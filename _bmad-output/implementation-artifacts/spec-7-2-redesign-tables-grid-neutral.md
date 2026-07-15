---
title: 'Redesign the Tables data grid to neutral — port the ChatGPT-style prototype look onto the browse grid'
type: 'refactor'
created: '2026-07-13'
status: 'in-progress'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '977a350de685efe02506d1171549b18ba379ed80'
context:
  - '{project-root}/design-artifacts/workspace.html'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The Tables data grid — `DataGrid`, `IndexList`, the result-bar/pager in `TabContent`, and the `CreateTablePanel` form — still wears the old spartan spine and does not yet MATCH the ChatGPT-style prototype `design-artifacts/workspace.html`, which is the visual source of truth and SUPERSEDES the coral rules still written in DESIGN.md / EXPERIENCE.md. The neutral pivot already repointed the tokens (`--coral*` now render ink `#ececec`/`#0d0d0d`, `--t-*` data-type colors and `--ok`/`--ok-soft` are in place), but the grid lacks the prototype's two-line type-tagged headers, humane cell formatting, state pills, faint-italic NULL, the `"rows … · <ms> ms"` result-bar readout, a live client-side row filter, and Export/Add-Row ghost affordances.

**Approach:** A presentation-only port. Re-skin the browse grid to the prototype: two-line stacked headers (ink column name + PK `⚿` key-icon in `--t-key`, over an uppercase type tag colored by `--t-*`), right-aligned `tabular-nums` numeric cells rendered as-is (the prototype does NOT add thousands separators), dimmed date cells, booleans as `--ok`/muted state pills, `null` as faint-italic, a faint hover wash and single-select in ink (`--coral-soft` fill + inset 2px `--coral` marker), a `rowRangeSummary` + `· <ms> ms` result-bar readout, a live client-side row filter, Export (client-side CSV of loaded rows) + Add-Row ghost buttons, and the retained Prev/Next pager and `rows | indexes` toggle. Every color is drawn from `globals.css` tokens. NO change to any data path: the `table.rows` read, the guarded `execute` mutation path, the pure `DataGridState` model and its helpers, the remount-per-table keying, the double-submit refs, and the `reloadNonce` retry all stay exactly as-is, and every existing test stays green.

## Boundaries & Constraints

**Always:**
- Match `design-artifacts/workspace.html` as the visual source of truth. Where it conflicts with the coral language in DESIGN.md / EXPERIENCE.md, the prototype wins. Concretely, the prototype supersedes three points the older coral framing implied: (a) NO zebra striping — rows are plain with a faint hover wash only; (b) numeric cells are NOT thousands-grouped — the value is rendered as received, only right-aligned `tabular-nums` ink; (c) headers are two-line stacked (ink name + uppercase colored type tag), not a single uppercase mono label.
- Presentation-only. Preserve every `table.rows` read call, every `execute` mutation RPC (structured `update`/`delete`/`insert`/`createTable`), the `DataGridState` model and its pure helpers (`applyPage`/`canPrev`/`canNext`/`prevPage`/`nextPage`/`rowRangeSummary`/`selectRow`) byte-for-byte, the remount-per-bound-table `key`, the `inFlight`/`firing` double-submit refs, and the `reloadNonce` retry / disabled-pager-on-error semantics.
- Draw all color from `globals.css` tokens: ink accent from `--coral`/`--coral-soft`/`--coral-line` (and the `text-coral`/`bg-coral-soft` utilities), data-type columns from `--t-int/-time/-bool/-json/-text`, PK from `--t-key`, boolean-true state from `--ok`/`--ok-soft`; destructive delete stays red.
- Keep the neutral discipline: color survives ONLY where functional (data-type header tags, ok state pill, red on destructive). Everything structural/decorative is ink or grayscale.
- The row filter and Export are pure presentation over already-loaded `data.rows` — never a `table.rows` refetch, never an RPC. Add-Row reuses the existing in-grid insert-draft flow (`onInsertRow`/`buildInsertOp`); it introduces no new mutation path.
- Keep all existing passing tests green (`data-grid-state`, `workspace-state`, `create-table`, `row-mutations`, `IndexList`). No assertion churn beyond what a class/markup reskin unavoidably forces, and no logic edited inside the pure/tested modules. `rowRangeSummary`'s exact output strings and IndexList's `⚿` / `"unique index"` / `"0 indexes"` text are load-bearing for tests — do not change them.

**Block If:**
- Matching the prototype grid would require a data-model or RPC change — e.g. the Core must return SQL-native column types, money semantics, or enum labels that the neutral `FrozenData` contract does not carry — HALT `blocked`, condition `prototype fidelity needs a contract change`. This story is presentation-only and the Story 3.2 read contract (`FrozenData`/`TableRowsResult`) is frozen.

**Never:**
- Never change data flow or RPC: no edits to `table.rows` params/handling, the `execute` path, `buildUpdateOp`/`buildDeleteOp`/`buildInsertOp`/`buildCreateTableOp`, `row-mutations.ts`, `create-table.ts`, `contract.ts`, or ANY `src/core/**` file.
- Never add coral or any decorative/hardcoded accent color (`#ff…`, `coral`, inline hex accents); never reintroduce coral rules from DESIGN.md / EXPERIENCE.md that the prototype supersedes.
- Never break, rewrite, or weaken existing tests; never move presentation logic into the pure state modules (or pull pure logic into the components).
- Never invent domain-specific coloring the generic `FrozenData` grid cannot infer. The prototype's `paid`/`pending`/`refunded` enum pills, the teal `type-num` header, and money-green are SAMPLE-SCHEMA fidelity; the generic grid maps only the neutral cell kinds (`number`/`date`/`boolean`/`string`/`null`) and a single numeric type-color (`--t-int`). Do NOT add `--warn`/`--err`/`--money`/`--count` tokens for the generic grid.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Populated page | `FrozenData` with number/date/boolean/string/null cells | mono grid per prototype: sticky two-line headers (ink name + PK `⚿` in `--t-key`, uppercase `--t-*` type tag), plain rows with faint hover wash, single-select `--coral-soft` fill + inset 2px `--coral` marker | n/a |
| Numeric column | `column.type === "number"` | header type tag colored `--t-int`; cells right-aligned `tabular-nums` in ink, value rendered as-is (NO thousands grouping) | n/a |
| Primary-key column | column in `primaryKeys` | header shows `⚿` in `--t-key`; PK data cells rendered in ink `--coral` | n/a |
| NULL cell | `cell.kind === "null"` | faint italic `null` (`--t-text`, reduced opacity) — never colored as data | n/a |
| Boolean cell | `cell.kind === "boolean"` | rendered as a state pill: true → `--ok`/`--ok-soft` tint, false → muted/neutral; not raw colored text | n/a |
| Date cell | `cell.kind === "date"` | dimmed (`--muted-foreground`/`--t-text`) `cell.iso`, per prototype `time-cell` | n/a |
| Empty / past-end page | `data.rows.length === 0` | headers still render; mono `"0 rows"` empty state (copy unchanged) | n/a |
| Live row filter | user types in the result-bar filter input | client-side, presentation-only show/hide of already-loaded rows via a pure `filterRows` helper; NO `table.rows` RPC, no refetch; empty query shows all | n/a |
| Export button | user clicks Export | client-side CSV download of the currently-loaded page rows via a pure serializer; NO RPC, no contract change | n/a |
| Add-Row button | mutable grid, user clicks Add-Row | opens/reuses the existing in-grid insert-draft flow (`onInsertRow`); shown only when `canMutate` | n/a |
| Result-bar readout | grid state + last fetch latency | ink `rowRangeSummary(grid)` text plus a `· <ms> ms` latency suffix in `--coral`; Export + Add-Row ghost buttons; Prev/Next; `rows | indexes` toggle | pager disabled states (page 1 / last page / loading / error) preserved exactly |
| Row selection | `onSelectRow(index)` | single-select row gets `--coral-soft` bg + inset 2px `--coral` marker | out-of-range clears selection (state unchanged) |
| Index sub-view | `view === "indexes"` | `IndexList` reskinned to match: mono, sticky header, `⚿`/`--t-key` unique marker (keep `title="unique index"`), ink hover, `"0 indexes"` empty state | n/a |
| Mutation banners | `error` / `mutationError` set | reskinned inline banners; retry/dismiss affordances and the disabled-pager-while-error behavior unchanged; envelope text still shown in-panel | envelope text preserved, never console-only |
| Create-table form | rail-toggled `CreateTablePanel` | reskinned to neutral (ink submit/checkbox accents via `--coral`, mono fields, neutral borders) | same validation + inline error banner + `inFlight` double-submit guard preserved |

</intent-contract>

## Code Map

- `src/ui/data/DataGrid.tsx` (~493 lines) -- reskin the browse grid to `workspace.html`. Header `<th>`: sticky, two-line stacked `.th-inner` (ink column name row with the PK `⚿` glyph in `--t-key` when the column is a primary key, over an uppercase 9px type tag colored by the existing `typeMeta` mapping → `--t-int`/`--t-time`/`--t-bool`/`--t-text`). `Cell`: numeric → right-aligned `tabular-nums` ink (value as-is, no grouping); date → dimmed `cell.iso`; boolean → `--ok`/`--ok-soft` pill (true) or muted pill (false); null → faint-italic; string → base ink; PK column cells in ink `--coral`. Rows: drop any zebra idea — plain rows, faint hover wash, single-select `--coral-soft` fill + inset 2px `--coral` marker. Swap the remaining coral-idiom classes to `globals.css` tokens. Keep `CellEditor`, `InsertDraftRow`, the inline delete-confirm (delete `yes` stays red), and ALL mutation callbacks (`onCommitEdit`/`onDeleteRow`/`onInsertRow`) and the `firing`/edit-reset effects unchanged in logic. Add an optional `onRequestInsert?`/exposed open affordance ONLY if needed to let the result-bar Add-Row open the existing insert draft — reusing the same `onInsertRow` path, no new op.
- `src/ui/data/IndexList.tsx` (83 lines) -- match `DataGrid`'s reskinned idioms (mono, sticky header, `⚿` in `--t-key` on unique indexes, ink hover, `"0 indexes"` empty state). Preserve `title="unique index"`, the `⚿` glyph, and the `index | columns | unique` column order/text — they are asserted by `IndexList.test.tsx`. No prop or behavior change; still read-only, issues no RPC.
- `src/ui/data/grid-view.ts` (NEW, pure) -- small presentation helpers with no React/RPC: `filterRows(rows, query)` (case-insensitive substring over each row's display cell text; empty/whitespace query returns all rows) and `rowsToCsv(columns, rows)` (RFC-4180-ish CSV of the loaded page; quotes fields containing `,`/`"`/newline; `null` → empty field). Keep pure and deterministic so it is unit-testable and never touches `DataGridState`.
- `src/ui/workspace/TabContent.tsx` (473 lines) -- reskin the result-bar + pager to the prototype: readout = `rowRangeSummary(grid)` text + `· <ms> ms` latency suffix in `--coral`; a live client-side row-filter input (view-local state over `data.rows`, wired through `filterRows`); Export ghost button (calls `rowsToCsv` + triggers a client-side download); Add-Row ghost button (mutable only, opens the in-grid insert draft); the retained Prev/Next pager and `rows | indexes` toggle, all via `globals.css` tokens / prototype `.ghost` idiom. Measure latency by capturing `performance.now()` around the existing `table.rows` `rpc` call in the fetch effect and storing the elapsed ms in view-local state — do NOT change the effect's deps, params, alive-guard, `applyPage` fold, the remount `key`, the `reloadNonce` retry, the disabled-on-error/loading pager states, or the `execute` mutation wiring. The filter/latency/Export are presentation state only; never a refetch.
- `src/ui/schema/CreateTablePanel.tsx` (305 lines) -- reskin the create-table form to neutral (ink accents on the submit button + `pk`/`not null` checkboxes via `--coral`, mono fields, neutral borders consistent with the grid). Preserve the fields, `validateCreateTableDraft`, the `inFlight` double-submit ref, the structured `execute {op:{kind:"createTable"}}` call (no `confirmed`), and the optimistic `synthesizeSchemaTable` append + `onClose`.
- `src/ui/data/data-grid-state.ts` -- VERIFY-ONLY: no change expected. The pure pager/selection helpers stay as-is; `rowRangeSummary` continues to feed the result-bar readout and its exact output strings must not change (asserted by `data-grid-state.test.ts`).
- `src/ui/styles/globals.css` -- VERIFY-ONLY: the tokens the generic grid needs already exist (`--coral`/`--coral-soft`/`--coral-line` = ink, `--t-int/-time/-bool/-json/-text`, `--t-key`, `--ok`/`--ok-soft`, plus the `@theme inline` `--color-*` aliases so `text-coral`/`bg-coral-soft`/`text-t-int`/`text-ok`/`bg-ok-soft` resolve). Add nothing — `--warn`/`--err`/`--money`/`--count` are sample-schema/chat-only and out of scope. Only touch this file if a concrete generic-grid element references an absent token (it should not).

## Tasks & Acceptance

**Execution:**
- [ ] `src/ui/styles/globals.css` -- verify the grid's tokens are present (`--coral*` ink, `--t-*`, `--t-key`, `--ok`/`--ok-soft` + `@theme` aliases); add nothing unless a rendered element needs an absent token.
- [ ] `src/ui/data/grid-view.ts` (NEW) -- add pure `filterRows` and `rowsToCsv` presentation helpers.
- [ ] `src/ui/data/grid-view.test.ts` (NEW) -- unit-test the I/O matrix edges for `filterRows` (match/no-match/empty query/whitespace) and `rowsToCsv` (comma/quote/newline escaping, null → empty).
- [ ] `src/ui/data/DataGrid.tsx` -- port the grid look (two-line type-tagged headers + PK `⚿`, tabular-nums right-aligned raw numerics, dimmed dates, boolean/state pills, faint-italic NULL, ink PK cells, faint hover, ink single-select — no zebra), swapping every coral idiom to a `globals.css` token; mutation/edit/insert/delete logic byte-for-byte unchanged.
- [ ] `src/ui/data/IndexList.tsx` -- align to the reskinned grid idioms (mono, sticky header, `⚿`/`--t-key`, ink hover, `"0 indexes"`); preserve `title="unique index"` and column text; read-only, no behavior change.
- [ ] `src/ui/workspace/TabContent.tsx` -- port the result-bar (`rowRangeSummary` + `· <ms> ms` readout, live row filter via `filterRows`, Export via `rowsToCsv`, Add-Row ghost) + retained Prev/Next + `rows|indexes` toggle; capture latency around the existing `table.rows` rpc; fetch/pagination/retry/mutation wiring untouched.
- [ ] `src/ui/schema/CreateTablePanel.tsx` -- reskin to neutral; fields/validation/double-submit/structured-op/optimistic-append preserved.
- [ ] `src/ui/data/data-grid-state.ts` -- verify no change needed; if a copy string must change, keep it pure and update `data-grid-state.test.ts` in lockstep (not expected).

**Acceptance Criteria:**
- Given a browsed table, when its page renders, then the data grid matches `design-artifacts/workspace.html`: two-line type-tagged headers with a PK `⚿` in `--t-key`, tabular-nums right-aligned numeric cells, dimmed date cells, boolean/state pills, faint-italic `NULL`, a faint hover wash, and ink single-select — with no coral and no zebra anywhere.
- Given the result bar, when a page is loaded, then it shows the `rowRangeSummary` text with a `· <ms> ms` latency suffix, a live client-side row filter, Export and Add-Row ghost buttons, a `rows|indexes` toggle, and Prev/Next whose disabled states (page 1 / last page / loading / error) are unchanged.
- Given the filter and Export, when exercised, then filtering only hides/shows already-loaded rows and Export only serializes loaded rows to a client-side CSV — neither issues a `table.rows` refetch or any RPC.
- Given the neutral pivot, when the grid is inspected, then every color comes from a `globals.css` token and color survives only where functional (data-type header tags, ok state pill, red on destructive) — no hardcoded coral or decorative accent.
- Given the port, when `table.rows`, the `execute` mutation path, the `DataGridState` model, and the create-table flow are exercised, then their behavior is identical to before the reskin, and `bunx tsc --noEmit` + `bun test` stay green.

## Design Notes

Prototype ↔ code token mapping (from `design-artifacts/workspace.html`, verified): the prototype's grid block renames the accent to `--accent`/`--accent-soft`/`--accent-line` and neutralizes it to ink — in THIS codebase those are the already-ink `--coral`/`--coral-soft`/`--coral-line`. Use the coral-named tokens; they render identical ink values (`#ececec` dark / `#0d0d0d` light). `--t-key` = ink accent. Prototype key snippets to match:

```css
/* header: two-line stacked, sticky */
.th-inner { padding: 7px 14px 6px; display:flex; flex-direction:column; gap:2px; }
.th-inner .col { color: var(--foreground); font-size: 11.5px; } /* name, NOT uppercase */
.th-inner .col .keyico { width:10px; height:10px; color: var(--t-key); } /* PK ⚿ */
.th-inner .type { font-size:9px; letter-spacing:.06em; text-transform:uppercase; } /* colored by --t-* */
/* cells */
td.num-cell { color: var(--foreground); text-align:right; font-variant-numeric: tabular-nums; } /* value as-is */
td.pk-cell  { color: var(--coral); }
td.time-cell{ color: var(--muted-foreground); }
.null { color: var(--muted-foreground); font-style: italic; opacity:.75; }
/* rows: no zebra; faint hover; ink single-select */
tbody tr:hover td { background: color-mix / rgba faint wash; }
tbody tr.sel td   { background: var(--coral-soft); box-shadow: inset 2px 0 0 var(--coral); }
/* boolean pill (generic grid: true → ok, false → muted) */
.pill { display:inline-flex; align-items:center; gap:5px; font-size:11px; padding:2px 8px 2px 6px; border-radius:20px; }
.pill::before { content:""; width:5px; height:5px; border-radius:50%; background: currentColor; }
```

Why the generic grid diverges from the prototype's richest cells: the prototype colors numeric decimals teal (`type-num` → `--t-json`), shows `paid`/`pending`/`refunded` pills (`--warn`/`--err`), and money-green — all SAMPLE-SCHEMA specifics. `FrozenData` only carries neutral kinds (`number`/`date`/`boolean`/`string`/`null`), so the generic grid uses one numeric color (`--t-int`) and a two-state boolean pill (`--ok` / muted). This is the neutral-discipline rule, not an omission.

Latency readout: `rowRangeSummary(grid)` stays the source of the "rows X–Y of Z" text (its strings are test-locked); the `· <ms> ms` suffix is NEW view-local state measured with `performance.now()` around the existing `table.rows` rpc. The prototype's single-page `142 rows` becomes our paginated `rows X–Y of Z · M ms` because the app has real pagination the static mock lacks. Prev/Next and the `rows|indexes` toggle are retained (real behavior) styled in the prototype's neutral `.ghost` idiom even though the static mock omits them.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors across the reskinned UI files and the new `grid-view.ts`.
- `bun test` -- expected: all suites pass; `data-grid-state`, `workspace-state`, `create-table`, `row-mutations`, and `IndexList` stay green with no assertion churn beyond forced markup/class updates; the new `grid-view.test.ts` passes.

**Manual checks (if a seeded DB + browser is available):**
- Launch the app, open a table, and confirm the grid, result bar (readout + filter + Export + Add-Row + pager), index sub-view, and create-table form visually match `design-artifacts/workspace.html`; toggle light/dark and confirm both themes read correctly with no coral.
- Type in the filter and confirm rows hide/show with no network call; click Export and confirm a CSV of the loaded page downloads with no network call.
