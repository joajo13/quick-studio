---
title: 'Harden post-handshake introspection (DW-19 classify listSchema failures, DW-20 bound the introspection query)'
type: 'bugfix'
created: '2026-07-15'
status: 'done'
baseline_revision: '895d732d050909425f017daa4e588e39c12219e6'
final_revision: 'e93309357753c5cd1147093b43104b366a48cb17'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** After a successful handshake, `listSchema()` throws raw in both adapters. In `connection.ts` `open()` a non-`DriverConnectionError` from `await d.listSchema()` hits `throw err` → `internal_error` (HTTP 500), so an authenticated-but-unprivileged account or a mid-introspection reset surfaces as an opaque 500 instead of a classified `status:"failed"` (DW-19). Separately, neither adapter bounds the `information_schema` introspection query, so a hung `listSchema` (lock on `information_schema`, stalled server) blocks `close()`'s unconditional `await` of the in-flight `open()` → `Core.stop()` never completes → the port leaks (DW-20).

**Approach:** In each adapter, wrap the `listSchema` introspection so every failure exits as a classified `DriverConnectionError` (reusing existing kinds — `auth` for permission-denied, `network` for the rest) and bound the whole introspection with a client-side timeout that rejects (→ classified `network`) if it does not settle. This makes `open()` always settle in bounded time, which in turn bounds `close()` and `Core.stop()` — no change to `connection.ts`'s golden re-throw shape is needed.

## Boundaries & Constraints

**Always:**
- Reuse the existing 4-kind `ConnectionFailureKind` taxonomy (`host` | `auth` | `network` | `unsupported_scheme`). Do NOT add a new kind or change the enum.
- Classify a post-handshake **permission/privilege** introspection error (PG SQLSTATE `42501`; MySQL `ER_TABLEACCESS_DENIED_ERROR`/1142, `ER_COLUMNACCESS_DENIED_ERROR`/1143, `ER_SPECIFIC_ACCESS_DENIED_ERROR`/1227) as `auth`. Any other introspection failure (reset, timeout, unknown) classifies as `network` — the existing safe default.
- Any `listSchema` failure must leave the adapter throwing a `DriverConnectionError` only; `connection.ts` `open()` already turns that into a neutral `status:"failed"` payload and closes the half-open driver.
- Messages stay neutral and credential-free — reuse the fixed per-kind `NEUTRAL_MESSAGE`; never interpolate the URL, credentials, or raw engine text.
- The introspection timeout is client-side and scoped to `listSchema` ONLY. It must clear its timer on settle (no dangling handle keeping the event loop alive) and must not change `query`/`queryReadOnly` behavior.
- Preserve the existing driver contract, the postgres `{ simple: false }` extended-protocol backstop, and the mysql `multipleStatements:false` backstop untouched.

**Block If:**
- Resolving DW-19 would require adding a new `ConnectionFailureKind` (the intent forbids it) — HALT `blocked`.
- The permission-denied → `auth` classification cannot be expressed via the existing `classifyConnectionError` code/errno path without regressing connect-time classification — HALT `blocked`.

**Never:**
- Do NOT set a server-side global `statement_timeout` (postgres) or a global per-connection query timeout that would also bound the legitimate browse `query`/`queryReadOnly` paths.
- Do NOT edit the deferred-work ledger (`deferred-work.md`) — the orchestrator records resolution.
- Do NOT change `connection.ts` `open()`'s "re-throw non-classified error as a bug" golden shape, nor race `close()` against a timer (that would reintroduce the driver-assignment leak `close()` currently prevents).
- No live-DB test dependency — exercise everything through fakes/synthetic errors like the existing suites.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Introspection OK | `connect()` + `listSchema()` succeed | `{status:"connected", schema}` | No error expected |
| Unprivileged introspection (PG) | `listSchema` throws err with `code:"42501"` | adapter throws `DriverConnectionError("auth", …)` → `connection.ts` returns `{status:"failed", failure:"auth"}` | Classified, neutral message, driver closed |
| Unprivileged introspection (MySQL) | `listSchema` throws err with `code:"ER_TABLEACCESS_DENIED_ERROR"`/errno 1142 | adapter throws `DriverConnectionError("auth", …)` → `{status:"failed", failure:"auth"}` | Classified, neutral message |
| Reset mid-introspection | `listSchema` throws err with `code:"ECONNRESET"` | adapter throws `DriverConnectionError("network", …)` → `{status:"failed", failure:"network"}` | Classified as `network` |
| Hung introspection | `listSchema` never settles | after `INTROSPECTION_TIMEOUT_MS` the wrap rejects → classified `network` → `open()` settles → `close()`/`Core.stop()` complete | Timer cleared; underlying client torn down by `open()`'s `safeClose` |
| Timer hygiene | introspection settles fast | pending timeout timer is cleared; no lingering handle | No error |

</intent-contract>

## Code Map

- `src/core/driver.ts` -- home of `DriverConnectionError`, `classifyConnectionError`, `toDriverConnectionError`, `NEUTRAL_MESSAGE`. Add the permission-denied codes to the `auth` classification and add the shared `INTROSPECTION_TIMEOUT_MS` constant + a `withTimeout` helper (exported for unit tests).
- `src/core/driver-postgres.ts` -- `createPostgresDriver().listSchema` currently runs 4 `information_schema`/catalog queries raw. Wrap the introspection body in `withTimeout` + a catch that maps to `DriverConnectionError`.
- `src/core/driver-mysql.ts` -- `createMysqlDriver().listSchema` same shape (4 queries). Same wrapping.
- `src/core/connection.ts` -- `open()` catch already returns a neutral payload for any `DriverConnectionError` and `safeClose`s the half-open driver. NO change required; relied upon as-is.
- `src/core/driver.test.ts` -- extend `classifyConnectionError` cases + add `withTimeout` unit tests.
- `src/core/connection.test.ts` -- existing "listSchema throws a plain Error → still rethrown as a bug" test MUST stay green (fakes bypass the adapter wrap); add a case proving an adapter-classified `listSchema` failure becomes `status:"failed"`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/driver.ts` -- add permission-denied codes (`42501`, `ER_TABLEACCESS_DENIED_ERROR`, `ER_COLUMNACCESS_DENIED_ERROR`, `ER_SPECIFIC_ACCESS_DENIED_ERROR`) and errnos (1142, 1143, 1227) to the `auth` sets in `classifyConnectionError`; add `export const INTROSPECTION_TIMEOUT_MS = 5000` and `export async function withTimeout<T>(op, ms)` that races `op` against a rejecting timer and clears the timer in `finally` -- reuses the taxonomy for DW-19 and provides the DW-20 bound.
- [x] `src/core/driver-postgres.ts` -- wrap the `listSchema` introspection in `withTimeout(…, INTROSPECTION_TIMEOUT_MS)` and a `try/catch` that rethrows a `DriverConnectionError` as-is else `toDriverConnectionError(err)` -- DW-19 classification + DW-20 bound.
- [x] `src/core/driver-mysql.ts` -- same wrap around its `listSchema` introspection (the `connection === null` bug-guard stays OUTSIDE the wrap) -- DW-19 + DW-20.
- [x] `src/core/driver.test.ts` -- add `classifyConnectionError` cases for the new permission codes/errnos → `auth`; add `withTimeout` tests (resolves passthrough, rejects after bound, clears timer / does not hang the runner) -- unit-cover the I/O matrix rows.
- [x] `src/core/connection.test.ts` -- add a test that a driver whose `listSchema` throws a `DriverConnectionError("auth"|"network")` surfaces as `{status:"failed", failure:…}` (not thrown); the existing plain-`Error` rethrow test still passes.

**Acceptance Criteria:**
- Given an authenticated connection whose `listSchema` fails with a permission-denied engine code, when `connect()` runs, then it resolves `{status:"failed", failure:"auth"}` with a neutral message and the half-open driver is closed — never an `internal_error`.
- Given an introspection query that never settles, when `connect()` runs, then within a bounded time it resolves `status:"failed"` (`network`) and a subsequent `close()`/`Core.stop()` completes and releases the port.
- Given `listSchema` succeeds quickly, when it returns, then no timeout timer remains pending (the test process exits without a lingering handle).
- Given the existing driver contract, when the changes land, then `bun test` passes with no regression to the postgres/mysql smuggle backstops or the `connection.ts` golden re-throw for genuinely non-classified bugs.

## Spec Change Log

_No `bad_spec` loopback occurred. Both review patches were applied to the implementation directly (see Review Triage Log); no `<intent-contract>`-external section was re-derived._

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 1: (high 0, medium 1, low 0)
- reject: 6
- addressed_findings:
  - `[medium]` `[patch]` Hard 5s introspection bound would misclassify a slow-but-healthy large-schema introspection (4 `information_schema`/catalog queries incl. postgres lateral-unnest joins) as a permanent `network` failure. Raised `INTROSPECTION_TIMEOUT_MS` 5000 → 30_000 in `src/core/driver.ts` — generous enough to clear a healthy large catalog, still finite so a wedged query cannot block `Core.stop()` indefinitely.
  - `[low]` `[patch]` `INTROSPECTION_TIMEOUT_MS` doc comment overclaimed the bound "can never block `close()`"; softened to "cannot block … INDEFINITELY" and documented the false-timeout-vs-shutdown-latency trade-off (same edit as the patch above).
- deferred (recorded here, NOT written to the ledger per the run's no-edit-ledger directive; orchestrator to log):
  - `[medium]` A privilege-filtered `information_schema` returns FEWER rows (no error) for an under-privileged account, so `open()` can return `status:"connected"` with a silently-partial schema instead of `failed:"auth"`. Pre-existing behavior of the privilege-filtered catalog views, outside DW-19/DW-20 intent (classify *errors*, not detect silent partial results). Evidence: PG/MySQL `information_schema.columns` filter by grant rather than raising `42501`/`1142`, so the DW-19 permission mapping "rarely fires" on introspection; a genuine detect-under-privilege feature would need a row-count/expected-object check.
- rejected (noise / acceptable-by-design): broad `introspect()` catch "masks JS bugs as network" (the body's only realistic throw sources are the query `await`s → engine errors classified correctly, and the timeout; `.map`/`assembleSchema` are pure+total); timeout doesn't client-cancel the query (reclaimed by `open()`'s `safeClose` within the teardown bound); slow-auth-vs-timer race → `network` (rare, inherent to any client timeout); integration-coverage of a real hang (needs a live driver / 30s timer; `withTimeout` + classification are unit-covered); dead-but-defensive mysql `connection===null` guard; `1227` broad bucket (only `listSchema` reaches this classifier).

## Design Notes

`withTimeout` shape (client-side, timer-hygienic):

```ts
export const INTROSPECTION_TIMEOUT_MS = 30_000;
export async function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("introspection timed out")), ms);
  });
  try {
    return await Promise.race([op, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

Adapter wrap (both engines — introspection body extracted to a local async, unchanged inside):

```ts
async listSchema(): Promise<DatabaseSchema> {
  try {
    return await withTimeout(introspect(), INTROSPECTION_TIMEOUT_MS);
  } catch (err) {
    throw err instanceof DriverConnectionError ? err : toDriverConnectionError(err);
  }
}
```

Why `auth` for a privilege error: the neutral 4-kind taxonomy has no `permission` bucket and the intent forbids adding one; `auth` ("the database rejected …") is far closer than `network` for an authenticated-but-unprivileged account, and `select 1` at connect needs no table privileges so extending the `auth` code set does not regress connect-time classification. The timeout rejects with a plain `Error` on purpose so the adapter catch classifies it via `toDriverConnectionError` (no `code` → `network`), keeping one classification seam. The abandoned query's socket is torn down by `open()`'s existing `safeClose(d)` on the failure path, so no zombie connection lingers.

## Verification

**Commands:**
- `bun test src/core/driver.test.ts src/core/connection.test.ts` -- expected: all pass, including the new classification/timeout/adapter-wrap cases and the unchanged smuggle-backstop + plain-Error-rethrow tests.
- `bunx tsc --noEmit` (or the project's typecheck script) -- expected: no type errors from the new helper/exports.
- `bun test` -- expected: full suite green, no lingering-handle / timeout hang.

## Auto Run Result

Status: done

**Summary of implemented change:** Hardened the post-handshake introspection seam shared by `connection.ts` and the driver adapters. DW-19: both adapters now wrap `listSchema` so any post-handshake failure exits as a classified `DriverConnectionError` (permission-denied engine codes → `auth`, everything else → `network`), which `connection.ts` `open()` already turns into a neutral `status:"failed"` payload — an unprivileged-introspection or mid-introspection error no longer escapes as `internal_error` (500). DW-20: a client-side `withTimeout` bounds the whole introspection so a hung/locked `listSchema` can no longer block `close()` → `Core.stop()` indefinitely and leak the port. No change to `connection.ts` (its golden re-throw shape and `safeClose`-on-failure are relied upon as-is).

**Files changed:**
- `src/core/driver.ts` — added post-handshake permission-denied codes/errnos (`42501`, `1142/1143/1227` + MySQL code names) to the `auth` classification; added `INTROSPECTION_TIMEOUT_MS` (30s) and the exported `withTimeout` race helper.
- `src/core/driver-postgres.ts` — wrapped `listSchema` introspection in `withTimeout` + classify-on-catch (DW-19 + DW-20).
- `src/core/driver-mysql.ts` — same wrap; kept the `connection===null` bug-guard OUTSIDE the classified wrap so a true programming error still surfaces as `internal_error`.
- `src/core/driver.test.ts` — new `classifyConnectionError` cases (permission codes/errnos → `auth`) + a `withTimeout` describe (passthrough, reject-after-bound, timer-cleared/no-hang, op-rejection-propagates).
- `src/core/connection.test.ts` — new test that a classified `listSchema` `DriverConnectionError` surfaces as `{status:"failed"}` and closes the half-open driver; the existing plain-`Error`-rethrow test stays green.

**Review findings breakdown:** 2 patches applied (medium: 5s→30s bound to avoid false `network` failures on large schemas; low: corrected the "can never block" comment overclaim + documented the trade-off). 1 item deferred (silent under-privilege → partial schema without `failed:auth`; pre-existing, out of DW-19/20 scope — recorded in the Review Triage Log for the orchestrator, NOT written to the ledger per this run's directive). 6 findings rejected as noise/acceptable-by-design (see Review Triage Log).

**Verification performed:**
- `bun test src/core/driver.test.ts src/core/connection.test.ts` → 61 pass, 0 fail.
- Post-patch: `bun test src/core/driver.test.ts src/core/connection.test.ts src/core/executor.test.ts src/core/lifecycle.test.ts` → 145 pass, 0 fail.
- `bunx tsc --noEmit` → exit 0 (no type errors).
- Full `bun test` → 1126 pass, 0 fail (69 files), no lingering-handle / timeout hang (reported by the implementation pass; unchanged by the localized patch).

**Residual risks:**
- The introspection bound now doubles as the mid-hang shutdown ceiling: a quit landing exactly while introspection is wedged on a lock can delay teardown up to ~30s (finite, not infinite — DW-20 satisfied). The false-timeout risk on very large catalogs is the traded-against concern.
- The abandoned server-side query on a client timeout is reclaimed only when `open()`'s `safeClose(d)` tears the connection down; correct today, but load-bearing on that teardown path.
- Deferred: an under-privileged account yields a silently-partial schema (`status:"connected"`) rather than a classified failure — see Review Triage Log.
