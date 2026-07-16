---
title: 'Settings as a singleton tab — retire the overlay, route Settings through the normal tab model (open-or-focus)'
type: 'refactor'
created: '2026-07-16'
status: 'done'
baseline_revision: '11928e5413903456f0160f052e6f7749f8007682'
final_revision: '5c5ce492afe44916023d26cc87c94925a2befe28'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/design-artifacts/connect.html'
  - '{project-root}/design-artifacts/workspace.html'
warnings: ['oversized']
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

<!-- Current line numbers reconciled to the post-8-5 tree. The intent-contract above quotes a few pre-8-5 line anchors (e.g. Workspace.tsx:273, 324; store:94; registry:81); THIS Code Map is the authoritative current-location layer. -->

- `src/shared/contract.ts` — add `"settings"` to `WORKSPACE_TAB_KINDS` (**line 677**, currently `["table","query","erd","chat","report"] as const`). `WorkspaceTabKind` (**680**), `WorkspaceSnapshotTab.kind` (**688**), and BOTH Core `isTabKind` guards derive from this array, so Core validation + the persisted tab type accept a settings tab automatically. Update the doc comment (**672-676**, currently "The five kinds of document Tab … Order matches the launcher-rail order") to state that `settings` is a SYSTEM singleton tab, NOT a launcher-rail kind, and that only the five document kinds map to launcher order. Also touch the "five kinds" wording in the `WorkspaceSnapshot` doc block (**692-722**) if it enumerates a count. Keep `WORKSPACE_SNAPSHOT_VERSION = 1` (**683**, additive member).
- `src/ui/workspace/workspace-state.ts` — (1) `TAB_KINDS` (**line 83**, re-export of the widened contract enum) now includes settings. Introduce `LAUNCHER_KINDS: ReadonlyArray<TabKind>` = the five document kinds (`TAB_KINDS.filter((k) => k !== "settings")`, or an explicit list) for the rail loop / any document-only per-kind record. (2) `KIND_LABEL` (`Readonly<Record<TabKind,string>>`, **line 74**) gains `settings: "Settings"` to stay exhaustive. (3) Add `openOrFocusSettings(state: WorkspaceState): WorkspaceState` — `const existing = state.tabs.find((t) => t.kind === "settings")`; if found return `activateTab(state, existing.id)`, else append `{ id: state.nextId, kind: "settings", title: "Settings" }`, make it active, `nextId: id + 1` (pure; mirrors `openTab` at **94-103** but singleton + no numeric suffix — do NOT reuse `openTab`'s `` `${KIND_LABEL[kind]} ${id}` `` title). (4) `restoreWorkspace` (**199**): after the existing id-dedupe loop (**200-206**), add a settings-singleton defense — keep only the FIRST `kind:"settings"` tab (drop any later ones), then recompute `activeTabId` defensively if it pointed at a dropped tab. `toWorkspaceSnapshot` (**269-274**, now 4 params incl `lastProvider`) and the snapshot bridge need NO change — they already map generically over `{ id, kind, title }`.
- `src/ui/workspace/Workspace.tsx` — remove `settingsOpen` state (**line 276**), `toggleSettings` (**281-284**), and the `settingsOpen ? <SettingsPanel/>` overlay branch (**346-347**, inside the three-way branch 346-376). Keep `createOpen` (**280**)/`toggleCreate` (**285-288**), dropping `toggleCreate`'s now-defunct `setSettingsOpen(false)`. The rail loop (**107-120** in `LauncherRail`) iterates `LAUNCHER_KINDS` (not `TAB_KINDS`) so no settings launcher button appears; add a `settings` entry (or re-key to the document subset) for `LAUNCH_LABEL` (**31**) and `KIND_ICON` (**40**) to keep the `Record<TabKind,…>` exhaustive under tsc. Change the `LauncherRail` prop `onToggleSettings` (**91**) → `onOpenSettings` (open-or-focus); on the Settings `<button>` (**142-158**) keep `data-testid="settings-toggle"` / `aria-label="Settings"` / `title`, set `aria-pressed={activeTab?.kind === "settings"}` (truthful "you're viewing settings"), `onClick={onOpenSettings}`. Instantiate `LauncherRail` (**299-305**) with `onOpenSettings={onOpenSettings}` (a NEW Workspace prop threaded from App — see App.tsx). Change the strip-visibility gate `!settingsOpen && !createOpen` → `!createOpen` (**line 327**). Guard the new-tab `+` fallback (**336**): `onOpen(activeTab && activeTab.kind !== "settings" ? activeTab.kind : LAUNCHER_KINDS[0]!)` so `+` never duplicates settings. Thread a close handler into `TabContent` (rendered **355-375**) for the settings body: pass `onCloseTab={onClose}` (Workspace already receives `onClose(id)` — used by `TabContent` as `() => onCloseTab(tab.id)`).
- `src/ui/workspace/TabContent.tsx` — add a `tab.kind === "settings"` routing branch (beside the existing chat branch at **526**, before the fallback placeholder **568-584**) → `<SettingsPanel onClose={() => onCloseTab?.(tab.id)} />`; add an `onCloseTab?: (id: number) => void` prop to the props interface (**452-492**). `KIND_BLURB` (`Readonly<Record<TabKind,string>>`, **56**) gains a harmless `settings` entry to stay exhaustive (the settings tab never renders the placeholder body). No change to the other kind branches (table 497, query 512, chat 526, erd 540, report 555).
- `src/ui/workspace/TabBar.tsx` — `TAB_ICON` (`Readonly<Record<TabKind,React.JSX.Element>>`, **line 18**) gains a `settings` gear leading icon (reuse the rail's gear SVG) so the Settings tab shows a proper leading icon in the strip. Roles (`role="tablist"` 66-67 / `role="tab"` 75) / `aria-selected` (76) / close-button `aria-label` (104) / keyboard contract unchanged.
- `src/ui/settings/SettingsPanel.tsx` — NO behavior change. Its sole prop stays `onClose` (**208**); the caller now wires `() => onCloseTab(settingsTabId)` so "close" closes the settings tab instead of hiding an overlay. Keep the header "close" button and its `aria-label="Close settings"` (**331-338**) — a second, redundant-but-harmless close affordance alongside the tab `×`, and a preserved DOM/e2e target. All connection/provider RPC, gates, `data-testid="settings-panel"` (**299**), and `role="alert"` lines untouched.
- `src/ui/App.tsx` — add a `WorkspaceAction` variant `{ type: "openSettings" }` (union **71-76**) and a `workspaceReducer` case (**78-90**) `case "openSettings": return openOrFocusSettings(state);` (import the helper). Pass `onOpenSettings={() => dispatch({ type: "openSettings" })}` down to `<Workspace>` (rendered **559-624**, beside `onOpen` 561). The existing `onClose` cleanup effects (queryDrafts 567-572 / chatStates 575-580 / reportStates 583-588 / erdLayouts 590-596) are all id-keyed and no-op for a settings tab — no change needed. NOTE: today settings toggling is ENTIRELY internal to `Workspace.tsx` (App passes no settings prop); this story lifts the action into the App-level reducer because the tab model / `WorkspaceState` lives here.
- `src/ui/workspace/workspace-state.test.ts` — EXTEND (do not rewrite): add tests for `openOrFocusSettings` (opens one when none exists → appended, active, `title:"Settings"`, `nextId++`; focuses the existing one when present → no new tab, `nextId` unchanged, `activeTabId` = existing; is a no-op when settings already active); a settings tab round-trips `toWorkspaceSnapshot` → `restoreWorkspace`; `restoreWorkspace` collapses two settings tabs to the first. Existing assertions stay green — the `toEqual([...5 kinds])` / `toHaveLength(5)` pair (**58-59**) counts five explicitly-opened document tabs, not the enum, and never opens a settings tab.
- `src/core/workspace-store.ts` (**isTabKind 91**, **checkTabs error 107**) + `src/core/workspace-registry.ts` (**isTabKind 80**) — NO manual edit. Both `isTabKind` guards derive from `WORKSPACE_TAB_KINDS` and accept `"settings"` automatically once the contract array grows; the `checkTabs` error string builds from `WORKSPACE_TAB_KINDS.join(", ")` and updates itself. Verified: no Core test hardcodes the valid kind-set or the "must be one of …" literal (`workspace-store.test.ts` uses only table/query; `workspace-registry.test.ts` "unknown kind" test at 223-231 uses `"not-a-kind"`, still invalid). Listed to pin that validation follows the single source of truth.
- `design-artifacts/connect.html` (tab strip **696-703**, `.tab` CSS 264-315) + `design-artifacts/workspace.html` (rail Settings icon **896-898**, below the `.spacer` 895) — reference only (visual source of truth): `connect.html` renders the connection/settings surface as a normal `.tab` (leading `.k` icon + close `.x`) inside the Chrome `.tabs` strip with `.tab-add` `+`; `workspace.html`'s rail keeps Settings as the bottom-pinned gear icon. Confirms settings-as-a-tab/view, not an overlay.

## Tasks & Acceptance

**Execution:** (ordered by dependency — the contract enum widens first, forcing the `Record<TabKind,…>` exhaustiveness fan-out tsc pinpoints)

- [x] `src/shared/contract.ts` — add `"settings"` to `WORKSPACE_TAB_KINDS` (677); update the "five kinds / launcher-rail order" doc comment (672-676, and any count in 692-722) to note `settings` is a system singleton tab, not a launcher kind. Keep `WORKSPACE_SNAPSHOT_VERSION = 1`. No RPC/param/type-shape change beyond the widened enum member.
- [x] `src/ui/workspace/workspace-state.ts` — add `LAUNCHER_KINDS` (five document kinds); add `settings: "Settings"` to `KIND_LABEL` (74); add pure `openOrFocusSettings(state)` (focus existing settings tab via `activateTab`, else append one `{kind:"settings", title:"Settings"}`, activate, bump `nextId`); in `restoreWorkspace` (199) add a settings-singleton defense after the id-dedupe loop (keep only the first `kind:"settings"`, recompute `activeTabId` if it pointed at a dropped tab). `toWorkspaceSnapshot`/bridge unchanged.
- [x] `src/ui/workspace/workspace-state.test.ts` — EXTEND (additive): `openOrFocusSettings` open-when-none / focus-when-present / no-op-when-active; settings-tab `toWorkspaceSnapshot`→`restoreWorkspace` round-trip; `restoreWorkspace` collapses two settings tabs to the first. Do not weaken existing assertions. (Covers the I/O-matrix reducer rows.)
- [x] `src/ui/App.tsx` — add `WorkspaceAction` `{ type: "openSettings" }` (71-76) + `workspaceReducer` case `return openOrFocusSettings(state)` (78-90, import helper); pass `onOpenSettings={() => dispatch({ type: "openSettings" })}` to `<Workspace>` (559-624). No change to the id-keyed `onClose` cleanup effects.
- [x] `src/ui/workspace/Workspace.tsx` — delete `settingsOpen` (276), `toggleSettings` (281-284), and the `settingsOpen ? <SettingsPanel/>` overlay branch (346-347); drop `setSettingsOpen(false)` from `toggleCreate` (285-288); accept a new `onOpenSettings` prop, thread it to `LauncherRail` (299-305) and rename its prop `onToggleSettings`→`onOpenSettings` (91); on the settings `<button>` (142-158) keep `settings-toggle` testid/`aria-label`/`title`, set `aria-pressed={activeTab?.kind === "settings"}`, `onClick={onOpenSettings}`; rail loop (107-120) iterates `LAUNCHER_KINDS`; add `settings` entries to `LAUNCH_LABEL` (31) + `KIND_ICON` (40); change strip gate `!settingsOpen && !createOpen`→`!createOpen` (327); guard the `+` fallback (336) against `"settings"`; pass `onCloseTab={onClose}` to `<TabContent>` (355-375).
- [x] `src/ui/workspace/TabContent.tsx` — add `onCloseTab?: (id:number)=>void` to props (452-492); add a `tab.kind === "settings"` branch → `<SettingsPanel onClose={() => onCloseTab?.(tab.id)} />` (beside chat 526, before the placeholder 568-584); add a harmless `settings` entry to `KIND_BLURB` (56). No other branch changes.
- [x] `src/ui/workspace/TabBar.tsx` — add a `settings` gear entry to `TAB_ICON` (18, reuse the rail gear SVG). No role/`aria-selected`/close-button/keyboard change.
- [x] `src/ui/settings/SettingsPanel.tsx` — NO behavior change; verify `onClose` (208), `data-testid="settings-panel"` (299), `aria-label="Close settings"` (331-338), every `role="alert"`, and all connection/provider RPC/gates are untouched. (Relocation only; listed to pin the no-touch boundary.)

**Acceptance Criteria:**

- Given no Settings tab is open, when the rail Settings control (`data-testid="settings-toggle"`) is clicked, then a single `"Settings"` tab appears in the tab strip (leading gear icon + close `×`), becomes active, and its body renders `SettingsPanel` (`data-testid="settings-panel"`) in the normal tab-body slot — no overlay superimposes over the workspace and the tab strip stays visible.
- Given a Settings tab is already open, when Settings is clicked again, then the existing Settings tab is focused/activated and NO second Settings tab is created (singleton) — verified live at http://127.0.0.1:6061.
- Given a Settings tab, when it is closed via the tab `×` or the panel "close" (`aria-label="Close settings"`), then it is removed through the normal `closeTab` path and the nearest sibling activates.
- Given a Settings tab is open, when the workspace is saved and the app reloaded, then the Settings tab is restored (recommended persist) and re-mounts `SettingsPanel`; a pre-change snapshot with only document kinds still loads with no version bump.
- Given the new-tab `+` while the Settings tab is active, then `+` opens a document tab and never a second Settings tab.
- Given the create-table toggle, then its `data-testid="create-table-toggle"`, `aria-pressed`, and overlay behavior are unchanged, and the former Settings overlay is gone.
- Given `SettingsPanel`, when inspected, then its connection/provider RPC calls, `busy`/`loading`/`listLoaded` gates, credential-store trust boundary, `envelopeText` error surfacing, `role="alert"` lines, and `data-testid="settings-panel"` are identical to before — only its mount site (tab body vs overlay) and `onClose` target changed.
- Given the suite, when run, then `bunx tsc --noEmit` is clean and `bun test` is green with `workspace-state.test.ts` extended (new `openOrFocusSettings` / persist-round-trip / restore-dedupe tests) and no existing assertion broken; Core accepts a persisted `"settings"` tab without a `bad_request`.

## Spec Change Log

## Review Triage Log

### 2026-07-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 0
- reject: 8
- addressed_findings:
  - `[medium]` `[patch]` Clicking the rail Settings control while the create-table overlay was open dispatched `openSettings` (activating the Settings tab in the model) but never cleared `createOpen`, so the Create overlay kept covering the pane — the click looked inert. The old `toggleSettings` ran `setCreateOpen(false)`; that mutual exclusion was dropped when Settings became a tab. Restored it: Workspace now wraps `onOpenSettings` to `setCreateOpen(false)` first, and the `settings-toggle` `aria-pressed` is `activeTab?.kind === "settings" && !createOpen` so it never falsely claims "you're viewing settings" while Create covers it. (`src/ui/workspace/Workspace.tsx`)
  - `[low]` `[patch]` `openTab` now type-accepts `"settings"` (widened enum) and would have minted a numeric-suffixed `"Settings 2"` duplicate, bypassing the singleton. Added a guard: `if (kind === "settings") return openOrFocusSettings(state)` — a third, reducer-level defense alongside the open seam and the restore collapse. Covered by a new additive test. (`src/ui/workspace/workspace-state.ts`, `src/ui/workspace/workspace-state.test.ts`)
  - `[low]` `[patch]` The `TabKind` alias doc comment still read "The five kinds of document Tab" after the enum grew to six; the spec explicitly required purging the "five kinds" wording. Corrected to "five document kinds plus the `settings` system singleton". (`src/ui/workspace/workspace-state.ts`)
  - `[low]` `[patch]` The tab-strip gear icon was hand-copied at `strokeWidth={1.8}` while the rail gear is `1.7`, so the two gears would not match — a fidelity miss in an epic whose whole point is prototype fidelity. Set the `TabBar` gear to `1.7` to match the rail. (`src/ui/workspace/TabBar.tsx`)
  - `[low]` `[patch]` The `settings` tab body rendered `<SettingsPanel>` without `key={tab.id}`, unlike every sibling branch (query/chat/erd/report). Harmless while the singleton holds, but inconsistent and non-remounting if two settings tabs ever coexist pre-collapse. Added `key={tab.id}`. (`src/ui/workspace/TabContent.tsx`)

Rejected (8 — noise / by-design / verified-safe): rail Settings click is an inert no-op when Settings is already the active tab (BY SPEC — the I/O matrix "Settings already the active tab → no-op"; open-or-focus is deliberately not a toggle, and `aria-pressed` staying true is truthful); `onCloseTab` being an optional prop (matches the codebase's pervasive optional-callback idiom; the sole caller wires it, and the redundant tab `×` remains); the three "exhaustiveness filler" `Record<TabKind,…>` entries (`KIND_ICON`/`LAUNCH_LABEL`/`KIND_BLURB` settings) (tsc-safe, commented; re-keying to a document-kind subset was an explicit spec-listed alternative, not a requirement); `LAUNCHER_KINDS` defined as `filter(k !== "settings")` being "membership-fragile" for hypothetical future system kinds (speculative, no active defect); `LAUNCHER_KINDS[0]!` non-null assertions (impossible-to-empty today; same pattern as the pre-existing `TAB_KINDS[0]!`); no component-level test for the `+`-guard / overlay interaction (the no-duplicate invariant is now enforced and unit-tested at THREE reducer seams — `openOrFocusSettings`, the new `openTab` guard, and `restoreWorkspace` collapse — so the JSX ternary is no longer load-bearing); restore "collapse to first" discarding a possibly-active second settings tab (BY SPEC — "collapse to the FIRST", mirroring DW-26; `activeTabId` is defensively recomputed); and the rail `aria-pressed` + tab `aria-selected` both signalling settings-active to AT (inherent to the spec's design of keeping the bottom-pinned rail toggle AND the tab).

## Design Notes

**Why the action lifts into App's reducer (not a local Workspace flag).** Today the whole settings overlay is local `Workspace.tsx` state (`settingsOpen`), and `App.tsx` passes NO settings prop. The moment Settings becomes a tab it MUST live in the `WorkspaceState` the App-level `workspaceReducer` owns (that's where `tabs`/`activeTabId`/`nextId` live). So the change is: a new `{ type: "openSettings" }` action → `openOrFocusSettings(state)` in the reducer, and a single `onOpenSettings` callback threaded App → Workspace → LauncherRail. No settings state survives in Workspace.

**Singleton at one seam + defense in depth on restore.** The invariant "at most one settings tab" is enforced primarily at the SOLE open seam (`openOrFocusSettings` focuses instead of appending). Restore is a SECOND, independent entry point (a hand-edited or legacy snapshot could carry two), so `restoreWorkspace` gets its own collapse-to-first defense — mirroring the DW-26 id-dedupe already in that function (200-206). Two guards because there are two ways in; neither alone is sufficient.

**`WORKSPACE_TAB_KINDS` as the single source of truth pays off here.** Adding one enum member to `contract.ts:677` flows automatically to: both Core `isTabKind` guards (store:91, registry:80), the `checkTabs` error string (registry:107, built via `.join`), and the persisted `WorkspaceSnapshotTab.kind` type — with ZERO Core hand-edits and no Core-test breakage (verified: no test enumerates the valid set or matches the "must be one of" literal). The cost is a tsc exhaustiveness fan-out across five `Record<TabKind,…>` maps (`KIND_LABEL`, `LAUNCH_LABEL`, `KIND_ICON`, `TAB_ICON`, `KIND_BLURB`) — tsc pinpoints each; give each a `settings` entry (or re-key document-only maps to `LAUNCHER_KINDS`).

**Persist-the-tab is the consistent choice (mirrors 8-5's field-drop posture).** The snapshot bridge maps generically over `{ id, kind, title }`, so a settings tab round-trips with no bridge special-casing once the contract accepts the kind — and `WORKSPACE_SNAPSHOT_VERSION` stays `1` (additive member; a document-only snapshot still loads). This follows the epic's established restore-tolerance philosophy from 8-5 (a single bad/unknown persisted value is dropped, never rejects the whole snapshot): the restore-side singleton defense drops extra settings tabs rather than failing the load.

**Example — `openOrFocusSettings` (pure, ~6 lines):**
```ts
export function openOrFocusSettings(state: WorkspaceState): WorkspaceState {
  const existing = state.tabs.find((t) => t.kind === "settings");
  if (existing) return activateTab(state, existing.id);
  const id = state.nextId;
  const tab: WorkspaceTab = { id, kind: "settings", title: "Settings" };
  return { ...state, tabs: [...state.tabs, tab], activeTabId: id, nextId: id + 1 };
}
```

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors. Exhaustiveness fan-out: widening `TabKind` with `"settings"` makes every `Record<TabKind,…>` (`KIND_LABEL`, `LAUNCH_LABEL`, `KIND_ICON`, `TAB_ICON`, `KIND_BLURB`) a compile error until each is given a `settings` entry or re-keyed to `LAUNCHER_KINDS`; tsc pinpoints every site.
- `bun test` — expected: full suite green. `src/ui/workspace/workspace-state.test.ts` MUST be extended (not broken) with the new `openOrFocusSettings`, settings persist round-trip, and restore-dedupe tests. Core suites (`workspace-store`/`workspace-registry`) stay green (validation derives from the contract enum; no test hardcodes the old kind set or the "must be one of …" message). `SettingsPanel` behavior is covered only by the pure `connections-model.test.ts`/`providers-model.test.ts` (no DOM), which a mount-site change cannot affect.
- `bun run build` — expected: OK (regenerates the UI bundle embedding the tab-routed Settings).

**Manual checks (live at http://127.0.0.1:6061):**
- Launch against a seeded database. Click the rail Settings icon → a Settings tab opens in the strip (gear leading icon), no overlay, the tab strip and other tabs stay visible.
- Click the Settings icon AGAIN → the existing Settings tab is focused; confirm there is exactly ONE Settings tab (no duplicate, no re-overlay).
- Close the Settings tab via its `×` and via the panel's "close"; reopen it.
- Inside the Settings tab, exercise Connections add/edit/remove and AI-providers set/remove — behavior identical to the overlay era.
- Open create-table from the rail and confirm it still overlays the panel (strip hidden) with the Settings tab preserved underneath.
- Reload the app and confirm the Settings tab restores (recommended persist) and re-mounts the panel.

## Auto Run Result

Status: done

**Implemented change:** Retired the Settings overlay and made Settings a normal SINGLETON TAB in the workspace tab model. `"settings"` joined the single-source-of-truth `WORKSPACE_TAB_KINDS` (additive enum member, no snapshot-version bump); a pure `openOrFocusSettings` reducer helper enforces the singleton at the open seam (focus-if-open, else open one), `restoreWorkspace` gained a collapse-to-first singleton defense, and `openTab` routes `"settings"` through the same seam (defense-in-depth added in review). `SettingsPanel` mounts as the tab body via `TabContent`; the rail `settings-toggle` repoints to an App-level `{ type: "openSettings" }` reducer action; the overlay branch, `settingsOpen` flag, and `toggleSettings` are gone. Create-table's overlay and `SettingsPanel`'s behavior/RPC/testids are untouched.

**Files changed:**
- `src/shared/contract.ts` — added `"settings"` to `WORKSPACE_TAB_KINDS`; doc comment reworked (five document kinds + settings singleton); `WORKSPACE_SNAPSHOT_VERSION` stays `1`.
- `src/ui/workspace/workspace-state.ts` — `LAUNCHER_KINDS` (five document kinds); `KIND_LABEL.settings`; pure `openOrFocusSettings`; `restoreWorkspace` settings-singleton collapse; `openTab` singleton guard; `TabKind` doc comment corrected.
- `src/ui/App.tsx` — `WorkspaceAction` `openSettings` variant + reducer case → `openOrFocusSettings`; `onOpenSettings` threaded to `<Workspace>`.
- `src/ui/workspace/Workspace.tsx` — deleted the settings overlay/`settingsOpen`/`toggleSettings`; rail loops `LAUNCHER_KINDS`; `settings` entries in `LAUNCH_LABEL`/`KIND_ICON`; `onOpenSettings` prop (clears the create overlay first); truthful `aria-pressed`; strip gate `!createOpen`; `+`-guard against settings; `onCloseTab` threaded to `TabContent`.
- `src/ui/workspace/TabContent.tsx` — `settings` routing branch → `<SettingsPanel key={tab.id} onClose=…/>`; `onCloseTab` prop; `KIND_BLURB.settings`.
- `src/ui/workspace/TabBar.tsx` — `TAB_ICON.settings` gear (strokeWidth 1.7, matching the rail).
- `src/ui/workspace/workspace-state.test.ts` — additive tests: `openOrFocusSettings` open/focus/no-op/immutability, `openTab('settings')` singleton routing, restore collapse-to-first + `activeTabId` recompute, settings-tab persist round-trip.
- `src/ui/settings/SettingsPanel.tsx` — UNTOUCHED (relocation only).

**Review findings breakdown:** 5 patches applied (1 medium: restored create-overlay dismissal on Settings open + truthful `aria-pressed`; 4 low: `openTab` singleton guard, stale "five kinds" comment, gear strokeWidth 1.7 match, `key={tab.id}` on the settings body). 0 deferred. 8 rejected (by-design / speculative / verified-safe — see Review Triage Log). No intent_gap, no bad_spec, no loopback.

**Verification:** `bunx tsc --noEmit` clean; `bun test` 1160 pass / 0 fail across 70 files; `bun run build` OK (regenerated the UI bundles). Live visual check at http://127.0.0.1:6061 (per the epic's fidelity gate) not performed in this unattended run — deferred to manual verification.

**Residual risks:** Low. The singleton is enforced at three tested reducer seams. The one behavior the unattended run cannot self-confirm is the live visual/interaction fidelity against `design-artifacts/connect.html` / `workspace.html` (the epic-wide manual gate), notably the gear-icon match and the tab wearing the neutral Chrome treatment.
