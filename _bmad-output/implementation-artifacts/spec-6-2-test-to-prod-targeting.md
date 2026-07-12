---
title: 'Test-to-production Report targeting'
type: 'feature'
created: '2026-07-12'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '58042fcbd7c2c0c10a0c7aca8ce277572311f6ae'
final_revision: 'd9daabbbcb5d7a2219f31b45ecaef3c2495f9c64'
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** A Report (Story 6.1) runs every query block against the single database the Core bound at boot. There is no way to build a Report against a test database and then re-run it against production — FR-19 / UJ-4 ("develop safely, then run the finished report against real data") is unmet. The Core holds exactly one immutable connection and its `execute` path carries no target; the saved-connections registry (Story 2.4) exists but never feeds the executor.

**Approach:** Give a Report a session-only **target** — a saved-connection id (default = the launch connection). Selecting a different target re-runs all of the Report's query blocks against the new database, executed through the Core (AR-2), leaving the Report's layout (block order, prose, chart specs, view toggles) untouched. The UI passes only a connection **id**; the Core resolves credentials internally via the existing credential store, lazily opens/caches a connection per target, and runs the query there — credentials never leave the Core.

## Boundaries & Constraints

**Always:**
- All re-target queries execute through the Core `execute` path (AR-2); the UI never touches a driver.
- The UI sends only a saved-connection **id**; url/credentials are resolved inside the Core and never appear in any reply or reach Ring 2 (Epic 2 trust boundary, AR-12).
- Absent a target id, `execute` runs against the boot connection with behavior byte-identical to today — table/query/ERD/chat tabs are unaffected.
- Re-targeting only rewrites query blocks' `result`/`error`/`info`/`truncated`; it never mutates layout (order, prose, chart, view). Prose blocks are inert.
- Re-run of all blocks uses the existing FR-18 functional-updater write path (no concurrent-completion clobber). A completion from a superseded target is dropped (the report's current target guards `applyOutcome`, mirroring 6.1's removed-block no-op).
- Target managers are opened lazily, cached by id, and closed on shutdown alongside the boot manager (Story 1.5 clean shutdown).

**Block If:**
- Resolving a saved-connection id to a live driver would require weakening the Core credential boundary (e.g. handing a url to Ring 2). It does not — `credentialStore.getConnection(id)` already resolves the url in-Core — so this must not happen; if it appears to, HALT.

**Never:**
- No Live-Report / external-caller authorization (Story 6.4) — re-target is only for the authorized in-app UI over the token-gated loopback.
- No report-to-disk persistence — the target is session-only, exactly like 6.1's in-memory `reportStates`.
- No SQL translation across engines — a query that is invalid on the new target's engine surfaces as that block's error; it is not rewritten.
- No global "active connection" swap — targeting is per-report and per-`execute`-request, never a process-wide mutation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Re-target with data | Report with 2 query blocks, target changed A→B | Both blocks re-run against B; each holds B's `FrozenData`; layout unchanged | No error expected |
| Default target | New report, `targetConnectionId=null` | Queries run against the boot/launch connection (unchanged 6.1 behavior) | No error expected |
| Unknown / deleted id | `execute` with a `connectionId` not in the store | Core returns a typed error reply; block shows error; other blocks unaffected | Per-block error surfaced |
| Unreachable target | Target's driver fails to open/connect | That block shows its error; re-target itself does not crash the report | Per-block error surfaced |
| No query blocks | Report of only prose, target changed | Target stored; nothing to re-run; layout unchanged | No error expected |
| Rapid re-target | Target A→B→C while A/B runs still in flight | Final block results reflect C; superseded-target completions dropped | Stale completion no-op |
| Ephemeral mode | No saved connections exist | Picker offers only the default/launch target; re-target degrades gracefully | No error expected |

</intent-contract>

## Code Map

- `src/core/executor.ts` -- `execute(request)` (validates `{shape, sql, confirmed?}`); add optional `connectionId?: string` and run the call against the resolved target seams
- `src/core/connection.ts` -- `createConnectionManager({ databaseUrl })` → `{ query, queryReadOnly, getSchema, quoteIdent, connect, close }`; instantiate one per target url
- `src/core/credential-store.ts` -- `getConnection(id) => StoredConnection | undefined` (has `.url`); the in-Core id→url resolution seam
- `src/core/connection-registry.ts` -- `list` returns credential-free `{id,name,host,engine}`; UI target picker source
- `src/core/server.ts` -- boot `connectionManager` (204), executor seams (259-263), dispatch `execute` (368), shutdown `connectionManager.close()` (534); wire the target resolver + close cached managers here
- `src/ui/rpc/client.ts` -- `rpc(method, params)`; `connectionId` rides inside `execute` params
- `src/ui/workspace/run-raw-query.ts` -- `runRawQuery(sql, confirmed?)`; add trailing `connectionId?` arg, back-compat for existing callers
- `src/ui/report/report-state.ts` -- `ReportState`; add `targetConnectionId: string | null` + `setReportTarget`
- `src/ui/report/ReportTabView.tsx` -- `runBlock`/`toOutcome`/`applyOutcome`/`confirmBlock`; add target picker, re-run-all-on-change, stale-target guard, transient-state cleanup, confirm target-stamping
- `src/ui/report/retarget-plan.ts` -- NEW: pure DOM-free lifecycle decision for a retarget (which query blocks re-fire, which transient run state to reset), so the retarget↔run lifecycle is unit-testable without a DOM
- `src/ui/settings/connections-model.ts` -- `ConnectionsState`; reference for reading `connections.list`

## Tasks & Acceptance

**Execution:**
- [x] `src/core/connection-targets.ts` -- NEW: pure factory `createConnectionTargets({ bootManager, getStoredUrl, createManager })` → `resolve(connectionId?: string | null)` returning the boot manager when id is null/absent, else a lazily-opened manager cached by id whose url comes from `getStoredUrl(id)`; typed `not-found` when the id is unknown; plus `closeAll()`. **Cache-invalidation (required):** cache the url alongside the manager; on every `resolve` of a cached id, re-read `getStoredUrl(id)` — if it now differs (connection repointed) close+evict the stale manager and re-open at the new url; if it is now `undefined` (connection removed) close+evict and return `not-found`. A removed/repointed connection must NOT keep serving its old live connection for the session. **Shutdown latch:** `closeAll()` sets a `closed` flag so any later `resolve` returns `not-found` and never opens a new (leaked) target -- isolates per-target manager lifecycle from the executor, testable without a driver
- [x] `src/core/connection-targets.test.ts` -- NEW: unit-test default→boot, id→new manager (created once, cached), unknown id→not-found, `closeAll` closing every opened manager, **cache-invalidation on url change (re-opens at new url, closes the old) and on removal (evicts + not-found)**, and **resolve-after-closeAll → not-found (no leak)** -- targeting correctness without a live DB
- [x] `src/core/executor.ts` -- accept optional `connectionId?: string` on the `execute` request; resolve the target's seams once per call (default boot) and run against them; unknown/failed target → typed error reply -- the Core re-target entry (AR-2)
- [x] `src/core/executor.test.ts` -- extend: `execute` with no `connectionId` uses the default seams (unchanged); with a valid `connectionId` routes to the resolved seams; with an unknown id returns an error reply. **Cover BOTH shapes** — assert the `structured` path (insert/update/delete/createTable, the guarded/destructive branch) also resolves and runs against the target seams, not just `raw` -- proves default path is untouched and targeting routes correctly on the highest-risk path
- [x] `src/core/connection-registry.ts` -- add a Core-internal `getStoredUrl(id)` over the same memoized credential store (never dispatched over RPC — url stays in-Core). **Distinguish store-unavailable from unknown-id:** the resolver/executor must be able to tell "the credential store could not open" (→ a store-unavailable/`internal_error` class error, and a stderr diagnostic like other store-open failures in this module) apart from "no such saved connection id" (→ `not-found`), so a valid target during a transient store failure is not mislabeled as an unknown connection -- correct error class + diagnosability for a security-sensitive path
- [x] `src/core/server.ts` -- construct `createConnectionTargets` from the boot manager + the `getStoredUrl` seam backed by the same credential store the registry uses; feed the executor a `resolveConnection` dep; on shutdown call `closeAll()` before/with `connectionManager.close()` -- wires targeting into the live Core and clean shutdown
- [x] `src/ui/workspace/run-raw-query.ts` -- add trailing `connectionId?: string | null` param, forwarded inside the `execute` params only when set -- carries the target to the Core; existing callers (unchanged 2-arg form) keep the default connection
- [x] `src/ui/report/report-state.ts` -- add `targetConnectionId: string | null` (default `null` in `emptyReport`) and total reducer `setReportTarget(state, id)`; leave block reducers untouched -- the session-only report target
- [x] `src/ui/report/report-state.test.ts` -- extend: `emptyReport` target is `null`; `setReportTarget` sets/clears it and preserves `blocks`/`nextId` unchanged (layout invariant) -- target model + no-layout-mutation guarantee
- [x] `src/ui/report/retarget-plan.ts` -- NEW: pure `planRetarget(blocks, runs)` deciding, per query block, the transient-run-state reset (clear `busy`, clear any pending `confirm`) and whether it must re-fire against the new target. This is the single source of truth for the retarget lifecycle so it can be tested without a DOM -- makes findings-1/2/4/5 class of bug reproducible in a unit test
- [x] `src/ui/report/retarget-plan.test.ts` -- NEW: unit-test that a retarget plans a re-fire for idle, busy (in-flight), and confirm-pending query blocks; clears a pending confirm; and never leaves a block `busy` with no re-fire (no stuck state); prose blocks untouched -- lifecycle correctness without a DOM
- [x] `src/ui/report/ReportTabView.tsx` -- fetch available connections via the `connections` (list) RPC once on mount; render a target picker (a "Default (launch connection)" option = `null`, plus each saved connection by name). Retarget lifecycle (drive it through `planRetarget`): on target change, `setReportTarget` then, for EVERY query block, reset its transient state per the plan and re-fire it against the NEW target passed explicitly (never read back from not-yet-committed state) — a block that was busy or confirm-pending against the OLD target must NOT retain its old result nor stay stuck. **`applyOutcome` superseded-target guard MUST also clear the block's transient run state** (`busy=false`, release `firing`) when it drops a stale completion, so a superseded run never strands the block "running…". **Confirm target-stamping:** a block's pending `confirm` captures the target that produced its preview; `confirmBlock` executes against THAT captured target (not the current picker value), and a retarget cancels/clears any pending confirm so a guarded/destructive statement can never commit against a different target than the one previewed -- the re-target UX, layout preserved, lifecycle-safe
- [x] `src/ui/report/ReportTabView.test.tsx` -- extend the smoke test: renders with a target picker; selecting a target invokes `runRawQuery` with the chosen `connectionId` for each query block and does not reorder/alter non-result block fields (mock `runRawQuery`) -- render + re-run wiring (deep lifecycle coverage lives in `retarget-plan.test.ts`)

**Acceptance Criteria:**
- Given a Report built and run against connection A, when the author selects connection B as the target, then every query block re-runs through the Core against B and displays B's data (FR-19, AR-2).
- Given a re-target, when it completes, then block order, prose, chart specs, and view toggles are identical to before — no layout rebuild is required.
- Given a query block re-targeted at an unknown or unreachable connection, when it runs, then that block shows an error while other blocks and the report layout are unaffected.
- Given any tab that is not a Report (table/query/ERD/chat), when it runs a query during and after this change, then it still runs against the boot connection with no observable behavior change.
- Given the UI at any point, when it requests a re-target, then no database url or credential is present in any RPC reply or in Ring 2 state — only the connection id crosses the boundary.
- Given a query block whose run is in flight against A, when the author retargets to B, then the block re-runs against B and never stays stuck showing "running…" — its superseded A completion is discarded and its transient run state is cleared.
- Given a guarded/destructive statement whose confirmation preview was computed against A, when the author retargets to B and then confirms, then the statement does not commit against B — the pending confirmation is invalidated by the retarget, so a destructive statement only ever executes against the target it previewed.
- Given the author rapidly retargets A→B→C, when the runs settle, then every query block reflects target C, with no block left stuck busy or showing stale A/B data.
- Given a saved connection a Report is targeting is repointed to a new url or removed in Settings, when the Report next re-runs, then it uses the new url — or, if removed, the connection is no longer executable and the block errors — the Core never keeps serving the stale cached connection for the session.

## Spec Change Log

### 2026-07-12 — bad_spec loopback (iteration 1)

- **Triggering findings:** review found the retarget↔run lifecycle was under-specified, producing two HIGH defects and three real MEDIUM/LOW gaps: (1) `applyOutcome`'s superseded-target guard `return`ed without clearing `busy`, stranding a block "running…" forever and blocking its re-fire when the user retargets mid-run; (2) the retarget re-run loop skipped busy/confirm-pending blocks (`if (busy||confirm) return`), so `confirmBlock` read the *current* picker target — a `DELETE` previewed against test A could commit onto prod B, and rapid A→B→C retargets stranded blocks; (3) the Core target-manager cache never re-validated against the registry, so a repointed/removed connection kept executing its stale live connection all session (correctness + revocation gap); (4) `getStoredUrl` conflated store-unavailable with unknown-id; (5) the retarget orchestration + structured (destructive) targeting path had no test coverage.
- **Amended (all OUTSIDE `<intent-contract>`):** added the whole-report retarget lifecycle contract to Design Notes; added a pure `src/ui/report/retarget-plan.ts` helper + test task (makes the lifecycle DOM-testable); strengthened the `ReportTabView` task with transient-state cleanup on superseded drop, explicit re-fire of busy/confirm blocks, and confirm target-stamping; required Core cache-invalidation (url-change/removal) + a `closeAll` closed-latch on the `connection-targets` task/test; added a `connection-registry` task to distinguish store-unavailable from unknown-id; required the executor test to cover the structured path; added five ACs.
- **Known-bad state avoided:** a report silently mixing old/new-target data; a block permanently stuck "running…"; a destructive statement committing against a different DB than its preview; a removed connection still executable; a green test suite that never exercised the retarget lifecycle.
- **KEEP (must survive re-derivation):** the Core-side architecture is correct and should be re-derived as-is — the `connection-targets.ts` resolver with a single `resolveConnection` dep on the executor, `ExecutorDeps` collapsed to `resolveConnection` returning `ConnectionSeams`, the byte-identical untargeted (null id) default path, the in-Core `getStoredUrl` seam so only the id crosses loopback, per-request (not global) targeting, lazy-open + cache-by-id, `closeAll` on shutdown. KEEP the UI shape too: the "Default (launch connection)"=null picker fed by `connections.list`, the pure exported `queryBlocksToRerun`, the explicit-target threading into re-fires (do not read target back from `stateRef`), and all FR-18 functional-updater writes. The fixes ADD lifecycle correctness on top of this structure — do not discard it.

## Review Triage Log

### 2026-07-12 — Review pass
- intent_gap: 0
- bad_spec: 7: (high 2, medium 3, low 2)
- patch: 0
- defer: 0
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[high]` `[bad_spec]` Superseded-target completion stranded a block "running…" forever (`applyOutcome` returned without clearing `busy`; the retarget loop then skipped the still-busy block) — spec now requires transient-state cleanup on the superseded drop and explicit re-fire of busy blocks against the new target.
  - `[high]` `[bad_spec]` Destructive confirmation fired against the *current* target, not the previewed one — a `DELETE` previewed on test A could commit on prod B after a retarget — spec now stamps the confirm with its preview target and cancels pending confirms on retarget.
  - `[medium]` `[bad_spec]` Retarget skipped busy/confirm blocks → report left in a mixed old/new-target state; rapid A→B→C stranded blocks — spec now routes the whole retarget through a pure `planRetarget` so every query block reaches the final target.
  - `[medium]` `[bad_spec]` Core target cache ignored connection edit/removal (stale url + revocation gap) — spec now requires cache self-invalidation against `getStoredUrl` on every resolve, plus a `closeAll` closed-latch.
  - `[medium]` `[bad_spec]` Retarget orchestration + structured (destructive) targeting path had zero test coverage — spec now mandates a `retarget-plan.test.ts` and a structured-shape executor routing test.
  - `[low]` `[bad_spec]` `getStoredUrl` conflated credential-store-unavailable with unknown-id → misleading "unknown connection" error — spec now requires distinguishing the two error classes.
  - `[low]` `[bad_spec]` `closeAll` had no latch, so a resolve racing shutdown could leak a target manager — folded into the `connection-targets` cache/latch requirement.
  - Rejected (dropped): engine/dialect-mismatch warning on retarget (per-block error is by-design per the spec's `Never` — no SQL translation); opaque `internal_error` on a target connect failure (the block still shows an error, satisfying the I/O matrix — classification is a diagnosability nicety); connection-list fetched once on mount so new connections don't appear until remount (usability limitation, matches the app's existing mount-fetch pattern); picker value showing "Default" while `targetConnectionId` holds a since-removed id (cosmetic once cache-invalidation makes such a run error).

### 2026-07-12 — Review pass (post-loopback re-derivation)
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 2, low 0)
- defer: 0
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[medium]` `[patch]` Per-block (not per-run) `firing`/`busy` guards corrupted each other under concurrent runs: a re-target re-fires an already-busy block, so two runs share one `firing[id]`/`busy` — the OLD (superseded) run completing first cleared `busy`+`firing` while the NEW re-fire was still in flight, showing the block idle mid-run and re-opening the manual double-fire window. Added a per-block RUN generation counter: `fireAgainst` bumps+captures its gen, and only the LATEST run may touch transient state (`applyOutcome` now gates every `setRuns` busy-clear on `isLatest`; `firing` cleared only by the latest run). Eventual state was already correct via the target guard; this fixes the transient window. Covered by the re-derivation + regression suite.
  - `[medium]` `[patch]` Re-target re-fired blank/whitespace-SQL query blocks, sending an empty statement to the Core and painting a spurious error onto never-run pristine blocks. `planRetarget` now skips query blocks whose `sql.trim()` is empty; added a test asserting only blocks with real SQL re-fire.
  - Rejected (dropped, all low/tolerable, no data- or target-integrity break): confirmed destructive commit's "N rows affected" note dropped when superseded by a retarget (the write hits the CORRECT previewed target — only the notification is lost in a narrow confirm-then-retarget race; no clean localized fix); connections list fetched once on mount (by-design, matches app pattern, Core safely rejects a removed id with `not_found`); cache eviction closing a manager mid-query on a concurrent repoint (narrow race, fails closed to `internal_error`, no wrong data); `resolve(null)` default path bypassing the `closed` latch (by-design — boot manager is caller-owned with its own latch); dead `action.reset`/`else` branch in `handleRetarget` (uniform `refire:true`, code-quality only); `handleRetarget` reading a possibly-stale `runs` closure while reading fresh `blocks` (latent, harmless under uniform plan; mitigated by the gen-counter fix); rapid same-tick A→B→A retargets amplifying concurrency (settles correctly via gen + target guard); execute mid-await during `closeAll` failing `internal_error` at shutdown (fail-safe); empty-string `connectionId` mapping to `not_found` (unreachable — the UI uses `null` and `run-raw-query` omits the key); structured unknown-op-kind + unknown id reporting `not_found` before `bad_request` (narrow malformed-request ordering).

### 2026-07-12 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 1, low 0)
- defer: 0
- reject: 11: (high 0, medium 1, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The per-run generation guard gated the transient-state clear (`busy`) on `isLatest`, but NOT the result fold: a same-target completion that was superseded by a newer re-fire against the SAME target still folded its (possibly older) snapshot. Under a rapid `A→B→C→B` retarget, a slow gen-1 run against B completing after the fresh gen-3 run against B would overwrite the block with stale data — violating the "no block showing stale data" AC. Fixed by adding an early `if (!isLatest) return;` before the outcome switch so last-FIRED wins (not last-COMPLETED); the redundant inner `if (isLatest)` guards were simplified out. Per-block gating (`runGen[id]`) leaves FR-18 sibling preservation intact. Covered by the regression suite (the fold lives in the component's `applyOutcome`; this repo has no jsdom, so — like the prior generation-guard patch — there is no dedicated DOM unit test).
  - Rejected (dropped, all by-design or previously-triaged noise, no NEW data/target-integrity break): `execute` now accepting a `connectionId` for any saved connection is the FR-19 feature itself over the token-gated loopback (Epic 2 trust boundary — not a new external-auth surface); picker showing "Default" while holding a since-removed/not-yet-loaded id (cosmetic, prior pass); connections list fetched once on mount (by-design, matches app pattern, Core rejects a removed id with `not_found` — prior pass ×2); retarget re-running never-run-but-typed SELECT blocks (the "every query block re-runs" AC; destructive statements still gate via `confirmation_required`); target-DB-unreachable surfacing as `internal_error` (satisfies the I/O-matrix "per-block error surfaced" row — classification is a diagnosability nicety, prior pass ×2); cache eviction closing a manager mid-query on a concurrent repoint (narrow race, fails closed, prior pass); `handleRetarget`/`applyOutcome` reading the lagging `stateRef` for the supersede check (inherent + harmless — an rpc cannot resolve before a React commit; prior pass); dead `else` branch in `handleRetarget` (uniform `refire:true`, code-quality only, prior pass); empty-string `connectionId`→`not_found` (unreachable — UI maps `""`→`null`; prior pass); confirmed destructive commit's "N rows affected" note dropped on a confirm-then-retarget race (the write hits the CORRECT previewed target — only the notification is lost; prior pass).

## Design Notes

- **Per-request target, not a global swap:** the target rides on each `execute` request (inside `params`), so re-targeting a Report never mutates a process-wide "active connection." Other tabs, which omit the id, keep hitting the boot manager. This is the only design that satisfies both AR-2 and per-tab isolation.
- **Why a resolver dep, not 5 target-aware seams:** the executor today takes five fixed seams bound to the boot manager. Replace them with a single `resolveConnection(id?) => seams` the executor calls once per `execute`; the default (id absent) returns the boot manager's seams, keeping the untargeted path byte-identical. Keeps the target logic in one testable place (`connection-targets.ts`).
- **Credentials stay in the Core:** the picker is fed by `connections.list` (credential-free `{id,name}`); resolution to a url happens only via `credentialStore.getConnection(id).url` inside `connection-targets.ts`. The id is the only thing that crosses loopback.
- **Stale-target guard:** `runBlock` captures the target at fire time; `applyOutcome` no-ops the *state fold* if the report's current `targetConnectionId` has since changed — the same shape as 6.1's "block removed mid-flight" no-op, extended to "target superseded mid-flight." **Critical difference from the removed-block case:** a superseded block STILL EXISTS, so dropping its completion must ALSO clear its transient run state (`busy=false`, release the `firing` guard). The removed-block no-op could skip cleanup because a removed block has no UI; a superseded block does — skipping cleanup strands it "running…" forever and blocks its re-fire.
- **Retarget is a whole-report lifecycle transition, not just N independent re-runs.** A retarget must leave EVERY query block consistent with the new target. Blocks are not always idle when the picker changes: one may be mid-run against the old target, another may be sitting in a pending-confirm dialog. The lifecycle rule, centralised in the pure `planRetarget` helper so it is testable without a DOM:
  - **idle block** → re-fire against the new target.
  - **in-flight (busy) block** → its old-target completion is superseded (dropped) and its transient state cleared; it is re-fired against the new target. No block may keep old-target data or stay stuck busy. A naive `if (busy) return` guard in the re-run loop is the bug: it skips exactly the blocks that most need re-firing.
  - **confirm-pending block** → the pending confirm belonged to the old target and MUST be cleared by the retarget. The block is re-run (returning a fresh preview against the new target if still guarded). This closes the destructive-op hole: a `DELETE` previewed against test A can never be confirmed straight onto prod B, because switching to B invalidates the A preview.
  - Because `setReportTarget` is committed via a functional updater but React has not necessarily re-rendered when the re-fires start, the new target is passed EXPLICITLY into every re-fire (never read back from `stateRef`).
- **Confirm carries its target:** the transient `confirm` run-state records the target that produced the preview; `confirmBlock` fires the confirmed statement against THAT captured target, not the live picker value — belt-and-suspenders with the retarget-cancels-confirm rule above.
- **Core cache must self-invalidate:** the per-id target-manager cache stores the url it was opened with. Every `resolve` of a cached id re-reads `getStoredUrl(id)` and, on a mismatch (repointed) or `undefined` (removed), closes+evicts the stale manager before re-resolving. Otherwise a connection edited or revoked in Settings keeps executing against its old live connection for the whole session — a correctness bug and a revocation/security gap. The registry is the single source of truth, not the cache.

## Verification

**Commands:**
- `bun test src/ui/report src/core/connection-targets.test.ts src/core/executor.test.ts` -- expected: all report + targeting + executor tests pass
- `bunx tsc --noEmit` -- expected: no type errors (strict, `noUncheckedIndexedAccess`)
- `bun run build` -- expected: UI + sandbox bundles build cleanly

**Manual checks (if no CLI):**
- Save two connections (A test, B prod-like). Open a Report, add a query block, run it against the default/A target. Switch the target picker to B: the block re-runs and shows B's rows, while block order/prose/chart are unchanged. Point a non-Report query tab at the same session: it still queries the launch connection.

## Auto Run Result

Status: done (one bad_spec loopback + one post-loopback patch pass).

### Implemented change
A Report tab can now be re-targeted at a different saved database connection: the author picks a target from a "Default (launch connection)" + saved-connections picker, and every query block re-runs against the new target through the Core, layout untouched. The UI sends only a connection **id**; the Core resolves the url in-Ring-1 via the credential store, lazily opens+caches a connection manager per target (self-invalidating on repoint/removal), and runs the query against it. The untargeted path (no id) is byte-identical to pre-6.2, so all other tabs are unaffected.

### Files changed
- `src/shared/contract.ts` -- `ExecuteRequest` gains optional `connectionId?: string | null`.
- `src/core/connection-targets.ts` (NEW) + `.test.ts` (NEW) -- per-id target-manager resolver: default→boot, lazy-open+cache, cache self-invalidation on url change/removal, unknown→`not-found`, store-unavailable→distinct signal, `closeAll` with a closed-latch.
- `src/core/executor.ts` + `.test.ts` -- `ExecutorDeps` collapsed to a single `resolveConnection`; `execute` validates `connectionId`, resolves seams once per call (raw + structured), maps not-found/unavailable to typed replies.
- `src/core/connection-registry.ts` -- Core-internal `getStoredUrl(id)` distinguishing found / unknown / store-unavailable (never RPC-dispatched).
- `src/core/server.ts` -- wires the resolver from the boot manager + registry, feeds the executor `resolveConnection`, calls `closeAll()` on shutdown.
- `src/ui/workspace/run-raw-query.ts` + `.test.ts` -- trailing `connectionId?` arg, forwarded only when set (2-arg callers unchanged).
- `src/ui/report/report-state.ts` + `.test.ts` -- `targetConnectionId` field + `setReportTarget` reducer (layout-preserving).
- `src/ui/report/retarget-plan.ts` (NEW) + `.test.ts` (NEW) -- pure DOM-free retarget lifecycle planner (re-fires every non-blank query block; resets busy + drops old-target confirms; skips blank-SQL blocks).
- `src/ui/report/ReportTabView.tsx` + `.test.tsx` -- target picker, `handleRetarget` via `planRetarget`, explicit-target `fireAgainst`, per-run generation guard so superseded completions never strand/false-idle a block, confirm target-stamping.

### Review findings
- **Pass 1 (bad_spec loopback):** the retarget↔run lifecycle was under-specified — 2 HIGH (superseded run stranded a block "running…" forever; a confirmed destructive statement could commit against a different target than its preview) + real MEDIUM/LOW gaps (mixed-target state, Core cache never invalidated on edit/remove, store-unavailable/unknown-id conflation, zero lifecycle test coverage). Amended the spec (Design Notes lifecycle contract, `retarget-plan` helper, cache-invalidation, structured-path test, 5 ACs) and re-derived the code.
- **Pass 2 (patches):** 2 MEDIUM patches applied — per-run generation guard (fixed a concurrent-run transient-state corruption where a superseded run false-idled a still-running block) and skipping blank-SQL blocks on re-target (no spurious errors on pristine blocks). 9 low/tolerable findings rejected (no data- or target-integrity break); see the Review Triage Log.

### Follow-up review
Recommended: **true** — the final pass changed the run-completion control flow (gating all transient-state writes on a per-run generation), which touches the FR-18 concurrency contract; a fresh independent look at that guard is worthwhile despite the two prior adversarial passes.

### Verification
- `bunx tsc --noEmit` -- clean (strict, `noUncheckedIndexedAccess`).
- `bun test src/ui/report src/core/connection-targets.test.ts src/core/executor.test.ts` -- 140 pass, 0 fail.
- `bun test src/core src/ui` (regression) -- 831 pass, 0 fail.
- `bun run build` -- UI + sandbox bundles built cleanly.

### Residual risks
- Confirmed destructive commit's "N rows affected" note is dropped if the author retargets during the confirmed run (write hits the correct previewed target; only the notification is lost — narrow race).
- Connections picker is fetched once on mount; a connection added in Settings after the tab opens won't appear until remount (a since-removed id is safely rejected by the Core).
- Cross-engine re-target (e.g. Postgres→MySQL) surfaces per-block SQL errors by design (no SQL translation — spec `Never`).
- The retarget-lifecycle generation gating lives in the component's `applyOutcome`; the repo has no jsdom, so its correctness is covered by the regression suite rather than a dedicated DOM unit test (the DOM-free share is exercised by `retarget-plan.test.ts`).

## Follow-up Review (2026-07-12)

An independent follow-up review pass (Blind Hunter + Edge Case Hunter, same model capability) ran against the full baseline→HEAD diff.

- **1 MEDIUM patch applied:** the per-run generation guard gated the transient `busy` clear on `isLatest` but not the RESULT FOLD, so an older same-target re-fire completing after a newer one (rapid `A→B→C→B`) could overwrite fresh data with a stale snapshot. Fixed with an early `if (!isLatest) return;` before the outcome switch (last-FIRED wins), simplifying the now-redundant inner guards. Per-block gating keeps FR-18 sibling preservation intact.
- **11 findings rejected** — all by-design (the FR-19 `connectionId` surface over the token-gated loopback; retarget re-running typed query blocks; mount-once connection list) or previously-triaged noise (picker cosmetic desync, target-down `internal_error` classification, mid-query eviction race, lagging-`stateRef` supersede read, dead `else` branch, empty-string id, confirm-note drop). None represent a new data- or target-integrity break.
- **Verification:** `bunx tsc --noEmit` clean; `bun test src/ui/report src/core/connection-targets.test.ts src/core/executor.test.ts` → 140 pass / 0 fail; `bun test src/core src/ui` regression → 831 pass / 0 fail; `bun run build` → UI + sandbox bundles clean.
- **Further follow-up recommended:** false — a single localized gating fix on a path already given three adversarial passes; it makes an existing guard uniform rather than introducing new behavior.
