---
title: 'DW-52 — Re-entrant connection reload in the Live Report runtime'
type: 'bugfix'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
baseline_revision: '0e8f2f53866e2367f1b116d387d2c92329da1743'
final_revision: '955048755d864b52e6e60b93a0f55c6bbc2d551f'
---

<intent-contract>

## Intent

**Problem:** In `src/live-report/runtime.ts`, a `connections.list` failure at initial load sets the top-level `CANNOT_REACH_HTML` banner and renders a Default-only picker, then `runLiveReport` returns early. `runAll` (wired to both the picker and Refresh) only re-issues `execute` per query block — it never re-attempts `loadConnections`, clears the banner, nor rebuilds the picker. So after the Core recovers, a Refresh re-queries and renders live data beneath a contradictory failure banner, with named connections still missing until a full page reload.

**Approach:** Make the runtime re-entrant on connection load by folding `loadConnections` into `runAll` under the existing run-generation guard: every run (initial, picker pick, Refresh) re-lists connections; on success it clears the failure banner (only if one was shown) and rebuilds the picker to reflect the fresh connections and the current pick; on failure it (re)shows the banner, rebuilds a Default-only picker, and surfaces the per-block "cannot reach" note without issuing `execute`. The picker becomes replaceable and reflects the current pick.

## Boundaries & Constraints

**Always:**
- Preserve the run-generation concurrency guard: only the latest run may mutate the top-level status, the picker, or any block slot. Gate every post-`await` mutation with `isCurrent()`.
- Preserve the current pick (`current`) across connection reloads; the rebuilt picker must visually reflect it.
- Keep the no-token inert path unchanged (never touch `/rpc`).
- Keep each query block isolated (a throw in one never drops siblings) and never auto-confirm a destructive statement.
- Keep the Ring discipline and the pure/injectable seam design (logic testable DOM-free over `LiveDeps` + `LiveHost`).
- On a connection-load failure, clear each query slot before appending the `CANNOT_REACH_BLOCK_NOTE` so a previously-rendered table is not left stale beneath the note.

**Block If:**
- A change would require importing Ring-2 modules or adding a new network dependency to satisfy re-entrancy.

**Never:**
- Do not re-issue `execute` when the connection list failed to load.
- Do not reset `current` on a failed reload (a down→up cycle must return to the same pick).
- Do not change the exported string constants' wording or the `execute`/`connections.list` RPC contracts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Healthy initial load | token present, `connections.list` ok | no failure banner; picker lists Default + named connections (Default selected); each query block runs and renders | per-block try/catch |
| Failed initial load | token present, `connections.list` fails | `CANNOT_REACH_HTML` banner; Default-only picker; each query slot cleared then shows `CANNOT_REACH_BLOCK_NOTE`; NO `execute` issued | banner + inline note |
| Recovery via Refresh | prior failed load, Core now up, viewer clicks Refresh | banner cleared; picker rebuilt with named connections (current pick selected); every query block re-queries and renders live data | per-block try/catch |
| Still-down Refresh | prior failed load, Core still down, viewer clicks Refresh | banner remains; Default-only picker; each slot cleared then re-shows the note; still NO `execute` | banner + inline note |
| Overlapping runs | rapid picker change / Refresh while a run is in flight | only the latest run mutates status, picker, and slots; superseded run appends nothing | generation guard drops superseded appends |
| Down→up with named pick | healthy load, pick `conn-b`, Core down (Refresh fails, Default-only picker, `current` stays `conn-b`), Core up (Refresh) | picker shows `conn-b` selected; blocks run against `conn-b` | as above |

</intent-contract>

## Code Map

- `src/live-report/runtime.ts` -- `runLiveReport` (orchestration), `runAll` (re-query driver), `loadConnections` (RPC), `LiveHost.renderPicker` (contract), `bootstrap` (DOM host). All changes live here.
- `src/live-report/runtime.test.ts` -- DOM-free unit tests over `LiveDeps` + fake `LiveHost`; `fakeHost` must adopt the new `renderPicker` signature; add recovery-scenario tests.

## Tasks & Acceptance

**Execution:**
- [x] `src/live-report/runtime.ts` -- Change `LiveHost.renderPicker` to `(connections, selectedId, onPick)` so it is replaceable and reflects the current pick; update its JSDoc to state it may be re-invoked and must replace any prior picker.
- [x] `src/live-report/runtime.ts` -- Refactor `runLiveReport`: build block slots and wire Refresh once, then move connection loading INTO `runAll`. `runAll` captures a generation, `await loadConnections`, returns early if superseded; on success clears the banner only if one was shown (track a `statusFailed` flag) and rebuilds the picker with `(connections, current, onPick)`; on failure sets `CANNOT_REACH_HTML`, rebuilds a Default-only picker, and for each query slot calls `clear()` then `appendError(CANNOT_REACH_BLOCK_NOTE)` without issuing `execute`; on success runs every query block against `current` under the same `isCurrent` guard. Kick off the initial `runAll()`.
- [x] `src/live-report/runtime.ts` -- Update the `bootstrap` DOM host: add a dedicated picker container so the picker always precedes Refresh; make `renderPicker` clear that container before appending (replace, not stack) and set `select.value = selectedId ?? ""` after options are built.
- [x] `src/live-report/runtime.test.ts` -- Update `fakeHost.renderPicker` to the new signature and record the connections + selectedId per render; make refresh-timing flushes robust (drain enough microtasks). Add tests for: recovery via Refresh clears the banner + rebuilds the picker with named connections + re-runs blocks; still-down Refresh re-shows the note and issues no `execute`; down→up preserves the named pick.

**Acceptance Criteria:**
- Given a failed initial `connections.list` and a subsequently-recovered Core, when the viewer clicks Refresh, then the failure banner is cleared, the picker lists the named connections, and every query block renders live data — no full page reload required.
- Given a failed initial load and a still-down Core, when the viewer clicks Refresh, then the banner remains, no `execute` RPC is issued, and each query block shows the cleared "cannot reach" note.
- Given two overlapping runs, when the superseded run's awaits resolve last, then it mutates neither the status, the picker, nor any slot (only the latest run renders).
- Given a healthy load where the viewer picked a named connection and the Core then cycled down and back up, when the viewer refreshes after recovery, then the picker shows that named connection selected and the blocks query against it.
- Given the no-token state, when `runLiveReport` runs, then no `/rpc` call is attempted and the inert state is unchanged.

## Design Notes

`runAll` becomes the single re-entrant entry point. Sketch:

```ts
let current: string | null = null;
let statusFailed = false;
let latestRun = 0;
const runAll = async (): Promise<void> => {
  const myRun = ++latestRun;
  const isCurrent = () => myRun === latestRun;
  const loaded = await loadConnections(deps);
  if (!isCurrent()) return;                    // superseded — newer run owns the UI
  const connectionsFailed = loaded === null;
  if (connectionsFailed) { host.setStatus(CANNOT_REACH_HTML); statusFailed = true; }
  else if (statusFailed) { host.setStatus(""); statusFailed = false; }   // clear on recovery
  host.renderPicker(loaded ?? [], current, (pick) => { current = pick; void runAll(); });
  if (connectionsFailed) {
    for (const { slot } of querySlots) { slot.clear(); slot.appendError(CANNOT_REACH_BLOCK_NOTE); }
    return;                                     // never issue execute against a down Core
  }
  await Promise.all(querySlots.map(async ({ block, slot }) => {
    try { await runBlock(deps, block, current, slot, isCurrent); }
    catch (err) { if (isCurrent()) slot.appendError(err instanceof Error ? err.message : "block failed"); }
  }));
};
host.renderRefresh(() => { void runAll(); });
await runAll();
```

The status clear is gated by `statusFailed` so a recovery only clears a banner that was actually shown (never emits a spurious empty `setStatus` on a normal run). The picker rebuild and the failed-path block loop are synchronous after the sole `await loadConnections` + `isCurrent()` check, so no newer run can interleave between them.

## Verification

**Commands:**
- `bun test src/live-report/runtime.test.ts` -- expected: all tests pass, including the new recovery/still-down/down-up cases.
- `bunx tsc --noEmit` -- expected: no type errors from the `renderPicker` signature change (all call sites updated).

## Review Triage Log

### 2026-07-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 3, low 5)
- addressed_findings:
  - `[medium]` `[patch]` `current`/`select.value` divergence: a pick with no matching option (Default-only failure picker, or a connection deleted between runs) left `current` holding a phantom id and the DOM `<select>` blank. Fixed by reconciling `current` against the freshly-listed connections ONLY on the success path (failure preserves the pick for the down→up cycle) so `execute` never targets a vanished id, plus a DOM-host fallback (`if (select.selectedIndex < 0) select.value = ""`) so the picker shows Default instead of a blank control.
  - `[medium]` `[patch]` core replaceable-picker fix (replace-not-stack + `select.value`) had zero automated coverage. Extracted the DOM host into an exported `makeDomHost` seam and added two DOM-host tests (over a minimal fake `Document` that models `<select>.value` option-matching) asserting replace-not-stack, pick reflection, and the absent-id→Default fallback; added `pickerRenders` assertions at the runtime layer (once per run).
  - `[low]` `[patch]` recovery test asserted membership not order; strengthened to assert the exact `setStatus` sequence (`[CANNOT_REACH_HTML]` then `[CANNOT_REACH_HTML, ""]`) so a stale banner surviving recovery is caught.
  - `[low]` `[patch]` `pickerRenders` getter was exposed but unasserted; now asserted in the recovery and down→up tests.
  - `[low]` `[patch]` the run-generation comment over-promised "picked up without a page reload"; clarified that recovery is user-initiated (Refresh / picker change) with no auto-poll.

### 2026-07-20 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 2: (high 0, medium 0, low 2)
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[low]` `[patch]` the DW-52-added post-`loadConnections` `isCurrent()` guard (the actual re-entrancy boundary a superseded connection-load run returns at) had no direct test — the prior overlapping-runs test only exercised supersession at the `execute`/`runBlock` layer. Added `overlapping runs at the connection-load boundary`: deferred `connections.list` replies drive run-1/run-2 overlap at the `loadConnections` await, resolve the latest (healthy) run first then the superseded run last as a FAILURE, and assert the superseded late resolve plants neither a stale `CANNOT_REACH_HTML` banner nor a Default-only picker over the newer run's UI (`statuses === []`, `pickerRenders === 1`, named connections survive). Suite now 25 pass.

## Auto Run Result

Status: done

### Summary
Made the Live Report runtime (`src/live-report/runtime.ts`) re-entrant on connection load (DW-52). `loadConnections` is now folded into `runAll` — the single re-entrant driver wired to the initial load, the picker, and Refresh — under the existing run-generation guard. Every run re-lists connections: on success it clears the "cannot reach" banner (only if one was shown), reconciles the current pick against the fresh list, and rebuilds the replaceable picker; on failure it (re)shows the banner, rebuilds a Default-only picker (preserving the pick internally), and surfaces the per-block note without issuing `execute`. A recovered Core is now reflected on the next Refresh without a full page reload.

### Files changed
- `src/live-report/runtime.ts` -- folded connection loading into `runAll`; hoisted the `onPick` callback; added `statusFailed` banner tracking + recovery clear; added pick reconciliation against the fresh list; restructured the failure path as an early return; extracted the DOM host into an exported `makeDomHost` with a `select.value`→Default fallback; changed `LiveHost.renderPicker` to `(connections, selectedId, onPick)`.
- `src/live-report/runtime.test.ts` -- new `renderPicker` signature in `fakeHost` (records latest connections/selectedId + `pickerRenders`); robust microtask flush; new tests for recovery-via-Refresh, still-down Refresh, down→up pick preservation, vanished-pick reconciliation, and two `makeDomHost` DOM-host tests.

### Review findings breakdown
- Patches applied: 5 (2 medium, 3 low) — see Review Triage Log.
- Items deferred: 1 (low). Per the invocation directive ("Do NOT edit the deferred-work ledger; the orchestrator records resolution"), the ledger was NOT edited — surfaced here for the orchestrator: the DOM host's `appendError` prefixes "block failed: ", so an infra-down note renders as "block failed: cannot reach quick-studio — re-query when it is running", mislabeling a down Core as a block failure. Pre-existing (not caused by this change), cosmetic copy issue.
- Items rejected: 8 — fixed-count microtask flush (house-consistent idiom), picker rebuild churn (specified behavior), empty-report still lists connections (pre-existing/harmless), non-array `connections.list` result → `[]` (pre-existing/defensive), unguarded failure-path throw + no `await` timeout + blank-SQL "cannot reach" note + half-render on initial throw (pre-existing patterns / out of scope / trusted host — `makeRpc` always resolves).

### Verification
- `bun test src/live-report/runtime.test.ts` → 24 pass, 0 fail (73 expect() calls).
- `bunx tsc --noEmit` → exit 0, no errors (whole project; the only other `renderPicker` reference is the minified `src/core/live-report-bundle.generated.ts` build artifact, untouched and clean).

### Residual risks
- The DOM host tests exercise a hand-rolled fake `Document`, not a real browser; they model `<select>.value` option-matching semantics but cannot catch a browser-specific quirk.
- The picker is rebuilt on every run; an open dropdown mid-Refresh would be re-created (transient, low-consequence, and inherent to the specified rebuild).

### Follow-up review pass (2026-07-20)
An independent follow-up review (Blind Hunter + Edge Case Hunter, same model capability) re-examined the full baseline→HEAD diff. Both reviewers independently confirmed the re-entrancy refactor is correct: the run-generation guard is placed right after the sole `await loadConnections` and before any shared-state mutation, so no overlapping-run interleaving diverges the banner/picker/slot state. No high or medium defect was caused by this change; no intent_gap or bad_spec.

- **Patch applied (1, low):** added `overlapping runs at the connection-load boundary` to `runtime.test.ts` — the DW-52-added post-`loadConnections` `isCurrent()` guard now has a direct test (a superseded FAILED connection-load run resolving last plants neither a stale banner nor a Default-only picker over the newer healthy run's UI). Suite now **25 pass, 0 fail (80 expect() calls)**; `bunx tsc --noEmit` → exit 0.
- **Deferred (2, low)** — appended as NEW entries to the deferred-work ledger (existing entries untouched): (1) the Core-down inline note is prefixed "block failed: " by `appendError`, mislabeling an infra-down Core as a per-block failure (pre-existing copy issue, re-confirmed from the prior pass); (2) `loadConnections` maps an `ok`-but-non-array `connections.list` result to `[]`, so the new success-path pick reconciliation silently drops a held named pick on a transient/malformed empty list (pre-existing `[]` coercion root).
- **Rejected (3, low):** fixed-count microtask flush (house-consistent idiom), unhandled promise rejection if a trusted host method throws inside `void runAll()` (host is trusted — constants are static HTML, DOM ops on freshly-created elements), and no Refresh debounce/fetch-storm (specified behavior — every run re-queries; the generation guard renders only the latest).

Follow-up review recommendation: **false** — this pass added a single localized low-consequence test and touched no product code; no further independent review is warranted.
