/**
 * quick-studio shared — the ONE rule for what counts as a usable Ring 3 sandbox origin.
 *
 * The injected `window.__QS_SANDBOX_ORIGIN__` is consumed by three places that must
 * agree exactly, across two rings:
 *
 *  - Ring 1 (`shellCspHeaders` in `core/server.ts`) puts it in the app shell's
 *    `frame-src` source list;
 *  - Ring 1 (`renderIndexHtml` in `core/server.ts`) injects it into the shell HTML;
 *  - Ring 2 (`buildSandboxIframeAttrs` in `ui/sandbox/sandbox-host.ts`) puts it in the
 *    iframe's `src`.
 *
 * If those disagree the failure is silent in the worst direction: the CSP admits an
 * origin the iframe never navigates to, or — the one that actually bites — the iframe
 * navigates to an origin the CSP refuses, and the user gets a blank preview pane with
 * nothing but a browser-console line to explain it. So the rule lives HERE, in one
 * module every consumer imports, rather than as copies of a regex kept in sync by good
 * intentions. (This is the same construction argument `safeCspNonce` makes for the
 * nonce, applied to the other value that must be byte-identical on every side.)
 *
 * ACCEPT-OR-REJECT, never repair. An earlier revision paired this gate with a
 * `sanitizeSandboxOrigin` character filter and gated the SURVIVORS — the exact
 * fail-open shape `safeCspNonce`'s docstring argues against for the nonce, and worse
 * here, because stripping characters can turn a hostile string into a different but
 * perfectly VALID origin: `"http://evil.test\:6789"` filtered down to
 * `"http://evil.test:6789"`, which every ring then agreed on — a fabricated remote host
 * admitted into `frame-src` and navigated to by the iframe; `"http://127.0.0.1:67'89"`
 * became a port the input never denoted. The filter is gone: a value is either exactly
 * a usable origin or it is refused whole, and every consumer fails closed together.
 * That also makes the character filter provably redundant rather than merely unused —
 * the accepted charset below contains no `;`, space, quote, `<` or `>`, so an accepted
 * value can neither split `frame-src` into a forged directive nor break out of the
 * `<script>` context it is injected into.
 */

/**
 * `scheme "://" host [":" port]` and nothing else — anchored on both ends.
 *
 * The host part is mandatory and must actually be a host: dot-separated labels that
 * start and end with an alphanumeric (which covers IPv4 literals), or a bracketed IPv6
 * literal — brackets containing at least one colon AND at least one hex digit. That is
 * much stricter than a bare `^https?://` shape test on purpose, because the malformed
 * authority forms are exactly the ones that produce a source expression no browser can
 * parse:
 *
 *  - `http://`, `https://`, `http:///x`   — no authority at all;
 *  - `http://:1234`, `http://[:]:80`      — a port with an EMPTY host;
 *  - `http://.:80`, `http://[`            — an authority that is not a host;
 *  - `http://my_host:80`, `http://a..b:80`, `http://a-.:80`, `http://xn--x.:80`
 *                                         — outside CSP3's `host-part` grammar, which
 *                                           admits ALPHA / DIGIT / `-` only and has no
 *                                           empty, trailing or `_`-bearing label;
 *  - `http://[1.2.3.4]:80`                — bracketed, but not an IPv6 literal.
 *
 * An unparseable source in `frame-src` is the failure this whole gate exists to prevent:
 * a browser that cannot parse a directive may discard it — or the entire policy — and
 * silently restore the ambient authority the CSP was added to remove.
 *
 * The ONE deliberate deviation from CSP3's `host-part` is the bracketed IPv6 literal
 * (`http://[::1]:6789`), which `deriveOpenUrl` produces on an IPv6 bind: `host-part`
 * formally admits no brackets or colons, yet Chromium and Gecko both accept the form,
 * and CSP has no portable alternative spelling for a single IPv6 host. It is admitted
 * because the value MUST stay byte-identical to the iframe's `src`; on a spec-strict
 * browser the frame is refused, which is a blank preview pane, never a security hole.
 * Every OTHER host form outside `host-part` is rejected rather than emitted, so that
 * deviation stays the single documented one instead of an open-ended class.
 *
 * Deliberately a regex rather than `new URL(x).origin === x`: this value must survive
 * BYTE-IDENTICAL into the CSP source, the injected shell global and the iframe `src`,
 * and the URL parser normalizes (case-folding, IDN punycode, default-port elision), so
 * a "valid" verdict from it would not guarantee the sides still match.
 */
const USABLE_SANDBOX_ORIGIN_RE =
  /^https?:\/\/(\[(?=[^\]]*:)[0-9A-Fa-f:.]*[0-9A-Fa-f][0-9A-Fa-f:.]*\]|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)(?::\d+)?$/;

/**
 * Whether `origin` — the RAW value, exactly as it will be emitted — is safe to hand to
 * every consumer: the `frame-src` source, the injected `window.__QS_SANDBOX_ORIGIN__`,
 * and the sandbox iframe's `src`. When this returns `false` all sides fail closed in the
 * matching way: `frame-src 'none'` in the header, `""` in the injected global, and
 * `about:blank` in the iframe (which inherits the embedder's policy and needs no source
 * of its own).
 *
 * Callers pass the value UNMODIFIED. There is deliberately no companion sanitizer to run
 * first — see the module docstring: a filter that repaired its input into a valid origin
 * is how the header, the global and the frame all came to agree on a fabricated host.
 * Pure and total.
 */
export function isUsableSandboxOrigin(origin: string): boolean {
  return USABLE_SANDBOX_ORIGIN_RE.test(origin);
}
