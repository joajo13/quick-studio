---
title: 'Single guarded Core executor — two request shapes, confirmation by shape, adversarial guard'
type: 'feature'
created: '2026-07-09'
status: 'in-progress'
baseline_revision: 'ceebd2c632145ca59214d43cf925abf6c3c6169e'
review_loop_iteration: 0
followup_review_recommended: false
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
- `src/core/driver.ts` -- engine-neutral `Driver` interface (currently `connect`/`listSchema`/`close`). Add a parameterized row-returning `query()` + `DriverQueryResult`/`DriverColumn`.
- `src/core/driver-postgres.ts` -- postgres.js adapter. Implement `query` via `sql.unsafe(text, params)`; map result columns/rows/count.
- `src/core/driver-mysql.ts` -- mysql2 adapter (already positional `?`-parameterizes). Implement `query` via `conn.query({sql, rowsAsArray:true}, params)`; map `fields`→columns, `affectedRows`.
- `src/core/connection.ts` -- `ConnectionManager` (single memoized Core connection). Add `query(sql, params)` delegating to the live driver.
- `src/core/executor.ts` -- **NEW.** `createExecutor({ runQuery })`: raw-SQL classifier/splitter, structured-op composer, confirmation gating, driver-row → `FrozenData` cell mapping. Pure except the injected `runQuery`.
- `src/core/rpc.ts` -- add `execute` handler + `execute` capability on `RpcContext` (return `bad_request` via `preformed`, results via `okReply`).
- `src/core/server.ts` -- `startCore`: construct executor from `connectionManager.query`, inject into `rpcContext`.
- `src/core/executor.test.ts` -- **NEW.** Adversarial battery + I/O-matrix unit tests via a fake `runQuery`.

## Tasks & Acceptance

**Execution:**
- [ ] `src/shared/contract.ts` -- Add `ExecuteRequest` (discriminated by `shape:"raw"|"structured"`, each with optional `confirmed:boolean`), `StructuredOp` (`insert`/`update`/`delete`/`createTable` with typed table/column/pk/value fields — no raw-SQL field), and `ExecuteResult` union: `{status:"rows", data:FrozenData, truncated:boolean}` | `{status:"ok", rowsAffected:number}` | `{status:"confirmation_required", preview:{sql:string, risk:string}}`. Keep dependency-free.
- [ ] `src/core/driver.ts` -- Add `query(sql:string, params:unknown[]):Promise<DriverQueryResult>` to `Driver`; `DriverQueryResult = {columns:DriverColumn[], rows:unknown[][], rowsAffected:number}`.
- [ ] `src/core/driver-postgres.ts` -- Implement `query` using `sql.unsafe(text, params)`; derive columns from result metadata, rows as arrays, `rowsAffected` from result count.
- [ ] `src/core/driver-mysql.ts` -- Implement `query` using `conn.query({sql:text, rowsAsArray:true}, params)`; map `fields` → column names/types, rows, `affectedRows`.
- [ ] `src/core/connection.ts` -- Add `query(sql, params)` to `ConnectionManager` that ensures-connected then delegates to the memoized driver; respect the `closed` latch.
- [ ] `src/core/executor.ts` -- Implement the guarded executor (see Design Notes): comment/string/dollar-quote/backtick-aware statement splitter (reject >1 statement); leading-keyword read/deny classification; structured-op composer with engine-correct identifier quoting + parameterized values + single-PK enforcement; confirmation gating on `confirmed`; driver-row → `FrozenData` mapping with a `MAX_RESULT_ROWS` Core cap.
- [ ] `src/core/rpc.ts` -- Register `execute` handler; add `execute` to `RpcContext`; validate params via `asParamsObject`; emit `bad_request` (via `preformed`) for rejects, `okReply` for results/confirmation.
- [ ] `src/core/server.ts` -- In `startCore`, build the executor from `connectionManager.query` and inject it into `rpcContext`.
- [ ] `src/core/executor.test.ts` -- Unit-test every I/O-matrix row plus the adversarial battery: path (b) statement smuggling / casing / line+block comments / string-literal `;` / postgres dollar-quote / mysql backtick; path (a) structured-field injection, PK tampering (array/multiple/missing), DDL/multi-row escalation, raw-SQL-in-field. Assert composed SQL is parameterized and identifiers are quote-escaped. Use a fake `runQuery` capturing `(sql, params)`.

**Acceptance Criteria:**
- Given a `SELECT` on the raw path, when executed, then the executor runs it and returns a Core-capped `FrozenData` result grid (`status:"rows"`).
- Given a raw mutating/DDL statement (`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`/`ALTER`), when submitted without `confirmed:true`, then it is not executed and `confirmation_required` is returned; the executor — not a dialog — is the gate.
- Given multi-statement raw input, when submitted, then it is rejected so no destructive statement rides behind a safe one.
- Given any attempt to smuggle raw SQL, extra statements, arbitrary DDL, or an unfiltered/multi-row mutation through the structured path, when submitted, then the executor rejects it; path (a) yields only one parameterized PK-addressed row statement or a `CREATE TABLE`.
- Given the story ships, then it ships with an adversarial test battery covering bypass attempts on both paths, and `bun test` passes.

## Design Notes

**Raw-path classifier (path b).** Scan char-by-char with a small state machine so `;` is only a separator at top level. States: single-quote string `'…'` (SQL doubles `''`), double-quote identifier `"…"`, backtick identifier `` `…` `` (mysql), line comment `-- … \n`, block comment `/* … */`, postgres dollar-quote `$tag$ … $tag$`. Split into statements; trim; drop trailing empty. `>1` non-empty statement → reject `bad_request`. For the single statement, strip leading comments/whitespace, read the first keyword upper-cased: `SELECT`/`SHOW` → read (auto-run); anything else → default-deny (`confirmation_required`). Empty → `bad_request`. Default-deny means a misclassification always fails safe (asks for confirmation), never auto-runs a mutation. Note: `EXPLAIN ANALYZE` can execute its inner statement, so `EXPLAIN` is deliberately NOT auto-run.

**Structured composer (path a).** Only these shapes exist as types — there is no field to carry raw SQL, so widening is unrepresentable, not just rejected. Validate at runtime anyway: exactly one pk column/value for update/delete, ≥1 column for insert, non-empty identifiers. Quote every identifier with engine rules (postgres `"x"` with `"`→`""`; mysql `` `x` `` with `` ` ``→`` `` ``), and bind every value as a parameter. Compose e.g. `UPDATE "t" SET "a"=$1 WHERE "id"=$2` (postgres) / `UPDATE \`t\` SET \`a\`=? WHERE \`id\`=?` (mysql). `createTable` composes a single `CREATE TABLE` from typed column defs; reject any type/constraint token that isn't from a fixed allowlist.

**Confirmation gating.** `policy = classify(request)` → `auto | needs-confirm | reject`. `reject` → `bad_request`. `needs-confirm && !confirmed` → return `confirmation_required` (with a preview of the composed/echoed SQL and a short risk string), execute nothing. `auto` or `needs-confirm && confirmed` → run via `runQuery`.

**Cell mapping.** Map driver row values → `FrozenCell` then `encode()`: `null`/`undefined`→null; `boolean`→boolean; finite `number`→number; `Date`→date ISO-UTC; everything else (bigint, pg numeric/bigint strings, Buffer, object)→string. Cap rows at `MAX_RESULT_ROWS` (e.g. 1000), set `truncated`. Known limitation: sub-second timestamp precision and non-finite numbers ride on the contract's existing `encode` invariants — see deferred-work notes (untrusted `decode`, frozen-date precision); full pagination is Story 3.2.

## Verification

**Commands:**
- `bun test src/core/executor.test.ts` -- expected: all executor + adversarial-battery tests pass.
- `bun test` -- expected: full suite green (no regression in rpc/driver/contract tests).
- `bunx tsc --noEmit` -- expected: no type errors (new contract types + driver method wired end-to-end).
