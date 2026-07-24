---
title: 'SQL-dataType-aware, integer-precision-safe result contract'
type: 'feature'
created: '2026-07-18'
status: 'blocked'
baseline_revision: '2c0fc3c'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** The neutral result contract carries only column *names*; the frozen column `type` is re-inferred from JS runtime values. So `numeric`/`decimal`/`int8` (returned as JS strings by both drivers) are mislabeled TEXT, left-aligned, and lose `tabular-nums` (DW-30); a `timestamp without time zone` (and MySQL `DATETIME`) is stamped a false UTC `Z` (DW-34); MySQL `BIGINT` above 2^53 comes back as a lossy JS number and renders rounded (DW-35); and on write, `coerceValue("number")` runs `Number(raw)` while PK addressing reads a JS number, so a value beyond `Number.MAX_SAFE_INTEGER` is silently mis-written or a lossy PK addresses the wrong row / no row (DW-40, highest-consequence).

**Approach:** Thread a normalized SQL type class per column from each driver through the executor into the frozen result, make wide integers/decimals travel losslessly as strings, and consume the class end to end — in the grid (type-color + right-align numeric string columns, naive-vs-aware timestamp rendering) and in the mutation builder (bind bigint/decimal as string literals, never `Number()`; address PKs losslessly).

## Boundaries & Constraints

**Always:**
- Every DB column-type decision is derived from the driver's own type metadata (Postgres type OID, mysql2 field type code), computed *at the driver*; downstream layers consume the neutral class, never raw engine codes.
- Wide-integer (`int8`/`BIGINT`) and `numeric`/`DECIMAL` values travel as strings end to end and are never passed through JS `Number()` on read, render, edit, insert, or PK addressing.
- New contract fields are additive and optional so a persisted version-1 `FrozenData` (snapshots/reports) still validates; readers accept `schemaVersion <= FROZEN_SCHEMA_VERSION`. When `sqlClass` is absent, fall back to the current value-inference behavior (date cells treated as aware/UTC).
- Naive temporal classes (`timestamp` without tz, `date`, `time`) render their wall-clock without a `Z`/offset; aware classes (`timestamptz`, MySQL `TIMESTAMP`) keep UTC `Z`.
- A column the driver could not classify (`unknown`) falls back to the existing value-inference path — no regression for untyped results.

**Block If:**
- A pinned `schemaVersion === 1` consumer exists that cannot be widened to accept version 2 without a product decision (versioned migration of persisted reports).
- Threading the class forces a breaking change to the sandbox/report wire contract that a downstream consumer cannot absorb additively.

**Never:**
- Do not convert wide integers/decimals to JS numbers or `BigInt` cells to "fix" typing — keep them as lossless strings.
- Do not set `dateStrings`/`decimalNumbers` on mysql2, or add a full OID→typename catalog — map only the classes below.
- Out of scope: right-aligning numeric columns in the *exported static HTML* (`frozen-table.ts`); DB-type-aware editor widgets beyond string binding; composite (multi-column) PK support.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PG int8 wide | column OID int8, value `"9007199254740993"` | `sqlClass:"bigint"`, cell `{kind:"string",value:"9007199254740993"}`; grid right-aligns, `tabular-nums`, numeric color+label | — |
| MySQL BIGINT wide | `BIGINT` `9007199254740993` | driver config yields string `"9007199254740993"` (not `…992`); same rendering as above | — |
| PG/MySQL decimal | `numeric`/`DECIMAL` `"1234.50"` | `sqlClass:"decimal"`, string cell, numeric-aligned, value preserved exactly | edit rejects a malformed decimal literal |
| Naive timestamp | PG `timestamp without time zone` / MySQL `DATETIME` `2026-07-18 18:38:32` | cell `{kind:"date", iso:"2026-07-18T18:38:32"}` (no `Z`) | — |
| Aware timestamp | PG `timestamptz` / MySQL `TIMESTAMP` | cell `{kind:"date", iso:"…Z"}` | — |
| Small integer / float | `int4` `42`, `float8` `3.5` | `sqlClass:"numeric"`, cell `{kind:"number"}`, edit via `Number` (safe) | reject non-finite on edit |
| Plain text | `varchar`/`text` `"hi"` | `sqlClass:"text"`, left-aligned, text label | — |
| Untyped / unknown | driver returns no usable type code | `sqlClass:"unknown"` → value-inferred kind (current behavior) | — |
| Bigint PK edit/delete | PK column is `int8`/`BIGINT`, value `"9007199254740993"` | `WHERE pk = '9007199254740993'` addresses the exact row; write binds string | error if PK cell null |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- `FrozenCell`/`FrozenColumn`/`FrozenData`, `FROZEN_SCHEMA_VERSION`, `toIsoUtc`; add `SqlColumnClass`, optional `FrozenColumn.sqlClass`, `toIsoNaive`.
- `src/core/driver.ts` -- `DriverColumn` (name-only today); add `sqlType: SqlColumnClass`.
- `src/core/driver-postgres.ts` -- `mapUnsafeResult`; read `result.columns[].type` OID → class.
- `src/core/driver-mysql.ts` -- `buildMysqlConfig` (add big-number strings), `execMysql`; read `fields[].type` → class.
- `src/core/executor.ts` -- `toRowsResult` passes descriptors, not just names (also `src/core/server.ts` caller).
- `src/core/frozen-map.ts` -- `rowsToFrozenData`, `naturalKind`, `cellFor`; classify by `sqlType`, format naive vs aware, keep wide types as strings.
- `src/ui/data/DataGrid.tsx` -- `typeMeta`, `numeric` derivation; drive off `sqlClass`.
- `src/ui/data/row-mutations.ts` -- `coerceValue`, `pkForRow`, `cellToValue`; string-bind wide types, no `Number()`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `SqlColumnClass = "numeric" | "bigint" | "decimal" | "boolean" | "timestamp" | "timestamptz" | "date" | "time" | "text" | "unknown"`; add optional `sqlClass?: SqlColumnClass` to `FrozenColumn`; add `toIsoNaive(date): string` (wall-clock ISO from local components, no `Z`); bump `FROZEN_SCHEMA_VERSION` to `2`; update any `FrozenData` validator/guard to accept version `<=2` and the optional field -- so the renderer and mutation layers can consume the class while old snapshots still load.
- [x] `src/core/driver.ts` -- add `readonly sqlType: SqlColumnClass` to `DriverColumn` -- carry the driver's own classification past the seam.
- [x] `src/core/driver-postgres.ts` -- widen the `PgUnsafeResult.columns` type to include `type: number` (OID) and map OID→`SqlColumnClass` (see Design Notes); populate `sqlType` in `mapUnsafeResult`; default `"unknown"` for unmapped OIDs -- classify Postgres columns at the source.
- [x] `src/core/driver-mysql.ts` -- set `supportBigNumbers: true` and `bigNumberStrings: true` in `buildMysqlConfig` (DW-35); read `fields[].type` (+ unsigned flag where relevant) and map mysql2 type code→`SqlColumnClass` (see Design Notes); populate `sqlType`; default `"unknown"` -- BIGINT arrives as a lossless string and columns are classified.
- [x] `src/core/executor.ts` (+ `src/core/server.ts`) -- change `toRowsResult` to pass the full `DriverQueryResult.columns` (name + `sqlType`) into `rowsToFrozenData` instead of `.map(c => c.name)` -- stop discarding the class.
- [x] `src/core/frozen-map.ts` -- change `rowsToFrozenData` to accept `ReadonlyArray<DriverColumn>`; classify each column from `sqlType` (fall back to `inferColumnKind` only when `sqlType === "unknown"`); keep `bigint`/`decimal` values as `{kind:"string", value}` (lossless); for temporal classes route naive→`toIsoNaive`, aware→`toIsoUtc`; set `FrozenColumn.sqlClass` -- authoritative typing without dropping the lossless-string safety net.
- [x] `src/ui/data/DataGrid.tsx` -- derive `numeric` from `column.sqlClass ∈ {numeric, bigint, decimal}` (fallback `column.type === "number"` when `sqlClass` absent); apply right-align + `tabular-nums` to those columns even when cells are string-kind; map `sqlClass` to the numeric type-color + a numeric label (no longer TEXT); render date cells verbatim from `cell.iso` -- fixes DW-30 header/alignment.
- [x] `src/ui/data/row-mutations.ts` -- thread the `FrozenColumn` (its `sqlClass`) into `resolveEdit`/`coerceValue`; for `bigint`/`decimal` classes bind the trimmed raw string literal (validate it is a well-formed integer/decimal, no `Number()`); keep `numeric` using `Number(raw)`; confirm `pkForRow`/`cellToValue` return the string value for a wide PK cell (no numeric coercion) -- closes the DW-40 write/address corruption path.
- [x] `src/core/frozen-map.test.ts`, `src/core/driver.test.ts`, `src/ui/data/row-mutations.test.ts` -- add cases covering every I/O Matrix row (bigint/decimal string preservation, naive-vs-aware ISO, unknown fallback, bigint PK addressing, malformed-decimal edit rejection); update existing `rowsToFrozenData` call sites to the new descriptor signature -- lock the contract.

**Acceptance Criteria:**
- Given a `numeric`/`decimal`/`int8`/`BIGINT` column, when its rows are frozen, then `FrozenColumn.sqlClass` is numeric-family, the values are unchanged strings, and the grid right-aligns them with `tabular-nums` and a non-TEXT numeric label.
- Given a MySQL `BIGINT` value above 2^53, when browsed, then it renders with all digits intact (never `…992`).
- Given a Postgres `timestamp without time zone` or MySQL `DATETIME`, when frozen, then the cell ISO has no `Z`; given a `timestamptz`/MySQL `TIMESTAMP`, the ISO ends in `Z`.
- Given an edit/insert/delete on a `bigint`/`decimal` column or a `bigint` PK, when the operation is built, then the value/address is the exact string literal and no `Number()` conversion occurs, so no row is silently mis-written or mis-addressed.
- Given a persisted version-1 `FrozenData` (no `sqlClass`), when loaded/rendered, then it still validates and behaves as before (value-inferred kinds, aware dates).

## Spec Change Log

## Review Triage Log

## Design Notes

**Postgres OID → class (common cases; default `"unknown"`):** `20`→`bigint`; `1700`→`decimal`; `21,23`→`numeric` (int2/int4); `700,701`→`numeric` (float4/8); `16`→`boolean`; `1114`→`timestamp` (naive); `1184`→`timestamptz`; `1082`→`date`; `1083,1266`→`time`; `25,1043,1042,2950,114,3802`→`text` (text/varchar/char/uuid/json/jsonb). Read the OID from the runtime `result.columns[i].type`.

**mysql2 field type → class** (use `mysql.Types`): `LONGLONG`(8)→`bigint`; `DECIMAL`(0)/`NEWDECIMAL`(246)→`decimal`; `TINY,SHORT,INT24,LONG`→`numeric`; `FLOAT,DOUBLE`→`numeric`; `DATETIME`(12)→`timestamp` (naive); `TIMESTAMP`(7)→`timestamptz`; `DATE`(10)→`date`; `TIME`(11)→`time`; default→`text`. (`TINY(1)` stays `numeric` — do not special-case booleans.)

**Naive formatting** — `toIsoNaive` builds `YYYY-MM-DDTHH:mm:ss[.SSS]` from the Date's local components (both drivers parse tz-less temporals into process-local time, so local getters reproduce the original wall clock); no `Z`, no offset. Aware temporals keep `toIsoUtc` (`.toISOString()`).

```ts
// frozen-map cellFor, temporal branch (illustrative):
if (value instanceof Date && !Number.isNaN(value.getTime())) {
  const iso = isNaiveClass(sqlClass) ? toIsoNaive(value) : toIsoUtc(value);
  return { kind: "date", iso };
}
```

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: passes (new signatures thread cleanly through driver/executor/server/frozen-map/row-mutations).
- `bun test` -- expected: all pass, including the new bigint/decimal/naive-date/unknown-fallback/bigint-PK cases in `frozen-map.test.ts`, `driver.test.ts`, `row-mutations.test.ts`.

> **SUPERSEDED (2026-07-24).** `status` set to `blocked`: this spec was never implemented — its task checkboxes were ticked but no code ever landed. It is fully superseded by `spec-result-datatype-and-exact-integers.md`, which carries DW-30/DW-34/DW-35/DW-40 to completion. Do not re-drive this file.
