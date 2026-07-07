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
import { createShutdownController, type ShutdownController } from "../src/core/lifecycle.ts";
import { startCore } from "../src/core/server.ts";

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
  const core = await startCore(resolvePort(), {
    onShutdownRequested: () => controller.initiate(),
    host: resolveBindHost(process.env.QS_HOST),
    mode: cli.mode,
    // Thread the in-memory Ephemeral URL through to the Core's connection manager
    // (Story 1.3). Held only in Core memory — never persisted, never logged here.
    databaseUrl: cli.databaseUrl ?? undefined,
  });
  controller = createShutdownController({ stop: core.stop, exit: () => process.exit(0) });

  // Registering a signal listener suppresses the default terminate behavior,
  // so the handler itself must exit — that's exactly what the controller does.
  // Keep this synchronous: no awaited work, so OS shutdown is never stalled.
  process.on("SIGINT", () => controller.initiate());
  process.on("SIGTERM", () => controller.initiate());

  // stderr only, terse. Never log the session token.
  process.stderr.write(`quick-studio Core listening on ${core.url}\n`);

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
