---
title: 'Redesign the AI chat to neutral — port the ChatGPT-style prototype onto the chat surface (presentation-only)'
type: 'refactor'
created: '2026-07-13'
status: 'backlog'
context:
  - '{project-root}/design-artifacts/ai-chat-chatgpt.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
review_loop_iteration: 0
followup_review_recommended: false
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

- `src/ui/styles/globals.css` -- already neutral (the `--coral*` tokens alias to ink). Add the chat-specific FUNCTIONAL tokens the prototype introduces and the current file lacks — SQL-syntax palette (`--sql-kw/fn/str/num/idn/pun`), KPI `--money` / `--count`, privacy/schema-only green (`--ok` / `--ok-soft`), the grey `--user-bubble`, and the composer-pill surface — each defined for dark + light per the prototype. Keep everything neutral; introduce no coral value.
- `src/ui/workspace/ChatTabView.tsx` -- the primary port. Restyle/restructure the JSX to the prototype anatomy: header (model button + privacy chip + share/more), right-aligned grey user bubble, the reasoning channel (`ReasoningBlock` → collapsed `<details class="reasoning">` with "Thought for…"/"Thinking…"), the generated-SQL block in `ChatQueryRun` (syntax highlighting + copy + open-in-editor alongside the existing `run` button), the inline KPI strip + mini result table for a `rows` outcome, the assistant action row, the ink composer pill + schema-only note, and the streaming caret on the live partial bubble. PRESERVE every exported function and all test-visible strings; change markup/classes only, keep all state, effects, guards, and the `runRawQuery`/`ConfirmRun`/`SandboxFrame` wiring intact.
- `src/ui/workspace/chat-model.ts` -- pure view-model; expect NO change (presentation-only leaves the wire shape and reducers untouched). If the KPI / mini-table render needs a derived shape from a `rows` outcome, add a pure, DOM-free, unit-tested selector HERE (not in the component) — but do NOT alter `ChatMessage` / `ChatState` / the reducers / `accumulateStream`.
- `src/ui/sandbox/SandboxFrame.tsx` -- keep the cross-origin sandbox seam EXACTLY (`allow-scripts`, never `allow-same-origin`, injected origin, `rebindHost`, height coalescing, `message` listener, `datum-clicked`/`error` forwarding, max-height clamp). Only the outer wrapper presentation (container spacing/border) may be neutral-ized to fit the redesigned thread; the guest bundle's internal styling (Ring 3) is out of scope for this story.
- `src/ui/data/DataGrid.tsx` -- (secondary/optional) the in-chat result grid consumed by `ChatQueryRun`. Already token-driven and neutral; restyle to the prototype's mini-table look (neutral headers, tabular-nums, functional money/count cells) ONLY if the result surface renders here — no logic change to the grid's pagination/selection model.

## Tasks & Acceptance

**Execution:**
- [ ] `src/ui/styles/globals.css` -- add the neutral chat functional tokens (SQL syntax palette, `--money`/`--count`, privacy green, `--user-bubble`, composer pill) for dark + light -- foundation for the ports below; no coral introduced.
- [ ] `src/ui/workspace/ChatTabView.tsx` -- port the header (model button + privacy chip), user bubble, reasoning channel, generated-SQL block (syntax + copy + open-in-editor), KPI/mini-table result surface, assistant action row, composer pill, and streaming caret to the prototype look -- presentation-only; every exported function and test-visible string preserved.
- [ ] `src/ui/workspace/chat-model.ts` -- add a pure, tested view-selector ONLY if the KPI/mini-table needs a derived shape; otherwise no change -- keep the wire contract and reducers untouched.
- [ ] `src/ui/sandbox/SandboxFrame.tsx` -- neutral-ize only the outer wrapper if needed -- the cross-origin sandbox security seam is untouched.
- [ ] `src/ui/data/DataGrid.tsx` -- (if used for the in-chat result) restyle to the neutral mini-table look -- no logic change.

**Acceptance Criteria:**
- Given the chat tab, when it renders, then it matches `design-artifacts/ai-chat-chatgpt.html`: near-black neutral canvas, ink accents, right-aligned grey user bubble, header model button + "Provider sees schema only — no rows leave the Core" privacy chip, collapsible "Thought for…" reasoning channel, generated-SQL block with copy / open-in-editor, inline KPIs + mini result table, assistant action row, ink composer pill, and a streaming caret — with NO coral anywhere and color only where functional.
- Given the redesign, when `bun test` runs, then the existing suite passes unchanged: the load-bearing strings (`schema-only`, `schema-only · N tables`, `ask a question about your schema`, the `run` button label, the `reasoning` token gated on reasoning presence, no `<iframe>` for a plain answer) are all still present.
- Given the schema-only path, when a message is sent, then Ring 2 still holds no key and makes no outbound provider call — it drives `streamChat` and the Core makes the only outbound call.
- Given a chart-bearing answer, when it renders, then `SandboxFrame` still mounts a cross-origin `allow-scripts` (never `allow-same-origin`) iframe against the injected origin, and the streaming / run / confirm behavior is unchanged.
- Given light and dark themes, when toggled, then the chat renders neutral in both with no coral.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors (presentation-only change).
- `bun test` -- expected: all suites pass unchanged, including `ChatTabView.test.tsx` (static-structure + `streamSend` + run/confirm/cancel + chart-doc) — the redesign preserves every load-bearing DOM string and every exported function.

**Manual checks (if no CLI):**
- Launch the app, open the chat tab, and compare against `design-artifacts/ai-chat-chatgpt.html`: confirm the header model button + privacy chip, grey user bubble, collapsible "Thought for…" reasoning, generated-SQL block with copy / open-in-editor, inline KPIs + mini table, assistant action row, composer pill, and streaming caret — all neutral, no coral. Toggle the theme and confirm both light and dark stay neutral.
