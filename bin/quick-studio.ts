#!/usr/bin/env bun
/**
 * quick-studio — CLI entry (walking skeleton).
 *
 * Boots the Trusted Core and logs the bound loopback URL to stderr. CLI mode
 * parsing (Ephemeral vs Persistent) and browser-open land in story 1.2 — not
 * here. Logging is terse and to stderr only; the token is NEVER logged.
 */

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

try {
  const core = await startCore(resolvePort());
  // stderr only, terse. Never log the session token.
  process.stderr.write(`quick-studio Core listening on ${core.url}\n`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`quick-studio: failed to start Core: ${msg}\n`);
  process.exit(1);
}
