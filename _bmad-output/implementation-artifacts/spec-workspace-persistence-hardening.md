---
title: 'Workspace persistence hardening (DW-22/24/26/27)'
type: 'bugfix'
created: '2026-07-15'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
baseline_revision: '02c2fec913d3f02281e6dd9bd53a2f82c2fe717f'
final_revision: '3f9fbcba7dde51747bb756620d5a4e8ca287aaf8'
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The workspace save/restore path has four hardening gaps: (DW-22) a failed persistent `workspace.save` is silently `void`-ed, so a developer believes their layout is saved when every write is failing; (DW-24) a change made within `SAVE_DEBOUNCE_MS` (400ms) before Stop / window-close is dropped because the pending debounce is never flushed; (DW-26) `checkTabs`/`restoreWorkspace` accept duplicate tab ids, so a hand-edited snapshot can make `closeTab` remove two tabs at once; (DW-27) two overlapping in-flight saves can land out of order and persist the older snapshot.

**Approach:** Rework the debounced save in `App.tsx` into single-flight-with-trailing that inspects the reply, surfaces a failure via a terse mono status-bar indicator, and does not advance the persisted marker on failure (so it retries). Flush the pending save on quit — async before `shutdown`, synchronous (XHR) on `beforeunload`. Reject/deduplicate duplicate tab ids in both the save validator and the restore reducer.

## Boundaries & Constraints

**Always:**
- A persistent-mode save that returns `!reply.ok` MUST be surfaced to the user and MUST NOT advance `lastPersistedRef` (so the next change retries).
- At most one `workspace.save` RPC is in flight at a time; a change arriving during a save becomes a single trailing save fired on completion (latest snapshot wins).
- After a successful save the failure indicator clears.
- Tab ids are unique everywhere they are trusted: `checkTabs` rejects duplicates; `restoreWorkspace` returns at most one tab per id.
- Preserve existing invariants: `savingEnabled` gates all saving; `saved:false` in ephemeral mode is normal and is NOT a failure; `restoreWorkspace`'s `nextId`/`activeTabId` re-mint logic is unchanged.

**Block If:**
- `bun test` cannot run the two target test files, or `XMLHttpRequest`/`window.__QS_TOKEN__` are unavailable in this renderer (would make the sync flush impossible) — HALT `blocked`.

**Never:**
- Do not add a toast/snackbar system — reuse the existing status-bar `ConnectionIndicator` pattern.
- Do not treat `saved:false` (ephemeral mode) as an error.
- Do not change the wire contract (`SaveWorkspaceResult`, `RpcReply`) or the store's temp-file+rename write.
- Do not block or delay normal saving to add ordering — single-flight is client-side only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Save OK (persistent) | change debounced, `reply.ok`, `result.saved:true` | `lastPersistedRef` advances; indicator hidden | none |
| Save OK (ephemeral) | `reply.ok`, `result.saved:false` | treated as success; indicator hidden | none |
| Save write-failed | `reply.ok:false` `internal_error` | indicator shows "save failed"; `lastPersistedRef` NOT advanced → next change retries | surfaced, not thrown |
| Overlapping change | change fires while S1 in flight | recorded as trailing; fired once when S1 resolves with latest snapshot | at most one in flight |
| Stop with pending change | change <400ms before Stop button | flushed via awaited save before `shutdown` | if flush fails, indicator shows; shutdown still proceeds |
| Window close with pending change | `beforeunload` with unsaved snapshot | synchronous XHR save best-effort | best-effort; no throw out of handler |
| Duplicate ids on save | `tabs:[{id:1},{id:1}]` sent to `workspace.save` | `bad_request` (field `tabs`), not persisted | rejected in `checkTabs` |
| Duplicate ids on restore | hand-edited disk snapshot with dup ids passes load shape-guard | `restoreWorkspace` keeps first per id; `closeTab` removes exactly one | deduped defensively |

</intent-contract>

## Code Map

- `src/ui/workspace/save-scheduler.ts` — **NEW** pure, framework-free single-flight-with-trailing scheduler; the one serialization primitive every async save path goes through. Injectable `save` fn + `onPersisted`/`onError`/`onSuccess` callbacks; exposes `schedule`, `drain`, `isBusy`. Unit-testable in isolation.
- `src/ui/App.tsx` — debounced save effect (`:379-389`), `onStop`/`callShutdown` (`:130-151`,`:391-397`), `lastPersistedRef` (`:217`), `ConnectionIndicator` pattern (`:153-182`); wire a scheduler instance (debounce + `onStop`), `stoppingRef`, `saveTimerRef`, `saveFailed` state, `SaveIndicator`, an `isBusy`-guarded `beforeunload` effect, and a mounted/alive guard on post-`await` `setState`.
- `src/ui/rpc/client.ts` — typed `rpc<T>` (`:39-80`), token from `window.__QS_TOKEN__`; add best-effort `saveWorkspaceSync` (sync XHR, never throws).
- `src/ui/workspace/Workspace.tsx` — status bar (`:372-385`) hosting `connectionIndicator`; add `saveIndicator?` prop rendered alongside it.
- `src/core/workspace-registry.ts` — `checkTabs` (`:85-107`); add id-uniqueness check.
- `src/ui/workspace/workspace-state.ts` — `restoreWorkspace` (`:190-198`), `closeTab` (`:112-137`); dedupe ids in restore.
- `src/ui/workspace/save-scheduler.test.ts` — **NEW** scheduler unit tests. `src/core/workspace-registry.test.ts`, `src/ui/workspace/workspace-state.test.ts` — add DW-26 coverage.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/workspace-registry.ts` -- in `checkTabs`, after per-element validation, reject when tab ids are not unique with reason `"tab ids must be unique"` (maps to `bad_request` field `tabs`) -- DW-26 save-path guard.
- [x] `src/ui/workspace/workspace-state.ts` -- in `restoreWorkspace`, drop duplicate-id tabs keeping the first occurrence (preserve current `maxId`/`nextId`/`activeTabId` logic) so `closeTab` can never remove two -- DW-26 restore-path defense.
- [x] `src/ui/workspace/save-scheduler.ts` -- NEW pure module `createSaveScheduler({ save, onPersisted, onError, onSuccess })` implementing single-flight-with-trailing (DW-27) for ALL async saves. `save: (snapshot) => Promise<{ ok: boolean }>` is injected (App passes a thin `rpc` wrapper). Internals: `running` flag + single `pending: {serialized,snapshot}|null`. `schedule(serialized, snapshot)`: if `running`, overwrite `pending` (latest wins) and return; else run it. A run calls `save(snapshot)`, and on settle: `running=false`; if the reply is `ok` call `onPersisted(serialized)` then `onSuccess?()`, else `onError()` (never call `onPersisted` on failure — retry invariant); then if `pending` exists, run it. Defensive `.catch` so a rejected `save` cannot wedge `running=true` forever (treat as `onError`). Expose `drain(): Promise<void>` that resolves when idle (not running AND no pending), and `isBusy(): boolean` = `running || pending!==null`. No React, no direct `rpc` import -- fully unit-testable.
- [x] `src/ui/rpc/client.ts` -- add `export function saveWorkspaceSync(snapshot: WorkspaceSnapshot): boolean` doing a synchronous `XMLHttpRequest` `POST /rpc` with `x-qs-token` (reusing `window.__QS_TOKEN__`) and body `{ method: "workspace.save", params: snapshot }`; return `true` only when the parsed reply is `ok:true`; best-effort, never throws -- DW-24 unload transport (used ONLY by `beforeunload`, and only when the scheduler is idle).
- [x] `src/ui/App.tsx` -- rework the save path (DW-22/24/27) around ONE scheduler instance so at most one `workspace.save` is ever outstanding across debounce AND quit paths. (1) Create the scheduler once (`useMemo`/`useRef`) with `save: (s) => rpc<SaveWorkspaceResult>("workspace.save", s).then(r => ({ ok: r.ok }))`, `onPersisted: (ser) => { lastPersistedRef.current = ser; }`, `onError: () => setSaveFailed(true)`, `onSuccess: () => setSaveFailed(false)`. Note `saved:false` (ephemeral) yields `reply.ok===true` → success, no indicator. (2) Debounce effect: compute snapshot+serialized; if `savingEnabled`, not `stoppingRef.current`, and `serialized !== lastPersistedRef.current`, call `scheduler.schedule(serialized, snapshot)`; store the `setTimeout` handle in `saveTimerRef` and clear it in cleanup. Stop advancing `lastPersistedRef` optimistically -- the scheduler advances it only on success. (3) `onStop`: set `stoppingRef.current = true` and `setStopping(true)`; clear `saveTimerRef`; if `savingEnabled` and current snapshot differs from `lastPersistedRef`, `scheduler.schedule(...)` it; `await scheduler.drain()` (so the in-flight + trailing + quit save all complete in order, newest last -- no reorder); then `await callShutdown()` and `setStatus`. Guard every post-`await` `setState` with a mounted/alive ref so shutdown-time unmount can't warn. (4) `beforeunload` effect (guarded by `savingEnabled`): when `serialized !== lastPersistedRef.current` AND `!scheduler.isBusy()`, call `saveWorkspaceSync(snapshot)` and advance `lastPersistedRef` only if it returned `true`. When the scheduler IS busy, do nothing -- the async writer owns the write (never overlap a sync XHR with an in-flight async save). (5) Build a `SaveIndicator` element (mono, `bg-red-500` dot, `title` tooltip, mirroring `ConnectionIndicator`) rendered only when `saveFailed`, and pass it to `Workspace`.
- [x] `src/ui/workspace/Workspace.tsx` -- add optional `saveIndicator?: ReactNode` prop; render it in the bottom status bar next to `connectionIndicator` -- DW-22 surface.
- [x] `src/ui/workspace/save-scheduler.test.ts` -- NEW unit tests with a fake async `save` (manually-resolved promises): (a) single-flight -- while one save is unsettled, a second `schedule` does NOT start a concurrent save; (b) trailing/latest-wins -- multiple `schedule` calls during one in-flight save collapse to a single follow-up carrying the LAST snapshot; (c) ordering -- an older save never lands after a newer one (records call order); (d) failure -- a rejected/`ok:false` save calls `onError` and does NOT call `onPersisted`, and a subsequent `schedule` still runs (retry); (e) `drain()` resolves only after the in-flight save AND its trailing save both settle; (f) `isBusy()` true while running or pending, false when idle; (g) a rejected `save` promise does not wedge the scheduler (next `schedule` still runs).
- [x] `src/core/workspace-registry.test.ts` -- add cases: duplicate tab ids are rejected as `bad_request`/field `tabs`; unique ids still pass -- covers DW-26 save path.
- [x] `src/ui/workspace/workspace-state.test.ts` -- add cases: `restoreWorkspace` on a dup-id snapshot yields one tab per id; a subsequent `closeTab(id)` removes exactly one tab -- covers DW-26 restore path.

**Acceptance Criteria:**
- Given persistent mode and a store `write-failed`, when the debounced save runs, then the status bar shows the save-failed indicator and the next content change re-attempts the save (proven by `lastPersistedRef` not equalling the failed snapshot).
- Given a change fires while a save is in flight, when the in-flight save resolves, then exactly one trailing save is issued carrying the latest snapshot and no more than one save was ever concurrently in flight (proven by the scheduler unit tests).
- Given a layout change made <400ms before the Stop button, when Stop is pressed, then the change is persisted before `shutdown` is requested, the pending debounce is cancelled, and no save is ever issued outside the scheduler (so the in-flight save, its trailing save, and the quit save complete in order with the newest snapshot landing last — no reorder).
- Given an async debounced save is still in flight, when `beforeunload` fires, then the synchronous XHR flush is skipped (the async writer owns the write) so a sync and an async `workspace.save` never overlap.
- Given a snapshot whose `tabs` contain duplicate ids, when it reaches `workspace.save`, then it is rejected with `bad_request` (field `tabs`) and not persisted.
- Given a hand-edited on-disk snapshot with duplicate tab ids loads, when `restoreWorkspace` runs and the user closes one such tab, then exactly one tab is removed.

## Spec Change Log

### 2026-07-15 — bad_spec loopback (iteration 1)
- **Triggering findings:** Both reviewers converged that the DW-24 quit-flush paths issue `workspace.save` OUTSIDE the DW-27 single-flight gate — `onStop` fires a raw awaited `rpc` save (F1, high) and `beforeunload` fires a sync XHR save (F2, high), each able to overlap an in-flight debounced save and let the store's temp-file+`rename` persist the OLDER snapshot: the exact reorder DW-27 exists to prevent. `onStop` also failed to cancel the armed debounce timer (F4) and the trailing save could resurrect stale content after a quit save (F6); the "at most one save outstanding" comment was therefore false (F5); and the race-prone logic had zero tests (F10).
- **Amended (outside `<intent-contract>`):** Introduced a NEW framework-free `src/ui/workspace/save-scheduler.ts` as the single serialization primitive for all async saves; rewrote the App.tsx save task so debounce AND `onStop` both go through it (`onStop` cancels the debounce timer, `schedule`s, then `await drain()` before shutdown), and `beforeunload` only sync-writes when `scheduler.isBusy()` is false. Added a `save-scheduler.test.ts` task covering single-flight/trailing/ordering/failure-retry/drain/isBusy. Added a mounted/alive guard for post-`await` `setState` (F11), documented the intentional `checkTabs`-rejects vs `restoreWorkspace`-dedupes asymmetry (F7) and the self-heal-on-next-edit behavior (F8), and recorded the sync-XHR no-timeout (F3) and Electron-main-quit (F9) items as accepted teardown limitations / out-of-scope follow-ups.
- **Known-bad avoided:** a Stop or window-close during an in-flight save issuing a second concurrent `workspace.save` and persisting a stale layout; untestable inline concurrency.
- **KEEP (must survive re-derivation):** (1) DW-26 fixes are correct as reviewed — `checkTabs` validates `id` finiteness BEFORE the `Set<number>` uniqueness loop; `restoreWorkspace` keeps the FIRST occurrence per id and leaves `maxId`/`nextId`/`activeTabId` untouched. (2) DW-22 core: advance `lastPersistedRef` ONLY on `reply.ok`; leave it stale on failure so the next change retries; `saved:false` (ephemeral) is a success. (3) `SaveIndicator` mirrors `ConnectionIndicator` exactly (mono, `bg-red-500` dot, `title` tooltip); no toast system. (4) `saveWorkspaceSync` is best-effort, never throws, returns `true` only on `ok:true`. (5) Preserve the codebase's dense WHY-comment style.

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 6 (high 2, medium 3, low 1)
- patch: 0
- defer: 0
- reject: 6 (medium 2, low 4)
- addressed_findings:
  - `[high]` `[bad_spec]` (F1) `onStop` issues a raw `rpc` `workspace.save` outside the single-flight gate → reintroduces the DW-27 reorder. Amended: route `onStop` through the shared scheduler, cancel the debounce timer, and `await drain()` before shutdown.
  - `[high]` `[bad_spec]` (F2) `beforeunload` sync XHR overlaps an in-flight async save. Amended: sync-write only when `scheduler.isBusy()` is false.
  - `[medium]` `[bad_spec]` (F4) `onStop` doesn't cancel the pending debounce timer. Amended: store the timer in `saveTimerRef` and clear it in `onStop`; `stoppingRef` blocks new schedules.
  - `[medium]` `[bad_spec]` (F6) trailing save can resurrect stale content after a quit save. Amended: single scheduler ordering + `stoppingRef` guarantee the newest snapshot lands last.
  - `[medium]` `[bad_spec]` (F10) race-prone save logic had zero tests. Amended: extract a pure `save-scheduler.ts` and require unit tests for single-flight/trailing/ordering/drain/failure.
  - `[low]` `[bad_spec]` (F5) the "at most one save outstanding" comment was false across quit paths. Amended: the unified scheduler makes the invariant true; comment re-derived.
  - Rejected this pass (moot under re-derivation / accepted limitations documented in Design Notes): F3 sync-XHR no timeout (teardown-only; sync XHR forbids `timeout`), F7 reject/dedupe asymmetry (intentional), F8 disk self-heals on next edit, F9 Electron main-process quit needs a separate main-process hook (out of renderer scope), F11 post-`await` setState (folded in via alive guard), F12 failed quit save vs dead Core (page already unloading).

### 2026-07-15 — Review pass (post-re-derivation)
- intent_gap: 0
- bad_spec: 0
- patch: 3 (low 2, medium 1)
- defer: 1 (low)
- reject: 6 (low 3, info 3)
- addressed_findings:
  - `[low]` `[patch]` scheduler `run()` was not truly total — the fulfil arm destructured `({ ok })` in the parameter (a non-object resolution would throw a `TypeError` before clearing `running`) and a synchronous throw from `save` escaped with `running=true`, either wedging the scheduler so `drain()` never resolves. Fixed: single `settle()` path clears `running` first; `ok` read defensively (`result != null && result.ok === true`); the `save` call is wrapped in `try/catch`. Added two scheduler tests (sync-throw + non-object resolution do not wedge).
  - `[low]` `[patch]` `onError`/`onSuccess` set `saveFailed` without a mounted guard — a save settling after a shutdown-time unmount would warn. Fixed: both guard on `mountedRef.current`.
  - `[medium]` `[patch]` `onStop`'s `drain()` resolves even when the quit save FAILED, so shutdown proceeded and the last change was lost. Fixed: after `drain()` (scheduler now idle → no reorder), a best-effort `saveWorkspaceSync` retries when `lastPersistedRef` is still stale, before `callShutdown()`.
- Verdict: both reviewers confirmed the DW-27 concurrent-write reorder (the iteration-1 loopback cause) is closed on every exercised path. Remaining rejects are accepted design tradeoffs / info: F1 `beforeunload` no-op while the scheduler is busy trades a reorder for a bounded last-change loss on hard OS window-close (the SAFE side — never persists stale-over-fresh); F4 `beforeunload` re-subscribes per edit (cheap, no correctness impact); F5 sync-XHR unbounded at teardown (sync XHR forbids a timeout); F6/F7 dedupe is content-lossy and the on-disk duplicate self-heals on next edit (intended tolerant-load design). Deferred (surfaced to the orchestrator, NOT written to the ledger per run instruction): the revert-during-in-flight divergence where `lastPersistedRef` tracks the last-finished save rather than the chain tail, so a specific revert timing can leave memory and disk transiently divergent until the next edit (narrow, self-healing).

## Design Notes

Central bug behind DW-22: today `lastPersistedRef.current` is set to the serialized snapshot *before* the RPC resolves (`App.tsx:385`), so a failed write is remembered as persisted and an identical later change short-circuits (`:384`) — never retrying. Fix by advancing the ref only inside the `reply.ok` branch (via the scheduler's `onPersisted`).

**One scheduler is the whole point (DW-27 + why the first attempt was rejected).** The `<intent-contract>` invariant "at most one `workspace.save` RPC is in flight at a time" must hold across *every* save path, not just the debounce. The first implementation added `onStop` (awaited `rpc`) and `beforeunload` (sync XHR) as **separate** writers that bypassed the in-flight gate — so a Stop or window-close during an in-flight debounced save issued a second concurrent `workspace.save`, and the store's per-save temp-file+`rename` could land the older one last: the exact DW-27 reorder, reintroduced by the DW-24 code. The fix routes debounce AND `onStop` through one `createSaveScheduler`; `beforeunload` (which cannot `await`) instead *defers* to the scheduler by only writing when `isBusy()` is false. Because the scheduler runs saves strictly one-at-a-time in enqueue order, the newest snapshot always lands last. Keeping the primitive in a plain module (no React) is what makes the concurrency unit-testable — the earlier inline version had zero tests exactly where the races lived.

Scheduler core (framework-free):
```ts
function run(serialized, snapshot) {
  running = true;
  Promise.resolve(save(snapshot)).then(({ ok }) => {
    running = false;
    if (ok) { onPersisted(serialized); onSuccess?.(); } else onError(); // never onPersisted on failure → retry
    const p = pending; pending = null;
    if (p) run(p.serialized, p.snapshot); else resolveDrainWaiters();
  }, () => { running = false; onError(); const p = pending; pending = null; if (p) run(p.serialized, p.snapshot); else resolveDrainWaiters(); });
}
// schedule: running ? (pending = { serialized, snapshot }) : run(serialized, snapshot)
```

`onStop` cancels the armed debounce timer, `schedule`s the current snapshot, `await drain()`, then shuts down — so the last pre-Stop change is persisted with no reorder. `beforeunload` uses `saveWorkspaceSync` because an async `fetch` cannot reliably complete during teardown; sync XHR is the accepted last-chance path (it has no timeout — a wedged Core could briefly block window close, an accepted teardown-only trade-off, since sync XHR forbids `timeout`).

**Intended asymmetry (not a bug):** `checkTabs` *rejects* duplicate ids (strict, at the trusted save boundary) while `restoreWorkspace` *deduplicates* them (tolerant, because the load shape-guard is intentionally looser than `checkTabs` so a hand-edited file still opens). A deduped restore does not rewrite the file immediately (the seeded `lastPersistedRef` matches the deduped snapshot); the on-disk duplicate self-heals on the user's next real edit. `saved:false` (ephemeral, `filePath===null`) is a normal success — only `!reply.ok` is a failure.

**Known limitation (out of scope):** `beforeunload` covers only renderer-initiated window close; a main-process `app.quit()`/force-close/crash won't fire it. A durable flush-on-quit belongs in the main process and is a separate follow-up, not part of this renderer-side bundle.

## Verification

**Commands:**
- `bun test src/ui/workspace/save-scheduler.test.ts src/core/workspace-registry.test.ts src/ui/workspace/workspace-state.test.ts` -- expected: all pass, including single-flight/trailing/ordering/drain and the duplicate-id cases.
- `bun test` -- expected: no regressions across the suite.
- `bunx tsc --noEmit -p tsconfig.json` -- expected: no type errors (new scheduler, `saveWorkspaceSync`, `saveIndicator` prop).

**Manual checks (if no CLI):**
- Confirm no `rpc`/`saveWorkspaceSync` call to `workspace.save` exists outside the scheduler except the `beforeunload` sync path (guarded by `!scheduler.isBusy()`) and the `onStop` post-`drain()` fallback (only reached when the scheduler is already idle).
- Confirm `onStop` cancels the debounce timer and `await scheduler.drain()` before `callShutdown()`, and post-`await` `setState` is behind a mounted/alive guard.

## Auto Run Result

Status: done

**Change implemented.** Hardened the workspace save/restore path across the bundle's four deferred-work items:
- **DW-22** — the debounced `workspace.save` reply is now inspected; a failed persistent write surfaces a terse mono `SaveIndicator` in the status bar (modelled on `ConnectionIndicator`, no toast system) and the persisted marker is NOT advanced on failure, so the next change retries. `saved:false` (ephemeral) stays a success.
- **DW-24** — the last change made <400ms before quit survives: `onStop` cancels the pending debounce, flushes through the scheduler, `await drain()`s, and (if the async quit save failed) does a best-effort synchronous flush before `shutdown`; a new `beforeunload` handler does a synchronous XHR flush on window close when the scheduler is idle.
- **DW-26** — `checkTabs` rejects duplicate tab ids (`bad_request`, field `tabs`) at the save boundary and `restoreWorkspace` deduplicates (first-per-id) at the tolerant load boundary, so `closeTab` can never remove two tabs at once.
- **DW-27** — a new pure single-flight-with-trailing scheduler (`save-scheduler.ts`) is the ONE primitive every async save routes through, so at most one `workspace.save` is ever outstanding and the newest snapshot always lands last — the store's temp-file+`rename` can no longer reorder overlapping writes.

**Files changed:**
- `src/ui/workspace/save-scheduler.ts` (NEW) — pure single-flight-with-trailing scheduler; total `run()` settle path.
- `src/ui/workspace/save-scheduler.test.ts` (NEW) — scheduler concurrency unit tests (single-flight, trailing/latest-wins, ordering, failure-retry, drain, isBusy, no-wedge on reject/throw/non-object).
- `src/ui/App.tsx` — scheduler wiring for debounce + `onStop`; `stoppingRef`/`saveTimerRef`/`mountedRef`; `beforeunload` effect; `SaveIndicator`; guarded state sets.
- `src/ui/rpc/client.ts` — `saveWorkspaceSync` best-effort synchronous unload transport.
- `src/ui/workspace/Workspace.tsx` — `saveIndicator?` status-bar prop.
- `src/core/workspace-registry.ts` — `checkTabs` id-uniqueness check.
- `src/ui/workspace/workspace-state.ts` — `restoreWorkspace` first-per-id dedupe.
- `src/core/workspace-registry.test.ts`, `src/ui/workspace/workspace-state.test.ts` — DW-26 coverage.

**Review findings breakdown:** Two adversarial passes (Blind Hunter + Edge Case Hunter each pass). Pass 1 → one `bad_spec` loopback: the first attempt's quit-flush paths issued saves OUTSIDE the single-flight gate, reintroducing the DW-27 reorder; the spec was amended to mandate the unified scheduler and the code re-derived. Pass 2 → reorder confirmed closed; **3 patches applied** (scheduler `run()` totality; `mountedRef` guard on `onError`/`onSuccess`; `onStop` post-`drain` sync fallback), **6 rejected** (accepted tradeoffs / info), **1 deferred** (see residual risks). `review_loop_iteration: 1`.

**Verification:** `bun test src/ui/workspace/save-scheduler.test.ts src/core/workspace-registry.test.ts src/ui/workspace/workspace-state.test.ts` → 73 pass / 0 fail. `bun test` (full) → 1141 pass / 0 fail. `bunx tsc --noEmit -p tsconfig.json` → exit 0.

**Follow-up review recommended:** false — the final pass applied only three localized, test-covered, low/low-medium hardening patches with no API/data-loss impact; the concurrency core was independently confirmed sound by both reviewers.

**Residual risks (surfaced to the orchestrator; NOT written to the ledger per run instruction):**
- Revert-during-in-flight divergence: `lastPersistedRef` tracks the last-*finished* save, not the chain tail, so if a slow save `A` finishes while a trailing `B` is queued and the user reverts to `A`, memory can be `A` while disk becomes `B` until the next edit (narrow, self-healing). Candidate deferred-work follow-up.
- `beforeunload` covers only renderer-initiated window close and is a no-op while the scheduler is busy (the safe side of the reorder tradeoff — never persists stale-over-fresh, but can drop the newest sub-second change on a hard OS close mid-save). A durable flush-on-quit belongs in the main process (a `sendBeacon`/`keepalive` transport would also lift the busy-window no-op and the sync-XHR unbounded-block).
