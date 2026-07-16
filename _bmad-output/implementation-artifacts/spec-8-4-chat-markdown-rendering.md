---
title: 'Render assistant chat messages as sanitized Markdown — stop showing literal markdown syntax (fenced code blocks, inline code, lists, emphasis) in the message bubble'
type: 'bug'
created: '2026-07-16'
status: 'backlog'
context:
  - '{project-root}/src/ui/workspace/ChatTabView.tsx'
  - '{project-root}/src/ui/workspace/chat-model.ts'
  - '{project-root}/src/ui/report/report-markdown.ts'
  - '{project-root}/src/ui/report/ReportTabView.tsx'
  - '{project-root}/src/ui/styles/globals.css'
  - '{project-root}/design-artifacts/ai-chat-chatgpt.html'
  - '{project-root}/src/ui/workspace/ChatTabView.test.tsx'
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

- `src/ui/workspace/ChatTabView.tsx` (957 lines) — the fix site (assistant body only):
  - **Root cause — replace the raw text node.** The assistant body at **L796-800** renders `{bubbleText}` as an escaped text node:
    ```tsx
    {showBubble ? (
      <p className="mb-3.5 whitespace-pre-wrap break-words text-[16px] leading-[1.75] text-[var(--foreground)]">
        {bubbleText}
      </p>
    ) : null}
    ```
    Replace this `<p>{bubbleText}</p>` with a memoized Markdown body: a small local component (mirror `ReportTabView.tsx`'s `ProseBlock`) e.g. `MarkdownBody({ text })` that does `const html = useMemo(() => renderReportMarkdown(text), [text])` and returns `<div className="chat-md mb-3.5 …" dangerouslySetInnerHTML={{ __html: html }} />`, rendered only when `showBubble && bubbleText.trim() !== ""`. Keep the `mb-3.5` spacing so the badge/SQL/actions layout below is unchanged.
  - **Import** `renderReportMarkdown` from `../report/report-markdown.ts` (new import beside the existing sibling imports at L37-65). No other symbol needed.
  - **Leave untouched:** the user bubble (L777-781, plain text), the `schema-only · N tables` badge (L801-804), `ChatQueryRun` and its verbatim `<pre>` SQL (L357-468), `ReasoningBlock` (L477-502, stays plain — out of scope), the assistant action row (L840-865), the header/composer, and the **live streaming partial** (L873-894) whose `{partial.text}` + caret stays PLAIN (Design Notes). Every exported function (`streamSend`, `runChatQuery`, `confirmChatQuery`, `cancelChatQuery`, `truncateMarkdown`, `buildChartDoc`, `decideMessageView`, `reconcileChartDocs`) is unchanged.
- `src/ui/report/report-markdown.ts` (69 lines) — **REUSE, no change.** `renderReportMarkdown(md)` is a generic sanitized-prose renderer: `micromark(md, { allowDangerousHtml: false })` then a URL-scheme/backslash/protocol-relative sanitize (and image-`src` egress block). Import it into chat as-is. (Optional, non-required nicety: add `export const renderMarkdown = renderReportMarkdown;` if a report-neutral name is preferred at the chat call site — behavior identical, no test impact. Not necessary.)
- `src/ui/report/ReportTabView.tsx` (VERIFY-ONLY reference) — `ProseBlock` (L600-630) is the exact reuse pattern to mirror: `useMemo(() => renderReportMarkdown(markdown), [markdown])` + a `dangerouslySetInnerHTML` div with a `report-prose` class. Chat mirrors this with a `.chat-md` class. No change here.
- `src/ui/styles/globals.css` (244 lines) — **ADD** one additive scoped block `.chat-md { … }` (near the end, after the body rule at L235-243) styling the micromark output with existing tokens — NO new token, NO coral:
  - `.chat-md` base: `color: var(--foreground)`, `font-size: 16px`, `line-height: 1.75`.
  - `.chat-md p` margins (`0 0 1rem`, last-child `0`); `.chat-md strong { font-weight: 650 }`; `.chat-md em`.
  - `.chat-md ul/ol` (padding-left, bottom margin), `.chat-md li` (spacing, `line-height`), `.chat-md li::marker { color: var(--muted-foreground) }`.
  - `.chat-md h1..h6` (bold, sized down toward the prototype's 16px `h3`); `.chat-md hr { border: none; border-top: 1px solid var(--border); margin: 1.25rem 0 }`.
  - `.chat-md code` (inline): mono (`font-family: var(--font-mono-stack)`), `font-size: .9em`, subtle `background: var(--muted)`, small padding, rounded, `color: var(--foreground)`.
  - `.chat-md pre` (fenced block): `background: var(--muted)` (or `--card`), `border: 1px solid var(--border)`, `border-radius: var(--radius)`, `padding`, `overflow-x: auto`; `.chat-md pre code` mono, `--foreground`, no inline-code background (reset), UNTOKENIZED.
  - `.chat-md a { color: var(--foreground); text-decoration: underline }`; `.chat-md blockquote` (left rule `--border`, `--muted-foreground`).
  - Values resolve in BOTH dark and light because every token already has a `[data-theme="light"]` override (L107-155). `.chat-md` is not referenced anywhere else, so it cannot regress the shell.
- `src/ui/workspace/chat-model.ts` — **NO change.** Shapes/reducers/`accumulateStream`/`deriveResultKpis` are untouched (presentation-only).
- `src/ui/workspace/ChatTabView.test.tsx` (519 lines) — **MUST stay green UNEDITED.** The relevant assertions survive because: `there are 3 tables` → micromark emits `<p>there are 3 tables</p>` (substring intact); the reasoning gate (`toContain`/`not.toContain("reasoning")`) is unaffected (`.chat-md` has no `reasoning` substring, `ReasoningBlock` unchanged); the SQL/`>run<` assertions target `ChatQueryRun` (untouched); `<iframe>` absence for a plain answer is unchanged. Add NO new test file is required, but an OPTIONAL additive `renderToStaticMarkup` case asserting a ` ```sql ` fence in the body renders `<pre>`/`<code>` (and NOT the literal triple-backtick) documents the fix — additive only, do not disturb existing cases.

## Design Notes

**Reuse `renderReportMarkdown`, don't fork it.** It already encodes the exact security posture chat needs (raw HTML disabled + URL sanitize), it is Ring-2, and it is unit-tested (`report-markdown.test.ts`). The name says "report" but the behavior is generic safe-prose; a direct import is the minimal, lowest-risk path. A shared/renamed module is NOT warranted for one more caller — if the team later wants a neutral name, alias it in place (`export const renderMarkdown = renderReportMarkdown`) without moving code or touching `shared/` (which is dependency-free by contract and cannot host micromark).

**Sanitization is the security story — state it explicitly.** Assistant text is untrusted model output routed through the Core stream; a prompt-injected model could try to emit `<script>`, `<img src=x onerror=…>`, or `[click](javascript:…)`. micromark's `allowDangerousHtml: false` (the default, set explicitly in `renderReportMarkdown`) ESCAPES raw HTML rather than emitting it, and the URL post-process neutralizes dangerous/off-origin/`data:` link and image destinations to `#`. We RELY on this (no extra sanitizer needed) and `report-markdown.test.ts` already locks it. The app is schema-only/no-egress; blocking remote image `src` (which `renderReportMarkdown` does) also prevents a beacon-on-preview.

**Code blocks are neutral, NOT syntax-highlighted.** micromark alone emits an untokenized `<pre><code class="language-sql">…</code></pre>`; there is no highlighter dependency and adding one is out of scope (Block If (b)). Style the block as a neutral mono surface. This both fixes the bug (no literal backticks) and stays consistent with Story 7.5's ruling that generated SQL is rendered verbatim/untokenized. The separate `ChatQueryRun` gen-sql block is likewise untouched.

**Assistant renders Markdown; user stays plain.** The bug is model-emitted Markdown syntax in the ASSISTANT body — that is where rendering belongs. User messages are echoed exactly as typed; transforming a user's literal `*`/`#`/backticks would be surprising and is not the reported problem. This keeps the user bubble byte-for-byte and scopes the change to one render site.

**Live streaming partial stays plain (scoped out).** The reported bug (screenshot) is a COMMITTED message bubble. The in-flight partial (`ChatTabView.tsx:873-894`) is transient and, mid-stream, carries half-parsed Markdown (an unclosed ```fence); rendering micromark on every animation-frame flush would re-parse growing text each frame and could flash a partially-formed code block. Keep the live partial plain text + blinking caret; it snaps to fully-rendered Markdown the instant it commits on `done`. This is an intentional scoping decision, not a defect — markdown-rendering the live stream can be a later story if desired.

**Memoize like `ProseBlock`.** `ChatTabView` re-renders on every composer keystroke (`setInput`). Rendering micromark for every committed message per keystroke is wasteful; memoize per-message HTML on the message text (a `useMemo`-backed `MarkdownBody` subcomponent, exactly as `ProseBlock` does), so only new/changed messages re-parse.

## Acceptance Criteria

- **(Primary — the reported bug)** Given an assistant message whose answer body contains a ` ```sql\nSELECT … \n``` ` fenced block, when it renders, then the fence markers (triple backticks) and `sql` info-string are NOT visible and the SQL shows as a styled neutral mono code block — verified live at `http://127.0.0.1:6061` (open the AI Chat, produce/inspect an assistant message whose prose includes a fenced block).
- Given an assistant answer containing `**bold**`, `` `inline code` ``, a `- bullet` list, a `# heading`, and a `---` rule, when it renders, then each appears as formatted HTML (`<strong>`, inline `<code>`, `<ul><li>`, heading, `<hr>`) with no raw markers, styled neutrally per `design-artifacts/ai-chat-chatgpt.html`.
- Given the assistant body renderer, when it is exercised, then it goes through `renderReportMarkdown` (micromark `allowDangerousHtml:false` + URL sanitize): a `<script>`/`<img onerror>` in the answer is emitted escaped (never live) and a `javascript:`/protocol-relative/remote-image URL is neutralized to `#`.
- Given a user message, when it renders, then it stays plain right-aligned grey-bubble text (no Markdown transformation), unchanged from before.
- Given the generated-SQL block (`message.query`), streaming, run/confirm/cancel, the schema-only Provider path, and `SandboxFrame`, when exercised, then their behavior is byte-for-byte identical — only the assistant message body's presentation changed.
- Given `bun test`, when it runs, then `ChatTabView.test.tsx` passes UNEDITED (the load-bearing strings — `ask a question about your schema`, `schema-only · 3 tables`, `there are 3 tables`, `SELECT count(*) FROM customers;`, `>run<`, the `reasoning` token gated on reasoning presence, no `<iframe>` for a plain answer — are all still present/absent as asserted), and `report-markdown.test.ts` stays green.
- Given `bunx tsc --noEmit`, when it runs, then there are no type errors (presentation-only change + one reused import).
- Given light and dark themes, when toggled, then the assistant Markdown body (prose + code block) renders neutral and legible in both, with no coral.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors across `ChatTabView.tsx` (and the reused `report-markdown.ts` import).
- `bun test` — expected: all suites pass; `ChatTabView.test.tsx` UNEDITED and `report-markdown.test.ts` green.
- `rg 'allowDangerousHtml' src/ui/workspace/ChatTabView.tsx` — expected: NO match (chat never passes the flag; it goes through `renderReportMarkdown`, which sets `false`).
- `rg 'coral.*#|bg-\[#|dangerouslySetInnerHTML' src/ui/workspace/ChatTabView.tsx` — expected: exactly one `dangerouslySetInnerHTML` (the assistant body) and no coral/hardcoded palette hit.
- `rg '\.chat-md' src/ui/styles/globals.css` — expected: the new additive scoped block is present.

**Manual check (live — REQUIRED for the primary criterion):**
- Launch the app and open the AI Chat at `http://127.0.0.1:6061`. Send a prompt that yields an assistant answer whose prose contains a ` ```sql ` fenced block plus some `**bold**`, a bulleted list, and a `---` rule. Confirm the message bubble shows a styled code block (no visible backticks / `sql` marker), bold text, a real bullet list, and a horizontal rule — while the separate "generated SQL" block below still shows the SQL verbatim. Toggle the theme and confirm both light and dark stay neutral and legible.
