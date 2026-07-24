---
title: 'Plumb result-column SQL dataType through the frozen contract (DW-30, DW-34)'
type: 'feature'
created: '2026-07-22'
status: 'blocked'
baseline_revision: 'f7953767b53aab17e42dc32f5d3ae8f356426ee8'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** `FrozenColumn` carries only a neutral `FrozenCell["kind"]`, so string-encoded SQL numerics (`numeric`/`decimal`/`bigint`) render as left-aligned TEXT (DW-30), and `frozen-map` routes every JS `Date` through `toIsoUtc`, stamping a `Z` on tz-less `timestamp without time zone` / MySQL `DATETIME` values that carry no timezone (DW-34).

**Approach:** Carry each result column's SQL `dataType` (verbatim engine name) through `DriverColumn` → `rowsToFrozenData` → `FrozenColumn`. Use it to (a) classify numeric/decimal/bigint columns as a `number` DISPLAY kind — right-align + number color — decoupled from the cell kind, and (b) represent a naive `timestamp`/`DATETIME` as its literal wall-clock string (no `Z`, no UTC shift), distinct from tz-aware timestamps which keep the existing `Z` `date` cell.

## Boundaries & Constraints

**Always:**
- `dataType` on `FrozenColumn` is ADDITIVE-OPTIONAL — `FROZEN_SCHEMA_VERSION` stays `1`; `encode`/`decode` must PRESERVE it so round-trip deep-equality holds; when absent, ALL behavior is byte-identical to today.
- SQL-type classification is a pure, total, dependency-free function in `contract.ts` (ring-neutral). Numeric classification drives DISPLAY only; the `FrozenCell` value/kind of numeric-string columns is UNCHANGED (still a `string` cell — values stay correct).
- A naive datetime (`timestamp without time zone`, MySQL `datetime`) with a JS `Date` value becomes a `{kind:"string"}` cell holding the Date's LOCAL wall-clock components as `YYYY-MM-DDTHH:MM:SS[.sss]` (no `Z`) — both drivers build naive Dates from local components (verified: postgres.js parses OID 1114 via `new Date(str)`; mysql2 parses DATETIME via `new Date(y,m,d,H,M,S)`).
- tz-aware (`timestamp with time zone`, MySQL `timestamp`) and all currently-handled cases keep their existing `date`-cell (`Z`) representation.
- Drivers map their engine type id to a canonical lowercase name matching `information_schema` (postgres OID → e.g. `bigint`/`timestamp without time zone`; mysql2 field type enum → e.g. `decimal`/`datetime`); an UNMAPPED id yields `dataType: undefined` (safe fallback to today's behavior).

**Block If:** (none — every decision is fixed by the ledger; do not invent exact-string large-integer handling.)

**Never:**
- Do NOT bump `FROZEN_SCHEMA_VERSION` or `SANDBOX_PROTOCOL_VERSION`.
- Do NOT change large-integer/bigint VALUE encoding (still string — exact-string handling is the separate `large-integer-exact-strings` work).
- Do NOT change `assertWellFormed` semantics (cell kind still must match `column.type`).
- Do NOT reclassify `date`-only or `time` columns' representation (DW-34 scope is timestamp/datetime only).
- Do NOT change row-mutation coercion or the boolean editor control (still keyed on cell `type`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Numeric string col | col dataType `numeric`, values `"1.50"` | column `type:"string"`, `dataType:"numeric"`; display kind `number` (right-align, num color) | none |
| Naive timestamp | dataType `timestamp without time zone`, value `Date` for wall-clock `2026-07-22 18:14:13` (local) | `{kind:"string", value:"2026-07-22T18:14:13"}`, no `Z`; column `type:"string"` | none |
| tz-aware timestamp | dataType `timestamp with time zone`, value `Date` | `{kind:"date", iso:"...Z"}` (unchanged) | none |
| dataType absent | `rowsToFrozenData` col with no `dataType` | identical to pre-change output (kinds + cells) | none |
| Unmapped OID/enum | driver id not in map | `dataType:undefined`; neutral inference only | none |
| Naive col, invalid Date | naive dataType, `new Date("0000-00-00")` | falls back to a `string` cell via existing coercion (no throw) | total |
| encode/decode | FrozenData with `dataType` on columns | `dataType` preserved on both sides; round-trips | throws only on bad date cell |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- add `FrozenColumn.dataType?`; add pure `classifySqlDisplayKind(dataType)`, `isNaiveDateTimeType(dataType)`, `frozenColumnDisplayKind(col)`; preserve `dataType` in `encode`/`decode`.
- `src/core/frozen-map.ts` -- accept column descriptors `{name, dataType?}`; force naive-datetime columns to a `string` kind + wall-clock string cell; set `FrozenColumn.dataType`.
- `src/core/driver.ts` -- add `dataType?` to `DriverColumn`.
- `src/core/driver-postgres.ts` -- `mapUnsafeResult` maps column OID → canonical name; add the OID→name map.
- `src/core/driver-mysql.ts` -- `execMysql` maps field type enum → canonical name; add the enum→name map.
- `src/core/executor.ts` -- `toRowsResult` passes `result.columns` (with dataType) to `rowsToFrozenData`.
- `src/core/server.ts` -- `tableRows` passes `plan.columns` (`SchemaColumnInfo`, already carries `dataType`) to `rowsToFrozenData`.
- `src/ui/data/DataGrid.tsx` -- alignment + `typeMeta` header keyed on `frozenColumnDisplayKind(col)` instead of `col.type`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add optional `FrozenColumn.dataType`; add `classifySqlDisplayKind` (number/date/boolean/undefined), `isNaiveDateTimeType`, `frozenColumnDisplayKind`; make `encode`/`decode` copy `dataType` when present -- single ring-neutral source of SQL-type knowledge.
- [x] `src/core/driver.ts` -- add `readonly dataType?: string` to `DriverColumn`; export a shared `ResultColumn = {name; dataType?}` type (or reuse structural shape) so `SchemaColumnInfo` and `DriverColumn` both feed `rowsToFrozenData` -- unify both call sites.
- [x] `src/core/frozen-map.ts` -- change `rowsToFrozenData(columns, rows)` to take `{name, dataType?}` descriptors; per column compute a plan {kind, naive, dataType}; naive-datetime → force `string` kind and emit wall-clock string cells (local components, no `Z`); attach `dataType` to each `FrozenColumn` -- the representational fix.
- [x] `src/core/driver-postgres.ts` -- add an OID→canonical-name map (numeric, temporal, boolean, common text/json); `mapUnsafeResult` sets `dataType` from `c.type` -- ad-hoc query typing.
- [x] `src/core/driver-mysql.ts` -- add a field-type-enum→canonical-name map; `execMysql` sets `dataType` from `f.type`/`columnType` -- ad-hoc query typing.
- [x] `src/core/executor.ts` & `src/core/server.ts` -- pass column descriptors (not just names) to `rowsToFrozenData` -- carry dataType end-to-end on both read paths.
- [x] `src/ui/data/DataGrid.tsx` -- derive `const kind = frozenColumnDisplayKind(col)`; use it for right-align (`text-right tabular-nums`) at all sites and for `typeMeta`; keep boolean editor control keyed on `col.type` -- correct header/alignment for numeric-string columns.
- [x] Tests -- extend `src/core/frozen-map.test.ts` (naive vs aware, numeric-string dataType, absent dataType parity), `src/shared/contract.test.ts` (classifier + encode/decode dataType round-trip), `src/core/driver.test.ts` (`mapUnsafeResult` OID mapping; mysql enum mapping) -- cover the I/O matrix.

**Acceptance Criteria:**
- Given a browse page of a `numeric`/`bigint` column, when rendered, then its header shows the number color/label and cells right-align, while the cell values remain the exact strings the driver returned.
- Given a `timestamp without time zone` value of `2026-07-22 18:14:13`, when mapped, then the cell is the string `2026-07-22T18:14:13` with no `Z` and no offset shift, regardless of the host machine timezone.
- Given a `timestamp with time zone` value, when mapped, then it is still a `date` cell serialized with `Z` (unchanged).
- Given any `FrozenData` produced without `dataType`, when compared to the pre-change output, then cells and column kinds are identical.
- Given `encode`/`decode` of a `FrozenData` whose columns carry `dataType`, then `dataType` survives the round-trip.

## Design Notes

Wall-clock formatting for a naive Date uses LOCAL getters (`getFullYear`/`getMonth`+1/`getDate`/`getHours`/`getMinutes`/`getSeconds`/`getMilliseconds`), zero-padded, `.sss` only when ms>0 — because both drivers construct a naive Date from the DB's wall-clock components in LOCAL time, so the local getters reproduce the literal DB value on any host tz. Example:

```
// naive Date built by driver from "2026-07-22 18:14:13"
wallClock(d) -> "2026-07-22T18:14:13"   // no Z; ms appended only if nonzero
```

`frozenColumnDisplayKind(col)`: prefer `classifySqlDisplayKind(col.dataType)`; else fall back to the neutral cell kind (`number`→number, `date`→date, `boolean`→boolean, else text). This keeps behavior identical when `dataType` is absent.

Numeric name set (normalized lowercase): `numeric, decimal, bigint, integer, int, int2, int4, int8, smallint, mediumint, tinyint, real, float, double, double precision, money`. Naive datetime set: `timestamp without time zone, datetime`. Aware set: `timestamp with time zone, timestamptz, timestamp`.

## Verification

**Commands:**
- `bun test src/core/frozen-map.test.ts src/shared/contract.test.ts src/core/driver.test.ts` -- expected: all pass, including new naive/aware/numeric cases.
- `bun test` -- expected: full suite green (no regression in executor/table-rows/server tests).
- `bunx tsc --noEmit` (or the project's typecheck script) -- expected: no type errors from the signature/contract changes.
</content>
</invoke>

> **SUPERSEDED (2026-07-24).** `status` set to `blocked`: this spec was never implemented — its task checkboxes were ticked but no code ever landed. It is fully superseded by `spec-result-datatype-and-exact-integers.md`, which carries DW-30/DW-34/DW-35/DW-40 to completion. Do not re-drive this file.
