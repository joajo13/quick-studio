---
title: 'Classify "no connection target" as its own ConnectionFailureKind and stop the read paths from degrading it into internal_error'
type: 'refactor'
created: '2026-07-21'
status: 'done'
baseline_revision: '185400e824b0458b25aaf2f84964847a6e2366d8'
final_revision: 'f8c999fd5aad8455eedd248d03aee31102fa3aa3'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 10 / Story 10.1
  - '{project-root}/_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** `unsupported_scheme` is being overloaded as the generic bucket for "there is no connection target configured at all" — a state that is not a URL-scheme problem, it is the normal shape of a Persistent boot with no saved connection yet. `doConnect` in `src/core/connection.ts` returns `{ status: "failed", failure: "unsupported_scheme", message: "no connection target configured" }` when `databaseUrl === null`, which is why `src/ui/schema/SchemaTree.tsx` had to grow an interim `isNoConnectionTarget` string-match hack (matching on `failure === "unsupported_scheme" && message === "no connection target configured"`) just to tell "no target" apart from a genuine unsupported-scheme URL error. Separately, and sharing the same root cause: `ensureDriver` in `connection.ts` THROWS a raw `Error` (`"connection unavailable (unsupported_scheme)"`) whenever a read path (`table.rows`, `execute`, `getSchema`) runs with no connection configured. `dispatch` in `src/core/rpc.ts` catches ALL handler throws indiscriminately and wraps them as the generic `internal_error: RPC handler failed` — so browsing or querying with no active connection surfaces the same ugly, undebuggable envelope the connect-time error used to.

**Approach:** Give "no connection target" its own first-class member of `ConnectionFailureKind` in `src/shared/contract.ts` (`"no-target"`, alongside the existing `host | auth | network | unsupported_scheme | database-does-not-exist | malformed-url`), and make `doConnect` return that kind — not `unsupported_scheme` — when `databaseUrl === null`. This alone lets `SchemaTree` retire `isNoConnectionTarget` and branch on `reply.result.failure === "no-target"` directly (the `connect` RPC already returns this outcome as a normal `ConnectResult`, no throw involved on that path today).

For the read paths that DO throw (`table.rows` / `execute` / `getSchema` via `ensureDriver`), the fix follows the precedent already established in `src/core/chat.ts`: `chat.ts`'s `answerStream` already wraps its `deps.getSchema()` call in a `try/catch` and converts a no-connection throw into a typed `bad_request` outcome (`"no active connection"`) instead of letting it propagate to `dispatch`'s catch-all — it never hits `internal_error` today. `table.rows` (`tableRows` in `src/core/server.ts`) and `execute` (`src/core/executor.ts`) do NOT have that catch — their doc comments explicitly say "a driver/connection throw propagates → `internal_error`", which is exactly the bug. Mirror the `chat.ts` seam at those two call sites: catch the `ensureDriver`-triggered throw and translate it into a typed, neutral, already-formed reply the UI can render as "sin conexión" — never a raw throw reaching `dispatch`. Prefer distinguishing this outcome structurally (e.g. a small typed marker on the thrown error, or a dedicated check) rather than string-matching the thrown message, so the fix does not just relocate the old `SchemaTree` hack one layer down. A genuine mid-session connection loss (driver was open, then died) may still be a distinct, less common case — keep it out of scope if it complicates the seam; the story's hard target is "no target configured," which is the ONLY state that currently produces the `internal_error: RPC handler failed` regression described in the container logs.

## Boundaries & Constraints

**Always:**
- `doConnect` in `connection.ts` returns the new `"no-target"` failure kind (not `"unsupported_scheme"`) when `databaseUrl === null`; the neutral message stays credential-free (e.g. keep or lightly reword `"no connection target configured"`).
- `SchemaTree.tsx` is updated to branch on the typed `failure === "no-target"` instead of the `isNoConnectionTarget` string-match helper, which is removed.
- The read paths (`table.rows`, `execute`, and — for consistency with the now-typed kind — optionally `getSchema`'s existing `chat.ts` catch) surface "no connection configured" as a typed, already-formed reply, never a raw throw that reaches `dispatch`'s generic catch-all.
- Keep `ConnectionFailureKind`'s existing five members and their meanings unchanged — this is an additive, non-breaking widening of the union.
- Preserve AR-12 (only opaque ids cross the loopback; URLs/credentials stay in Core) and credential neutrality on every new/changed message — no URL, host, user, or password in any failure message, ever.

**Block If:**
- If distinguishing "no target configured" from a genuine mid-connection driver failure at the `ensureDriver` throw site cannot be done without a broad rewrite of `connection.ts`'s driver lifecycle — HALT `blocked`, scope down to just the no-target case (the one confirmed in the container logs) and leave other `ensureDriver` throws propagating to `internal_error` as today.

**Never:**
- NEVER let any new or changed error message leak a URL, hostname, port, username, or password — every message here is either the existing neutral connect-failure text or a new equally neutral "no connection" phrase.
- NEVER reintroduce a string-match hack on an error message as the UI's discriminator — the whole point of this story is replacing that pattern with a typed kind/code.
- NEVER change `unsupported_scheme`'s existing meaning (a URL whose scheme is not a relational engine quick-studio speaks) — it keeps firing for a genuinely bad scheme; only the "no URL at all" case moves to `no-target`.
- NEVER widen what crosses the Core↔UI RPC boundary beyond a typed failure kind/code + neutral message — no raw driver/engine error text, no stack trace, no internal file path.

## I/O & Edge-Case Matrix

| Scenario | Input/State | Expected Output | Error Handling |
|----------|-------------|------------------|-----------------|
| Persistent boot, no saved connection, tree loads | `databaseUrl === null`, UI calls `connect` RPC | `ConnectResult` `{ status: "failed", failure: "no-target", message: "no connection target configured" }` | Not a throw; a normal domain result inside `okReply` |
| SchemaTree renders the no-target state | `connect` reply as above | `SchemaTree` shows the existing "Sin conexión activa" empty-state via `failure === "no-target"` (no string match) | No `role="alert"`; calm empty-state, not an error banner |
| Genuinely unsupported URL scheme | `databaseUrl` set to e.g. `ftp://...` | `ConnectResult` `{ status: "failed", failure: "unsupported_scheme", message: ... }` (unchanged) | Unchanged from today |
| Browse a table with no connection configured | `databaseUrl === null`, UI calls `table.rows` | A typed, neutral "no connection" reply the UI can render as "sin conexión" — NOT `internal_error: RPC handler failed` | No raw throw reaches `dispatch`'s catch-all; no credential in the message |
| Run a query with no connection configured | `databaseUrl === null`, UI calls `execute` | Same as `table.rows` — typed neutral no-connection outcome | Same |
| Chat schema fetch with no connection configured | `databaseUrl === null`, UI calls chat | Unchanged: `chat.ts` already catches this and returns `bad_request` "no active connection" — verify it still behaves correctly against the renamed kind, align to the same typed signal if low-cost | No `internal_error` (already true before this story) |
| A genuine driver bug elsewhere (not "no target") | Any other unexpected throw in a handler | Still wrapped as `internal_error: RPC handler failed` by `dispatch`'s catch-all (unchanged, intentional last-resort) | Unchanged — this story narrows the catch-all's blast radius, it does not remove it |

</intent-contract>

## Code Map

- `src/shared/contract.ts` — `ConnectionFailureKind` union at **lines 306-312** (doc **293-305**). Add `"no-target"` member + a doc-comment line describing it ("no connection target configured at all — the normal shape of a Persistent boot before any connection is saved; not a URL problem"). `ConnectResult` (320-326) and `RpcErrorCode` (903-910, already has `bad_request`) are unchanged.
- `src/core/connection.ts` — `doConnect` `databaseUrl === null` branch at **lines 156-162**: change `failure: "unsupported_scheme"` → `failure: "no-target"` (keep message `"no connection target configured"`). `ensureDriver` at **179-189** currently builds its throw message from the failure STRING (`connection unavailable (${result.failure})`), losing all typing. Add an exported typed marker error `NoConnectionTargetError extends Error` and have `ensureDriver` throw it specifically when `result.status === "failed" && result.failure === "no-target"`; all other failures keep throwing the existing generic `Error`.
- `src/core/server.ts` — `tableRows` at **302-317** (doc 294-301 states the throw currently propagates → `internal_error`). Wrap the driver calls (`connectionManager.getSchema()` line 303, `connectionManager.query(...)` 309/311) in a `try/catch`; on `err instanceof NoConnectionTargetError` return `errorReply("bad_request", "no active connection")`; otherwise `throw err` (re-throw so genuine driver bugs still reach `dispatch`'s `internal_error`). Update the doc comment to record the new no-target seam.
- `src/core/executor.ts` — `execute` entry at **669-704**; the driver seam calls (`seams.getEngine()` / `getSchema()` / `runQuery()` / `runReadOnly()` inside `executeRaw`/`executeStructured`) can throw `NoConnectionTargetError` when `databaseUrl === null`. Wrap the seam-executing region in a `try/catch` mirroring `tableRows`: `NoConnectionTargetError` → `bad("no active connection")` (the existing `bad` helper = `errorReply("bad_request", …)`, line 431); re-throw everything else. `resolveConnection`'s existing typed `not-found`/`unavailable` outcomes (via `targetError`, 434-438) are unchanged.
- `src/core/chat.ts` — `prepareRequest`'s `try { schema = await deps.getSchema(); } catch { return badRequest("no active connection", "schema=unavailable"); }` at **276-281** already converts this throw into `bad_request` and never hits `internal_error`. Verify unaffected by the `doConnect` rename. Optional low-cost alignment (only if trivial): narrow the bare `catch` to re-throw non-`NoConnectionTargetError` errors so a genuine driver bug is no longer silently mislabeled "no active connection" — but this is a behavior change, so leave it OUT unless it is a one-liner with no test churn.
- `src/ui/schema/SchemaTree.tsx` — remove `isNoConnectionTarget` (helper **50-52**, doc **43-49**) and update its call site (**154-160**) to branch on `reply.result.failure === "no-target"` for the `{ phase: "empty" }` state. `LoadState` (32-41) and the "Sin conexión activa" empty-state render (217-235) are unchanged.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` — add `"no-target"` to `ConnectionFailureKind` and document it in the union's doc comment. Keep the other members and their meanings intact.
- [x] `src/core/connection.ts` — change `doConnect`'s `databaseUrl === null` branch to `failure: "no-target"`; add & export `NoConnectionTargetError`; make `ensureDriver` throw it for the `no-target` failure and keep the generic throw for all other failures.
- [x] `src/core/server.ts` — wrap `tableRows`'s driver calls in a `try/catch`: `NoConnectionTargetError` → `errorReply("bad_request", "no active connection")`; re-throw all other errors. Update the doc comment.
- [x] `src/core/executor.ts` — wrap `execute`'s driver-seam calls in the same `try/catch`: `NoConnectionTargetError` → `bad("no active connection")`; re-throw all other errors.
- [x] `src/core/chat.ts` — verify the existing `getSchema` catch still returns `bad_request` "no active connection" after the rename; do NOT change behavior unless the optional narrowing is a trivial one-liner.
- [x] `src/ui/schema/SchemaTree.tsx` — remove `isNoConnectionTarget` and branch the `connect` reply on `failure === "no-target"` for the empty-state.
- [x] `src/core/connection.test.ts` — update the existing "null databaseUrl reports a clear no-target failure" test to expect `failure === "no-target"`; add a test that the manager's read path (`getSchema`/`query`) throws `NoConnectionTargetError` when `databaseUrl === null`.
- [x] `src/core/server.test.ts` (or `table-rows.test.ts`) — add a test that `tableRows` with a null-url manager returns `{ ok: false, error.code: "bad_request" }` with message "no active connection", never `internal_error`, and no credential text in the envelope.
- [x] `src/core/executor.test.ts` — add a test that `execute` with no connection target returns `bad_request` "no active connection" (not `internal_error`), keeping the existing redaction assertion (`JSON.stringify(reply.error)` contains no secret/URL).

**Acceptance Criteria:**
- Given a Persistent-mode boot with no saved/active connection, when the UI calls the `connect` RPC, then the result is `{ status: "failed", failure: "no-target", message: "no connection target configured" }` — a distinct `ConnectionFailureKind` member, never `"unsupported_scheme"` — and `SchemaTree` renders its "Sin conexión activa" empty-state by branching on `failure === "no-target"`, with the `isNoConnectionTarget` string-match hack removed.
- Given no connection is configured, when the UI calls `table.rows` or `execute`, then the RPC reply is a typed, neutral, already-formed "no connection" outcome (`bad_request` / "no active connection") the UI can render as "sin conexión" — never the generic `internal_error: RPC handler failed` envelope — and the message carries no URL, host, or credential.
- Given a genuine driver bug (any non-`NoConnectionTargetError` throw) in a handler, when it propagates, then `dispatch` still wraps it as `internal_error: RPC handler failed` — the catch-all's last-resort behavior is narrowed, not removed.

## Spec Change Log

## Review Triage Log

### 2026-07-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 0
- reject: 5
- addressed_findings:
  - `[low]` `[patch]` Edge Case Hunter flagged the executor no-target test covering only the `raw` shape, leaving the `structured` path — where seam ordering (`getEngine`/`getSchema` before `quoteIdent`) is load-bearing — untested. Added a structured-`insert` test with the same throwing seams asserting `bad_request` "no active connection" (never `internal_error`) and a credential-free envelope, locking the seam order against future refactors. Rejected (noise/non-defects): Blind Hunter #1 "chat degrades no-target to internal_error" — factually incorrect, verified `chat.ts:277-281` catches the throw (incl. `NoConnectionTargetError`, an `Error` subclass) and returns `badRequest("no active connection")`, never `internal_error`; #2 "read paths still stringly-typed via `bad_request`/message" — the `bad_request` + "no active connection" outcome is the spec-mandated AC, a deliberate design choice mirroring `chat.ts`; #3 "`NEUTRAL_MESSAGE['no-target']` is dead/can drift" — the entry is required for compile-time `Record<ConnectionFailureKind,string>` exhaustiveness, low/hygiene, no defect; plus two marginal test-coverage nits (`queryReadOnly` not separately covered — identical `ensureDriver` behavior; executor test not re-asserting HTTP 400 — mapping shared and covered by the server test).

## Design Notes

**Structural discriminator (not string-match).** The whole point of the story is to stop distinguishing outcomes by message text. So the thrown-side marker must be a *type*, not a string. `NoConnectionTargetError extends Error` gives every read-path catch an `instanceof` check that is compaction-proof and rename-proof:

```ts
// connection.ts
export class NoConnectionTargetError extends Error {
  constructor() { super("no connection target configured"); this.name = "NoConnectionTargetError"; }
}
// inside ensureDriver, replacing the generic throw only for the no-target case:
if (result.status === "failed" && result.failure === "no-target") throw new NoConnectionTargetError();
throw new Error(result.status === "failed" ? `connection unavailable (${result.failure})` : "connection unavailable");
```

**Read-path seam (mirror of chat.ts), re-throwing non-target errors so the catch-all stays intact:**

```ts
// server.ts tableRows / executor.ts execute
try {
  /* driver calls */
} catch (err) {
  if (err instanceof NoConnectionTargetError) return errorReply("bad_request", "no active connection");
  throw err; // genuine driver bug → dispatch → internal_error (unchanged)
}
```

Reuse the existing `"no active connection"` phrase from `chat.ts` for a single neutral, credential-free message across all three read paths — the UI already treats `bad_request` as a non-alarming, renderable outcome.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors (the widened union and new export compile cleanly).
- `bun test` — expected: all green, including the updated `connection.test.ts` and the new `tableRows` / `execute` no-target tests asserting `bad_request` (not `internal_error`) and no credential leakage.
- `bun run build` — expected: production build succeeds.

**Manual checks:**
- Boot Persistent mode with no saved connection: the schema tree shows the calm "Sin conexión activa" empty-state (no red error banner), and browsing a table / running a query surfaces "sin conexión", never an `internal_error: RPC handler failed` envelope.

## Auto Run Result

Status: done

**Summary:** Gave "no connection target" its own first-class `ConnectionFailureKind` member (`"no-target"`) and stopped the read paths from degrading it into `internal_error`. `doConnect` now returns `no-target` for `databaseUrl === null`; a typed `NoConnectionTargetError` (thrown by `ensureDriver` only for that case) lets `tableRows` and `execute` catch it structurally and return a neutral `bad_request` "no active connection" reply instead of a raw throw hitting `dispatch`'s catch-all. The UI dropped its `isNoConnectionTarget` string-match hack and branches on the typed kind.

**Files changed:**
- `src/shared/contract.ts` — added `"no-target"` to `ConnectionFailureKind` union + doc comment.
- `src/core/connection.ts` — `doConnect` null branch returns `no-target`; added & exported `NoConnectionTargetError`; `ensureDriver` throws it for the no-target case only (generic `Error` for all others).
- `src/core/driver.ts` — added the `no-target` key to the exhaustive `NEUTRAL_MESSAGE` record (compile-time requirement; a driver never emits it).
- `src/core/server.ts` — `tableRows` try/catch translates `NoConnectionTargetError` → `bad_request` "no active connection", re-throws everything else; doc updated.
- `src/core/executor.ts` — `execute` seam region try/catch mirrors the same translation (`bad("no active connection")`), re-throws the rest.
- `src/ui/schema/SchemaTree.tsx` — removed `isNoConnectionTarget`; branches on `failure === "no-target"` for the "Sin conexión activa" empty-state.
- `src/core/{connection,server,executor}.test.ts` — updated the null-url assertion to `no-target`; added typed-throw, `tableRows` no-connection, and executor raw+structured no-target coverage.

**Review findings breakdown:** 1 patch applied (low: added the executor structured-path no-target test to lock the load-bearing seam order); 0 deferred; 5 rejected (Blind Hunter's chat/internal_error claim — factually wrong, `chat.ts` already returns `bad_request`; the `bad_request` outcome is the spec-mandated AC; the exhaustive-map entry is required, not dead; plus two marginal test-coverage nits). No intent_gap, no bad_spec, no review-loop iterations.

**Follow-up review recommended:** false — the only review-driven change was a single low-severity test addition with no production-code impact.

**Verification:**
- `bunx tsc --noEmit` — green (0 errors).
- `bun test` — green, 1349 pass / 0 fail (73 files, 3344 expects).
- `bun run build` — green (4 bundles regenerated).
- Manual: no-target now surfaces as the calm "Sin conexión activa" empty-state and read RPCs return `bad_request` "no active connection", never `internal_error: RPC handler failed`.

**Residual risks:** chat's no-connection catch (`chat.ts:277-281`) is a broad `catch {}` that treats any `getSchema` throw as "no active connection" — pre-existing, intentionally left out of scope; a genuine mid-session driver loss on a live connection is still classified generically by design (spec Block-If boundary).
