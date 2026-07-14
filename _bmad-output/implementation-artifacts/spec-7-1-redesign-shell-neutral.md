---
title: 'Redesign the workspace shell to neutral — rail, tabs, schema tree, status'
type: 'refactor'
created: '2026-07-13'
status: 'done'
review_loop_iteration: 0
warnings: [oversized]
baseline_revision: '9fbc16ddc015fb0111f3a583c1f55e861e93eb7e'
final_revision: 'fba2f592711f557aadbe040193416c33f72a0f60'
followup_review_recommended: false
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
- Keep the neutral palette: near-black surfaces + ink accent. Color survives ONLY where functional — the connection dot green (`--ok`, the one token to ADD), destructive red (the existing shadcn `--destructive` token) on Stop / error states, and the schema-tree column type dots via `--t-*`. (Token reality: `globals.css` currently has NO `--ok`/`--err`/`--bg`/`--warn`; near-black surfaces are the existing shadcn `--background`/`--card`, red is `--destructive`. See the globals.css Code Map entry for exactly what to add.)
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
| Connection error / stopped | `health` error / after Stop | Status dot flips red (`--destructive`) / muted; label text unchanged; `data-testid="health"` intact; Stop still guarded against double-fire | Existing status branching preserved |
| Port exposed | `exposure.exposed` true | `ExposureBanner` (`data-testid="exposure-banner"`) still renders full-width red alert above the panel — functional red kept | No error |
| Light theme | `data-theme="light"` (or `prefers-color-scheme`) | Neutral tokens flip to the prototype's light values (white surfaces, ink accent); no coral in either mode | No error |
| Existing tests | full suite | Shell roles, aria, and testids preserved (hard constraint, not test-gated today); the full existing `bun test` suite stays green | No error |

</intent-contract>

## Code Map

- `src/ui/workspace/Workspace.tsx` -- reshape the left region and the main chrome. Turn `LauncherRail` into the prototype `.rail`: a pure-black 52px column with the `q` brand mark, **icon-only** buttons per `TabKind` (Tables/Query/ERD/Chat/Report SVGs with `title`/`aria-label` tooltips — no clipped text labels), the bottom-pinned create-table + Settings toggles as icon buttons (keep their `data-testid`s and `aria-pressed`), and a bottom `.rail-status` connection dot (green `--ok`). Replace the current `quick-studio` / `workspace` header (two `<span>`s inside the `<header>`) with the Chrome-style `.topbar` that hosts the (restyled) `TabBar`, the new-tab `+`, and a `.win` group carrying the Stop control; wrap the active-tab body in a rounded, detached `.content-panel` (`bg-background`, radius, small margin gap) and mount the neutral status bar hosting `connectionIndicator` + Stop at the bottom. Keep `PanelGroup`/`Panel`/`PanelResizeHandle`, all props, the settings/create mutually-exclusive toggles, and `ExposureBanner` exactly as-is.
- `src/ui/workspace/TabBar.tsx` -- restyle each tab into the prototype `.tab`: fixed-height rounded-top box, a per-kind leading SVG icon (`.k`), neutral color states (rest muted, hover floating grey pill, active `.on` sharing `--bg` so it fuses into the content panel), and the neutral close `×` (`.x`). Keep `role="tablist"` / `role="tab"` / `aria-selected` / `tabIndex` / `onKeyDown` (Enter/Space) / `onActivate` and the close button's `aria-label` + `onClose`/`stopPropagation` verbatim; renders `null` on zero tabs as today.
- `src/ui/schema/SchemaTree.tsx` -- restyle the tree into the prototype `.side`: a `.conn-row` header (status dot + connection name/host + mode chip), a `.side-cap` schema caption ("`engine` · N tables"), and `.tree-row` table buttons with a chevron, table icon, name, and row/column count, over expandable `.tree-children` column rows carrying type-colored `.c-ico` dots (`ty-int`/`-time`/`-bool`/`-json`/`-text`/`-pk`) and a `.c-type` label. Replace the inline `style={{ backgroundColor: "var(--coral-soft)", color: "var(--coral)" }}` active/hover highlight with the neutral Tailwind utilities (`bg-coral-soft` / `text-coral` — ink — and `bg-muted` on hover). Keep `role="button"` / `tabIndex=0` / `aria-pressed` / Enter-Space activation, `onActivate`, `onSchemaLoaded`, `mergeTables`, the `connect` fetch, and the `role="alert"` error branch untouched.
- `src/ui/App.tsx` -- restyle `ConnectionIndicator` into the neutral status look (prototype `.statusbar .seg` / `.rail-status` dot): neutral surface + mono segment text, green `--ok` dot when `ok`, red `--destructive` when `error`, muted when `stopped`/`loading`. Keep `data-testid="health"`, the `title`/`label` text, and every effect (`callHealth`/`callShutdown`, `workspace.load`/`save`, debounced save, PK/index memos, `onStop` guard) and all props passed to `Workspace` exactly as-is — App's shell wrapper and reducer are not touched.
- `src/ui/styles/globals.css` (supporting) -- token reality (verified): the shell's surface system is the existing **shadcn** tokens (`--background`, `--card`, `--muted`, `--border`, `--accent`, `--primary`, `--destructive`) — the prototype's near-black `--bg`/`--bg-deep`/rail map onto these already-present near-black surfaces, so **no new surface tokens are needed** and destructive red reuses the existing `--destructive`. The ONE thing missing is the green connection-status pair: **add `--ok` and `--ok-soft`** (green, matching `design-artifacts/workspace.html`) plus their `@theme inline` utility maps (e.g. `text-ok` / `bg-ok` / `bg-ok-soft`) for both dark and light `:root` blocks. Leave `--coral` (= ink `#ececec`), `--coral-soft/-line`, and the `--t-*` data-type tokens exactly as they already are. No coral value is introduced or changed. (Anywhere this spec's intent-contract says `--err`, use `--destructive`; anywhere it says `--bg`, use the existing `--background`/`--card`.)

## Acceptance Criteria

- Given the workspace loads connected, when the shell paints, then the rail (icon-only, no clipped text), the Chrome-style tab strip, the schema tree, and the status bar match `design-artifacts/workspace.html` + `design-artifacts/ai-chat-chatgpt.html` in structure, spacing, iconography, type scale, and neutral palette — near-black surfaces, ink accent, no coral.
- Given a table in the schema tree, when it is activated by click or Enter/Space, then exactly one row shows the neutral ink active highlight (`bg-coral-soft` + `text-coral`) and `onActivate` fires with the identical `SchemaTableInfo` — behavior unchanged.
- Given the connection state, when it is ok / error / stopped, then the status dot is green / red / muted respectively, the label text is unchanged, and `data-testid="health"` is still present.
- Given the light theme, when it is active, then the shell flips to the prototype's light neutral values (white surfaces, ink accent) with no coral in either mode.
- Given the full test suite, when run, then `bunx tsc --noEmit` is clean and the existing `bun test` suite stays green, and — enforced by review, not by a dedicated test today — no role, aria, `data-testid`, RPC, state-shape, or routing change is introduced on the four shell components.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors across the four touched UI components (not wired as an npm script; run directly).
- `bun test` -- expected: the full existing suite stays green. Note: there are currently **no dedicated TabBar/SchemaTree/App/Workspace test files** — the roles/aria/`data-testid`s these components expose are load-bearing for a11y and MUST be preserved as a hard constraint, but they are not directly asserted by a test today. Existing UI/model suites that MUST stay green include `ChatTabView`, `QueryTabView`, `ErdTabView`, `ReportTabView`, `ConfirmRun`, `IndexList`, `SandboxFrame`, and the `workspace-state` / other `*.test.ts` model tests.

**Manual checks (if no CLI):**
- Launch the app against a seeded database and compare side-by-side with `design-artifacts/workspace.html`: the icon rail shows tooltipped icons (no clipped text); tabs render Chrome-style with the active tab fused into a rounded content panel; the schema tree shows the connection-status row, schema caption, table rows, and type-colored column dots (expand a table row to reveal them); the neutral status bar sits at the bottom hosting the authoritative connection indicator (green dot when connected) + Stop. Set `document.documentElement.dataset.theme = "light"` and confirm the shell flips to the prototype's light values. Confirm no coral anywhere.

## Review Triage Log

### 2026-07-14 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 1
- reject: 16
- addressed_findings:
  - `[low]` `[patch]` `typeDotClass`'s anchored `\bint` test mis-bucketed the prefixed integer families (`bigint`/`smallint`/`mediumint`/`tinyint`, `bigserial`/`smallserial`) into the generic `text` dot — broadened to `/\bint|serial|(?:big|small|medium|tiny)int/`, kept ordered after the `time|date|interval` and `bool` tests so `interval` is still caught by `time` and `point` stays out of the int bucket.
  - `[low]` `[patch]` `LauncherRail` docstring still promised a "bottom connection-status dot" the earlier pass had already removed — corrected the doc to point at the status bar as the authoritative connection status.
  - `[low]` `[patch]` `TabBar` docstring described decorative radial-gradient "foot" sibling elements that were never shipped (the earlier pass dropped them) — rewrote it to describe the actual `bg-card` + `-mb-px` active-tab fusion.
- deferred: DW-54 — the shell's destructive/error reds (`text-red-400`/`bg-red-500`) are dark-tuned and do not flip under `:root[data-theme="light"]`, so they read low-contrast on the new light theme (latent: light has no toggle UI yet; tokenize when the light theme is completed across Epic 7).
- rejected (16): additive `aria-expanded` on the disclosure row (spec-required disclosure feature; the "Never" rule forbids removing/renaming existing aria, not adding — and the attribute value is truthful); the re-activate-to-collapse-a-non-active-row nuance and disclosure-coupled-to-activation (both intentional prior-pass design, aria stays accurate); the new-tab `+` control (spec-required Code Map element; already rejected 1st pass); the schema-tree `.conn-row` as a "second connection indicator" and its engine/caption overlap (spec-mandated conn-row; name/host/mode data unavailable client-side — documented residual risk); the amber `--t-bool` column dot (spec-sanctioned `--t-*` functional-color exception); the `coral`→ink token naming (spec explicitly says leave the coral token names as-is); `loading`≡`stopped` muted dot and the persistent-red Stop (both spec-matching; already rejected 1st pass); the removed `quick-studio`/`workspace` header text (spec-mandated replacement, a11y name preserved via prior brand `role="img"` patch); the un-pruned session-only `expanded` Set, dotted-identifier `<li>` key collision, and zero-column phantom-key churn (all negligible session-only state; already rejected 1st pass); `numeric`/`float` sharing the `t-json` dot (no dedicated numeric bucket in the fixed `--t-*` palette; cosmetic, no correct answer); the light-theme block as "dead code" (spec-required AC, reachable via explicit `data-theme="light"`).

### 2026-07-14 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 3, low 4)
- defer: 1
- reject: 4
- addressed_findings:
  - `[medium]` `[patch]` Light theme auto-activated app-wide via `@media (prefers-color-scheme: light)` while Epic 7 is mid-flight (only the shell is neutral so far) — removed the OS-preference auto-activation block from `globals.css`; light stays available via explicit `data-theme="light"`.
  - `[medium]` `[patch]` SchemaTree conflated table activation with column disclosure (re-clicking the active row silently collapsed it) and exposed no disclosure state — activation now always expands a newly-selected table and only toggles when re-activating the already-active row; added `aria-expanded` to the row and gated the chevron on `columns.length > 0`.
  - `[medium]` `[patch]` The rail's bottom connection dot was hardcoded green regardless of real status (misleading, since `Workspace` only receives the indicator as an opaque node and a status prop is disallowed) — removed the decorative rail dot; the authoritative text-bearing indicator already lives in the status bar.
  - `[low]` `[patch]` `typeDotClass` matched `interval` (and any name containing the substring `int`) as an integer — reordered so `time|date|interval` and `bool` are tested before an anchored `\bint` check.
  - `[low]` `[patch]` TabBar's `overflow-x-auto overflow-y-visible` computes `overflow-y` to `auto`, clipping the active-tab fusion and the concave "feet" — dropped `overflow-y-visible` and removed the fragile decorative feet; the active tab still fuses via matching `bg-card` + `-mb-px`.
  - `[low]` `[patch]` The workspace name was dropped from accessible content (the new brand mark was an `aria-hidden` `q` glyph with only a `title` on a non-interactive div) — gave the brand `role="img"` + `aria-label="quick-studio"`.
  - `[low]` `[patch]` The relocated status-bar Stop button lost its disabled-hover neutralizer, so the red hover tint could flash on a disabled control — added `disabled:hover:bg-transparent`.
- deferred: DW-53 — no dedicated component tests exercise the shell (`Workspace`/`TabBar`/`SchemaTree`/`App`), so the redesign's roles/aria/testids ship without a regression net (pre-existing gap, documented in Verification).
- rejected (4): new-tab `+` control (explicitly required by the spec Code Map); `loading`≡`stopped` muted dot (matches the spec's "muted when stopped/loading"); un-pruned session-only `expanded` set / dotted-identifier key collision (negligible, and the `<li key>` pattern is pre-existing); empty-`engine`-string conn-row label (engine is always populated).

## Auto Run Result

Status: done

### Summary
Ported the neutral / ChatGPT-style look from the `design-artifacts/*.html` prototypes onto the four workspace-shell components — presentation only. The launcher became a pure icon rail (brand mark + tooltipped icon-only kind buttons + bottom-pinned create/settings toggles), `TabBar` became Chrome-style rounded-top tabs fusing into a detached rounded content panel, `SchemaTree` gained a connection-status row + in-place expandable type-colored column rows, and `ConnectionIndicator` became a neutral bottom status-bar segment. Added the one missing functional token (`--ok`/`--ok-soft` green) and an explicit `data-theme="light"` token set. No logic, RPC, state-shape, prop, or routing changed; every ARIA role, `aria-*`, keyboard handler, and `data-testid` was preserved; no coral hex introduced.

### Files changed
- `src/ui/workspace/Workspace.tsx` — icon rail, Chrome topbar + new-tab `+`, detached rounded content panel, bottom status bar hosting the connection indicator + Stop; `ExposureBanner` and `PanelGroup` layout preserved.
- `src/ui/workspace/TabBar.tsx` — Chrome-style rounded-top tabs with per-kind leading icons; active tab fuses via `bg-card` + `-mb-px`; roles/close-button contract preserved.
- `src/ui/schema/SchemaTree.tsx` — neutral `.side` tree: connection-status row, expandable type-colored column rows (`aria-expanded`), neutral ink active highlight; RPC/roles/error branch preserved.
- `src/ui/App.tsx` — `ConnectionIndicator` restyled to a neutral mono status segment (green/red/muted dot); effects/props/`data-testid="health"` preserved.
- `src/ui/styles/globals.css` — added `--ok`/`--ok-soft` (+ `@theme inline` maps) and a `:root[data-theme="light"]` token block; dark defaults untouched.

### Review findings breakdown
- Patches applied: 7 (3 medium, 4 low) — light-theme scope reduction, disclosure semantics + a11y, misleading rail dot removed, type-dot classification, tab-overflow fusion, brand a11y name, Stop disabled-hover.
- Deferred: 1 (DW-53 — no shell component tests).
- Rejected: 4 (spec-required or spec-matching or negligible).

### Verification performed
- `bunx tsc --noEmit` — clean.
- `bun test` — 1031 pass / 0 fail (2544 assertions, 67 files), unchanged from baseline.
- Grep-confirmed all preserved roles/aria/`data-testid`s intact and no coral/orange hex introduced.

### Residual risks
- Visual fidelity to the prototypes was not verified by a live render (no CLI screenshot in this run) — the port is code-faithful but a side-by-side visual pass is recommended.
- Light theme is reachable only via an explicit `data-theme="light"` (no toggle UI exists yet); OS-preference auto-activation was intentionally deferred until the rest of Epic 7's surfaces are neutralized.
- The schema-tree connection row shows only engine/phase (connection name/host/mode chip need data not available client-side without a new RPC — out of scope for a presentation-only pass).

### Follow-up review pass (2026-07-14)

An independent follow-up review (Blind Hunter + Edge Case Hunter, no prior context) ran against the full `9fbc16d..16165bb` shell diff. It surfaced 20 deduped findings; triage: **3 low patches applied, 1 deferred, 16 rejected** (0 intent_gap, 0 bad_spec — no spec amendment or re-implementation loopback).

- **Patches applied (all low, all in the new presentation code):**
  - `typeDotClass` broadened so prefixed integer families (`bigint`/`smallint`/`bigserial`/…) get the int-type column dot instead of falling through to the generic text dot.
  - `LauncherRail` docstring corrected (dropped the stale "bottom connection-status dot" that a prior pass had removed).
  - `TabBar` docstring corrected (removed the description of decorative "foot" elements that were never shipped; describes the real `bg-card` + `-mb-px` fusion).
- **Deferred:** DW-54 — light-theme destructive/error reds are dark-tuned and do not flip under `data-theme="light"`; tokenize when the light theme is completed across Epic 7.
- **Rejected (16):** spec-required elements (disclosure `aria-expanded`, new-tab `+`, `.conn-row`, light-theme block, header replacement), spec-sanctioned functional color (`--t-bool` dot, red Stop, muted loading≡stopped), spec-mandated token naming (`coral`→ink), and negligible session-only state churn (un-pruned `expanded` Set, dotted-key collision, zero-column phantom key). See the Review Triage Log for the itemized rationale.
- **Verification:** `bunx tsc --noEmit` clean; `bun test` → 1031 pass / 0 fail (2544 assertions, 67 files) — unchanged from baseline.
- **Follow-up review recommendation:** `false` — this pass made only a few localized, low-consequence fixes (two doc-comment corrections + one type-color regex fix) with no behavior/API/a11y/security/data impact; the shell has now had two independent review passes.
