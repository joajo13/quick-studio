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
 * match is required. The bound host in this story is always `127.0.0.1`.
 */
export function validateOrigin(
  originHeader: string | null | undefined,
  hostHeader: string | null | undefined,
  boundHost: string,
  boundPort: number,
): boolean {
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
