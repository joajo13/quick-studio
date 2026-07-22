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
 * Number of random bytes in the app-shell CSP nonce (128 bits). The CSP spec asks
 * for at least 128 bits of entropy per nonce; more would only bloat every inline
 * `<script>` tag without buying security, since the nonce is regenerated per boot
 * and the shell is `no-store` (never cached, never replayed against a later boot).
 */
const NONCE_BYTES = 16;

/** Scheme-default HTTP port, which browsers omit from `Host`/`Origin`. */
const HTTP_DEFAULT_PORT = 80;

/**
 * Bracket a bare IPv6 literal so `:<port>` is unambiguous in an authority
 * (`::1` → `[::1]`), matching `deriveOpenUrl`'s normalization. IPv4 addresses,
 * hostnames, and already-bracketed literals pass through unchanged. Without this
 * the browser opens `http://[::1]:<port>` (bracketed) while the gate expected the
 * unbracketed `::1:<port>` — a Host mismatch that 403s every RPC on an IPv6 bind.
 */
function bracketIfIpv6(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Extract the port segment from an authority (a `Host` header value),
 * bracket-aware so a bracketed IPv6 literal's inner colons are not mistaken for
 * the port separator. Returns "" when no explicit port is present — e.g. a
 * browser omitting `:80` from `127.0.0.1` or `[::1]`.
 */
function authorityPort(authority: string): string {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return "";
    const rest = authority.slice(close + 1);
    return rest.startsWith(":") ? rest.slice(1) : "";
  }
  const colon = authority.lastIndexOf(":");
  return colon === -1 ? "" : authority.slice(colon + 1);
}

/**
 * Draw `byteLength` bytes from the CSPRNG and render them as lowercase hex
 * (`2 * byteLength` chars, zero-padded so the length is fixed and a leading zero
 * byte is never swallowed).
 *
 * The ONE minting primitive behind both {@link mintSessionToken} and
 * {@link mintCspNonce}. It is shared deliberately: the two secrets differ only in
 * width, so two copies of the same loop would mean a future hardening change
 * (a different RNG call, a different encoding, a rejection-sampling step) could
 * land on one and silently miss the other — and the one it missed would be the
 * weaker secret nobody re-audits. Private: the widths are the callers' contract,
 * not a knob.
 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Mint a fresh per-boot session token: 256 bits of CSPRNG output as lowercase
 * hex. A new token is generated on every call (every boot). The caller holds it
 * in memory only.
 */
export function mintSessionToken(): string {
  return randomHex(TOKEN_BYTES);
}

/**
 * Mint a fresh per-boot CSP nonce for the app shell (DW-2): 128 bits of CSPRNG
 * output as lowercase hex, minted through the very same {@link randomHex}
 * primitive as the session token because it carries the same weight — a
 * guessable nonce is an XSS bypass, since
 * any injected `<script nonce="…">` matching it would execute with the shell's
 * full ambient authority (including `window.__QS_TOKEN__` and `/rpc` reach).
 *
 * Provenance guarantees, identical to {@link mintSessionToken}: minted ONCE per
 * boot (the shell HTML is a boot-time template served `no-store`, so one nonce
 * covers every request of that boot and never survives it), held in memory only
 * for the life of the process, never logged, never persisted, never returned on
 * the public `Core` surface. Two boots must never share a nonce — a leaked nonce
 * from a previous session must not unlock the next one.
 *
 * What those guarantees do NOT amount to, and must not be read as: secrecy from
 * the local machine. The shell that carries the nonce is served at the UNGATED
 * `GET /`, so any process on this box can simply fetch it and read the current
 * boot's nonce out of the HTML — exactly as it can read the session token, which
 * is the same-machine exposure DW-2's ledger entry explicitly carved out as a
 * separate, still-open concern. The threat this value closes is GUESSING (a
 * remote-injected script cannot fabricate a matching `nonce` attribute), not
 * READING. Anything that assumes the nonce is confidential against local
 * processes is assuming a property this deployment does not provide.
 *
 * Lowercase hex is deliberate: the value is interpolated straight into both the
 * `'nonce-…'` CSP source token and an HTML attribute, and the hex alphabet
 * contains no character that could terminate either context. This exact shape —
 * 32 lowercase hex chars — is also the contract consumers validate against
 * all-or-nothing (`safeCspNonce` in `server.ts`), so changing the width or the
 * encoding here without changing that gate fails the suite rather than silently
 * shipping a shell whose inline scripts are all refused.
 */
export function mintCspNonce(): string {
  return randomHex(NONCE_BYTES);
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
  // A port-80 bind is reached with the port omitted: browsers drop the
  // scheme-default `:80` from both `Host` and `Origin`, and `deriveOpenUrl`
  // omits it from the URL it opens. So on port 80 a bare (portless) authority is
  // also valid. Only when `boundPort === 80` — every other port still requires
  // the explicit `<host>:<port>` form, byte-identical to before this relaxation.
  const acceptBareHost = boundPort === HTTP_DEFAULT_PORT;

  // Wildcard bind: relax the hostname to a port-match + Origin==Host same-origin
  // check. Port extraction is bracket-aware (`authorityPort`) so a bracketed IPv6
  // authority (`[::1]`) parses correctly and a port-80 bind (port omitted) still
  // matches — `deriveOpenUrl` remaps a wildcard to `127.0.0.1`/`[::1]`, dropping
  // `:80`, and this must accept exactly that.
  if (isWildcardHost(boundHost)) {
    if (typeof hostHeader !== "string") return false;
    const portStr = authorityPort(hostHeader);
    const portOk =
      portStr === String(boundPort) || (acceptBareHost && portStr === "");
    if (!portOk) return false;
    if (originHeader === null || originHeader === undefined || originHeader === "") {
      return true;
    }
    return originHeader === `http://${hostHeader}`;
  }

  // Concrete bind: pin the full authority. Bracket a bare IPv6 bind host so it
  // matches the bracketed `Host` a browser sends (and `deriveOpenUrl` opens).
  const authHost = bracketIfIpv6(boundHost);
  const expectedAuthority = `${authHost}:${boundPort}`;

  // Host must exactly match the bound authority (or the bare host on port 80).
  if (typeof hostHeader !== "string") return false;
  if (hostHeader !== expectedAuthority && !(acceptBareHost && hostHeader === authHost)) {
    return false;
  }

  // Origin is optional (absent for same-process / curl). If present it must be
  // exactly the loopback http origin — no localhost, no foreign host — or, on
  // port 80, the bare-host http origin the browser actually sends.
  if (originHeader === null || originHeader === undefined || originHeader === "") {
    return true;
  }
  if (originHeader === `http://${expectedAuthority}`) return true;
  return acceptBareHost && originHeader === `http://${authHost}`;
}
