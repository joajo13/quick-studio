---
title: 'DW-36: Bound the FETCH (not just the display slice) for auto-classified raw reads'
type: 'bugfix'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
baseline_revision: 'c4c25e4920bd614a42a60663e2d68e35ef894f6b'
final_revision: '0b345da0091536b30afa5b46b6ef902445a46c0e'
---

<intent-contract>

## Intent

**Problem:** In `executeRaw`'s auto-classified read path (`executor.ts`), `runReadOnly(stmt, [])` lets the driver (postgres.js / mysql2) buffer EVERY row into Core memory, and only afterwards does `toRowsResult` slice to `MAX_RESULT_ROWS`. So a `SELECT * FROM huge_table` OOMs the Core process before the 1000-row cap ever applies — the cap bounds the response payload, not the fetch.

**Approach:** Push the bound to the DB by appending `LIMIT MAX_RESULT_ROWS + 1` to the auto-run raw SELECT before it reaches `runReadOnly`, so the driver never materializes more than 1001 rows. The `+ 1` is the sentinel `toRowsResult` already reads to set `truncated`, so a bounded fetch of MAX+1 rows detects "there were more" exactly as an unbounded fetch did — `toRowsResult` needs no change.

## Boundaries & Constraints

**Always:**
- Only auto-classified raw reads (`isRead` true) are affected; the structured path and the confirm/`runQuery` mutation path are untouched.
- Push the bound ONLY when provably syntax-safe to append: the verb is `SELECT` AND the statement carries no top-level `LIMIT` already. A `SHOW` (small fixed metadata; does not reliably accept a trailing `LIMIT`) and an already-`LIMIT`ed statement fall back to today's Core-side cap.
- The appended clause is a Core-computed integer literal (`MAX_RESULT_ROWS + 1`) — never a bound param, never user text. It is preceded by a newline so a trailing line comment (`-- …`) cannot swallow it.
- `truncated`/`data.rows` semantics are byte-identical to today for every result size (0, ≤MAX, >MAX).

**Block If:**
- (none — the change is self-contained and unit-testable against fake seams)

**Never:**
- Do NOT rewrite/wrap statements in a subquery (`SELECT * FROM (<stmt>) …`) — it regresses `SHOW` and MySQL duplicate-column reads (DW-29/DW-38).
- Do NOT touch the driver adapters, the `Driver`/`ConnectionSeams` interfaces, or `queryReadOnly`'s read-only-transaction isolation.
- Do NOT alter classification: what counts as a read, `INTO`/CTAS default-deny, and the multi-statement rejection stay exactly as-is.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unbounded read | `SELECT * FROM users` | `runReadOnly` receives `SELECT * FROM users\nLIMIT 1001` | No error expected |
| Already limited | `SELECT * FROM t LIMIT 5` | passed verbatim (top-level `LIMIT` present) | No error expected |
| SHOW read | `SHOW TABLES` | passed verbatim (not a `SELECT`) | No error expected |
| Trailing line comment | `SELECT * FROM t -- note` | `LIMIT 1001` appended on a NEW line, not inside the comment | No error expected |
| Inner LIMIT only | `SELECT * FROM (SELECT a FROM t LIMIT 5) x` | passed verbatim (a top-level `LIMIT` word is present) | No error expected |
| Truncation sentinel | read returns MAX+1 rows | `data.rows.length === MAX_RESULT_ROWS`, `truncated === true` | No error expected |
| Exact fit | read returns exactly MAX rows | all rows returned, `truncated === false` | No error expected |
| Mutation path | `DELETE FROM users` (confirmed) | `runQuery` sql is unchanged (no `LIMIT`) | No error expected |

</intent-contract>

## Code Map

- `src/core/executor.ts` -- `executeRaw` read branch (line ~377) calls `runReadOnly(stmt, [])`; `toRowsResult` (line ~319) slices to `MAX_RESULT_ROWS`. `verb`/`words` from `topLevelWords` are already in scope. Add a pure `boundRawRead` helper and call it in the read branch.
- `src/core/executor.test.ts` -- `makeSeams` captures `runReadOnly` calls in `readOnlyCalls`; existing read tests (`SELECT dispatches via runReadOnly`, `the Core caps the result grid`) show the conventions to mirror.
- `src/core/table-rows.ts` -- reference for the "Core-computed integer literal LIMIT, never a bound value" precedent (Story 3.2).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/executor.ts` -- Add exported pure `boundRawRead(stmt, verb, words)` returning `stmt` unchanged unless `verb === "SELECT"` and `!words.includes("LIMIT")`, in which case it returns `` `${stmt}\nLIMIT ${MAX_RESULT_ROWS + 1}` ``. Call it in the `isRead` branch of `executeRaw` so `runReadOnly` receives the bounded SQL. Document why (DB-side fetch bound, DW-36). -- Bounds the fetch, not just the payload.
- [x] `src/core/executor.test.ts` -- Add tests covering every I/O Matrix row (bounded SELECT, already-limited passthrough, SHOW passthrough, trailing-line-comment newline, inner-LIMIT passthrough, MAX+1 truncation sentinel via `readOnlyResult`, exact-fit no-truncation, mutation path unchanged). -- Locks the bound and its guards.

**Acceptance Criteria:**
- Given an unbounded `SELECT` read, when executed, then the SQL reaching `runReadOnly` ends with `\nLIMIT <MAX_RESULT_ROWS + 1>` and the reply is `status: "rows"`.
- Given a read whose driver result has `MAX_RESULT_ROWS + 1` rows, when executed, then the reply data has exactly `MAX_RESULT_ROWS` rows and `truncated === true`.
- Given a `SHOW` or an already-`LIMIT`ed statement, when executed, then the SQL reaching `runReadOnly` is byte-identical to the input statement.
- Given any mutation (structured or confirmed raw), when executed, then no `LIMIT` is appended to the SQL reaching `runQuery`.

## Spec Change Log

<!-- No bad_spec loopback occurred; review findings were resolved as patches within the spec's stated principle ("push the bound ONLY when provably syntax-safe"). -->

## Review Triage Log

### 2026-07-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 2, low 1)
- defer: 4: (high 0, medium 3, low 1)
- reject: 4
- addressed_findings:
  - `[medium]` `[patch]` `SELECT … FOR UPDATE`/`FOR SHARE`/MySQL `LOCK IN SHARE MODE` appended a trailing `LIMIT` after the locking clause → a syntax error on both engines (a read that runs today would break). Extended the guard with a `NO_FETCH_BOUND_WORDS` set so a locking tail (`UPDATE`/`SHARE`/`LOCK`) leaves the statement verbatim; added execute-level + unit tests.
  - `[medium]` `[patch]` Postgres `FETCH FIRST n ROWS ONLY` (word `FETCH`, not `LIMIT`) got a second row-count clause appended → syntax error. `FETCH` added to `NO_FETCH_BOUND_WORDS`; covered by tests.
  - `[low]` `[patch]` The `boundRawRead` docstring falsely claimed a `LIMIT` inside an inner subquery "does not count" (`topLevelWords` does not track parenthesis depth). Rewrote the docstring to state the real guard and its KNOWN LIMITATIONS truthfully.
  - defer (NOT written to the ledger — the orchestrator owns ledger writes for this bundle; captured under Auto Run Result → Residual risks): `LIMIT ALL` bypass, position-blind subquery/UNION inner-`LIMIT` gap, explicit large `LIMIT` still buffers, and the pre-existing `WITH`/`TABLE`/`VALUES` read-classification gap.
  - reject (dropped): `SHOW` unbounded (small metadata, outside the table-data OOM threat model), unbounded server-side sort cost (out of scope — DW-36 targets Core-process memory), unordered-row-identity for a raw read (no ordering contract exists), latent `verb` vs `firstKeyword` inconsistency (no current consequence).

## Design Notes

The `+ 1` sentinel is load-bearing and requires NO change to `toRowsResult`: its existing `truncated = rows.length > MAX_RESULT_ROWS` is correct on the bounded fetch — MAX+1 fetched ⇒ truncated true, sliced to MAX; ≤MAX fetched ⇒ truncated false. The newline before `LIMIT` defeats a trailing `-- …` line comment (a block comment `/* */` cannot span to it).

The append guard is intentionally conservative: it only bounds a `SELECT` whose top-level words contain none of `NO_FETCH_BOUND_WORDS` = {`LIMIT`, `FETCH`, `UPDATE`, `SHARE`, `LOCK`} — the set of clauses (existing row-count bound, or a `FOR UPDATE`/`FOR SHARE`/`LOCK IN SHARE MODE` locking tail) after which a trailing `LIMIT` is illegal or redundant. Matching a rare unquoted identifier only over-suppresses (falls back to the Core cap) — it never breaks a query.

**Known limitations (residual, NOT regressions — the fetch stays unbounded exactly as before this change):** because `words` is the flat `topLevelWords` output with no parenthesis-depth tracking, a `LIMIT`/`FETCH` inside a subquery or one `UNION` arm suppresses the outer bound (e.g. `(SELECT … LIMIT 5) UNION SELECT * FROM huge`); Postgres `LIMIT ALL` reads as a `LIMIT` but means "no limit"; and an explicit large `LIMIT 500000` is honored as the user's own bound. The fully robust fix for all of these is the server-cursor approach (bound at the driver read seam, no SQL rewriting), which is a larger, driver-level change out of scope for this DW. The common OOM vector DW-36 names — `SELECT * FROM huge_table` with no bound — is fully covered.

## Verification

**Commands:**
- `bun test src/core/executor.test.ts` -- expected: all pass, including the new DW-36 cases.
- `bunx tsc --noEmit` -- expected: no type errors (or the project's configured typecheck).

## Auto Run Result

Status: done

**Implemented change:** DW-36 — the auto-classified raw read path in `executeRaw` now bounds the FETCH (not just the display slice). A pure `boundRawRead(stmt, verb, words)` helper appends a Core-computed `LIMIT MAX_RESULT_ROWS + 1` (1001) to a `SELECT` before it reaches `runReadOnly`, so the driver never materializes an entire `SELECT * FROM huge_table` into Core memory before the 1000-row cap trims the payload. The `+ 1` is the existing `truncated` sentinel, so `toRowsResult` is unchanged. A conservative `NO_FETCH_BOUND_WORDS` guard leaves statements verbatim when a trailing `LIMIT` would be illegal/redundant (existing `LIMIT`, `FETCH FIRST`, or a `FOR UPDATE`/`FOR SHARE`/`LOCK IN SHARE MODE` locking tail) and for `SHOW` (small metadata).

**Files changed:**
- `src/core/executor.ts` — added exported pure `boundRawRead` + `NO_FETCH_BOUND_WORDS`; `executeRaw` read branch now calls `runReadOnly(boundRawRead(stmt, verb, words), [])`. Classification, mutation path, and `toRowsResult` untouched.
- `src/core/executor.test.ts` — new `describe("raw read fetch bound (DW-36)")` covering every I/O-matrix row plus the FOR UPDATE / LOCK IN SHARE MODE / FETCH FIRST pass-throughs and direct `boundRawRead` units; two pre-existing read-path assertions updated to expect the bounded SQL.

**Review findings breakdown:** 3 patches applied (2 medium: FOR UPDATE / FETCH FIRST syntax-error regressions; 1 low: false docstring claim). 4 deferred, 4 rejected (see Review Triage Log).

**Residual risks (recommended deferrals — orchestrator to record on the ledger):**
- `LIMIT ALL` (Postgres) reads as a `LIMIT` yet means "no limit" → fetch stays unbounded.
- Position-blind guard: a `LIMIT`/`FETCH` inside a subquery or one `UNION` arm suppresses the outer bound (`(SELECT … LIMIT 5) UNION SELECT * FROM huge` unbounded).
- An explicit large `LIMIT 500000` is honored as the user's bound and still buffers that many rows.
- Pre-existing: `WITH … SELECT`, `TABLE t`, `VALUES …` are classified as non-reads (needs-confirm) and never reach the read bound.
- The definitive fix for the above is the server-cursor approach (bound at the driver read seam, no SQL rewriting) — a larger, driver-level change beyond this DW.

**Verification:** `bun test src/core/executor.test.ts` → 92 pass / 0 fail (250 expect calls). `bunx tsc --noEmit` → clean. The named OOM vector (`SELECT * FROM huge_table`, no bound) is now fetched at ≤1001 rows.
