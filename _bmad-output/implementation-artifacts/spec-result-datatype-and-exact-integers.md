---
title: 'Carry SQL dataType on result columns and keep wide integers exact end-to-end (DW-30, DW-34, DW-35, DW-40)'
type: 'feature'
created: '2026-07-24'
status: 'done'
baseline_revision: '10c82c3f9ec8aaf88f8bf262c83a43a4853066ba'
final_revision: '9e915cf84090c34526c91189bed76a8fd0be5d16'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** `FrozenColumn` carries only a name plus a neutral `FrozenCell["kind"]` (`src/shared/contract.ts:40-44`). So string-encoded SQL numerics (`numeric`/`decimal`/`int8`/`BIGINT`) render as left-aligned TEXT (DW-30); `frozen-map` routes every JS `Date` through `toIsoUtc`, stamping a false `Z` on tz-less `timestamp`/`DATETIME` (DW-34); `buildMysqlConfig` (`src/core/driver-mysql.ts:151-155`) sets no big-number options, so a MySQL `BIGINT` above 2^53 decodes to a lossy JS number and displays rounded (DW-35); and `row-mutations.ts` binds edits through `Number(raw)` and reads PK values as JS numbers, so a wide value is silently mis-written and a lossy PK makes `WHERE pk = <lossy>` address the wrong row or none (DW-40).

**Approach:** Thread each result column's SQL `dataType` (canonical lowercase engine name) from both drivers and from the browse plan into `FrozenColumn` as a new OPTIONAL field, and consume it in three places: the grid derives type-color/label and right-align from the SQL type instead of the cell kind; naive datetimes become literal wall-clock string cells (no `Z`, no shift) while tz-aware ones keep their UTC `date` cell; and the mutation builder binds exact-numeric columns as validated exact strings on both the SET value and the PK address, never through `Number()`. MySQL is switched to big-number strings so `BIGINT`/`DECIMAL` arrive lossless, matching what postgres.js already does.

## Boundaries & Constraints

**Always:**
- `FrozenColumn.dataType` is OPTIONAL. Absent `dataType` MUST reproduce today's behavior byte-for-byte (value-inferred kind, aware dates, `Number()` coercion). `FROZEN_SCHEMA_VERSION` stays `1`.
- `date` cells keep their existing invariant: `iso` always ends in `Z` and satisfies `ISO_UTC_RE`. A naive datetime is therefore represented as a `string` cell, NOT as a `date` cell with a stripped suffix.
- `assertWellFormed`'s cell-kind-matches-column-type rule stays intact: whatever kind the mapper picks for a column, every non-null cell in it uses that kind.
- `encode`/`decode` must PRESERVE `dataType` while keeping their whitelist rebuild (do not switch to a blind spread of unknown properties).
- Exact-numeric columns (`bigint`/`int8`/`numeric`/`decimal`) travel as strings on read, on write, and in PK addressing. No code path may call `Number()` on their values.
- `buildMysqlConfig` keeps its existing unconditional `multipleStatements: false` enforcement (both the URL query param and the explicit option) exactly as-is.
- Column values themselves are never reformatted for display — the grid renders the driver's string verbatim.

**Block If:**
- Enabling `supportBigNumbers`/`bigNumberStrings` would require changing the mysql2 connection API in a way that conflicts with the multi-statement pinning (e.g. the URI merge cannot preserve both).
- The `FrozenColumn` shape cannot gain an optional field without a `FROZEN_SCHEMA_VERSION` bump (i.e. some validator rejects unknown/extra column fields in a way that breaks persisted snapshots).

**Never:**
- Do not bump `FROZEN_SCHEMA_VERSION` or migrate persisted snapshots.
- Do not add a `bigint` variant to `FrozenCell` — wide integers stay `string` cells.
- Do not introduce DB-type-aware EDITORS (date pickers, numeric spinners); the inline editor stays a text input, only its alignment class changes.
- Do not touch schema introspection, the ERD, chart specs, or CSV export beyond what the type change forces.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Postgres wide int | `int8` column, value `9007199254740993` (driver returns string) | `FrozenColumn` = `{type:"string", dataType:"bigint"}`; cell `{kind:"string", value:"9007199254740993"}`; grid shows a numeric label/color, right-aligned, all digits intact | No error expected |
| MySQL wide int | `BIGINT` column, value `9007199254740993` | Same as above — driver returns the exact string because `bigNumberStrings` is on (DW-35) | No error expected |
| Naive timestamp | PG `timestamp without time zone` / MySQL `DATETIME` = `2026-07-22 18:14:13` | Column `{type:"string", dataType:"timestamp without time zone"}`; cell `{kind:"string", value:"2026-07-22T18:14:13"}` — no `Z`, no offset shift, on any host tz (DW-34) | No error expected |
| Aware timestamp | PG `timestamptz` / MySQL `TIMESTAMP` | Unchanged: `{type:"date"}`, cell `{kind:"date", iso:"…Z"}` | No error expected |
| Wide-int edit | User types `9007199254740993` into a `bigint` cell | `StructuredOp.set[0].value` is the exact string `"9007199254740993"` (bound as a parameter, no `Number()`) (DW-40) | No error expected |
| Malformed exact-numeric edit | User types `12ab` into a `numeric` cell | Rejected as `MutationError` before an op is built | `{ error: "not a number: 12ab" }`-style message |
| Wide-int PK address | Update/delete on a row whose PK column is `bigint` | `pk.value` is the exact string from the cell; `WHERE pk = <exact>` | No error expected |
| No dataType | Legacy/persisted `FrozenData`, or a driver column with no type metadata | Identical to pre-change behavior (inferred kind, aware dates, `Number()` coercion) | No error expected |
| Unknown dataType | Engine type not in the canonical map (e.g. `inet`, `geometry`) | `dataType` carried verbatim; display falls back to the neutral cell kind | No error expected |
| Null-only page | Every value in a `bigint` column is NULL on this page | Column kind `"string"`, all `{kind:"null"}` cells; grid still right-aligns via `dataType` | No error expected |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- `FrozenColumn` (`:40-44`), `assertWellFormed` (`:171-197`), `encode` (`:214`) / `decode` (`:232`) rebuild `{name, type}` and would DROP a new field; `SchemaColumnInfo` (`:284-288`) already has `dataType`; `ISO_UTC_RE` (`:70`) enforces the `Z` on `date` cells; `toIsoUtc` (`:152`).
- `src/core/frozen-map.ts` -- sole exported `rowsToFrozenData` (`:124-132`); private `naturalKind` (`:31-38`), `inferColumnKind` (`:104-116`), `cellFor` (`:64-96`), `coerceString` (`:48`). The ONLY site constructing `FrozenColumn` literals (`:129`).
- `src/core/driver.ts` -- `DriverColumn` (`:76-79`, name only), `DriverQueryResult` (`:86-95`).
- `src/core/driver-postgres.ts` -- `PgUnsafeResult` (`:188-191`) narrows columns to `{name}`; `mapUnsafeResult` (`:203-208`) discards the runtime OID in `c.type`; connection opts (`:248-255`) use postgres.js defaults (int8/numeric already strings).
- `src/core/driver-mysql.ts` -- `buildMysqlConfig` (`:151-155`); `execMysql` (`:114-136`) already destructures mysql2 `fields` but reads only `.name`; introspection `dataType` comes from `information_schema.columns.data_type` (`:237`, `:328`).
- `src/core/executor.ts` -- `toRowsResult` (`:358-364`) flattens to names at `:359`, calls `rowsToFrozenData` at `:362`. Ad-hoc SQL path.
- `src/core/server.ts` -- `tableRows` (`:641-668`); `rowsToFrozenData(plan.columns.map(c => c.name), …)` at `:657-660`. `plan.columns` are `SchemaColumnInfo` — they ALREADY carry `dataType`. Browse path.
- `src/core/table-rows.ts` -- `TableRowsPlan.columns: ReadonlyArray<SchemaColumnInfo>` (`:45`).
- `src/ui/data/DataGrid.tsx` -- `typeMeta` (`:22-33`); five independent `col.type === "number"` checks at `:385`, `:434`, `:147-148`, `:270-272`, plus `Cell` (`:41-67`) whose `date` branch prints `cell.iso` verbatim; boolean editor branch at `:117`.
- `src/ui/data/row-mutations.ts` -- `coerceValue` (`:65-93`, `Number(raw)` at `:70-73`), `resolveEdit` (`:96-99`), `cellToValue` (`:102-113`), `pkForRow` (`:126-146`), `buildUpdateOp` (`:153-170`, reads `columns[idx]!.type` at `:166`), `buildInsertOp` (`:190-208`).
- `src/ui/workspace/TabContent.tsx` -- `:238`, `:248`, `:263` pass the full `data.columns` (`FrozenColumn[]`) into the builders, so `dataType` reaches them with no call-site change.
- `src/core/executor.ts` -- `StructuredPk` consumers: `executeUpdate` composes `WHERE <pk>=<placeholder>` (`:546-548`), `executeDelete` the same (`:569-570`); `placeholder(engine, n)` (`:444-446`) emits `$n` / `?`; `readPk` validates the inbound pk shape. This is where a MySQL exact-numeric PK must be CAST.
- `src/shared/contract.ts` -- `StructuredPk` (`:1129-1132`, `{column, value}`) is the wire shape the PK exactness flag must travel on; `StructuredOp` update/delete variants at `:1163`, `:1170`.
- `src/ui/workspace/chat-model.ts` -- `deriveResultKpis` (`:170-181`) gates the scalar KPI on `columns[0].type === "number"` AND `cell.kind === "number"`.
- `src/ui/report/report-chart.ts` -- `mapChart` (`:83-98`) gates the y-channel on `yCol.type !== "number"`; `frozenToRecords` (`:65-74`) / `cellValue` (`:42+`) flatten cells with no column context.
- `src/shared/frozen-table.ts` -- snapshot/live-report table renderer; reads only `c.name` (pre-existing: never aligned numerics at all).
- Tests: `src/core/frozen-map.test.ts`, `src/shared/contract.test.ts`, `src/core/driver.test.ts` (fakes pg results via `Object.assign([...rows], {columns, count})`, tests `mapUnsafeResult` directly), `src/ui/data/row-mutations.test.ts` (module-level `columns`/`row`/`target` fixtures). Runner is `bun:test`.
- Superseded prior attempts (specs only, no code ever landed): `spec-sql-datatype-result-contract.md`, `spec-result-column-datatype-plumbing.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `readonly dataType?: string` to `FrozenColumn`; export `classifySqlDisplayKind(dataType?): "number"|"date"|"boolean"|undefined`, `isNaiveDateTimeType(dataType?): boolean`, `isExactNumericType(dataType?): boolean`, and `frozenColumnDisplayKind(col: FrozenColumn): FrozenCell["kind"]`; make `encode`/`decode` carry `dataType` through their whitelist rebuild; have `assertWellFormed` reject a non-string `dataType`, and — since the new per-column loop is the FIRST thing to dereference a column entry — guard `typeof col !== "object" || col === null` in that same loop so a malformed `columns: [null]` frame produces a labelled boundary error rather than an unlabelled `Cannot read properties of null` from inside the assertion -- one ring-neutral source of SQL-type knowledge, no schema bump.
- [x] `src/core/driver.ts` -- add `readonly dataType?: string` to `DriverColumn` -- lets the ad-hoc query path carry engine typing.
- [x] `src/core/driver-postgres.ts` -- widen `PgUnsafeResult`'s column element to `{name: string; type?: number}`; add an OID→canonical-name map (see Design Notes); populate `dataType` in `mapUnsafeResult`, leaving it `undefined` for unmapped OIDs -- classify ad-hoc Postgres columns at the source.
- [x] `src/core/driver-mysql.ts` -- in `buildMysqlConfig`, pin FIVE options by the existing `multipleStatements` double-pin (URL query param AND explicit option): `supportBigNumbers: true`, `bigNumberStrings: true` (DW-35) plus `decimalNumbers: false`, `dateStrings: false`, `timezone: "local"` — the latter three are mysql2 defaults but are URL-overridable (`connection_config.js` `validOptions` + `parseUrl`), and every invariant this spec adds rests on them: `?decimalNumbers=true` reintroduces lossy `DECIMAL`, `?dateStrings=true` breaks the `Date`-shaped mapper contract, `?timezone=Z` breaks the wall-clock LOCAL-getter premise. In `execMysql`, map each `fields[i].type` numeric code to a canonical name through a LOCAL literal map (see Design Notes — do NOT use `mysql.Types`: it is an untyped runtime getter absent from `mysql2/promise.d.ts` and it maps code→enum-name, not code→SQL-name) and set `dataType`. Do NOT claim in comments or tests that the big-number pin rescues `DECIMAL` precision: mysql2 already returns DECIMAL/NEWDECIMAL as a string unconditionally (`text_parser.js`) — the pin materially affects `LONGLONG` only, and it is `decimalNumbers: false` that protects `DECIMAL` -- lossless wide integers plus ad-hoc MySQL typing on a connection whose behavior a URL cannot flip.
- [x] `src/core/frozen-map.ts` -- change `rowsToFrozenData` to accept `ReadonlyArray<{readonly name: string; readonly dataType?: string}>`; per column build a plan: when `isNaiveDateTimeType(dataType)` force kind `"string"` and emit wall-clock strings for `Date` values (local getters, see Design Notes), otherwise infer as today; attach `dataType` to each emitted `FrozenColumn`. ZERO-PAD THE YEAR to 4 digits like every other field — a raw `getFullYear()` renders a Postgres `timestamp` of `0500-01-01 00:00:00` as the malformed `500-01-01T00:00:00`, which is exactly the string the editor then seeds and commits back -- the representational fix for DW-34 plus the carrier for DW-30.
- [x] `src/core/executor.ts` & `src/core/server.ts` -- pass column DESCRIPTORS instead of names: `result.columns` at `executor.ts:362` and `plan.columns` at `server.ts:657` (both are structurally `{name, dataType?}`) -- carry `dataType` on both read paths.
- [x] `src/ui/data/DataGrid.tsx` -- compute `const displayKind = frozenColumnDisplayKind(col)` once per column and use it for `typeMeta` and for every right-align/`tabular-nums` decision (`:385`, `:434`, `:147-148`, `:270-272`); keep the boolean `<select>` editor branch keyed on the raw `col.type` -- fixes DW-30 header colour/label/alignment for string-encoded numerics.
- [x] `src/ui/workspace/chat-model.ts` & `src/ui/report/report-chart.ts` -- migrate the two remaining DISPLAY-side numeric gates to `frozenColumnDisplayKind`, because switching MySQL to big-number strings turns `COUNT(*)`/`SUM(...)` (a `LONGLONG`) from a `number` cell into a `string` cell and would silently regress both: in `deriveResultKpis`, gate on `frozenColumnDisplayKind(columns[0])` and accept a `string` cell whose text parses to a finite number (keep the existing non-finite rejection and the integer→`count`/fractional→`money` split); in `mapChart`, gate the y-channel on `frozenColumnDisplayKind(yCol)` and have `frozenToRecords` emit a NUMBER for cells in a column whose display kind is `number` (it currently flattens per-cell with no column context, so it needs the columns passed in). Leave `src/sandbox/render.ts`'s mirrored copy alone — Ring 3 is out of scope -- keeps the MySQL scalar KPI card and MySQL bigint charts working instead of silently degrading to a row-count card and a table.
- [x] `src/ui/data/row-mutations.ts` -- add `coerceValueForColumn(column: FrozenColumn, raw: string)` that dispatches on `column.dataType` BEFORE falling back to `coerceValue(column.type, raw)`, with three branches: (a) INTEGER-exact (`bigint`/`int8`) accepts only `/^[+-]?\d+$/` — a fractional or trailing-dot literal must be rejected client-side, not shipped to an engine that would round or error; (b) DECIMAL-exact (`numeric`/`decimal`) accepts an integer-or-decimal literal; both (a) and (b) return the TRIMMED STRING, never `Number()`. (c) any temporal `dataType` (naive OR aware) routes through `coerceValue("date", raw)` so a `timestamp`/`datetime` column keeps its client-side date validation even though forcing naive columns to `type: "string"` (task 5) would otherwise silently drop it — the header still reads "time", so the editor must still validate as one. Every other column delegates unchanged. In `pkForRow`, when the PK column is exact-numeric and its cell is a `number` cell, reject with a "precision cannot be guaranteed" error; and set the new exactness flag on the returned `StructuredPk` (task 8b) -- closes the DW-40 write path. Keep `coerceValue`'s existing signature and behavior.
- [x] `src/shared/contract.ts` (2nd pass) & `src/core/executor.ts` -- **the DW-40 addressing half, on MySQL.** Add `readonly exactNumeric?: boolean` to `StructuredPk`; `pkForRow` sets it `true` iff `isExactNumericType(column.dataType)`; `executor.ts`'s `readPk` accepts and forwards it. In `executeUpdate`/`executeDelete`, when `engine === "mysql"` AND `pk.exactNumeric === true`, compose the predicate as `WHERE <ident>=CAST(? AS DECIMAL(65,30))` instead of `WHERE <ident>=?`. RATIONALE (mandatory — do not "simplify" this away): mysql2 escapes a JS string parameter into a quoted SQL literal, and MySQL compares an integer column against a string operand **as a floating-point number** (the manual's own example: `SELECT '18015376320243458' = 18015376320243459` → `1`). So binding the exact digits as a string re-opens the very wrong-row hazard DW-40 exists to close: on a `BIGINT` PK holding both `9007199254740992` and `9007199254740993`, `WHERE id='9007199254740993'` float-matches BOTH, and neither statement carries a `LIMIT 1`. `CAST(… AS DECIMAL(65,30))` forces MySQL's exact decimal comparison path (65 digits ≫ BIGINT's 19). Postgres needs NO cast — postgres.js sends parameters untyped and the server parses the literal into the column's own type exactly — so the cast must be engine-gated, never unconditional -- makes "WHERE pk = <exact> can never address the wrong row" true on both engines rather than only on Postgres.
- [x] `src/core/frozen-map.test.ts`, `src/shared/contract.test.ts`, `src/core/driver.test.ts`, `src/ui/data/row-mutations.test.ts` -- add cases for every I/O Matrix row: bigint/decimal string preservation, naive-vs-aware representation (assert tz-independence), absent-`dataType` parity with current output, `dataType` surviving `encode`/`decode`, pg OID + mysql type-code mapping, `buildMysqlConfig`'s FIVE pins, exact-string edit binding, malformed-decimal rejection, and bigint PK addressing. Plus, from the first review pass: a fractional literal REJECTED for a `bigint` column but accepted for `numeric`; a temporal column still rejecting `"not a date"`; a sub-1000 year rendering as `0500-…`; `encode({columns:[null]})` throwing a LABELLED error; `deriveResultKpis` surfacing a string-cell `COUNT(*)`; `mapChart` accepting a string-cell bigint y-channel; and — in `src/core/executor.test.ts` — that an exact-numeric PK composes `CAST(? AS DECIMAL(65,30))` under the mysql engine and a bare `$1` under postgres. Also pin the two `as`-cast assumptions the ad-hoc path silently depends on (a mysql2 `FieldPacket` exposes `.type`; a postgres.js column exposes its OID as `.type`) so a library rename cannot make the whole typing path return `{name}` with a green suite -- lock the contract.
- [x] `_bmad-output/implementation-artifacts/spec-sql-datatype-result-contract.md`, `_bmad-output/implementation-artifacts/spec-result-column-datatype-plumbing.md` -- set frontmatter `status` to `blocked` and append a one-line note that this spec supersedes them (their tasks are checked but no code ever landed) -- stop future sweeps from re-driving abandoned duplicates.

**Acceptance Criteria:**
- Given the typecheck and the full test suite, when run after the change, then the typecheck is clean and the suite shows no NEW failures beyond the 9 pre-existing shim failures, with no signature drift left at any `rowsToFrozenData` call site.
- Given a browse page whose column list came from `plan.columns`, when rendered, then each column's header label/colour and alignment reflect its SQL `dataType`, while the cell text is exactly what the driver returned.
- Given any code path that writes or addresses a `bigint`/`int8`/`numeric`/`decimal` value, when inspected, then no `Number()` conversion appears anywhere along it.
- Given a `FrozenData` produced with every `dataType` stripped, when compared against the pre-change output for the same rows, then columns, kinds and cells are identical.

## Spec Change Log

### 2026-07-24 — Amendment 1 (review pass 1, bad_spec loopback)

**Triggering finding (high):** The implementation bound an exact-numeric PK as a STRING parameter and stopped there. mysql2 escapes a JS string into a quoted SQL literal, and MySQL compares an integer column against a string operand as a floating-point number, so `WHERE id='9007199254740993'` float-matches `…992` too — with no `LIMIT 1` on either the UPDATE or the DELETE. The story's headline promise ("WHERE pk = <exact> can never address the wrong row") therefore held on Postgres only. The original spec never contemplated engine-specific binding, so no amount of care in the code could have caught it — a spec-level gap, not a coding slip.

**What was amended (all outside `<intent-contract>`):**
1. New task: `StructuredPk.exactNumeric` + an engine-gated `CAST(? AS DECIMAL(65,30))` in `executeUpdate`/`executeDelete`, with the MySQL comparison semantics written into the task so it cannot be "simplified" away. Postgres explicitly needs no cast.
2. `buildMysqlConfig` now pins FIVE options, not two — `decimalNumbers`/`dateStrings`/`timezone` are URL-overridable and every new invariant rests on them.
3. Corrected a factually wrong rationale: mysql2 returns DECIMAL as a string regardless of the big-number pins; the pins affect `LONGLONG` only.
4. `coerceValueForColumn` gained an integer-vs-decimal split and a temporal branch (forcing naive columns to `type:"string"` had silently dropped the editor's date validation while the header still read "time").
5. Display-side gates in `chat-model.ts` and `report-chart.ts` migrated to `frozenColumnDisplayKind` — big-number strings turn MySQL `COUNT(*)` into a string cell and would otherwise kill the scalar KPI card and bigint charts.
6. Wall-clock year zero-padding; `assertWellFormed` null-column guard; type-map spellings aligned to `information_schema` (`integer`/`smallint`/`character varying`/`jsonb`, MySQL `int`).
7. Test task extended to cover all of the above plus the two `as`-cast library assumptions.

**Known-bad state avoided:** shipping a story that CLOSES DW-40 in the ledger while a MySQL wide-integer update/delete can still hit the wrong row (or two rows) and report `ok`; plus a silent MySQL-only regression of the chat KPI card and bigint charts introduced by the big-number pin.

**KEEP — these worked and MUST survive re-derivation.** The previous attempt is preserved verbatim at `/tmp/claude-1001/-mnt-c-Users-Juan-Desktop-projects-quick-studio/d0045489-a368-4632-951d-61cb3dc8d66a/scratchpad/attempt-1-KEEP.patch` (1466-line diff, `tsc` clean, 1840 pass / 9 pre-existing shim fails, tz-independent under Tokyo and Kiritimati). Read it and re-derive from it rather than from scratch. Specifically keep:
- The `dataType`-as-OPTIONAL-parallel-hint design, and the reasoning that `type` must stay the truthful runtime kind so `assertWellFormed` and the `date`-cell `Z` invariant both stay intact.
- OMITTING the `dataType` key entirely (never `dataType: undefined`) in BOTH `rebuildColumn` and `rowsToFrozenData`, so a legacy payload stays byte-identical under strict comparison — and the comments explaining why.
- The `ReadonlySet`-based classifier quartet in `contract.ts` (`isExactNumericType` / `isNaiveDateTimeType` / `classifySqlDisplayKind` / `frozenColumnDisplayKind`) with `canonicalSqlType` trimming+lowercasing, and `frozenColumnDisplayKind` as THE single display accessor.
- `encode`/`decode`'s explicit whitelist rebuild (never a blind spread) with `dataType` added to the whitelist.
- The `ColumnDescriptor` structural parameter type on `rowsToFrozenData`, which lets `DriverColumn` and `SchemaColumnInfo` both pass unadapted.
- `mysqlFieldsToColumns` exported as a pure function so the code→name map is testable without a live MySQL (the `buildMysqlConfig` precedent).
- The `multipleStatements` double-pin left exactly as it was, and the new pins written in the same style.
- The `pkForRow` lossy-PK guard (exact-numeric column + `number` cell → refuse to address) and its "we cannot repair what already lost digits" rationale.
- `DataGrid.tsx` computing ONE `displayKind` per column for both `typeMeta` and every alignment site, with the boolean `<select>` still keyed on the raw `col.type`.
- The dense explanatory block comments throughout — they carry the reasoning and match the codebase's house style.

**Carried forward for the NEXT review pass (do not lose):** five pre-existing/defer-class findings were identified in pass 1 and are moot this pass because the code was reverted — MySQL `DATE` rendering the wrong calendar day on UTC+ hosts (mysql2 builds local midnight; Postgres does not have this bug, so the engines disagree); MySQL bare `timestamp` only being genuinely tz-aware when the server session tz equals the host tz; naive wall-clock values inside a DST spring-forward gap being unrepresentable once the driver has built the `Date`; `frozen-table.ts` never aligning numerics at all, so an exported snapshot and the live grid present the same column differently; and the ad-hoc typing path resting on two undeclared library properties reached through `as` casts. Re-triage them next pass.

## Review Triage Log

### 2026-07-24 — Review pass 1
- intent_gap: 0
- bad_spec: 1: (high 1, medium 0, low 0)
- patch: 9: (high 0, medium 4, low 5)
- defer: 5: (high 0, medium 2, low 3)
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Exact-numeric PK bound as a string literal is compared as a FLOAT by MySQL, so a wide-integer update/delete can still address the wrong row (or two rows) and report `ok` — DW-40 was closed on Postgres only. Spec amended with `StructuredPk.exactNumeric` + an engine-gated `CAST(? AS DECIMAL(65,30))`; code reverted for re-derivation. The nine patch-class findings were folded into the amended tasks in the same pass, since the code is re-derived anyway.

### 2026-07-24 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 1, medium 3, low 4)
- defer: 1: (high 0, medium 1, low 0)
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` `exactNumeric` was taken at face value from the RPC payload, so a frame setting it on a TEXT primary key composed `WHERE name=CAST(? AS DECIMAL(65,30))` — MySQL coerces the VARCHAR column to a number too, every non-numeric row collapses to `0`, and one UPDATE/DELETE hits MANY rows. Fixed: `resolvePkCastScale` honors the hint only when the RESOLVED table's introspected PK `dataType` is exact-numeric AND the value is a well-formed numeric literal; otherwise the plain placeholder, or `bad_request` on a malformed exact value.
  - `[medium]` `[patch]` `DECIMAL(65,30)` has 35 integral digits, not 65 — a legal `DECIMAL(40,0)` PK was CLAMPED by the cast, matched nothing, and still returned `status:"ok"`. Fixed: the scale is derived from the validated literal (clamped 0..30), so an integer PK gets MySQL's full 65 integral digits; the comment's arithmetic was corrected.
  - `[medium]` `[patch]` The Ring-3 renderer (`src/sandbox/render.ts`) — which feeds the MDX sandbox, the exported static snapshot and the exported live report — was never made display-kind aware, so a MySQL `COUNT(*)` string cell made Plot infer a categorical y-scale and the same block rendered correctly in-app but wrong in every export. Fixed by mirroring the Ring-2 projection, with the Ring boundary intact.
  - `[medium]` `[patch]` Moving the chart y-gate to the display kind removed the AC'd degrade-to-table fallback: a Postgres `money` column (locale-formatted text) or a `numeric` holding `'NaN'` now passed the gate and drew a BLANK chart. Fixed: the gate additionally requires at least one non-null cell that parses finite.
  - `[low]` `[patch]` The KPI card claimed lossless formatting while running the scalar through `Number()` — misreporting exactly the above-2^53 values DW-35 exists to protect. Fixed: integer-shaped digit strings are grouped character-wise, bypassing `Number()`.
  - `[low]` `[patch]` The MySQL ad-hoc map emitted `timestamp with time zone`, a name MySQL does not have, contradicting the same block's own "both paths use the `information_schema` spelling" invariant. Fixed to `timestamp` (still aware); the spec's Design Notes were amended to withdraw the carve-out.
  - `[low]` `[patch]` The exact-decimal literal regex accepted a trailing-dot literal (`12.`). Tightened to require a digit after the point; `.5` and `+7` still accepted.
  - `[low]` `[patch]` The new `assertWellFormed` column loop claimed to own the entry's shape check but validated only `dataType`, so an array entry or a non-string `name` passed through and an exported snapshot rendered `[object Object]`. Fixed: array, `name`-is-string and `type`-in-enum checks, all as labelled boundary errors.

## Design Notes

**Why a separate optional `dataType` instead of new cell kinds.** `assertWellFormed` requires every non-null cell's `kind` to equal its column's `type`, and `ISO_UTC_RE` requires a `Z` on every `date` cell. Keeping `type` as the truthful runtime kind (`"string"` for a driver-stringified bigint, `"string"` for a naive wall-clock) satisfies both invariants; `dataType` is a parallel DISPLAY/BINDING hint that older data may simply lack.

**Canonical names.** Normalize to trimmed lowercase engine names. Exact-numeric set: `bigint`, `int8`, `numeric`, `decimal`. Other numerics (display only): `integer`, `int`, `int2`, `int4`, `smallint`, `mediumint`, `tinyint`, `real`, `float`, `double`, `double precision`, `money`. Naive set: `timestamp without time zone`, `datetime`. Aware set: `timestamp with time zone`, `timestamptz`, `timestamp`. Anything else is unmapped and falls back to the neutral cell kind.

**The browse path's names are already canonical.** Both engines' introspection reads `information_schema.columns.data_type` (`driver-postgres.ts:283`/`:432`, `driver-mysql.ts:237`/`:328`), so `SchemaColumnInfo.dataType` arrives as e.g. PG `bigint`, `numeric`, `double precision`, `timestamp without time zone`, `timestamp with time zone` and MySQL `bigint`, `decimal`, `int`, `datetime`, `timestamp`. Postgres never emits a bare `timestamp` from that view, so a bare `timestamp` is unambiguously MySQL's tz-aware type — which is why bare `timestamp` sits in the AWARE set while MySQL's `datetime` sits in the naive one. The OID / field-code maps below exist only for the ad-hoc SQL path, which has no introspection to lean on; they deliberately emit the SAME canonical names.

**Postgres OID → name** (default `undefined`): `20`→`bigint`; `1700`→`numeric`; `21`→`smallint`; `23`→`integer`; `700`→`real`; `701`→`double precision`; `16`→`boolean`; `1114`→`timestamp without time zone`; `1184`→`timestamp with time zone`; `1082`→`date`; `1083`→`time without time zone`; `1266`→`time with time zone`; `25`→`text`; `1043`→`character varying`; `1042`→`character`; `2950`→`uuid`; `114`→`json`; `3802`→`jsonb`.

**The maps must spell types the way `information_schema` does — no collapsing.** `dataType` is now a whitelisted PUBLIC field on the wire contract documented as "the SQL type as the engine names it", so the ad-hoc maps must not invent a private vocabulary that disagrees with the browse path for the same logical column. Concretely: emit `integer` (not `int4`), `smallint` (not `int2`), `character varying` (not `text`), `jsonb` (not `json`) — even though all four land in the same display bucket TODAY, the next consumer that keys on the spelling (a richer type label, a CREATE TABLE round-trip, an AI prompt) would inherit a field that lies depending on which read path produced it. MySQL's `LONG` maps to `int` for the same reason (`information_schema` says `int`, never `integer`). **Amended in review pass 2:** there is NO exception — MySQL's `TIMESTAMP` maps to the bare `timestamp` too, because that is exactly what MySQL's `information_schema` reports and what the browse path already emits; `timestamp` is in the AWARE set, so the tz-aware classification is unchanged, and both read paths now agree literally rather than only behaviorally. (The earlier draft of this paragraph carved out `timestamp with time zone` as a deliberate divergence; that carve-out is withdrawn.)

**mysql2 field type CODE → name** (codes verified against `mysql2/lib/constants/types.js`; default `undefined`): `0` DECIMAL→`decimal`; `246` NEWDECIMAL→`decimal`; `8` LONGLONG→`bigint`; `1` TINY→`tinyint`; `2` SHORT→`smallint`; `9` INT24→`mediumint`; `3` LONG→`int`; `4` FLOAT→`float`; `5` DOUBLE→`double`; `12` DATETIME→`datetime`; `7` TIMESTAMP→`timestamp with time zone`; `10` DATE→`date`; `11` TIME→`time`. Do NOT special-case `TINY(1)` as boolean. MySQL `TIMESTAMP` is session-tz converted, so it is treated as AWARE (keeps the `Z` `date` cell) while `DATETIME` is the naive one.

**mysql2 big-number config is safe to pin both ways.** `connection_config.js:120-121` reads `options.supportBigNumbers || false`, i.e. a truthy explicit option always survives the URI merge; and both keys appear in the URL-parseable list (`:19`, `:56`), so setting the query params too closes the reverse hole — exactly the `multipleStatements` pattern already in `buildMysqlConfig`.

**Naive wall-clock formatting.** Both drivers construct a tz-less temporal into a LOCAL-time `Date`, so local getters reproduce the literal DB value on any host timezone:

```ts
// "2026-07-22 18:14:13" -> "2026-07-22T18:14:13"  (".sss" appended only when ms > 0)
const p = (n: number, w = 2) => String(n).padStart(w, "0");
const wallClock = (d: Date) =>
  `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
  `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
  (d.getMilliseconds() ? `.${p(d.getMilliseconds(), 3)}` : "");
```

**Why `pkForRow` rejects a lossy PK rather than repairing it.** Once a wide integer has been decoded into a JS `number`, the lost digits are unrecoverable; addressing with it risks hitting the WRONG row. After this change that combination should be unreachable via both drivers, so the guard is a belt-and-braces invariant, not a routine path.

## Verification

**Commands:**
- `export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit` -- expected: clean; the widened `rowsToFrozenData` signature threads through driver/executor/server/frozen-map/row-mutations with no residual `.map(c => c.name)`.
- `export PATH="$HOME/.bun/bin:$PATH" && bun test` -- expected: all pass. NOTE: 9 shim tests fail in this environment for unrelated pre-existing reasons; treat only NEW failures as regressions.
- `export PATH="$HOME/.bun/bin:$PATH" && TZ=Asia/Tokyo bun test src/core/frozen-map.test.ts` -- expected: naive-timestamp cases produce the identical wall-clock string as under the default TZ, proving no UTC shift.

## Auto Run Result

Status: done
DW items resolved: DW-30, DW-34, DW-35, DW-40 (bundle `result-datatype-and-exact-integers`)

**Implemented change.** Each result column now carries its SQL `dataType` — a canonical lowercase `information_schema` spelling — as a new OPTIONAL field on `FrozenColumn` (no `FROZEN_SCHEMA_VERSION` bump; an absent `dataType` reproduces the previous behavior byte-for-byte). The browse path gets it free from the introspected `SchemaColumnInfo`; the ad-hoc SQL path derives it from postgres.js's column OID and mysql2's field-type code. Four consequences: string-encoded numerics render as right-aligned numeric columns instead of TEXT (DW-30); tz-less `timestamp`/`DATETIME` values become literal wall-clock strings with no `Z` and no UTC shift (DW-34); mysql2 is pinned to return `BIGINT` as an exact string (DW-35); and exact-numeric values are bound and PK-addressed as validated exact strings, with MySQL's PK predicate wrapped in a scale-derived `CAST(? AS DECIMAL(65,<scale>))` so a wide integer can never be float-compared into the wrong row (DW-40).

**Files changed**
- `src/shared/contract.ts` -- `FrozenColumn.dataType`; the classifier quintet (`isExactNumericType`/`isExactIntegerType`/`isNaiveDateTimeType`/`classifySqlDisplayKind`/`frozenColumnDisplayKind`); `StructuredPk.exactNumeric`; `encode`/`decode` whitelist rebuild carries `dataType`; `assertWellFormed` gained full per-column shape validation.
- `src/core/driver.ts` -- `DriverColumn.dataType`.
- `src/core/driver-postgres.ts` -- OID→canonical-name map; `mapUnsafeResult` populates `dataType`.
- `src/core/driver-mysql.ts` -- `buildMysqlConfig` double-pins FIVE options; `mysqlFieldsToColumns` maps field-type codes.
- `src/core/frozen-map.ts` -- `rowsToFrozenData` takes column descriptors; naive-temporal wall-clock rendering with a 4-digit year.
- `src/core/executor.ts` -- descriptors passed to the mapper; `resolvePkCastScale` validates the PK hint against the resolved schema; `pkPlaceholder` composes the MySQL cast.
- `src/core/server.ts` -- browse path passes `plan.columns` descriptors.
- `src/ui/data/DataGrid.tsx` -- one `frozenColumnDisplayKind` per column drives label, colour and every alignment site.
- `src/ui/data/row-mutations.ts` -- `coerceValueForColumn` (integer / decimal / temporal branches); `pkForRow` lossy-PK guard + exactness flag.
- `src/ui/workspace/chat-model.ts`, `src/ui/report/report-chart.ts`, `src/sandbox/render.ts` -- display-side consumers migrated to the display kind and taught to handle string-encoded numerics.
- Tests: `contract.test.ts`, `frozen-map.test.ts`, `driver.test.ts`, `executor.test.ts`, `server.test.ts`, `row-mutations.test.ts`, `chat-model.test.ts`, `report-chart.test.ts`, `render.test.ts`.
- Superseded (marked `blocked` + note): `spec-sql-datatype-result-contract.md`, `spec-result-column-datatype-plumbing.md` — both were hardened and had their checkboxes ticked, but no code from either ever landed.

**Review findings breakdown**
- Pass 1: 1 bad_spec (high) → spec amended, code reverted and re-derived from the preserved attempt; 9 patch-class findings folded into the amended tasks; 5 deferred.
- Pass 2: 8 patches applied (1 high, 3 medium, 4 low); 0 intent_gap; 0 bad_spec; 1 deferred; 0 rejected.
- The high-severity pass-2 finding is worth calling out: `StructuredPk.exactNumeric` arrived from the RPC payload unvalidated, so a frame setting it on a TEXT primary key would have composed a cast that collapses every non-numeric row to `0` — one UPDATE/DELETE hitting many rows. The executor now validates the hint against its OWN introspected schema before it can change SQL composition.

**Verification performed**
- `bunx tsc --noEmit` -- clean (exit 0, no output).
- `bun test` -- 1887 pass / 1 skip / 9 fail / 10361 expect() calls across 86 files. All 9 failures are the pre-existing `quick-studio shim — …` cases (`node` not on PATH in this environment); zero non-shim failures, independently confirmed.
- `TZ=Asia/Tokyo` and `TZ=Pacific/Kiritimati bun test src/core/frozen-map.test.ts` -- byte-identical wall-clock output, proving tz-independence.

**Deferred for the orchestrator to ledger** (NOT written to `deferred-work.md` — this run was instructed not to touch it):
- `[medium]` MySQL `DATE` renders the wrong calendar day on any UTC+ host: mysql2 builds a LOCAL-midnight `Date`, and `date` is not in the naive set, so `toIsoUtc` shifts it back a day. Postgres does NOT have this bug, so the two engines now visibly disagree on the same logical value. Adding `date` to the naive set is NOT a safe one-liner — postgres.js parses OID 1082 as UTC midnight, so local-getter wall-clock formatting would break Postgres on negative-offset hosts. Needs its own decision.
- `[medium]` MySQL bare `timestamp` is classified tz-aware, which is only correct when the server's session timezone matches the host's. With `SET time_zone='+00:00'` and a non-UTC host the displayed instant is off by the host offset, presented with an authoritative `Z`.
- `[medium]` Sub-millisecond precision is silently zeroed on a wall-clock round trip: a PG `timestamp` (µs) or MySQL `DATETIME(6)` renders truncated to 3 fractional digits, and the inline editor seeds and re-commits that truncated text. Inherited from the `Date`-based driver contract (adjacent to the existing DW-6 ms-precision policy), not introduced here — but DW-34 makes the truncated string look canonical.
- `[low]` A naive wall clock inside the host's DST spring-forward gap is unrepresentable once the driver has materialized the `Date`; only driver-level `dateStrings` could preserve it.
- `[low]` `src/shared/frozen-table.ts` (snapshot / live-report table renderer) never aligned numerics at all, so an exported table and the live grid present the same column differently.
- `[low]` The ad-hoc typing path reaches mysql2's `FieldPacket.type` and postgres.js's column OID through `as` casts against properties neither library declares in its `.d.ts`. Pinned by tests now, but a library rename would still silently degrade every ad-hoc column to `{name}`.

**Residual risks**
- The MySQL `CAST` behavior is reasoned from MySQL's documented comparison semantics and asserted at the SQL-composition level; there is no live-MySQL integration test in this repo, so the end-to-end behavior against a real server is unverified.
- `deriveResultKpis` and the chart record projections convert string-encoded numerics through `Number()` for DISPLAY only. An integer-shaped scalar is grouped digit-wise and stays exact, but a fractional value above 2^53 would render rounded. Neither ever flows back into a row.
- `resolvePkCastScale` fails closed: a malformed exact-numeric PK value now returns `bad_request` where it previously composed a query. The UI cannot produce that state (`pkForRow` already refuses `number` cells on exact-numeric columns), but a hand-built RPC frame would see the new error.
