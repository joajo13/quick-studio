---
title: 'Render assistant chat messages as sanitized Markdown — stop showing literal markdown syntax (fenced code blocks, inline code, lists, emphasis) in the message bubble'
type: 'bugfix'
created: '2026-07-16'
status: 'done'
baseline_revision: 'e1c09a05d89d727282793dc95bf8c1748b2f6503'
final_revision: '08ce420'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/src/ui/workspace/ChatTabView.tsx'
  - '{project-root}/src/ui/report/report-markdown.ts'
  - '{project-root}/src/ui/report/ReportTabView.tsx'
  - '{project-root}/src/ui/styles/globals.css'
  - '{project-root}/design-artifacts/ai-chat-chatgpt.html'
  - '{project-root}/src/ui/workspace/ChatTabView.test.tsx'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem (user report, item 9, with screenshot):** In the AI Chat, an assistant message's body renders the model's answer as a **raw, un-parsed text node** — so Markdown/MDX syntax is shown LITERALLY. A fenced code block the model wrote inline in its prose (e.g. ` ```sql\nSELECT … \n``` `) displays with its backticks and the `sql` info-string visible, instead of as a styled code block; likewise `**bold**`, `` `inline code` ``, `- bullet`, `# heading`, and `---` rules all show their raw markers. The culprit is `ChatTabView.tsx` line 797-799, which renders the assistant body as `<p className="… whitespace-pre-wrap …">{bubbleText}</p>` — `bubbleText` is the model's Markdown string dropped straight into a React text node, so every markup character is escaped and shown verbatim. (Note: the SEPARATE "generated SQL" block below the answer — driven by `message.query` in `ChatQueryRun`, rendered read-only in a `<pre>` — is CORRECT and must stay untokenized/verbatim. The bug is ONLY the raw Markdown in the message body bubble.)

**Approach:** Render the COMMITTED assistant answer body through the project's EXISTING micromark-based, security-reviewed renderer — `renderReportMarkdown` in `src/ui/report/report-markdown.ts` — to sanitized HTML, and mount it via `dangerouslySetInnerHTML` exactly the way `ReportTabView`'s `ProseBlock` already does (`ReportTabView.tsx:607/621-626`). REUSE that renderer as-is: it is a generic safe-prose pass (`micromark(md, { allowDangerousHtml: false })` + URL-scheme sanitization), not report-specific in behavior; both are Ring-2 modules, so a `../report/report-markdown.ts` import is a clean intra-ring dependency (the ring-boundary note in that file forbids importing Ring-3 / lifting micromark into `shared/`, NOT Ring-2↔Ring-2 reuse). Style the emitted HTML through a NEW additive scoped CSS class `.chat-md` in `globals.css` — neutral paragraphs, emphasis, lists, headings, `<hr>`, inline `<code>`, and a neutral mono `<pre><code>` code block (surface `--muted`, `--border`, rounded, `--foreground` mono text) — matching the prototype `design-artifacts/ai-chat-chatgpt.html`'s `.answer` treatment. USER messages stay plain text (unchanged). The live STREAMING partial stays plain text + caret (out of scope; see Boundaries). Presentation-only: no change to `chat-model.ts` shapes/reducers, the streaming/`streamChat` RPC, the schema-only Provider/sandbox seams, `ChatQueryRun`/`ConfirmRun`/`runRawQuery`, or `SandboxFrame`.

## Boundaries & Constraints

**Always:**
- Render the COMMITTED assistant answer body (`decideMessageView`'s `bubbleText`, only for `role:"assistant"` messages) as sanitized HTML via `renderReportMarkdown`, mounted with `dangerouslySetInnerHTML` inside a `.chat-md` wrapper — mirroring `ReportTabView.tsx`'s `ProseBlock` (`useMemo(() => renderReportMarkdown(text), [text])` + a `dangerouslySetInnerHTML` div). The memoization is REQUIRED: the render must not re-run micromark for every message on each composer keystroke — key the memo on the message text.
- Rely on micromark's raw-HTML-disabled default as the sanitization boundary. `renderReportMarkdown` calls `micromark(md, { allowDangerousHtml: false })` (the default, set explicitly) so a `<script>` / `<img onerror=…>` in the model's answer is EMITTED ESCAPED (`&lt;script&gt;`), never live markup, and its URL post-process rewrites any `href`/`src` whose scheme is not http(s)/mailto/relative (and any protocol-relative `//host` and any image `src` with an explicit scheme) to a harmless `#`. Assistant text is UNTRUSTED Provider/model output, so this sanitization is load-bearing — do not bypass it, do not pass `allowDangerousHtml: true`, and do not hand-roll a second renderer.
- Keep the assistant body's neutral look faithful to `design-artifacts/ai-chat-chatgpt.html`: 16px roomy line-height prose, `--foreground` text, `--muted-foreground` list markers, `strong` bolded, well-spaced `<ul>/<ol>`, subtle `<hr>` rules (`--border`), and a fenced code block as a neutral mono surface (mono font, `--muted`/`--card` background, `--border`, rounded, `--foreground` text). All color from `globals.css` tokens; no coral, no new hue.
- Preserve every test-visible string and structural assertion in `ChatTabView.test.tsx` unedited: the empty-state copy `ask a question about your schema`, `schema-only`, `schema-only · 3 tables`, the raw assistant answer text substring (`there are 3 tables`), the generated-SQL substring (`SELECT count(*) FROM customers;`) and `>run<`, the `reasoning` token present ONLY when reasoning exists, and NO `<iframe>` for a plain answer. The `.chat-md` wrapper className must NOT contain the substring `reasoning`.
- Keep USER messages exactly as they are: the right-aligned grey `--user-bubble` rendered as plain, whitespace-preserved text (`ChatTabView.tsx:777-781`). Only the assistant body changes.
- Preserve the generated-SQL block byte-for-byte: `ChatQueryRun` still renders `message.query` read-only in its `<pre>` as a SINGLE verbatim, untokenized mono node (`ChatTabView.tsx:408-410`) — this story does NOT touch it and does NOT add syntax highlighting anywhere.

**Block If:**
- Rendering the assistant Markdown safely would require EITHER (a) enabling raw HTML / weakening `renderReportMarkdown`'s sanitization, (b) adding a syntax-highlighting or Markdown dependency beyond the already-present `micromark`, OR (c) breaking a load-bearing `ChatTabView.test.tsx` string — HALT `blocked`, condition `chat markdown rendering cannot stay sanitized + dependency-free + test-green`.

**Never:**
- Never render the assistant body with `allowDangerousHtml: true`, never introduce a second/looser Markdown pass, and never inject unsanitized model text into the DOM.
- Never change `chat-model.ts` (the `ChatMessage`/`ChatState` shape, reducers, `accumulateStream`, `deriveResultKpis`) or the `streamChat` chunk protocol, `runRawQuery`/`ConfirmRun` seams, or `SandboxFrame` security seam — this is presentation of the message body only.
- Never make user-typed messages render as Markdown (a user typing `*foo*` or `# hi` must see it verbatim, not transformed) — assistant renders Markdown; user stays plain.
- Never add per-token SQL/code syntax coloring in the message body: micromark emits an UNTOKENIZED `<pre><code>`; style it as a neutral mono block. (Consistent with Story 7.5's decision that generated SQL is not tokenized.)
- Never repaint an existing token or add a coral value; the `.chat-md` CSS is additive and token-driven.
- Do not edit `ChatTabView.test.tsx` to make it pass.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Assistant answer with a fenced code block | `bubbleText` contains ` ```sql\nSELECT …\n``` ` | The fence markers and `sql` info-string are NOT visible; the code renders as a styled neutral mono `<pre><code>` block | Malformed/unclosed fence renders as micromark yields it (still no raw backticks leaking as prose) |
| Assistant answer with inline markup | `**bold**`, `` `code` ``, `- item`, `# heading`, `---` | Rendered as `<strong>`, inline `<code>`, `<ul><li>`, `<h*>`, `<hr>` — neutral-styled, no raw markers shown | n/a |
| Plain-prose assistant answer | `bubbleText === "there are 3 tables"` | Renders as a paragraph; the substring `there are 3 tables` is present in the serialized HTML | n/a |
| Empty assistant body (reasoning-only answer) | `bubbleText === ""` (answer empty, reasoning present) | The `.chat-md` body is not rendered (guard on non-empty/trimmed text, mirroring `ProseBlock`); the reasoning block still renders | No empty bordered box |
| Untrusted HTML in answer | answer contains `<script>` / `<img onerror=…>` | Emitted ESCAPED, never live markup (micromark `allowDangerousHtml:false`) | No script/embed executes (R5) |
| Dangerous link/image scheme | answer contains `[x](javascript:…)` / `![y](https://evil/beacon)` | Rewritten to `#` by `renderReportMarkdown`'s URL post-process (no egress on preview) | Safe http(s)/mailto/relative links pass through |
| User message | `role:"user"` | Right-aligned grey `--user-bubble`, plain whitespace-preserved text — UNCHANGED (no Markdown) | n/a |
| Generated-SQL block | `message.query !== null` | `ChatQueryRun` renders the SQL verbatim/untokenized in its `<pre>` — UNCHANGED; body Markdown render is independent of it | n/a |
| Chart-bearing answer | `chartDoc !== null` | `showBubble === false`; the plain body is suppressed and the sandbox owns the prose+chart — UNCHANGED | n/a |
| Streaming in-flight | `partial !== null` | The live partial bubble stays PLAIN text + blinking caret (out of scope); it snaps to rendered Markdown once committed on `done` | n/a |
| Composer keystroke re-render | user types in the composer | Committed messages' Markdown HTML is memoized (keyed on text) — micromark does NOT re-run per keystroke | n/a |
| Theme | `data-theme` / dark default | `.chat-md` reads neutral tokens in both themes; code block + prose legible, no coral | n/a |

</intent-contract>

## Code Map

- `src/ui/workspace/ChatTabView.tsx` (956 lines) — the fix site (assistant body only):
  - **Root cause — replace the raw text node.** The committed assistant body at **L796-800** renders `{bubbleText}` as an escaped text node:
    ```tsx
    {showBubble ? (
      <p className="mb-3.5 whitespace-pre-wrap break-words text-[16px] leading-[1.75] text-[var(--foreground)]">
        {bubbleText}
      </p>
    ) : null}
    ```
    `bubbleText`/`showBubble` come from `decideMessageView(m, chartDoc)` (called **L773**, defined **L258-273**): for an assistant message `bubbleText = extractChartFence(message.text).markdown` and `showBubble = chartDoc === null`. Replace this `<p>{bubbleText}</p>` with a memoized Markdown body: a small LOCAL component (mirror `ReportTabView.tsx`'s `ProseBlock`) e.g. `MarkdownBody({ text })` that does `const html = useMemo(() => renderReportMarkdown(text), [text])` and returns `<div className="chat-md mb-3.5 break-words" dangerouslySetInnerHTML={{ __html: html }} />`, rendered only when `showBubble && bubbleText.trim() !== ""`. Keep the `mb-3.5` spacing so the badge/SQL/actions layout below is unchanged.
  - **Import — add FRESH.** `renderReportMarkdown` is NOT currently imported and there are NO `../report/...` imports in this file today. Add `import { renderReportMarkdown } from "../report/report-markdown.ts";` as a new line after the last import (**L65**, `./run-raw-query.ts`), grouped with the sibling `../…` imports (e.g. near L47-49 `../sandbox/`, `../data/`, `../rpc/`). No other symbol needed.
  - **Leave untouched:** the user bubble (**L779**, plain text `<p className="whitespace-pre-wrap break-words">{bubbleText}</p>`), the `schema-only · N tables` badge (**L802-804**), `ChatQueryRun` (defined **L357**, rendered **L805-816**) and its verbatim `<pre>` SQL (**L408-410**), `ReasoningBlock` (defined **L477**, rendered **L795** — stays plain, out of scope), the assistant action row (**L840-865**), the header/composer, and the **live streaming partial** (**L873-890**, `partial.text` + caret at L884-889) whose body stays PLAIN (see Design Notes — its own separate `<p>`, not the L796-800 target). Every exported function (`streamSend`, `runChatQuery`, `confirmChatQuery`, `cancelChatQuery`, `truncateMarkdown`, `buildChartDoc`, `decideMessageView`, `reconcileChartDocs`) and the `ChatRunEntry` type are unchanged.
- `src/ui/report/report-markdown.ts` (69 lines) — **REUSE, no change.** `export function renderReportMarkdown(md: string): string` (L64): `const html = micromark(md, { allowDangerousHtml: false })` (L65) then a URL-scheme/protocol-relative/image-`src` sanitize (`URL_ATTR_RE` + `isSafeUrl`, `SAFE_URL_SCHEMES = {http, https, mailto}`, L22/L35-54/L66-68). Import it into chat as-is. The file's L9-12 ring-boundary comment forbids ONLY lifting micromark into `shared/` and a Ring-2 importing Ring-3 — it does NOT forbid the Ring-2↔Ring-2 import chat needs.
- `src/ui/report/ReportTabView.tsx` (VERIFY-ONLY reference) — `ProseBlock` (L600) is the mount-pattern to mirror: `const html = useMemo(() => renderReportMarkdown(markdown), [markdown])` (**L607**) + a `dangerouslySetInnerHTML` div (**L621-626**, className `report-prose max-w-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] …`). Chat mirrors the PATTERN with a `.chat-md` class. No change here. NOTE: `report-prose` is only a Tailwind className string — there is NO `.report-prose` CSS rule anywhere; `.chat-md` is genuinely new CSS (below).
- `src/ui/styles/globals.css` (332 lines) — **ADD** one additive scoped block `.chat-md { … }` at the END of the file (after the last rule, L332) styling the micromark output with existing tokens — NO new token, NO coral:
  - `.chat-md` base: `color: var(--foreground)`, `font-size: 16px`, `line-height: 1.75`.
  - `.chat-md p` margins (`0 0 1rem`, last-child `0`); `.chat-md strong { font-weight: 650 }`; `.chat-md em { font-style: italic }`.
  - `.chat-md ul/ol` (padding-left, bottom margin), `.chat-md li` (spacing, `line-height`), `.chat-md li::marker { color: var(--muted-foreground) }`.
  - `.chat-md h1..h6` (bold, sized down toward the prototype's 16px `h3`); `.chat-md hr { border: none; border-top: 1px solid var(--border); margin: 1.25rem 0 }`.
  - `.chat-md code` (inline): mono (`font-family: var(--font-mono-stack)` — the guaranteed `:root` token at L53; `--font-mono` exists only inside `@theme inline`), `font-size: .9em`, subtle `background: var(--muted)`, small padding, rounded, `color: var(--foreground)`.
  - `.chat-md pre` (fenced block): `background: var(--muted)` (or `--card`), `border: 1px solid var(--border)`, `border-radius: var(--radius)`, `padding`, `overflow-x: auto`; `.chat-md pre code` mono, `--foreground`, `background: none` (reset the inline-code background), UNTOKENIZED.
  - `.chat-md a { color: var(--foreground); text-decoration: underline }`; `.chat-md blockquote` (left rule `--border`, `--muted-foreground`).
  - Values resolve in BOTH dark and light because every token has a `:root[data-theme="light"]` override (L109-159). `.chat-md` is referenced nowhere else, so it cannot regress the shell.
- `src/ui/workspace/chat-model.ts` — **NO change.** Shapes/reducers/`accumulateStream`/`deriveResultKpis` are untouched (presentation-only).
- `src/ui/workspace/ChatTabView.test.tsx` (519 lines) — **MUST stay green.** Renders via `renderToStaticMarkup` (no jsdom); every load-bearing assertion is a substring `toContain`/`not.toContain` and none targets the assistant body's tag or `.whitespace-pre-wrap`, so switching `<p>{bubbleText}</p>` → a `.chat-md` `dangerouslySetInnerHTML` div survives: `there are 3 tables` → micromark emits `<p>there are 3 tables</p>` (substring intact); the reasoning gate is unaffected (`.chat-md` has no `reasoning` substring, `ReasoningBlock` unchanged); the SQL/`>run<` assertions target `ChatQueryRun` (untouched); `<iframe>` absence for a plain answer is unchanged. ADD an additive `renderToStaticMarkup` case (new `it`, existing cases untouched) asserting a ` ```sql ` fence in an assistant answer renders `<pre>`/`<code>` and NOT the literal triple-backtick.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/workspace/ChatTabView.tsx` -- add a fresh `import { renderReportMarkdown } from "../report/report-markdown.ts";` (after the last import, L65); add a local memoized `MarkdownBody({ text }: { text: string })` component (`const html = useMemo(() => renderReportMarkdown(text), [text]); return <div className="chat-md mb-3.5 break-words" dangerouslySetInnerHTML={{ __html: html }} />`), mirroring `ProseBlock`; replace the committed assistant body at L796-800 (`<p …>{bubbleText}</p>`) with `{showBubble && bubbleText.trim() !== "" ? <MarkdownBody text={bubbleText} /> : null}` -- renders the assistant answer as sanitized, memoized Markdown while leaving the user bubble, streaming partial, `ChatQueryRun`, `ReasoningBlock`, action row, and all exported functions untouched.
- [x] `src/ui/styles/globals.css` -- append the additive scoped `.chat-md { … }` block at end of file (values per Code Map: token-driven prose + neutral mono `<pre><code>` and inline `<code>`, `--muted`/`--border`/`--radius`/`--foreground`/`--muted-foreground`, `var(--font-mono-stack)`); NO new token, NO coral, NO `@theme` mapping -- styles the micromark output neutrally per `ai-chat-chatgpt.html`, resolving in both themes via the existing `:root[data-theme="light"]` overrides.
- [x] `src/ui/workspace/ChatTabView.test.tsx` -- add ONE additive `it(...)` using `renderToStaticMarkup` that feeds an assistant answer containing a ` ```sql\nSELECT 1\n``` ` fence and asserts the output `toContain("<pre")`/`toContain("<code")` and `not.toContain("```")` -- locks the primary bug fix (no literal fence markers) without editing or weakening any existing case.

**Acceptance Criteria:**
- Given a user message, when it renders, then it stays plain right-aligned grey-bubble text (no Markdown transformation), unchanged from before.
- Given the generated-SQL block (`message.query`), streaming, run/confirm/cancel, the schema-only Provider path, and `SandboxFrame`, when exercised, then their behavior is byte-for-byte identical — only the assistant message body's presentation changed.
- Given `bun test`, when it runs, then `ChatTabView.test.tsx` passes with every EXISTING case unedited (the load-bearing strings — `ask a question about your schema`, `schema-only · 3 tables`, `there are 3 tables`, `SELECT count(*) FROM customers;`, `>run<`, the `reasoning` token gated on reasoning presence, no `<iframe>` for a plain answer — all still present/absent as asserted) plus the new additive fence case, and `report-markdown.test.ts` stays green.
- Given `bunx tsc --noEmit`, when it runs, then there are no type errors (presentation-only change + one reused import).
- Given light and dark themes, when toggled, then the assistant Markdown body (prose + code block) renders neutral and legible in both, with no coral.
- Given a live app at `http://127.0.0.1:6061` (Epic-8 live-visual gate), when the AI Chat shows an assistant answer whose prose contains a ` ```sql ` fence plus `**bold**`, a bulleted list, and a `---` rule, then the bubble shows a styled neutral code block (no visible backticks / `sql` marker), bold text, a real bullet list, and a horizontal rule, while the separate generated-SQL block below still shows the SQL verbatim.

## Spec Change Log

## Review Triage Log

### 2026-07-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 1: (high 0, medium 1, low 0)
- reject: 6
- addressed_findings:
  - `[medium]` `[patch]` Rendered model links became live anchors with no `target`/`rel`, so a click would navigate the whole app document away and destroy the ephemeral chat session (links were literal text before this change). Post-process the sanitized HTML in `MarkdownBody` to force `target="_blank" rel="noopener noreferrer"` on every anchor (chat-local; does NOT touch the shared `renderReportMarkdown`), plus a `.chat-md a:hover` state. Verified: the added security/mount test stays green; the regex runs once inside the existing `useMemo`. (`src/ui/workspace/ChatTabView.tsx`, `src/ui/styles/globals.css`)
  - `[low]` `[patch]` The new fence test was a weak proxy (`not.toContain("```")` only). Strengthened it to assert `<pre><code` nesting and that the fence CONTENT (`SELECT 1`) survives, and added a second additive test proving untrusted raw HTML (`<script>`/`<img onerror>`) is ESCAPED at the chat mount (not just the report unit test) — the story's own load-bearing security posture is now covered at this integration point. Existing cases untouched. (`src/ui/workspace/ChatTabView.test.tsx`)
  - `[low]` `[patch]` Only `.chat-md p:last-child` reset its margin, so an answer ending in a list/`pre`/heading/blockquote stacked extra bottom margin on the wrapper `mb-3.5`, and a heading-led answer pushed its first line down — misaligning the body against the avatar. Replaced with `.chat-md > :first-child { margin-top:0 }` + `.chat-md > :last-child { margin-bottom:0 }`. (`src/ui/styles/globals.css`)
  - `[low]` `[patch]` A model `<img>` (neutralized to `src="#"` by the egress policy) had no `max-width`, so a broken image could overflow the 760px column. Added `.chat-md img { max-width:100%; height:auto }`. (`src/ui/styles/globals.css`)
  - `[low]` `[patch]` A long unbroken inline `<code>` token (SQL identifiers are common here) could widen the reading column since only the block `pre` got `overflow-x:auto`. Added `overflow-wrap: anywhere` to `.chat-md code`. (`src/ui/styles/globals.css`)
  - `[low]` `[patch]` The `.chat-md` header comment claimed "every value reads an existing token" while the block hardcodes px/rem/em/font-weight literals. Softened to "all colors read existing tokens" so it does not mislead a future maintainer. (`src/ui/styles/globals.css`)

Deferred (1 — real limitation, out of scope): assistant answers with a GFM Markdown table collapse to literal pipe text because the reused `renderReportMarkdown` uses micromark CORE only (no gfm extension) — enabling GFM is forbidden by this story's Block-If (b) (no new Markdown dependency) and would cross-cut the shared report renderer; logged to `deferred-work.md` for a focused follow-up.

Rejected (6 — spec-mandated, pre-existing, or unconfirmed): streaming-partial→commit visual snap (spec explicitly scopes the live partial to plain text — intentional, documented in Design Notes); single-`\n` soft-break collapse and multi-space/indentation collapse (standard Markdown/HTML behavior, inherent to the spec-mandated `renderReportMarkdown` reuse, consistent with the report path); possible duplicate SQL when a prose fence coincides with the structured `message.query` panel (unconfirmed — the two are independent data sources and any duplication predates this presentational change); no length clamp on a very long committed answer (pre-existing; the new micromark parse is one-time and memoized, matching `ProseBlock` parsing whole reports); and a review-integrity note that the paraphrased diff shown to a reviewer wasn't valid CSS (the actual committed `globals.css` is correct — an artifact of the review prompt, not the code).

## Design Notes

**Reuse `renderReportMarkdown`, don't fork it.** It already encodes the exact security posture chat needs (raw HTML disabled + URL sanitize), it is Ring-2, and it is unit-tested (`report-markdown.test.ts`). The name says "report" but the behavior is generic safe-prose; a direct import is the minimal, lowest-risk path. A shared/renamed module is NOT warranted for one more caller — if the team later wants a neutral name, alias it in place (`export const renderMarkdown = renderReportMarkdown`) without moving code or touching `shared/` (which is dependency-free by contract and cannot host micromark).

**Sanitization is the security story — state it explicitly.** Assistant text is untrusted model output routed through the Core stream; a prompt-injected model could try to emit `<script>`, `<img src=x onerror=…>`, or `[click](javascript:…)`. micromark's `allowDangerousHtml: false` (the default, set explicitly in `renderReportMarkdown`) ESCAPES raw HTML rather than emitting it, and the URL post-process neutralizes dangerous/off-origin/`data:` link and image destinations to `#`. We RELY on this (no extra sanitizer needed) and `report-markdown.test.ts` already locks it. The app is schema-only/no-egress; blocking remote image `src` (which `renderReportMarkdown` does) also prevents a beacon-on-preview.

**Code blocks are neutral, NOT syntax-highlighted.** micromark alone emits an untokenized `<pre><code class="language-sql">…</code></pre>`; there is no highlighter dependency and adding one is out of scope (Block If (b)). Style the block as a neutral mono surface. This both fixes the bug (no literal backticks) and stays consistent with Story 7.5's ruling that generated SQL is rendered verbatim/untokenized. The separate `ChatQueryRun` gen-sql block is likewise untouched.

**Assistant renders Markdown; user stays plain.** The bug is model-emitted Markdown syntax in the ASSISTANT body — that is where rendering belongs. User messages are echoed exactly as typed; transforming a user's literal `*`/`#`/backticks would be surprising and is not the reported problem. This keeps the user bubble byte-for-byte and scopes the change to one render site.

**Live streaming partial stays plain (scoped out).** The reported bug (screenshot) is a COMMITTED message bubble. The in-flight partial (`ChatTabView.tsx:873-890`, its OWN `<p>{partial.text}</p>` at L884, separate from the L796-800 committed body) is transient and, mid-stream, carries half-parsed Markdown (an unclosed ```fence); rendering micromark on every animation-frame flush would re-parse growing text each frame and could flash a partially-formed code block. Keep the live partial plain text + blinking caret; it snaps to fully-rendered Markdown the instant it commits on `done`. This is an intentional scoping decision, not a defect — markdown-rendering the live stream can be a later story if desired.

**Memoize like `ProseBlock`.** `ChatTabView` re-renders on every composer keystroke (`setInput`). Rendering micromark for every committed message per keystroke is wasteful; memoize per-message HTML on the message text (a `useMemo`-backed `MarkdownBody` subcomponent, exactly as `ProseBlock` does), so only new/changed messages re-parse.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors across `ChatTabView.tsx` (and the reused `report-markdown.ts` import).
- `bun test` — expected: all suites pass; `ChatTabView.test.tsx` existing cases unedited + the new additive fence case green, and `report-markdown.test.ts` green.
- `rg 'allowDangerousHtml' src/ui/workspace/ChatTabView.tsx` — expected: NO match (chat never passes the flag; it goes through `renderReportMarkdown`, which sets `false`).
- `rg 'dangerouslySetInnerHTML' src/ui/workspace/ChatTabView.tsx` — expected: exactly one hit (the assistant body); and `rg 'coral|bg-\[#' src/ui/workspace/ChatTabView.tsx` — expected: no coral/hardcoded-palette hit.
- `rg '\.chat-md' src/ui/styles/globals.css` — expected: the new additive scoped block is present.

**Manual check (live — REQUIRED for the primary criterion, Epic-8 gate):**
- Launch the app and open the AI Chat at `http://127.0.0.1:6061`. Send a prompt that yields an assistant answer whose prose contains a ` ```sql ` fenced block plus some `**bold**`, a bulleted list, and a `---` rule. Confirm the message bubble shows a styled code block (no visible backticks / `sql` marker), bold text, a real bullet list, and a horizontal rule — while the separate "generated SQL" block below still shows the SQL verbatim. Toggle the theme (`document.documentElement.dataset.theme = "light"`) and confirm both light and dark stay neutral and legible, no coral.

## Auto Run Result

Status: done

### Summary of implemented change
Presentation-only fix for the reported bug (item 9): the COMMITTED assistant chat message body was rendering the model's Markdown answer as a raw escaped text node, so fenced code blocks, inline code, lists, headings, emphasis, and rules all showed their literal markers. The body now renders through the project's EXISTING security-reviewed micromark renderer `renderReportMarkdown` (`micromark(md, { allowDangerousHtml: false })` + URL-scheme sanitize), mounted via `dangerouslySetInnerHTML` inside a new additive, token-driven `.chat-md` wrapper — mirroring `ReportTabView`'s `ProseBlock`, memoized on the message text so micromark does not re-run per composer keystroke. USER messages, the live streaming partial (stays plain + caret, scoped out), the generated-SQL `ChatQueryRun` block, `ReasoningBlock`, reducers/`chat-model.ts`, the `streamChat` RPC, and `SandboxFrame` are all untouched. No new dependency (micromark already present), no raw-HTML path, no coral, no syntax highlighting.

### Files changed
- `src/ui/workspace/ChatTabView.tsx` — added a fresh `renderReportMarkdown` import; added a local memoized `MarkdownBody({ text })` component (`useMemo` → `renderReportMarkdown`, then a chat-local regex forcing `target="_blank" rel="noopener noreferrer"` on any surviving anchor); replaced the assistant body `<p>{bubbleText}</p>` with `{showBubble && bubbleText.trim() !== "" ? <MarkdownBody text={bubbleText} /> : null}`.
- `src/ui/styles/globals.css` — appended the additive scoped `.chat-md { … }` block (neutral prose + inline `<code>` + a neutral mono `<pre><code>` surface + list markers + `<hr>` + links/blockquote/img), all from existing tokens; includes the review-added first/last-child margin resets, `img` max-width, inline-code `overflow-wrap`, and `a:hover`.
- `src/ui/workspace/ChatTabView.test.tsx` — added two additive `renderToStaticMarkup` cases (fenced-block renders `<pre><code>` with content intact and no literal backticks; raw HTML is escaped at the chat mount). No existing case edited.
- (Build output `src/core/ui-bundle.generated.ts` regenerated by `bun run build`; gitignored, not committed.)

### Review findings breakdown
- **Patches applied (6):** link `target`/`rel` hardening so a model link can't navigate the app away and lose the chat session (medium); strengthened + added security test at the chat mount (low); `.chat-md` first/last-child margin resets (low); `img` max-width overflow guard (low); inline-`code` `overflow-wrap` (low); corrected an overstated CSS header comment (low). All re-verified green.
- **Deferred (1):** GFM Markdown tables collapse to literal pipe text (micromark core has no table extension; enabling it is forbidden by Block-If (b) and would cross-cut the shared report renderer) — logged to `deferred-work.md`.
- **Rejected (6):** streaming→commit visual snap (spec-scoped intentional), soft-newline/whitespace collapse (standard Markdown behavior, inherent to the mandated renderer reuse), possible duplicate SQL (unconfirmed, independent data sources), no long-answer clamp (pre-existing + memoized), and a review-artifact note about a paraphrased diff (real file is correct).

### Follow-up review recommendation
`false` — the six patches are localized, presentation-only CSS/test/doc fixes plus one small, tested behavioral hardening (anchor `target`/`rel` via a one-time memoized regex that does not touch the shared renderer or the sanitization boundary). No API/data/security-boundary change; full suite + build + static visual gate all re-confirmed. No independent follow-up warranted.

### Verification performed
- `bunx tsc --noEmit` → clean (exit 0).
- `bun test` → 1143 pass / 0 fail / 2835 expect() across 70 files (was 1141 before the story; +2 additive chat tests). `ChatTabView.test.tsx` existing cases unedited, `report-markdown.test.ts` green.
- `bun run build` → all build scripts succeeded; the served CSS bundle (`src/core/ui-bundle.generated.ts`) contains the `.chat-md` rules.
- Guard checks: `rg 'allowDangerousHtml' src/ui/workspace/ChatTabView.tsx` → no match; `rg -c 'dangerouslySetInnerHTML' …` → exactly 1; `rg -c '\.chat-md' src/ui/styles/globals.css` → present (30 hits).
- **Epic-8 live-visual gate — STATIC fallback (headless tooling unavailable in this environment: no playwright/chrome in `node_modules`/PATH):** 6/6 PASS against the COMPILED served CSS — the `.chat-md` `<pre>` resolves to an opaque `--muted` surface with a `--border` border and `--radius` corners (reads as a code block, not literal backticks), inline `<code>` has the subtle `--muted` tint + mono font, list markers use `--muted-foreground`, `<hr>` is a subtle rule, ZERO coral anywhere in the `.chat-md` subtree, and foreground-on-surface contrast is AAA in both dark (12.94) and light (15.84); first/last-child margin resets present.

### Residual risks
- The Epic-8 live-visual gate was satisfied by the STATIC fallback (compiled-CSS + resolved-token + WCAG-contrast verification), NOT the full headless browser render Story 8.3 ran — `playwright-core`/`chrome-headless-shell` are not installed in this environment. The rendered LAYOUT of a real assistant answer (very wide `<pre>` horizontal scroll, long-line wrapping, exact spacing against the avatar) was not visually confirmed in a browser; a one-time manual spot-check at `http://127.0.0.1:6061` against `design-artifacts/ai-chat-chatgpt.html` remains the only unverified surface. Functional rendering (fence → `<pre><code>`, no literal backticks, raw-HTML escaped) IS proven by the new unit tests.
- GFM tables render as collapsed literal pipes (deferred, see above) — the one known content shape this fix does not beautify.
