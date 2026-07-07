/**
 * quick-studio Core — bind-host resolution + classification (Ring 1).
 *
 * A dependency-free, unit-testable pure module (mirrors `lifecycle.ts`). It is
 * the single source of truth for turning the `QS_HOST` override into a concrete
 * bind host and classifying that host as loopback (private, no warning) or
 * exposed (reachable off-machine, warn loudly on both surfaces).
 *
 * Exposure is a pure function of the resolved bind host — evaluated once at boot
 * and static for the session. There is no live network-interface watcher.
 *
 * `process.exit` / stderr side effects stay in `bin/`; this module only decides.
 */

/** Loopback bind address used when no `QS_HOST` override is supplied. */
const DEFAULT_HOST = "127.0.0.1";

/**
 * Resolve the raw `QS_HOST` value (typically `process.env.QS_HOST`) into a
 * concrete bind host. Trims surrounding whitespace and lower-cases the host; an
 * unset, empty, or whitespace-only value falls back to the loopback default
 * `127.0.0.1`. Lower-casing keeps the resolved host consistent with the
 * case-insensitive classification below AND with the `validateOrigin` authority
 * match: hostnames/IPs are case-insensitive, but a browser sends a lower-cased
 * `Host`, so a mixed-case bind (`QS_HOST=LocalHost`) that skips this fold would
 * bind fine yet 403 every RPC on the verbatim `${boundHost}:${port}` comparison.
 */
export function resolveBindHost(raw: string | undefined): string {
  if (typeof raw !== "string") return DEFAULT_HOST;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "" ? DEFAULT_HOST : trimmed;
}

/** Any IPv4 in the `127.0.0.0/8` loopback range, validated as a real dotted quad. */
const LOOPBACK_V4_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True when `host` is a loopback address that is unreachable from other
 * machines: `localhost`, IPv6 loopback `::1`, or any IPv4 in `127.0.0.0/8`.
 * Comparison is case-insensitive. The `127.0.0.0/8` test is a validated
 * dotted-quad match — NOT a `127.` prefix — so a hostname like
 * `127.attacker.example` is correctly classified as NON-loopback (exposed),
 * and its Port-Exposure Warning still fires. Everything else — including the
 * wildcards `0.0.0.0` / `::` — is NOT loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  return LOOPBACK_V4_RE.test(h);
}

/**
 * True when `host` is a bind wildcard (`0.0.0.0` for IPv4, `::` for IPv6) whose
 * concrete reachable authority is unknowable at request time — the case that
 * relaxes `validateOrigin` to a port-match + Origin==Host gate.
 */
export function isWildcardHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "0.0.0.0" || h === "::";
}

/**
 * True when the bind host is reachable off-machine (i.e. not loopback), meaning
 * both Port-Exposure Warning surfaces must fire.
 */
export function isExposed(host: string): boolean {
  return !isLoopbackHost(host);
}

/** The scheme-default HTTP port, omitted from a navigable URL's authority. */
const HTTP_DEFAULT_PORT = 80;

/**
 * Derive a navigable, gate-passing browser URL from the bind host + bound port.
 *
 * `Core.url` is the bind host verbatim, so under a wildcard bind it is
 * `http://0.0.0.0:<port>` (non-navigable) and `validateOrigin` treats `localhost`
 * and `127.0.0.1` as distinct. This maps the bind host to an address a browser
 * can actually reach AND the Origin/Host gate accepts:
 *  - wildcard `0.0.0.0` → `127.0.0.1`, `::` → `[::1]` (the wildcard-bind auth
 *    relaxation then passes it by port-match);
 *  - a concrete host is used verbatim — a bare IPv6 literal is bracketed so the
 *    `:` port separator is unambiguous;
 *  - the scheme-default port 80 is omitted (browsers drop it; the port-80 auth
 *    fix accepts the resulting bare-authority Host/Origin).
 *
 * Pure and total; mirrors `resolveBindHost`'s trim + lower-case normalization so
 * a direct caller cannot pass a padded/mixed-case host.
 */
export function deriveOpenUrl(bindHost: string, port: number): string {
  const h = bindHost.trim().toLowerCase();

  let host: string;
  if (h === "0.0.0.0") {
    host = "127.0.0.1";
  } else if (h === "::") {
    host = "[::1]";
  } else if (h.includes(":") && !h.startsWith("[")) {
    // Bare IPv6 literal (e.g. `::1`) — bracket it so `:<port>` is unambiguous.
    host = `[${h}]`;
  } else {
    host = h;
  }

  const authority = port === HTTP_DEFAULT_PORT ? host : `${host}:${port}`;
  return `http://${authority}`;
}
