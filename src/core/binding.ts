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

/**
 * Any IPv4 in the `127.0.0.0/8` loopback range, matched as a dotted quad. SHAPE only —
 * `\d{1,3}` does not bound an octet to 0-255, so `127.1.2.999` matches (see
 * {@link isLoopbackHost}).
 */
const LOOPBACK_V4_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True when `host` is a loopback address that is unreachable from other
 * machines: `localhost`, IPv6 loopback `::1`, or any IPv4 in `127.0.0.0/8`.
 * Comparison is case-insensitive. The `127.0.0.0/8` test is a dotted-quad
 * match — NOT a `127.` prefix — so a hostname like `127.attacker.example` is
 * correctly classified as NON-loopback (exposed), and its Port-Exposure Warning
 * still fires. Everything else — including the wildcards `0.0.0.0` / `::` — is
 * NOT loopback. Known limitation: the quad match checks shape, not the 0-255
 * octet range, so a typo like `127.1.2.999` is classified loopback here.
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

/**
 * Clamp a requested bind host down to loopback for the Ring 3 sandbox origin (DW-48).
 *
 * The Core's bind is a user decision — `QS_HOST=0.0.0.0` deliberately exposes the Core
 * to the LAN, and the Port-Exposure Warning says so. The sandbox origin is NOT the same
 * decision. It carries NO session token, NO `/rpc`, NO `/chat/stream` and no credential
 * of any kind, which is precisely why it must never be reachable off-machine: a tokenless
 * origin has nothing to authenticate WITH, so "exposed" there means "anyone on the network
 * can load the guest document and script the frame", with no gate left to stand between
 * them and it. Propagating the Core's bind into the sandbox `Bun.serve` also produced a
 * second, quieter failure: `deriveOpenUrl` normalizes the injected `__QS_SANDBOX_ORIGIN__`
 * to loopback, so under a wildcard bind the served page pointed a REMOTE browser at an
 * origin resolved against that browser's own machine — a silently blank preview pane. One
 * clamped value, used for both the bind and the derived origin, removes both failures at
 * once: the socket and the navigable string can no longer disagree.
 *
 * The rule, in order:
 *  - a host {@link isLoopbackHost} already accepts (`localhost`, `127.0.0.0/8`, `::1`)
 *    passes through verbatim, so today's loopback behavior — every origin, every existing
 *    test — is byte-identical and this function is invisible in the default configuration;
 *  - anything else is clamped to a loopback address chosen by the SHAPE OF THE LITERAL: a
 *    host that looks IPv6 (the wildcard `::`, a bracketed `[::]`, or anything containing
 *    a `:`) becomes `::1`, and everything else — IPv4 wildcard, routable IPv4, a hostname
 *    — becomes `127.0.0.1`.
 *
 * "Shape of the literal", not "address family", and the distinction is deliberate: this
 * is a string test, not a resolver. A NAME is always clamped to `127.0.0.1` even if it
 * resolves AAAA-only, and a malformed value carrying a stray colon (`dev.local:8080`,
 * which `resolveBindHost` does not reject) reads as IPv6-shaped. Neither is a hazard —
 * every output is loopback either way, which is the property that matters — but calling
 * it family detection would promise a lookup that does not happen.
 *
 * Preserving the shape is load-bearing rather than tidy for the literals: clamping an IPv6 bind to
 * `127.0.0.1` would bind and serve perfectly well, but it would also mean `deriveOpenUrl`'s
 * bracketing branch (`http://[::1]:<port>`) stopped being reached by exactly the binds that
 * reach it today, quietly turning the recorded CSP3 `host-part` IPv6 residual in
 * `shellCspHeaders` into a description of dead code. Keeping the family keeps that path —
 * and the reasoning written around it — honest.
 *
 * Note the deliberate asymmetry with `isWildcardHost`: this does NOT special-case the
 * wildcards, because a clamp that only caught `0.0.0.0`/`::` would still hand the guest to
 * the LAN for a concrete routable bind like `QS_HOST=192.168.1.50`. The predicate is
 * "already unreachable from other machines", not "looks like a wildcard" — which is also
 * why the loopback test is `isLoopbackHost` rather than a `127.` prefix, so a lookalike
 * hostname such as `127.attacker.example` is clamped, not trusted.
 *
 * Inherited limitation, named rather than implied: `isLoopbackHost`'s dotted-quad match
 * checks the SHAPE (`127.` + three 1-3 digit groups), not the 0-255 range, so a typo like
 * `127.1.2.999` is classified loopback here and passed through verbatim. It is not a
 * CONTAINMENT hole — no such value is routable, so nothing off-machine can reach it either
 * way, and that property holds for this function alone. What it does cost is bindability
 * and diagnosis: `Bun.serve` will refuse the address, so a direct caller of
 * `startSandboxServer` (the tests are direct callers) gets a throw rather than a server,
 * and no Port-Exposure Warning fires for a host that is not really loopback.
 * Deliberately NOT argued away as "Core's own boot rejects it first" — that would make the
 * guarantee a property of one call order, which is exactly what this function exists to
 * stop doing. The wart belongs to `isLoopbackHost` and is tracked there.
 *
 * Pure and total; mirrors `resolveBindHost`/`deriveOpenUrl`'s trim + lower-case
 * normalization so a direct caller cannot smuggle a padded or mixed-case host past it.
 */
export function sandboxBindHost(bindHost: string): string {
  const h = bindHost.trim().toLowerCase();
  if (isLoopbackHost(h)) return h;
  // IPv6-shaped: the wildcard `::`, a bracketed literal, or any address carrying a `:`.
  if (h.includes(":")) return "::1";
  return "127.0.0.1";
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
