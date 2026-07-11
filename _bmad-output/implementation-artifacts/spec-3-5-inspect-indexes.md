---
title: 'Inspect indexes'
type: 'feature'
created: '2026-07-11'
status: 'done'
baseline_revision: '355bc41c4cffeaf154057b40f490837bfc83301c'
final_revision: 'c570a1a563819a1b8db0a9219b7a017505d9f9e1'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The Data & Schema workspace can browse, edit, and create tables (Stories 3.2–3.4), but a developer cannot see a table's indexes — the columns they cover and whether each is unique. The epic requires "view a table's indexes, each listing its columns and its uniqueness," but the Core introspects **only** columns and the primary key (`SchemaTableInfo` carries no index data), so nothing in the UI can surface it. This is a genuine Core gap, not a UI-only story like 3.4.

**Approach:** Follow the existing `primaryKey` introspection precedent exactly: add a `SchemaIndexInfo {name, columns, unique}` type and a required `indexes` field on `SchemaTableInfo` to the wire contract; have each engine driver's `listSchema()` introspect index metadata (Postgres `pg_index`/`pg_class`/`pg_attribute`; MySQL `information_schema.statistics`) and fold it in the assembler alongside PK. Indexes ride inside the existing memoized `connect`/`getSchema` payload — **no new RPC**. The UI then reads the active table's `.indexes` (already in hand via the `allTables`/`primaryKeys` lookup) and renders a read-only `rows | indexes` sub-view toggle inside `TableTabView`; no fetch, no SQL in the UI.

## Boundaries & Constraints

**Always:**
- All index introspection SQL lives **only** in the Core drivers (engine-dialect isolation). Add `SchemaIndexInfo {name: string; columns: ReadonlyArray<string>; unique: boolean}` to `contract.ts` and a required `indexes: ReadonlyArray<SchemaIndexInfo>` on `SchemaTableInfo` (empty array when a table has none — mirroring how `primaryKey` is always present).
- Index metadata is introspected eagerly at connect time inside `listSchema()` and folded in the assembler exactly as `primaryKey` is (`isPrimaryKey`/`assembleSchema` precedent); it flows to the UI inside the already-memoized `connect` payload.
- Each `SchemaIndexInfo.columns` lists the index's columns in **index order** (Postgres `indkey` position; MySQL `SEQ_IN_INDEX`), not table or alphabetical order. `unique` is true iff the index is a unique index.
- The PK-backing index legitimately appears in the list (Postgres `<table>_pkey`, MySQL `PRIMARY`), marked unique — "view a table's indexes" includes it; do not filter it out.
- The UI reads the active table's `indexes` from the resolved `SchemaTableInfo` (same `allTables` lookup that yields `primaryKeys`) and threads it down parallel to `primaryKeys`. The index sub-view is presentational and read-only: it issues no RPC and composes no SQL.
- The `rows | indexes` toggle lives in `TableTabView`'s result-bar; the body renders `DataGrid` (rows) or the new `IndexList` (indexes), mutually exclusive. Reuse DESIGN tokens (mono, sticky header, `--coral-soft`, the `⚿`/`--t-key` marker for unique, the "0 rows"-style empty state → "0 indexes").
- `synthesizeSchemaTable` (Story 3.4 optimistic append) must set `indexes: []` so freshly-created tables type-check and render "0 indexes" until the next reconnect supersedes the optimistic entry.

**Block If:**
- The `primaryKey` eager-introspection precedent no longer holds — e.g. `assembleSchema`/`listSchema` in `driver.ts` no longer group flat introspected rows into `SchemaTableInfo` as documented, so index rows cannot be folded the same way → HALT (investigation stale; do not invent a divergent introspection path).

**Never:**
- Never route index introspection through the guarded `execute` executor or add any mutating RPC. Introspection is read-only and uses the driver's existing internal query path — the Story 3.1 executor, guard, and classifier are untouched.
- Never add a lazy `table.indexes` RPC or fetch indexes on demand — the design choice is eager, connect-time introspection matching the memoized schema cache and the `primaryKey` precedent.
- Never compose index SQL in the UI or expose engine-specific SQL above the driver layer.
- Out of scope (defer): index method/type (btree/hash/gin/…), partial-index predicates (`WHERE`), covering/`INCLUDE` columns, per-column sort direction (ASC/DESC) and `NULLS` ordering, expression-index expressions, index size/storage, and any create/drop/rebuild of indexes. Surface only name + ordered columns + unique. Expression-index columns (Postgres `attnum = 0`) may be omitted rather than rendered as an expression.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Table with several indexes | Table with a PK, a single-column unique index, and a composite non-unique index | Index view lists each index: name, ordered columns, unique marker on the unique ones | No error expected |
| Multi-column index ordering | Composite index on `(b, a)` | Columns render in index order `b, a` (not alphabetical/ordinal) | — |
| Unique vs non-unique | Mix of unique and non-unique indexes | Unique indexes carry the `⚿`/unique marker; non-unique do not | — |
| PK-backing index | Table with a primary key | The PK's unique index (`*_pkey` / `PRIMARY`) appears in the list, marked unique | — |
| Table with no indexes | Table with no PK and no secondary indexes | Body renders headers + "0 indexes" (no decorative empty art) | — |
| Toggle rows ↔ indexes | User clicks the `indexes` toggle, then `rows` | Body swaps `DataGrid` ↔ `IndexList`; no server round-trip (indexes already in the schema payload) | — |
| Optimistically-created table | A table created this session via Story 3.4 | Index view shows "0 indexes" (optimistic `indexes: []`); real indexes appear after a fresh reconnect | — |
| Default/empty-namespace table | Table in the resolved default schema | Indexes introspected and grouped under the same schema the table is grouped under | — |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- ADD `SchemaIndexInfo {name: string; columns: ReadonlyArray<string>; unique: boolean}` and a required `indexes: ReadonlyArray<SchemaIndexInfo>` field on `SchemaTableInfo` (currently `{schema, name, columns, primaryKey}` ~L236-241). Update the L234-235 comment that calls `primaryKey` the "ONLY constraint info introspected."
- `src/core/driver.ts` -- extend the introspection assembly: add an `IntrospectedIndex`-style flat row type mirroring `IntrospectedColumn` (`isPrimaryKey` at ~L97-110), and fold flat index rows into `SchemaTableInfo.indexes` inside `assembleSchema` (~L118-147) grouping by index name and preserving column order. `Driver.listSchema()` still returns `DatabaseSchema` (now with `indexes`) — NO new `Driver` method.
- `src/core/driver-postgres.ts` -- in `listSchema` (~L112-146) add an index-introspection query over `pg_index`/`pg_class`/`pg_attribute`/`pg_namespace` yielding `(schema, table, index_name, is_unique, column_name, ordinal)` (same non-system-schema scoping as the column query); pass the rows to the assembler.
- `src/core/driver-mysql.ts` -- in `listSchema` (~L170-220) add an index query over `information_schema.statistics` selecting `INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX` with the existing db/system-schema scoping; `unique = NON_UNIQUE = 0`; pass to the assembler.
- `src/core/driver.test.ts` (or the assembler's existing test file) -- unit-test index folding: grouping by index name, column ordering, unique flag derivation, PK-index inclusion, and the empty case.
- `src/ui/data/IndexList.tsx` (NEW) -- presentational read-only component: sticky mono header, one row per index (name, `columns.join(", ")`, unique marker reusing the `⚿` glyph + `--t-key`), "0 indexes" empty state mirroring `DataGrid`'s "0 rows". No rpc, no mutation, no state beyond props.
- `src/ui/data/IndexList.test.tsx` (NEW) -- render tests: multiple indexes, ordered columns, unique vs non-unique marker, "0 indexes" empty state.
- `src/ui/workspace/TabContent.tsx` -- `TableTabView`: add `view: "rows" | "indexes"` local state and a segmented toggle in the result-bar (~L194-222); render `IndexList` (fed the table's `indexes` prop) vs `DataGrid` in the body branch (~L255-274). Indexes come from props — no fetch.
- `src/ui/App.tsx` -- resolve the active table's `indexes` alongside `primaryKeys` from the same `allTables` lookup (~L254-260) and thread it down.
- `src/ui/workspace/Workspace.tsx` -- thread the active table's `indexes` from `App` through to `TabContent`/`TableTabView`, parallel to the existing `primaryKeys` prop (~L254).
- `src/ui/schema/create-table.ts` -- `synthesizeSchemaTable`: add `indexes: []` to the synthesized `SchemaTableInfo` (keeps Story 3.4's optimistic append type-correct; superseded on reconnect).

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `SchemaIndexInfo` and the required `indexes` field on `SchemaTableInfo`; update the stale PK-only comment.
- [x] `src/core/driver.ts` -- add the `IntrospectedIndex` row type and fold index rows into `SchemaTableInfo.indexes` in `assembleSchema` (group by index name, preserve column order, derive `unique`).
- [x] `src/core/driver-postgres.ts` -- add the `pg_index`-based index query to `listSchema` and route rows through the assembler.
- [x] `src/core/driver-mysql.ts` -- add the `information_schema.statistics` index query to `listSchema` (unique = `NON_UNIQUE = 0`) and route rows through the assembler.
- [x] `src/core/driver.test.ts` -- unit-test index folding (grouping, ordering, uniqueness, PK-index inclusion, empty case).
- [x] `src/ui/data/IndexList.tsx` -- the read-only index list component reusing DataGrid header/mono/`--coral-soft`/empty-state idioms and the `⚿`/`--t-key` unique marker.
- [x] `src/ui/data/IndexList.test.tsx` -- render tests for ordered columns, unique markers, and the "0 indexes" empty state.
- [x] `src/ui/workspace/TabContent.tsx` -- `rows | indexes` toggle in `TableTabView`'s result-bar + body branch rendering `IndexList` vs `DataGrid`.
- [x] `src/ui/App.tsx` -- resolve and pass the active table's `indexes` alongside `primaryKeys`.
- [x] `src/ui/workspace/Workspace.tsx` -- thread `indexes` from `App` to `TabContent`.
- [x] `src/ui/schema/create-table.ts` -- add `indexes: []` to `synthesizeSchemaTable`'s output.

**Acceptance Criteria:**
- Given a connected PostgreSQL or MySQL database, when the schema is introspected at connect time, then each `SchemaTableInfo` carries an `indexes` array whose entries list the index name, its columns in index order, and its `unique` flag — sourced only from Core driver SQL that never leaves the driver layer.
- Given a table bound to the active data tab, when I switch to the indexes sub-view and back, then I see that table's indexes (name, columns, uniqueness) and its rows respectively, with no additional server round-trip for indexes and no SQL composed in the UI.
- Given the Story 3.1 guarded executor and its guard/classifier, when this story ships, then they are unchanged and no new mutating RPC exists — index introspection is read-only.
- Given a table with no indexes, when I open the indexes view, then it renders headers with "0 indexes" (no decorative empty art), consistent with the "0 rows" convention.

## Spec Change Log

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 1, medium 1, low 0)
- defer: 0
- reject: 4
- addressed_findings:
  - `[high]` `[patch]` The Postgres index query reads the system catalogs but only excluded `pg_catalog`/`information_schema`, so `pg_toast` toast indexes (one exists for every table with a varlena TEXT/JSONB/bytea column) and materialized-view indexes flowed into `assembleSchema`, where `ensureEntry` materialized **phantom column-less tables** — polluting the schema tree on virtually every real Postgres database. Fixed at two layers: (a) the index-fold loop now only DECORATES tables already produced by column introspection (`index.get`, `continue` when absent) so an index row can never create a table; (b) the PG index query excludes every `pg_*` system schema (`n.nspname !~ '^pg_'`). Added a regression test proving toast/matview index rows are dropped, not materialized. (`src/core/driver.ts`, `src/core/driver-postgres.ts`, `src/core/driver.test.ts`.)
  - `[medium]` `[patch]` A MySQL 8 functional-key-part index carries a NULL `COLUMN_NAME` in `information_schema.statistics` (the expression lives in `EXPRESSION`); the mapper pushed that `null` into the folded `columns` array, violating the declared `string` element type and rendering an empty/`"null"` column entry in `IndexList`. Fixed by filtering `column_name IS NOT NULL` in the MySQL index query — the direct analog of Postgres's `attnum > 0` expression-column filter, so no null ever reaches the fold. (`src/core/driver-mysql.ts`.)
- rejected (4): INCLUDE/covering columns render as ordinary key columns (spec explicitly defers covering columns; the clean fix via `ix.indnkeyatts` would reference a catalog column absent before Postgres 11, a compatibility regression not worth a deferred concern); expression columns dropped from mixed indexes and expression-only indexes omitted entirely (the spec explicitly permits omitting Postgres `attnum = 0` expression columns as out of scope); the "0 indexes" empty state still renders the header row (intentional — mirrors `DataGrid`'s "0 rows" convention the spec asked to follow); and a pathological `CREATE INDEX ON t(a, a)` collapsing its duplicate column to one entry (not a real-world index shape).

### 2026-07-11 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 1, low 0)
- defer: 0
- reject: 13
- addressed_findings:
  - `[medium]` `[patch]` The `rows | indexes` toggle left the rows-path feedback banners bound only to their state, not to the active sub-view: after a failed `table.rows` load (or a row mutation error) the red "could not load rows / retry" banner and the amber mutation banner kept rendering in `TableTabView` even once the user switched to the `indexes` sub-view, floating a contextually-wrong rows error over an otherwise-correct `IndexList` (and offering a retry that re-fetches rows the user isn't looking at). Fixed by gating both banners behind `view === "rows"` so they only surface in the rows sub-view; the underlying `error`/`mutationError` state is preserved, so the banner reappears intact when the user toggles back to rows. (`src/ui/workspace/TabContent.tsx`.)
- rejected (13): index-shape concerns the intent contract explicitly defers — Postgres INCLUDE/covering columns rendered as key columns, expression columns dropped from mixed composite indexes, pure-expression / MySQL functional-only indexes omitted entirely, and a repeated-column (`t(a, a)`) index collapsing to one entry; the dialect introspection SQL (`pg_index` join, `information_schema.statistics`) not being unit-tested (matches the codebase's pre-existing driver convention — only `assembleSchema` folding is unit-tested; raw dialect SQL needs a live engine, per the spec's "Manual checks if no live DB"); post-DDL / `CREATE INDEX` staleness of the index view (a pre-existing by-design property of the connect-time memoized schema cache, identical for columns/tables/PKs — not caused by this story); invalid/in-progress Postgres indexes (`indisvalid = false`) shown as real (index-validity metadata is out of the "name + ordered columns + unique" surface, same bucket as method/partial-predicate deferrals); the doc comment describing wire ordering as "mirrors the live DB" being imprecise for index grouping (indexes sort by name); the intentional "0 indexes" empty-state header row; the `unique` column rendering an empty cell for non-unique indexes (cosmetic); the MySQL `non_unique: number` row-type annotation coexisting with a defensive `Number()` coercion (not a bug); and the index list not paginating (bounded schema metadata, not a live result set).

## Design Notes

- **Why eager (Option A), not a lazy `table.indexes` RPC.** Index metadata is small, bounded schema data — not a live result set — so the epic's "Core never ships a whole live result set" / large-result concern does not apply. The UI already holds the bound table's `SchemaTableInfo` (via the `allTables`/`primaryKeys` lookup), so reading `.indexes` needs no round-trip, no new RPC handler, no new `RpcContext` capability, and no new guard surface. This mirrors exactly how `primaryKey` was added. Trade-off: the `connect` payload grows by per-table index rows — the same magnitude and one-time startup cost as the existing column/PK introspection; acceptable and precedented.
- **Introspection SQL guidance (lives only in the drivers).**
  - Postgres — join `pg_index ix` → `pg_class i` (index), `pg_class t` (table), `pg_namespace n`, `pg_attribute a` (`a.attnum = ANY(ix.indkey)`), ordering columns by their position in `ix.indkey` (e.g. `array_position(ix.indkey::int[], a.attnum)`), selecting `ix.indisunique`. Exclude `pg_catalog`/`information_schema`. Expression indexes (`attnum = 0`) are out of scope — omit those columns.
  - MySQL — `SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.statistics` with the same db/system-schema scoping as the column query, `ORDER BY … INDEX_NAME, SEQ_IN_INDEX`; `unique = (NON_UNIQUE = 0)`.
  - Both fold flat rows into grouped `SchemaIndexInfo[]` in the assembler, exactly like PK folding.
- **PK-backing index appears in the list.** Both engines expose the primary key as a real unique index (`<table>_pkey`, `PRIMARY`). Showing it is correct — the feature is "view a table's indexes," which includes the PK's index. No special-casing.
- **UI home: a sub-view toggle, not a new tab-kind or rail panel.** Indexes are table-scoped, so they belong beside the rows they describe, reusing the already-bound table identity and remount-on-switch (`TableTabView key={schema.name}`). A new tab-kind would needlessly touch `WORKSPACE_TAB_KINDS`/persistence; a rail panel is wrong because it is global, not table-scoped.
- **Optimistic 3.4 tables get `indexes: []`.** A table created this session is appended optimistically (no re-introspection possible against the memoized cache); it shows "0 indexes" until a fresh process reconnects and introspects the real indexes — consistent with Story 3.4's documented optimistic-append behavior.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors across the contract, drivers, and edited UI components (the new required `indexes` field is populated everywhere a `SchemaTableInfo` is constructed, including `synthesizeSchemaTable`).
- `bun test` -- expected: all suites pass, including the new index-folding tests (`driver.test.ts`) and `IndexList` render tests.

**Manual checks (if no live DB):**
- Confirm each driver's `listSchema()` result includes an `indexes` array per table with grouped `{name, columns (ordered), unique}` entries, and that `assembleSchema` groups multi-column indexes in index order.
- Confirm the `rows | indexes` toggle swaps `DataGrid` ↔ `IndexList` with no `rpc` call for the index view, and that an index-less table renders "0 indexes".

## Auto Run Result

Status: done

**Implemented change:** Added "inspect indexes" as a cross-layer feature following the existing `primaryKey` introspection precedent. The wire contract gains a `SchemaIndexInfo {name, columns, unique}` type and a required `indexes` field on `SchemaTableInfo`. Each engine driver introspects index metadata eagerly at connect time inside `listSchema()` — Postgres via `pg_index`/`pg_class`/`pg_namespace`/`pg_attribute` (columns ordered by `indkey` position, `indisunique` for uniqueness), MySQL via `information_schema.statistics` (`SEQ_IN_INDEX` order, `NON_UNIQUE = 0` for uniqueness) — folded in `assembleSchema` exactly as PK columns are, and rides inside the already-memoized `connect` payload (no new RPC, no new `Driver` method, no change to the Story 3.1 executor/guard). The UI reads the active table's `indexes` from the resolved `SchemaTableInfo` (threaded from `App` alongside `primaryKeys`) and renders a read-only `rows | indexes` sub-view toggle in `TableTabView` via a new presentational `IndexList` — no fetch, no SQL. The PK-backing index appears in the list marked unique.

**Files changed:**
- `src/shared/contract.ts` — `SchemaIndexInfo` + required `indexes` field on `SchemaTableInfo`; updated the stale "PK is the only constraint introspected" comment.
- `src/core/driver.ts` — `IntrospectedIndex` type; `assembleSchema` folds index rows grouped by index name preserving column order; the fold guard (indexes only decorate tables produced by column introspection).
- `src/core/driver-postgres.ts` — `pg_index`-based index introspection query (scoped to exclude all `pg_*` system schemas).
- `src/core/driver-mysql.ts` — `information_schema.statistics` index query (`column_name IS NOT NULL`, `unique = NON_UNIQUE = 0`).
- `src/core/driver.test.ts` — index-folding unit tests (grouping, column order, uniqueness, PK-index inclusion, empty case, phantom-table guard).
- `src/ui/data/IndexList.tsx` (new) + `src/ui/data/IndexList.test.tsx` (new) — read-only index list (sticky mono header, `⚿`/`--t-key` unique marker, "0 indexes" empty state) + render tests.
- `src/ui/workspace/TabContent.tsx` — `rows | indexes` toggle in `TableTabView` + body branch (`IndexList` vs `DataGrid`).
- `src/ui/App.tsx` — resolves the active table's `indexes` alongside `primaryKeys`; `src/ui/workspace/Workspace.tsx` — threads it to `TabContent`.
- `src/ui/schema/create-table.ts` — `synthesizeSchemaTable` emits `indexes: []` (Story 3.4 optimistic append stays type-correct).
- Test fixtures updated with the new required `indexes: []` field (`connection.test.ts`, `executor.test.ts`, `server.test.ts`, `table-rows.test.ts`, `create-table.test.ts`).

**Review findings breakdown:** 2 patches applied (1 high, 1 medium) — the Postgres phantom-table bug (pg_toast/matview indexes materializing column-less tables, fixed via a fold-layer guard + system-schema SQL scoping + regression test) and the MySQL functional-index NULL column (fixed via a `column_name IS NOT NULL` filter). 4 rejected (INCLUDE/covering columns and expression columns — both spec-deferred out-of-scope index shapes; the intentional "0 indexes" empty-state header; a pathological duplicate-column-in-index). 0 intent_gap, 0 bad_spec, 0 deferred. `followup_review_recommended: true` — the high-severity fix changes shared introspection/fold logic used by the column and PK paths too, so an independent pass is worthwhile.

**Verification:** `bunx tsc --noEmit` → clean (exit 0). `bun test` → 565 pass, 0 fail (30 files, 1353 expects), including the new index-folding and `IndexList` tests. The `[rpc] handler … threw` lines are pre-existing expected negative-path diagnostics, not failures.

**Residual risks:** Advanced Postgres index shapes are intentionally out of scope (per the intent contract): expression/functional index parts are omitted (a mixed key + expression index shows only its plain columns; an expression-only index does not appear), and covering (`INCLUDE`) columns render as ordinary indexed columns rather than being distinguished. On MySQL, functional-index parts are dropped entirely. Index metadata is introspected eagerly, so on a schema with very many tables the `connect` payload grows proportionally (same one-time cost as the existing column/PK introspection). Optimistically-created tables (Story 3.4) show "0 indexes" until the next reconnect. Implementation hygiene note: the Story-3.5 refactor of `assembleSchema` had drifted the grouping-key separator from the codebase's pre-existing NUL convention to a space; this was restored to NUL so the diff stays purely additive and out-of-scope pre-existing behavior is unchanged.

---

### Follow-up review pass (2026-07-11)

A fresh independent review pass (Blind Hunter + Edge Case Hunter, Opus-capability, no prior context) was run against the full since-baseline diff. Outcome: **1 patch applied (medium), 0 intent_gap, 0 bad_spec, 0 deferred, 13 rejected.**

**Patch applied:** The `rows | indexes` sub-view toggle left the rows-path feedback banners (the red page-load `error`/retry banner and the amber `mutationError`/dismiss banner) rendering purely on their state, independent of the active sub-view. So after a failed `table.rows` load or a row-mutation error, switching to the `indexes` sub-view left a contextually-wrong rows error floating over an otherwise-correct `IndexList`, with a retry that would re-fetch rows the user isn't viewing. Fixed by gating both banners behind `view === "rows"` in `src/ui/workspace/TabContent.tsx`; the `error`/`mutationError` state is preserved, so the banner reappears intact on toggling back to rows.

**Rejected (13):** All other findings were index-shape concerns the intent contract explicitly defers (Postgres INCLUDE/covering columns as key columns; expression columns dropped from mixed indexes; pure-expression / MySQL functional-only indexes omitted; repeated-column `t(a,a)` collapse), the dialect SQL lacking unit tests (consistent with the codebase's pre-existing driver convention — only `assembleSchema` folding is unit-tested; raw dialect SQL needs a live engine), post-DDL staleness of the index view (a pre-existing by-design property of the connect-time memoized schema cache, shared by columns/tables/PKs), invalid Postgres indexes (`indisvalid = false`) shown as real (validity metadata is outside the name/columns/unique surface), and several doc-comment/cosmetic/type-annotation nits.

**Verification (follow-up):** `bunx tsc --noEmit` → clean (exit 0). `bun test` → 565 pass, 0 fail (30 files, 1353 expects). The `[rpc] handler … threw` lines are pre-existing expected negative-path diagnostics, not failures.

**Follow-up recommendation:** `false` — this pass made a single localized, low-consequence UI fix (banner visibility gated on sub-view); no shared/introspection logic, API, data, or security surface was touched. No further independent review is warranted.
