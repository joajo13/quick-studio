/**
 * The shared origin matrix for DW-2's cross-ring agreement, in a plain module rather
 * than in either test file: `shared/sandbox-origin.test.ts` (the rule itself),
 * `core/server.test.ts` (the `frame-src` source) and `ui/sandbox/sandbox-host.test.ts`
 * (the iframe `src`) all assert against THESE lists, so the three can never drift into
 * testing three different matrices. Not imported by any production module.
 */

/** Origins that must be admitted verbatim by both consumers. */
export const USABLE_SANDBOX_ORIGINS = [
  "http://127.0.0.1:6789",
  "https://127.0.0.1:5555",
  "http://localhost:3000",
  "http://127.0.0.1", // scheme-default port, which `deriveOpenUrl` omits
  "http://[::1]:5555", // IPv6 bind — see the recorded CSP3 host-part residual
  "http://[::1]",
];

/** Origins that must fail closed on both sides (`frame-src 'none'` / `about:blank`). */
export const UNUSABLE_SANDBOX_ORIGINS = [
  "",
  "about:blank",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "127.0.0.1:6789", // no scheme
  "//evil.test", // scheme-relative
  "ftp://127.0.0.1:21",
  "http://", // hostless
  "https://",
  "http:///x", // hostless with a path
  "http://:1234", // port, EMPTY host
  "http://[:]:80", // bracketed, but not an IPv6 literal
  "http://.:80", // an authority that is not a host
  "http://[", // truncated bracket
  "http://127.0.0.1:6789/embed", // a path is not part of an origin source expression
  // Outside CSP3's `host-part` grammar (ALPHA / DIGIT / `-`, no empty label). A browser
  // cannot parse these as a source expression, so emitting one drops the directive.
  "http://my_host:5555", // `_` is not a host char
  "http://a..b:80", // empty label
  "http://a-.:80", // label ending in `-`, then an empty one
  "http://-a.b:80", // label starting with `-`
  "http://xn--e1afmkfd.:80", // trailing dot
  "http://[1.2.3.4]:80", // bracketed IPv4 is not an IPv6 literal
];

/**
 * Hostile inputs a CHARACTER FILTER would have repaired into a valid — and in the first
 * three cases entirely fabricated — origin, which every ring would then have agreed on.
 * The gate is accept-or-reject on the raw value, so all of these are refused whole.
 * (The commented value is what a strip-and-keep filter turned each one into.)
 */
export const REPAIRABLE_HOSTILE_SANDBOX_ORIGINS = [
  "http://evil.test\\:6789", // -> http://evil.test:6789  (a remote host)
  "http://127.0.0.1:67'89", // -> http://127.0.0.1:6789  (a port never denoted)
  "http://12 7.0.0.1:6789", // -> http://127.0.0.1:6789
  "http://127.0.0.1:6789'", // -> http://127.0.0.1:6789
  "http://127.0.0.1:6789 ", // -> http://127.0.0.1:6789
  "http://127.0.0.1:1; script-src 'unsafe-inline'", // a forged second directive
  'http://127.0.0.1:1</script><script>alert(1)</script>', // a `<script>` breakout
];
