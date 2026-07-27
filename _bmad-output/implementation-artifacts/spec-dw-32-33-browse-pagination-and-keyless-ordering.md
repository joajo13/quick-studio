---
title: 'DW-32/DW-33 — robust keyless-table browse ordering (physical row locator) + non-atomic pagination snapshot note'
type: 'bugfix'
created: '2026-07-24'
status: 'done'
baseline_revision: '10c82c3f9ec8aaf88f8bf262c83a43a4853066ba'
final_revision: '0327c4771fcd2d46506c94c1407a200e1533918a'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['multiple-goals', 'oversized']
---

<intent-contract>

## Intent

**Problem:** `planTableRows` (`src/core/table-rows.ts`) classifies keyless-table ordering with a static type-prefix **denylist** (`UNORDERABLE_TYPE_PREFIXES`). For a no-PK relation it either filters out every column and emits **no `ORDER BY`** — so two page requests can return rows in different physical orders (silent overlap/skip with zero concurrent writes) — or passes a column that only *looks* orderable (Postgres `USER-DEFINED`, `ARRAY`, `record`, `tsvector`, `pg_lsn`; MySQL `geometry` and blob variants the prefix list misses), so the composed `ORDER BY` throws at the engine and the whole page collapses to `internal_error` (DW-33). Separately, `tableRows` (`src/core/server.ts`) issues the COUNT and the page SELECT as two independent round-trips, so `total` and page contents can disagree and OFFSET pages can drift under concurrent writes — accepted as a known limitation, documentation only (DW-32).

**Approach:** Order a keyless relation by a **physical row locator** when the engine and the relation actually have one (Postgres `ctid`), otherwise by the **full set of orderable columns** decided by a conservative per-engine **allowlist** (unknown type ⇒ not orderable), so an `ORDER BY` the engine would reject is never composed. Because Postgres **views are introspected and browsable and never have a PK**, `ctid` may only be used once the relation is known to be physically stored — so introspection gains a neutral `kind` fact (`table` / `view` / `other`), absent ⇒ treated as unknown ⇒ no locator. DW-32 is a comment at the `tableRows` composition site — no code change, no keyset pagination.

## Boundaries & Constraints

**Always:**
- The composed `ORDER BY` must be one the target engine accepts. Orderability is decided by an **allowlist** keyed on `DbEngine`; a `dataType` not in the allowlist is treated as NOT orderable. Never widen a denylist.
- `ctid` is used **only** when `schema.engine === "postgres"` AND the resolved table's `kind === "table"`. Any other engine, any other `kind`, and a missing/unknown `kind` all fall through to the orderable-column ordering.
- Ordering precedence stays: primary key → physical row locator → all orderable columns → omit `ORDER BY`.
- `ctid` is rendered through the injected `quoteIdent`, exactly like every other identifier; it is never projected into the SELECT column list, so `TableRowsResult.data` columns are unchanged.
- All existing safety invariants of `planTableRows` hold verbatim: identifiers come from the live schema match, `LIMIT`/`OFFSET` stay Core-computed validated integer literals, no user value is ever concatenated, the function never throws (typed `PlanError` only).
- The new `SchemaTableInfo.kind` is **optional**; every existing construction site keeps compiling and behaves as "unknown".
- `planTableRows` keeps its current 3-argument signature — engine comes from `schema.engine`, relation kind from the resolved table.

**Block If:**
- Populating relation kind would require a query the driver cannot express without a second round-trip per table (N+1) — HALT `blocked`, condition `relation kind not introspectable in one query`.

**Never:**
- Do NOT implement keyset/seek pagination, a shared snapshot, or a transaction around COUNT+SELECT — the user explicitly deferred it; DW-32 is documentation only.
- Do NOT add a try/catch-and-retry "degrade" path around a failing `ORDER BY` — prevention is by pre-validation, not recovery.
- Do NOT change the `table.rows` wire result shape, the pager, or any UI file.
- Do NOT edit `_bmad-output/implementation-artifacts/deferred-work.md` — the orchestrator records resolution.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PK table (either engine) | table with `primaryKey: ["id"]` | `ORDER BY "id"` — unchanged from today | No error expected |
| Postgres keyless base table | `engine:"postgres"`, `kind:"table"`, no PK, any column types | `ORDER BY <quoted ctid>`; column list unchanged | No error expected |
| Postgres keyless view | `engine:"postgres"`, `kind:"view"`, no PK, columns `id int`, `payload jsonb` | No `ctid`; `ORDER BY "id"` only (jsonb not allowlisted) | No error expected |
| Postgres keyless, kind absent | `engine:"postgres"`, `kind` undefined, no PK | No `ctid`; orderable-column ordering | No error expected |
| Postgres keyless, kind `other` | partitioned/foreign relation, no PK | No `ctid`; orderable-column ordering | No error expected |
| Only exotic columns | keyless view with `USER-DEFINED`, `ARRAY`, `xml`, `record`, `tsvector`, `pg_lsn` | `ORDER BY` omitted entirely — never an order the engine rejects | No error; order is non-total (documented residual) |
| MySQL keyless | `engine:"mysql"`, no PK, columns `id int`, `g geometry` | `ORDER BY \`id\`` only; `ctid` never emitted on MySQL | No error expected |
| Unknown/unlisted type | `dataType` not in the engine allowlist (e.g. a future type) | Column excluded from `ORDER BY` (conservative) | No error expected |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- `SchemaTableInfo`; add `SchemaRelationKind` + optional `kind`.
- `src/core/driver.ts` -- `IntrospectedColumn` (+ optional `relationKind`), `assembleSchema`/`ensureEntry` (`:210-224`) stamp `kind` at table creation.
- `src/core/driver-postgres.ts` -- column introspection query (`:282-287`) + `PgColumnRow` (`:29-36`) + row mapping (`:432`).
- `src/core/driver-mysql.ts` -- column introspection query (`:237-241`) + its row type + mapping (`:328`).
- `src/core/table-rows.ts` -- `UNORDERABLE_TYPE_PREFIXES`/`isOrderable` (`:62-87`) and the ORDER BY composition (`:165-179`); module doc (`:1-17`).
- `src/core/server.ts` -- `tableRows` (`:641-668`) and its doc block (`:625-640`): DW-32 note only.
- `src/core/table-rows.test.ts`, `src/core/driver.test.ts` -- existing suites to extend (`bun:test`, co-located, `test`/`expect`, `{ok}`-narrowing idiom).

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `export type SchemaRelationKind = "table" | "view" | "other"` and `readonly kind?: SchemaRelationKind` to `SchemaTableInfo`, documented as a neutral structural fact ("table" = physically stored, directly scannable relation) -- lets the planner know a `ctid` exists without leaking ordering semantics into the wire contract.
- [x] `src/core/driver.ts` -- add optional `relationKind` to `IntrospectedColumn`; `ensureEntry` accepts it and stamps `SchemaTableInfo.kind` when the table is first created (first column row wins; absent ⇒ field omitted) -- one fold, no new decorator list, order-independent.
- [x] `src/core/driver-postgres.ts` -- `LEFT JOIN pg_catalog.pg_class`/`pg_namespace` on the column query to select `relkind`; map `r`/`m` → `"table"`, `v` → `"view"`, anything else → `"other"`, NULL → omitted -- partitioned (`p`) and foreign (`f`) relations have no usable `ctid` and must not get one.
- [x] `src/core/driver-mysql.ts` -- `LEFT JOIN information_schema.tables` for `table_type`; `BASE TABLE` → `"table"`, `VIEW`/`SYSTEM VIEW` → `"view"`, else → `"other"` -- keeps `kind` honest on both engines even though MySQL has no physical locator.
- [x] `src/core/table-rows.ts` -- replace `UNORDERABLE_TYPE_PREFIXES`/prefix matching with `ORDERABLE_TYPES: Record<DbEngine, ReadonlySet<string>>` matched exactly on `dataType.toLowerCase().trim()` (unknown ⇒ not orderable); add the `ctid` branch gated on `schema.engine === "postgres" && target.kind === "table"`; update the module doc to describe the new precedence and point at the DW-32 snapshot note -- the DW-33 fix.
- [x] `src/core/server.ts` -- extend the `tableRows` doc block: COUNT and page SELECT are two **non-atomic** round-trips with no shared snapshot/transaction, so `total` and the returned page can disagree and OFFSET pages can drift under concurrent writes; accepted as a best-effort snapshot for a local single-user browse tool; keyset pagination deliberately not implemented (DW-32) -- documentation only, zero behavior change.
- [x] `src/core/table-rows.test.ts` -- cover every I/O matrix row: PK unchanged (both engines), pg keyless `kind:"table"` → `ctid`, pg keyless `kind:"view"`/`"other"`/absent → no `ctid`, exotic-only relation → no `ORDER BY` at all, MySQL keyless never emits `ctid`, unknown `dataType` excluded -- these are the regressions the ledger entries describe.
- [x] `src/core/driver.test.ts` -- assert `assembleSchema` stamps `kind` from the first column row of a table and omits it when no `relationKind` is supplied -- the fold is the only place kind reaches the neutral shape.

**Acceptance Criteria:**
- Given a keyless Postgres base table whose every column is of an unorderable type, when a page is planned, then the SELECT orders by `ctid` and pages are contiguous with no overlap or skip (previously: no `ORDER BY`).
- Given a keyless Postgres **view**, when a page is planned, then the composed SQL contains no `ctid` and orders only by allowlisted columns — so browsing views keeps working exactly as before this change.
- Given any keyless relation on either engine, when a page is planned, then every column named in `ORDER BY` is in that engine's orderable allowlist — the planner never composes an `ORDER BY` the engine would reject.
- Given the full suite, when `bunx tsc --noEmit` and `bun test` run, then both are clean and no existing `SchemaTableInfo` construction site required a change (the new field is optional).

## Spec Change Log

## Review Triage Log

### 2026-07-24 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 1
- reject: 13
- addressed_findings:
  - `[low]` `[patch]` The `IntrospectedColumn.relationKind` JSDoc (`driver.ts:107-110`) claimed each adapter reads relation kind with a "single LEFT JOIN", but both adapters deliberately use correlated scalar subqueries — the prior pass replaced the join precisely because a case-insensitive catalog match (MySQL `lower_case_table_names=0`) can multiply/drop column rows and this query gates ALL connect. The doc contradicted the change's central safety invariant and pointed a maintainer straight at reintroducing the join the offline SQL tests exist to catch. Rewrote the comment to describe the scalar subquery, the anti-duplication rationale, and an explicit "do not simplify back to a join" warning.
  - defer (1): keyless-ordering PK branch fires unconditionally, so a Postgres legacy-inheritance parent WITH a PK is ordered by a non-total PK (duplicate PK values across child heaps) — pre-existing (PK-first predates this story) and not trivially patchable (`kind:"other"` cannot distinguish a legacy-inheritance parent from a declarative-partition parent whose PK IS total). Logged as DW-94.

### 2026-07-24 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 5, low 4)
- defer: 4
- reject: 12
- addressed_findings:
  - `[medium]` `[patch]` Postgres legacy inheritance parent (`relkind='r'` + `relhassubclass`) would have been classified `"table"` and ordered by `ctid`, but `SELECT ... FROM parent` scans every child heap so `ctid` is non-unique across the result — non-total order, the exact DW-33 defect. Now reads `relhassubclass` and maps such relations to `"other"` (no locator).
  - `[medium]` `[patch]` The orderable allowlist under-approximated vs the recorded "full set of orderable columns" decision, dropping types that provably ARE orderable and that the old prefix denylist admitted. Added MySQL `json`/`tinyblob`/`blob`/`mediumblob`/`longblob` and Postgres `jsonb`/`oid`/`name` (plain `json` deliberately kept OUT — no ordering operator).
  - `[medium]` `[patch]` Both rewritten column-introspection queries used a LEFT JOIN whose row count depends on catalog-name uniqueness; under MySQL `lower_case_table_names=0` (`Foo`+`foo` in one schema) the case-insensitive I_S collation could match both and duplicate every column row — and this query gates ALL connect, not just browse. Replaced both joins with correlated scalar subqueries (structurally cannot multiply/drop a column row); scope predicate stays unqualified/verbatim, LEFT-JOIN-equivalent NULL semantics preserved.
  - `[medium]` `[patch]` The DW-32 note in `server.ts` overstated the no-writer guarantee ("contiguity guaranteed by deterministic ORDER BY"). Rewrote: contiguity with no writers holds ONLY on the PK and physical-row-locator (total-order) branches; the orderable-column branch is best-effort and the no-`ORDER BY` branch is a documented residual.
  - `[medium]` `[patch]` The riskiest change (the two new introspection queries) had zero test coverage. Added tests pinning both drivers' composed SQL offline (relation-kind scalar selected, scope spliced verbatim/unqualified, exactly one row-producing source) — following the existing `pgSchemaScope` text-assertion precedent, no live DB.
  - `[low]` `[patch]` `pgRelationKind`'s `m`→`"table"` doc claimed matviews are browsable, but `information_schema.columns` lists only `relkind IN ('r','v','f','p')` so `m` never reaches this query. Kept the branch for forward-compat; corrected the comment to state it is currently unreachable.
  - `[low]` `[patch]` `PgColumnRow`'s NULL-`relkind` justification ("relation the catalogs do not expose to this role") was false — `pg_class`/`pg_namespace` are world-readable. Replaced with the honest reason: a defensive fallback so an unmatched relation still yields columns with kind unknown.
  - `[low]` `[patch]` No test pinned the ORDER BY precedence — the only `ctid` test used a relation with no orderable columns, so it couldn't prove the locator WINS. Added a `kind:"table"` + orderable-columns case asserting `ORDER BY [ctid]`; trimmed the redundant `for (const kind of …)` duplication.
  - `[low]` `[patch]` The assembler map key was a raw NUL byte, matching the "NUL-joined" invariant in behavior but stored as an invisible byte (the file read as non-text and the comment was unverifiable). Converted the 6 sites to the `\0` escape so the source visibly matches the documented invariant. (The reviewer's "space separator collides" claim was a NUL-rendered-as-space misread — no behavioral bug existed.)

## Design Notes

- **Why relation kind is required, not gold-plating:** `information_schema.columns` has no `table_type` filter (`driver-postgres.ts:282-287`), so Postgres **views are introspected and browsable today**, and a view never has a primary key. Without the `kind` gate, "keyless ⇒ `ctid`" would emit `ORDER BY "ctid"` on every view and turn every view browse into `internal_error` — precisely the failure the recorded decision forbids. Matviews (`m`) do have a `ctid`; partitioned parents (`p`) and foreign tables (`f`) do not.
- **Allowlist over denylist:** "never emit an `ORDER BY` the engine will reject" is only achievable if the *unknown* case is conservative. A denylist fails open (unknown ⇒ orderable ⇒ possible hard error); an allowlist fails closed (unknown ⇒ skipped ⇒ at worst a weaker order). Suggested Postgres entries: `smallint, integer, bigint, numeric, decimal, real, double precision, money, boolean, character, character varying, text, uuid, date, timestamp without time zone, timestamp with time zone, time without time zone, time with time zone, interval, bytea, inet, cidr, macaddr, macaddr8, bit, bit varying`. MySQL: `tinyint, smallint, mediumint, int, integer, bigint, decimal, numeric, float, double, real, bit, char, varchar, binary, varbinary, tinytext, text, mediumtext, longtext, enum, set, date, datetime, timestamp, time, year`. The dev may adjust within this rationale, never by adding a type that lacks a default ordering operator.
- **Residual, by design:** a keyless *non*-`ctid` relation (a view, a partitioned parent) whose columns are all unorderable still gets no `ORDER BY` and therefore a non-total page order. That is strictly better than today (it can no longer also hard-fail) and cannot be fixed without keyset pagination, which is out of scope.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: exit 0, no type errors (the new `kind` field is optional, so no existing construction site breaks).
- `bun test` -- expected: all suites pass, including the new `table-rows` ordering cases and the `assembleSchema` kind fold; no pre-existing test regresses.
- `bun run build` -- expected: exit 0.

**Manual checks (if no CLI):**
- Inspect the composed SQL in the new tests: a Postgres keyless base table yields `... ORDER BY <quoted ctid> LIMIT n OFFSET m`, a Postgres view yields no `ctid`, and MySQL never yields `ctid`.

## Auto Run Result

Status: done

**Summary:** Resolved DW-33 (keyless-table browse ordering) and documented DW-32 (non-atomic COUNT/SELECT snapshot). Keyless ordering now follows a strict precedence — primary key → physical row locator → all orderable columns → omit `ORDER BY` — and never composes an `ORDER BY` the engine would reject. Orderability moved from a fail-open type-prefix **denylist** to a per-engine, exact-match **allowlist** (unknown type ⇒ not orderable). A keyless *physically stored* Postgres relation now orders by `ctid` (a total order even when no column is orderable), gated on a new neutral `SchemaTableInfo.kind` fact so it can never fire on a view (introspected + browsable, never has a PK — an unguarded "keyless ⇒ ctid" would have turned every view browse into `internal_error`) or on a legacy inheritance parent (whose `ctid` is non-unique across child heaps). DW-32 is a documentation-only note at the `tableRows` composition site — no keyset pagination, no transaction, per the user's explicit deferral.

**Files changed (one-line):**
- `src/shared/contract.ts` — `SchemaRelationKind = "table"|"view"|"other"` + optional `SchemaTableInfo.kind`.
- `src/core/driver.ts` — optional `IntrospectedColumn.relationKind`; `ensureEntry` stamps `kind` on table creation (absent ⇒ omitted).
- `src/core/driver-postgres.ts` — correlated scalar subqueries carry `relkind`+`relhassubclass` on the column query; `pgRelationKind(relkind, hasSubclass)` maps `r`(non-parent)/`m`→table, `v`→view, inheritance parent/else→other.
- `src/core/driver-mysql.ts` — correlated scalar subquery carries `table_type`; `mysqlRelationKind` maps BASE TABLE→table, VIEW/SYSTEM VIEW→view, else→other.
- `src/core/table-rows.ts` — `ORDERABLE_TYPES: Record<DbEngine, ReadonlySet<string>>` (exact match), `PHYSICAL_ROW_LOCATOR="ctid"`, `hasPhysicalRowLocator` gate, new precedence in `planTableRows`; module doc rewritten.
- `src/core/server.ts` — DW-32 snapshot caveat added to the `tableRows` doc block (no behavior change).
- `src/core/table-rows.test.ts`, `src/core/driver.test.ts` — full I/O-matrix coverage + relation-kind fold + composed-introspection-SQL text assertions.

**Review findings breakdown:** 2 adversarial reviewers (Blind Hunter + Edge Case Hunter), diff `10c82c3..HEAD` over `src/`. Triage: 0 intent_gap, 0 bad_spec, **9 patches applied** (5 medium, 4 low), **4 deferred**, 12 rejected. Patches: inheritance-parent → `"other"` (non-unique ctid); allowlist widened to the provably-orderable types the denylist admitted (MySQL json/blob family, Postgres jsonb/oid/name — plain `json` kept out); both introspection queries converted from LEFT JOIN to correlated scalar subqueries (a join could duplicate every column row under `lower_case_table_names=0`, breaking ALL connect); DW-32 note corrected to not overstate the no-writer guarantee; introspection-SQL text now pinned by offline tests; false `m`/NULL-relkind comments corrected; ORDER BY precedence pinned by a test; assembler NUL key made explicit.

**Deferred (4) — for the orchestrator to record in the ledger (not written by this run per invocation):**
1. `source_spec: spec-dw-32-33-browse-pagination-and-keyless-ordering.md` — summary: The new `SchemaTableInfo.kind` fact has no UI/AI consumer, so views are still presented to the user and the LLM as tables. evidence: `src/core/chat.ts serializeTable` describes a view to the model as `table <name>`; `SchemaTree`/`ErdTabView`/`IndexList` render views identically to tables; `src/ui/schema/create-table.ts synthesizeSchemaTable` builds a `SchemaTableInfo` without `kind`. Distinguishing views (e.g. so the assistant does not propose INSERT/UPDATE against one) is a UI/chat change out of this spec's scope.
2. `source_spec: spec-dw-32-33-browse-pagination-and-keyless-ordering.md` — summary: The DW-32 best-effort-snapshot decision is documented only in a Core JSDoc, invisible to the user the decision was about. evidence: The recorded user decision framed `total`/page as a user-facing expectation, but nothing in the pager UI, README, or an in-app note communicates it; a single-statement `COUNT(*) OVER ()` alternative (same-snapshot count+rows, one round-trip, PG + MySQL 8) was never evaluated as a lighter-than-transaction option.
3. `source_spec: spec-dw-32-33-browse-pagination-and-keyless-ordering.md` — summary: The two rewritten introspection queries are exercised only by offline text assertions; no live-engine test confirms they parse/run. evidence: The repo has no integration/e2e harness (no docker/testcontainers wired into `bun test`); a syntax or column-resolution error in the new correlated subqueries would surface only against a real Postgres/MySQL at connect time, and this query gates all introspection, not just browse.
4. `source_spec: spec-dw-32-33-browse-pagination-and-keyless-ordering.md` — summary: The Postgres relation-kind subquery matches catalogs by name (`ns.nspname = c.table_schema`), relying on an unverified implicit cast on the pre-12 servers this driver explicitly supports. evidence: `information_schema` identifier columns are the `sql_identifier` domain — over `name` on PG 12+, over `varchar` on PG ≤ 11 — and the driver already probes pre-12 servers (`pgSupportsConparentid`/DW-42); the `name`↔identifier comparison resolves through an implicit cast that no test pins, and an introspection failure fails the whole connect, not just the `kind` field.

**Verification:** `bunx tsc --noEmit` → exit 0. `bun test` → 1819 pass / 1 skip / 9 fail (10100 expects, 86 files); the 9 failures are the pre-existing `bin/quick-studio-shim.test.ts` `spawn node → ENOENT` baseline (no `node` on PATH in this dev box) — 0 non-shim failures. `bun run build` → exit 0. No live-DB browse check (unattended; no seeded DB/browser) — covered by the pure-module + composed-SQL unit tests.

**Residual risks:** (1) The two new introspection queries are unexercised against a live engine (deferred #3). (2) `ctid` is total within one browse pass but not stable across `VACUUM FULL`/`CLUSTER` — strictly better than the prior "no ORDER BY" and a smaller window than the DW-32 concurrent-write residual. (3) A keyless view/partitioned parent whose columns are all unorderable still gets no `ORDER BY` (non-total order) — the documented, by-design residual, which can only be closed by keyset pagination (out of scope).

---

### Follow-up review pass — 2026-07-24

**Trigger:** `followup_review_recommended: true` from the first pass. Two fresh adversarial reviewers (Blind Hunter + Edge Case Hunter, Opus, no prior context) over the same `10c82c3..b23b802` diff.

**Outcome:** No new correctness-breaking defect; the design still fails closed. Triage: 0 intent_gap, 0 bad_spec, **1 patch applied** (low), **1 deferred** (DW-94), 13 rejected.

- **Patch (low):** `IntrospectedColumn.relationKind` JSDoc (`driver.ts:107-110`) still said each adapter reads relation kind via a "single LEFT JOIN", but the first pass deliberately replaced that join with correlated scalar subqueries (a name-based join can multiply/drop column rows under MySQL `lower_case_table_names=0`, and this query gates ALL connect). The stale doc contradicted the change's central safety invariant and invited reintroducing the exact regression the offline SQL tests guard. Corrected the comment to describe the scalar subquery + anti-duplication rationale + an explicit "do not simplify back to a join" warning.
- **Deferred → DW-94:** the keyless-ordering PK branch fires unconditionally, so a Postgres legacy-inheritance parent WITH a PK is ordered by a non-total PK (duplicate PK values across child heaps). Pre-existing (PK-first predates this story) and not trivially patchable (`kind:"other"` cannot distinguish a legacy-inheritance parent from a declarative-partition parent whose PK IS total), so it needs a contract-widening focused pass.
- **Rejected (13):** MySQL case-collision picks an arbitrary `kind` (only affects the informational field, unused on the MySQL path); allowlist "under-approximates" pg_lsn/enums/arrays (the intent-contract I/O matrix deliberately classifies these as omit-worthy; `USER-DEFINED` cannot be exact-matched); O(columns) correlated subqueries on connect (accepted tradeoff — anti-duplication was correctly prioritized, no profiling evidence of a real problem); `ctid` "total-order" doc nuance (the "no writers" qualifier keeps the claim accurate); COUNT/SELECT transaction wrapping (explicitly forbidden by the intent-contract Never clause; the `COUNT(*) OVER ()` alternative is already deferred from pass 1); brittle source-text SQL assertions (accepted repo precedent); `space→\0` key "behavioral fix" (misread — the key is NUL before and after, already adjudicated in pass 1); intended `bytea`/`jsonb` behavior change (the point of the story); plus assorted nits (dead `decimal`/`SYSTEM VIEW`/first-row-wins arms, all harmless/unreachable).

**Verification (follow-up):** `bunx tsc --noEmit` → exit 0. `bun test` → 1819 pass / 1 skip / 9 fail — the 9 are the pre-existing `bin/quick-studio-shim.test.ts` `spawn node → ENOENT` baseline (no `node` on PATH), 0 non-shim failures. `bun run build` → exit 0. The only code change this pass is a JSDoc comment, so no behavior changed.

**Follow-up recommendation:** `false` — this pass made a single localized, low-consequence doc-comment fix; no further independent review warranted.
