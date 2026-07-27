---
title: 'Insert-draft UX: reveal the in-grid draft on Add-Row, and reset it on page navigation'
type: 'bugfix'
created: '2026-07-27'
status: 'done'
baseline_revision: '8bff238a8ba79bfbd4daf9ac7ac56edb19d9b936'
final_revision: '6b2a5e4'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** Two deferred UX gaps on the shared TabContent/DataGrid insert surface. **DW-56:** the result-bar Add-Row (`row`) button sets `insertOpen = true`, but the in-grid insert draft renders as the last child of `<tbody>` inside the `overflow-auto` grid container — on a full or scrolled page the draft is off-screen, so the click looks like it did nothing. **DW-57:** `insertOpen` (lifted into `TableTabView`) and `InsertDraftRow`'s local `values`/`nulls` are never cleared on page navigation; `TableTabView` is keyed by bound table, not by page, so Prev/Next leaves a half-typed draft open over a freshly loaded page with the previous page's typed values.

**Approach:** DW-56 — inside `InsertDraftRow`, keep a DOM ref on the draft's trailing row and, on a closed→open transition, call a guarded `scrollIntoView({ block: "nearest", inline: "nearest" })`, so the draft's bottom edge (and the inputs row directly above it) is pulled into the grid's scroll container. DW-57 — add a `useEffect` in `TableTabView` that clears `insertOpen` when `page` changes, and an effect in `InsertDraftRow` that clears `values`/`nulls` whenever `open` goes false, so a parent-driven close discards the draft exactly like Cancel does. The scroll decision and the guarded scroll call are extracted into a new pure module so they are unit-testable in a DOM-less harness.

## Boundaries & Constraints

**Always:**
- Presentation/UX only. Preserve every `table.rows` read, the guarded `execute` mutation path, `buildInsertOp`/`row-mutations.ts`, the `DataGridState` model and its pure helpers, the remount-per-bound-table `key`, the `inFlight`/`firing` double-submit refs, and the `reloadNonce` retry — byte-for-byte in behavior.
- Do **not** change the fetch effect at `TabContent.tsx:162-199`: no new deps, no changed params, no touched alive-guard, `applyPage` fold, or disabled-pager-on-error semantics. The DW-57 reset is a **separate** effect keyed on `[page]`, mirroring the existing `[filterQuery]` selection-clear effect at `TabContent.tsx:284-286`.
- Guard the DOM call (`typeof el.scrollIntoView === "function"`) — nothing in this repo polyfills it and `bun test` has no DOM.
- Follow project test convention: `bun test`, `react-dom/server` `renderToStaticMarkup`, **no** jsdom / testing-library. New logic that needs coverage goes into a pure `*.ts` module with a co-located `*.test.ts`, mirroring `grid-view.ts` / `schema-tree-state.ts`.
- Keep every existing test green with zero assertion churn.

**Block If:**
- Revealing the draft cannot be done without changing the grid's scroll container, the sticky `<thead>`, or the `<tbody>` row order — HALT `blocked`, condition `insert-draft reveal needs a layout change`.
- Clearing the draft on page change is found to also clear it on an unrelated refetch (mutation reload / `reloadNonce` retry) — HALT `blocked`, condition `draft reset leaks into refetch path`.

**Never:**
- Never edit `src/core/**`, `contract.ts`, `row-mutations.ts`, `create-table.ts`, `data-grid-state.ts`, or any RPC param/handling.
- Never close or clear the draft on `[data]` identity change inside `DataGrid` — that would also discard an open draft after an unrelated edit/delete reload. Page-driven reset belongs in `TableTabView`.
- Never add focus stealing (no new `autoFocus`, no imperative `.focus()`), no smooth/animated scrolling, no new dependency, no jsdom.
- Never introduce a render loop: clearing `values`/`nulls` must be a no-op when they are already empty.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Draft opens | `shouldRevealInsertDraft(prev=false, next=true)` | `true` — reveal on the closed→open transition | n/a |
| Draft already open | `shouldRevealInsertDraft(prev=true, next=true)` | `false` — no repeat scroll on re-render | n/a |
| Draft closes | `shouldRevealInsertDraft(prev=true, next=false)` | `false` | n/a |
| Draft stays closed | `shouldRevealInsertDraft(prev=false, next=false)` | `false` | n/a |
| Reveal with real element | element exposing `scrollIntoView` | calls it once with `{ block: "nearest", inline: "nearest" }`; returns `true` | n/a |
| Reveal, no element | `null` / `undefined` ref | returns `false`, no throw | swallowed by the guard |
| Reveal, DOM-less env | element without a `scrollIntoView` function | returns `false`, no throw | swallowed by the guard |

</intent-contract>

## Code Map

- `src/ui/data/insert-draft-ux.ts` (NEW, pure) -- `shouldRevealInsertDraft(prevOpen, nextOpen): boolean` (true only on the closed→open edge) and `revealInsertDraft(el): boolean` (guarded `scrollIntoView({ block: "nearest", inline: "nearest" })`, returns whether it fired). No React, no RPC — the DW-56 decision made unit-testable without a DOM.
- `src/ui/data/insert-draft-ux.test.ts` (NEW) -- `bun:test` unit tests for the full I/O matrix above, using a hand-rolled fake element (precedent: `src/live-report/runtime.test.ts`).
- `src/ui/data/DataGrid.tsx` -- in `InsertDraftRow` (:189-314): add `rowRef` (`useRef<HTMLTableRowElement | null>`) attached to the **trailing** commit/cancel `<tr>` (:290) so revealing it also brings the adjacent inputs row (:257) into view; add `prevOpenRef` and one `useEffect` on `[open]` that (a) reveals via the new helpers on the closed→open edge and (b) clears `values`/`nulls` when `open` is false, using functional updates that bail when already empty. `reset()` (:217-221), `commit()`, the `firing` guard, the collapsed `+ insert row` render, and the `insertOpen`/`onInsertOpenChange` controlled/uncontrolled merge (:359-361) stay unchanged. Do **not** touch the `[data]` effect at :367-370.
- `src/ui/workspace/TabContent.tsx` -- in `TableTabView`: add `useEffect(() => { setInsertOpen(false); }, [page]);` placed next to the existing `[filterQuery]` selection-clear effect (:284-286). No other change; the Add-Row button (:376-387), the pager (:400-415), the fetch effect (:162-199), and the DataGrid prop wiring (:457-469) are untouched.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/data/insert-draft-ux.ts` (NEW) -- add the two pure helpers -- isolates the DW-56 reveal decision + guarded DOM call so it is testable in a DOM-less `bun test` harness.
- [x] `src/ui/data/insert-draft-ux.test.ts` (NEW) -- unit-test every row of the I/O matrix (all four transition combos; reveal with a fake element, with `null`, and with an element lacking `scrollIntoView`) -- proves the edge-only trigger and the no-DOM safety guard.
- [x] `src/ui/data/DataGrid.tsx` -- wire `rowRef` + the `[open]` effect into `InsertDraftRow` (reveal on open, clear `values`/`nulls` on close) -- delivers DW-56's visible feedback and DW-57's stale-value half.
- [x] `src/ui/workspace/TabContent.tsx` -- add the `[page]` effect clearing `insertOpen` -- delivers DW-57's open-over-a-new-page half without touching the frozen fetch effect.

**Acceptance Criteria:**
- Given a mutable bound table scrolled so the bottom of `<tbody>` is out of view, when the user clicks the result-bar Add-Row (`row`) button, then the expanded draft's trailing commit/cancel row is scrolled into the grid's `overflow-auto` container and the inputs row above it is visible.
- Given the insert draft is already open, when `InsertDraftRow` re-renders for any other reason (busy flag, new `data`, column change), then no additional scroll is performed.
- Given a draft is open with typed values on page 1, when the user clicks `next` (or `prev`), then the draft is collapsed and its `values`/`nulls` are empty, so re-opening it on the new page shows blank inputs.
- Given an edit or delete triggers a data reload on the same page, when the reload completes, then an open insert draft stays open with its typed values intact.
- Given the existing suites (`data-grid-state`, `grid-view`, `workspace-state`, `create-table`, `row-mutations`, `IndexList`, `TabContent`), when the full test run executes, then every previously passing test still passes with no assertion edits.

## Spec Change Log

## Review Triage Log

### 2026-07-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 2: (high 0, medium 0, low 2)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` `prevOpenRef` was seeded with `open`, so a mount with `open === true` computed `shouldRevealInsertDraft(true, true)` → `false` and never scrolled. Reachable two ways: the `rows`/`indexes` toggle unmounts `DataGrid` while the lifted `insertOpen` stays `true`, and the result-bar Add-Row has no `disabled` guard so it can be clicked while the grid is absent (loading / load error) — both remount the draft already-open and un-revealed, i.e. the exact inert-click symptom DW-56 filed. Fixed: seed `useRef(false)` and document why.
  - `[low]` `[patch]` The `rowRef` comment asserted that revealing the trailing row "pulls the inputs row directly above into view too" unconditionally; `block: "nearest"` only guarantees the target's own bottom edge. Reworded to state the real guarantee (draft bottom edge in view; inputs row follows whenever the container fits both rows).
  - `[low]` `[patch]` The functional-bail comment claimed "a fresh `{}` every render would loop" — false with deps `[open]`, and misleading about the dep array's breadth. Reworded to the true rationale (avoids a pointless re-render on close; stays safe if deps widen).
  - `[low]` `[patch]` `RevealTarget` declared `scrollIntoView` optional, which made every object structurally assignable — a ref misattached to an unrelated value would typecheck and silently no-op. Tightened to `Pick<HTMLElement, "scrollIntoView">`; the runtime guard stays as the DOM-less net and its test now casts explicitly.
- deferred_findings (NOT written to the ledger — this run was instructed to leave the deferred-work ledger to the orchestrator; carry these forward from here):
  - `[low]` Toggling `rows` → `indexes` → `rows` with a half-typed draft unmounts `InsertDraftRow`, destroying `values`/`nulls`, while the lifted `insertOpen` stays `true` — the draft returns open but blank. Pre-existing (predates this change); the coherent fix is widening the reset effect's deps to `[page, view]`, which is scope beyond DW-57's "page navigation".
  - `[low]` No screen-reader affordance accompanies the visual reveal. The spec deliberately forbids focus stealing, but nothing fills the gap (no `aria-live`/status announcement), so a non-sighted user pressing Add-Row gets a scroll they cannot perceive — the accessibility analogue of DW-56. Pre-existing: opening the draft was never announced.

## Verification

**Commands:**
- `export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit` -- expected: exit 0, no new type errors (note `strict` + `noUncheckedIndexedAccess`).
- `export PATH="$HOME/.bun/bin:$PATH" && bun test src/ui/data/insert-draft-ux.test.ts` -- expected: all new tests pass.
- `export PATH="$HOME/.bun/bin:$PATH" && bun test` -- expected: pass count grows by the new tests; fail count unchanged from the pre-change baseline (capture the baseline before editing).

**Manual checks (if no CLI):**
- `src/ui/workspace/TabContent.tsx`: the `[page]` reset is its own `useEffect`; the fetch effect's dependency array is still exactly `[table.schema, table.name, table.connectionId, page, reloadNonce]`.
- `src/ui/data/DataGrid.tsx`: the `[data]` effect at :367-370 still only clears `editing`/`confirmingDelete`; the new `[open]` effect never calls `onOpenChange`.

## Auto Run Result

Status: done

**Implemented change.** Resolves the two deferred insert-draft UX gaps (DW-56, DW-57) on the shared TabContent/DataGrid insert surface. The in-grid draft is now scrolled into its grid scroll container when it opens (including when it mounts already-open), and it is collapsed and emptied on page navigation instead of persisting with the previous page's typed values.

**Files changed:**
- `src/ui/data/insert-draft-ux.ts` (NEW) -- pure `shouldRevealInsertDraft` (closed→open edge predicate) + guarded `revealInsertDraft` (`scrollIntoView({ block: "nearest", inline: "nearest" })`), extracted so the DW-56 decision is testable in this repo's DOM-less harness.
- `src/ui/data/insert-draft-ux.test.ts` (NEW) -- 7 `bun:test` cases covering every row of the I/O matrix.
- `src/ui/data/DataGrid.tsx` -- `InsertDraftRow` gains `rowRef` on the trailing commit/cancel `<tr>`, a `prevOpenRef` seeded closed, and one `[open]` effect that reveals on the open edge and clears `values`/`nulls` on close. `reset()`, `commit()`, the `firing` guard, the `[data]` effect and the controlled/uncontrolled merge are untouched.
- `src/ui/workspace/TabContent.tsx` -- one `useEffect(() => setInsertOpen(false), [page])` beside the existing `[filterQuery]` selection-clear effect. The frozen fetch effect and its dep array are untouched.

**Review findings breakdown:** 4 patches applied (1 medium, 3 low), 2 items deferred (both low, recorded in the Review Triage Log rather than the ledger — this run was instructed not to edit the deferred-work ledger), 11 rejected as noise. 0 intent gaps, 0 spec defects, no repair loopback.

**Verification performed:**
- `bunx tsc --noEmit` -- exit 0, clean (strict + `noUncheckedIndexedAccess`), re-run after the review patches.
- `bun test` -- 1926 pass / 1 skip / 0 fail across 88 files. Pre-change baseline was 1919 pass / 1 skip / 0 fail across 87 files: +7 new tests, zero regressions, zero assertion edits to existing tests.
- Manual inspection confirmed both frozen-effect checks above.

**Residual risks:**
- The scroll behavior itself is not automated-test-covered and cannot be under this repo's convention (`renderToStaticMarkup` never runs effects; there is no jsdom). Tests prove the decision predicate and the guard; the wiring (ref placement, `[open]` effect, `[page]` effect) is verified by typecheck and code inspection only.
- `block: "nearest"` reveals the draft's bottom edge. If the grid pane is shorter than the draft's two rows combined, the inputs row can still be clipped above the fold — no `scrollIntoView` option fixes that.
- The two deferred items above (view-toggle blanking, missing screen-reader announcement) remain open.
