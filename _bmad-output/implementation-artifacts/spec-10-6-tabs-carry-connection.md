---
title: 'Tabs carry their connectionId — persist it in the WorkspaceSnapshot and survive the connection being removed'
type: 'feature'
created: '2026-07-21'
status: 'draft'
depends_on:
  - '10-4-core-resolve-by-connection-id'
  - '10-5-multi-root-schema-tree'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 10 / Story 10.6
  - '{project-root}/_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html'
  - '{project-root}/src/ui/workspace/workspace-state.ts'
---

<intent-contract>

## Intent

**Problem:** The workspace is becoming multi-connection (10.4 makes every read path resolve by `connectionId`; 10.5 turns the schema sidebar into a multi-root tree, one root per saved connection). But `TableRef` (`src/ui/workspace/workspace-state.ts:49`) is still `{ schema, name }` only — it has no idea WHICH connection a bound table came from. And even if it did, that fact evaporates on restart: `toWorkspaceSnapshot` deliberately drops `table` from every persisted tab (Story 3.2's Block-If — "the open-table binding does not survive an app restart"), and `WorkspaceSnapshotTab` (`src/shared/contract.ts:736`) carries only `{ id, kind, title }`. So today a restored table tab is always unbound, and there is no way — even in principle — to know which of N connections it was ever pointed at. Once the tree is multi-root, "reopen the same tab against the same database" requires that fact to survive a relaunch, AND the referenced connection may no longer exist by then (it was removed in the meantime) — which today would have no representation at all, let alone a non-crashing one.

**Approach:** Give `connectionId` two homes: (1) `TableRef` gains `connectionId: string | null` (`null` = the boot/default target, mirroring the existing `null`-means-default convention already used by `ExecuteRequest.connectionId` in `contract.ts`) — this is the LIVE binding, threaded from the multi-root tree's activation callback (10.5) through `bindTableToActiveTab` into `table.rows`/`execute` RPC calls (10.4). (2) `WorkspaceTab` (the reducer's in-memory tab, `workspace-state.ts:55`) gains its OWN top-level `connectionId?: string | null` — decoupled from `table`, because `table` itself still does not survive restore (that Story-3.2 decision is NOT reversed by this story: schema+name binding stays session-only). This top-level field is the one thing that DOES persist: `WorkspaceSnapshotTab` gains an additive, optional `connectionId?: string | null` (no `WORKSPACE_SNAPSHOT_VERSION` bump — same additive posture as `erdLayouts`/`lastProvider`), `toWorkspaceSnapshot` writes it whenever a table tab has ever been bound, and `restoreWorkspace` carries it onto the restored tab (still unbound — `table` stays `undefined`, exactly like today) so the tab "remembers" its connection even though it forgot its table. A render-layer check (App/Workspace — NOT the pure `workspace-state.ts`, which cannot itself call `connections.list`) then compares each tab's `connectionId` against the live saved-connection set and renders a "conexión no disponible" state, with a reassign affordance, for that ONE tab — never a crash, never a dropped tab, never a tanked sibling.

## Boundaries & Constraints

**Always:**
- Add `connectionId: string | null` to `TableRef` (`workspace-state.ts:49`). `null` means the boot/default connection — the SAME convention `ExecuteRequest.connectionId?: string | null` already uses (`contract.ts:876-877`), so there is exactly one "default target" encoding across the codebase, not a second one invented here.
- Add a top-level `connectionId?: string | null` to `WorkspaceTab` (`workspace-state.ts:55`), independent of `table?: TableRef`. Populate it whenever a table tab is bound (`bindTableToActiveTab`, mirroring `ref.connectionId`) so the live and persisted values never disagree while the tab is bound.
- Add `connectionId?: string | null` to `WorkspaceSnapshotTab` (`contract.ts:736`) as an ADDITIVE optional field — `WORKSPACE_SNAPSHOT_VERSION` stays `1`. `toWorkspaceSnapshot` writes it only when present (mirrors the existing `erdLayouts`/`lastProvider` "no gratuitous field" posture — an untouched/no-connection workspace still serializes byte-identically to today).
- `restoreWorkspace` carries a tab's persisted `connectionId` onto the restored `WorkspaceTab` verbatim (defaulting an absent field to `undefined`, never throwing) — it stays PURE and does not itself decide reachability (it has no RPC access; `connections.list` is Core-side).
- An old snapshot with no `connectionId` on a tab restores as `undefined` — treated identically to `null` (the boot/default target) at every read site, so a pre-10.6 workspace file loads with no behavior change and no forced "conexión no disponible" for tabs that simply predate this story.
- The missing-connection check happens at the App/Workspace render layer, AFTER both `workspace.load` and `connections.list` resolve, by comparing each tab's `connectionId` (when non-null/non-undefined) against the live `ConnectionSummary.id` set. A tab whose id is absent renders a "conexión no disponible" state (Spanish copy, per the mockup: `conexión no disponible (fue eliminada)`) with a "Reasignar conexión…" affordance, IN PLACE of the normal table body — it never throws, never removes the tab, and never touches any sibling tab's render.
- Core's save-boundary validators (`checkTabs` in `workspace-registry.ts:85`, `isSnapshotTab` in `workspace-store.ts:140`) accept the new optional field: at SAVE (the trusted, strict boundary) `connectionId` must be `undefined`, `null`, or a non-empty string, else `bad_request` naming the field — mirroring how `id`/`kind`/`title` are already strictly checked there. At LOAD (the total, never-throw boundary) a malformed `connectionId` must NOT nuke the whole snapshot — sanitize/drop just that field, mirroring `lastProvider`'s documented "a single bad hint must never discard every tab" posture (`workspace-store.ts:175-179`), rather than degrading the entire file to `null`.
- The migration must never silently drop a tab: every existing tab in an old snapshot restores exactly as it does today, plus the new (absent) field — `restoreWorkspace`'s id-dedupe/settings-singleton defenses are unchanged.
- Thread `connectionId` through wherever a table tab is opened from the tree (10.5's multi-root activation callback) and wherever a bound table's rows are fetched (`table.rows` in `TabContent.tsx`'s `TableTabView`) — this story's job is to CARRY the id end-to-end once 10.4/10.5 hand it in and out; it does not itself build the multi-root tree or the connectionId-aware RPC surface.

**Block If:**
- If a restored tab's `connectionId` cannot be compared against the live connection set without giving the pure `workspace-state.ts` module an RPC dependency (breaking its stated dependency-free/DOM-free contract) — HALT `blocked`, condition `connection-availability check cannot be kept out of the pure reducer module`. (Expected resolution per this draft: keep the check at the App/Workspace layer, as scoped above — flag if step-02 finds a reason that is not viable.)
- If 10.5's multi-root tree activation callback cannot supply a `connectionId` alongside the activated `SchemaTableInfo` without a breaking signature change agreed upon in 10.5's own spec — HALT `blocked`, condition `10.5 activation callback does not carry connectionId`, and coordinate the exact callback shape with that story rather than guessing it here.

**Never:**
- NEVER crash the workspace restore because one tab's connection is missing — `restoreWorkspace` and the render-layer check are both total; a missing connection is a per-tab UI state, not an exception.
- NEVER tank sibling tabs — a tab with a missing connection renders its own "conexión no disponible" body; every other tab (any kind, any connection, or no connection) renders normally, completely unaffected.
- NEVER silently drop a tab or its title/kind because its connection vanished — the tab stays in the strip, closable and reassignable, exactly like any other tab.
- NEVER let a raw connection url/credential leak into the persisted snapshot or the "conexión no disponible" UI — only the opaque `connectionId` crosses any boundary (AR-12), matching 10.4's hard invariant.
- NEVER bump `WORKSPACE_SNAPSHOT_VERSION` for this additive field.
- NEVER reverse Story 3.2's decision that the live table binding (`schema`/`name`) does not persist — this story persists ONLY `connectionId`, not the rest of `TableRef`. (Open question for step-02, see below.)

**Open question for step-02:** Epic 10's own Story 10.6 AC text says "a table/query tab" carries a `connectionId`, but the authoritative solution point and the only existing per-tab connection-scoped ref type (`TableRef`) cover table tabs only — query tabs have no equivalent bound-ref today. This draft scopes `WorkspaceTab.connectionId`/`WorkspaceSnapshotTab.connectionId` generically (any tab kind CAN carry it), but only wires table tabs to actually populate it. Whether query tabs should also carry/persist a `connectionId` in this story or a follow-up is left for step-02 to confirm against 10.4/10.5's actual query-tab RPC shape.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|----------------|------------------------------|-----------------|
| Open a table tab from a connection root | Activate a table under connection `conn-2` in the multi-root tree (10.5) | `bindTableToActiveTab` sets `table: { connectionId: "conn-2", schema, name }` AND the tab's top-level `connectionId: "conn-2"`; `table.rows` is called with `connectionId: "conn-2"` | No error |
| Open a table tab from the boot/default target | Activate a table with no explicit connection (ephemeral, or the boot manager) | `connectionId: null` on both `table` and the tab; RPCs omit/pass `null`, resolving to the boot manager (10.4) | No error |
| Save + restore against the SAME still-existing connection | `workspace.save` while a table tab is bound to `conn-2`, then relaunch | Snapshot carries `connectionId: "conn-2"` on that tab; on restore the tab reopens with `connectionId: "conn-2"` (table binding itself stays unbound, same as today); no "conexión no disponible" (id found in `connections.list`) | No error |
| Restore a tab whose connection was deleted | Snapshot tab has `connectionId: "conn-2"`; `connections.list` no longer includes `conn-2` | Tab renders a "conexión no disponible (fue eliminada)" state with a "Reasignar conexión…" affordance, in place of the table body; the tab itself, its title, and its position in the strip are all preserved | No crash; no thrown error; workspace restore completes normally |
| Old snapshot, tab has no `connectionId` field | Pre-10.6 snapshot, `tabs[].connectionId` absent | Restores as `undefined`, treated as the boot/default target everywhere (never flagged unavailable) — behavior identical to today | No error, no forced reassign prompt |
| One tab's connection is missing among several open tabs | Tabs bound to `conn-1` (exists), `conn-2` (deleted), and a query tab with no connection | Only the `conn-2` tab shows "conexión no disponible"; the `conn-1` table tab and the query tab render and behave exactly as normal | Isolated — no sibling impact |
| Core save-boundary validation | `workspace.save` with a tab `connectionId` that is a non-empty string, `null`, or absent | Accepted — `checkTabs`/`isSnapshotTab` pass; snapshot persists | — |
| Core save-boundary validation, malformed value | `workspace.save` with a tab `connectionId` that is e.g. a number or empty string | `bad_request` naming the offending field; nothing written | Rejected at the trusted write boundary |
| Load-time malformed value (hand-edited file) | On-disk snapshot has a tab with `connectionId: 42` (wrong type) | Load sanitizes/drops just that field (tab restores with `connectionId: undefined`) rather than degrading the WHOLE snapshot to `null` | Tolerated, isolated to the one field |
| Reassign affordance | User clicks "Reasignar conexión…" on an unavailable tab | The tab's `connectionId` is updated to a newly chosen live connection; the "conexión no disponible" state clears and the tab returns to its normal (still-unbound, per 3.2) table-selection state | No error |

</intent-contract>

## Acceptance Criteria

- **Given** a table/query tab opened from a connection root, **when** it is created and the workspace is persisted, **then** its `TableRef` (for a bound table tab) carries a `connectionId`, the owning `WorkspaceTab` carries the same `connectionId` at its top level, and that id is written into the `WorkspaceSnapshot` as an additive optional field (no `WORKSPACE_SNAPSHOT_VERSION` bump) — so on restore the tab still knows which connection it belongs to, even though (per the unchanged Story 3.2 decision) the specific table binding itself does not persist.
- **Given** a restored tab whose connection no longer exists (it was removed since the snapshot was written), **when** the session is restored, **then** the tab lands in a "conexión no disponible" state with a reassign affordance — the workspace restore completes without crashing and every other tab (any connection, or none) is completely unaffected.

## Code Map

> Light on purpose — the loop's dev planner (step-02) enriches this.

- `src/ui/workspace/workspace-state.ts` — `TableRef` (~line 49) gains `connectionId: string | null`; `WorkspaceTab` (~line 55) gains a top-level `connectionId?: string | null`; `bindTableToActiveTab` (~line 221) sets both from `ref.connectionId`; `toWorkspaceSnapshot` (~line 372) writes `connectionId` per persisted tab when present; `restoreWorkspace` (~line 288) carries the persisted `connectionId` onto each restored tab (pure, no availability check here).
- `src/shared/contract.ts` — `WorkspaceSnapshotTab` (~line 736) gains `readonly connectionId?: string | null`; doc comment updated to describe the additive field and its `null`-means-default convention (mirrors `ExecuteRequest.connectionId`, ~line 876). `WORKSPACE_SNAPSHOT_VERSION` (~line 733) stays `1`.
- `src/core/workspace-registry.ts` — `checkTabs` (~line 85) gains a strict per-tab `connectionId` check (`undefined | null | non-empty string` → else `bad_request`), mirroring the existing `id`/`kind`/`title` checks in the same function.
- `src/core/workspace-store.ts` — `isSnapshotTab` (~line 140) shape-checks a PRESENT `connectionId` tolerantly (never degrades the whole snapshot over one bad value), mirroring the `lastProvider` posture documented at ~line 175-179.
- `src/ui/workspace/Workspace.tsx` / `TabContent.tsx` — the render-layer availability check (compare each active/rendered table tab's `connectionId` against the live `connections.list` id set) and the new "conexión no disponible" body (in place of `TableTabView`/`SelectTablePrompt` for that one tab), with the "Reasignar conexión…" affordance. Exact prop-threading (where the live connection-id set is sourced from — likely already fetched for Settings) left to step-02.
- `src/ui/schema/SchemaTree.tsx` — consumes 10.5's multi-root activation callback; threads the activated table's `connectionId` into `onActivateTable`/`bindTableToActiveTab`. Exact callback signature is 10.5's to finalize (see Block-If above).
- `src/ui/workspace/TabContent.tsx` (`TableTabView`) — `table.rows` RPC call gains `connectionId` from the bound `TableRef`, per 10.4's connectionId-aware read paths.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] Add `connectionId: string | null` to `TableRef`; thread it through `bindTableToActiveTab`.
- [ ] Add a top-level `connectionId?: string | null` to `WorkspaceTab`.
- [ ] Add `connectionId?: string | null` to `WorkspaceSnapshotTab` in `contract.ts` (additive, no version bump).
- [ ] `toWorkspaceSnapshot` writes the tab's `connectionId` when present; `restoreWorkspace` restores it verbatim (pure, no RPC).
- [ ] `checkTabs` (registry) strictly validates `connectionId` at save; `isSnapshotTab` (store) tolerantly shape-checks it at load without nuking the whole snapshot on a bad value.
- [ ] Wire 10.5's multi-root activation callback to hand `connectionId` into `bindTableToActiveTab`; wire `table.rows` to send it (10.4).
- [ ] Render-layer availability check (App/Workspace) + "conexión no disponible" body + "Reasignar conexión…" affordance for a table tab whose `connectionId` is absent from `connections.list`.
- [ ] Confirm an old (pre-10.6) snapshot still loads with no forced "conexión no disponible" and no dropped tabs.
- [ ] `bunx tsc --noEmit`, `bun test`, `bun run build` all green.

## Spec Change Log

<!-- populated by step-02+ as the spec is enriched/revised -->

## Review Triage Log

<!-- populated by the review loop -->
