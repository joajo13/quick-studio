#!/usr/bin/env bun
/**
 * quick-studio — CLI entry (walking skeleton).
 *
 * Boots the Trusted Core and logs the bound URL to stderr. The bind host comes
 * from `QS_HOST` (default loopback `127.0.0.1`); a non-loopback bind emits a
 * loud Port-Exposure Warning here in `bin/` (FR-22). CLI mode parsing (Ephemeral
 * vs Persistent) lives in `parseCliArgs`; after boot we launch the OS default
 * browser on the navigable `core.openUrl` (best-effort — a launch failure logs a
 * terse note and never aborts the session). Logging is terse and to stderr only;
 * the token is NEVER logged.
 *
 * Clean shutdown (story 1.5): SIGINT/SIGTERM and the UI's `shutdown` RPC all
 * converge on one idempotent `ShutdownController` built over `core.stop` +
 * `process.exit(0)`, so however the session ends it terminates at most once,
 * promptly, and without stalling OS shutdown.
 */

import { resolveBindHost } from "../src/core/binding.ts";
import { openBrowser } from "../src/core/browser-open.ts";
import { CliArgsError, parseCliArgs, type CliArgs } from "../src/core/cli-args.ts";
import { runFirstRunSetup, type FirstRunSetupResult } from "../src/core/first-run-setup.ts";
import { HELP_TEXT } from "../src/core/help-text.ts";
import { createShutdownController, type ShutdownController } from "../src/core/lifecycle.ts";
import { startCore } from "../src/core/server.ts";
import { printUpdateInstructions, runUpdateCheck } from "../src/core/update-check.ts";
import { VERSION } from "../src/core/version.generated.ts";

/** Parse QS_PORT into a valid TCP port (0 = ephemeral). Rejects garbage early. */
function resolvePort(): number {
  const raw = process.env.QS_PORT;
  if (raw === undefined || raw === "") return 0;
  // Accept only a plain run of decimal digits. `Number()` would otherwise
  // silently coerce whitespace ("  " → 0 → ephemeral), hex ("0x1F" → 31), and
  // exponent ("1e3" → 1000) forms — none of which is a port the user typed.
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`quick-studio: invalid QS_PORT '${raw}' (want 0-65535)\n`);
    process.exit(1);
  }
  return port;
}

// Resolve the CLI decision (mode + browser-open) BEFORE booting. A usage error
// is terse-to-stderr + exit(1) — no stack, no Core booted.
let cli: CliArgs;
try {
  cli = parseCliArgs(process.argv.slice(2), process.env);
} catch (err) {
  if (err instanceof CliArgsError) {
    process.stderr.write(`quick-studio: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

// --help / --version are the only two stdout writes anywhere in this file
// (everything else is process.stderr.write): requested output, not
// diagnostics, so they exit 0 and never boot the Core. Checked before
// resolvePort() or anything else runs.
if (cli.action === "help") {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}
if (cli.action === "version") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// `quick-studio update` (Story 11.5): a read-only, advisory subcommand. It
// prints how to upgrade the running copy (detected from `process.execPath`) to
// stdout — requested output, like help/version — and exits 0 without booting the
// Core. No download, no write, no process replacement.
if (cli.action === "update") {
  printUpdateInstructions();
  process.exit(0);
}

try {
  // Forward reference: `startCore` needs `onShutdownRequested` (so the UI's
  // `shutdown` RPC converges on the same teardown), but the controller itself
  // needs `core.stop`, which only exists once `startCore` resolves. The thunk
  // below is only ever invoked later, from a live RPC — by then `controller`
  // has been assigned.
  // Initialized to a safe no-op so the thunk below can never deref `undefined`
  // if the timing invariant is ever broken. The thunk is only invoked from a
  // live RPC (post-boot), by which point `controller` is the real one.
  let controller: ShutdownController = { initiate: async () => {} };

  // Review fix: resolved BEFORE the first-run pre-flight (was previously passed
  // inline to `startCore` after the prompt). `resolvePort()` is cheap, synchronous
  // PARSING — a malformed `QS_PORT` now fails before the user is asked to type and
  // confirm a passphrase. It does NOT (and cannot, without pre-binding) cover a
  // port that parses but cannot be bound: the `listen()` happens inside `startCore`
  // below, so an `EADDRINUSE` still surfaces after a store may have been created.
  // That residual case is the outer catch's "failed to start Core", which is
  // accurate — the Core genuinely failed to start.
  const port = resolvePort();

  // First-run setup pre-flight (Story 11.6): on a Persistent boot with no OS
  // keychain reachable and no QS_PASSPHRASE/QS_PASSPHRASE_FD set, prompt
  // interactively BEFORE the Core boots — never after, since the registries open
  // their stores lazily and a wrong/declined passphrase would otherwise surface
  // only as an opaque `internal_error` on the first RPC. Runs AFTER the
  // help/version/update early exits above, so none of those paths ever prompt.
  // `aborted` (Ctrl-C) is the one outcome only `bin/` may act on: exit 130 without
  // ever booting the Core. `skip` means change nothing — `startCore` resolves its
  // own provider exactly as today.
  //
  // Review fix: wrapped in its own try/catch, separate from the outer one below.
  // `openCredentialStore` re-throws genuinely unexpected errors (not a typed
  // `OpenResult` arm); left uncaught here it would propagate to the OUTER catch and
  // be misreported as "failed to start Core" even though the Core was never
  // started. Contained here, it is reported for what it is.
  let setup: FirstRunSetupResult;
  try {
    setup = await runFirstRunSetup(cli.mode, process.env, {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`quick-studio: first-run setup failed: ${msg}\n`);
    process.exit(1);
  }
  if (setup.outcome === "aborted") {
    process.exit(130);
  }

  const core = await startCore(port, {
    onShutdownRequested: () => controller.initiate(),
    host: resolveBindHost(process.env.QS_HOST),
    mode: cli.mode,
    // Thread the in-memory Ephemeral URL through to the Core's connection manager
    // (Story 1.3). Held only in Core memory — never persisted, never logged here.
    databaseUrl: cli.databaseUrl ?? undefined,
    // The ONE provider instance the pre-flight already resolved interactively
    // (Story 11.6), or undefined on `skip` so `startCore` resolves it exactly as
    // today (`resolvePassphraseProvider(process.env)`).
    passphraseProvider: setup.outcome === "provider" ? setup.provider : undefined,
  });
  controller = createShutdownController({ stop: core.stop, exit: () => process.exit(0) });

  // Registering a signal listener suppresses the default terminate behavior,
  // so the handler itself must exit — that's exactly what the controller does.
  // Keep this synchronous: no awaited work, so OS shutdown is never stalled.
  process.on("SIGINT", () => controller.initiate());
  process.on("SIGTERM", () => controller.initiate());

  // stderr only, terse. Never log the session token.
  process.stderr.write(`quick-studio Core listening on ${core.url}\n`);

  // TTL-cached update check (Story 11.5). Fire-and-forget, exactly like the
  // `openBrowser` call below: launched after the Core is listening, NEVER
  // awaited, structurally incapable of delaying or failing the boot. It self-
  // swallows every failure and is a no-op in Ephemeral mode / when
  // `QS_NO_UPDATE_CHECK` is set (both guarded before any disk or network access).
  runUpdateCheck(cli.mode, process.env);

  // Port-Exposure Warning (FR-22): a non-loopback bind is reachable off-machine,
  // so anyone on the network can reach the UI and, through it, the connected
  // database. The user opted in explicitly — we warn loudly, we do not veto.
  // Printed BEFORE the browser opens so the operator sees the warning first in
  // exactly the (exposed) scenario where it matters most.
  if (core.exposed) {
    process.stderr.write(
      "\n" +
        "  ╔══════════════════════════════════════════════════════════════════╗\n" +
        "  ║  ⚠  PORT-EXPOSURE WARNING — quick-studio is NOT localhost-only     ║\n" +
        "  ╚══════════════════════════════════════════════════════════════════╝\n" +
        `  Bound to ${core.host}:${core.port} — reachable from OTHER machines on\n` +
        "  the network. Anyone who can reach this address can open the UI and,\n" +
        "  through it, access the connected database. Only the session token\n" +
        "  stands between them and your data.\n" +
        "\n" +
        "  To revert to localhost-only:\n" +
        "    1. Stop quick-studio.\n" +
        "    2. Unset QS_HOST (or set QS_HOST=127.0.0.1).\n" +
        "    3. Start quick-studio again.\n" +
        "\n",
    );
  }

  // Best-effort browser-open on the navigable, gate-passing URL (not `core.url`,
  // which is the bind host verbatim). Suppressed by `--no-open`/`QS_NO_OPEN`.
  // Fire-and-forget: `openBrowser` swallows any launcher failure internally.
  if (cli.openBrowser) {
    openBrowser(core.openUrl, { platform: process.platform, spawn: Bun.spawn });
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`quick-studio: failed to start Core: ${msg}\n`);
  process.exit(1);
}
