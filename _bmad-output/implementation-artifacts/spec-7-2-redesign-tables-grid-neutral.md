---
title: 'Redesign the Tables data grid to neutral — port the ChatGPT-style prototype look onto the browse grid'
type: 'refactor'
created: '2026-07-13'
status: 'backlog'
context:
  - '{project-root}/design-artifacts/workspace.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
---

<intent-contract>

## Intent

**Problem:** The Tables data grid — `DataGrid`, `IndexList`, the result-bar/pager in `TabContent`, and the `CreateTablePanel` form — still wears the old coral/monospace spine: coral-idiom Tailwind classes, coral selection markers, plain colored-text booleans, and a spartan result bar with no row-count·latency readout, no row filter, and no Export/Add-Row affordances. The neutral pivot has already moved the underlying tokens (`--coral` is now ink `#ececec`, `--t-*` data-type colors kept), but the grid does not yet MATCH the ChatGPT-style prototype `design-artifacts/workspace.html`, which is now the visual source of truth and SUPERSEDES the coral rules still written in DESIGN.md / EXPERIENCE.md.

**Approach:** A presentation-only port. Re-skin the browse grid to the prototype: type-colored uppercase mono header labels with a PK key-icon (`⚿` in `--t-key`), tabular-nums right-aligned numeric cells formatted for humans, dates in `--t-time`, booleans/state rendered as pills, `NULL` as faint-italic, zebra rows, hover and single-select in ink (`--coral-soft` fill + inset `--coral` marker), a `"<n> rows · <ms> ms"` result-bar readout, a live client-side row filter, Export/Add-Row ghost buttons, and Prev/Next. Every color is drawn from `globals.css` tokens (ink accent via `--coral`/`--coral-soft`/`--coral-line`, data-type via `--t-int/-time/-bool/-json/-text`, PK via `--t-key`, functional state via `--ok`/`--warn`/`--err`, red on destructive). NO behavior changes: the `table.rows` read path, the guarded `execute` mutation path (update/delete/insert/createTable), the pure `DataGridState` model and its helpers, the remount-per-table keying, the double-submit refs, and the `reloadNonce` retry all stay exactly as-is, and every existing test stays green.

## Boundaries & Constraints

**Always:**
- Match `design-artifacts/workspace.html` as the visual source of truth. Where it conflicts with the coral language in DESIGN.md / EXPERIENCE.md, the prototype wins (the prototype supersedes the coral rules).
- Presentation-only. Preserve every `table.rows` read call, every `execute` mutation RPC (structured `update`/`delete`/`insert`/`createTable`), the `DataGridState` model and its pure helpers (`applyPage`/`canPrev`/`canNext`/`prevPage`/`nextPage`/`rowRangeSummary`/`selectRow`), the remount-per-bound-table `key`, the `inFlight`/`firing` double-submit refs, and the `reloadNonce` retry/disabled-pager-on-error semantics — byte-for-byte in logic.
- Draw all color from `globals.css` tokens: ink accent from `--coral`/`--coral-soft`/`--coral-line` (and the `text-coral`/`bg-coral-soft` utilities), data-type columns from `--t-int/-time/-bool/-json/-text`, PK from `--t-key`, functional state from `--ok`/`--warn`/`--err`; destructive delete stays red.
- Keep the neutral discipline: color survives ONLY where functional (data-type columns, ok/warn/err state pills, red on destructive). Everything structural/decorative is ink or grayscale.
- Keep all existing passing tests green (`data-grid-state`, `workspace-state`, `create-table`, `row-mutations`, and any snapshot/behavior suites). No assertion churn beyond what a class/markup reskin unavoidably forces, and no logic edited inside the pure/tested modules.

**Block If:**
- Matching the prototype grid would require a data-model or RPC change — e.g. the Core must return SQL-native column types, money semantics, or enum labels that the neutral `FrozenData` contract does not carry — HALT `blocked`, condition `prototype fidelity needs a contract change`, because this story is presentation-only and the Story 3.2 read contract (`FrozenData`/`TableRowsResult`) is frozen.

**Never:**
- Never change data flow or RPC: no edits to `table.rows` params/handling, the `execute` path, `buildUpdateOp`/`buildDeleteOp`/`buildInsertOp`/`buildCreateTableOp`, `row-mutations.ts`, `create-table.ts`, `contract.ts`, or ANY `src/core/**` file.
- Never add coral or any decorative/hardcoded accent color (`#ff…`, `coral`, inline hex accents); never reintroduce coral rules from DESIGN.md / EXPERIENCE.md that the prototype supersedes.
- Never break, rewrite, or weaken existing tests; never move presentation logic into the pure state modules (or pull pure logic into the components).
- Never invent domain-specific coloring the generic `FrozenData` grid cannot infer — the prototype's `paid`/`pending`/`refunded` enum pills and money-green are SAMPLE-SCHEMA fidelity; the generic grid maps only the neutral cell kinds (`number`/`date`/`boolean`/`string`/`null`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Populated page | `FrozenData` with number/date/boolean/string/null cells | mono grid per prototype: sticky type-colored uppercase header labels (`--t-*`), PK header shows `⚿` in `--t-key`, zebra rows, ink hover, single-select `--coral-soft` fill + inset `--coral` marker | n/a |
| Numeric column | `column.type === "number"` | header + cells right-aligned, `tabular-nums`, grouped for human reading (Intl); underlying value unchanged | n/a |
| NULL cell | `cell.kind === "null"` | faint italic `null` (`--t-text`, reduced opacity) — never colored as data | n/a |
| Boolean cell | `cell.kind === "boolean"` | rendered as a state pill (true → `--ok` tint, false → muted/neutral), not raw colored text | n/a |
| Date cell | `cell.kind === "date"` | `--t-time` colored, human-readable per prototype `time-cell` | n/a |
| Empty / past-end page | `data.rows.length === 0` | headers still render; mono `"0 rows"` empty state (copy unchanged) | n/a |
| Live row filter | user types in the result-bar filter input | client-side, presentation-only show/hide of already-loaded rows; NO `table.rows` RPC, no page refetch; clears cleanly | n/a |
| Result-bar readout | grid state page/total + last latency | ink `"<n> rows · <ms> ms"` readout mirroring the prototype `.count`; Export + Add-Row ghost buttons; Prev/Next | pager disabled states (page 1 / last page / loading / error) preserved exactly |
| Row selection | `onSelectRow(index)` | single-select row gets `--coral-soft` bg + inset 2px `--coral` marker (ink, not coral) | out-of-range clears selection (state unchanged) |
| Index sub-view | `view === "indexes"` | `IndexList` reskinned to match: mono, sticky header, `⚿`/`--t-key` unique marker, ink hover, `"0 indexes"` empty state | n/a |
| Mutation banners | `error` / `mutationError` set | reskinned inline banners; retry/dismiss affordances and the disabled-pager-while-error behavior unchanged; envelope text still shown in-panel | envelope text preserved, never console-only |
| Create-table form | rail-toggled `CreateTablePanel` | reskinned to neutral (ink submit/checkbox accents via `--coral`, mono fields, neutral borders) | same validation + inline error banner + `inFlight` double-submit guard preserved |
| No contract change | any | `FrozenData` / `TableRowsResult` / structured-op shapes untouched; only markup/classes/formatting differ | `bunx tsc --noEmit` + `bun test` stay green |

</intent-contract>

## Code Map

- `src/ui/data/DataGrid.tsx` -- reskin the browse grid to `workspace.html`: type-colored uppercase mono header labels (`--t-*`) with the PK `⚿` in `--t-key`, right-aligned `tabular-nums` numeric cells (human-grouped via Intl, value unchanged), `--t-time` dates, boolean/state cells as pills, faint-italic `NULL`, ink hover + inset `--coral` single-select marker, `"0 rows"` state. Swap the remaining coral-idiom classes to `globals.css` tokens (`text-coral`/`bg-coral-soft`/`--coral-line`, `--t-*`). Keep `CellEditor`, `InsertDraftRow`, the inline delete-confirm, and ALL mutation callbacks (`onCommitEdit`/`onDeleteRow`/`onInsertRow`) unchanged in logic.
- `src/ui/data/IndexList.tsx` -- match `DataGrid`'s reskinned idioms (mono, sticky header, `⚿` in `--t-key` on unique indexes, ink hover, `"0 indexes"` empty state); no prop or behavior change — still read-only, issues no RPC, composes no SQL.
- `src/ui/data/data-grid-state.ts` -- presentation-only story: NO logic change expected. The pure pager/selection helpers stay as-is; `rowRangeSummary` continues to feed the result-bar row-count readout. Touch ONLY if the prototype's `"<n> rows"` copy needs a summary-string tweak, and if so keep it pure + update its unit test in lockstep.
- `src/ui/workspace/TabContent.tsx` -- reskin the result-bar + pager to the prototype: ink `"<rows> · <ms> ms"` readout, a live client-side row-filter input, Export + Add-Row ghost buttons, Prev/Next, and the `rows | indexes` toggle — all via `globals.css` tokens. Keep the `table.rows` fetch effect, the remount-per-table `key`, the `reloadNonce` retry, the disabled-on-error/loading pager states, and the `execute` mutation wiring untouched. The filter is view-local presentation state over already-loaded `data.rows` — never a refetch.
- `src/ui/schema/CreateTablePanel.tsx` -- reskin the create-table form to neutral (ink accents on the submit button + `pk`/`not null` checkboxes via `--coral`, mono fields, neutral borders); preserve the fields, `validateCreateTableDraft`, the `inFlight` double-submit ref, the structured `execute {op:{kind:"createTable"}}` call, and the optimistic `synthesizeSchemaTable` append.
- `src/ui/styles/globals.css` -- add ONLY the functional-semantic tokens the prototype's pills/readout need IF absent: `--ok`/`--ok-soft` (and, if used, `--warn`/`--warn-soft`, `--err`/`--err-soft`, `--money`/`--count`) with their light-mode overrides and matching `@theme` `--color-*` aliases, following the existing `--t-*` alias pattern. No coral, no decorative accent, no change to any existing token. (Already present: `--coral` = ink `#ececec`, `--t-int/-time/-bool/-json/-text`, `--t-key`, `--data-cell-size`, `--label-size`, `--font-mono`.)

## Tasks & Acceptance

**Execution:**
- [ ] `src/ui/styles/globals.css` -- add the missing functional state tokens (`--ok`/`--warn`/`--err` + softs, optional `--money`/`--count`) with light-mode overrides and `@theme` aliases -- neutral color foundation for pills.
- [ ] `src/ui/data/DataGrid.tsx` -- port the grid look (type-colored mono headers + PK `⚿`, tabular-nums right-aligned numerics, `--t-time` dates, boolean/state pills, faint-italic NULL, ink hover/selection, `"0 rows"`), swapping every coral idiom to a `globals.css` token; logic byte-for-byte unchanged.
- [ ] `src/ui/data/IndexList.tsx` -- align to the reskinned grid idioms (mono, sticky header, `⚿`/`--t-key`, ink hover, `"0 indexes"`); read-only, no behavior change.
- [ ] `src/ui/workspace/TabContent.tsx` -- port the result-bar (`"<rows> · <ms> ms"` readout, live row filter, Export/Add-Row ghost buttons) + Prev/Next + `rows|indexes` toggle; fetch/pagination/retry/mutation wiring untouched.
- [ ] `src/ui/schema/CreateTablePanel.tsx` -- reskin to neutral; fields/validation/double-submit/structured-op/optimistic-append preserved.
- [ ] `src/ui/data/data-grid-state.ts` -- verify no change needed (pure model already feeds the readout); adjust only a copy string if required, with its test.

**Acceptance Criteria:**
- Given a browsed table, when its page renders, then the data grid matches `design-artifacts/workspace.html`: type-colored uppercase mono headers, a PK `⚿` key-icon in `--t-key`, tabular-nums right-aligned numeric cells, `--t-time` dates, boolean/state pills, faint-italic `NULL`, zebra rows, and ink hover/selection — with no coral anywhere.
- Given the result bar, when a page is loaded, then it shows a `"<n> rows · <ms> ms"` ink readout, a live client-side row filter, Export and Add-Row ghost buttons, and Prev/Next whose disabled states (page 1 / last page / loading / error) are unchanged.
- Given the neutral pivot, when the grid is inspected, then every color comes from a `globals.css` token and color survives only where functional (data-type columns, ok/warn/err state pills, red on destructive) — no hardcoded coral or decorative accent.
- Given the port, when `table.rows`, the `execute` mutation path, the `DataGridState` model, and the create-table flow are exercised, then their behavior is identical to before the reskin.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors across the reskinned UI files.
- `bun test` -- expected: all suites pass with no assertion churn beyond forced markup/class updates; `data-grid-state`, `workspace-state`, and `create-table` behavior tests stay green.

**Manual checks (if a seeded DB + browser is available):**
- Launch the app, open a table, and confirm the grid, result bar, pager, index sub-view, and create-table form visually match `design-artifacts/workspace.html`; toggle light/dark and confirm both themes read correctly with no coral.
