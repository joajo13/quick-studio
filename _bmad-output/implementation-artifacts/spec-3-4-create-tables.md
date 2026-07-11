---
title: 'Create tables'
type: 'feature'
created: '2026-07-11'
status: 'done'
baseline_revision: '54dd152b9b612eae6ef5525e641dac8286cbe450'
review_loop_iteration: 0
followup_review_recommended: false
final_revision: '132eab8edded9a849def4707b053e25411da2f5f'
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The Data & Schema workspace can browse and edit rows (Stories 3.2/3.3) but a developer cannot create a new table — the daily schema work that, together with row editing, decides tool adoption (UJ-1). The guarded Core executor already exposes a `createTable` structured op (Story 3.1), but no UI issues it and nothing surfaces the result in the schema tree.

**Approach:** Add a create-table surface (a rail-toggled panel mirroring `SettingsPanel`) that collects a table name, target schema, and typed column defs (name, type from the Core allowlist, NOT NULL, primary-key flags) and submits them through the Story 3.1 guarded Core executor as a **structured** op (RPC `execute`, `{shape:"structured", op:{kind:"createTable", …}}`, path (a)) — never raw SQL. CREATE TABLE auto-commits dialog-free. On success the new table appears in the schema tree **without a manual refresh** via an optimistic client-side append (the Core's connect-time schema cache is memoized and cannot be re-introspected without a Core change). UI-only story: the executor already composes and guards this op; nothing in the Core changes.

## Boundaries & Constraints

**Always:**
- Every create calls RPC `execute` with `{shape:"structured", op:{kind:"createTable", …}}` (path (a)); the UI never composes SQL and never uses the `raw` shape.
- The op carries only `schema?` + `table` + typed column defs (`{name, type, notNull?, primaryKey?}`). `type` is an allowlisted canonical token (a UI mirror of the executor's `CREATE_TABLE_TYPES`), never free text; primary-key membership is expressed via per-column `primaryKey:true` flags (the Core folds them into the effective PK set — no separate table-level PK array needed).
- CREATE TABLE auto-commits: send NO `confirmed` and show NO dialog (the CREATE TABLE fast-path, per epic). Handle `status:"ok"` (success) and any error envelope (inline). Treat an unexpected `confirmation_required` defensively as an inline error — createTable never gates.
- On `ok`, optimistically append the synthesized `SchemaTableInfo` (built from the submitted draft) to the schema tree so the table appears with no manual refresh, AND feed it into the App-level table list used for PK lookup (so the new table is immediately editable per Story 3.3). Close/reset the form on `ok`; keep it open with its values on error.
- Validate before enabling submit: non-empty table name, ≥1 column, unique non-empty column names, a selected type per column. Primary key is optional (a PK-less table is allowed). Never send an RPC on invalid input.
- Guard submit with an in-flight `useRef` that flips before the `await`, so two fast synchronous clicks issue exactly one create (the `busy`/`disabled` gate only lands after a re-render — the exact duplicate-op class of bug fixed in Story 3.3).
- Reuse the existing `rpc` client, `envelopeText`, the `SettingsPanel` `Field`/draft/validate/busy pattern, and DESIGN tokens (mono, coral, global focus ring). No new modal framework: the surface toggles in the main Panel like `SettingsPanel` and is mutually exclusive with it.

**Block If:**
- The Core `execute`/`createTable` contract does not, in fact, accept the structured create-table op with allowlisted type tokens and auto-commit (`status:"ok"`) semantics as specified here → HALT (investigation stale; do NOT modify or work around the Story 3.1 executor/guard/allowlist).

**Never:**
- Never compose SQL in the UI or use the `raw` execute shape.
- Never modify the Core executor, its guard/classifier, or its type allowlist — Story 3.1 owns them; 3.4 is a consumer.
- Never re-introspect by mutating the Core's connect-time schema cache; the refresh is UI-side optimistic append only.
- Never batch multiple statements or create more than one table per op.
- Out of scope (defer): column length/precision params (`VARCHAR(n)`, `NUMERIC(p,s)`) — bare allowlist tokens only; foreign keys and CHECK/UNIQUE/DEFAULT constraints beyond NOT NULL + PK; ALTER/DROP table; multi-engine type mapping (the Core allowlist is engine-blind — postgres-flavored tokens fail-closed on MySQL, a Story 3.1 deferral); creating into a brand-new schema; a true DB re-introspection refresh (would require a Core change to the memoized cache).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create a valid table | Name + ≥1 typed column, optional PK checkbox(es), submit | `execute {shape:"structured", op:{kind:"createTable"}}` runs, auto-commits (`status:"ok"`), panel closes/resets, table appears in the schema tree with NO manual refresh | RPC/DB error envelope → inline; draft preserved |
| Missing name or zero columns | Empty table name, or no column rows | Submit disabled; NO RPC sent | Inline validation |
| Duplicate column names | Two columns with the same name | Submit disabled; NO RPC sent | Inline validation |
| Column-level PK flags | One or more columns flagged PK | Op carries `primaryKey:true` per flagged column; Core folds them into the effective PK; synthesized table's `primaryKey` lists them | — |
| Table name already exists | Name of an existing table | Core returns an error envelope (relation exists); NOT appended to the tree; draft preserved | Inline error |
| Type rejected by the engine | e.g. `UUID`/`JSON`/`DOUBLE PRECISION` on a MySQL connection | Core `bad_request`/DB error surfaced inline; no tree change; draft preserved | Inline error (known multi-engine limitation) |
| Double-click submit | Two fast synchronous submit clicks | In-flight ref guard → exactly one `createTable` RPC in flight | — |
| Click the newly-created tree entry | The optimistically-appended table | Binds to a data tab and browses via `table.rows` (it really exists in the DB) | Standard browse error path |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- REFERENCE ONLY (no change). Reuse `ExecuteRequest`, `StructuredOp` (`createTable` variant: `{kind:"createTable", schema?, table, columns, primaryKey?}`), `StructuredColumnDef` (`{name, type, notNull?, primaryKey?}`), `ExecuteResult` (`status:"ok"` for createTable), `SchemaTableInfo`/`SchemaColumnInfo`, `ConnectResult`.
- `src/core/executor.ts` -- REFERENCE ONLY (no change). Source of truth for the type allowlist `CREATE_TABLE_TYPES` (13 tokens: `INTEGER, BIGINT, SMALLINT, TEXT, VARCHAR, BOOLEAN, DATE, TIMESTAMP, NUMERIC, REAL, DOUBLE PRECISION, UUID, JSON`) and the createTable compose/guard semantics. Do not edit.
- `src/ui/schema/create-table.ts` (NEW) -- pure seam: the `CREATE_TABLE_TYPES` UI mirror, `ColumnDraft`/`CreateTableDraft` types, `validateCreateTableDraft(draft)` (errors or ok), `buildCreateTableOp(draft)` → `StructuredOp | {error}`, and `synthesizeSchemaTable(draft)` → `SchemaTableInfo` for the optimistic append. Keeps the panel thin and testable with no live DB.
- `src/ui/schema/create-table.test.ts` (NEW) -- unit tests for the I/O matrix edge cases.
- `src/ui/schema/CreateTablePanel.tsx` (NEW) -- the form surface (mirror `SettingsPanel`: `Field`, draft state, repeatable column rows with add/remove, per-column type `<select>` + NOT NULL + PK checkboxes, `validate`, `busy` + in-flight `useRef` guard, error banner via `envelopeText`). Submits `rpc<ExecuteResult>("execute", {shape:"structured", op})`; on `ok` calls `onCreated(synthesizeSchemaTable(draft))` and closes.
- `src/ui/schema/SchemaTree.tsx` -- accept a new `extraTables?: ReadonlyArray<SchemaTableInfo>` prop and render `[...load.schema.tables, ...extraTables]` (deduped by `schema.name`, count reflected in the header) so optimistically-created tables appear without re-introspection. Fetch-once-on-mount behavior is otherwise unchanged.
- `src/ui/workspace/Workspace.tsx` -- add a rail control mirroring the ⚙ Settings toggle that toggles a `createOpen` surface; render `<CreateTablePanel/>` in the main Panel (mutually exclusive with `SettingsPanel`); pass `extraTables` into `SchemaTree`, and pass the existing schema/table context (for schema default + dup-name validation) and the `onCreated` appender into `CreateTablePanel`.
- `src/ui/App.tsx` -- own `createdTables` state; merge into the table list used by the `primaryKeys` memo (`[...schemaTables, ...createdTables]`) and pass `createdTables` + an `onTableCreated` appender down to `Workspace`.
- `src/ui/settings/SettingsPanel.tsx` -- REFERENCE for the `Field` component and add-form/validate/busy pattern. If `Field` is exported, reuse it; otherwise mirror its classes (mono, `focus:border-primary`, `invalid` state).
- `src/ui/styles/globals.css` -- only if needed: a form/column-row affordance reusing existing tokens (coral, focus ring). Likely no change.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/schema/create-table.ts` -- the `CREATE_TABLE_TYPES` UI mirror (comment: MUST mirror `executor.ts`; drift fails closed via Core `bad_request`), `validateCreateTableDraft`, `buildCreateTableOp` (per-column `primaryKey` flags; omit undefined/false flags), and `synthesizeSchemaTable` (columns → `{name, dataType:type, nullable:!notNull}`, `primaryKey` = flagged column names, `schema` = exactly the submitted schema) returning `StructuredOp | {error}`.
- [x] `src/ui/schema/create-table.test.ts` -- cover the I/O matrix: valid build, missing-name/zero-column/dup-name rejection, PK-flag folding, allowlist token pass-through, and `synthesizeSchemaTable` shape (nullable/PK derivation). (18 tests.)
- [x] `src/ui/schema/CreateTablePanel.tsx` -- the form (name, schema selector defaulted from existing schemas, repeatable typed column rows, submit disabled until valid, `busy` + in-flight ref guard, inline error banner); `rpc("execute", {shape:"structured", op})`; branch `ok` (call `onCreated`, close/reset) / error (inline, keep draft) / defensive `confirmation_required` (inline error).
- [x] `src/ui/schema/SchemaTree.tsx` -- add `extraTables` prop; render the loaded tables merged with `extraTables` (deduped via `mergeTables`, introspection wins), header count updated; keep the fetch-once effect unchanged.
- [x] `src/ui/workspace/Workspace.tsx` -- rail toggle (`＋`, `create-table-toggle`) + `createOpen` state; render `CreateTablePanel` in the main Panel mutually exclusive with `SettingsPanel`; thread `extraTables`, `schemas`, and `onCreated` (→ App's `onTableCreated`) through.
- [x] `src/ui/App.tsx` -- `createdTables` state; `onTableCreated` appender; `allTables = [...schemaTables, ...createdTables]` merged into the `primaryKeys` lookup so a freshly-created table is editable; `schemas` memo; pass `createdTables`/`schemas` + `onTableCreated` into `Workspace`.
- [x] `src/ui/styles/globals.css` -- (if required) form/column-row affordance reusing existing tokens + focus ring. -- Not required: reused existing tokens (coral accents, focus ring, mono) + Tailwind utilities; no CSS change.

**Acceptance Criteria:**
- Given a connected database, when I open the create-table surface, define a table name, one or more columns with allowlisted types and (optionally) a primary key, and submit, then a parameterized/identifier-quoted CREATE TABLE runs through the Core structured `execute` path (path (a)), auto-commits with no dialog, and the new table appears in the schema tree without a manual refresh.
- Given the newly-created table shown in the tree, when I click it, then it binds to a data tab and browses via `table.rows` (it exists in the DB), and edit/insert/delete work per Story 3.3 (single-PK tables enable inline edit/delete).
- Given any create, when issued, then the UI sends only `{shape:"structured", op:{kind:"createTable", …}}` (never raw SQL/DDL text, never multi-statement) with typed table + schema + column/type/PK fields, and never composes SQL.
- Given a create that fails (name clash, engine-incompatible type, DB error), when it returns, then the error shows inline, the panel stays responsive with the draft recoverable, and the schema tree is unchanged.
- Given a table created optimistically this session, when the app reconnects (fresh process), then the tree reflects the Core's re-introspected truth (the optimistic entry is not persisted anywhere).

## Spec Change Log

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 0
- reject: 12
- addressed_findings:
  - `[medium]` `[patch]` A table created into the default namespace on an otherwise-empty DB synthesized `schema:""`; clicking it dispatched `bindTable`/`table.rows` with `schema:""`, which the Core rejects as `bad_request` ("non-empty string when provided") — the just-created table was un-browsable (and structured edits un-runnable) until reconnect. `TableTabView` now derives one `effectiveSchema` (blank → `undefined`) shared by the `table.rows` fetch and the structured-op `target`, so a blank schema is omitted and the Core resolves its default; the result-bar label drops the leading dot for a blank schema. (`src/ui/workspace/TabContent.tsx`.)
  - `[low]` `[patch]` The create-table schema selector could render a blank `""` option once an empty-schema optimistic entry existed. App's `schemas` memo now skips blank schema names. (`src/ui/App.tsx`.)
  - `[low]` `[patch]` `synthesizeSchemaTable` marked a primary-key column `nullable:true` when the user left NOT NULL unchecked, diverging from DB truth (a PK column is NOT NULL). Now `nullable: !(notNull || primaryKey)`. (`src/ui/schema/create-table.ts` + regression test.)
  - `[low]` `[patch]` `synthesizeSchemaTable` used an untrimmed `schema` while `buildCreateTableOp` trimmed it, so a whitespace-padded schema could desync the optimistic key from the op's effective target. Synthesis now trims to match. (`src/ui/schema/create-table.ts` + regression test.)
  - `[low]` `[patch]` Column rows were keyed by array index, so removing a non-last column misattached focus/transient DOM state to the wrong row. Each row now carries a stable `_key` minted at creation. (`src/ui/schema/CreateTablePanel.tsx`.)
- rejected (12): `createdTables` never cleared "on reconnect" (no in-session reconnect/remount exists — `SchemaTree` mounts once and a fresh process resets all state; this is precisely why the append is optimistic); synthesized `dataType` token vs introspected verbatim spelling (not displayed — the tree shows a column count and the grid reads real `table.rows` columns; spec-acknowledged, self-corrects on reconnect); composite-PK-via-per-column-flags "assumption" (verified: the Core folds per-column `primaryKey:true` into one effective PK); case-only duplicate column names (Core quotes identifiers → case-sensitive/distinct on Postgres, fail-closed inline error on MySQL — no silent corruption); no client-side table-name-collision guard (by design — the Core returns an error inline, the row is not appended, the draft is preserved; the spec's I/O matrix row); no free-text schema input on an empty DB (creating into a brand-new schema is explicitly out of scope); appended table sorts to the list bottom (the tree renders a flat list with no visual schema grouping; re-sorting would disturb Story 3.2's introspection order); `schemas` default captured once and stale after mount (cannot occur — the panel can only be opened after startup `connect` resolves and `schemas` is stable thereafter); and four low/cosmetic UX-polish items (no hint on the disabled submit until "dirty", only the first validation reason shown, per-field `invalid` not surfaced, Enter does not submit) — the form is functional and none are required by the spec.

## Design Notes

- **Core is reused as-is.** Story 3.1 already composes and guards `createTable` (identifier-quoted `CREATE TABLE`, allowlisted types validated in `readColumnDefs` and re-asserted at compose time, effective PK = table-level array ∪ column-level `primaryKey:true` flags, DDL auto-commits with no confirmation gate). 3.4 adds only the UI that issues the typed op — no contract or executor change. If the contract differs from this, HALT (Block If) rather than touch the guard.
- **Schema refresh is optimistic, not a re-introspect — and this is deliberate.** `SchemaTree` fetches once via the `connect` RPC, but `ConnectionManager.doConnect` is idempotent (`connection.ts`: `if (cached !== null) return cached`) and `getSchema()` is memoized at connect time. Re-calling `connect` returns the STALE cached schema WITHOUT the new table. A true refresh would require changing the Core's connect-time memoization — out of scope and outside the UI-only discipline of this epic's stories. Instead: a createTable `ok` guarantees the table exists exactly as specified (DDL is all-or-nothing), so the UI synthesizes the `SchemaTableInfo` from the submitted draft and appends it to the tree. It is superseded by introspected truth on the next reconnect (a fresh process resets the optimistic list).
- **PK via per-column flags.** The form needs only a per-column PK checkbox; the op carries `primaryKey:true` on those columns and the Core folds them into the effective PK (the exact post-hoc fix recorded in Story 3.1). No table-level PK array in the UI.
- **Type vocabulary mirrors the Core allowlist.** The 13 `CREATE_TABLE_TYPES` tokens live in `executor.ts` (Core, not shared), so the UI keeps a mirrored constant with a comment binding it to the authority. Drift fails closed: an unknown token yields a Core `bad_request` surfaced inline — never a silent bad DDL.
- **Multi-engine caveat (inherited deferral).** The Core allowlist is engine-blind; postgres-flavored tokens (`DOUBLE PRECISION`, `UUID`, `JSON`, …) fail-closed on MySQL. 3.4 does NOT fix this (a Core change explicitly deferred by Story 3.1) — it surfaces the DB/`bad_request` error inline and preserves the draft.
- **Schema qualifier consistency.** The form targets a schema chosen from existing schemas (default the first, typically `public`) so the optimistic entry's grouping and the click→`bindTable`/`table.rows` browse agree with how introspection lists it. The empty-DB / brand-new-schema edge falls back to the Core default and self-corrects on the next reconnect.
- **In-flight ref guard on submit.** The `busy`/`disabled` gate only takes effect after a parent re-render, so two fast synchronous clicks could both pass a closure-captured check and fire two creates. Flip a `useRef` before any `await` (the fix pattern proven in Story 3.3's insert-draft).

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors across the new schema/create module and edited components.
- `bun test` -- expected: all suites pass, including the new `create-table` tests (validation, op build, PK folding, `synthesizeSchemaTable`).

**Manual checks (if no live DB):**
- Confirm `execute` is invoked with `{shape:"structured", op:{kind:"createTable", table, columns:[{name,type,notNull?,primaryKey?}], schema?}}` and NO `confirmed`, and that on `status:"ok"` the schema tree shows the new table without any reload/`connect` re-fetch.

## Auto Run Result

Status: done

**Implemented change:** Added a create-table surface (a rail-toggled panel mirroring `SettingsPanel`) that collects a table name, target schema, and typed column defs (name, allowlisted type, NOT NULL, primary-key flags) and issues them through the Story 3.1 guarded Core executor as a structured op (RPC `execute`, `{shape:"structured", op:{kind:"createTable", …}}`, path (a)). CREATE TABLE auto-commits dialog-free; on success the new table appears in the schema tree with no manual refresh via an optimistic client-side append (the Core's connect-time schema is memoized and cannot be re-introspected without a Core change). UI-only — no change to `src/core/**` or `src/shared/contract.ts`.

**Files changed:**
- `src/ui/schema/create-table.ts` (new) — pure seam: `CREATE_TABLE_TYPES` (mirror of the executor allowlist, drift fails closed), `validateCreateTableDraft`, `buildCreateTableOp` (per-column PK/notNull flags, blank schema omitted), `synthesizeSchemaTable` (columns → `{name, dataType, nullable}`, PK ⇒ NOT NULL, trimmed schema) → `StructuredOp | {error}`.
- `src/ui/schema/create-table.test.ts` (new) — 20 unit tests over the I/O matrix + the two synthesize regressions (PK-implies-NOT-NULL, schema trim).
- `src/ui/schema/CreateTablePanel.tsx` (new) — the form (name, schema selector, repeatable typed column rows with stable keys, submit disabled until valid, `busy` + in-flight `useRef` guard); submits `execute {shape:"structured", op}` with NO `confirmed`; `ok` → `onCreated` + close, error/`confirmation_required` → inline with the draft preserved.
- `src/ui/schema/SchemaTree.tsx` — new `extraTables` prop merged (deduped) into the rendered list so optimistically-created tables appear without re-introspection.
- `src/ui/workspace/Workspace.tsx` — a `＋` rail control toggling `CreateTablePanel` in the main Panel, mutually exclusive with `SettingsPanel`; threads `extraTables`/`schemas`/`onTableCreated`.
- `src/ui/App.tsx` — `createdTables` state + `onTableCreated` appender; merged into the `primaryKeys` lookup (new table immediately editable) and a blank-filtered `schemas` selector list.
- `src/ui/workspace/TabContent.tsx` — derives one `effectiveSchema` (blank → omitted) shared by the `table.rows` fetch and the structured-op target, so a table created into the default namespace is browsable and editable in-session; result-bar label drops the leading dot for a blank schema.

**Review findings breakdown:** 5 patches applied (1 medium, 4 low) — see Review Triage Log. 0 intent_gap, 0 bad_spec, 0 deferred, 12 rejected (a non-existent in-session reconnect, verified-correct composite-PK folding, identifier-quoting that makes case-only column collisions safe/fail-closed, by-design server-side collision handling, out-of-scope brand-new-schema creation, and low/cosmetic UX-polish items).

**Verification:** `bunx tsc --noEmit` → clean (exit 0). `bun test` → 554 pass, 0 fail (29 files, 1333 asserts). The medium finding (empty-DB created table un-browsable/un-editable via `schema:""`) and all four low findings are fixed and re-verified.

**Residual risks:** On a truly empty database, a table created into the default namespace carries no known schema name in its optimistic tree entry (`schema:""`); browse and structured edits work (the blank schema is omitted so the Core resolves its default), but the entry's displayed schema/`dataType` reflect the submitted draft rather than introspected truth until the next reconnect (a fresh process), which supersedes the optimistic list. Creating into a brand-new schema, column length/precision params, and non-PK/NOT-NULL constraints remain out of scope per the intent contract. The engine-blind Core type allowlist (Story 3.1 deferral) means postgres-flavored tokens fail closed with an inline error on MySQL.
