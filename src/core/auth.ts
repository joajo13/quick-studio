/**
 * quick-studio Core — caller authentication (AD-12).
 *
 * Loopback is NOT the auth boundary. The Core mints a per-boot session token,
 * hands it to the UI at boot, and rejects every RPC that lacks the current
 * token. Origin/Host validation is defense-in-depth against DNS-rebinding.
 *
 * The token is 256-bit crypto-random hex, held in memory only for the life of
 * the process — never logged, never persisted.
 */

import { isWildcardHost } from "./binding.ts";

/** Number of random bytes in the session token (256 bits). */
const TOKEN_BYTES = 32;

/**
 * Mint a fresh per-boot session token: 256 bits of CSPRNG output as lowercase
 * hex. A new token is generated on every call (every boot). The caller holds it
 * in memory only.
 */
export function mintSessionToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Length-checked, prefix-safe string comparison. For equal-length inputs it
 * scans the whole string and never returns early on the first differing byte,
 * so it does not leak *where* two strings differ via timing. It does return
 * early on a length mismatch (a length oracle) — acceptable here because the
 * session token is a fixed 64-hex-char value, so every real comparison is
 * equal-length. Pure and total.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Validate a provided token against the current boot token. Pure predicate.
 * Returns false for an absent/blank/foreign token, true only for an exact match.
 */
export function validateToken(
  provided: string | null | undefined,
  current: string,
): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  if (typeof current !== "string" || current.length === 0) return false;
  return safeEqual(provided, current);
}

/**
 * Validate the Origin/Host of an incoming request against the bound loopback
 * address (defense-in-depth, DNS-rebinding guard). Pure predicate.
 *
 * Accepts only when:
 *  - `Origin` is absent (non-CORS callers such as curl) OR exactly
 *    `http://<boundHost>:<boundPort>`, AND
 *  - `Host` is exactly `<boundHost>:<boundPort>`.
 *
 * `localhost` and `127.0.0.1` are treated as DISTINCT origins — an exact string
 * match is required for a concrete bind host, which fully pins the authority and
 * so blocks DNS-rebinding (a rebinding page's `Host` never matches the bound IP).
 *
 * Wildcard exception (`0.0.0.0` / `::`): when the server binds a wildcard the
 * concrete reachable authority is unknowable (browsers reach it as `localhost`
 * or a LAN IP, never as `0.0.0.0`), so pinning to `${boundHost}:${boundPort}`
 * would 403 every RPC. The pinned *hostname* is therefore relaxed to a port-match
 * plus an Origin==Host same-origin check. IMPORTANT: this degraded gate blocks
 * plain cross-origin requests (`Origin` differs from `Host`) but does NOT stop a
 * DNS-rebinding attack, where the attacker controls both headers so `Origin ==
 * Host == attacker-authority` and this check passes. In wildcard/exposed mode the
 * SESSION TOKEN is the sole real boundary (per AD-12: loopback is not the auth
 * boundary, the token is) — the user explicitly opted into exposure with a loud
 * warning. Do not treat this predicate as rebinding protection for wildcard binds.
 */
export function validateOrigin(
  originHeader: string | null | undefined,
  hostHeader: string | null | undefined,
  boundHost: string,
  boundPort: number,
): boolean {
  // Wildcard bind: relax the hostname to a port-match + Origin==Host same-origin
  // check. Port is the segment after the LAST colon so bracketed IPv6 authorities
  // (`[::1]:<port>`) parse correctly rather than splitting on the address colons.
  if (isWildcardHost(boundHost)) {
    if (typeof hostHeader !== "string") return false;
    const lastColon = hostHeader.lastIndexOf(":");
    const portStr = lastColon === -1 ? "" : hostHeader.slice(lastColon + 1);
    if (portStr !== String(boundPort)) return false;
    if (originHeader === null || originHeader === undefined || originHeader === "") {
      return true;
    }
    return originHeader === `http://${hostHeader}`;
  }

  const expectedAuthority = `${boundHost}:${boundPort}`;

  // Host must exactly match the bound authority.
  if (typeof hostHeader !== "string" || hostHeader !== expectedAuthority) {
    return false;
  }

  // Origin is optional (absent for same-process / curl). If present it must be
  // exactly the loopback http origin — no localhost, no foreign host.
  if (originHeader === null || originHeader === undefined || originHeader === "") {
    return true;
  }
  return originHeader === `http://${expectedAuthority}`;
}
