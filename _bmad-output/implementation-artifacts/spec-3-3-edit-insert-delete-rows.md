---
title: 'Edit, insert, and delete rows'
type: 'feature'
created: '2026-07-10'
status: 'done'
baseline_revision: '96f9df73f0def585dac25619c1234f13761318ec'
final_revision: 'cf7b5b6c4ec55b8b30fe72135865b835c4d139af'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The data grid (Story 3.2) is read-only — a developer can browse rows but cannot fix a value, add a row, or remove one, which is the daily work that decides whether they adopt the tool (UJ-1).

**Approach:** Add inline cell editing, row insertion, and row deletion to the grid, routing every mutation through the Story 3.1 guarded Core executor as **structured single-row DML** (RPC `execute`, `{shape:"structured", op}`, path (a)) — typed and parameterized by primary key, never raw SQL. Insert and single-cell update auto-commit dialog-free; delete requires explicit confirmation. This is a UI-only story: the executor already composes and guards these ops; nothing in the Core changes.

## Boundaries & Constraints

**Always:**
- Every grid mutation calls RPC `execute` with `{shape:"structured", op}` (path (a)); the UI never composes SQL and never uses the `raw` shape.
- A request carries only table (+ optional schema) + a single-column PK + column/value fields; the Core parameter-binds values and quotes identifiers. Nothing new to guard — `StructuredOp` is structurally incapable of raw/DDL/multi-row/multi-statement.
- Outgoing `value`s are JS-typed to the column's inferred `FrozenCell` kind before sending: `number`→`Number(...)`, `boolean`→`true`/`false`, `date`→`Date`, `string`→string, explicit NULL→`null`. Never send a bare string for a non-string column (postgres.js serializes a JS string as `text`, which Postgres will not assignment-cast to int/bool/timestamp).
- Insert omits columns the user left untouched/empty (so the DB default or NULL applies) — this is how serial PKs and defaulted columns stay insertable without threading full schema metadata.
- Update and delete require exactly one PK column (matching the executor's `resolveSinglePkTable`); when a table lacks exactly one PK column, inline edit and delete are disabled (insert stays available). PK value is read from the row's cell at the PK column index.
- Delete requires explicit user confirmation before executing and only runs with `confirmed:true`; the Core executor stays the real gate (a delete without the flag returns `confirmation_required` and mutates nothing). Esc closes the confirm.
- Insert and single-cell update auto-commit with NO dialog (the fast-path exemption).
- After any successful mutation, refetch the current page (reuse the `reloadNonce` mechanism) so the grid reflects committed state; surface any error envelope inline via `envelopeText`, never crashing the panel.
- Reuse the existing `rpc` client, `FrozenData`, and DESIGN tokens (coral-soft/coral-line for edit affordances, the global focus ring). No new modal framework — mirror the inline-confirm pattern in `SettingsPanel`'s `ConnectionRow`.

**Block If:**
- The Core `execute`/`StructuredOp` contract does not, in fact, expose structured insert/update/delete with `confirmed`-flag delete semantics as specified here → HALT (investigation stale; do NOT modify or work around the Story 3.1 executor/guard).

**Never:**
- Never compose SQL in the UI or use the `raw` execute shape for grid edits.
- Never batch multiple rows/statements into one action (one structured op per edit/insert/delete).
- Never modify the Core executor, its guard, or its adversarial guarantees — Story 3.1 owns them; 3.3 is a consumer.
- Never gate insert or single-cell update behind a dialog.
- Never treat the UI confirmation as the security boundary — the Core is the gate.
- Out of scope (defer): DB-type/nullability-aware editors via `SchemaColumnInfo`, multi-cell/bulk edit, editing composite-PK / no-PK tables, transactional multi-statement edits, rich date/time pickers beyond text input.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Edit a valid cell | Single-PK table; double-click text/number/bool/date cell, new value, Enter | Structured `update` (`pk` + one `set`), value coerced by kind, auto-commits; page refetches; persists on reload | RPC error envelope → inline message, cell reverts |
| Edit number cell with non-numeric text | `"abc"` into a `number` cell | Client-side validation blocks; NO RPC sent; editor stays open | Inline validation message |
| Set a cell to NULL | Editor "set NULL" action | `update` with `value:null` → real NULL persists | If column is NOT NULL, DB error envelope surfaced inline |
| Insert a row, subset of columns filled | Fill some inputs, commit | Structured `insert` with only filled columns (empties omitted → default/NULL); auto-commits; total increments; appears on reload | Error envelope inline; draft preserved |
| Delete a selected row, confirmed | Single-PK table; select row, delete, confirm "yes" | Structured `delete` with `confirmed:true` → row removed; page refetches | Error envelope inline |
| Delete cancelled | Delete, then Esc / "no" | No RPC sent; row remains | — |
| Table without exactly one PK column | Composite-PK or no-PK table open | Inline edit + delete affordances disabled; insert still available | — |
| Delete reaches Core without `confirmed:true` (defensive) | Any structured delete missing the flag | Core returns `confirmation_required`, deletes nothing | UI treats as not-executed |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- REFERENCE ONLY (no change). Reuse `ExecuteRequest`, `StructuredOp` (`insert`/`update`/`delete`), `StructuredColumnValue = {column,value}`, `StructuredPk = {column,value}`, `ExecuteResult` (`ok`/`confirmation_required`/`rows`), `FrozenData`/`FrozenColumn`/`FrozenCell`.
- `src/ui/data/row-mutations.ts` (NEW) -- pure builders/validators: kind-based value coercion, single-PK guard + PK-value extraction from a `FrozenRow`, and `buildUpdateOp`/`buildDeleteOp`/`buildInsertOp` returning a `StructuredOp` or a validation error.
- `src/ui/data/row-mutations.test.ts` (NEW) -- unit tests for the I/O matrix edge cases.
- `src/ui/data/DataGrid.tsx` -- add inline cell editor (double-click → kind-appropriate input; Enter commits, Esc cancels), per-row delete with inline confirm, and an insert-row draft affordance; new props for mutation callbacks + `canMutate` + busy/error; transient edit UI state kept local (the component stays presentational for data).
- `src/ui/workspace/TabContent.tsx` -- in `TableTabView`: mutation handlers that build the op via `row-mutations`, call `rpc<ExecuteResult>("execute", {shape:"structured", op, confirmed})`, branch on `ok`/`confirmation_required`/error, refetch via `reloadNonce`, track a mutation error/pending state, and compute `canMutate = primaryKeys.length === 1`.
- `src/ui/styles/globals.css` -- only if needed: an edit-in-progress / insert-draft affordance style reusing existing coral tokens (`--coral-soft`/`--coral-line`) and the global focus ring.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/data/row-mutations.ts` -- pure `coerceValue(kind, raw)`, single-PK guard + `pkForRow(columns, primaryKeys, row)`, and `buildUpdateOp`/`buildDeleteOp`/`buildInsertOp(... , draft)` (omit untouched/empty on insert) returning `StructuredOp | {error}` -- the tested seam that keeps `DataGrid`/`TabContent` thin.
- [x] `src/ui/data/row-mutations.test.ts` -- cover the I/O matrix: valid update, non-numeric-into-number rejection, explicit-NULL, omit-empty insert, single-PK guard rejecting composite/no-PK, and PK-value extraction by column index. (21 tests.)
- [x] `src/ui/data/DataGrid.tsx` -- inline cell editor (double-click, Enter/Esc, kind-appropriate control incl. a set-NULL action), per-row delete + inline confirm (mirror `ConnectionRow`), insert-row draft; wire up via new `onCommitEdit`/`onDeleteRow`/`onInsertRow` + `canMutate`/`busy`/`mutationError` props; disable edit+delete when `!canMutate`.
- [x] `src/ui/workspace/TabContent.tsx` -- implement the mutation handlers: build op, `rpc("execute", {shape:"structured", op, confirmed})`, handle `ok` (refetch via `reloadNonce`) / `confirmation_required` (delete flow) / error (inline), auto-commit insert+update, confirm+`confirmed:true` for delete, pass `canMutate` and handlers into `DataGrid`.
- [x] `src/ui/styles/globals.css` -- (if required) add an edit/insert-draft affordance style reusing coral tokens + focus ring. -- Not required: reused existing `--coral-soft`/`--coral-line`/`--coral` + global focus ring; no CSS change.

**Acceptance Criteria:**
- Given an open single-PK table, when I double-click a cell, change its value, and press Enter, then a parameterized single-row UPDATE runs through the Core `execute` structured path, auto-commits with no dialog, the grid refetches, and the new value persists after reload.
- Given an open table, when I add a new row and commit it, then a parameterized INSERT runs through the Core structured path, auto-commits with no dialog, the row total increases, and the row appears on reload.
- Given a selected row in a single-PK table, when I trigger delete, then a confirmation appears and only on explicit confirm does a parameterized single-row DELETE execute (`confirmed:true`) through the Core; on cancel/Esc nothing is deleted.
- Given a table without exactly one primary-key column, when it is open, then inline edit and delete affordances are disabled while insert remains available.
- Given any grid mutation, when issued, then the UI sends only `{shape:"structured", op}` (never raw SQL/DDL/multiple statements) with only table + single PK + column/value fields, and never composes SQL.
- Given a mutation that fails with an error envelope, when it returns, then the message shows inline and the panel stays responsive (no crash; editor/draft state recoverable).

## Spec Change Log

## Review Triage Log

### 2026-07-10 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 2, medium 3, low 4)
- defer: 0
- reject: 4
- addressed_findings:
  - `[high]` `[patch]` The insert draft was not reset after a successful insert (`InsertDraftRow` stayed open pre-filled) → a second commit re-inserted a duplicate row. `onInsertRow` now returns the op status and the draft closes/clears only on `ok`, staying open with its values on error.
  - `[high]` `[patch]` `DataGrid`'s transient `editing`/`confirmingDelete` state is keyed by row index and survived the post-mutation refetch → an open editor or delete-confirm could act on a reindexed (wrong) row. Both are now reset via a `useEffect` on `data` identity, so no stale index outlives a refetch.
  - `[medium]` `[patch]` The cell editor closed and discarded the typed input before validation → an invalid value (e.g. "abc" in a number cell) was lost and the editor closed, violating the spec's "editor stays open, no RPC, recoverable" rule. `onCommitEdit` now reports accepted/rejected and the editor closes only on acceptance.
  - `[medium]` `[patch]` Date coercion round-tripped through `new Date()` — unrepresentable across the JSON-RPC wire as a Date and silently shifting a tz-less input from local to UTC. `coerceValue`/`cellToValue` now validate parseability but send the raw ISO/text literal for the DB to parse in-context.
  - `[medium]` `[patch]` `pkForRow` accepted a NULL primary-key cell value → `WHERE pk = NULL` matched nothing yet the executor returned `ok` (silent no-op reported as success). A null PK value is now a hard `{error}` that disables the mutation.
  - `[low]` `[patch]` `coerceValue("number")` accepted non-finite values (`Number("1e400")` → `Infinity` passed the `isNaN` guard); now rejected via `Number.isFinite`.
  - `[low]` `[patch]` The boolean editor seeded from a NULL cell displayed "true" but committed empty → rejected; it now seeds a valid default so the shown value commits (the explicit "null" action still sets real NULL).
  - `[low]` `[patch]` Esc did not cancel the delete confirm unless the "no" button held focus; the cancel button now autofocuses so Esc reliably closes the confirm.
  - `[low]` `[patch]` The insert-draft row ignored the per-row actions column in its `colSpan`/cell count → misalignment when a single PK enabled actions; the draft now accounts for the actions column.

### 2026-07-10 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 1, low 0)
- defer: 1: (high 1)
- reject: 14
- addressed_findings:
  - `[medium]` `[patch]` `InsertDraftRow.commit` could double-fire: the `busy`/`disabled` guard only lands after the parent re-renders, so two fast synchronous clicks both passed the closure-captured `mutating` check and issued two `insert` RPCs → a duplicate row (the exact case the "reset only on success" comment claimed to prevent). Added a `useRef` in-flight guard that flips before any `await`, so at most one insert is ever in flight per draft regardless of React render timing. Flagged independently by both reviewers.
- deferred (1, appended to `deferred-work.md` as a NEW entry): bigint/int8/numeric precision loss on both the write value (`coerceValue` via `Number(raw)`) and the PK address (`pkForRow`/`cellToValue` read `FrozenCell.value` as a JS number) — a silent wrong-value / wrong-row data-corruption path. Root cause is upstream in Story 3.2's `FrozenCell` number representation; the durable fix belongs with the deferred `SchemaColumnInfo` type-threading, not the 3.3 UI.
- rejected (14): unreachable `execute` result `status:"rows"` for structured DML; unreachable `confirmation_required` for insert/update (only delete gates); empty-string omit-on-insert (spec-by-design); boolean editor on a NULL cell committing the visibly-selected `true` on Enter (WYSIWYG + Esc cancels + explicit `null` action available; tightening reintroduces the prior pass's empty-commit bug); insert draft using free-text controls instead of per-kind inputs (minimal-scope; coercion errors surface gracefully with the draft preserved); loose `new Date()` date validation forwarding the raw literal (spec-by-design — the DB parses in-context and rejections surface inline); no keyboard-only edit path (spec AC defines double-click as the interaction); delete-confirm optimistic close on RPC failure (row correctly persists, error surfaces inline, re-triggerable); `confirmation_required` delete dead-end (unreachable — delete always sends `confirmed:true`); draft state keyed by column name (table switch remounts; columns stable within a table; duplicate output names not a browse surface); hardcoded red/amber Tailwind classes on the destructive button + mutation banner (cosmetic, low); simultaneous open editor + delete-confirm (minor UX, no data risk); pager not disabled during a mutation (the `alive` guard already prevents a stale render); double-clicking a second cell discarding an open editor's text (minor UX).

## Design Notes

- **Core is reused as-is.** Story 3.1's `execute`/`StructuredOp` already composes and guards single-row INSERT/UPDATE/DELETE (parameterized values, `quoteIdent` identifiers, single-column-PK verified against live schema, delete gated by `confirmed`). 3.3 adds only the UI that issues typed ops — no contract or executor change. If the contract differs from this, HALT (Block If) rather than touch the guard.
- **Value typing is the one correctness trap.** Params must be native JS types matching the column: postgres.js serializes a JS string as `text`, and Postgres will not assignment-cast `text` → int/bool/timestamp. Coerce by the inferred `FrozenCell` kind before sending. Columns whose kind can't be inferred (all-NULL on the current page) fall back to string best-effort — a documented limitation, superseded when `SchemaColumnInfo` types are threaded (deferred).
- **Insert omits empties** rather than sending NULLs, so serial PKs and defaulted/NOT-NULL-with-default columns insert cleanly without full schema metadata. A truly-required column left empty surfaces the DB error inline.
- **Delete leans on the Core gate.** The UI confirm is UX; the request executes only with `confirmed:true`; a missing flag makes the Core return `confirmation_required` and mutate nothing.
- **Single-PK constraint is surfaced in the UI** (edit/delete disabled on composite/no-PK tables) to match `resolveSinglePkTable` and avoid predictable `bad_request`s. PK column name comes from `primaryKeys[0]`; its value from the row's cell at that column's index.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors across the new UI module and edited components.
- `bun test` -- expected: all suites pass, including the new `row-mutations` tests covering coercion, single-PK guard, omit-empty insert, and PK extraction.

**Manual checks (if no live DB):**
- Confirm `execute` is invoked with `{shape:"structured", op:{kind:"update"|"insert"|"delete", ...}}` shapes and that delete carries `confirmed:true` only after the UI confirm; insert/update send no `confirmed` and auto-commit.

## Auto Run Result

Status: done

**Implemented change:** Added inline cell editing, row insertion, and row deletion to the browse grid (Story 3.2), routing every mutation through the existing Story 3.1 guarded Core executor as structured single-row DML (RPC `execute`, `{shape:"structured", op}`, path (a)). Insert and single-cell update auto-commit dialog-free; delete requires an inline UI confirm then `confirmed:true`, with the Core as the real gate. UI-only — no change to `src/core/**` or `src/shared/contract.ts`.

**Files changed:**
- `src/ui/data/row-mutations.ts` (new) — pure builders/validators: kind-based value coercion (number rejects NaN/non-finite; boolean; date sends the raw literal; string; explicit NULL), single-PK guard + null-PK rejection, and `buildUpdate/Delete/InsertOp` (omit-empty insert) returning `StructuredOp | {error}`.
- `src/ui/data/row-mutations.test.ts` (new) — unit tests for the I/O matrix + the review fixes (null-PK, non-finite number, date-as-string).
- `src/ui/data/DataGrid.tsx` — inline cell editor (double-click, Enter/Esc, set-NULL), insert-draft row, per-row delete with inline confirm; transient edit state reset on refetch; edit/delete disabled when not exactly one PK.
- `src/ui/workspace/TabContent.tsx` — mutation handlers calling `execute`, `ok`/`confirmation_required`/error handling, refetch via `reloadNonce`, `canMutate = primaryKeys.length === 1`.

**Review findings breakdown:** 9 patches applied (2 high, 3 medium, 4 low) — see Review Triage Log. 0 intent_gap, 0 bad_spec, 0 deferred, 4 rejected (unreachable `execute` status; a duplicate untouched-NULL-cell case folded into the editor/boolean fixes; a negligible double-submit keyboard window already covered by the busy guard; the by-design insert/update empty-string asymmetry).

**Verification:** `bunx tsc --noEmit` → clean (exit 0). `bun test` → 534 pass, 0 fail (28 files, 1308 asserts). The two HIGH data-integrity bugs (duplicate insert, wrong-row mutation after refetch) and the date-value corruption are fixed and re-verified.

**Residual risks:** Value typing for columns whose kind can't be inferred (all-NULL page → kind `"null"`) falls back to a best-effort string — resolved once `SchemaColumnInfo` types are threaded (deferred). Date/timestamp edits cross as text literals parsed by the DB in its own timezone context (no client-side reinterpretation).

### 2026-07-10 — Follow-up review pass

An independent adversarial + edge-case review pass (two reviewers at session model capability) was run against the full baseline→HEAD diff.

**Change applied this pass:** `src/ui/data/DataGrid.tsx` — `InsertDraftRow.commit` gained a `useRef` in-flight guard. The `busy`/`disabled` gate only takes effect after a parent re-render, so two fast synchronous clicks could both pass the closure-captured `mutating` check and fire two `insert` RPCs (a duplicate row). The ref flips before any `await`, so at most one insert is in flight per draft. Both reviewers flagged this independently.

**Deferred (1, high):** bigint/int8/numeric precision loss on the write value and the PK address (`Number(raw)` coercion + `FrozenCell.value` read as a JS number) — a silent wrong-value / wrong-row corruption path. Root cause is upstream in Story 3.2's `FrozenCell` number representation; the durable fix belongs with the deferred `SchemaColumnInfo` type-threading. Appended to `deferred-work.md` as a NEW entry.

**Rejected (14):** unreachable `execute` result shapes, several spec-by-design behaviors (empty-string omit-on-insert, raw-literal date forwarding, double-click-to-edit interaction, boolean WYSIWYG commit), and low-consequence UX/cosmetic items — see the Review Triage Log for the full list and rationale.

**Verification:** `bunx tsc --noEmit` → clean (exit 0). `bun test` → 534 pass, 0 fail (28 files, 1308 asserts). No spec/intent gap and no bad-spec loopback: the diff conforms to the intent contract.

**Residual risks (unchanged):** the deferred bigint-precision item is the only outstanding data-integrity concern; it is out of Story 3.3's scope by the spec's explicit `SchemaColumnInfo` deferral. `followup_review_recommended: false` — this pass made a single localized, low-complexity patch.
