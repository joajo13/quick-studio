---
title: 'Story 4.2: Persist and restore ERD layout'
type: 'feature'
created: '2026-07-11'
status: 'done'
baseline_revision: '16539219e9ad87cd3a4117e4952c4ae521306310'
final_revision: '9bb8911f42e6ad4834d759ad65ea984032e9b239'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** The ERD (Story 4.1) is view-only: node positions come purely from dagre on every `tables` change, dragging is disabled (`nodesDraggable={false}`), and nothing about the layout is written to disk. A developer who mentally arranges a schema loses it on the next launch, and even creating a table reshuffles every node.

**Approach:** Enable node dragging in the ERD, capture the rearranged node positions (and viewport) per ERD tab, and persist them **additively** through the existing `WorkspaceSnapshot` / `workspace.save` substrate (Story 2.5) — restored on relaunch in Persistent mode, and never written in Ephemeral mode because the Core already no-ops the whole snapshot save there. A pure position-merge overlays saved positions on the dagre graph so restored nodes stay put and only new tables get auto-placed.

## Boundaries & Constraints

**Always:**
- Reuse the existing persistence substrate: ERD layout rides inside `WorkspaceSnapshot` and is saved/loaded via the existing `workspace.save` / `workspace.load` RPCs and the existing `workspace-state.json` file. No new RPC, no new on-disk file.
- Add the ERD-layout field **additively** and keep `WORKSPACE_SNAPSHOT_VERSION` at `1` — an existing v1 snapshot with no ERD-layout data must still load cleanly and fall back to dagre. Do not bump the version (a bump discards existing persisted workspaces).
- Ephemeral mode must write nothing about the ERD. Rely on the Core's existing mode gating (ephemeral store no-ops `save`/`load`); the UI stays mode-oblivious and does not add a mode branch.
- Layout is keyed by tab id plus `tableId(schema, name)` (the existing NUL-separated node id) so positions survive restart and re-introspection and map to the right node.
- Graph derivation stays pure and DOM-free: the saved-position overlay is a pure function in `src/ui/erd/erd-graph.ts`, unit-tested with `bun test`. The React Flow canvas stays a thin wrapper.
- A table created via the Epic-3 builder must still appear in the ERD without a manual refresh, and must NOT disturb the positions of already-placed nodes (it gets a fresh dagre position; existing saved nodes keep theirs).
- The persisted layout carries geometry only (node positions + viewport). Never any credentials, connection URLs, row data, or query text (three-ring trust model — the snapshot must stay credential-free).

**Block If:**
- ERD layout cannot be persisted through the existing `WorkspaceSnapshot` substrate without either a breaking snapshot-version bump that discards existing persisted workspaces or a new Core RPC / on-disk file — HALT with status `blocked`.

**Never:**
- Add a new Core RPC method, a new persisted file, or a UI-side Ephemeral/Persistent branch — reuse `workspace.save`/`workspace.load` and let the Core gate mode.
- Persist secrets, connection strings, rows, or query text as part of the layout.
- Mutate the schema through the diagram — still view-only (editing is v2).
- Re-run dagre over nodes that already have a saved position on a `tables` change — saved positions win; only un-positioned (new) nodes are auto-placed.
- Key layout by anything unstable (array index, title) — use tab id + `tableId`.

## I/O & Edge-Case Matrix

Applies to the pure position-overlay function in `erd-graph.ts` (input = dagre `ErdGraph` + a `savedPositions` map keyed by node id).

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full saved layout | positions for every node id | each node uses its saved `{x,y}`; dagre positions overridden | No error expected |
| Partial saved (new table) | positions missing for some node ids | saved nodes keep saved position; nodes with no saved position keep their dagre position | No error expected |
| Stale saved (dropped table) | positions include node ids absent from the graph | extra positions are ignored; no phantom node created | No error expected |
| No saved layout | empty / undefined positions map | all nodes use dagre positions (Story 4.1 behavior) | No error expected |
| Empty graph | zero nodes | empty graph returned; nothing applied | No error expected |
| Malformed coordinate | a saved position with a non-finite x or y | that entry is ignored; node falls back to dagre position | Skip entry, no throw |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- `WorkspaceSnapshot` (v1) and `WORKSPACE_SNAPSHOT_VERSION`; add an `ErdTabLayout` type + additive optional `erdLayouts` field here.
- `src/core/workspace-store.ts` -- `isWorkspaceSnapshot` shape guard + atomic write; extend the guard to tolerate/validate optional `erdLayouts`.
- `src/core/workspace-registry.ts` -- `validateSnapshotParams` semantic validation on save; extend for `erdLayouts` (finite coords).
- `src/ui/workspace/workspace-state.ts` -- `toWorkspaceSnapshot(state, panelSizes)` / `restoreWorkspace(snapshot)` bridge; thread `erdLayouts` through both.
- `src/ui/App.tsx` -- owns the workspace reducer, `panelSizes`, mount-load + debounced-save `useEffect`s; add `erdLayouts` state, seed on load, include in save, prune closed tabs.
- `src/ui/erd/erd-graph.ts` -- pure `schemaToGraph`; add the pure saved-position overlay (`ErdNode.id`, `position` are top-left corners).
- `src/ui/erd/erd-graph.test.ts` -- pure `bun test` cases; add overlay-scenario coverage.
- `src/ui/workspace/ErdTabView.tsx` -- React Flow canvas; enable dragging, capture positions/viewport, apply saved layout, restore viewport, report changes up.
- `src/ui/workspace/ErdTabView.test.tsx` -- `renderToStaticMarkup` structural tests.
- `src/ui/workspace/TabContent.tsx` / `src/ui/workspace/Workspace.tsx` -- thread `erdLayouts` + `onErdLayoutChange` down to each ERD tab keyed by `tab.id`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `ErdTabLayout` (`positions: Record<string,{x:number;y:number}>`, optional `viewport?: {x:number;y:number;zoom:number}`) and an additive optional `erdLayouts?: Record<string, ErdTabLayout>` (keyed by stringified tab id) on `WorkspaceSnapshot`, keeping `WORKSPACE_SNAPSHOT_VERSION` at 1 -- additive persistence contract.
- [x] `src/core/workspace-store.ts` -- extend `isWorkspaceSnapshot` so a snapshot with no `erdLayouts` still validates (old v1 files) and a present `erdLayouts` is shape-checked (object of layouts with numeric coords) -- backward-compatible read.
- [x] `src/core/workspace-registry.ts` -- extend `validateSnapshotParams` to accept `erdLayouts`, rejecting entries with non-finite coordinates -- reject malformed layout on save.
- [x] `src/core/workspace-store.test.ts` (and/or `workspace-registry.test.ts`) -- round-trip a snapshot with `erdLayouts`; assert an old snapshot lacking the field still loads -- persistence regression coverage.
- [x] `src/ui/erd/erd-graph.ts` -- add a pure `applyLayout(graph, savedPositions)` (or optional-positions param on `schemaToGraph`) overlaying saved positions onto dagre nodes per the I/O matrix -- pure, testable restore + new-node handling (resolves the reshuffle-on-create deferred item).
- [x] `src/ui/erd/erd-graph.test.ts` -- unit tests for all six overlay scenarios in the I/O matrix via `bun test` -- edge-case coverage.
- [x] `src/ui/workspace/ErdTabView.tsx` -- accept `savedLayout?` + `onLayoutChange` props; switch to `useNodesState` + `onNodesChange`; set `nodesDraggable={true}`; overlay saved positions; capture positions on drag stop and viewport on move end; restore the saved viewport via `defaultViewport` and disable `fitView` when a saved layout exists; reconcile drag state with `tables` changes so existing dragged nodes stay put -- interactive drag + capture surface.
- [x] `src/ui/workspace/ErdTabView.test.tsx` -- `renderToStaticMarkup` tests: empty-state still renders; a schema with a supplied saved layout renders its table names -- structural coverage.
- [x] `src/ui/workspace/workspace-state.ts` -- thread `erdLayouts` through `toWorkspaceSnapshot` and `restoreWorkspace` (defensive: drop layouts for tab ids not present in the restored tab set) -- serialization bridge.
- [x] `src/ui/App.tsx` -- hold `erdLayouts` state (tabId -> layout); seed it from the loaded snapshot; update it from each ERD tab's `onLayoutChange`; include it in the debounced `toWorkspaceSnapshot` save; prune layouts when their tab closes -- lift + persist path.
- [x] `src/ui/workspace/TabContent.tsx` / `src/ui/workspace/Workspace.tsx` -- pass each ERD tab its `savedLayout` (from `erdLayouts[tab.id]`) and an `onLayoutChange` callback, keyed by `tab.id` -- wiring.

**Acceptance Criteria:**
- Given Persistent mode and an ERD tab whose nodes I dragged to new positions, when I restart the app, then the ERD tab reopens with those nodes exactly where I left them rather than re-run through dagre.
- Given Persistent mode and an ERD I panned/zoomed, when I restart, then the diagram restores that pan/zoom instead of auto-fitting to the default view.
- Given Ephemeral mode, when I rearrange the ERD and restart, then nothing about the ERD layout was written to disk and the ERD renders with the default dagre layout.
- Given a saved ERD layout, when I create a table via the create-table builder, then the new table appears as a node without moving any already-placed node.
- Given a persisted workspace file written before this story (no ERD-layout data), when I launch, then it loads without error and the ERD falls back to the dagre layout.
- Given the ERD tab, when I drag a node and release it, then the node stays where I dropped it and no React Flow error is thrown.

## Design Notes

- **Reuse, don't invent.** Persistence already exists end-to-end (Story 2.5): `App.tsx` mount-loads via `rpc("workspace.load")` and debounce-saves via `rpc("workspace.save")` behind a "save only after a successful load" guard; the Core resolves the app dir, writes `workspace-state.json` atomically, and no-ops both in Ephemeral. Story 4.2 only extends the `WorkspaceSnapshot` payload and the App state it carries — it adds no new persistence machinery and no mode logic.
- **Additive, version-stable.** Add `erdLayouts?` as an optional field and keep `WORKSPACE_SNAPSHOT_VERSION = 1`. The shape guard treats it as optional (absent -> undefined -> dagre fallback), so pre-4.2 files keep working and a bump that would discard users' saved workspaces is avoided.
- **Purity boundary.** The dagre-vs-saved decision is a pure overlay in `erd-graph.ts` (`applyLayout`), unit-tested without a DOM. `ErdTabView` becomes stateful only for the React Flow node/viewport wiring (`useNodesState` + `onNodesChange`, `onMoveEnd`, `defaultViewport`); the pure module is where correctness (new-node placement, stale/malformed positions) is verified.
- **Enabling drag safely.** Story 4.1 set `nodesDraggable={false}` precisely because `nodes` was controlled with no `onNodesChange` (React Flow error #015). This story adds `onNodesChange` (via `useNodesState`), which is exactly what makes `nodesDraggable={true}` safe.
- **Key by tab id + node id.** Tab ids are stable across restore (`restoreWorkspace` preserves them), and node ids are the stable NUL-separated `tableId(schema,name)` — together they map a saved position to the right node in the right tab after relaunch.

## Verification

**Commands:**
- `bun test` -- expected: all pass, including new `erd-graph` overlay cases and the snapshot round-trip / backward-compat cases.
- `bunx tsc --noEmit` -- expected: no type errors (no typecheck npm script; run directly).
- `bun run build` -- expected: UI bundles successfully.

**Manual checks:**
- `bun run dev` in Persistent mode: open an ERD, drag nodes and pan/zoom, restart the app, reopen the ERD — positions and viewport are restored. Create a table via the builder — it appears without moving existing nodes.
- Launch in Ephemeral mode, rearrange the ERD, restart — layout is not restored and no ERD layout was written to `workspace-state.json` (the file is not created/updated in Ephemeral).

## Spec Change Log

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 2, low 2)
- defer: 0
- reject: 6: (high 0, medium 1, low 5)
- addressed_findings:
  - `[medium]` `[patch]` `ErdTabView` (`src/ui/workspace/ErdTabView.tsx`) seeded `positionsRef` only from `savedLayout`, so in a fresh session (no saved layout, no drag/pan yet) creating a table re-ran dagre over the whole set and reshuffled every already-placed node — failing the story's "new table must not disturb placed nodes" intent and the reshuffle-on-create deferred item. Added a mount-only effect seeding `positionsRef` from the initial on-screen (saved-overlaid dagre) layout so placed nodes always stay put.
  - `[medium]` `[patch]` `ErdTabView` `handleMoveEnd` persisted the viewport on every `onMoveEnd`, including React Flow's programmatic mount-time `fitView` (which passes a null event), so opening a tab self-persisted a viewport the developer never chose and permanently disabled `fitView`. Now ignores programmatic moves (`event == null`); only real user pan/zoom persists.
  - `[low]` `[patch]` `applyLayout` (`src/ui/erd/erd-graph.ts`) threw a `TypeError` on a `null`-valued saved position (the `saved === undefined` guard let `null` through to `saved.x`), violating the I/O matrix "malformed → no throw" row. Switched to `saved == null` (+ regression test for null/non-object entries).
  - `[low]` `[patch]` Snapshot validators (`workspace-store.ts` `isErdLayouts`, `workspace-registry.ts` `checkErdLayouts`) accepted a viewport `zoom` of `0`/negative, which restores a degenerate (blank) canvas with `fitView` disabled. Both now reject `zoom <= 0` (+ regression test).
- notes:
  - Rejected (6): new-table can land outside a restored viewport (by design — the AC restores the user's chosen pan/zoom, and the Controls fit button recovers); stale node positions in a still-open tab's layout persist until next interaction (bounded, dropped by `applyLayout` on load); TabContent inline `onLayoutChange` closure churns handler identity (no user consequence); saved viewport + fully non-matching positions strands nodes off-screen (same viewport-honoring tradeoff, Controls recovery); `tables` change mid-drag snaps the dragged node (rare — the create-table builder is a separate panel, no realistic concurrent gesture); Core `validateSnapshotParams` does not prune `erdLayouts` to present tab ids (by design — the UI bridge prunes; the Core validates shape).

### 2026-07-11 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 1, medium 0, low 1)
- defer: 0
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[high]` `[patch]` `ErdTabView` (`src/ui/workspace/ErdTabView.tsx`) reshuffled already-placed nodes on a SECOND consecutive table create. `positionsRef` was seeded only once (mount) and updated only on drag/pan report — never on a `tables` change. So after create #1 the auto-placed new node's dagre position was never captured; create #2 re-ran dagre over the whole set and the overlay (holding a stale `positionsRef`) let the intermediate table move — a direct violation of the "new table must not disturb already-placed nodes" AC (the prior mount-seed patch only covered the first create). Fixed by folding the seed into the `[graph]` reconcile effect so `positionsRef` re-snapshots the on-screen positions on every derived graph (mount + every create/remove); the redundant mount-only effect was removed.
  - `[low]` `[patch]` `ErdTabView.test.tsx` seeded `savedLayout.positions` with space-separated keys (`"public orders"`) that never match the real NUL-separated `tableId` node ids, so the overlay silently no-op'd and the saved-layout tests proved nothing about position matching. Switched the keys to `tableId("public", ...)` so the component overlay path runs against real ids (overlay correctness itself remains exhaustively covered by `erd-graph.test.ts`).
- notes:
  - Rejected (15): mid-drag `tables` change snaps the dragged node (rare — re-introspection concurrent with a live drag); `onNodeDragStop` reads `nodesRef` rather than the event node (last drag `onNodesChange` already committed the final position, so they agree); a new table can land outside a restored viewport with `fitView` frozen off (by design — the AC restores the user's chosen pan/zoom, Controls-fit recovers; reasserted by both hunters but the tradeoff stands); Controls +/- zoom (programmatic, null-event) not persisted while wheel-zoom is (inherent to the mount-`fitView` guard, no clean split); bounded stale-position growth for dropped tables (dropped on next `report`/`applyLayout`); duplicated save/load `erdLayouts` validators (registry normalizes, store guard passes through — different roles, no user-facing round-trip bug); `__proto__` key in a hand-edited snapshot (local trust model, data-only, low consequence); full-schema node names persisted (inherent — positions must key by `tableId`; names are non-secret schema metadata, not credentials); `as unknown as` casts into React Flow (pre-existing 4.1 pattern); ref write during render for `nodesRef` (handler-read mirror, no observed effect); spurious save churn on no-op gestures (guarded by the serialized-equality check, no RPC); Core not pruning `erdLayouts` to present tab ids (UI bridge prunes; Core validates shape; ids are monotonic so orphan-by-kind can't arise); huge-but-finite hand-edited coordinates (finite-by-contract, out of scope); no automated coverage of the interactive capture surface (no jsdom in the project — residual risk, covered by the pure model + manual checks).

### 2026-07-27 — Review pass (deferred-work follow-up, DW-1)
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 1, medium 3, low 3)
- defer: 2: (high 0, medium 1, low 1)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[high]` `[patch]` `ErdTabView` (`src/ui/workspace/ErdTabView.tsx`) **silently discarded the restored layout whenever the ERD tab was the ACTIVE tab at launch** — the exact restart this story exists for (AC #1). The `[graph]` reconcile effect (added by the 2026-07-11 follow-up patch) unconditionally did `positionsRef.current = positionsOf(graph.nodes)`. All hooks run above the `tables.length === 0` early return, and `App` starts `schemaTables` at `[]` while `workspace.load` resolves strictly before introspection answers — so the first mount ran with an EMPTY graph and replaced the seeded saved positions with `{}`. When the tables arrived the `[tables]` memo re-derived with an empty overlay → pure dagre, framed by the restored viewport with `fitView` off (usually mostly off-screen). Worse, the next drag or pan then re-persisted those dagre positions, **destroying the saved arrangement on disk**. Both hunters found it independently. Fixed with a new pure, unit-tested `reconcilePositions(previous, nodes)` in `erd-graph.ts` that returns `previous` VERBATIM for an empty node set and re-seeds otherwise (preserving the second-consecutive-create fix the effect was introduced for). Only reachable with the ERD tab ACTIVE at boot, which is why the story's manual check ("restart, *reopen* the ERD") passed and `bun test` stayed green through three later epics — no test in the repo could execute the effect.
  - `[medium]` `[patch]` The ERD's only zoom/fit affordance never persisted. Story 7.4 replaced React Flow's `<Controls>` with `ErdToolbar`, whose buttons call `useReactFlow().zoomIn/zoomOut/fitView` — programmatic, so the resulting `onMoveEnd` carries a null event and was dropped wholesale by the mount-`fitView` guard. The 2026-07-11 pass rejected this as having "no clean split"; the split is the toolbar announcing its own command. `ErdToolbar` now takes an `onViewportCommand` callback and `handleMoveEnd` accepts an event-less move only when that flag is set (consuming it), so the mount-time `fitView` is still ignored while a deliberate zoom/fit persists like a wheel zoom.
  - `[medium]` `[patch]` Same seam, worse consequence: `report()` unconditionally attached `viewportRef.current`, which the null-event guard never advanced. So after a toolbar zoom, an unrelated **node drag re-persisted the pre-zoom viewport** — the user's zoom was not merely un-saved, it was actively overwritten with a stale value and reverted on relaunch. Resolved by the same fix (the toolbar's move now advances `viewportRef`).
  - `[medium]` `[patch]` One malformed ERD coordinate on disk discarded the **entire workspace**. `isWorkspaceSnapshot` (`src/core/workspace-store.ts`) is all-or-nothing, and `erdLayouts` was the one additive optional field gated by it — while the same file's comments argue the opposite policy for `connectionId` and `lastProvider`, naming this exact blast radius ("would nuke every tab, panel size and ERD layout"). `App` reads the resulting `null` as an ordinary first launch, enables saving, and the first tab open **overwrites the good file with an empty workspace**. Made `erdLayouts` a field-drop field like its two siblings: the Core gate is gone, and `restoreErdLayouts` now sanitizes per entry (keep finite positions, drop malformed ones; keep the viewport only when finite with positive zoom; drop an unusable entry; degrade a non-object `erdLayouts` to `{}`). Sanitizing — not merely tolerating — is required, since the restored map is fed straight back into `toWorkspaceSnapshot` and the Core's save validator rejects malformed geometry. This is also what the story's own I/O matrix asks for ("skip entry, no throw"); `applyLayout` implemented it correctly but the harsher layer fired first. The SAVE boundary stays strict.
  - `[low]` `[patch]` No finiteness guard on the capture side: `positionsOf` copied `n.position.x/y` verbatim into the layout report, and one non-finite coordinate reaching `workspace.save` is a `bad_request` for the whole snapshot — i.e. **every save fails for the rest of the session**, the failure mode `normalizeConnectionId` guards against on the tab side. `positionsOf` (now pure and exported from `erd-graph.ts`) skips non-finite entries, and a new `sanitizeViewport` drops a degenerate transform (non-finite offsets, `zoom <= 0`) at the same seam.
  - `[low]` `[patch]` `defaultViewport` read the FROZEN mount-time layout, but `<ReactFlow>` sits below the zero-tables early return and therefore remounts whenever the table set empties and returns (a re-introspection after DDL, a retry after a transient connect error) — reverting this session's pan/zoom. Now reads `viewportRef.current`, which is seeded from the saved layout and advanced by every captured move.
  - `[low]` `[patch]` `ErdTabView.test.tsx`'s saved-layout tests assert only that table names render, which is true whether or not a single position is applied — and `renderToStaticMarkup` runs no effects, so the capture/reconcile surface was structurally invisible (this is why the `[high]` regression shipped green). Added an explicit scope note so a green run is not misread as coverage, and moved the real coverage where it can exist: the pure `positionsOf` / `reconcilePositions` / `sanitizeViewport` helpers are now directly unit-tested (19 new cases).
- notes:
  - Deferred (2): ERD geometry carries no database identity, so relaunching against a different `--db-url` applies the previous database's positions to same-named tables (**DW-95**, medium — the fix widens the persisted contract and the right keying policy for boot-target-only tabs is a real decision); the ERD cannot be rearranged without a pointer, since `elementsSelectable={false}` disables arrow-key node movement and that path would not fire `onNodeDragStop` anyway (**DW-96**, low — a genuine accessibility gap, but the fix changes 4.1's view-only interaction contract and needs a second capture seam).
  - Rejected (6): `report()` persists a position for every node rather than only moved ones, so the snapshot enumerates the table inventory (already adjudicated — geometry must key by `tableId`; schema names are non-secret metadata, not credentials, and "saved positions win" is the specified behaviour); a newly created table can land off-screen under a restored viewport (adjudicated twice before, and the toolbar-fit recovery now actually persists); `applyLayout`'s `savedPositions === undefined` fast path is unreachable in production (dead-path nit, no failure); `pruneErdLayouts` prunes by tab id and not tab kind, so a layout keyed to a non-ERD tab would linger (both hunters raised it, but it is unreachable without a hand-edited file and has zero user-visible consequence); load and save validators differ on unknown extra properties, so a hand-added field is dropped on first save (hypothetical, no user-facing round-trip bug); stale positions for dropped tables linger in App state until the next gesture in that tab (bounded, self-healing, and discarded by `applyLayout` on read).

## Auto Run Result

Status: done

### Summary
Implemented Story 4.2: the ERD is now rearrangeable and its layout persists. Node dragging is enabled (`useNodesState` + `onNodesChange`, `nodesDraggable`); dragged node positions and the pan/zoom viewport are captured per ERD tab and persisted **additively** inside the existing `WorkspaceSnapshot` (`erdLayouts`, keyed by stringified tab id) via the Story-2.5 `workspace.save`/`workspace.load` substrate — no new RPC, no new on-disk file, `WORKSPACE_SNAPSHOT_VERSION` unchanged at `1`. A pure `applyLayout` overlay applies saved positions over the dagre graph so restored nodes stay put and only new tables get auto-placed. Ephemeral mode writes nothing (the Core already no-ops the whole snapshot save); the UI stays mode-oblivious. Persisted data is geometry only (positions + viewport) — no credentials/URLs/rows/SQL.

### Files changed
- `src/shared/contract.ts` — added `ErdTabLayout` + additive optional `erdLayouts?` on `WorkspaceSnapshot`; version kept at 1.
- `src/core/workspace-store.ts` — `isWorkspaceSnapshot` tolerates absent `erdLayouts` and shape-checks a present one (finite coords; positive `zoom`).
- `src/core/workspace-registry.ts` — `validateSnapshotParams` accepts/validates `erdLayouts`, rejecting non-finite coords and non-positive `zoom`.
- `src/ui/erd/erd-graph.ts` — pure `applyLayout(graph, savedPositions)` overlay implementing the full I/O matrix (null/non-object/non-finite entries skipped, no throw).
- `src/ui/workspace/ErdTabView.tsx` — drag + viewport capture, saved-layout overlay, viewport restore via `defaultViewport` with `fitView` gated on a saved viewport, mount-seed of `positionsRef` (no-reshuffle), programmatic-move guard.
- `src/ui/workspace/workspace-state.ts` — threads `erdLayouts` through `toWorkspaceSnapshot` (+ `restoreErdLayouts`), pruned to present tabs.
- `src/ui/App.tsx` — holds/seeds/persists/prunes `erdLayouts`; wires it into the debounced save.
- `src/ui/workspace/TabContent.tsx`, `src/ui/workspace/Workspace.tsx` — thread `savedLayout` + `onErdLayoutChange` per `tab.id`.
- Tests: `src/ui/erd/erd-graph.test.ts`, `src/core/workspace-store.test.ts`, `src/core/workspace-registry.test.ts`, `src/ui/workspace/ErdTabView.test.tsx`, `src/ui/workspace/workspace-state.test.ts`.

### Review findings breakdown
- **Patches applied (4):** fresh-session reshuffle-on-create (seed `positionsRef` at mount, medium); spurious viewport persist on mount `fitView` (ignore programmatic `onMoveEnd`, medium); `applyLayout` `TypeError` on a null saved position (low); viewport `zoom <= 0` accepted by validators (low). Regression tests added for the two pure/validator fixes.
- **Deferred (0):** no new pre-existing issues surfaced beyond what is already logged for Epic 4.
- **Rejected (6):** viewport-honoring can leave a new table off-screen (by design; Controls fit recovers); bounded stale-position growth; TabContent closure churn (cosmetic); non-matching-positions + saved viewport off-screen (viewport-honoring tradeoff); mid-drag `tables` change snap (rare concurrency); Core not pruning by tab id (UI bridge prunes, Core validates).

### Verification performed
- `bun test` → 623 pass / 0 fail (33 files) — +2 regression tests over the post-implementation 621.
- `bunx tsc --noEmit` → exit 0.
- `bun run build` → exit 0 (UI bundles).

### Residual risks
- The interactive capture paths (drag stop, `onMoveEnd`, mount `fitView`) run only in a real browser — there is no jsdom, so the two React-level patches (mount position-seed, programmatic-move guard) are covered by the pure model + manual checks, not automated UI tests. The programmatic-move guard relies on React Flow v12 passing a null event for non-user viewport changes.
- Follow-up review recommended: true — the two medium patches changed behavioral logic in the layout-capture surface (the story's core) and are not unit-testable here.

### Follow-up review pass (2026-07-11)
Independent adversarial + edge-case review of the full diff. Two patches applied, no spec/intent changes, no deferrals.
- **`[high]` reshuffle-on-consecutive-create (AC violation):** the prior pass's mount-only `positionsRef` seed covered only the FIRST table create; a second consecutive create (no intervening drag/pan) re-ran dagre over the whole set and moved the intermediate table. Fixed by re-seeding `positionsRef` from the on-screen positions inside the `[graph]` reconcile effect (mount + every `tables` change), replacing the redundant mount-only effect. This closes the "new table must not disturb already-placed nodes" AC on repeated creates.
- **`[low]` test-fidelity:** `ErdTabView.test.tsx` saved-layout tests used space-separated position keys that never match the real NUL-separated `tableId` node ids (silent overlay no-op); switched to `tableId(...)` keys so the component overlay path runs against real ids.
- **Rejected (15):** by-design viewport-honoring tradeoffs (new node off-screen, Controls-zoom not persisted), bounded stale-position growth, validator duplication, `__proto__` hardening (local trust model), full-schema name persistence (inherent to `tableId` keying), `as unknown as` casts (pre-existing), mid-drag reset (rare), and the untested interactive surface (no jsdom — residual risk above). See the follow-up Review Triage Log entry for the full list.
- **Verification (post-patch):** `bun test` → 623 pass / 0 fail (33 files); `bunx tsc --noEmit` → exit 0; `bun run build` → exit 0.
- **Follow-up recommended:** true — the high-severity fix altered behavioral logic in the story's core layout-capture surface, which has no automated coverage here (browser-only).

### Follow-up review pass (2026-07-27, deferred-work DW-1)
The single focused follow-up the 2026-07-21 user decision sanctioned for the post-epic sweep, closing the budget-exhaustion recommendation preserved as DW-1. Reviewed against the **current** working tree (`epic-11`), not just the historical diff — the ERD has since passed through 7.4 (neutral redesign + toolbar), 9.5 (hover panel) and Epic 10 (multi-connection). It found a live, AC-violating, data-destroying regression that had shipped green through three epics.

- **`[high]` The restored layout was wiped whenever the ERD tab was ACTIVE at launch.** The `[graph]` reconcile effect — introduced by the 2026-07-11 follow-up patch itself — unconditionally re-seeded `positionsRef` from the derived graph. At boot that graph is EMPTY (`App` starts `schemaTables` at `[]`, and `workspace.load` resolves before introspection answers), so the restored positions were replaced with `{}` and the tables-arrival re-derivation fell back to pure dagre, framed by the restored viewport with `fitView` off. The next drag or pan then wrote those dagre positions back to disk, destroying the saved arrangement. Fixed by a pure, unit-tested `reconcilePositions(previous, nodes)` that never re-seeds from an empty node set — preserving the consecutive-create fix the effect exists for.
- **`[medium]` Toolbar zoom/fit is now persisted, and no longer reverted by an unrelated drag.** Story 7.4 made `ErdToolbar` the ERD's ONLY zoom affordance, and its programmatic (null-event) moves were dropped by the mount-`fitView` guard — while `report()` kept re-persisting the stale `viewportRef` on every drag, actively reverting the user's zoom on relaunch. The toolbar now announces its command so a deliberate zoom/fit is captured while the mount-time fit is still ignored.
- **`[medium]` One bad ERD coordinate no longer discards the whole workspace.** `erdLayouts` was the one additive optional field gated by the all-or-nothing `isWorkspaceSnapshot`, against the store's own documented field-drop rule for `connectionId`/`lastProvider` — and `App` reads the resulting `null` as a first launch, then overwrites the good file with an empty workspace. The Core gate is gone; `restoreErdLayouts` sanitizes per entry instead (which the story's I/O matrix already asked for). The save boundary stays strict.
- **`[low]` ×3:** capture-side finiteness guards (`positionsOf` skips non-finite coords, new `sanitizeViewport` drops a degenerate transform) so a bad number can never poison every save for the session; `defaultViewport` reads the live `viewportRef` so a `<ReactFlow>` remount (tables emptying and returning) no longer reverts this session's pan/zoom; an explicit scope note on `ErdTabView.test.tsx`, whose smoke tests were being misread as layout coverage.
- **Deferred (2):** DW-95 (ERD geometry has no database identity — a different `--db-url` reuses the previous database's positions for same-named tables; needs a contract decision); DW-96 (the ERD is pointer-only — arrow-key node movement is disabled and would not persist anyway; needs an accessibility pass).
- **Rejected (6):** all-nodes-persisted / table-inventory in the snapshot, new table off-screen under a restored viewport, `applyLayout`'s unreachable `undefined` fast path, prune-by-id-not-kind, load/save disagreement on unknown extra properties, and stale positions lingering until the next gesture. See the triage-log entry for the reasoning.
- **Verification (post-patch):** `bun test` → 1868 pass / 1 skip / 0 fail (86 files); `bunx tsc --noEmit` → exit 0; `bun run build` → exit 0 (all five bundles). 19 new pure unit cases cover the capture/reconcile/sanitize surface that previously had none.
- **Residual risk:** the React-level seams themselves (the effect firing on an empty mount, React Flow's null-event `onMoveEnd`, the toolbar-command flag) still run only in a real browser — there is no jsdom in this repo. The regression logic is now pure and tested, but the WIRING of those helpers into `ErdTabView` remains browser-only, and the toolbar fix relies on React Flow v12 emitting `onMoveEnd` for `zoomIn`/`zoomOut`/`fitView` (verified by reading `@xyflow/system`'s `setTransform` → d3-zoom path, not by running it). The `[high]` fix should be confirmed manually: launch in Persistent mode with an arranged ERD as the ACTIVE tab and check the nodes come back where they were left.
- **Follow-up recommended:** false — the fixes are behaviour-restoring rather than behaviour-adding, the two riskiest ones are now expressed as pure functions with direct coverage, and the remaining items are recorded as DW-95/DW-96 rather than left implicit.
