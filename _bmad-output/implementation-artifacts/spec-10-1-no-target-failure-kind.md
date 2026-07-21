---
title: 'Classify "no connection target" as its own ConnectionFailureKind and stop the read paths from degrading it into internal_error'
type: 'refactor'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 10 / Story 10.1
  - '{project-root}/_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html'
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

## Acceptance Criteria

- Given a Persistent-mode boot with no saved/active connection, when the UI calls the `connect` RPC, then the result is `{ status: "failed", failure: "no-target", message: "no connection target configured" }` — a distinct `ConnectionFailureKind` member, never `"unsupported_scheme"` — and `SchemaTree` renders its "Sin conexión activa" empty-state by branching on `failure === "no-target"`, with the `isNoConnectionTarget` string-match hack removed.
- Given no connection is configured, when the UI calls `table.rows` or `execute`, then the RPC reply is a typed, neutral, already-formed "no connection" outcome the UI can render as "sin conexión" — never the generic `internal_error: RPC handler failed` envelope — and the message carries no URL, host, or credential.

## Code Map

> Light on purpose — the loop's dev planner (step-02) verifies exact line numbers and finalizes the seam.

- `src/shared/contract.ts` — add `"no-target"` to `ConnectionFailureKind` (currently `host | auth | network | unsupported_scheme | database-does-not-exist | malformed-url`); update the type's doc comment to describe the new member.
- `src/core/connection.ts` — `doConnect`: change the `databaseUrl === null` branch's `failure` from `"unsupported_scheme"` to `"no-target"` (the message can stay as-is or be lightly reworded). `ensureDriver`: currently throws a plain `Error` built from `result.failure` on any non-connected outcome — needs a way for callers (or `ensureDriver` itself) to distinguish the no-target case from other failures without string-matching, so the read-path seam below can classify it.
- `src/core/server.ts` — `tableRows`: currently lets a driver/connection throw from `connectionManager.getSchema()`/`.query()` propagate uncaught to `dispatch`; add a catch that classifies a no-connection throw and returns a typed reply instead of letting it fall through to `internal_error`.
- `src/core/executor.ts` — same seam as `tableRows` for whatever call resolves the connection/driver before running a read or write (verify the exact call site in step-02; not read in this draft pass).
- `src/core/chat.ts` — already catches `deps.getSchema()`'s throw (`answerStream`, `try { schema = await deps.getSchema(); } catch { return badRequest("no active connection", ...); }`) and never hits `internal_error` for this case today; verify unaffected by the `doConnect` rename, and consider aligning its outcome to the same typed signal used by `table.rows`/`execute` for consistency (optional, not required for this story's ACs).
- `src/ui/schema/SchemaTree.tsx` — remove `isNoConnectionTarget` (lines ~43-52 today) and its call site (~line 156); branch directly on `reply.result.failure === "no-target"` for the `"empty"` phase.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] Add `"no-target"` to `ConnectionFailureKind` in `src/shared/contract.ts`.
- [ ] `doConnect` in `src/core/connection.ts` returns `"no-target"` instead of `"unsupported_scheme"` for `databaseUrl === null`.
- [ ] Give `ensureDriver` (or its callers) a structural way to distinguish "no target configured" from other connection failures without message string-matching.
- [ ] `tableRows` (`src/core/server.ts`) catches the no-connection throw and returns a typed, neutral, already-formed reply instead of propagating to `internal_error`.
- [ ] `execute`'s connection-resolution path (`src/core/executor.ts`) gets the same treatment.
- [ ] `SchemaTree.tsx` drops `isNoConnectionTarget` and branches on the typed `"no-target"` kind.
- [ ] Confirm `chat.ts`'s existing `getSchema` catch still behaves correctly after the rename (no regression), align if low-cost.
- [ ] `bunx tsc --noEmit`, `bun test`, `bun run build` all green.

## Spec Change Log

<!-- populated by step-02+ as the spec is enriched/revised -->

## Review Triage Log

<!-- populated by the review loop -->
