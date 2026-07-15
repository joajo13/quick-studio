---
title: 'Redesign the AI chat to neutral — port the ChatGPT-style prototype onto the chat surface (presentation-only)'
type: 'refactor'
created: '2026-07-13'
baseline_revision: '06d4b1a491f99d46a99a736a3fddb0c94ccb2c99'
final_revision: 'df81682bc9aad3ad1d275a00fa982841dc276eb6'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/design-artifacts/ai-chat-chatgpt.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** The product is pivoting its whole UI from the coral / monospace-heavy dev-tool skin to a NEUTRAL, ChatGPT-style look — near-black canvas, ink (`#ececec`) accent, NO coral, color spent only where it is functional. The AI chat view is the MOLD the entire pivot is based on: it is the one surface the visual language is derived from. Until the real chat surface matches the prototype, the pivot has no reference implementation in the app, and the chat still wears the old coral-token skin (`--coral*`, `border-[var(--coral-line)]`, `bg-[var(--coral-soft)]`) and the mono-everywhere dev-tool treatment.

**Approach:** PORT the visual language of `design-artifacts/ai-chat-chatgpt.html` onto the existing chat components as a **presentation-only** refactor — change JSX structure, class names, and CSS/design tokens ONLY; do not touch behavior, RPC, wire contracts, sandbox security, or the passing test suite. The prototype is the VISUAL SOURCE OF TRUTH and SUPERSEDES any coral direction still lingering in `DESIGN.md` / `EXPERIENCE.md`; where those docs say "coral accent", read "neutral ink". The redesigned chat reproduces the prototype's anatomy: a header with a model button (`provider · schema-only ▾`) and a privacy chip ("Provider sees schema only — no rows leave the Core"); a right-aligned grey user bubble; a collapsible reasoning channel ("Thought for…" / live "Thinking…") rendered as a muted left-ruled stream; a generated-SQL block with syntax highlighting plus copy / open-in-editor affordances and the existing run action; inline KPIs + a mini result table (functional money/count colors, tabular-nums); an assistant action row (copy / thumbs / share / regenerate); an ink composer pill with the schema-only note; and a streaming caret on the in-flight answer. All neutral; color appears ONLY on SQL syntax, KPI money/count, the privacy/schema-only green, and error red. This story redesigns the CHAT TAB VIEW content only — not the surrounding workspace shell chrome (identity rail, workspace tab bar, conversations sidebar), which the prototype shows purely as context.

## Boundaries & Constraints

**Always:**
- Presentation-only: the visual result matches `design-artifacts/ai-chat-chatgpt.html`. Only JSX markup, class names, and CSS/tokens change; every exported function's signature and behavior is preserved verbatim (`streamSend`, `runChatQuery`, `confirmChatQuery`, `cancelChatQuery`, `truncateMarkdown`, `buildChartDoc`, `reconcileChartDocs`, `decideMessageView`, and the `chat-model.ts` reducers/selectors).
- Neutral palette only, dark-first with a matching light theme (per the prototype's `:root` / `[data-theme="light"]` / `prefers-color-scheme` blocks). Color is spent ONLY where it is FUNCTIONAL: SQL syntax highlighting, KPI money/count, the privacy / schema-only green, and error red. Every other surface is a neutral grey or ink.
- Preserve the test-visible DOM so the existing `bun test` suite stays green without edits to the tests: the literal strings `schema-only`, `schema-only · N tables` (e.g. `schema-only · 3 tables`), the empty-state copy `ask a question about your schema`, the run-button label rendered as `>run<`, the reasoning token `reasoning` present ONLY when a message carries reasoning (a prose-only answer's HTML must NOT contain `reasoning`), the raw assistant answer text, the read-only generated SQL text, and NO `<iframe>` for a plain (non-chart) answer. (The prototype's `class="reasoning"` on the `<details>` conveniently satisfies the `reasoning` token gate.)
- Preserve the schema-only Provider path exactly: Ring 2 holds NO provider key and makes NO outbound provider call; it opens the token-gated `POST /chat/stream` SSE via `streamChat`; the Core remains the sole key holder. The header privacy chip and composer note only VISUALIZE this invariant — they must reflect the real policy, never fake it.
- Preserve the cross-origin JS sandbox behavior in `SandboxFrame.tsx`: `sandbox="allow-scripts"` and NEVER `allow-same-origin`, the injected Ring 3 origin (`__QS_SANDBOX_ORIGIN__`), rebind-on-`load` (`rebindHost`), height coalescing, the single window `message` listener, the max-height clamp, and `datum-clicked` / `error` forwarding — all untouched. Only the frame's OUTER wrapper presentation (container spacing/border) may adapt to the neutral look.
- Preserve the streaming RPC flow: rAF-coalesced partials (`schedulePartial`), abort-on-unmount, the mounted guard, `done` / `error` terminal handling, and the per-message run / confirm / cancel re-entrancy guards (`firing`, `runFiring`). The generated-SQL run still drives the SAME `runRawQuery` seam and the SAME `ConfirmRun` dialog; the UI never parses/classifies the SQL (AR-3) — it sends `pendingSql` verbatim.
- Keyboard operability and a discreet monochrome `:focus-visible` ring are preserved (never a coral ring, never the harsh white default rectangle); honor `prefers-reduced-motion` for the streaming caret and reasoning fade.

**Block If:**
- The neutral chat look cannot be reached without EITHER (a) reintroducing a coral color value, (b) weakening the sandbox security seam, OR (c) breaking a load-bearing test string above — HALT `blocked`, condition `neutral chat redesign cannot stay presentation-only + secure + test-green`.

**Never:**
- No coral, anywhere: no coral hex literal, and no `--coral*` (or any) token set to a coral color. The existing `--coral*` tokens already alias to neutral ink; do not restore a coral value. Prefer migrating chat usages to neutral `--ink`/neutral tokens; at minimum, emit no coral color.
- No change to logic, RPC, or wire contracts: `ChatMessage` / `ChatState` shape, the `chat-model.ts` reducers, the `streamChat` chunk protocol, `runRawQuery` / `ConfirmRun` seams, and `shared/contract.ts` types stay exactly as they are.
- No change to sandbox security: no `allow-same-origin`, no relaxed sandbox attrs, no widened `postMessage` target/origin, no inlining the untrusted guest into the parent document.
- No new outbound provider call from Ring 2 and no API-key handling in the UI; chat state stays session-only (never persisted to the workspace snapshot).
- Do not edit the tests to make them pass; do not remove or rename any test-visible string listed above.
- Do not redesign the surrounding workspace shell chrome (identity rail, workspace tab bar, conversations sidebar) in this story — those are separate stories; the prototype shows them only as context. Scope is the chat tab view content.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty chat | `state.messages=[]`, `partial===null` | Centered neutral muted empty prompt with the exact copy `ask a question about your schema` | n/a |
| User turn | a `role:"user"` message | Right-aligned grey rounded bubble (`--user-bubble`), ~75% max-width, neutral text | n/a |
| Assistant answer, no reasoning | `role:"assistant"`, `reasoning===null` | Assistant body with NO reasoning channel; the `schema-only · N tables` badge; assistant action row | HTML must NOT contain the token `reasoning` |
| Assistant answer, with reasoning | `reasoning!==null` | Collapsible `<details class="reasoning">` collapsed by default; summary reads "Thought for…" (live: "Thinking…"); muted left-ruled steps | HTML contains the token `reasoning`; both the label and the reasoning text render |
| Generated SQL present | `message.query!==null` | Neutral code block: syntax-highlighted SQL (functional syntax colors), copy + open-in-editor affordances, and the run action whose label renders exactly `run`; SQL shown read-only, verbatim | Copy failure is a no-op; open-in-editor routes to the query tab (presentation affordance) without mutating chat state |
| Query run → rows | `entry.outcome.kind==="rows"` | Inline KPI strip (money/count functional colors, tabular-nums) + mini result table / `DataGrid`, neutral; single active result | `truncated` banner preserved (neutral/amber) |
| Query run → destructive/DDL | `entry.outcome.kind==="confirm"` | The SAME `ConfirmRun` dialog renders unchanged; confirm re-issues frozen `pendingSql` | Verbatim `pendingSql`, `confirmed:true` only when a confirm is pending |
| Query run → error | `entry.outcome.kind==="error"` | In-panel error text (functional red) with `role="alert"`; never console-only | Error stays until the next run |
| Streaming in-flight | `partial!==null` | Live assistant bubble with a blinking streaming caret; reasoning channel live/open while thinking | Caret + reasoning fade honor `prefers-reduced-motion` |
| Chart-bearing answer | `chartDoc!==null` | `SandboxFrame` iframe (cross-origin `allow-scripts`, injected origin) renders the rich Markdown + Plot; the plain bubble is suppressed (no duplicate prose) | Guest render error → inline neutral/amber note; a plain answer mounts NO `<iframe>` |
| Header model / provider | header | Model button shows `provider · schema-only ▾` and drives the existing provider selection (maps onto the current `<select>` behavior + `validateSend`) | No providers configured / list failure → the existing empty-state / error copy preserved |
| Privacy indicator | always | Header privacy chip "Provider sees schema only — no rows leave the Core" (restrained green) + composer schema-only note | Purely visual; reflects the real schema-only policy, holds no key |
| Theme | `data-theme` / `prefers-color-scheme` | Neutral tokens resolve in BOTH light and dark; no coral in either | — |

</intent-contract>

## Code Map

- `src/ui/styles/globals.css` (200 lines) — add the neutral FUNCTIONAL tokens the prototype needs and this file lacks. Confirmed MISSING (add to dark `:root` beside `--ok`/`--ok-soft` ~L62-63, AND to `:root[data-theme="light"]` beside its `--ok` overrides ~L117-118): `--money` (dark `#6ec6a8` / light `#157a56`), `--count` (dark `#7fb3ff` / light `#2f6fd6`), `--user-bubble` (dark `#2f2f2f` / light `#e8e8e8`), `--composer-bg` (dark `#2f2f2f` / light `#f4f4f4`). Expose `--color-money`/`--color-count`/`--color-user-bubble`/`--color-composer-bg` in the `@theme inline` block (beside the existing `--color-ok*` aliases ~L160-168). REUSE (do not re-add): `--ok`/`--ok-soft` (already present and value-matched to the prototype's privacy green), `--muted`/`--card`/`--border` for the SQL-block and chip surfaces, and `--coral` (= ink `#ececec`/`#0d0d0d`) for the ink accent. Do NOT add an `--sql-*` syntax palette — the generated-SQL text is NOT tokenized (see Design Notes). Introduce no coral value.
- `src/ui/workspace/ChatTabView.tsx` (787 lines) — the primary port; markup/classes/tokens ONLY. Restyle each area, preserving every exported function and every test-visible string:
  - Header (~L607-630): style the existing `<label>` + `<select aria-label="provider">` (L611) as a neutral "model button" reading `{provider} · schema-only ▾`; KEEP the `<select>`, its `aria-label="provider"`, `value`/`onChange`→`setProvider`, the disabled-when-no-providers state, and `canSend`/`validateSend` (L492/L602) intact. Keep the `schema-only` pill text (L627-629). Add the privacy chip "Provider sees schema only — no rows leave the Core" (restrained `--ok` green, `<b>` on "schema only").
  - Empty state (~L648-654): keep the exact copy `ask a question about your schema` (L653); restyle centered/muted.
  - User bubble (~L673-683): right-aligned, `bg-[var(--user-bubble)]`, ~75% max-width, rounded; replace the `--coral-line`/`--coral-soft` at L677.
  - `ReasoningBlock` (L393-407): render `<details className="reasoning" open={live}>`; summary label live→`Thinking…`, done→`Thought`; muted left-ruled steps. KEEP the literal token `reasoning` present ONLY inside this block (now via the `className`), rendered ONLY when reasoning is present (callers at L670 / L731 unchanged) — so a no-reasoning answer's HTML still contains no `reasoning`.
  - `ChatQueryRun` (L317-384): wrap the SQL in the prototype's neutral `.gen-sql` chrome — a toolbar with a `sql · generated` tag + `Copy` + `Open in editor` mini buttons AND the preserved `run` button whose label renders exactly `run` (L345, replace the `--coral*` at L343 with neutral ink). Render the SQL as a SINGLE verbatim mono text node — NO per-token color spans (Design Notes). Keep the `ConfirmRun` (L349-351), `error` `role="alert"` (L353-357), `ok` "N rows affected" (L359-363), and `rows` (L365-381) branches.
  - KPI strip + mini table (rows outcome, ~L365-381): above the DataGrid, render a neutral KPI strip (tabular-nums; `--count`/`--money` functional colors) built from the new `deriveResultKpis` selector; keep the `truncated` banner (L367-371) and the existing `DataGrid` (L372-379) as the mini result table.
  - Assistant action row (new, after the answer body ~L684-722): a `[role="toolbar"]` of icon buttons — copy / thumbs-up / thumbs-down / share / regenerate / more — with `aria-label`s and a monochrome `:focus-visible` ring. Only `copy` is functional this story (copies the raw answer text — a benign client action, no state/RPC change); the rest are visual affordances (Design Notes). Add NO new RPC or reducers.
  - Composer (~L754-783): ink pill `bg-[var(--composer-bg)]`; KEEP the `<textarea aria-label="chat message">` (L758) and Ctrl/Cmd+Enter handler (L758-763) and the send button; add the schema-only note with an `--ok` green dot. Replace the `--coral*` at L769 and L777.
  - Streaming caret (~L729-740): replace the `"…"` placeholder (L736) with a blinking `<span className="caret" aria-hidden="true">` on the live partial bubble; honor `prefers-reduced-motion` (force caret opacity 1). Preserve the `partial`/`partialRef`/`schedulePartial` rAF coalescing and abort-on-unmount (L430-467).
- `src/ui/workspace/chat-model.ts` (130 lines) — ADD ONE pure, DOM-free, exported selector `deriveResultKpis(data: FrozenData): ReadonlyArray<{ label: string; value: string; kind: "money" | "count" }>` for the KPI strip (see Design Notes for the derivation rule). Do NOT touch `ChatMessage`/`ChatState` (L27-42), the reducers (`appendUserMessage`/`appendAnswer`/`setProvider`/`validateSend`), or `accumulateStream` (L120).
- `src/ui/sandbox/SandboxFrame.tsx` (246 lines) — NO CHANGE. The security seam is self-contained (`allow-scripts` only, injected origin, `rebindHost`, height coalescing, single `message` listener, max-height clamp, `datum-clicked`/`error` forwarding) and the component returns the bare `<iframe>` with no outer wrapper of its own — the container styling lives in `ChatTabView` (L704-715). Leave this file untouched; adapt only that ChatTabView container div.
- `src/ui/data/DataGrid.tsx` (secondary/optional) — the in-chat result grid (used at `ChatTabView.tsx:373` with `primaryKeys={[]}`, read-only). Already token-driven; its `--coral*` selection/hover styling ALREADY aliases to ink (no coral renders). Restyle to the mini-table look ONLY if the in-chat result visually needs it; NO logic change and NO change to the mutation-path styling (not exercised in the read-only chat path).
- `src/ui/workspace/ChatTabView.test.tsx` (520 lines) — MUST stay green UNCHANGED. Do not edit it to pass; the redesign preserves every load-bearing string and export it asserts (L447-519).
- `src/ui/workspace/chat-model.test.ts` — ADD unit tests for `deriveResultKpis` (row-count KPI, single 1×1 numeric scalar as money vs count, multi-column degrade). Additive only; leave existing reducer tests intact.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/styles/globals.css` — add `--money`/`--count`/`--user-bubble`/`--composer-bg` to dark `:root` AND `:root[data-theme="light"]`, and expose the `--color-*` aliases in `@theme inline` — functional-color + surface foundation for the port; reuse `--ok`/`--ok-soft`; add no `--sql-*` palette; introduce no coral.
- [x] `src/ui/workspace/chat-model.ts` — add the pure exported `deriveResultKpis(data)` selector (row-count always; single 1×1 numeric scalar as `money`/`count`; otherwise just the row count) — DOM-free, no wire/reducer change. (Money/count split keys on integer-vs-fractional value, the finest real signal in `FrozenData`'s single numeric type.)
- [x] `src/ui/workspace/chat-model.test.ts` — add `deriveResultKpis` unit tests (families + multi-column degrade) — additive (6 tests).
- [x] `src/ui/workspace/ChatTabView.tsx` — port the header (model button + privacy chip), user bubble, reasoning channel (`<details className="reasoning">`), generated-SQL chrome (tag + copy + open-in-editor + the preserved verbatim `run`), KPI strip + mini table, assistant action row, ink composer pill + schema-only note, and the blinking streaming caret to the prototype look — presentation-only; every exported function and test-visible string preserved; only the `SandboxFrame` container div (not the component) adapts.
- [x] `src/ui/data/DataGrid.tsx` — no change needed: the in-chat read-only mini table already renders neutral/token-driven and its `--coral*` selection/hover aliases to ink; left untouched.

**Acceptance Criteria:**
- Given the chat tab, when it renders, then it matches `design-artifacts/ai-chat-chatgpt.html`: near-black neutral canvas, ink accents, right-aligned grey user bubble, header model button + "Provider sees schema only — no rows leave the Core" privacy chip, collapsible "Thought…" reasoning channel, generated-SQL block with copy / open-in-editor + the `run` action, inline KPIs + mini result table, assistant action row, ink composer pill, and a streaming caret — with NO coral anywhere and color only where functional (KPI money/count, privacy green, error red).
- Given the redesign, when `bun test` runs, then `ChatTabView.test.tsx` passes UNEDITED — the load-bearing strings (`schema-only`, `schema-only · 3 tables`, `ask a question about your schema`, `>run<`, the `reasoning` token gated on reasoning presence, the verbatim SQL text, no `<iframe>` for a plain answer) are all still present/absent as asserted.
- Given the schema-only path, when a message is sent, then Ring 2 still holds no key and makes no outbound provider call — it drives `streamChat` and the Core makes the only outbound call; the privacy chip/composer note only visualize this.
- Given a chart-bearing answer, when it renders, then `SandboxFrame` still mounts a cross-origin `allow-scripts` (never `allow-same-origin`) iframe against the injected origin, and the streaming / run / confirm behavior is unchanged.
- Given light and dark themes, when toggled, then the chat renders neutral in both with no coral, and the KPI/privacy/error functional colors stay legible.
- Given `bunx tsc --noEmit`, when it runs, then there are no type errors (presentation-only + one additive pure selector).

## Spec Change Log

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` KPI scalar value rendered raw via `String(cell.value)` → float artifacts (`0.30000000000000004`) and exponential (`1e+21`) surfaced in a 22px KPI card → added a `formatKpiValue` helper (`Intl.NumberFormat`, grouping, ≤2 fraction digits, never scientific) (`chat-model.ts`).
  - `[medium]` `[patch]` Reasoning disclosure caret was bound to `live` (`{live ? "▾" : "▸"}`), so manually expanding a finished "Thought" block left the caret pointing collapsed → replaced with one chevron rotated from the ACTUAL `[open]` state via `group-open:rotate-90` (+ `motion-reduce`) (`ChatTabView.tsx`).
  - `[low]` `[patch]` A single 1×1 non-finite scalar (`NaN`/`±Infinity` from float columns) would render literally in a money-colored card → added a `Number.isFinite` guard so it degrades to just the row-count KPI (`chat-model.ts`), with unit tests.
  - `[low]` `[patch]` Header showed the schema-only signal THREE times (model-button `· schema-only`, privacy chip, AND a stale pre-existing `ml-auto` pill) → removed the redundant standalone pill; `schema-only` (hyphen) stays present via the model button so the load-bearing empty-state test remains green (`ChatTabView.tsx`).
  - `[low]` `[patch]` Action row used `role="toolbar"` (which advertises roving-tabindex / arrow-key nav that is not implemented) → changed to `role="group"` so the ARIA contract is honest (`ChatTabView.tsx`).

## Design Notes

**SQL is NOT tokenized — the verbatim-string test wins over per-token highlighting.** `ChatTabView.test.tsx:516` asserts `html.toContain("SELECT count(*) FROM customers;")` — a contiguous substring of the serialized markup. Splitting the SQL into `.kw`/`.fn`/`.str`/… spans (the prototype's approach) would interleave tags and break that contiguous string → a load-bearing-test violation (contract **Never** / **Block If (c)**). The neutral look is fully reachable WITHOUT per-token color, so this is NOT a HALT: render the generated SQL as a single verbatim, read-only mono text node inside the prototype's neutral `.gen-sql` chrome (surface, `sql · generated` tag, copy + open-in-editor, preserved `run`). The functional-color budget for the chat is therefore spent on KPI money/count, the privacy green, and error red — not SQL tokens. This is why globals.css gets NO `--sql-*` palette.

**`reasoning` token gate.** Keep the literal token `reasoning` emitted ONLY inside the conditionally-rendered `ReasoningBlock` (now the prototype's `<details className="reasoning">`). Do not add the substring `reasoning` to any always-present element (class, aria-label, or copy) or the no-reasoning test (L472) breaks. The summary text becomes "Thinking…"/"Thought" (no fabricated duration — we have no timing datum).

**KPI derivation is real-data-only, never fabricated.** `deriveResultKpis(data)` derives KPIs from the ACTUAL `FrozenData`: always a row-count KPI (`{label:"rows", value:<n>, kind:"count"}`); and when the result is exactly one row × one **finite** numeric column (the common `SELECT count(*)` / `SELECT sum(...)` chat shape), surface that scalar as a KPI. `FrozenData` exposes only a single `number` type (no money/decimal granularity), so the money-vs-count *color* keys on the finest real signal available — a fractional value → `kind:"money"`, a whole value → `kind:"count"`; the column NAME is not used. This is a cosmetic accent only (the shown value is always correct) and is acknowledged as imperfect (a fractional `avg(rating)` reads money-green) — see Residual risks. Non-finite scalars (`NaN`/`±Infinity`) are not surfaced. Values are human-formatted (grouping, ≤2 fraction digits, never scientific). Multi-column / multi-row results degrade to just the row-count KPI + the mini table. No invented business metrics (the prototype's "$128,540 · 1,284 orders" are mock).

**Assistant action row is presentational except `copy`.** The prototype's copy/thumbs/share/regenerate/more row renders as icon buttons for visual fidelity, but only `copy` (copies the raw answer text — a pure client action) is wired this story; thumbs/share/regenerate would require new behavior/RPC, which is out of scope (contract **Never**: no logic/RPC change). Give them `aria-label`s + `:focus-visible`; this is an intentional scoping decision, not a defect.

**SandboxFrame stays byte-for-byte.** Its security seam is self-contained and it has no outer wrapper element — the only adaptable presentation is the container `<div>` around `<SandboxFrame>` in `ChatTabView` (L704-715). Do not touch `SandboxFrame.tsx`.

**Tokens: alias/reuse, don't invent hues** (cf. Story 7.4). `--ok`/`--ok-soft` already match the prototype's privacy green — reuse them. Only the four genuinely-missing tokens (`--money`, `--count`, `--user-bubble`, `--composer-bg`) are added, with both dark and light values, since globals.css's `[data-theme="light"]` block is real and opt-in.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors across `ChatTabView.tsx`, `chat-model.ts`, and the touched test.
- `bun test` — expected: all suites pass, with `ChatTabView.test.tsx` UNEDITED (static-structure + `streamSend` + run/confirm/cancel + chart-doc) and the new additive `deriveResultKpis` tests in `chat-model.test.ts`.
- `rg 'coral.*#|#f[0-9a-fA-F]{2}[0-9a-fA-F]{3}|bg-\[#|text-red-[0-9]|amber-[0-9]' src/ui/workspace/ChatTabView.tsx src/ui/workspace/chat-model.ts` — expected: no coral / hardcoded-palette hits introduced (functional red/amber stay on tokens where already present).

**Manual checks (if no CLI):**
- Launch the app, open the chat tab, and compare against `design-artifacts/ai-chat-chatgpt.html`: header model button + privacy chip, grey right-aligned user bubble, collapsible "Thought…" reasoning, generated-SQL block with copy / open-in-editor + `run`, inline KPIs + mini table, assistant action row, ink composer pill + schema-only note, and the blinking streaming caret — all neutral, no coral. Toggle the theme and confirm both light and dark stay neutral and legible.

## Auto Run Result

Status: done

### Summary
Presentation-only neutral (ChatGPT-style) port of the AI chat tab onto `design-artifacts/ai-chat-chatgpt.html`. `ChatTabView` gained the prototype anatomy — a header "model button" (the preserved provider `<select>` restyled ink, `· schema-only` mode) + an `--ok`-green privacy chip; a right-aligned grey `--user-bubble`; a `<details class="reasoning">` channel ("Thinking…"/"Thought") with the caret driven from the real `[open]` state; a neutral `.gen-sql` block (tag + copy + open-in-editor + the preserved verbatim `run`, SQL as a single un-tokenized mono node); an inline KPI strip (from a new pure `deriveResultKpis` selector) above the restyled mini `DataGrid`; an assistant action `role="group"` row (`copy` wired, the rest presentational); an ink `--composer-bg` pill + schema-only note; and a blinking streaming caret. Four functional/surface tokens (`--money`/`--count`/`--user-bubble`/`--composer-bg`) were added to globals.css for dark AND light with `@theme inline` aliases; `--ok`/`--ok-soft` were reused for the privacy green. NO per-token SQL syntax coloring (it would split the verbatim-SQL test string). Every exported function, the `streamChat`/`runRawQuery`/`ConfirmRun` seams, and the `SandboxFrame` security seam are byte-for-byte unchanged; no coral renders in either theme.

### Files changed
- `src/ui/styles/globals.css` — added `--money`/`--count`/`--user-bubble`/`--composer-bg` to dark `:root` and `:root[data-theme="light"]`, plus `--color-*` aliases in `@theme inline`. Reused `--ok`/`--ok-soft`; no `--sql-*` palette; no coral.
- `src/ui/workspace/chat-model.ts` — added the pure exported `deriveResultKpis(data)` selector + `ResultKpi` type and a `formatKpiValue` helper (finite-guarded, human-formatted). `ChatMessage`/`ChatState`/reducers/`accumulateStream` untouched.
- `src/ui/workspace/chat-model.test.ts` — additive `deriveResultKpis` unit tests (row-count, integer/decimal/negative, float-artifact formatting, non-finite guard, non-numeric + multi-row degrade, zero-row).
- `src/ui/workspace/ChatTabView.tsx` — the full presentation port (header, user bubble, reasoning channel, gen-sql chrome, KPI strip + mini table, action row, composer pill, streaming caret); only the `SandboxFrame` container div adapted. All test-visible strings preserved.
- `src/ui/sandbox/SandboxFrame.tsx`, `src/ui/data/DataGrid.tsx` — not changed (security seam / already-neutral grid).

### Review findings breakdown
- **Patches applied (5):** KPI value human-formatting (was raw `String()` → float artifacts / exponential); reasoning caret desync fixed via `group-open:rotate-90` (was bound to `live`); non-finite KPI scalar guard; removed the stale triple `schema-only` header pill; `role="toolbar"`→`role="group"` (no roving-tabindex implemented). Two medium, three low; all presentation + one pure-selector tweak.
- **Deferred (1):** the assistant action row ships open-in-editor / thumbs / share / regenerate / more as focusable buttons with action `aria-label`s but no behavior — an epic-wide a11y/UX decision (wire later or mark disabled), logged to `deferred-work.md`.
- **Rejected (10):** "coral reintroduced" (the `--coral*` tokens alias to ink — no coral renders, sanctioned reuse); money-vs-count classification imperfect (inherent to `FrozenData`'s single numeric type + contract-mandated color, cosmetic); always-on ROWS KPI "redundant"/dead guard (specced defensive code); possible `noUncheckedIndexedAccess` type error (tsc is clean); streaming placeholder→thin-caret (the live reasoning block + blinking caret ARE the affordance); user-bubble `showBubble` invariant (guaranteed by `decideMessageView`); `overflow-hidden` clip (DataGrid scrolls internally via `overflow-auto`); `color-mix` fallback (modern Chromium target); pre-existing `<label>`+`aria-label` redundancy; empty-string reasoning (streamSend normalizes `""`→`null`, unreachable).

### Verification
- `bunx tsc --noEmit` → clean (exit 0), after patches.
- `bun test` → 1065 pass, 0 fail (2621 expect calls, 68 files). Chat-specific: `ChatTabView.test.tsx` (unedited) + `chat-model.test.ts` = 57 pass. The `relation "secret" does not exist` line is a deliberate error-path fixture log, not a failure.
- `rg 'coral.*#|bg-\[#|text-red-[0-9]|amber-[0-9]'` over `ChatTabView.tsx` + `chat-model.ts` → CLEAN (no coral / hardcoded palette). `SandboxFrame.tsx` and `ChatTabView.test.tsx` unmodified in the diff.

### Follow-up review recommendation
`false` — the final pass applied five localized, low-consequence fixes (two medium: KPI number-formatting and a CSS-only caret-state correction; three low: a finiteness guard, a redundant-pill removal, and an ARIA role rename) plus additive tests. No behavior, API, RPC, security, persistence, or data-flow change; the streaming/run/confirm/sandbox seams and every exported function are untouched. Not significant enough to warrant an independent follow-up review.

### Residual risks
- **Visual fidelity is Tailwind-approximated**, not a pixel clone of the prototype's bespoke CSS; a manual light/dark pass in the running app is the only check a CLI can't perform.
- **KPI money-vs-count color is a heuristic** (fractional→money, whole→count) because `FrozenData` carries no money/decimal type — a fractional `avg(...)` reads money-green and an integer `sum(price)` reads count-blue. Cosmetic only (the value shown is always correct); revisit if a richer column-type signal becomes available.
- **Light theme is opt-in** and, as across Epic 7, less battle-tested than dark; the new tokens carry the epic-wide small-text contrast risk (cf. DW-58/67).
- **The action row's non-functional affordances** are the deferred item above — visually present but inert until a later behavioral story.
