---
title: 'Redesign the workspace shell to neutral — rail, tabs, schema tree, status'
type: 'refactor'
created: '2026-07-13'
status: 'backlog'
context:
  - '{project-root}/design-artifacts/workspace.html'
  - '{project-root}/design-artifacts/ai-chat-chatgpt.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
---

<intent-contract>

## Intent

**Problem:** The workspace shell (icon rail, tab strip, schema tree, connection/status area) still wears the old Epic-3 coral/monospace spine: a 52px launcher rail with clipped text labels ("New table", "New query"), a flat `border-b` tab strip, a schema tree whose active row hardcodes `var(--coral)`/`var(--coral-soft)`, and a `quick-studio · workspace` header pill instead of a real status bar. The Epic-7 pivot moves the whole product to a neutral, ChatGPT-style look — near-black surfaces, an ink (white/black) accent, no coral — and the shell is the first and most visible surface that must match it. Nothing about the shell's *behavior* is wrong; only its skin is off-brand.

**Approach:** Port the neutral shell look from the prototypes onto the four existing shell components — presentation only. Reshape the launcher into the prototype's compact pure-black **icon rail** (brand mark + icon-only tab-kind buttons with tooltips, no clipped text, bottom-pinned Settings/create controls, and a bottom connection-status dot); restyle `TabBar` into the **Chrome-style tab strip** (rounded-top tabs, per-kind leading icon, active tab fused into the content panel); restyle `SchemaTree` into the neutral **schema sub-sidebar + tree** (connection row, schema caption, table rows with chevron/table-icon/row-count, type-colored column dots); and restyle the connection indicator into the neutral **status bar**. All markup keeps its ARIA roles, labels, `data-testid`s, event handlers, RPC calls, reducer/state shapes, and routing exactly as-is, so every passing test stays green. Colors come from `globals.css` tokens / Tailwind utilities (`bg-background`, `text-coral` — now ink — `bg-coral-soft`, `text-t-int/-time/-bool/-json/-text`, `font-mono`); no coral hex is ever written. The `design-artifacts/*.html` prototypes are the visual source of truth and SUPERSEDE any coral rule still worded in DESIGN.md / EXPERIENCE.md.

## Boundaries & Constraints

**Always:**
- Match the prototype's structure, spacing, iconography, and type scale for all four shell surfaces: the pure-black icon rail (`design-artifacts/workspace.html` `.rail`), the Chrome-style tab strip (`.topbar`/`.tab`/`.tab.on` with concave feet, shared with `ai-chat-chatgpt.html`), the schema sub-sidebar + tree (`.side`/`.conn-row`/`.tree-row`/`.col-row`), and the bottom status bar (`.statusbar`).
- Consume `src/ui/styles/globals.css` tokens and their Tailwind utilities only — `bg-background`/`bg-card`, `text-coral` / `bg-coral-soft` / `border-coral-line` (all resolve to ink now), the data-type utilities `text-t-int`/`-t-time`/`-t-bool`/`-t-json`/`-t-text`/`-t-key`, and `font-mono`. Never hardcode a coral/orange hex.
- Keep the neutral palette: near-black surfaces + ink accent. Color survives ONLY where functional — the connection dot green (`--ok`), destructive red (`--err`) on Stop / error states, and the schema-tree column type dots via `--t-*`.
- Preserve every component's behavior verbatim: props and their shapes, the `connect` / `health` / `shutdown` / `workspace.load` / `workspace.save` RPC calls, the `useReducer` workspace model, tab open/close/activate, table activation, keyboard operability, and the resizable `PanelGroup`/`Panel` layout.
- Keep every test-asserted hook intact: `role="tablist"` / `role="tab"` / `aria-selected` on tabs and their close-button `aria-label`; `role="button"` / `tabIndex=0` / `aria-pressed` / `aria-label="Schema tables"` and Enter/Space activation on tree rows; and `data-testid="health"` / `"settings-toggle"` / `"create-table-toggle"` / `"exposure-banner"`.

**Block If:**
- The Chrome-tab concave-feet / active-fuse look cannot be expressed without restructuring `TabBar`'s DOM in a way that breaks the `role="tab"` / `aria-selected` / close-button-`aria-label` contract the tests assert — HALT `blocked`, condition `tab chrome cannot be styled without breaking the tab a11y/test contract`.

**Never:**
- No logic, RPC, state-shape, prop, or routing changes — this is presentation only. Do not touch `workspace-state.ts`, `chat-model.ts`, `report-state.ts`, or any Core/contract file.
- No coral: no coral/orange hex, no revival of the old `--coral` *color value*, no coral-tinted chrome anywhere. The accent is ink.
- No new colored chrome beyond the functional `--ok` / `--warn` / `--err` + `--t-*` exceptions — the shell reads neutral.
- Do not rename, remove, or restyle away any test-asserted role / aria / `data-testid`; do not drop the resizable `PanelGroup` layout or the `ExposureBanner`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Shell first paint (connected) | Workspace loaded, `health` ok | Pure-black icon rail (brand mark + icon-only kind buttons + bottom status dot), Chrome-style tab strip, neutral schema tree, and status bar render per prototype; connection dot green (`--ok`) | No error expected |
| Active tab | one tab active | Exactly one `.tab.on`, fused into the rounded content panel via `--bg`; content panel is a detached rounded card; keyboard activation (Enter/Space) unchanged | No error |
| Schema-tree table activation | click or Enter/Space on a table row | Row shows single active highlight via `bg-coral-soft` + `text-coral` (ink), `onActivate` fires with the same `SchemaTableInfo`; one `.on` at a time | No error |
| Column rows | expandable table node | Column rows render with type-colored `--t-*` dots (int/time/bool/json/text) and PK via ink `--t-key`; text mono | No error |
| Schema load error | `connect` reply `!ok` or `status:"failed"` | In-panel `role="alert"` message still shown, neutral styling (red text only) — never console-only | Existing envelope text preserved |
| Loading / no tables | schema pending or 0 tables | "loading schema…" / "no tables" empty states render neutral (muted mono), no coral | No error |
| Close tab | × click or keyboard | `onClose(id)` fires unchanged; strip re-renders; close control keeps its `aria-label` | No error |
| Connection error / stopped | `health` error / after Stop | Status dot flips red (`--err`) / muted; label text unchanged; `data-testid="health"` intact; Stop still guarded against double-fire | Existing status branching preserved |
| Port exposed | `exposure.exposed` true | `ExposureBanner` (`data-testid="exposure-banner"`) still renders full-width red alert above the panel — functional red kept | No error |
| Light theme | `data-theme="light"` (or `prefers-color-scheme`) | Neutral tokens flip to the prototype's light values (white surfaces, ink accent); no coral in either mode | No error |
| Existing tests | full suite | TabBar / SchemaTree / App roles, aria, and testids unchanged → `bun test` stays green | No error |

</intent-contract>

## Code Map

- `src/ui/workspace/Workspace.tsx` -- reshape the left region and the main chrome. Turn `LauncherRail` into the prototype `.rail`: a pure-black 52px column with the `q` brand mark, **icon-only** buttons per `TabKind` (Tables/Query/ERD/Chat/Report SVGs with `title`/`aria-label` tooltips — no clipped text labels), the bottom-pinned create-table + Settings toggles as icon buttons (keep their `data-testid`s and `aria-pressed`), and a bottom `.rail-status` connection dot (green `--ok`). Replace the `quick-studio · workspace` `<header>` with the Chrome-style `.topbar` that hosts the (restyled) `TabBar`, the new-tab `+`, and a `.win` group carrying the Stop control; wrap the active-tab body in a rounded, detached `.content-panel` (`bg-background`, radius, small margin gap) and mount the neutral status bar hosting `connectionIndicator` + Stop at the bottom. Keep `PanelGroup`/`Panel`/`PanelResizeHandle`, all props, the settings/create mutually-exclusive toggles, and `ExposureBanner` exactly as-is.
- `src/ui/workspace/TabBar.tsx` -- restyle each tab into the prototype `.tab`: fixed-height rounded-top box, a per-kind leading SVG icon (`.k`), neutral color states (rest muted, hover floating grey pill, active `.on` sharing `--bg` so it fuses into the content panel), and the neutral close `×` (`.x`). Keep `role="tablist"` / `role="tab"` / `aria-selected` / `tabIndex` / `onKeyDown` (Enter/Space) / `onActivate` and the close button's `aria-label` + `onClose`/`stopPropagation` verbatim; renders `null` on zero tabs as today.
- `src/ui/schema/SchemaTree.tsx` -- restyle the tree into the prototype `.side`: a `.conn-row` header (status dot + connection name/host + mode chip), a `.side-cap` schema caption ("`engine` · N tables"), and `.tree-row` table buttons with a chevron, table icon, name, and row/column count, over expandable `.tree-children` column rows carrying type-colored `.c-ico` dots (`ty-int`/`-time`/`-bool`/`-json`/`-text`/`-pk`) and a `.c-type` label. Replace the inline `style={{ backgroundColor: "var(--coral-soft)", color: "var(--coral)" }}` active/hover highlight with the neutral Tailwind utilities (`bg-coral-soft` / `text-coral` — ink — and `bg-muted` on hover). Keep `role="button"` / `tabIndex=0` / `aria-pressed` / Enter-Space activation, `onActivate`, `onSchemaLoaded`, `mergeTables`, the `connect` fetch, and the `role="alert"` error branch untouched.
- `src/ui/App.tsx` -- restyle `ConnectionIndicator` into the neutral status look (prototype `.statusbar .seg` / `.rail-status` dot): neutral surface + mono segment text, green `--ok` dot when `ok`, red `--err` when `error`, muted when `stopped`/`loading`. Keep `data-testid="health"`, the `title`/`label` text, and every effect (`callHealth`/`callShutdown`, `workspace.load`/`save`, debounced save, PK/index memos, `onStop` guard) and all props passed to `Workspace` exactly as-is — App's shell wrapper and reducer are not touched.
- `src/ui/styles/globals.css` (supporting) -- if the shell surfaces the prototype needs are not already present, add ONLY the neutral shell tokens + their `@theme inline` utility maps: near-black surfaces (`--bg`/`--bg-deep`/rail) and the functional connection-status pair `--ok` / `--ok-soft` (green), matching `design-artifacts/workspace.html`. Leave `--coral` (= ink `#ececec`), `--coral-soft/-line`, and the `--t-*` data-type tokens as they already are. No coral value is introduced or changed.

## Acceptance Criteria

- Given the workspace loads connected, when the shell paints, then the rail (icon-only, no clipped text), the Chrome-style tab strip, the schema tree, and the status bar match `design-artifacts/workspace.html` + `design-artifacts/ai-chat-chatgpt.html` in structure, spacing, iconography, type scale, and neutral palette — near-black surfaces, ink accent, no coral.
- Given a table in the schema tree, when it is activated by click or Enter/Space, then exactly one row shows the neutral ink active highlight (`bg-coral-soft` + `text-coral`) and `onActivate` fires with the identical `SchemaTableInfo` — behavior unchanged.
- Given the connection state, when it is ok / error / stopped, then the status dot is green / red / muted respectively, the label text is unchanged, and `data-testid="health"` is still present.
- Given the light theme, when it is active, then the shell flips to the prototype's light neutral values (white surfaces, ink accent) with no coral in either mode.
- Given the full test suite, when run, then `bunx tsc --noEmit` is clean and `bun test` stays green — no role, aria, `data-testid`, RPC, state-shape, or routing change.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors across the four touched UI components.
- `bun test` -- expected: all suites pass, including the existing TabBar / SchemaTree / App / workspace-state tests (unchanged roles, aria, testids).

**Manual checks (if no CLI):**
- Launch the app against a seeded database and compare side-by-side with `design-artifacts/workspace.html`: the icon rail shows tooltipped icons (no clipped text) with a green connection dot; tabs render Chrome-style with the active tab fused into a rounded content panel; the schema tree shows the connection row, schema caption, table rows, and type-colored column dots; the status bar sits at the bottom. Toggle the theme and confirm the light look matches the prototype. Confirm no coral anywhere.
