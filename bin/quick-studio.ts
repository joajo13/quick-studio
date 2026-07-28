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
import { FIRST_RUN_HINT, isFirstRunBoot } from "../src/core/first-run-signal.ts";
import { HELP_TEXT } from "../src/core/help-text.ts";
import { createShutdownController, type ShutdownController } from "../src/core/lifecycle.ts";
import { formatSelfCheckValue, resolveSelfCheckMode } from "../src/core/self-check.ts";
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

// Hidden release-gate diagnostic (DW-89): `QS_SELFCHECK=keychain` runs the
// keychain round-trip and exits, so `.github/workflows/release.yml` can gate on
// THE SHIPPED `quick-studio-<os>-<arch>` binary instead of a second artifact
// compiled from `scripts/keyring-native-check.ts`. Deliberately not a CLI flag
// and deliberately absent from BOTH HELP_TEXT and the README: it mutates the OS
// keychain and is a CI probe, not a user knob. `QS_NO_UPDATE_CHECK` is only a
// PARTIAL precedent — it is hidden from HELP_TEXT but IS documented in
// README.md's environment list, because it is a genuine user knob that merely
// does not earn help-text space. This one goes further, out of both, and is
// documented in docs/keyring-spike-decision.md instead.
//
// It resolves HERE, above `parseCliArgs`, on purpose: the gate invokes the binary
// with whatever argv the workflow happens to pass, and no argv shape — a usage
// error, a stray positional, `--persistent` — may mask it or make it exit for the
// wrong reason. Sitting above the whole boot sequence also means it can never bind
// a port, create the app-data directory, write a lock file, or prompt for a
// passphrase; it exits before mode resolution, `runFirstRunSetup`, and `startCore`.
//
// The round-trip module is imported DYNAMICALLY, inside the try — but be precise
// about what that buys TODAY, because the honest answer is "not yet the error
// message". This file's import block above already reaches `src/core/keychain.ts`
// through a STATIC chain (`first-run-setup.ts` → … → `keychain.ts` → its
// top-level `@napi-rs/keyring` import), so on a binary that did not embed its
// binding the addon load throws during MODULE EVALUATION, before a single line
// below runs: the operator gets an uncaught Bun stack trace, loud and non-zero,
// but not the clean `selfcheck: FAILED — native module did not load` line. The
// dynamic import and its catch are what make that clean report — and the whole
// self-check — correct the moment that chain goes lazy, which is exactly the
// future DW-89 exists to guard. Importing the round-trip module statically HERE
// would move the failure permanently outside this try and make the catch dead
// code forever, so the split into `self-check.ts` (dependency-free, static) and
// `keychain-self-check.ts` (keychain-touching, dynamic) is right in both worlds.
// (`bun build --compile` still statically bundles a dynamic import with a literal
// specifier, so the addon is embedded either way.)
const selfCheck = resolveSelfCheckMode(process.env);
if (selfCheck.kind === "unknown") {
  // Fail fast and name the expected value. A silent fall-through would boot the
  // Core on a CI runner and sit there until `timeout-minutes` expires, reporting
  // a 30-minute hang instead of a one-character typo.
  //
  // The offending value is echoed through `formatSelfCheckValue`, never raw: it
  // is arbitrary environment text landing in a public CI log, and a value
  // carrying newlines or an ESC could forge extra log lines or repaint the
  // terminal. `src/core/keychain.ts` bounds its `detail` for the same reason.
  //
  // The bounding is also why the line needs a HINT arm. `formatSelfCheckValue`
  // strips control characters and trims, so a value that differs from `keychain`
  // only by a trailing space or a CRLF — the shape a YAML scalar or a
  // Windows-edited workflow file produces — would otherwise print the
  // self-contradictory `unknown QS_SELFCHECK 'keychain' (want: keychain)`, and an
  // all-whitespace value would print `unknown QS_SELFCHECK ''`. Naming the real
  // difference is the whole point: this arm exists to turn a CI misconfiguration
  // into a five-second diagnosis, and a line that appears to reject the value it
  // asks for spends that budget instead of saving it.
  const shown = formatSelfCheckValue(selfCheck.value);
  const hint =
    shown === "keychain"
      ? " (it matches only once surrounding whitespace/control characters are stripped)"
      : shown === ""
        ? " (the value is entirely whitespace or control characters)"
        : "";
  process.stderr.write(`quick-studio: unknown QS_SELFCHECK '${shown}'${hint} (want: keychain)\n`);
  process.exit(1);
}
if (selfCheck.kind === "keychain") {
  try {
    const { runKeychainSelfCheck } = await import("../src/core/keychain-self-check.ts");
    process.exit(runKeychainSelfCheck(process.env));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`selfcheck: FAILED — native module did not load: ${msg}\n`);
    process.exit(1);
  }
}
// Exhaustiveness guard. The two branches above are `if`s with an implicit
// fall-through, and the fall-through BOOTS THE CORE — so a future fourth
// `SelfCheckMode` arm that nobody wired up here would silently start a listening
// server on a release runner and hang the leg to its timeout, the exact failure
// the `unknown` arm exists to prevent. `never` turns that into a compile error;
// the runtime arm is unreachable by construction and says so if it ever is not.
if (selfCheck.kind !== "none") {
  const unhandled: never = selfCheck;
  process.stderr.write(
    `quick-studio: internal error — unhandled QS_SELFCHECK mode ${JSON.stringify(unhandled)}\n`,
  );
  process.exit(1);
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

  // Story 11.7: the bare-command routing/messaging signal, computed HERE — before
  // the Story 11.6 pre-flight below has any chance to run. That pre-flight's create
  // path (`runFirstRunSetup` -> `openCredentialStore` -> `openPersistent`) can write
  // the app-data directory and, on a keychain-less host completing the passphrase
  // create flow, the descriptor and the eager empty `.enc` too — all BEFORE
  // `startCore` is ever reached. A probe read after that point would see its own
  // just-created files and report "configured" on exactly the machine this hint
  // exists for. Reading disk state as of process start is also the honest answer to
  // "has this machine ever been set up?" (Design Notes). Total and cheap: a couple
  // of `existsSync` calls, no decryption, no directory creation, and a hard no-op
  // in Ephemeral mode.
  const firstRun = isFirstRunBoot(cli.mode, process.env, process.platform);

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
    // Routing/messaging only (Story 11.7) — never changes what boots. A returning
    // user (firstRun === false) gets the served shell byte-for-byte unchanged.
    firstRun,
  });
  controller = createShutdownController({ stop: core.stop, exit: () => process.exit(0) });

  // Registering a signal listener suppresses the default terminate behavior,
  // so the handler itself must exit — that's exactly what the controller does.
  // Keep this synchronous: no awaited work, so OS shutdown is never stalled.
  process.on("SIGINT", () => controller.initiate());
  process.on("SIGTERM", () => controller.initiate());

  // stderr only, terse. Never log the session token.
  process.stderr.write(`quick-studio Core listening on ${core.url}\n`);

  // Story 11.7: printed immediately after the listening-URL line — never before —
  // so the hint's "the URL above" reference is always literally true. A hint, never
  // an error: the exit code and the rest of boot are unaffected either way.
  if (firstRun) process.stderr.write(FIRST_RUN_HINT);

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
