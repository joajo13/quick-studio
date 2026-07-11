---
title: 'Run ad-hoc SQL in a query Tab'
type: 'feature'
created: '2026-07-11'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
baseline_revision: '63f19cb5cbd029483138c96cf51004793fed6734'
final_revision: '3be1665095595a37b66d8a9885f8b074f486ff76'
---

<intent-contract>

## Intent

**Problem:** The `"query"` tab kind exists in the workspace shell but renders only a placeholder — a developer cannot yet write and run arbitrary SQL, so they are trapped in the point-and-click surface (browse/edit/create) and cannot go beyond it (UJ-1, FR-11).

**Approach:** Build a `QueryTabView` that renders a monospace SQL editor and runs the typed text verbatim through the **already-existing** `execute` RPC raw path (`{shape:"raw", sql}`, Story 3.1). A `SELECT` returns `FrozenData` rendered in the existing read-only `DataGrid` with client-side pagination; a destructive/mutating statement comes back as `confirmation_required` and is executed only after an inline confirm re-issues the identical request with `confirmed:true`. The Core guarded executor is the sole gate and is not modified.

## Boundaries & Constraints

**Always:**
- Send the user's SQL **verbatim** as `rpc<ExecuteResult>("execute", { shape: "raw", sql })`. The UI never parses, splits, classifies, or composes SQL — the Core executor is the sole risk classifier and gate (AR-3).
- Render `status:"rows"` results with the existing `DataGrid` in **read-only** mode (omit `canMutate`/`onCommitEdit`/`onDeleteRow`/`onInsertRow`; `primaryKeys={[]}`).
- Route every `status:"confirmation_required"` reply through an inline confirm showing `preview.sql` + `preview.risk`; on confirm, re-issue the **identical** request with `confirmed:true`. The dialog is UX only.
- Reuse the codebase's inline render-swap confirm idiom (no modal framework) with Esc-to-cancel, mirroring `DataGrid`'s delete confirm.
- Paginate the returned result **client-side** over the capped rows using the pure `data-grid-state.ts` helpers.

**Block If:**
- Satisfying any acceptance criterion would require changing the Story 3.1 guarded executor, its classifier, or the `execute` RPC contract (a new RPC, a new result status, or server-side raw pagination) — HALT with status `blocked` rather than touch the guarded executor.

**Never:**
- No changes to `src/core/**` (executor, guard, drivers, rpc) — this is a UI-only story.
- No new RPC method and no new `WORKSPACE_TAB_KINDS` member (`"query"` already exists).
- No persisting query text to disk or into the `WorkspaceSnapshot` (contract invariant: the snapshot never stores query text). Draft SQL is session-only.
- No UI-side SQL parsing, multi-statement splitting, syntax highlighting, or autocomplete (multi-statement is rejected by the Core as a `bad_request`).
- No schema-tree refresh after a DDL statement (pre-existing connect-time memoized-cache behavior, same as Stories 3.4/3.5).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Run SELECT | Query tab, valid `SELECT`, Run clicked | `status:"rows"` → read-only `DataGrid` over the result with client-side prev/next paging and a "rows X–Y of N" summary | No error expected |
| Large SELECT | `SELECT` returning > 1000 rows | Grid renders the Core-capped rows; a "showing first 1000 rows (truncated)" banner is shown | No error expected |
| Destructive statement | e.g. `UPDATE`/`DELETE`/`DROP`/`INSERT`, Run clicked | `status:"confirmation_required"` → inline confirm shows `preview.sql` + `preview.risk`; on confirm, re-run `{..., confirmed:true}` → on `status:"ok"` show "N rows affected" | Cancel/Esc → nothing runs, editor unchanged |
| Multi-statement | `SELECT 1; DROP TABLE users` | Core returns `bad_request` error envelope; nothing executes | Inline error via `envelopeText(reply.error)` |
| Empty / whitespace SQL | Editor blank | Run is disabled; no RPC issued | No call made |
| Engine / syntax error | Invalid SQL | Error envelope surfaced inline | `envelopeText(reply.error)` shown; no grid |

</intent-contract>

## Code Map

- `src/ui/workspace/QueryTabView.tsx` (NEW) -- the query editor + runner. Monospace `<textarea>` bound to `draft`/`onDraftChange`; Run button + Ctrl/Cmd+Enter; calls `rpc<ExecuteResult>("execute", { shape:"raw", sql })` (client at `src/ui/rpc/client.ts`); local state for `result: FrozenData | null`, `page`, `selectedRow`, `confirm: {sql,risk} | null`, `affected: number | null`, `error`, `busy`. Renders read-only `DataGrid` for `"rows"`, inline confirm for `"confirmation_required"`, "N rows affected" for `"ok"`, `envelopeText` for `!reply.ok`.
- `src/ui/workspace/QueryTabView.test.tsx` (NEW) -- component tests mocking `rpc` (reuse the existing TabContent/DataGrid test rpc-mock idiom) for every I/O Matrix row.
- `src/ui/workspace/TabContent.tsx` -- add the `query` dispatch branch at the render switch (~L349/364, replacing the generic placeholder for `query`): `if (tab.kind === "query") return <QueryTabView draft={...} onDraftChange={...} />`. Thread the two new draft props down from its own props.
- `src/ui/App.tsx` -- add session-only `queryDrafts` state (`Map<number,string>` keyed by tab id) and an `onQueryDraftChange(tabId, sql)` setter; pass both toward `Workspace` (parallel to the existing table-specific props at ~L254-260). Never included in the `workspace.save` snapshot.
- `src/ui/workspace/Workspace.tsx` -- thread `queryDrafts`/`onQueryDraftChange` from `App` through to `TabContent` (parallel to the existing `primaryKeys`/`indexes` threading ~L254), resolving the active tab's draft as `queryDrafts.get(tab.id) ?? ""`.
- `src/ui/data/data-grid-state.ts` -- REUSE (no change): `createDataGridState`, `applyPage`, `prevPage`, `nextPage`, `canPrev`, `canNext`, `rowRangeSummary` drive client-side paging with `total = result.rows.length`.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/workspace/QueryTabView.tsx` -- build the SQL editor + runner: verbatim `execute` raw call, read-only `DataGrid` for rows, client-side pagination via `data-grid-state.ts`, inline confirm (Esc-to-cancel) re-issuing with `confirmed:true`, `truncated` banner, "N rows affected" for `ok`, inline `envelopeText` errors, Run disabled when blank.
- [x] `src/ui/workspace/TabContent.tsx` -- add the `query` kind branch to the render dispatch, rendering `QueryTabView` with threaded draft props instead of the generic placeholder.
- [x] `src/ui/App.tsx` -- add session-only `queryDrafts` state + `onQueryDraftChange`, threaded toward `Workspace`; keep it out of the `workspace.save` snapshot.
- [x] `src/ui/workspace/Workspace.tsx` -- thread `queryDrafts`/`onQueryDraftChange` to `TabContent`, resolving the active tab's draft.
- [x] `src/ui/workspace/QueryTabView.test.tsx` -- test each I/O Matrix scenario (SELECT→paginated grid, large/truncated, destructive→confirm→execute, cancel/Esc, multi-statement error, empty→Run disabled, engine error) with a mocked `rpc`.

**Acceptance Criteria:**
- Given a connected database and a query Tab, when I run a `SELECT`, then its rows render in a read-only, client-side-paginated result grid (prev/next + "rows X–Y of N"), with no SQL composed in the UI.
- Given a query Tab, when I run a destructive statement, then it does not execute until I explicitly confirm, and confirming re-runs the identical request with `confirmed:true` through the Story 3.1 guarded executor (the dialog is UX only, never the gate).
- Given the Story 3.1 guarded executor, guard, classifier, and the `execute` RPC contract, when this story ships, then they are byte-for-byte unchanged and no new RPC exists — the query Tab is a pure consumer of the existing raw path.
- Given typed but unrun SQL in a query Tab, when I switch to another tab and back, then my SQL is still there (session draft), and when I relaunch the app, then it is gone (never written to disk or the workspace snapshot).
- Given multi-statement input (e.g. `SELECT 1; DROP TABLE users`), when I run it, then the Core rejects it as a `bad_request` and nothing executes, surfaced as an inline error.

## Spec Change Log

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 2, medium 3, low 5)
- defer: 0
- reject: 4
- addressed_findings:
  - `[high]` `[patch]` `QueryTabView` was rendered without a `key`, and only the active Tab's `TabContent` mounts — so switching between two query Tabs reused ONE component instance: React updated the `draft` prop but preserved component-local `data`/`grid`/`confirm`/`pendingSql`. Tab B showed Tab A's grid and, critically, Tab A's pending destructive-confirm banner — confirming there would run Tab A's `DELETE`/`DROP` against the wrong Tab's intent. Fixed with `key={tab.id}` (the exact pattern the sibling `TableTabView` branch already uses to remount per bound table). (`src/ui/workspace/TabContent.tsx`.)
  - `[high]` `[patch]` `confirmRun` (and `run`) guarded only on the React state `busy`, which lands a render late — two synchronous confirm clicks both read `busy===false` and both re-issued `{shape:"raw", sql, confirmed:true}`, executing the same destructive statement TWICE. Added a `useRef` `firing` re-entrancy guard (the pattern `DataGrid`'s insert draft-row already documents for exactly this hazard). (`src/ui/workspace/QueryTabView.tsx`.)
  - `[medium]` `[patch]` `applyOutcome`'s `confirmation_required` branch cleared only `error`, leaving a prior SELECT's grid, pager, and "truncated" banner (and any "N rows affected") on screen beneath a confirm describing an unrelated statement. Now clears `data`/`truncated`/`affected` on confirm. (`QueryTabView.tsx`.)
  - `[medium]` `[patch]` `run`/Ctrl+Cmd+Enter fired unconditionally through an open confirm banner, silently overwriting `pendingSql` and abandoning the destructive confirm the user was mid-decision on. `run` is now blocked (and the Run button disabled) while a confirm is pending — the user must cancel/confirm first. (`QueryTabView.tsx`.)
  - `[medium]` `[patch]` The truncated banner hardcoded the literal "showing first 1000 rows", which drifts/lies if the Core cap ever differs, and read as a contradiction next to the pager's "of N". Reworded to derive the count from `data.rows.length` ("result truncated — showing the first N rows"), always accurate and consistent with the pager. (`QueryTabView.tsx`.)
  - `[low]` `[patch]` `applyOutcome`'s error branch did not reset `truncated`, so a "truncated" banner could persist over an error with no grid. Now reset. (`QueryTabView.tsx`.)
  - `[low]` `[patch]` `run`/`confirmRun` did `setBusy(true)` then bare `await` with no `try/finally` — a rejected `rpc` promise (or the new exhaustiveness throw) would latch `busy=true`, locking Run/Confirm for the session. Wrapped in `try/catch/finally` (busy always released; a thrown error surfaces inline). (`QueryTabView.tsx`.)
  - `[low]` `[patch]` `runRawQuery`'s final branch assumed `confirmation_required` for any non-rows/ok status, which would mislabel and crash (`.preview`) on a future 4th status. Replaced with an exhaustive `switch` + `never` default (compile-time guard). (`QueryTabView.tsx`.)
  - `[low]` `[patch]` The confirm banner's cancel button stayed enabled mid-flight (during a committing confirmed run), implying an abort it cannot perform. Now disabled while `busy`. (`QueryTabView.tsx`.)
  - `[low]` `[patch]` `queryDrafts` was never pruned on Tab close, leaking a closed query Tab's draft SQL for the session. `onClose` now deletes the closed Tab's entry. (`src/ui/App.tsx`.)
- rejected (4): Esc-to-cancel only works while the cancel button holds focus (it has `autoFocus`; this mirrors the established `DataGrid`/`SettingsPanel` inline-confirm idiom the spec asked to follow — a house-wide pattern, not a regression); the confirm/error/truncated banners use dark-only Tailwind palettes (the app is dark-first and `DataGrid` already hardcodes the same reds — pre-existing convention); the Run-enable predicate trims while the payload is sent verbatim (intentional per AR-3 — the UI never mutates the SQL, the Core is the sole gate); and the result grid wires single-row selection/highlight with no downstream consumer (the built-in `DataGrid` selection affordance, identical to its use in the table browse view).

### 2026-07-11 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 0
- reject: 13
- addressed_findings:
  - `[low]` `[patch]` The truncation banner read "showing the first N rows" while the grid viewport actually shows only one ~100-row page — a literal contradiction with what's on screen. Reworded to "result truncated — only the first N rows were returned" (states what the Core returned, not what the viewport shows). (`QueryTabView.tsx`.)
  - `[low]` `[patch]` The SQL editor `<textarea>` carried only a `placeholder` — not an accessible name, and it disappears on input — leaving the feature's primary input unlabeled for screen readers, inconsistent with the codebase's `aria-label`ed controls (e.g. `DataGrid`). Added `aria-label="sql query editor"`. (`QueryTabView.tsx`.)
  - `[low]` `[patch]` The mutation result rendered the ungrammatical "1 rows affected" for a single-row write. Pluralized to "N row / N rows affected" via `affected === 1`. (`QueryTabView.tsx`.)
- rejected (13): re-entrancy double-execute guard has no interactive-DOM regression test (the `firing` ref is verified-correct by inspection; the repo has no jsdom/testing-library harness — a known, prior-accepted residual risk, not a new defect); query results (grid/confirm) are discarded on Tab switch (the AC only promises the *draft* survives — results loss is the workspace's house behavior of unmounting inactive Tabs, spec-compliant); Esc-dismiss works only while the cancel button holds focus (spec-mandated inline-confirm idiom mirroring `DataGrid`, already adjudicated last pass); an in-flight query resolving into an unmounted Tab sets state on a dead component (React 18 no longer warns; same async pattern as the table Tab); `queryDrafts` lifted to `App` re-renders the workspace per keystroke (the App-level lift is the spec's mandated design; cost negligible for this tree); the confirm banner shows `preview.sql` but re-sends the original `pendingSql` (the spec explicitly requires BOTH — show `preview.sql`, re-issue the identical request; identical for `raw`); the pager's "of N" reflects the capped rows (clarified by the truncation banner); the static-markup tests assert on `disabled=""` (the standard technique for a serialized boolean attr under the repo's DOM-free convention); Ctrl+Enter is a no-op while a confirm is pending (intentional — must not abandon the pending destructive confirm); `autoFocus` on cancel moves focus off the textarea (the spec-required idiom; focus belongs on the decision); `pendingSql`/`confirmRun` safe by render invariant (button renders only under `confirm !== null` — adding a redundant guard is noise); prev/next paginate the still-displayed result while a run is in flight (harmless — the shown rows are valid and page resets to 1 on completion); the no-op `onDraftChange` default freezes the textarea only under hypothetical un-wired reuse (wired at the sole call site).

## Design Notes

- **Why zero Core changes.** The `execute` RPC raw path (`{shape:"raw", sql, confirmed?}` → `rows` | `ok` | `confirmation_required`) already does everything this story needs: it splits/rejects multi-statement, default-denies every non-`SELECT` verb, caps reads at `MAX_RESULT_ROWS=1000` with a `truncated` flag, and gates destructive statements behind a stateless `confirmed:true` re-submit. The query Tab is a thin, faithful consumer — building it UI-only keeps the "single guarded executor" invariant (AR-3) provably intact.
- **Client-side pagination is the right scope.** There is no server-side pagination for arbitrary SQL (`planTableRows` needs a schema-resolved table + orderable PK, unusable for opaque text). The raw path already caps at 1000 rows and never ships a whole live result set, so paginating those returned rows client-side with the pure `data-grid-state.ts` helpers (`total = rows.length`, slice per page) satisfies "paginated result grid" without any Core work. The `truncated` flag drives an honest "first 1000 rows" banner.
- **Confirm reuses the inline render-swap idiom, not a modal.** There is no modal framework; mirror `DataGrid`'s delete confirm (`autoFocus` on the "no" button + `onKeyDown` Escape → cancel). On confirm, re-issue the identical raw request with `confirmed:true` — the Core re-classifies and executes; the UI never decides risk.
- **Draft SQL lifted to App, session-only.** Tab bodies unmount when inactive, so keeping SQL purely local would lose typed queries on tab switch. Lifting the text (only) to an App-level `Map<tabId,string>` makes drafts survive tab switches while honoring the snapshot invariant that query text is never persisted to disk. Result/pagination/confirm state stays local to `QueryTabView`.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors across the new `QueryTabView`, the `TabContent` dispatch branch, and the `App`/`Workspace` draft threading.
- `bun test` -- expected: all suites pass, including the new `QueryTabView.test.tsx` covering every I/O Matrix scenario.

**Manual checks (if no live DB):**
- Confirm running a `SELECT` renders the read-only `DataGrid` with working prev/next and a "rows X–Y of N" summary; a destructive statement shows the inline confirm and only executes after confirming; a multi-statement input surfaces an inline error and never executes.

## Auto Run Result

Status: done

**Implemented change:** Gave the pre-existing (placeholder-only) `query` Tab kind a real ad-hoc SQL runner. A new `QueryTabView` renders a monospace editor and runs the typed text verbatim through the EXISTING Story 3.1 guarded `execute` RPC raw path (`{shape:"raw", sql}`) — the UI never parses, splits, classifies, or composes SQL, so the Core remains the sole risk gate (AR-3) and no `src/core/**` file was touched. A `SELECT` returns `FrozenData` rendered in the existing read-only `DataGrid` with client-side pagination over the Core-capped rows (via the pure `data-grid-state.ts` helpers) and a truncation banner; a destructive/mutating statement returns `confirmation_required` and executes only after an inline confirm re-issues the identical request with `confirmed:true`; multi-statement/smuggling input is rejected by the Core as a `bad_request` surfaced inline. Draft SQL is lifted to a session-only `App` map keyed by Tab id so it survives Tab switches but never touches disk or the workspace snapshot.

**Files changed:**
- `src/ui/workspace/QueryTabView.tsx` (new) — the SQL editor + runner: verbatim raw `execute`, read-only paginated `DataGrid`, inline confirm re-issuing with `confirmed:true`, truncation banner, "N rows affected", inline `envelopeText` errors; hardened with a `firing` re-entrancy guard, `try/catch/finally`, an exhaustive result switch, and stale-banner clearing.
- `src/ui/workspace/QueryTabView.test.tsx` (new) — DOM-free `bun:test` coverage of every I/O Matrix scenario via the exported `runRawQuery`, plus `renderToStaticMarkup` structure checks (matching the repo's testing convention).
- `src/ui/workspace/TabContent.tsx` — dispatch branch rendering `QueryTabView key={tab.id}` (isolated per-Tab state) with threaded draft props.
- `src/ui/workspace/Workspace.tsx` — threads `queryDrafts`/`onQueryDraftChange`, resolving the active Tab's draft.
- `src/ui/App.tsx` — session-only `queryDrafts` state + setter (excluded from the snapshot) and draft pruning on Tab close.

**Follow-up review pass (2026-07-11):** An independent Blind Hunter + Edge Case Hunter pass (opus) over the same baseline diff. 3 low-severity patches applied — the truncation banner reworded from "showing the first N rows" (contradicted the ~100-row viewport) to "only the first N rows were returned", an `aria-label="sql query editor"` added to the previously placeholder-only editor textarea, and the mutation result pluralized ("1 row affected" vs "N rows affected"). 0 intent_gap, 0 bad_spec, 0 deferred, 13 rejected (chiefly: results-lost-on-Tab-switch is spec-compliant house behavior — the AC only promises the draft survives; Esc-focus scope and `autoFocus`-on-cancel are the spec-mandated inline-confirm idiom; the re-entrancy guard is verified-correct by inspection with the DOM-test gap a prior-accepted residual risk; `preview.sql`-shown-vs-`pendingSql`-sent is exactly what the spec requires and identical for `raw`). No spec loopback. `bunx tsc --noEmit` → 0 errors; `bun test` → 579 pass, 0 fail. `followup_review_recommended: false` — only three localized, low-consequence cosmetic/a11y fixes, no behavior/data/API change.

**Review findings:** 2 review passes (Blind Hunter + Edge Case Hunter, opus). 10 patches applied (high 2, medium 3, low 5) — chiefly the missing `key={tab.id}` (cross-Tab state contamination that could confirm-execute the wrong Tab's destructive SQL) and a `firing` re-entrancy guard (a double-click could execute a confirmed destructive statement twice); plus stale-banner clearing, blocking Run through an open confirm, an accurate (non-hardcoded) truncation banner, `try/catch/finally` busy-latch protection, an exhaustive switch, cancel-disabled-mid-flight, and draft-map pruning. 0 intent_gap, 0 bad_spec, 0 deferred, 4 rejected (Esc-focus scope, dark-only banner palette, trim-vs-verbatim, unconsumed row selection — all matching established house conventions). No spec loopback. `followup_review_recommended: true` — two high-severity safety fixes plus a broad component-state-management hardening pass warrant an independent look.

**Verification:** `bunx tsc --noEmit` → 0 errors. `bun test` → 579 pass, 0 fail (1383 expect() calls across 31 files; +14 new tests). No `src/core/**` change (verified via `git status`). The two protected invariants held under review: Core/executor untouched and no query text persisted to disk.

**Residual risks:** The two acceptance-critical outcomes (raw-path contract usage; no-persist invariant) are unit-covered and type-checked, but the component-level state fixes (per-Tab isolation via keying, banner clearing, re-entrancy guard) are not exercised by an interactive DOM test — the repo has no jsdom/testing-library harness, so these rest on `tsc` + manual reasoning. DDL run from a query Tab does not refresh the connect-time memoized schema tree until reconnect (documented, pre-existing behavior shared with Stories 3.4/3.5), and the truncation "of N" pager reflects only the returned capped rows (clarified by the truncation banner).
