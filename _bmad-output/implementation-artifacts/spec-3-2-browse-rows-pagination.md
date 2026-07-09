---
title: 'Browse table rows with pagination — schema tree, Core-paginated read path, result grid'
type: 'feature'
created: '2026-07-09'
status: 'done'
baseline_revision: 'ceebd2c632145ca59214d43cf925abf6c3c6169e'
final_revision: 'aeb0112a9bea0fcaecb0d305e5d9baf9f2ecb873'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** The UI has a workspace shell (tabs/panels) and the Core can introspect a database's schema, but nothing renders the schema and no table data is ever shown — a developer cannot see a single row. This is the first data-on-screen story and the read foundation the rest of Epic 3 (edit, create, ad-hoc SQL) builds on.

**Approach:** Add a Core-owned, read-only paginated read path — a `Driver.query`/`quoteIdent` seam, primary-key introspection, and a `table.rows` RPC that composes a parameterized, engine-quoted `SELECT ... ORDER BY <pk> LIMIT/OFFSET` and returns exactly one page as `FrozenData` plus a total count. The UI grows a keyboard-operable schema tree in the left region and a result grid: clicking a table loads its first page into the active data tab, names the tab, and offers Prev/Next pagination. The Core never ships a whole live result set. This is NOT a mutation path and does NOT route through the guarded executor (Story 3.1) — it is SELECT-only by construction.

## Boundaries & Constraints

**Always:**
- All engine-specific SQL, identifier quoting, and pagination live only inside the Core drivers behind the uniform `Driver` interface; rings above see one engine-neutral shape for PostgreSQL and MySQL.
- The browse SELECT is composed by the Core only. Table/schema identifiers are validated against the live introspected schema and then rendered via the driver's `quoteIdent`; they are never string-concatenated raw. `LIMIT`/`OFFSET` are Core-computed non-negative integers, validated and clamped, rendered as integer literals — no user-supplied value is ever concatenated into SQL.
- Pagination is deterministic: order by the table's primary-key columns; when a table has no primary key, order by all columns (a total, repeatable order) so pages never overlap or skip rows.
- The Core returns at most one page (`pageSize`, capped at `MAX_PAGE_SIZE`) per `table.rows` call, plus the table's total row count for the pager.
- Every `table.rows` reply is a typed result inside `okReply` or the single `{code,message,detail}` error envelope; the UI branches on `reply.ok` and surfaces `reply.error` in-panel (never console-only).
- Schema-tree table activation is keyboard-operable (`role="button"`, `tabindex=0`, Enter/Space) with a single active/`.on` table at a time; the grid and tree honor the DESIGN.md visual language (mono data, coral accent, type-colored columns, tabular-nums, sticky headers, "0 rows" empty state).

**Block If:**
- The uniform `Driver` interface cannot express row-returning parameterized queries for BOTH postgres.js and mysql2 without leaking engine-specific placeholder syntax above the driver — HALT `blocked`, condition `driver query seam cannot stay engine-neutral`.

**Never:**
- No writes, mutations, DDL, or raw user SQL — that is Stories 3.3/3.4/3.6 and the guarded executor. This story adds no `execute` path and must not be reachable for any non-SELECT statement.
- Do not persist the open table binding across app restart (snapshot round-trip of table refs), do not add saved-connection selection for browse (browse targets the single live boot-time connection), and do not add index/constraint inspection beyond the primary-key column names needed here — all explicitly out of scope.
- Do not ship the whole result set, add client-side full-table sorting/filtering, or fetch more than one page at a time.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Browse first page | `table.rows` `{schema,table,page:1,pageSize:100}`, table exists, 5000 rows | `{data:FrozenData(≤100 rows), page:1, pageSize:100, total:5000}`; rows ordered by PK | No error expected |
| Page past end | `{table, page:999}` on a 30-row table | `{data:FrozenData(0 rows, columns present), page:999, pageSize:100, total:30}` | No error; UI shows "0 rows" and disables Next |
| Empty table | table exists, 0 rows | `{data:FrozenData(0 rows, columns present), total:0}` | No error; grid renders headers + "0 rows" |
| Table not in schema | `{table:"does_not_exist"}` | error | `not_found`, message names the table |
| Bad request params | missing/blank `table`, non-integer `page`/`pageSize`, ambiguous unqualified table across schemas | error | `bad_request` with a specific message |
| Not connected / driver failure | live connection closed or query throws | error | `internal_error`; envelope message is engine-neutral, secrets never logged |
| pageSize over cap | `{pageSize: 100000}` | Clamped to `MAX_PAGE_SIZE`; returned `pageSize` reflects the cap | No error |
| Cell mapping | driver rows contain null, integer, float, boolean, Date, text, and an unknown/other value | `FrozenData` with per-column `type`; cells tagged `null`/`number`/`boolean`/`date`(ISO-UTC)/`string`; unknown → `string` fallback | No error |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- add `TableRowsRequest`/`TableRowsResult`; add `primaryKey: ReadonlyArray<string>` to `SchemaTableInfo`. Reuse existing `FrozenData`, `RpcReply`, error envelope.
- `src/core/driver.ts` -- extend `Driver` with `query(text, params?)` and `quoteIdent(ident)`; add `DriverQueryResult`/`DriverColumn`; thread `isPrimaryKey` through `IntrospectedColumn` + `assembleSchema` to populate `SchemaTableInfo.primaryKey`.
- `src/core/driver-postgres.ts` -- implement `query` (via `sql.unsafe`), `quoteIdent` (double-quote, `"`→`""`); extend introspection to flag primary-key columns.
- `src/core/driver-mysql.ts` -- implement `query` (via `conn.query({sql, rowsAsArray:true}, params)`), `quoteIdent` (backtick, `` ` ``→`` `` ``); extend introspection to flag primary-key columns.
- `src/core/connection.ts` -- add `query(text, params?)`, `quoteIdent(ident)`, and memoized `getSchema()` to `ConnectionManager`, delegating to the live driver and respecting the `closed` latch.
- `src/core/frozen-map.ts` (NEW) -- pure `rowsToFrozenData(columns, rows): FrozenData` mapping driver rows to tagged cells with per-column type inference.
- `src/core/table-rows.ts` (NEW) -- pure page-request validation/normalization + SELECT/COUNT composition helper (table lookup in schema, PK→ORDER BY, page/pageSize clamp, offset math, quoted identifiers, integer-literal LIMIT/OFFSET).
- `src/core/rpc.ts` -- register `table.rows` handler + `tableRows` capability on `RpcContext`; `preformed` for `bad_request`/`not_found`.
- `src/core/server.ts` -- wire the `table.rows` capability from `connectionManager` into `rpcContext`.
- `src/ui/styles/globals.css` -- add the DESIGN.md tokens: coral `accent`/`accent-soft`/`accent-line`, `t-int/t-time/t-bool/t-text/t-key` column colors, mono font stack, `data-cell`/`label` sizes, tree width, focus ring.
- `src/ui/schema/SchemaTree.tsx` (NEW) -- left-region schema tree; fetches schema via the rpc client, renders tables, keyboard-operable single active selection, calls back on table activation.
- `src/ui/data/data-grid-state.ts` (NEW) -- pure pagination + row-selection model (page bounds, `canPrev/canNext`, row range summary, `selectRow`).
- `src/ui/data/DataGrid.tsx` (NEW) -- renders `FrozenData`: sticky mono type-colored headers, PK key icon, single-select rows with inset coral marker, hover tint, tabular-nums, "0 rows" state.
- `src/ui/workspace/workspace-state.ts` -- extend `WorkspaceTab` (table kind carries `{schema,name}` ref; title = table name) + pure action binding a table to the active data tab (reuse active table tab, else open new).
- `src/ui/workspace/TabContent.tsx` -- for `kind:"table"` with a bound table, fetch `table.rows`, manage page state, render `DataGrid` + Prev/Next + "rows X–Y of N"; unbound table tab shows a "select a table" empty state.
- `src/ui/workspace/Workspace.tsx` -- insert the schema tree into the left region (fixed rail + resizable tree) and route table activation into the workspace reducer.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `primaryKey` to `SchemaTableInfo` and `TableRowsRequest = {schema?, table, page?, pageSize?}` / `TableRowsResult = {data: FrozenData, page, pageSize, total}` -- typed wire contract shared by both rings.
- [x] `src/core/driver.ts` -- add `query`/`quoteIdent` to `Driver`, `DriverQueryResult`/`DriverColumn`, and thread `isPrimaryKey` through `IntrospectedColumn`+`assembleSchema` into `SchemaTableInfo.primaryKey` -- the engine-neutral read + PK seam.
- [x] `src/core/driver-postgres.ts` -- implement `query`/`quoteIdent` and PK-flag introspection (join `pg_index`/`information_schema` key columns) -- Postgres dialect.
- [x] `src/core/driver-mysql.ts` -- implement `query`/`quoteIdent` and PK-flag introspection (`information_schema.KEY_COLUMN_USAGE` / `SHOW KEYS`) -- MySQL dialect.
- [x] `src/core/connection.ts` -- add `query`/`quoteIdent`/memoized `getSchema` to `ConnectionManager` respecting the `closed` latch -- live-connection access for browse.
- [x] `src/core/frozen-map.ts` -- pure `rowsToFrozenData` mapping driver rows → tagged `FrozenData` -- unit-test the cell-mapping matrix row (null/number/boolean/Date/string/unknown).
- [x] `src/core/table-rows.ts` -- pure request validation + SELECT/COUNT composition (lookup, PK ordering, clamp, offset, quoting, integer-literal LIMIT/OFFSET) -- unit-test bad_request/not_found/clamp/order-by-fallback edge cases.
- [x] `src/core/rpc.ts` -- register `table.rows` handler + `RpcContext.tableRows`, `preformed` for control errors -- unit-test method dispatch + error tagging with a fake capability.
- [x] `src/core/server.ts` -- build the `table.rows` capability from `connectionManager` and inject it into `rpcContext` -- wire the read path end to end.
- [x] `src/ui/styles/globals.css` -- add coral/`t-*`/mono/`data-cell`/tree/focus tokens from DESIGN.md -- design-token foundation for tree + grid.
- [x] `src/ui/data/data-grid-state.ts` -- pure pagination + selection model -- unit-test page bounds, `canPrev/canNext`, row-range summary ("0 rows" and "rows X–Y of N"), selection.
- [x] `src/ui/data/DataGrid.tsx` -- render `FrozenData` per DESIGN.md (type-colored sticky mono headers, PK key icon, single-select coral marker, hover, tabular-nums, "0 rows") -- thin over the tested state module.
- [x] `src/ui/schema/SchemaTree.tsx` -- keyboard-operable tree fetching schema via `rpc`, single active table, activation callback -- follow the `alive`/`reply.ok`/`envelopeText` client pattern.
- [x] `src/ui/workspace/workspace-state.ts` -- extend `WorkspaceTab` with a table ref + title, and a pure action binding a table to the active data tab (reuse active table tab, else open+activate new) -- unit-test the binding/rename/reuse logic.
- [x] `src/ui/workspace/TabContent.tsx` -- render `DataGrid` + pager for bound table tabs (fetch `table.rows`, page state, loading/error), "select a table" for unbound -- one active table shown at a time.
- [x] `src/ui/workspace/Workspace.tsx` -- add the schema tree to the left region and route table activation through the reducer -- assemble the browse flow.

**Acceptance Criteria:**
- Given a connected database with tables, when the workspace loads, then the left region renders a keyboard-operable schema tree listing the live tables (mono, one active at a time).
- Given the schema tree, when a table is activated by click or Enter/Space, then its first page loads into the active data tab, the tab is named after the table, and exactly that table shows as active (`.on`).
- Given a table with more rows than one page, when Next/Prev is used, then the grid shows the correct contiguous page with no overlapped or skipped rows across pages, and the pager reads "rows X–Y of N"; Prev is disabled on page 1 and Next is disabled on the last page.
- Given a table with zero rows (or a page past the end), when it loads, then the grid renders its column headers and reads "0 rows" with no error.
- Given the browse path, when any `table.rows` request is issued, then the Core composes a parameterized, engine-quoted SELECT with integer-literal LIMIT/OFFSET, returns at most `MAX_PAGE_SIZE` rows plus the total, and never returns a mutating statement result.
- Given a `table.rows` failure (unknown table, bad params, disconnected), when it returns, then the UI shows the error envelope message in-panel and the app stays responsive.

## Spec Change Log

_No bad_spec loopback triggered — intent contract and spec body held through review._

## Review Triage Log

### 2026-07-09 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 4
- reject: 3
- addressed_findings:
  - `[medium]` `[patch]` Unbounded `page` produced a malformed `OFFSET` (scientific-notation / `Infinity`) → the directly-callable `table.rows` planner now bounds `page`/`offset` to the safe-integer range and rejects out-of-range as `bad_request`.
  - `[medium]` `[patch]` Keyless table with an unorderable column type (jsonb/json/xml) was un-browsable (Postgres "no ordering operator" on `ORDER BY <jsonb>`) → the no-PK fallback now orders only by orderable columns, omitting `ORDER BY` when none remain.
  - `[medium]` `[patch]` `rowsToFrozenData` threw on an invalid `Date` (e.g. MySQL `0000-00-00`), failing the whole page with `internal_error` → invalid Dates now coerce to their string form; frozen-map is total (never-throwing) again.
  - `[low]` `[patch]` Buffer/BLOB cells were `JSON.stringify`-ed into giant `{type:"Buffer",data:[…]}` payloads → now rendered as a compact `\x…(N bytes)` placeholder.
  - `[low]` `[patch]` `readTotal` lost precision for a COUNT above 2^53 → clamped via `Number.isSafeInteger`.
  - `[low]` `[patch]` Stale error banner persisted across table switches → error is reset on table change.
  - `[low]` `[patch]` Stale pager (grid page/total) briefly described the previous table during a switch → grid state is reset on table change.
  - `[low]` `[patch]` A redundant wasted `table.rows` RPC fired with the previous page on table switch → per-table state resets so only one fetch fires.
  - `[low]` `[patch]` Duplicated `envelopeText` helper across two UI components → extracted to a shared module.

### 2026-07-09 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 1, low 0)
- defer: 3
- reject: 10
- addressed_findings:
  - `[medium]` `[patch]` A `table.rows` fetch that failed on a page > 1 froze the pager: `grid` kept the last successful page so Next computed the already-set page (a no-op refetch) and Prev was disabled, leaving no in-tab recovery (only a tab switch/remount escaped) → added a "retry" affordance to the error banner (re-fires the fetch for the current page via a reload nonce) and disabled Prev/Next while an error is shown, so the pager is never a dead end.

## Design Notes

- **Why a dedicated read path, not the guarded executor:** browsing is SELECT-only and never mutates, so routing it through the Story 3.1 classifier would add risk-gating with nothing to gate. Safety here comes from construction: the Core composes the only SQL, identifiers are schema-validated + `quoteIdent`-quoted, and pagination bounds are validated integers. The generic `Driver.query`/`quoteIdent` seam added here is the same plumbing the executor will later reuse — build it read-only-clean now.
- **Deterministic pagination:** ORDER BY the primary key (indexed, cheap, unique) is both the correct page key and the source of the grid's PK key icon — one introspection addition serves both. No-PK fallback orders by all columns for a repeatable sequence (accept the sort cost for the rarer keyless case).
- **Engine placeholders stay in the driver:** postgres.js uses `$n` and mysql2 uses `?`; the browse SELECT sidesteps this by carrying no bound user values (only quoted identifiers + integer literals). `Driver.query(text, params?)` keeps `params` for the future raw path but browse passes none.
- **Column color mapping:** map neutral `FrozenColumn.type` → `t-*` (number→`t-int`, date→`t-time`, boolean→`t-bool`, string→`t-text`). Distinguishing `t-json` from text needs the SQL type and is deferred.
- Suggested constants: `DEFAULT_PAGE_SIZE = 100`, `MAX_PAGE_SIZE = 200` (Core-owned; the dev may tune within reason).

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors across contract, Core, and UI changes.
- `bun test` -- expected: all suites pass, including new `frozen-map`, `table-rows`, `data-grid-state`, and `workspace-state` tests; the frozen-map cell-mapping and pagination edge cases are covered.

**Manual checks (if no CLI):**
- With a seeded database, launch the app, click a large table in the tree, and confirm: first page paints, Prev/Next move through contiguous pages, "rows X–Y of N" is correct, an empty table shows "0 rows", and PK columns show the key icon with type-colored mono headers.

## Auto Run Result

Status: done

**Summary:** Delivered the first data-on-screen slice of Epic 3 — a read-only, Core-paginated browse path. Added a `Driver.query`/`quoteIdent` seam plus primary-key introspection to the engine-neutral driver (PostgreSQL + MySQL), a pure `table.rows` page planner that composes a schema-validated, engine-quoted `SELECT … ORDER BY <pk|orderable-cols> LIMIT/OFFSET` with a `COUNT(*)` total (integer-literal bounds, no user value ever concatenated, SELECT-only by construction — it does NOT route through the Story 3.1 guarded executor), and a `table.rows` RPC wired through `ConnectionManager`. On the UI: a keyboard-operable schema tree, a `FrozenData` result grid (type-colored sticky mono headers, PK key icon, single-select coral marker, tabular-nums, "0 rows" state), a Prev/Next pager ("rows X–Y of N"), the design-token set (coral + `t-*` + mono) added to `globals.css`, and a table-ref extension to the workspace tab model that names the tab after the browsed table.

**Files changed (one-line):**
- `src/shared/contract.ts` — `primaryKey` on `SchemaTableInfo`; `TableRowsRequest`/`TableRowsResult`.
- `src/core/driver.ts` — `query`/`quoteIdent` on `Driver`, `DriverQueryResult`/`DriverColumn`, PK flag threaded through `assembleSchema`.
- `src/core/driver-postgres.ts` / `src/core/driver-mysql.ts` — `query`, `quoteIdent`, and PK introspection per engine.
- `src/core/connection.ts` — `query`/`quoteIdent`/memoized `getSchema` on `ConnectionManager`.
- `src/core/frozen-map.ts` (new) — total driver-rows → `FrozenData` mapper (invalid-Date + binary guards).
- `src/core/table-rows.ts` (new) — pure, safety-critical page planner (`planTableRows`, `readTotal`).
- `src/core/rpc.ts` / `src/core/server.ts` — `table.rows` handler + capability wiring.
- `src/ui/styles/globals.css` — coral/`t-*`/mono/`data-cell`/tree/focus tokens.
- `src/ui/schema/SchemaTree.tsx` (new), `src/ui/data/DataGrid.tsx` (new), `src/ui/data/data-grid-state.ts` (new) — tree, grid, pure pager/selection model.
- `src/ui/workspace/{workspace-state.ts,TabContent.tsx,Workspace.tsx}` + `src/ui/App.tsx` — table-ref tab model, grid render + pager, tree wiring.
- `src/ui/rpc/envelope-text.ts` (new) — shared error-envelope formatter.
- Tests: `frozen-map.test.ts`, `table-rows.test.ts`, `data-grid-state.test.ts` (new) + extended `connection/rpc/server/workspace-state` tests.

**Review findings breakdown:** 2 adversarial reviewers (Blind Hunter + Edge Case Hunter). Triage: 0 intent_gap, 0 bad_spec, **9 patches applied** (3 medium, 6 low), **4 deferred**, 3 rejected. Patches: page/offset bounded to the safe-integer range (`bad_request` on overflow); keyless `ORDER BY` skips unorderable types (jsonb/xml/…) and is omitted when none remain (jsonb tables were un-browsable); `rowsToFrozenData` made total against invalid Dates (MySQL `0000-00-00`) and binary blobs; `readTotal` precision clamp; stale error-banner/pager reset + single-fetch on table switch (component remount); shared `envelopeText`. Deferred to `deferred-work.md`: PG duplicate-column projection in the shared read seam, SQL-`dataType`-aware numeric column typing (with `t-json`), composite-PK ordinal ordering, and non-atomic COUNT/SELECT pagination drift.

**Verification:** `bunx tsc --noEmit` → clean (exit 0). `bun test` → 427 pass / 0 fail (26 files, 1057 expects). `bun run build` → OK. Manual DB-driven browse check not run (unattended; no seeded DB/browser on this box) — covered behaviorally by the pure-module unit tests.

**Residual risks:** Grid interaction is verified via the pure state modules only (no React component-test harness in this repo, by project convention) — the tree/grid/pager `.tsx` rendering is unexercised by automated tests. The deferred items are latent (future raw-SQL/edit stories, or narrow exotic-type/precision/timezone edges), not active browse defects.

### Follow-up review pass — 2026-07-09

An independent follow-up review (Blind Hunter + Edge Case Hunter, same model capability, diff `ceebd2c..HEAD`) re-examined the browse path. The safety architecture held: identifiers are resolved out of the live schema and `quoteIdent`-quoted, `LIMIT`/`OFFSET` are Core-computed integer literals with a safe-integer guard, the cell mapper is total, and the client error envelope does not echo raw exception text. Triage: **0 intent_gap, 0 bad_spec, 1 patch (medium), 3 deferred, 10 rejected.**

- **Patched:** the result-grid pager could dead-end after a failed page->1 fetch — `grid` retained the last successful page, so Next recomputed the already-set page (a no-op) and Prev was disabled, stranding the user with no in-tab recovery until a tab switch remounted the view. Fixed by adding a "retry" control to the error banner (re-fires the fetch for the current page via a reload nonce) and disabling Prev/Next while an error is shown. Localized to `src/ui/workspace/TabContent.tsx`.
- **Deferred (3 new ledger entries):** (1) keyless-table (no-PK) `ORDER BY` robustness — the static orderable-type heuristic can either omit ordering (page overlap/skip) or emit an order the engine rejects (`internal_error`) for exotic column types; (2) `timestamp without time zone` values are stamped UTC (`Z`) by the neutral cell mapper, shifting displayed wall-clock times; (3) MySQL `BIGINT` above 2^53 is decoded to a precision-lossy JS number under mysql2's default numeric handling. All three are latent, narrow, and their fixes are design/contract/driver-config decisions, not mechanical patches.
- **Rejected (10):** items already tracked in the deferred ledger (non-atomic COUNT/SELECT drift, Postgres duplicate-column projection), unreachable-in-practice defensive concerns (empty `result.columns` data-loss, `readTotal` fallbacks, `pageSize<=0`/sci-notation guards), pre-existing/local-single-user surfaces (stderr error logging, schema-name error strings, giant self-inflicted offsets), and already-sound quoting.

**Follow-up verification:** `bunx tsc --noEmit` → clean (exit 0). `bun test` → 427 pass / 0 fail (26 files, 1057 expects). `bun run build` → OK (exit 0). `followup_review_recommended: false` — the single localized UI recovery fix does not warrant a further independent review pass.
