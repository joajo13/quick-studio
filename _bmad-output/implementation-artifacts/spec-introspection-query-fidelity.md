---
title: 'Introspection query fidelity: PK key-order + partition-FK dedup'
type: 'bugfix'
created: '2026-07-18'
status: 'done'
review_loop_iteration: 0
baseline_revision: '2c0fc3cbcf025356918826d73a7132339c37bf74'
final_revision: 'bb7bdd92886778a1e95a5726b94e6ae050560f88'
followup_review_recommended: false
context: []
warnings: [multiple-goals]
---

<intent-contract>

## Intent

**Problem:** Two schema-introspection fidelity gaps in the driver layer. (DW-31) `SchemaTableInfo.primaryKey` is reported in table-column order, not the key's own ordinal order, so a composite PK `(b, a)` with `a` earlier in the table is misreported as `["a","b"]` — wrong once a consumer relies on PK column order (row-edit where-clause). (DW-42) The Postgres FK introspection filters only `contype = 'f'`, so on a partitioned parent every partition's inherited copy of the FK yields a duplicate near-identical ERD edge.

**Approach:** (DW-31) Introspect PK columns as an ordered flat list (each PK query ordered by the key's own `ordinal_position` within the constraint) and fold `primaryKey` in that arrival order — mirroring the existing index/FK folding — instead of flagging columns via an order-losing membership Set. (DW-42) Add `AND con.conparentid = 0` to the Postgres FK query to drop inherited partition constraints, gated behind a PG-version check because `pg_constraint.conparentid` exists only on PG 11+.

## Boundaries & Constraints

**Always:** PK column order in `primaryKey` mirrors the key's own ordinal order (Postgres `key_column_usage.ordinal_position`, MySQL `key_column_usage.ordinal_position`). PK/FK/index rows only DECORATE tables already produced by the column query — never materialize a phantom table. Keep every existing introspection guarantee: system-schema exclusion, db-scoping, composite grouping, `withTimeout` bound (DW-20), classified-failure exit (DW-19). The `conparentid` filter must never reference the column on a server that lacks it (no parse error on PG ≤ 10).

**Block If:** the project must support PostgreSQL versions below 11 in a way that forbids the `conparentid` clause even behind a runtime version guard (the guard already degrades to today's behavior on PG ≤ 10, so this should not trigger).

**Never:** Do not change `primaryKey` *membership* (the set of PK columns) — only its order. Do not touch pagination/browse ORDER-BY totality, the ERD PK marker (membership-derived, order-independent), MySQL FK introspection, or the neutral error taxonomy. Do not add a `permission`/version field to the public contract. No live-DB integration harness.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Composite PK, key order ≠ column order | columns `[a, b]`; PK rows arrive in key order `[b, a]` | `table.primaryKey === ["b", "a"]` | No error expected |
| Single-column PK | one PK row `id` | `primaryKey === ["id"]`; membership unchanged | No error expected |
| No PK | no PK rows for table | `primaryKey === []` | No error expected |
| PK row for unknown table | PK row whose table absent from column list | dropped, no phantom table | No error expected |
| PG FK on partitioned parent (PG 11+) | inherited FK copies carry `conparentid <> 0` | only the parent-defined FK survives (one edge) | No error expected |
| PG server ≤ 10 | `server_version_num < 110000` | FK query omits the `conparentid` clause; runs exactly as today | No parse error |

</intent-contract>

## Code Map

- `src/core/driver.ts` -- `IntrospectedColumn` (drop `isPrimaryKey`), new `IntrospectedPrimaryKey` type, `assembleSchema` (new ordered-PK param + fold loop).
- `src/core/driver-postgres.ts` -- PK query `ORDER BY`, ordered-PK mapping, remove `pkSet`/`pkKey`/`isPrimaryKey`; FK query version-gated `conparentid` filter + `pgSupportsConparentid` helper.
- `src/core/driver-mysql.ts` -- PK query `ORDER BY`, ordered-PK mapping, remove `pkSet`/`pkKey`/`isPrimaryKey`.
- `src/shared/contract.ts` -- `SchemaTableInfo.primaryKey` doc: "column order" → "key order".
- `src/core/driver.test.ts` -- new PK key-order/membership fold tests; `pgSupportsConparentid` boundary test.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/driver.ts` -- Remove `isPrimaryKey?` from `IntrospectedColumn`; add `IntrospectedPrimaryKey { schema; table; column }` (pre-ordered by key position); add 5th optional param `primaryKeys: readonly IntrospectedPrimaryKey[] = []` to `assembleSchema`; drop the `col.isPrimaryKey` push in the columns loop; add a PK-fold loop that pushes each PK row's column into `entry.pk` in arrival order, guarded (skip rows whose table is absent) exactly like the FK/index folds. -- Preserves key order via arrival order, one fold idiom.
- [x] `src/core/driver-postgres.ts` -- Add `ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position` to the PK query; map `pkRows` → `IntrospectedPrimaryKey[]` and pass to `assembleSchema`; delete `pkSet`, the `pkKey` helper, and the `isPrimaryKey` field from the column mapper. Add exported pure `pgSupportsConparentid(serverVersionNum: number): boolean` (`>= 110000`); before the FK query read `current_setting('server_version_num')::int`; interpolate a `sql` fragment (`AND con.conparentid = 0` when supported, empty `sql\`\`` otherwise) into the FK `WHERE`; update the FK comment. -- Key-order PK + partition-FK dedup, guarded.
- [x] `src/core/driver-mysql.ts` -- Add `ORDER BY table_schema, table_name, ordinal_position` to the PK query; map `pkRows` → `IntrospectedPrimaryKey[]`; delete `pkSet`, the `pkKey` helper, and the `isPrimaryKey` field from the column mapper. -- Key-order PK (MySQL has no partition-FK issue).
- [x] `src/shared/contract.ts` -- Update the `SchemaTableInfo.primaryKey` doc comment from "in column order" to "in key order (the PK's own column ordinal order)". -- Truthful contract.
- [x] `src/core/driver.test.ts` -- Add `assembleSchema` PK-fold tests (composite key order `[b,a]`; single-column; no-PK empty; PK row for absent table dropped) and a `pgSupportsConparentid` boundary test (100000→false, 110000→true, 160001→true). -- Cover the I/O matrix.

**Acceptance Criteria:**
- Given a composite PK whose key order differs from table-column order, when the schema is assembled, then `primaryKey` lists the columns in the PK's own ordinal order.
- Given the PK column *set* is unchanged, when consumers check membership (ERD marker, pagination key), then behavior is identical to before (only order changed).
- Given a partitioned Postgres parent on PG 11+, when the ERD renders, then each foreign key appears once (inherited partition copies excluded).
- Given a Postgres server at version ≤ 10, when `listSchema` runs, then the FK query omits the `conparentid` clause and introspection succeeds without a parse error.
- Given the full change, when `bun test` and typecheck run, then all pass with no `isPrimaryKey`/`pkSet`/`pkKey` references left in the driver adapters.

## Spec Change Log

## Review Triage Log

### 2026-07-18 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 0, low 2)
- defer: 0
- reject: 6
- addressed_findings:
  - `[low]` `[patch]` Stale "4 introspection queries" comment — Postgres now issues 5 (added the `server_version_num` probe). Updated `driver-postgres.ts` `listSchema` comment and the `INTROSPECTION_TIMEOUT_MS` JSDoc in `driver.ts` (four on MySQL, five on Postgres).
  - `[low]` `[patch]` Local `server_version_num` broke the file's camelCase convention — renamed to `serverVersionNum` (SQL alias / row-type property unchanged).
  - Rejected (noise or specified behavior): PK fold not verifying column-in-columns (concurrent-DDL-only, matches existing FK/index table-only guard); partition-leaf FKs excluded (the DW-42 spec'd behavior); composite-PK pagination order shift (the intended DW-31 consequence, totality preserved, suite green); extra version round-trip (once-per-connect, imperceptible); no string-level SQL-composition test (accepted gap per Verification, no live-DB harness); PK-via-information_schema vs FK-via-catalog asymmetry (pre-existing, not introduced here).

## Design Notes

Why the DW-31 note's "just add ORDER BY" is necessary-but-insufficient: today `primaryKey` is built inside the columns loop gated by a membership `Set`, so it always comes out in *column* order regardless of how the PK query is ordered. The fix must both order the PK query by the key's ordinal AND carry that order into the fold — hence the dedicated ordered `IntrospectedPrimaryKey` rows, identical in shape to the existing FK/index folding. `isPrimaryKey` on `IntrospectedColumn` had exactly one consumer (this fold) and becomes dead, so it is removed; the UI's `ErdColumn.isPrimaryKey` is a *different* type derived from `primaryKey` membership and is untouched.

DW-42 guard shape (postgres.js fragment composition):
```ts
const [{ server_version_num }] = await sql`
  SELECT current_setting('server_version_num')::int AS server_version_num`;
const partitionFilter = pgSupportsConparentid(server_version_num)
  ? sql`AND con.conparentid = 0`   // PG 11+: drop inherited partition FK copies
  : sql``;                          // PG <= 10: column absent, behave as today
// ... WHERE con.contype = 'f' ${partitionFilter} AND con_ns.nspname !~ '^pg_' ...
```
The version gate is required because a bare `con.conparentid` reference fails to *parse* on PG ≤ 10 — a runtime `CASE` cannot rescue a parse error, so the column must be omitted from the SQL text entirely on old servers.

## Verification

**Commands:**
- `bun test src/core/driver.test.ts` -- expected: all pass, including the new PK-order and `pgSupportsConparentid` tests.
- `bun test` -- expected: full suite green (no regression in ERD/erd-graph, table-rows, executor, chat, connection).
- `bunx tsc --noEmit` (or the project's typecheck script) -- expected: no type errors; confirms no dangling `isPrimaryKey`/`pkKey` references.

**Manual checks (if no CLI):**
- DW-42's actual partition-FK exclusion needs a live partitioned Postgres, which this repo has no harness for; confirm by inspection that the FK `WHERE` emits `AND con.conparentid = 0` only when `server_version_num >= 110000`, plus the passing `pgSupportsConparentid` boundary test.

## Auto Run Result

Status: done — DW-31 and DW-42 implemented, reviewed (Blind Hunter + Edge Case Hunter), and 2 low-severity patches applied.

**Change summary:**
- DW-31 — `primaryKey` is now reported in the key's own ordinal order. PK columns are introspected as an ordered flat list (`IntrospectedPrimaryKey`) — each PK query ordered by the key's `ordinal_position` within the constraint — and folded in arrival order, mirroring the existing index/FK folding. The order-losing membership `Set`/`isPrimaryKey` flag path was removed. Membership (ERD PK marker, pagination key set) is unchanged; only column order within a composite PK changed.
- DW-42 — the Postgres FK introspection now drops inherited partition FK copies via `AND con.conparentid = 0`, interpolated as a `sql` fragment only when `server_version_num >= 110000` (empty fragment otherwise, so PG ≤ 10 never emits the column and cannot parse-error).

**Files changed:**
- `src/core/driver.ts` — dropped `IntrospectedColumn.isPrimaryKey`; added `IntrospectedPrimaryKey`; `assembleSchema` gained a 5th `primaryKeys` param + arrival-order PK fold; updated `INTROSPECTION_TIMEOUT_MS` JSDoc query count.
- `src/core/driver-postgres.ts` — PK query `ORDER BY … kcu.ordinal_position`; ordered-PK mapping; removed `pkSet`/`pkKey`/`isPrimaryKey`; added `pgSupportsConparentid` helper + version-gated `conparentid` FK filter; comment fixes; `serverVersionNum` rename.
- `src/core/driver-mysql.ts` — PK query `ORDER BY … ordinal_position`; ordered-PK mapping; removed `pkSet`/`pkKey`/`isPrimaryKey`.
- `src/shared/contract.ts` — `SchemaTableInfo.primaryKey` doc: "column order" → "key order".
- `src/core/driver.test.ts` — PK key-order fold tests (composite `[b,a]`, single, empty, absent-table) + `pgSupportsConparentid` boundary test.

**Review findings:** 2 patches applied (both low: stale comment count, snake_case rename); 0 intent_gap; 0 bad_spec; 0 defer; 6 rejected (specified behavior or negligible/pre-existing). See Review Triage Log.

**Verification:** `bun test` → 1312 pass / 0 fail (73 files); `bun test src/core/driver.test.ts` → 71 pass; `bunx tsc --noEmit` → clean (exit 0); no residual `isPrimaryKey`/`pkSet`/`pkKey` in the driver adapters.

**Residual risks:** DW-42's live partition-FK exclusion has no automated end-to-end coverage (no live-DB harness) — mitigated by inspection + the version-boundary unit test. Under concurrent DDL between the two non-snapshotted introspection round-trips, `primaryKey` could momentarily list a column absent from `columns` (same visibility-skew class the existing FK/index folds already accept); negligible, no crash.
