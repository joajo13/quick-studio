---
title: 'Settings as a singleton tab — retire the overlay, route Settings through the normal tab model (open-or-focus)'
type: 'refactor'
created: '2026-07-16'
status: 'backlog'
context:
  - '{project-root}/src/ui/workspace/Workspace.tsx'
  - '{project-root}/src/ui/workspace/workspace-state.ts'
  - '{project-root}/src/ui/workspace/workspace-state.test.ts'
  - '{project-root}/src/ui/workspace/TabBar.tsx'
  - '{project-root}/src/ui/workspace/TabContent.tsx'
  - '{project-root}/src/ui/settings/SettingsPanel.tsx'
  - '{project-root}/src/ui/App.tsx'
  - '{project-root}/src/shared/contract.ts'
  - '{project-root}/design-artifacts/connect.html'
  - '{project-root}/design-artifacts/workspace.html'
---

<intent-contract>

## Intent

**Problem (complaint item 12):** Settings opens as an OVERLAY. Clicking the rail's `settings-toggle` flips a React-memory-only `settingsOpen` flag in `Workspace.tsx` (`useState(false)`, line 273) that superimposes `<SettingsPanel>` over the whole main panel and HIDES the tab strip + new-tab `+` (the strip is gated on `!settingsOpen && !createOpen`, line 324). To get back to the open tabs you must first CLOSE Settings — there is no way to keep it alongside the workspace, and it is mutually exclusive with the create-table surface (`toggleSettings`/`toggleCreate` each turn the other off). The prototype disagrees: `design-artifacts/connect.html` renders the connections/settings surface as a normal `.tab` inside the Chrome `.tabs` strip (with the shared `.tab-add` `+`), and `workspace.html` keeps Settings as the bottom-pinned rail icon that opens that view. Settings is a VIEW, not a modal.

**Approach:** Make Settings a NORMAL TAB in the tab strip, and a SINGLETON — you can't configure two settings in parallel, so a second click focuses the one that's already open instead of opening a duplicate or re-overlaying. Introduce a `settings` tab kind into the SAME pure tab model the five document kinds already use (`open` / `activate` / `close` / persist), enforce single-instance at one entry point via a new `openOrFocusSettings` reducer helper (focus the existing settings tab, else open exactly one), mount `SettingsPanel` as that tab's body through `TabContent`, and repoint the rail `settings-toggle` (testid preserved) to that open-or-focus action. Delete the settings overlay branch and its `settingsOpen` state entirely. The create-table toggle keeps its overlay behavior verbatim; only Settings leaves the overlay system. `'settings'` joins the single-source-of-truth `WORKSPACE_TAB_KINDS` in `contract.ts`, so Core's two derived `isTabKind` validators and the persisted `WorkspaceSnapshotTab.kind` accept it with ZERO manual Core edits and the tab persists across reload like any other tab (recommended — see Boundaries). `SettingsPanel`'s credential-store / connection / provider behavior is not touched; it is relocated, not rewritten.

## Boundaries & Constraints

**Always:**
- Model the Settings tab through the EXISTING pure tab reducer (`workspace-state.ts`): it opens (open-or-focus), activates, closes, and persists via the same `openTab`/`activateTab`/`closeTab`/`restoreWorkspace`/`toWorkspaceSnapshot` machinery as document tabs — no parallel, out-of-band settings state.
- Add `"settings"` to the shared `WORKSPACE_TAB_KINDS` single source of truth (`contract.ts:677`) so BOTH Core validators — `src/core/workspace-store.ts:94` and `src/core/workspace-registry.ts:81`, whose `isTabKind` guards both derive from `WORKSPACE_TAB_KINDS` — and the persisted `WorkspaceSnapshotTab.kind` accept it with no hand-edit in Core. Keep `WORKSPACE_SNAPSHOT_VERSION` at `1` (additive enum member; a pre-change snapshot of only document kinds still loads).
- Enforce the singleton at the SOLE entry point: a new pure `openOrFocusSettings(state)` helper FOCUSES the existing settings tab if one is open (delegates to `activateTab`), else appends exactly one settings tab (title `"Settings"`, no numeric suffix) and makes it active. The rail toggle and the App action route only through this helper.
- Keep the rail's per-kind launcher loop over the FIVE document kinds only (introduce `LAUNCHER_KINDS`) so Settings never gains a launcher button; the Settings control stays the SEPARATE bottom-pinned toggle, keeping `data-testid="settings-toggle"`, `aria-label="Settings"`, and `title`.
- Route `tab.kind === "settings"` in `TabContent` to `<SettingsPanel>`, mounting it as the tab body in the exact same slot the overlay used (the `overflow-auto` region above the status bar). Preserve `SettingsPanel`'s `data-testid="settings-panel"`, every `role="alert"` line, `aria-label="Close settings"`, and every RPC call / mutation gate / credential-store trust boundary / `envelopeText` surfacing verbatim.
- Persist the Settings tab across reload like any tab (RECOMMENDED — justify): the snapshot bridge maps generically over `{ id, kind, title }`, so once the contract accepts the kind the tab rides `toWorkspaceSnapshot` → `restoreWorkspace` type-safely with ZERO snapshot-bridge special-casing; on relaunch it reopens and re-mounts `SettingsPanel`. This is the least-surprising, most-uniform behavior (open tabs come back) and matches the tab model's own restore contract; it is a deliberate, consistent change from the overlay era's non-persisted flag.
- Preserve the create-table toggle EXACTLY: `data-testid="create-table-toggle"`, its `aria-pressed`, and its overlay-over-the-panel behavior (which hides the tab strip while open) are unchanged — only the settings overlay is removed. `toggleCreate` simply drops its now-defunct `setSettingsOpen(false)`.
- Preserve every tab a11y hook in `TabBar`: `role="tablist"` / `role="tab"` / `aria-selected` / `tabIndex` / Enter-Space activation, and the close-button `aria-label`; keep `ExposureBanner`, the `PanelGroup`/`Panel` resizable layout, and the bottom status bar (connection indicator + Stop).
- Update AND extend `workspace-state.test.ts` (the reducer's test): add coverage for `openOrFocusSettings` (open-when-none, focus-when-present, no-op-when-already-active), the settings-tab persist round-trip, and the restore-side singleton defense — without breaking any existing assertion (no existing test hardcodes the kind-set length or membership; `toHaveLength(5)` at line 58 counts five explicitly-opened tabs, not the enum).

**Block If:**
- If `"settings"` cannot join `WORKSPACE_TAB_KINDS` without breaking a Core validation test that hardcodes the exact kind set or the literal `"each tab.kind must be one of …"` message (a repo-wide search finds NONE today) — HALT `blocked`, condition `settings kind cannot join the contract enum without breaking a Core validation test`.
- If the Chrome tab strip cannot render a `settings` tab body without restructuring `TabContent`'s kind routing in a way that breaks the `role="tab"` / `aria-selected` / close-button contract — HALT `blocked`, condition `settings tab body cannot mount without breaking the tab a11y contract`.

**Never:**
- No overlay / superimposed Settings surface — Settings is a tab, full stop. Do NOT keep the `settingsOpen` flag, the `toggleSettings` mutual-exclusion, or the `settingsOpen ? <SettingsPanel/>` branch for it.
- No second Settings tab, ever — NO code path (rail toggle, App action, the new-tab `+`, or restore) may yield two settings tabs. In particular, the new-tab `+` (which duplicates the active tab's kind, `onOpen(activeTab?.kind ?? …)`) MUST guard against `"settings"` and open a document kind instead.
- No change to `SettingsPanel`'s RPC methods/params, connection/provider gates (`busy`/`loading`/`listLoaded`), credential-store / vault trust boundary, `envelopeText` behavior, or its props/testids — the ONLY wiring change is that its `onClose` now closes the settings tab (`onClose(settingsTabId)`) instead of hiding an overlay.
- No change to create-table's toggle/overlay behavior; do not remove `ExposureBanner`, the `PanelGroup` layout, or the status bar.
- No snapshot version bump; do not hand-duplicate the kind list in Core (keep the single source of truth in `contract.ts`).
- No coral / off-brand chrome regression — the settings tab wears the same neutral Chrome tab treatment as every other tab (Epic 7).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open Settings (none open) | click rail `settings-toggle` | A single `"Settings"` tab is appended (leading gear icon + close `×`), activated; its body renders `SettingsPanel` (`data-testid="settings-panel"`) in the normal tab-body slot — NO overlay; `nextId` bumps | No error |
| Open Settings (already open, not active) | click `settings-toggle` again | The EXISTING settings tab is activated/focused via `activateTab`; NO second tab; `nextId` unchanged | No error |
| Settings already the active tab | click `settings-toggle` | `openOrFocusSettings` → `activateTab` is a no-op (already active); state unchanged | No-op |
| Close the Settings tab | tab `×` OR panel "close" (`aria-label="Close settings"`) | `onClose(settingsTabId)` runs the normal `closeTab` path; nearest-sibling activation; `SettingsPanel` unmounts | No error |
| New-tab `+` while Settings active | click `+` with `activeTab.kind === "settings"` | `+` opens a DOCUMENT kind (default), never a second settings tab — the `onOpen(activeTab?.kind ?? …)` fallback is guarded against `"settings"` | No duplicate |
| Create-table toggle with a Settings tab open | click `create-table-toggle` | Create-table overlay opens over the panel (strip hidden, as today); the Settings tab stays open underneath; closing create returns to the active tab (possibly Settings). `create-table-toggle` testid/`aria-pressed` preserved | No error |
| Persist + reload with Settings open | `workspace.save` then relaunch | The settings tab is written into the snapshot and `restoreWorkspace` reopens it; `TabContent` re-mounts `SettingsPanel`. A pre-change snapshot (only document kinds) still loads (no version bump) | No error |
| Hand-edited snapshot: two settings tabs | restore a file with two `kind:"settings"` tabs (distinct ids) | `restoreWorkspace` collapses to the FIRST settings tab (singleton defense), mirroring the DW-26 id-dedupe philosophy | Tolerated, deduped |
| Core save-boundary validation | `workspace.save` with a settings tab | `checkTabs`/`isTabKind` accept `"settings"` (derived from `WORKSPACE_TAB_KINDS`); no `bad_request` | Behavior preserved |
| Credential-store / provider flows inside the tab | add/edit/remove connection, provider set/remove, error envelope, mutation gates | Identical to the overlay era — only the mount site changed (tab body vs overlay); `role="alert"`, `settings-panel` testid intact | `bun test` green; no settings-model test edit needed |
| Full suite | `bunx tsc --noEmit` + `bun test` | tsc clean; `workspace-state.test.ts` extended (not broken); full suite green | No error |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- add `"settings"` to `WORKSPACE_TAB_KINDS` (line 677). `WorkspaceTabKind`, `WorkspaceSnapshotTab.kind`, and BOTH Core `isTabKind` guards (`workspace-store.ts:94`, `workspace-registry.ts:81`) derive from this array, so Core validation + the persisted tab type accept a settings tab automatically. Update the doc comment (currently "The five kinds of DOCUMENT Tab … Order matches the launcher-rail order") to state that `settings` is a SYSTEM singleton tab, NOT a launcher-rail kind. Keep `WORKSPACE_SNAPSHOT_VERSION = 1` (additive member).
- `src/ui/workspace/workspace-state.ts` -- (1) `TAB_KINDS` (re-export of the widened enum) now includes settings; introduce `LAUNCHER_KINDS: ReadonlyArray<TabKind>` = the five document kinds (e.g. `TAB_KINDS.filter((k) => k !== "settings")`, or an explicit list) for the rail loop and any document-only per-kind record. (2) `KIND_LABEL` (`Record<TabKind,string>`) gains `settings: "Settings"` to stay exhaustive. (3) Add `openOrFocusSettings(state: WorkspaceState): WorkspaceState` — `const existing = state.tabs.find((t) => t.kind === "settings")`; if found return `activateTab(state, existing.id)`, else append `{ id: nextId, kind: "settings", title: "Settings" }`, make it active, bump `nextId` (pure; mirrors `openTab` but singleton + no numeric suffix). (4) `restoreWorkspace`: after the existing id-dedupe loop, add a settings-singleton defense — keep only the FIRST `kind:"settings"` tab (drop any later ones), then recompute `activeTabId` defensively if it pointed at a dropped tab.
- `src/ui/workspace/Workspace.tsx` -- remove the `settingsOpen` state (line 273), `toggleSettings` (278-281), and the `settingsOpen ? <SettingsPanel/>` overlay branch (343-344). Keep `createOpen`/`toggleCreate`, dropping `toggleCreate`'s now-defunct `setSettingsOpen(false)`. The rail loop iterates `LAUNCHER_KINDS` (not `TAB_KINDS`) so no settings launcher button appears; add a `settings` entry (or re-key to the document subset) for `LAUNCH_LABEL` and `KIND_ICON`. Change the rail `LauncherRail` prop `onToggleSettings` → `onOpenSettings` (open-or-focus); on the Settings `<button>` keep `data-testid="settings-toggle"`/`aria-label`/`title`, set `aria-pressed={activeTab?.kind === "settings"}` (truthful "you're viewing settings"), `onClick={onOpenSettings}`. Change the strip-visibility gate `!settingsOpen && !createOpen` → `!createOpen` (line 324). Guard the new-tab `+` fallback (line 333): open `activeTab && activeTab.kind !== "settings" ? activeTab.kind : LAUNCHER_KINDS[0]` so `+` never duplicates settings. Thread a close handler into `TabContent` for the settings body (pass `onClose`, used as `() => onClose(settingsTabId)`).
- `src/ui/workspace/TabContent.tsx` -- add a `tab.kind === "settings"` routing branch → `<SettingsPanel onClose={() => onCloseTab?.(tab.id)} />`; add an `onCloseTab?: (id: number) => void` prop (Workspace passes its `onClose`). `KIND_BLURB` stays keyed to the document subset (or gains a harmless settings entry) — the settings tab never renders the placeholder body. No change to the other kind branches.
- `src/ui/workspace/TabBar.tsx` -- `TAB_ICON` (`Record<TabKind,JSX>`) gains a `settings` gear leading icon (reuse the rail's gear SVG) so the Settings tab shows a proper leading icon in the strip. Roles / `aria-selected` / close-button `aria-label` / keyboard contract unchanged.
- `src/ui/settings/SettingsPanel.tsx` -- NO behavior change. Its `onClose` prop now closes the settings tab (the caller wires `() => onClose(settingsTabId)`) instead of hiding an overlay; keep the header "close" button and its `aria-label="Close settings"` (a second, redundant-but-harmless close affordance alongside the tab `×`, and a preserved DOM/e2e target). All connection/provider RPC, gates, `data-testid="settings-panel"`, and `role="alert"` lines are untouched.
- `src/ui/App.tsx` -- add a `WorkspaceAction` variant `{ type: "openSettings" }` and a `workspaceReducer` case `return openOrFocusSettings(state)`; pass `onOpenSettings={() => dispatch({ type: "openSettings" })}` down to `Workspace`. The existing `onClose` cleanup effects (query drafts / chat / report / erd maps) are id-keyed and no-op for a settings tab — no change needed.
- `src/ui/workspace/workspace-state.test.ts` -- EXTEND (do not rewrite): add tests for `openOrFocusSettings` (opens one when none exists → appended, active, `title:"Settings"`, `nextId++`; focuses the existing one when present → no new tab, `nextId` unchanged, `activeTabId` = existing; is a no-op when settings already active); a settings tab round-trips `toWorkspaceSnapshot` → `restoreWorkspace`; `restoreWorkspace` collapses two settings tabs to the first. Existing assertions stay green (none assert the kind-set length/membership).
- `src/core/workspace-store.ts` + `src/core/workspace-registry.ts` -- NO manual edit. Both `isTabKind` guards derive from `WORKSPACE_TAB_KINDS` and accept `"settings"` automatically once the contract array grows; the `checkTabs` error string updates itself via `WORKSPACE_TAB_KINDS.join(", ")`. Listed to pin that validation follows the single source of truth (verify no Core test hardcodes the old set — search shows none).
- `design-artifacts/connect.html` + `design-artifacts/workspace.html` -- reference only (visual source of truth): `connect.html` renders the connections/settings surface as a normal `.tab` inside the Chrome `.tabs` strip (with `.tab-add` `+`); `workspace.html`'s rail keeps Settings as the bottom-pinned icon button (line 896) below the `.spacer`. Confirms settings-as-a-tab/view, not an overlay.

## Acceptance Criteria

- Given no Settings tab is open, when the rail Settings control (`data-testid="settings-toggle"`) is clicked, then a single `"Settings"` tab appears in the tab strip (leading gear icon + close `×`), becomes active, and its body renders `SettingsPanel` (`data-testid="settings-panel"`) in the normal tab-body slot — no overlay superimposes over the workspace and the tab strip stays visible.
- Given a Settings tab is already open, when Settings is clicked again, then the existing Settings tab is focused/activated and NO second Settings tab is created (singleton) — verified live at http://127.0.0.1:6061.
- Given a Settings tab, when it is closed via the tab `×` or the panel "close" (`aria-label="Close settings"`), then it is removed through the normal `closeTab` path and the nearest sibling activates.
- Given a Settings tab is open, when the workspace is saved and the app reloaded, then the Settings tab is restored (recommended persist) and re-mounts `SettingsPanel`; a pre-change snapshot with only document kinds still loads with no version bump.
- Given the new-tab `+` while the Settings tab is active, then `+` opens a document tab and never a second Settings tab.
- Given the create-table toggle, then its `data-testid="create-table-toggle"`, `aria-pressed`, and overlay behavior are unchanged, and the former Settings overlay is gone.
- Given `SettingsPanel`, when inspected, then its connection/provider RPC calls, `busy`/`loading`/`listLoaded` gates, credential-store trust boundary, `envelopeText` error surfacing, `role="alert"` lines, and `data-testid="settings-panel"` are identical to before — only its mount site (tab body vs overlay) and `onClose` target changed.
- Given the suite, when run, then `bunx tsc --noEmit` is clean and `bun test` is green with `workspace-state.test.ts` extended (new `openOrFocusSettings` / persist-round-trip / restore-dedupe tests) and no existing assertion broken; Core accepts a persisted `"settings"` tab without a `bad_request`.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors. Note the exhaustiveness fan-out: widening `TabKind` with `"settings"` makes every `Record<TabKind, …>` (`KIND_LABEL`, `LAUNCH_LABEL`, `KIND_ICON`, `TAB_ICON`, `KIND_BLURB`) a compile error until each is either given a `settings` entry or re-keyed to the document subset — tsc pinpoints every site.
- `bun test` -- expected: full suite green. The reducer suite `src/ui/workspace/workspace-state.test.ts` MUST be extended (not broken) with the new `openOrFocusSettings`, settings persist round-trip, and restore-dedupe tests. Core suites over `workspace-store`/`workspace-registry` stay green (validation derives from the contract enum; no test hardcodes the old kind set or the `"must be one of …"` message). Settings behavior is covered only by the pure `connections-model.test.ts`/`providers-model.test.ts` (no DOM), which a mount-site change cannot affect.
- `bun run build` -- expected: OK (regenerates the UI bundle embedding the tab-routed Settings).

**Manual checks (live at http://127.0.0.1:6061):**
- Launch against a seeded database. Click the rail Settings icon → a Settings tab opens in the strip (gear leading icon), no overlay, the tab strip and other tabs stay visible.
- Click the Settings icon AGAIN → the existing Settings tab is focused; confirm there is exactly ONE Settings tab (no duplicate, no re-overlay).
- Close the Settings tab via its `×` and via the panel's "close"; reopen it.
- Inside the Settings tab, exercise Connections add/edit/remove and AI-providers set/remove — behavior identical to the overlay era.
- Open create-table from the rail and confirm it still overlays the panel (strip hidden) with the Settings tab preserved underneath.
- Reload the app and confirm the Settings tab restores (recommended persist) and re-mounts the panel.
