---
title: 'Story 1.4 — Workspace shell: open/close Tabs and resizable Panels'
type: 'feature'
created: '2026-07-06'
status: 'done'
baseline_revision: '0b218891c38f5afa389aaa391cfc73e784779568'
final_revision: '9a15e932ae8bb1bb46b06b1f8ed6d8a50db94732'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The UI is still the walking-skeleton health page. Every later feature (table browsing, queries, ERDs, chat, reports) needs a Workspace surface that holds many pieces of work at once, but no Tabs/Panels shell or dark-first shadcn theming exists yet (both were deliberately deferred from 1.1 to this story).

**Approach:** Build the in-memory Workspace shell in the UI ring: a resizable two-Panel layout (a launcher sidebar and a main area) whose main area holds openable/closable document Tabs of five kinds (table, query, erd, chat, report). Drive the Tab set from a dependency-free, unit-tested pure state model. Establish the shadcn-convention dark-first design tokens via Tailwind v4, and extend the Core's UI bundler to also emit and serve the stylesheet. Keep the existing authenticated `health` channel live as a connection indicator.

## Boundaries & Constraints

**Always:**
- Ephemeral: all Workspace state (open Tabs, active Tab, Panel sizes) lives in React memory only. Nothing is persisted — no `localStorage`/`sessionStorage`, no disk writes. Restore-on-launch is Epic 2.
- Dark-first, restrained shadcn aesthetic expressed as design tokens (CSS custom properties: `--background`, `--foreground`, `--card`, `--border`, `--muted`, `--muted-foreground`, `--primary`, `--accent`, `--radius`), via Tailwind CSS v4.
- Resizable Panels use `react-resizable-panels` (the primitive shadcn's `resizable` wraps): a `PanelGroup` with a draggable `PanelResizeHandle`.
- Closing one Tab never mutates any other Tab; the others stay open and intact (FR-23).
- Module files kebab-case; React components PascalCase; explicit `.ts`/`.tsx` import extensions; `import type` for type-only imports (verbatimModuleSyntax); respect `noUncheckedIndexedAccess`.
- The shell still completes the token-gated `health` RPC on boot and surfaces a connection indicator, proving the authenticated channel from 1.1 is intact.

**Block If:**
- Tailwind CSS v4 cannot be integrated into the existing `Bun.build` UI pipeline in this environment (e.g. no installable `bun-plugin-tailwind` compatible with the installed Bun) — the shadcn/Tailwind foundation is a mandated stack decision, not one to silently swap.
- No `react-resizable-panels` release compatible with React 19 is installable.

**Never:**
- No persistence of layout/Tab/session state of any kind (Ephemeral).
- No real Tab content: table rows (Epic 3), ERD rendering (Epic 4), chat/report (Epic 5/6) are out of scope — Tab bodies are labelled shell placeholders only.
- No new Core RPCs, DB/driver, auth, or shared-contract changes beyond serving the stylesheet. Do not widen the UI ring's powers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open a Tab | `openTab(state, kind)` | new Tab appended with unique id + kind; it becomes active | No error expected |
| Open several same-kind Tabs | repeated `openTab(state,'table')` | each call yields a distinct Tab (multiple tables coexist) | No error expected |
| Close a non-active Tab | `closeTab(state, id)`, `id !== activeTabId` | that Tab removed; `activeTabId` unchanged; all others intact | Unknown id → state returned unchanged |
| Close the active Tab | `closeTab(state, activeTabId)` with siblings | Tab removed; active becomes the nearest remaining sibling | No error expected |
| Close the last Tab | `closeTab(state, onlyId)` | empty Tab set; `activeTabId === null`; shell shows empty state | No error expected |

</intent-contract>

## Code Map

- `package.json` -- add deps `tailwindcss@^4` + `react-resizable-panels` (React 19-compatible), devDep `bun-plugin-tailwind`
- `src/ui/styles/globals.css` -- `@import "tailwindcss";` + shadcn-convention dark-first tokens (`:root` CSS vars + Tailwind v4 `@theme inline` mapping) + base body background/foreground
- `src/ui/main.tsx` -- import `./styles/globals.css` so the bundler emits the stylesheet
- `src/ui/workspace/workspace-state.ts` -- dependency-free model: `TabKind`, `WorkspaceTab`, `WorkspaceState`, `emptyWorkspace()`, `openTab`, `closeTab`, `activateTab` (pure functions)
- `src/ui/workspace/workspace-state.test.ts` -- `bun:test` unit tests for the I/O matrix (open/close/activate + close-active-sibling + close-last)
- `src/ui/workspace/Workspace.tsx` -- shell: horizontal `PanelGroup` (launcher sidebar Panel + main Panel) with a `PanelResizeHandle`; composes the launcher rail, `TabBar`, `TabContent`, connection indicator
- `src/ui/workspace/TabBar.tsx` -- renders open Tabs with active styling and a per-Tab close control; hidden/empty when no Tabs
- `src/ui/workspace/TabContent.tsx` -- renders the active Tab's placeholder body per kind; empty-state when `activeTabId === null`
- `src/ui/App.tsx` -- shell root: `useReducer`/state over `workspace-state`, opens Tabs from the sidebar, still runs the authenticated `health` call for the connection indicator
- `src/core/server.ts` -- `buildUiBundle` emits JS **and** CSS (Tailwind plugin + read both `Bun.build` outputs); add `GET /app.css` route (`content-type: text/css`, `nosniff`); add `<link rel="stylesheet" href="/app.css">` to `renderIndexHtml`

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- add `tailwindcss@^4`, `react-resizable-panels` (React 19 compatible), and devDep `bun-plugin-tailwind`; run `bun install` -- styling + resizable foundation
- [x] `src/ui/styles/globals.css` -- Tailwind v4 entry + dark-first shadcn design tokens (CSS custom properties) + base surface styles -- UX-DR1 aesthetic
- [x] `src/ui/workspace/workspace-state.ts` -- pure Tab model with `openTab`/`closeTab`/`activateTab`, close-active-picks-nearest-sibling, unique ids -- FR-23 core, testable in isolation
- [x] `src/ui/workspace/workspace-state.test.ts` -- unit-test every I/O-matrix row (no DOM) -- locks FR-23 behavior
- [x] `src/ui/workspace/Workspace.tsx` -- resizable `PanelGroup` (sidebar + main), launcher buttons that `openTab` each of the five kinds, `PanelResizeHandle` divider -- FR-24 + AC open path
- [x] `src/ui/workspace/TabBar.tsx` -- open-Tab strip with active highlight + per-Tab close button wired to `closeTab` -- FR-23 UI
- [x] `src/ui/workspace/TabContent.tsx` -- placeholder body per Tab kind; empty-state when no active Tab -- shell surface
- [x] `src/ui/main.tsx` -- import `globals.css` so the bundler emits the stylesheet -- wire CSS into the bundle
- [x] `src/ui/App.tsx` -- host Workspace state, render `Workspace`, keep the token-gated `health` call feeding a connection indicator -- preserves 1.1 channel
- [x] `src/core/server.ts` -- extend `buildUiBundle` to produce+return JS and CSS; serve `GET /app.css`; link the stylesheet in the served HTML -- deliver theming to the browser

**Acceptance Criteria:**
- Given the Workspace is open, when I open Tabs for a table, a query, an ERD, a chat, and a report from the sidebar, then five Tabs are open at once and closing any one leaves the rest open and unchanged (FR-23).
- Given the two-Panel layout, when I drag the Panel divider, then the Panels resize live and the layout reflows (FR-24; restore-on-launch is Epic 2).
- Given the running shell, when it loads in the browser, then it renders in a dark-first shadcn aesthetic and the connection indicator shows the authenticated `health` result — confirming the token-gated channel still works (UX-DR1).
- Given `bun test`, when it runs, then the `workspace-state` model passes every I/O-matrix case with no browser in the loop, and `bun x tsc --noEmit` is clean under strict.

## Spec Change Log

## Review Triage Log

### 2026-07-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 0
- reject: 7
- addressed_findings:
  - `[medium]` `[patch]` `TabBar` close button was keyboard-dead: its Enter/Space keydown bubbled to the parent `role="tab"` div, whose handler called `preventDefault()` + re-activated the tab, so a tab could never be closed via keyboard. Guarded the parent `onKeyDown` with `if (e.target !== e.currentTarget) return;` so keys on the nested button reach its native Enter/Space→click (which closes). Mouse close already worked.
  - `[low]` `[patch]` Duplicate Tab titles: `openTab` derived the per-kind ordinal from the current live count (`filter(kind).length + 1`), so open Table→Table, close "Table 1", open Table produced a second "Table 2" (and a duplicate `aria-label`). Title now suffixes the tab's unique monotonic `id`, which is never reused. Added a regression unit test.
  - `[low]` `[patch]` `buildUiBundle` selected the JS artifact by first `.endsWith(".js")` match; now prefers `kind === "entry-point"` (extension fallback retained) so it stays correct if code-splitting ever emits extra `.js` chunks. Latent today (single entrypoint).

## Design Notes

- **Pure state model.** `workspace-state.ts` owns all Tab logic as pure functions so FR-23 is unit-tested without a DOM (the project has no React test harness and adding one is out of scope). React holds the state via `useReducer`/`useState` and calls these helpers. Tab ids are a monotonically increasing counter carried in state (no `Math.random`/`Date.now`, which are unavailable/nondeterministic) — e.g. `nextId` field incremented on each `openTab`.
- **Close-active heuristic:** when the active Tab closes, activate the Tab at the same index if one remains, else the new last Tab, else `null`.
- **CSS through Bun.build:** `main.tsx` importing `globals.css` makes `Bun.build` emit a CSS artifact; select outputs by kind/extension (JS entry vs `.css` asset) rather than `outputs[0]`, return both from `buildUiBundle`, and serve `/app.css` mirroring the `/app.js` handler. Keep `no-store`/`nosniff` consistent with the existing HTML/JS responses.
- **Tabs are documents, not Radix tabs:** a document-tab workspace (dynamic, closable, multiple of one kind) is hand-rolled; Radix `Tabs` models a fixed switcher and does not fit.

## Verification

**Commands:**
- `bun install` -- expected: `tailwindcss`, `react-resizable-panels`, `bun-plugin-tailwind` resolve with no errors
- `bun test` -- expected: new `workspace-state` tests pass alongside the existing suite (0 fail)
- `bun x tsc --noEmit` -- expected: clean under strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`)

**Manual checks:**
- `bun run bin/quick-studio.ts`, open the served `http://127.0.0.1:<port>` URL: the shell renders dark-first; the connection indicator shows `health` ok. From the sidebar open a table, query, ERD, chat, and report → five Tabs open at once. Close a middle Tab → the others remain; close the active Tab → a sibling activates; close all → empty state. Drag the Panel divider → Panels resize smoothly. Interactions feel instant (<100ms).

## Auto Run Result

Status: done

### Summary
Built the in-memory Workspace shell in the UI ring (Ring 2). A horizontal `react-resizable-panels` `PanelGroup` splits a launcher sidebar Panel from the main area (draggable `PanelResizeHandle` = FR-24). The main area holds openable/closable document Tabs of five kinds (table, query, erd, chat, report), driven by a dependency-free, unit-tested pure state model (`workspace-state.ts`): open appends a distinct active Tab; closing the active Tab activates the nearest remaining sibling; closing never mutates other Tabs (FR-23). Established the dark-first shadcn-convention theming via Tailwind CSS v4 (design tokens as CSS custom properties), extended the Core UI bundler to emit and serve the stylesheet at `GET /app.css`, and kept the story-1.1 authenticated `health` channel live as a connection indicator (UX-DR1). Ephemeral — no state is persisted.

### Files changed
- `src/ui/workspace/workspace-state.ts` — pure Tab model (`TabKind`, `WorkspaceTab`, `WorkspaceState`, `emptyWorkspace`/`openTab`/`closeTab`/`activateTab`); monotonic ids, close-active-picks-sibling, unknown-id no-op.
- `src/ui/workspace/workspace-state.test.ts` — 15 `bun:test` cases covering every I/O-matrix row + immutability + unique-title regression.
- `src/ui/workspace/Workspace.tsx` — resizable `PanelGroup` (sidebar + main), launcher rail opening all 5 kinds, connection indicator.
- `src/ui/workspace/TabBar.tsx` — open-Tab strip, active highlight, per-Tab close control (mouse + keyboard).
- `src/ui/workspace/TabContent.tsx` — labelled placeholder body per kind; empty-state when no active Tab.
- `src/ui/styles/globals.css` — Tailwind v4 entry + dark-first shadcn design tokens + base surface.
- `src/ui/App.tsx` — shell root: `useReducer` over the model, renders `Workspace`, keeps the token-gated `health` call.
- `src/ui/main.tsx` — imports `globals.css` so the bundler emits the stylesheet.
- `src/core/server.ts` — `buildUiBundle` runs `bun-plugin-tailwind` and returns `{ js, css }` (JS by `entry-point` kind, CSS by extension); added `GET /app.css` (`text/css`, `nosniff`) + `<link>` in the served HTML.
- `package.json` / `bun.lock` — added `tailwindcss@4.3.2`, `react-resizable-panels@3.0.6`, devDep `bun-plugin-tailwind@0.1.2`.

### Review findings breakdown
- Patches applied: 3 (1 medium, 2 low) — keyboard-close shadowing fixed, duplicate-title ordinal fixed (+ regression test), JS-artifact selection hardened. See Review Triage Log 2026-07-06.
- Deferred: 0.
- Rejected: 7 — incomplete tablist ARIA (roving tabindex / `aria-controls` / `role="tabpanel"`) and the structural button-in-tab a11y polish (functional keyboard bug already patched), CSS-artifact fail-loud (by-design, matches the Block-If), reducer default-case guard (unreachable under the typed union), and 3 nits (handler identity churn, empty-state copy wording, 4px resize hit-target).
- intent_gap: 0, bad_spec: 0 (no spec loopback; `review_loop_iteration` stayed 0).

### Deviation from spec
- Pinned `react-resizable-panels@^3` (3.0.6) rather than the latest `^4`: v4 renamed its API to `Group`/`Panel`/`Separator`, whereas the spec's Code Map/Design Notes name `PanelGroup`/`Panel`/`PanelResizeHandle` — exactly v3's exports. v3 declares React 19 as a peer. No functional compromise.

### Verification performed
- `bun x tsc --noEmit` → clean under strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- `bun test` → 51 pass / 0 fail (107 expect calls), no browser/DOM harness.
- e2e (boot on an ephemeral high port + curl): `GET /` → 200 `text/html` `no-store`, links `/app.css` + `/app.js` + injects the token; `GET /app.css` → 200 `text/css; charset=utf-8` + `nosniff` (33,923 bytes of compiled Tailwind); `GET /app.js` → 200 `text/javascript`. Server killed, no orphan process (clean shutdown handling itself lands in story 1.5).

### Residual risks
- Full tablist keyboard/ARIA semantics (roving tabindex, `aria-controls`, `role="tabpanel"`) are intentionally not implemented at this shell stage (no data yet); acceptable now, revisit when Tabs carry real content (Epic 3+).
- `buildUiBundle` still rebuilds on every boot and hard-fails the Core if Tailwind stops emitting a discrete `.css` — carried by the pre-existing 1.1 deferred item about decoupling the UI build / cold-start (stories 1.2 / 1.7).
