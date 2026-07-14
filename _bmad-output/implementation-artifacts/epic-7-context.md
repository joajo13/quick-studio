# Epic 7 Context: UI Redesign — Neutral (ChatGPT look)

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic pivots the entire UI from the original coral/monospace "TablePlus" visual spine to a neutral, ChatGPT-style language: near-black surfaces, an ink (white/black) accent, and no coral. Color is retained only where it carries meaning — data-type column colors, ok/warn/err state semantics, a blue chart data-series, and red on destructive actions. Every story is presentation-only: it ports an existing HTML prototype's look onto existing React components while preserving all logic, RPC contracts, and passing tests. This matters because the product's aesthetic is part of its identity (a calm, restrained dev tool, not a decorated one), and the coral spine described in the original UX docs is now historical.

## Stories

- Story 7.1: Redesign the workspace shell to neutral — rail, tabs, schema tree, status
- Story 7.2: Redesign the Tables data grid to neutral
- Story 7.3: Redesign the Query editor + destructive confirm to neutral
- Story 7.4: Redesign the ERD to neutral
- Story 7.5: Redesign the AI Chat to neutral
- Story 7.6: Redesign the Report to neutral
- Story 7.7: Redesign Settings/Connections to neutral

## Requirements & Constraints

- The HTML files in `design-artifacts/` are the visual source of truth for every story in this epic and supersede any coral/mono rule still described in the older UX docs (which are being rewritten separately and are explicitly marked superseded).
- Color discipline: outside of the functional exceptions (data-type coding, ok/warn/err semantics, the chart's blue data-series, and red on destructive elements), no coral and no other saturated color should appear — surfaces are neutral/ink.
- Aesthetic target: shadcn/ui-style — clean, modern, restrained; dark-first. Motion exists only to serve feedback (state changes, streaming, the latency-readout pop), never as decoration.
- Streaming UX must keep reasoning visually distinct from the final answer, and streaming/render work must never jank the UI thread.
- Destructive-action UX needs a clear, consistent confirmation surface across the data grid, query editor, and chat — this dialog is UX only; the underlying guarded Core executor remains the actual gate and its behavior must not change.
- Every story must preserve existing behavior exactly: this is a presentation-layer pass, not a functional change. RPC contracts, mutation/guarded-execute paths, layout persistence, schema-only Provider/sandbox behavior, and report export behavior must all remain unchanged after the visual port.

## Technical Decisions

- `src/ui/styles/globals.css` already carries the neutral design tokens needed for this epic — no new token system is required. The variable names still say "coral" (`--coral`, `--coral-ink`, `--coral-soft`, `--coral-line`, `--t-key`, `--focus-ring`) but their values were repointed to ink (`--coral` = `#ececec`) as part of the pivot setup. Stories should reuse these existing CSS variables and their Tailwind utilities (e.g. `text-coral`, `bg-coral-soft`) rather than introducing new names — the token identity is intentionally kept stable even though its meaning changed.
- The semantic state colors (ok/warn/err) are a separate token set from the accent and are untouched by this pivot — they continue to color pills, connection status, and result deltas, distinct from "active/selected."
- Data-type column color coding (the `t-*` type system) is preserved as-is except for the primary-key token, which now reuses the ink accent instead of coral; other type colors (int, timestamptz, numeric, json, etc.) keep their original hues.
- In-app charts (Recharts, Ring 2) switch their data-series color to blue as the one functional chart accent — this is the only place blue is used as a primary visual color.
- Mono typography for tabular/code contexts (headers, schema tree, status bar, SQL editor) is unchanged by this epic — only the color scheme changes, not the type system.
- No component logic, state management, or RPC call sites should change as part of any Epic 7 story; changes are scoped to markup/class/style layers implementing the prototype's look.

## UX & Interaction Patterns

- Each story maps to a specific prototype file as its literal reference: `workspace.html` (shell, tabs, tree, status, data grid, query editor), `confirm-destructive.html` (destructive confirmation dialog), `erd.html` (ERD), `ai-chat-chatgpt.html` (chat), `report.html` (report), `connect.html` (Settings/Connections).
- Shell: a compact vertical icon rail (brand mark + Tables/Query/ERD/Chat/Report plus a pinned Settings, no clipped or wrapped labels); tabs use a Chrome-tab look (active tab fuses into the content panel, close ×, new-tab +).
- Data grid: mono, type-colored headers with a PK key icon; tabular-nums numeric cells right-aligned; status/bool as pills; money/amount columns formatted for humans; NULL rendered faint-italic; zebra rows; hover/selection in ink. Also expected: a live client-side row filter, a row-count·latency readout, Export/Add-Row ghost buttons, and Prev/Next pagination — none of this changes the underlying grid RPC behavior.
- Query editor: neutral type-colored SQL syntax highlighting and an ink-styled Run control (⌘↵), with the guarded-execute behavior unchanged.
- Destructive confirm: no top color line; red isolated to functional bits only (icon, affected-rows badge, statement border, confirm button); neutral modal frame; a concise one-line description; a dependent-FK line; and type-to-confirm.
- ERD: card-style table nodes (table name in mono + row count), PK shown as an ink key icon, FK shown as a blue link icon, type-colored type labels, with pan, zoom-to-cursor, drag-a-table (edges follow), and hover-to-highlight-relations.
- Chat: right-aligned grey user bubble, a collapsible reasoning channel visually distinct from the answer, a generated-SQL block, inline KPIs plus a mini result table, an action row, an ink composer pill, and a visible "schema only — no rows leave the Core" note; streaming caret and reasoning treatment follow the same prototype.
- Report: KPI cards with ok/err deltas, a blue chart data-series, a results table with type-colored headers and status pills, and ink-styled Export-snapshot / Export-live controls.
- Settings/Connections: an engine picker with an ink selected-state, form fields, a Test-connection control with ok/err result, an encrypted credential-store panel, and an ink primary/Connect button with legible text (explicitly no white-on-white).

## Cross-Story Dependencies

All seven stories are independent presentation passes over separate surfaces (shell, grid, query/confirm, ERD, chat, report, settings) and can proceed in any order or in parallel — they share only the token foundation in `globals.css`, which is already in place. None of them depend on each other functionally; each depends only on the corresponding prototype file already existing in `design-artifacts/`.
