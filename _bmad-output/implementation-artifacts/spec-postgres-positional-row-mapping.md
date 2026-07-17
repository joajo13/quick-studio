---
title: 'Postgres raw-read positional row mapping (DW-29, DW-38)'
type: 'bugfix'
created: '2026-07-17'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
baseline_revision: '71b5ff06398738bb46aae3e5a6ca3cace4d357ed'
final_revision: 'e89af66308a19d6d85762ca41d6a89cab768e1de'
---

<intent-contract>

## Intent

**Problem:** The postgres adapter's raw-read path (`runUnsafe` in `driver-postgres.ts`) builds each result row via `cols.map((c) => row[c.name])` on postgres.js's name-keyed row object. When a `SELECT` yields two same-named or aliased output columns (`SELECT id, id`, `a.id, b.id`), both map to the SAME key, so the last column's value overwrites the first and the distinct columns collapse to one value. The browse SELECT never triggers it (single-table columns are unique), but Story 3.1's raw-SQL path routes arbitrary SELECTs through this same seam where duplicate/aliased names are common. MySQL already returns positional arrays (`rowsAsArray: true`), so the two engines diverge.

**Approach:** Switch the postgres raw-read path to postgres.js's `.values()` array row-mode, which yields rows as position-aligned arrays keyed to the ordered `result.columns` metadata (mirroring mysql2's `rowsAsArray`). This removes the name-keyed lookup entirely, so duplicate/aliased columns keep their distinct per-position values and the two engines align on the same neutral `DriverQueryResult` shape.

## Boundaries & Constraints

**Always:**
- The `{ simple: false }` (FORCE_EXTENDED) multi-command backstop stays UNCONDITIONAL on both `query` and `queryReadOnly` — the row-mode change must not touch protocol selection.
- `DriverQueryResult` shape is unchanged: `columns` in server order, `rows` as position-aligned value arrays, `rowsAffected` from `result.count` (falling back to `rows.length`).
- Both the `query` and `queryReadOnly` paths (which share `runUnsafe`) get the fix, including the reserved-connection read-only path.
- `columns` continues to reflect every output column verbatim and in order — including duplicates — so `rows[i]` stays position-aligned to `columns[i]`.

**Block If:**
- postgres.js `.values()` does not expose `columns`/`count` on the result in the installed version (would change the mapping contract). (Verified present: `Result` extends Array and carries `columns` + `count` in values mode.)

**Never:**
- Do not change the MySQL adapter (already positional).
- Do not change the browse SELECT composition, the executor, or `assembleSchema`/introspection paths.
- Do not deduplicate, rename, or suffix duplicate column names — preserve them verbatim.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Duplicate output names | values-mode result: rows `[[1,2],[3,4]]`, columns `[{id},{id}]`, count 2 | `columns` = `[{id},{id}]`, `rows` = `[[1,2],[3,4]]` (both values survive), `rowsAffected` 2 | No error expected |
| Unique columns (browse) | values-mode result: rows `[[7,'a']]`, columns `[{id},{name}]`, count 1 | `columns` = `[{id},{name}]`, `rows` = `[[7,'a']]`, `rowsAffected` 1 (unchanged behavior) | No error expected |
| Empty result | values-mode result: `[]`, columns `[{id}]`, count 0 | `columns` = `[{id}]`, `rows` = `[]`, `rowsAffected` 0 | No error expected |
| Missing count (non-SELECT) | values-mode result: `[]`, columns `[]`, count `undefined`/`null` | `rowsAffected` falls back to `rows.length` (0) | No error expected |

</intent-contract>

## Code Map

- `src/core/driver-postgres.ts` -- `runUnsafe` holds the name-keyed mapping (`cols.map((c) => row[c.name])`); the file to change. Shared by `query` and `queryReadOnly`.
- `src/core/driver-mysql.ts` -- reference: `execMysql` already uses `rowsAsArray: true` positional mapping; the target shape.
- `src/core/driver.ts` -- defines `DriverQueryResult` / `DriverColumn` (the neutral shape, unchanged).
- `src/core/driver.test.ts` -- existing "no live DB" backstop tests establish the pattern (lazy query-builder inspection + exported-helper unit tests); add the new tests here.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/driver-postgres.ts` -- Extract the result mapping into an exported pure helper `mapUnsafeResult(result)` that takes a postgres.js values-mode result (array-of-arrays carrying `columns` + `count`) and returns the neutral `DriverQueryResult` (`columns` from `result.columns`, `rows` = the positional array, `rowsAffected` = `result.count ?? rows.length`). Change `runUnsafe` to issue the query via `.values()` and delegate to `mapUnsafeResult`. Keep `FORCE_EXTENDED` unconditional. Update the `runUnsafe` doc comment to note the positional (values) row-mode and the DW-29/DW-38 rationale.
- [x] `src/core/driver.test.ts` -- Unit-test `mapUnsafeResult` against the I/O & Edge-Case Matrix (duplicate names not collapsing, unique columns unchanged, empty result, missing-count fallback). Add a "no live DB" inspection test that the raw-read query is issued in values mode (`.values()` sets the postgres.js query's `isRaw === 'values'`), analogous to the existing `{ simple: false }` protocol test.

**Acceptance Criteria:**
- Given a raw `SELECT` whose result has two identically-named output columns, when the postgres adapter maps the result, then both columns appear in `columns` and both distinct values appear at their positions in each `rows` entry (no collapse to the last value).
- Given the existing browse SELECT (unique columns), when the adapter maps the result, then `columns`, `rows`, and `rowsAffected` are unchanged from prior behavior.
- Given the read-only path (`queryReadOnly`), when it runs a raw SELECT, then it uses the same positional values-mode mapping (both paths share `runUnsafe`).
- Given the full driver test suite, when `bun test src/core/driver.test.ts` runs, then it passes with the new tests green.

## Spec Change Log

(none — no bad_spec loopback occurred.)

## Review Triage Log

### 2026-07-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 0
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[patch]` The values-mode no-live-DB test only asserted `isRaw === 'values'`, never `options.simple === false` on the same chained call — the multi-command backstop's durability was untested on the real production call shape. Strengthened that test to assert BOTH invariants on the same `.unsafe(…, { simple: false }).values()` query.
  - `[medium]` `[patch]` No test pinned `rowsAffected` to `result.count` when it differs from `rows.length` (the mutation path: empty rows, non-zero affected count). Added a mutation-shape case (`count: 3`, `rows: []`) so an impl regressing to `rows.length` would fail.
  - `[low]` `[patch]` The same new case uses the real `columns: null` postgres.js default, exercising the `columns ?? []` null branch that the `[]`-passing cases never hit.
  - `[low]` `[patch]` `PgUnsafeResult` declared `columns?`/`count?` as `| undefined` while postgres.js's `Result` initialises them to `null`; changed both to `| null` for type honesty (the `??` fallbacks already caught null at runtime).
  - `[low]` `[patch]` Removed a redundant `as unknown as ReadonlyArray<…>` double-cast in `mapUnsafeResult` (the value already has that base type).

Rejected (noise / consistent with existing repo conventions): no end-to-end executor→frozen-map regression test (fix is at the correct seam; the file's convention is no-live-DB seam tests, and downstream positionality was independently verified); test-double enumerability divergence (irrelevant to `mapUnsafeResult`'s direct property access); returning the live postgres.js `Result` array as `rows` (the MySQL sibling returns its driver array the same way — a defensive copy would break parity and cost a full copy per query; safe today via `Symbol.species = Array` + non-enumerable props); exporting `mapUnsafeResult` for testing (matches the file's established `createMutex`/`buildMysqlConfig`/`withTimeout` "exported for unit testing" convention); doc-comment precision on the `rowsAsArray` parallel (already scoped to "positional").

## Design Notes

postgres.js `.values()` sets the query's `isRaw = 'values'`; the returned `Result` (an `Array` subclass) then holds rows as `new Array(columns.length)` filled by ordinal position — so same-named columns no longer overwrite each other. `result.columns` (ordered `{name,...}` descriptors) and `result.count` remain attached exactly as in object mode, so only the row projection changes.

```ts
export function mapUnsafeResult(result: PgUnsafeResult): DriverQueryResult {
  const columns = (result.columns ?? []).map((c) => ({ name: c.name }));
  const rows = result as unknown as ReadonlyArray<ReadonlyArray<unknown>>;
  return { columns, rows, rowsAffected: result.count ?? rows.length };
}
// runUnsafe: await sql.unsafe(text, params, FORCE_EXTENDED).values() -> mapUnsafeResult(...)
```

## Verification

**Commands:**
- `bun test src/core/driver.test.ts` -- expected: all tests pass, including the new `mapUnsafeResult` and values-mode tests.
- `bunx tsc -p tsconfig.json --noEmit` -- expected: no new type errors from the `.values()` / helper change (no `typecheck` npm script exists; run tsc directly).

## Auto Run Result

Status: done

**Summary:** The postgres raw-read path (`runUnsafe`, shared by `query` and `queryReadOnly`) now projects result rows positionally via postgres.js `.values()` (array row-mode) and delegates the neutral-shape mapping to a new pure, exported helper `mapUnsafeResult`. This resolves DW-29 / DW-38: a raw `SELECT` with duplicate/aliased output column names (`SELECT id, id`, `a.id, b.id`) keeps each column's distinct value at its position instead of collapsing to the last name-keyed value, and aligns postgres with the MySQL adapter's existing `rowsAsArray` positional shape. The `{ simple: false }` (FORCE_EXTENDED) multi-command backstop is preserved unconditionally.

**Files changed:**
- `src/core/driver-postgres.ts` -- added `PgUnsafeResult` type + exported `mapUnsafeResult` helper; `runUnsafe` now issues `.unsafe(…, FORCE_EXTENDED).values()` and delegates mapping. Doc comments updated.
- `src/core/driver.test.ts` -- added the `mapUnsafeResult` unit-test suite (duplicate-name no-collapse, unique columns, empty result, missing-count fallback, mutation count-vs-length + null-columns) and a no-live-DB test asserting the raw-read query is issued in values mode AND keeps `options.simple === false`.

**Review findings breakdown:** 5 patches applied (2 medium, 3 low — backstop-durability assertion, mutation `rowsAffected` provenance + real-null `columns` branch, `| null` type honesty, redundant-cast cleanup); 0 deferred; 5 rejected (see Review Triage Log). No intent_gap, no bad_spec — zero repair loopbacks.

**Follow-up review recommended:** false — the change is a small, correct, well-scoped bugfix; the review-driven changes were localized test/type strengthening with no new behavior, API, security, or data-integrity impact.

**Verification performed:**
- `bun test src/core/driver.test.ts` -> 66 pass, 0 fail (116 expect() calls).
- `bun test` (full suite) -> 1241 pass, 0 fail across 71 files.
- `bunx tsc -p tsconfig.json --noEmit` -> exit 0, no type errors.

**Residual risks:** `mapUnsafeResult` returns the live postgres.js `Result` (an `Array` subclass) as `rows` rather than a defensive plain-array copy — matching the MySQL adapter's convention of returning its driver array directly. Safe under current consumers (all normalize to `FrozenData` before any RPC/worker boundary; `Symbol.species = Array` and non-enumerable meta props). A future consumer that serializes/clones `rows` directly or checks `rows.constructor`/`instanceof` would need to normalize first — same caveat that already applies to the MySQL path.
