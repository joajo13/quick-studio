---
title: 'Custom neutral scrollbars + remove the left-panel divider seam'
type: 'refactor'
created: '2026-07-16'
status: 'backlog'
context:
  - '{project-root}/design-artifacts/workspace.html'
  - '{project-root}/design-artifacts/ai-chat-chatgpt.html'
  - '{project-root}/src/ui/styles/globals.css'
  - '{project-root}/src/ui/workspace/Workspace.tsx'
  - '{project-root}/src/ui/schema/SchemaTree.tsx'
---

<intent-contract>

## Intent

**Problem:** Two off-brand presentation details survive the Epic-7 neutral pivot and read as regressions against the visual source of truth (`design-artifacts/workspace.html` + `ai-chat-chatgpt.html`):

1. **A hard divider line between the left schema panel (the tables list) and the content.** The prototypes have NO border anywhere across the left region — the rail, the schema sub-sidebar, and the window are all the same near-black surface, and the *only* delimitation is that the content lives in a slightly-lighter, rounded, detached card (`.content-panel`, `--bg` over the deeper `--bg-deep`) with a small margin gap. The current app instead paints a visible vertical seam: `Workspace.tsx`'s `PanelResizeHandle` carries `bg-border` (a 4px-wide `w-1` bar in the solid `--border` grey), and `SchemaTree.tsx`'s `<nav>` carries `border-l border-border` (a second hairline between the rail and the tree). Neither line exists in the artifacts.
2. **Browser-default scrollbars everywhere.** Every scroll container (schema tree, content pane, data grid, query/chat/report bodies) shows the OS/browser default scrollbar, which clashes with the neutral near-black skin. Both prototypes ship an identical custom scrollbar (`::-webkit-scrollbar*`: 12px, transparent track, muted translucent thumb inset via a 3px transparent border → thin look, hover-darkening) that the app never adopted; `globals.css` has NO scrollbar rules at all.

**Approach:** A presentation-only, CSS-and-className port. (a) Remove the seam: strip the resting `bg-border` fill off the `PanelResizeHandle` (keep the element, its `w-1` hit target, and its hover/drag accent so resize still works and still gives feedback) and drop the `border-l border-border` off the `SchemaTree` nav — after this the schema panel is delimited from the content by surface contrast alone (the rounded, lighter `bg-card` content panel with its margin gap), exactly as in the prototypes. (b) Add app-wide custom scrollbars to `globals.css`: the `::-webkit-scrollbar*` rules ported verbatim from the artifacts (thin, transparent track, muted translucent thumb, hover-darkening) PLUS the Firefox `scrollbar-width: thin` / `scrollbar-color` pair (which the Chrome-only prototypes omit), driven by a neutral token pair that flips dark↔light. Nothing else changes: no logic, RPC, state, props, roles, aria, or `data-testid`; the resizable `PanelGroup`/`Panel`/`PanelResizeHandle` drag/`onLayout`/`panelSizes` behavior is byte-for-byte intact; no coral is introduced.

## Boundaries & Constraints

**Always:**
- Match the artifacts as the visual source of truth: the left region (rail → schema sub-sidebar → content) carries NO border between the schema panel and the content — the delimitation reads from surface contrast alone (the detached, rounded, lighter `bg-card` content panel over `bg-background`, with its existing `m-1.5` gap). Both `design-artifacts/workspace.html` (`.rail`/`.side`/`.main` all share the deep surface; only `.content-panel` differs) and `ai-chat-chatgpt.html` confirm this.
- Keep the resizable layout BEHAVIOR verbatim: `PanelGroup`/`Panel`/`PanelResizeHandle` stay; dragging the handle still resizes the two panels live; `onLayout` still reports every layout change up for the debounced save; `panelSizes` is still read once as each `Panel`'s `defaultSize`; the handle keeps a usable pointer hit target (its `w-1` width). Only the *visible resting seam* (`bg-border`) is removed.
- Port the custom scrollbar from the artifacts (identical in both `workspace.html` and `ai-chat-chatgpt.html`): `::-webkit-scrollbar { width:12px; height:12px }`, transparent track, a muted translucent thumb (`border-radius:7px; border:3px solid transparent; background-clip:padding-box` → a thin centered thumb), and a hover state that darkens the thumb. ADD the Firefox equivalent the prototypes omit — `scrollbar-width: thin` and `scrollbar-color: <thumb> transparent` — since the app runs in real browsers, not just WebKit.
- Drive the scrollbar thumb color from a neutral token that flips with the theme, so the thumb reads muted-translucent on both the near-black dark surface and the white light surface (the artifacts' light block re-tints the thumb to a black-translucent overlay). Add a purpose-named `--scrollbar-thumb` / `--scrollbar-thumb-hover` pair (values ported from the artifacts) to both the `:root` and `:root[data-theme="light"]` blocks; these are consumed only by raw CSS scrollbar rules, so NO `@theme inline` Tailwind mapping is needed.
- Preserve every role / aria / `data-testid` / handler / prop on the two touched components exactly (`aria-label="Schema tables"`, `role="button"`/`aria-pressed`/`aria-expanded` tree rows, the rail toggles' `data-testid`s, the `ExposureBanner` `data-testid="exposure-banner"`, etc.). This is a skin-only change.

**Block If:**
- Removing the resting seam cannot be done without restructuring `PanelGroup`/`Panel`/`PanelResizeHandle` in a way that breaks live drag-to-resize or the persisted panel-sizes contract (`defaultSize` from `panelSizes` + `onLayout` reporting) — HALT `blocked`, condition `divider seam cannot be removed without breaking the resizable-panels behavior/persistence contract`.

**Never:**
- Never remove the `PanelResizeHandle` element itself (that would kill resize) — only remove its `bg-border` resting fill. Never change `direction`, `minSize`/`maxSize`, `defaultSize`, `onLayout`, or any `PanelGroup`/`Panel` prop.
- Never touch logic, RPC, state shape, props, or routing — presentation only. Do not edit `workspace-state.ts`, any Core/contract file, or any handler.
- Never introduce coral or any decorative/hardcoded accent color; the scrollbar thumb is a neutral grayscale translucent overlay, not an accent.
- Never remove or repaint the borders that DO match the artifacts and are out of scope: the status bar's `border-t border-border` (matches the prototype `.statusbar { border-top }`) and the `ExposureBanner`'s functional red `border-b` (a warning affordance, not a divider) both stay.
- Never rename, remove, or restyle away any test-asserted role / aria / `data-testid` on the two components.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Left region first paint | workspace loaded, schema ready | No vertical hairline between the schema panel and the content, and none between the rail and the tree; the content reads as a distinct region purely via the lighter, rounded, detached `bg-card` panel + its margin gap — matching `design-artifacts/workspace.html` | n/a |
| Drag the resize handle | pointer-drag on the `PanelResizeHandle` | The two panels still resize live; `onLayout` still fires with the new sizes; the handle may show its hover/drag accent while active, but shows NO resting seam at rest | resize/persist behavior unchanged |
| Keyboard/programmatic layout | `panelSizes` restored at mount, `onLayout` on change | `defaultSize` still seeded from `panelSizes`; every layout change still reported up (debounced save unaffected) | unchanged |
| Any vertical scroll container | schema tree overflow, content pane overflow, grid-scroll, query/chat/report bodies overflow | Custom thin neutral scrollbar: transparent track, muted translucent thumb (inset via 3px transparent border), thumb darkens on hover; no browser-default scrollbar | n/a |
| Firefox | same scroll containers in Gecko | `scrollbar-width: thin` + `scrollbar-color: <thumb> transparent` applied (inherited from `:root`), so Firefox shows the thin neutral bar too | n/a |
| Horizontal scroll (wide grid/SQL) | data grid or SQL block overflows horizontally | Same custom scrollbar applies on the horizontal axis (`::-webkit-scrollbar { height:12px }`) | n/a |
| Light theme | `data-theme="light"` set | Scrollbar thumb flips to the black-translucent overlay (via `--scrollbar-thumb` light value); no divider reappears; no coral | n/a |
| Reduced motion | `prefers-reduced-motion: reduce` | Unaffected — this change adds no animation/transition | n/a |
| Existing tests | full `bun test` suite | Roles/aria/`data-testid`s on the two components preserved; suite stays green (skin-only change) | n/a |

</intent-contract>

## Code Map

- `src/ui/styles/globals.css` -- add the app-wide custom scrollbars + their neutral token pair. (1) In the dark `:root` block, add `--scrollbar-thumb: rgba(255,255,255,0.15)` and `--scrollbar-thumb-hover: rgba(255,255,255,0.25)` (ported from the artifacts' `#ffffff26` / `#ffffff40`); in `:root[data-theme="light"]`, add `--scrollbar-thumb: rgba(0,0,0,0.15)` and `--scrollbar-thumb-hover: rgba(0,0,0,0.25)` (light re-tint, per the artifacts' `#00000026` light thumb). (2) Add the global scrollbar rules (anywhere after the token blocks, e.g. near the bottom by the `html, body, #root` rules): `::-webkit-scrollbar { width:12px; height:12px }`, `::-webkit-scrollbar-track { background:transparent }`, `::-webkit-scrollbar-thumb { background:var(--scrollbar-thumb); border-radius:7px; border:3px solid transparent; background-clip:padding-box }`, `::-webkit-scrollbar-thumb:hover { background:var(--scrollbar-thumb-hover); background-clip:padding-box }`, and the Firefox pair on the root so it cascades (both are inherited properties): `html { scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) transparent; }`. No `@theme inline` mapping — these tokens are read only by raw CSS, not by Tailwind utilities. Add NOTHING else; do not touch existing tokens. (Alternative if the team forbids new tokens: reference the existing ink overlays `--coral-soft`/`--coral-line`, which already flip dark↔light — but the purpose-named pair above is preferred for clarity and exact artifact fidelity.)
- `src/ui/workspace/Workspace.tsx` -- remove the resting divider seam on the resize handle. The line is drawn at line ~315: `<PanelResizeHandle className="w-1 bg-border transition-colors hover:bg-primary data-[resize-handle-state=drag]:bg-primary" />`. Drop the `bg-border` utility (make the handle transparent at rest, e.g. `bg-transparent`); KEEP `w-1` (the pointer hit target), `transition-colors`, and the `hover:bg-primary` / `data-[resize-handle-state=drag]:bg-primary` accents so dragging still works and still gives visual feedback. Do NOT remove the element or change any `PanelGroup`/`Panel` prop (`direction`/`defaultSize`/`minSize`/`maxSize`/`onLayout`). Leave the status bar's `border-t border-border` (line ~378) and the `ExposureBanner`'s red `border-b` (line ~174) exactly as-is — both match the artifacts / are functional, not the complained-of divider.
- `src/ui/schema/SchemaTree.tsx` -- remove the second hairline. The `<nav aria-label="Schema tables">` (line ~157) carries `... overflow-hidden border-l border-border bg-background`; delete `border-l border-border` so the rail and the tree blend into one surface (as in the artifacts' borderless `.rail`/`.side`). Keep `bg-background`, `overflow-hidden`, the `aria-label`, `style={{ fontFamily: ... }}`, and every row/role/aria/handler untouched. No other change to this file.

## Acceptance Criteria

- Given the workspace is loaded, when the shell paints, then there is NO vertical divider line between the left schema panel (tables list) and the content, and none between the rail and the tree — the content is delimited only by its lighter, rounded, detached `bg-card` panel and margin gap, matching `design-artifacts/workspace.html`.
- Given the resize handle, when it is dragged, then the two panels still resize live and `onLayout` still fires (and `defaultSize` is still seeded from `panelSizes` at mount) — resize behavior and panel-size persistence are unchanged; only the resting seam is gone.
- Given any scroll container (schema tree, content pane, data grid, query/chat/report bodies), when it overflows, then it shows the custom thin neutral scrollbar (transparent track, muted translucent thumb, hover-darkening) in both WebKit (`::-webkit-scrollbar*`) and Firefox (`scrollbar-width: thin` + `scrollbar-color`), with no browser-default scrollbar and no coral.
- Given the light theme (`data-theme="light"`), when active, then the scrollbar thumb flips to the black-translucent overlay and no divider line reappears — neither theme shows coral.
- Given a live app at `http://127.0.0.1:6061`, when inspected visually, then (a) the custom scrollbars are visibly rendered (not browser defaults), (b) there is no divider line between the schema panel and the content, and (c) dragging the panel boundary still resizes the panels.
- Given the port, when `bunx tsc --noEmit` and `bun test` run, then both stay green, and — enforced by review — no role, aria, `data-testid`, RPC, state-shape, prop, or routing change is introduced on the two touched components.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors (this change is CSS + className-only; a clean run confirms nothing structural broke).
- `bun test` -- expected: the full existing suite stays green with no assertion churn (no dedicated Workspace/SchemaTree render tests exist today; the roles/aria/`data-testid`s these components expose are load-bearing and preserved as a hard constraint).

**Manual checks (live app):**
- Launch the app and open `http://127.0.0.1:6061` against a seeded database. Compare side-by-side with `design-artifacts/workspace.html`:
  - Confirm there is NO vertical seam between the schema tree (tables list) and the content panel, and none between the icon rail and the tree — the content reads as a distinct region only via its lighter, rounded, detached card.
  - Drag the boundary between the left panel and the content and confirm the panels still resize live (and that the position persists across the debounced save / relaunch).
  - Force a scroll in the schema tree, the data grid, and a query/chat body and confirm each shows the custom thin neutral scrollbar (muted translucent thumb, transparent track, darkening on hover) — not the browser default. Verify in both a WebKit/Chromium browser and Firefox.
  - Set `document.documentElement.dataset.theme = "light"` and confirm the scrollbar thumb flips to a black-translucent overlay, no divider reappears, and there is no coral anywhere.
