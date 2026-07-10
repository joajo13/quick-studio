---
title: 'Single guarded Core executor — two request shapes, confirmation by shape, adversarial guard'
type: 'feature'
created: '2026-07-09'
status: 'done'
baseline_revision: '333870a4d5b53525e1b03fad699a2b4b36f14323'
review_loop_iteration: 3
followup_review_recommended: true
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Epic 3 lets developers mutate live databases (edit/insert/delete rows, create tables, run ad-hoc SQL). Today the Core has no SQL execution path and no risk classifier — nothing stops a hand-written or (later) AI-generated statement from silently mutating or dropping data. This is the linchpin story: the executor must exist and be proven before any row-editing UI (AR-3, AD-4).

**Approach:** Build one Core-owned executor that is the sole system-wide risk classifier. It accepts exactly two request shapes and sets confirmation policy by shape: **(a) structured single-row DML / CREATE TABLE** — the Core composes parameterized SQL from typed fields (can never widen to raw/multi-row/DDL beyond CREATE TABLE); **(b) raw SQL text** — opaque text classified default-deny, multi-statement rejected. Ships with an adversarial test battery. Backend-only: no UI in this story.

## Boundaries & Constraints

**Always:**
- All mutation flows through this ONE executor; every statement it runs is parameterized (values never string-spliced; identifiers only via engine-correct quoting).
- Confirmation is enforced by the executor, never by a UI dialog. A statement requiring confirmation is NOT executed unless the request carries explicit `confirmed: true`; without it the executor returns `confirmation_required` and runs nothing.
- Path (a) can only ever emit a single primary-key-addressed row-level `INSERT`/`UPDATE`/`DELETE` or a `CREATE TABLE`. It can carry no raw SQL, no multiple statements, no arbitrary DDL, no multi-row/unfiltered mutation.
- Path (a) policy: `INSERT`, single-row `UPDATE`, `CREATE TABLE` auto-commit; row `DELETE` requires confirmation.
- Path (b) policy: only a leading `SELECT`/`SHOW` auto-runs (read). Everything else (`UPDATE`/`DELETE`/`INSERT`/`DROP`/`TRUNCATE`/`ALTER`/`CREATE`/`WITH`/`EXPLAIN`/unknown) is default-deny → requires confirmation. Multi-statement input is rejected so no destructive statement rides behind a safe one.
- Engine-specific SQL and quoting stay inside the Core/driver; rings above see one engine-neutral request/result shape (postgres + mysql).
- Errors follow the existing wire contract: results/confirmation are domain outcomes inside a successful `okReply` (discriminated by `status`, mirroring `ConnectResult`); protocol violations (smuggling, multi-statement, malformed params) return a `bad_request` envelope. Raw engine error text is never echoed to the client `detail`.

**Block If:**
- The adversarial battery cannot demonstrate that path (a) is un-widenable to a destructive statement, or that path (b) statement-splitting is not defeated by comment/string/dollar-quote/backtick tricks — i.e. the hand-rolled classifier proves insufficient and a real SQL parser dependency is genuinely required to meet the guarantee. (Adopting a new third-party parser is a decision to escalate, not make unattended.)

**Never:**
- Do not build any UI (query Tab wiring, data grid, row editor, confirmation dialog) — those are Stories 3.2/3.3/3.6. This story is executor + tests only.
- Do not implement full DB-side pagination/virtualization (Story 3.2). A Core-side row cap is the only responsiveness measure here.
- Never introduce a bypass that lets raw SQL enter path (a), or lets a mutating statement auto-run on path (b).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Read (b) | `{shape:"raw", sql:"SELECT * FROM users"}` | Executes; `status:"rows"` with `FrozenData` (Core-capped, `truncated` flag) | — |
| Mutating raw, no confirm (b) | `{shape:"raw", sql:"UPDATE users SET x=1"}` | Not executed; `status:"confirmation_required"` with SQL preview + risk | — |
| Mutating raw, confirmed (b) | same + `confirmed:true` | Executed; `status:"ok"` with `rowsAffected` | — |
| Multi-statement (b) | `"SELECT 1; DROP TABLE users"` | Rejected — `bad_request`; nothing executed | `bad_request` "multiple statements not allowed" |
| Comment/casing tricks (b) | `"sElEcT 1 -- ; DROP"`, `"SELECT/*x*/1"`, `"SELECT ';'"`, pg `$$;$$`, mysql `` `a;b` `` | Correctly treated as ONE statement; `;` inside comment/string/dollar-quote/backtick is not a separator | — |
| Structured insert (a) | `{shape:"structured", op:{kind:"insert", table, columns:[...]}}` | Composes parameterized `INSERT`; auto-commits; `status:"ok"` | — |
| Structured single-row update (a) | `{kind:"update", table, pk:{col,val}, set:[...]}` | Parameterized `UPDATE ... WHERE pk=$` (exactly one row); auto-commits | — |
| Structured delete (a) | `{kind:"delete", table, pk:{col,val}}`, no confirm | `confirmation_required`; with `confirmed:true` → parameterized single-row `DELETE`, `status:"ok"` | — |
| Structured create table (a) | `{kind:"createTable", table, columns:[...], primaryKey}` | Parameterized/identifier-quoted `CREATE TABLE`; auto-commits | — |
| Path-(a) escalation attempt | value/identifier containing SQL (`id"; DROP`), pk as array/multiple, extra statements, `DROP`/`ALTER` kind, missing pk on update/delete | Rejected — `bad_request`; unreachable widening. Values parameterized, identifiers quote-escaped | `bad_request` with neutral reason |
| Unknown/empty statement (b) | `""`, `"FOOBAR"` | Empty → `bad_request`; unknown verb → default-deny `confirmation_required` | `bad_request` for empty |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- dependency-free wire contract. Home of new `ExecuteRequest`/`StructuredOp`/`ExecuteResult` types. Reuse `FrozenData`/`encode`, `okReply`/`errorReply`, existing `bad_request` code (no new code needed).
- `src/core/driver.ts` -- engine-neutral `Driver` interface (currently `connect`/`listSchema`/`close`). Add a parameterized row-returning `query()` + `DriverQueryResult`/`DriverColumn`, and a read-only-transaction read runner (a `queryReadOnly()` method, or a `readOnly` option on `query()`) that runs the statement inside an engine read-only transaction and rolls back.
- `src/core/driver-postgres.ts` -- postgres.js adapter. Implement `query` via `sql.unsafe(text, params)`; map result columns/rows/count.
- `src/core/driver-mysql.ts` -- mysql2 adapter (already positional `?`-parameterizes). Implement `query` via `conn.query({sql, rowsAsArray:true}, params)`; map `fields`→columns, `affectedRows`.
- `src/core/connection.ts` -- `ConnectionManager` (single memoized Core connection). Add `query(sql, params)` delegating to the live driver, and a read-only-transaction runner delegating to the driver's read-only read path (feeds the executor's `runReadOnly` seam).
- `src/core/executor.ts` -- **NEW.** `createExecutor({ runQuery, runReadOnly, getEngine, getSchema, quoteIdent })`: raw-SQL classifier/splitter, structured-op composer, structured update/delete single-column-PK verification against the live schema, `SELECT`/`SHOW`-with-`INTO` denial, confirmation gating, driver-row → `FrozenData` cell mapping. `runReadOnly(sql, params)` executes an auto-classified read inside an engine read-only transaction (rolled back); `runQuery` is used for confirmed raw mutations and structured DML. Pure except the injected seams. `getSchema` resolves the live DB schema (Story-3.2 introspection, includes per-column primary-key flags) lazily off the connection, like `getEngine`.
- `src/core/rpc.ts` -- add `execute` handler + `execute` capability on `RpcContext` (return `bad_request` via `preformed`, results via `okReply`).
- `src/core/server.ts` -- `startCore`: construct executor from `connectionManager.query`, inject into `rpcContext`.
- `src/core/executor.test.ts` -- **NEW.** Adversarial battery + I/O-matrix unit tests via a fake `runQuery`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- Add `ExecuteRequest` (discriminated by `shape:"raw"|"structured"`, each with optional `confirmed:boolean`), `StructuredOp` (`insert`/`update`/`delete`/`createTable` with typed table/column/pk/value fields — no raw-SQL field), and `ExecuteResult` union: `{status:"rows", data:FrozenData, truncated:boolean}` | `{status:"ok", rowsAffected:number}` | `{status:"confirmation_required", preview:{sql:string, risk:string}}`. Keep dependency-free.
- [x] `src/core/driver.ts` -- Add `query(sql:string, params:unknown[]):Promise<DriverQueryResult>` to `Driver`; `DriverQueryResult = {columns:DriverColumn[], rows:unknown[][], rowsAffected:number}`. Add a read-only read runner (`queryReadOnly(sql, params)`, or a `readOnly` option on `query`) that runs the statement inside an engine read-only transaction and rolls back.
- [x] `src/core/driver-postgres.ts` -- Implement `query`; derive columns from result metadata, rows as arrays, `rowsAffected` from result count. **Raw execution must use the extended/parameterized protocol (not simple query), so a smuggled second `;`-statement is rejected at the driver even if the splitter errs** (see Design Notes "Driver-boundary backstop"). Implement the read-only runner via a read-only transaction (`SET TRANSACTION READ ONLY` / `BEGIN READ ONLY` on a **reserved** connection), then roll back in a `finally`.
- [x] `src/core/driver-mysql.ts` -- Implement `query` using `conn.query({sql:text, rowsAsArray:true}, params)`; map `fields` → column names/types, rows, `affectedRows`. Implement the read-only runner via `START TRANSACTION READ ONLY` (then rollback in a `finally`), keeping `multipleStatements` disabled (default). **Isolate the read-only transaction so concurrent `execute` RPCs cannot interleave and implicit-commit it — pin it to a dedicated/reserved connection or serialize `query`/`queryReadOnly` behind a per-driver async mutex** (see Design Notes "Read-only transaction must be isolated").
- [x] `src/core/connection.ts` -- Add `query(sql, params)` to `ConnectionManager` that ensures-connected then delegates to the memoized driver; respect the `closed` latch. Add the matching read-only-transaction runner delegating to the driver's read-only path.
- [x] `src/core/executor.ts` -- Implement the guarded executor (see Design Notes): comment/string/dollar-quote/backtick-aware statement splitter (reject >1 statement) **with engine-correct string-escape handling (mysql backslash escapes; postgres `E'…'` escape strings) so a `;` inside an escaped string is never mis-split — closes a confirmed-path smuggle — and dropping comment/whitespace-only trailing segments before the multi-statement count**; leading-keyword read/deny classification; **auto-classified reads (`SELECT`/`SHOW`) executed via the `runReadOnly` seam inside an engine read-only transaction, and default-deny any `SELECT`/`SHOW` whose top-level tokens contain `INTO`** (see Design Notes "Auto-run reads must execute read-only"); structured-op composer with engine-correct identifier quoting + parameterized values + single-PK **structural** enforcement AND **semantic single-column-PK verification against the live schema for update/delete** (reject when the addressed column is not the table's single primary-key column — see Design Notes "Single-row enforcement"); duplicate-column rejection; **`value`-key-present enforcement (absent value → `bad_request`, never silent NULL)**; **no raw-text fallback in `createTable` type composition (assert on unvalidated type)**; request-shape validation before acquiring engine/schema/connection; confirmation gating on `confirmed`; driver-row → `FrozenData` mapping with a `MAX_RESULT_ROWS` Core cap.
- [x] `src/core/rpc.ts` -- Register `execute` handler; add `execute` to `RpcContext`; validate params via `asParamsObject`; emit `bad_request` (via `preformed`) for rejects, `okReply` for results/confirmation.
- [x] `src/core/server.ts` -- In `startCore`, build the executor from `connectionManager` (`query` → `runQuery`, the read-only runner → `runReadOnly`, engine + schema resolved off the live connection for `getEngine`/`getSchema`, `quoteIdent`) and inject it into `rpcContext`.
- [x] `src/core/executor.test.ts` -- Unit-test every I/O-matrix row plus the adversarial battery: path (b) statement smuggling / casing / line+block comments / string-literal `;` / postgres dollar-quote / mysql backtick; path (a) structured-field injection, PK tampering (array/multiple/missing), DDL/multi-row escalation, raw-SQL-in-field, duplicate columns. **Single-row-enforcement cases: `update`/`delete` where `pk.column` is a non-unique/non-PK column, where the table's PK is composite, and where the table is unknown → all `bad_request`, `runQuery` never called; and the happy path where `pk.column` IS the single primary-key column → composes and runs.** **Read-only-execution cases: an auto-classified read (`SELECT`/`SHOW`) is dispatched via `runReadOnly` (not `runQuery`); `SELECT … INTO …` / `SELECT … INTO OUTFILE …` → default-deny (`confirmation_required`), never `runReadOnly`/`runQuery`. Value-required cases: a column value or pk with the `value` key absent → `bad_request` (distinct from an explicit `null`). CreateTable type composition never falls back to raw text. String-escape smuggle cases: a backslash/E-string statement-smuggle attempt — mysql `… '\'; DROP …'` and postgres `… E'\'' ; DROP …` — is correctly seen as MULTIPLE statements → `bad_request`, nothing executed (assert on both confirmed and unconfirmed). Trailing-comment case: `SELECT 1; -- done` (and `/* … */`) is ONE statement, not a multi-statement rejection.** Driver-level: a read-only-transaction isolation test / mysql serialization test as feasible in the driver's own test file, and (postgres) a driver test that a multi-statement raw string is rejected by the execution path. Assert composed SQL is parameterized and identifiers are quote-escaped. Use fakes for `runQuery`/`runReadOnly` capturing `(sql, params)` and a fake `getSchema` returning controllable primary-key metadata.

**Acceptance Criteria:**
- Given a `SELECT` on the raw path, when executed, then the executor runs it and returns a Core-capped `FrozenData` result grid (`status:"rows"`).
- Given a raw mutating/DDL statement (`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`/`ALTER`), when submitted without `confirmed:true`, then it is not executed and `confirmation_required` is returned; the executor — not a dialog — is the gate.
- Given multi-statement raw input, when submitted, then it is rejected so no destructive statement rides behind a safe one.
- Given any attempt to smuggle raw SQL, extra statements, arbitrary DDL, or an unfiltered/multi-row mutation through the structured path, when submitted, then the executor rejects it; path (a) yields only one parameterized PK-addressed row statement or a `CREATE TABLE`.
- Given the story ships, then it ships with an adversarial test battery covering bypass attempts on both paths, and `bun test` passes.

## Design Notes

**Raw-path classifier (path b).** Scan char-by-char with a small state machine so `;` is only a separator at top level. States: single-quote string `'…'`, double-quote identifier `"…"`, backtick identifier `` `…` `` (mysql), line comment `-- … \n`, block comment `/* … */`, postgres dollar-quote `$tag$ … $tag$`. **String-escape handling — MANDATORY (engine-correct):** a single-quote string ends only where the ENGINE would end it, or the splitter can under-count and merge a hidden `;`-separated statement. SQL doubles `''` (both engines). Additionally: (i) **mysql** default strings treat a backslash as an escape — `\'` does NOT end the string (consume the escaped char); (ii) **postgres** escape-strings `E'…'`/`e'…'` treat `\'` as an escape too (standard `'…'` postgres strings do not — backslash is literal there). If the splitter honored only `''`-doubling, a crafted `E'\''` (postgres) or `'\''` (mysql) would desynchronize the splitter from the engine and let `… ; DROP …` ride inside what the engine sees as two statements — a real smuggle on the **confirmed** committing path. The splitter MUST track these backslash/E-string escapes so its statement boundaries match the target engine. Split into statements; before counting, **drop any segment that tokenizes to zero top-level words (comment/whitespace-only)** — a trailing comment after a terminating `;` (e.g. `SELECT 1; -- done`) is not a second statement. `>1` remaining non-empty statement → reject `bad_request`.

**Driver-boundary backstop for raw execution (postgres) — defense-in-depth.** The splitter is the primary guard, but postgres.js `sql.unsafe(text)` with no bind parameters uses the simple-query protocol, which executes ALL `;`-separated commands — so on postgres the splitter is the ONLY thing standing between a smuggled `;` and execution (mysql is backstopped by mysql2's `multipleStatements:false` default). Add a driver-level backstop so splitter correctness is not solely load-bearing on postgres: the raw-execution path must not run through a multi-statement-capable protocol — execute raw text via the extended/parameterized protocol (which rejects multiple commands) rather than the simple protocol, so a smuggled second statement is refused at the driver even if the splitter ever errs. If postgres.js cannot force this for a given call, document the residual precisely rather than silently relying on the simple protocol. For the single statement, strip leading comments/whitespace, read the first keyword upper-cased: `SELECT`/`SHOW` → read (auto-run); anything else → default-deny (`confirmation_required`). Empty → `bad_request`. Default-deny means a misclassification always fails safe (asks for confirmation), never auto-runs a mutation. Note: `EXPLAIN ANALYZE` can execute its inner statement, so `EXPLAIN` is deliberately NOT auto-run.

**Auto-run reads must execute read-only (path b) — MANDATORY.** Leading-keyword classification is necessary but NOT sufficient: a `SELECT`-led statement can still have write side effects that a keyword check cannot see — e.g. postgres `SELECT … INTO new_table …` (this is `CREATE TABLE AS`, a DDL write), mysql `SELECT … INTO OUTFILE/DUMPFILE '…'` (writes a server file), and volatile/writing function calls (`SELECT nextval('s')`, `SELECT setval(...)`, `SELECT my_writing_function()`, `SELECT pg_terminate_backend(...)`). Under the previous rule these auto-ran with `confirmed` never checked, silently mutating — a direct violation of the intent-contract Never "lets a mutating statement auto-run on path (b)". So the executor MUST run every auto-classified read (leading `SELECT`/`SHOW`) inside an engine-level **read-only transaction** (postgres `BEGIN`/`SET TRANSACTION READ ONLY`; mysql `START TRANSACTION READ ONLY`), then roll back. Any write attempt (INTO, sequence/volatile writes, DDL) then fails at the engine and surfaces as a normal error result rather than a committed mutation — turning a misclassification into a safe failure instead of a silent write. **Belt-and-suspenders:** additionally, before auto-running, deny (default-deny → `confirmation_required`) any `SELECT`/`SHOW` statement whose top-level token stream contains `INTO` (a read-only transaction does not block mysql `INTO OUTFILE`, which writes the filesystem rather than a table). Confirmed raw mutations and structured DML still run through the normal (non-read-only) path — this read-only wrapping applies ONLY to auto-classified reads.

**Read-only transaction must be isolated — MANDATORY.** The read-only guarantee only holds if the `BEGIN`/statement/`ROLLBACK` sequence cannot interleave with another query on the same connection. Postgres does this by reserving a connection (`sql.reserve()` + `finally release()`). Mysql MUST get equivalent isolation — the multi-step transaction is NOT atomic across `await` points, so on a shared single connection two concurrent `execute` RPCs can interleave as `A:START, B:START, A:stmt, …`; because mysql `START TRANSACTION` implicitly commits the in-flight transaction, B's START drops A's READ-ONLY scope and A's statement then runs (and can commit a write) OUTSIDE the read-only transaction. Do NOT rely on an unproven "the single connection is not concurrent" assumption. Pin the read-only transaction to a dedicated/reserved connection (or serialize `query`/`queryReadOnly` behind a per-driver async mutex), and release/settle it in a `finally` so a failed rollback cannot leave the connection wedged mid-transaction. **Known limitation (out of scope):** a read whose write side effect executes on a SEPARATE backend — postgres `dblink_exec(...)`, `postgres_fdw`, or an untrusted-language function opening its own connection — is not governed by this transaction; such extension-dependent escapes are a documented residual, not a mainstream vector, and are not covered by this story.

**Structured composer (path a).** Only these shapes exist as types — there is no field to carry raw SQL, so widening is unrepresentable, not just rejected. Validate at runtime anyway: exactly one pk column/value for update/delete, ≥1 column for insert, non-empty identifiers, no duplicate column identifiers in an insert column list or update `set` list, and the `value` key present on every column value and pk (an absent `value` is `bad_request`, NOT a silent SQL `NULL` — only an explicit `null` binds NULL; an absent pk value must never compose `WHERE pk=NULL` and silently no-op). Reject all of these as `bad_request`. The `createTable` type/constraint composer must have **no raw-text fallback**: it composes only from the validated/canonical allowlist output; an unvalidated type token is an invariant violation (throw/assert), never spliced verbatim into the DDL. Quote every identifier with engine rules (postgres `"x"` with `"`→`""`; mysql `` `x` `` with `` ` ``→`` `` ``), and bind every value as a parameter. Compose e.g. `UPDATE "t" SET "a"=$1 WHERE "id"=$2` (postgres) / `UPDATE \`t\` SET \`a\`=? WHERE \`id\`=?` (mysql). `createTable` composes a single `CREATE TABLE` from typed column defs; reject any type/constraint token that isn't from a fixed allowlist.

**Single-row enforcement for structured update/delete (path a) — MANDATORY.** A composed `WHERE <pk.column>=$n` addresses exactly one row **only if `pk.column` is a unique/primary key**. The `StructuredPk` type is structural (one column, one value) and cannot by itself prove uniqueness, so the executor MUST verify it semantically against the live schema before composing an auto-committing `UPDATE` or a `DELETE`: resolve the target table via the injected `getSchema()` (the Story-3.2 schema already carries per-column primary-key flags), require that the table's primary key is a **single column** and that `pk.column` equals it. If the table is not found, has a composite (multi-column) primary key, or `pk.column` is not that single primary-key column, **reject with `bad_request`** ("update/delete requires a single-column primary key that matches the addressed column") — never compose a statement whose `WHERE` could match more than one row. This closes the only way path (a) can widen to a multi-row/unfiltered mutation and keeps the intent-contract invariant "no multi-row/unfiltered mutation" enforced by the executor rather than trusted from the caller. (`INSERT` and `CREATE TABLE` need no such check; `DELETE` still additionally requires `confirmed:true`.) Validate request shape and field types (e.g. `req.sql` is a string on path b; `op` fields present/typed on path a) **before** acquiring the engine/schema/connection, so a malformed request returns `bad_request` without a wasted connection round-trip.

**Confirmation gating.** `policy = classify(request)` → `auto | needs-confirm | reject`. `reject` → `bad_request`. `needs-confirm && !confirmed` → return `confirmation_required` (with a preview of the composed/echoed SQL and a short risk string), execute nothing. `auto` or `needs-confirm && confirmed` → run via `runQuery`.

**Cell mapping.** Map driver row values → `FrozenCell` then `encode()`: `null`/`undefined`→null; `boolean`→boolean; finite `number`→number; `Date`→date ISO-UTC; everything else (bigint, pg numeric/bigint strings, Buffer, object)→string. Cap rows at `MAX_RESULT_ROWS` (e.g. 1000), set `truncated`. Known limitation: sub-second timestamp precision and non-finite numbers ride on the contract's existing `encode` invariants — see deferred-work notes (untrusted `decode`, frozen-date precision); full pagination is Story 3.2.

## Verification

**Commands:**
- `bun test src/core/executor.test.ts` -- expected: all executor + adversarial-battery tests pass.
- `bun test` -- expected: full suite green (no regression in rpc/driver/contract tests).
- `bunx tsc --noEmit` -- expected: no type errors (new contract types + driver method wired end-to-end).

## Spec Change Log

### 2026-07-10 — Amendment (review loop iteration 1)

- **Triggering finding** (`high`, `bad_spec`): the structured composer emitted `UPDATE/DELETE ... WHERE <pk.column>=$n` trusting that the caller-supplied `pk.column` is a unique/primary key. `StructuredPk` is structural only, so a non-unique `pk.column` (e.g. `status`) produced a multi-row `UPDATE` that **auto-commits** with no confirmation — a direct violation of the intent-contract invariant "no multi-row/unfiltered mutation" and "single primary-key-addressed row". The executor, being "the sole system-wide risk classifier", must enforce this, not trust the caller (the story's threat model explicitly includes AI-generated ops).
- **What was amended** (all OUTSIDE `<intent-contract>`):
  - Design Notes → added "Single-row enforcement for structured update/delete (path a) — MANDATORY": verify `pk.column` against the live schema's single-column primary key via an injected `getSchema()`; reject (`bad_request`) on table-not-found / composite PK / non-PK column; validate request shape/types before acquiring the connection; reject duplicate columns.
  - Code Map → `createExecutor` deps extended to `{ runQuery, getEngine, getSchema, quoteIdent }`.
  - Tasks → `executor.ts`, `server.ts`, `executor.test.ts` updated to require and test semantic PK verification, duplicate-column rejection, and pre-connection shape validation.
- **Known-bad state avoided:** an auto-committing structured `UPDATE`/`DELETE` whose `WHERE` can match more than one row when the caller mislabels a non-unique column as `pk`.
- **KEEP instructions (must survive re-derivation):**
  - The whole raw-path guard: char-by-char statement splitter that is comment/single-quote-string(`''`)/double-quote-ident/mysql-backtick/postgres-`$tag$`-dollar-quote aware, rejecting `>1` statement; leading-keyword `SELECT`/`SHOW`→auto-run else default-deny classifier. This proved sufficient WITHOUT any third-party SQL parser — do NOT add a parser dependency.
  - Structured composer: every value bound as a parameter (never string-spliced); every identifier engine-quote-escaped (postgres `"`→`""`, mysql `` ` ``→`` `` ``); structural validation (one pk col/val for update/delete, ≥1 col for insert, non-empty identifiers); `createTable` from typed defs with a fixed type/constraint allowlist; `INSERT`/single-row-`UPDATE`/`CREATE TABLE` auto-commit, row `DELETE` needs `confirmed:true`.
  - Confirmation gating (`auto | needs-confirm | reject`) enforced by the executor; `bad_request` via `preformed` for protocol violations, domain outcomes inside `okReply`; raw engine error text never echoed to `detail`.
  - Driver-row → `FrozenData` cell mapping with `MAX_RESULT_ROWS = 1000` cap + `truncated` flag; the `DriverQueryResult.rowsAffected` additions to both driver adapters; the `execute` rpc handler + `RpcContext.execute` wiring.
  - The full adversarial + I/O-matrix test battery (was 54 tests, all green) — re-create it and ADD the new single-row-enforcement cases.

### 2026-07-10 — Amendment (review loop iteration 2)

- **Triggering finding** (`high`, `bad_spec`, flagged independently by both reviewers): the raw-path classifier auto-ran ANY statement whose leading keyword is `SELECT`/`SHOW`, but a `SELECT`-led statement can have write side effects the keyword check can't see — postgres `SELECT … INTO t` (= `CREATE TABLE AS`, DDL), mysql `SELECT … INTO OUTFILE '…'` (server file write), and volatile/writing function calls (`SELECT nextval(...)`, `SELECT setval(...)`, `SELECT writing_fn()`, `SELECT pg_terminate_backend(...)`). These auto-committed with `confirmed` never checked — a direct violation of the intent-contract Never "lets a mutating statement auto-run on path (b)". NOT fail-safe (silent mutation, not over-rejection).
- **What was amended** (all OUTSIDE `<intent-contract>`):
  - Design Notes → added "Auto-run reads must execute read-only (path b) — MANDATORY": run every auto-classified read inside an engine read-only transaction (rolled back) so any write attempt fails at the engine; plus default-deny any `SELECT`/`SHOW` containing a top-level `INTO` (read-only tx does not block mysql `INTO OUTFILE`).
  - Design Notes (Structured composer) → require the `value` key present on every column value / pk (absent → `bad_request`, never silent `NULL`); forbid any raw-text fallback in `createTable` type composition (assert on unvalidated type).
  - Code Map → executor deps add `runReadOnly`; `driver.ts`/`driver-postgres.ts`/`driver-mysql.ts`/`connection.ts` gain a read-only-transaction read runner.
  - Tasks → executor/driver/connection/server/test tasks updated for read-only execution, `INTO` denial, value-required, no-raw-fallback, and their tests.
- **Known-bad state avoided:** a `SELECT`-led statement with write side effects (INTO/CTAS/OUTFILE/volatile-write-function) auto-committing on the read path with no confirmation.
- **KEEP instructions (must survive re-derivation):** everything from the iteration-1 KEEP list PLUS the now-solid **`verifySingleColumnPk`** semantic single-column-PK verification for structured update/delete (reviewers confirmed it correctly rejects unknown/composite/non-PK/cross-schema with `runQuery` never called — do not regress it), the splitter's fail-closed behavior (over-counts separators, never under-counts for the target engine — reviewers found no smuggle), duplicate-column rejection, and pre-connection shape validation. Confirmed raw mutations and structured DML must still use the normal (non-read-only) run path.

### 2026-07-10 — Amendment (review loop iteration 3)

- **Triggering finding** (`high`, `bad_spec`): the splitter's single-quote-string state only treated doubled `''` as an escape, not engine backslash escapes. On postgres, a crafted escape-string `E'\''` (and mysql `'\''`) desynchronizes the splitter from the engine's parse in the UNDER-count direction, merging a hidden `;`-separated statement into one segment so it passes the `>1 statement` gate. Concrete postgres exploit: `UPDATE t SET c=E'\'' ; DROP TABLE users` with `confirmed:true` → splitter sees one statement, leading verb stays the confirmed-safe `UPDATE`, and postgres.js `sql.unsafe(text)` (simple protocol) runs BOTH statements → the `DROP` executes. This defeats the intent-contract "Multi-statement input is rejected so no destructive statement rides behind a safe one". (Mysql is backstopped by `multipleStatements:false`; postgres is the live vector.)
- **Secondary findings folded in:**
  - MySQL `queryReadOnly` ran `START TRANSACTION READ ONLY`/stmt/`ROLLBACK` on the shared single connection with no reservation/mutex/`finally`; concurrent `execute` RPCs can interleave and (via mysql's implicit-commit-on-START) drop the read-only scope, letting a mis-classified write commit — the iteration-2 guarantee eroded on mysql under concurrency.
  - A trailing comment after a terminating `;` (`SELECT 1; -- done`) was counted as a second statement → valid single statement falsely rejected (`bad_request`).
  - Postgres simple-query protocol executes all `;`-chained commands, so the splitter was the SOLE guard on postgres (deferred from passes 1–2).
- **What was amended** (all OUTSIDE `<intent-contract>`):
  - Design Notes (Raw-path classifier) → "String-escape handling — MANDATORY": splitter must track mysql backslash escapes and postgres `E'…'` escape strings so string boundaries match the engine; drop comment/whitespace-only trailing segments before the multi-statement count.
  - Design Notes → "Driver-boundary backstop for raw execution (postgres)": run raw text via the extended/parameterized protocol (rejects multiple commands) so splitter correctness is not solely load-bearing on postgres.
  - Design Notes (read-only) → "Read-only transaction must be isolated — MANDATORY": pin the mysql read-only tx to a reserved connection or a per-driver mutex, release in `finally`; documented the dblink/fdw out-of-scope residual.
  - Code Map/Tasks → driver-postgres (extended protocol + reserved read-only conn), driver-mysql (isolated read-only tx + finally), executor (escape-aware splitter + comment-only segment drop), and their tests.
- **Known-bad state avoided:** a destructive statement (`DROP`/`DELETE`/…) riding behind a confirmed-safe leading verb through a backslash/E-string escape on postgres; and a concurrency-eroded read-only guarantee on mysql.
- **KEEP instructions (must survive re-derivation):** everything from the iteration-1 and iteration-2 KEEP lists (splitter comment/`''`/`""`/backtick/dollar-quote handling; leading-keyword default-deny; `runReadOnly` read-only execution + `INTO` denial; `verifySingleColumnPk`; structured composer parameterization + identifier quoting + value-required + no-raw-type-fallback; confirmation gating; `FrozenData` cap; `execute` rpc/server wiring). All three prior fixes were confirmed solid by pass-3 reviewers — do NOT regress them. The escape-handling addition must only make the splitter MORE conservative (still fail-closed for the read path), never open a new auto-run path.

## Review Triage Log

### 2026-07-10 — Review pass 1
- intent_gap: 0
- bad_spec: 1: (high 1, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Structured `UPDATE`/`DELETE` composed `WHERE <pk.column>=$n` trusting a caller-labeled `pk` without verifying it is the table's single-column primary key → a non-unique `pk.column` yields a multi-row, auto-committed mutation (violates intent-contract "no multi-row/unfiltered mutation"). Amended Design Notes ("Single-row enforcement") + Code Map + Tasks to require schema-based single-column-PK verification; reverted code for re-derivation. Lower-tier findings (raw-splitter MySQL-tokenization gaps, postgres `sql.unsafe` simple-protocol defense-in-depth, `RETURNING`-row discard, engine-blind `createTable` allowlist, parenthesized-SELECT confirmation, pre-existing UTF-16 driver encoding) are moot this pass and will be re-triaged against the re-derived code.

### 2026-07-10 — Review pass 2
- intent_gap: 0
- bad_spec: 1: (high 1, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Raw classifier auto-ran `SELECT`/`SHOW`-led statements with write side effects (`SELECT … INTO`/CTAS, mysql `INTO OUTFILE`, volatile/writing functions) with `confirmed` never checked → silent mutation, violating intent-contract Never "lets a mutating statement auto-run on path (b)". Amended Design Notes (read-only-transaction execution for auto-runs + `INTO` denial), plus folded composer value-required + no-raw-type-fallback hardening; extended Code Map/Tasks (driver/connection read-only runner). Reverted code for re-derivation. Pass-1 `verifySingleColumnPk` fix confirmed solid by both reviewers. Lower-tier findings (post-materialization row cap / no fetch `LIMIT` — explicitly scoped to Story 3.2 by the spec; engine-blind splitter defense-in-depth — fail-closed today; backslash/E-string splitter divergence — fail-closed; pre-existing UTF-16 driver encoding) are moot this pass and will be re-triaged against the re-derived code.

### 2026-07-10 — Review pass 3
- intent_gap: 0
- bad_spec: 1: (high 1, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Splitter honored only `''`-doubling, not engine backslash/`E'…'` escapes → a postgres `E'\''` (mysql `'\''`) desyncs the splitter in the under-count direction, smuggling `; DROP …` behind a confirmed-safe leading verb; postgres.js simple protocol then runs both. Amended Design Notes (engine-correct string-escape handling; postgres extended-protocol driver backstop; comment-only trailing-segment drop; mysql read-only-tx isolation; dblink/fdw known-limitation) + Code Map/Tasks. Reverted code for re-derivation. Pass-1 (`verifySingleColumnPk`) and pass-2 (read-only execution + INTO denial) fixes confirmed solid by both reviewers. Folded secondary findings (mysql read-only isolation, trailing-comment false-reject, postgres simple-protocol backstop) into the same amendment. Residual dblink/fdw write-escape documented as out of scope.

### 2026-07-10 — Review pass 4
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 4: (medium 1, low 3)
- reject: 0
- addressed_findings:
  - `[medium]` `[patch]` MySQL's multi-statement smuggle backstop was conditional — `mysql.createConnection(url)` let a `?multipleStatements=true` URI param re-enable client multi-statements, and the splitter treated `--` as a comment for both engines while real MySQL requires `-- ` (space), so `UPDATE t SET x=1 --3;DROP TABLE users` hid a `;`. Fixed: `buildMysqlConfig` pins `multipleStatements=false` in the URL AND the options (mysql2 only preserves *truthy* explicit options, so the URL param itself is overwritten) — the backstop is now unconditional like postgres's `{simple:false}`; and the splitter's `--` rule is now engine-aware (mysql: only a comment when followed by whitespace/control/EOL). Test: mysql `--3;DROP` smuggle → `bad_request`, nothing runs.
  - `[low]` `[patch]` `StructuredColumnDef.primaryKey` was advertised in the contract but silently ignored by the composer (column-level `primaryKey:true` composed a table with no PK, breaking later PK-verified update/delete). Fixed: `executeCreateTable` now honors column-level `primaryKey` flags, folding them (order-preserving, deduped union) into the effective PK set with the table-level `primaryKey` array; PK identifiers stay quote-escaped.
  - defer (appended to `deferred-work.md`): (medium) auto-read result set materialized before the row cap / no fetch `LIMIT` — memory bound, spec-scoped to Story 3.2 pagination; (low) engine-blind `createTable` type allowlist (postgres-only tokens fail opaquely on mysql, fail-closed); (low) postgres duplicate output-column-name mapping collapses same-named columns (pre-existing Story-3.2 by-name row mapping, exposed by raw SELECT); (low) splitter assumes default session SQL modes (`standard_conforming_strings=on`, default mysql `sql_mode`) — non-default modes over-reject (safe) or are backstopped by `multipleStatements:false`.
  - Pass-4 reviewers confirmed all three prior high-severity fixes (`verifySingleColumnPk`; read-only execution + `INTO` denial; escape-correct splitter + `{simple:false}` backstop + mysql mutex) are genuinely closed with no new under-count/auto-run-write path. Loop converged: no intent_gap or bad_spec this pass.

## Auto Run Result

Status: done

**Implemented change.** A single Core-owned guarded SQL executor (`src/core/executor.ts`) — the sole system-wide risk classifier for DB mutation. Two request shapes: (a) **structured** single-row DML / `CREATE TABLE` composed from typed fields (values always parameter-bound, identifiers engine-quote-escaped, and structured `UPDATE`/`DELETE` semantically verified against the live schema so the addressed column is the table's single-column primary key — a non-unique column is rejected, never a multi-row auto-commit); (b) **raw** SQL text classified default-deny by an engine-aware, escape-correct char splitter that rejects multi-statement input. Auto-classified reads (`SELECT`/`SHOW`) run inside an engine read-only transaction and any read carrying a top-level `INTO` is default-denied, so a mis-classified write (CTAS / `INTO OUTFILE` / volatile-writing function) fails at the engine instead of committing. Postgres raw execution forces the extended protocol and MySQL forces `multipleStatements:false` + serializes the read-only transaction, so a smuggled second statement is refused at the driver even if the splitter erred. Backend only — no UI. Confirmation is enforced by the executor (never a dialog); protocol violations return `bad_request`, domain outcomes ride inside `okReply`, raw engine error text is never echoed.

**Files changed** (since baseline `333870a`):
- `src/shared/contract.ts` — new `ExecuteRequest` / `StructuredOp` / `StructuredColumnValue` / `StructuredPk` / `StructuredColumnDef` / `ExecuteResult` wire types (dependency-free).
- `src/core/executor.ts` (NEW) — the guarded executor: escape-correct splitter, default-deny classifier, read-only auto-run + `INTO` denial, structured composer, `verifySingleColumnPk`, value-required + no-raw-type-fallback, `FrozenData` cell mapping capped at `MAX_RESULT_ROWS=1000`.
- `src/core/driver.ts` / `driver-postgres.ts` / `driver-mysql.ts` — `DriverQueryResult.rowsAffected`; `queryReadOnly` (postgres reserved-connection read-only tx; mysql mutex-serialized `START TRANSACTION READ ONLY`); postgres extended-protocol raw execution; `buildMysqlConfig` forcing `multipleStatements:false`.
- `src/core/connection.ts` — `queryReadOnly` on `ConnectionManager`.
- `src/core/rpc.ts` / `server.ts` — `execute` handler + `RpcContext.execute`; executor built from the connection manager and injected.
- `src/core/executor.test.ts` (NEW) — adversarial + I/O-matrix battery. Fakes updated in `rpc.test.ts` / `connection.test.ts` / `server.test.ts` / `driver.test.ts`.

**Review findings breakdown** (4 passes): 3 high-severity `bad_spec` findings caught and fixed via spec-amendment + re-derivation loopbacks — (1) structured `UPDATE`/`DELETE` could auto-commit a multi-row mutation when the caller mislabeled a non-unique column as `pk` (→ live-schema single-column-PK verification); (2) `SELECT`-led statements with write side effects (`INTO`/CTAS/writing functions) auto-ran with no confirmation (→ read-only-transaction execution + `INTO` denial); (3) a backslash/`E'…'`-string splitter desync smuggled a destructive statement behind a confirmed-safe verb on postgres (→ engine-correct escape handling + postgres extended-protocol driver backstop). Final pass: 2 patches applied — unconditional MySQL `multipleStatements:false` backstop + MySQL-faithful `--` comment rule, and honoring the advertised column-level `primaryKey` flag. 4 findings deferred to `deferred-work.md` (fetch-bound `LIMIT` → Story 3.2; engine-blind type allowlist; postgres duplicate-column mapping; default-SQL-mode assumption). 0 rejected.

**Follow-up review recommended: true** — the final pass made review-driven, security-relevant changes to the splitter and the MySQL smuggle backstop, and the story is a security-critical guard that went through three deep hardening loops; an independent follow-up review of the final state is warranted.

**Verification** (final state, run by the orchestrator):
- `bun test src/core/executor.test.ts` — pass (executor + adversarial battery).
- `bun test` — 511 pass, 0 fail (27 files; the `table.rows`/`execute` "connection unavailable" stderr lines are intentional internal_error test output).
- `bunx tsc --noEmit` — clean (exit 0).

**Residual risks / known limitations** (see `deferred-work.md`): large auto-reads materialize before the Core row cap (no fetch `LIMIT` — Story 3.2 pagination); engine-blind `createTable` type allowlist fails closed on mismatched engines; postgres duplicate output-column names collapse in the by-name row mapping; the splitter assumes default session SQL modes (non-default `standard_conforming_strings`/`sql_mode` over-reject safely or are backstopped by `multipleStatements:false`); cross-backend writes via `dblink`/`fdw`/untrusted-language functions escape the read-only transaction (documented out-of-scope). None is a live bypass at default configuration.
