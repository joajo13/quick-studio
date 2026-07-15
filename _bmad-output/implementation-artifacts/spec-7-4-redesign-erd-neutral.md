---
title: 'Redesign the ERD to neutral — port the design-artifacts/erd.html look onto the React Flow diagram (presentation-only)'
type: 'refactor'
created: '2026-07-13'
baseline_revision: '3aa42c58714d4e9a5202de39f922a03e7e20a52e'
final_revision: '58a5c3555aca90b8917604846768d03267ed4630'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/design-artifacts/erd.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** The ERD tab (Stories 4.1/4.2) renders and behaves correctly but still wears the OLD visual language — a plain shadcn-style card node with an emoji (🔑) PK marker, a single muted color (`--t-text`) on every column type, no FK marker, default React Flow chrome (bottom-left `<Controls>`, bare `<Background>`), and no functional type/relationship color coding. The neutral pivot makes `design-artifacts/*.html` the VISUAL SOURCE OF TRUTH, superseding the coral described in DESIGN.md/EXPERIENCE.md. `design-artifacts/erd.html` redefines the ERD look: a near-black canvas with a dot grid, ink accent (no coral), table nodes as mono cards (table-icon + name + row count in the header; per-column PK ink-key / FK blue-link markers and type-colored type labels), FK relations as bezier edges that light up on hover, a bottom-right zoom/fit toolbar with a % readout, and a bottom-left type legend. That prototype is the pixel target.

**Approach:** A **presentation-only** port. Keep the React Flow architecture and the pure `erd-graph.ts` data derivation (`schemaToGraph` nodes/edges/dagre positions, `dedupeTables`, `applyLayout`) and the Story 4.2 layout-persistence wiring (`savedLayout`/`onLayoutChange`, `positionsRef`/`viewportRef`, drag-stop + real-move-end persistence, mount-time freeze) exactly as they are; change only markup, class names, tokens, and presentational interaction state. Restyle the custom `ErdTableNode` into the prototype card, color-code each column's type through a pure `typeColorClass` mapper, mark PK columns with an ink key and FK columns with a blue link (the FK flag added additively from the already-present `SchemaTableInfo.foreignKeys`), give the canvas the neutral dot-grid background, edges that turn blue while a connected table is hovered, a bottom-right zoom/fit toolbar with a percentage readout, and a bottom-left data-type legend. No Core/RPC/data changes and no new fetches — the row count is shown only if it is already carried in the node data; otherwise it is omitted (no count query is added). No coral anywhere.

## Boundaries & Constraints

**Always:**
- Only markup, class names, CSS tokens, and presentational interaction state change, and only in the three source files below (plus the additive test update). The pure graph derivation (`schemaToGraph`, `applyLayout`, `dedupeTables`, dagre layout, node/edge ids, `markerEnd`) and the Story 4.2 persistence contract (`savedLayout`, `onLayoutChange`, `positionsRef`/`viewportRef`, drag-stop + programmatic-vs-user move-end handling, the mount-time `initialLayoutRef` freeze) behave byte-for-byte as before.
- Color is FUNCTIONAL only: data-type column labels use the `t-*` tokens (int → `--t-int`, timestamp/date/time → `--t-time`, numeric/decimal/money → `--t-num`, enum/user-defined → `--t-enum`, everything else → `--t-text`); the PK marker and PK column name use ink `--t-key`; the FK marker uses blue `--t-int`; relationship edges are neutral `--edge` at rest and `--edge-hot` (blue) only while a connected table is hovered. Every other surface is neutral (near-black canvas/cards, ink text/accent).
- The look tracks `design-artifacts/erd.html`, which is the visual source of truth and SUPERSEDES any coral in DESIGN.md/EXPERIENCE.md.
- Identifiers (schema, table name, column names, data types) render VERBATIM — never renamed, normalized, or lowercased. The uppercase styling of the type label is a CSS `text-transform` only; the underlying string is unchanged.
- Both light and dark themes render with no coral and legible functional colors (tokens flip through the existing `:root[data-theme="light"]` handling; `erd.html` documents both palettes).
- The diagram stays VIEW-ONLY: no connections drawn, no selection-driven mutation, no schema change through the canvas.
- All existing `bun test` suites (erd-graph derivation, `ErdTableNode` static-render tests, workspace tests) stay green; any test change is additive, covering only the new `isForeignKey` flag and the `typeColorClass` mapper.

**Block If:**
- Rendering the prototype's per-column FK marker would require changing node/edge/position derivation beyond adding a single additive presentational `isForeignKey` flag (derived from the already-present `foreignKeys`) — HALT `blocked`, condition `FK marker cannot be rendered without altering graph derivation`.

**Never:**
- No coral: no coral or `#ff…`-style coral hex is reintroduced anywhere; consume tokens only. The pivot is neutral-only.
- No logic/data change: do not change how nodes, edges, or positions are derived; do not re-tune dagre; do not change persistence timing or shape; do not add a Core RPC or any new data fetch. The row count is rendered ONLY if already present in the node data — do NOT add a count query to produce it.
- No dependency swap: keep `@xyflow/react` + `@dagrejs/dagre`. The prototype's vanilla pan/zoom/drag JS is a BEHAVIOR reference for what React Flow already provides — not a mandate to hand-roll the canvas.
- No broken tests, no `tsc` errors, no new console warnings (e.g. duplicate node types, uncontrolled-nodes error #015).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Notes |
|----------|--------------|---------------------------|-------|
| PK column | column in `primaryKey` | ink key badge (`--t-key`), column name in ink (`--foreground`), bold — matches `.col.pk` | replaces the 🔑 emoji |
| FK column | column appears in a table `foreignKey.columns` | blue link badge (`--t-int`), name in dim text, type color per family | `isForeignKey` flag added additively from existing `foreignKeys` |
| Plain column | neither PK nor FK | hidden spacer badge (keeps name alignment), dim name, type color per family | mirrors `.badge.spacer` |
| Type color mapping | dataType `int8`/`int4`/`serial` → int; `timestamptz`/`date`/`time` → time; `numeric`/`decimal`/`money`/`float`/`double` → num (teal); enum/`USER-DEFINED` → enum (amber); `text`/`citext`/`varchar`/`inet`/unknown → text (muted) | uppercase type label in the mapped `t-*` color; unknown types fall back to `--t-text` | pure `typeColorClass(dataType)` |
| Hover a table node | pointer enters a node | that table's FK edges (incoming + outgoing) turn `--edge-hot` (blue); leave reverts to `--edge` | React Flow `onNodeMouseEnter`/`onNodeMouseLeave` + edge class/style; no derivation change |
| Drag a table node | node dragged, dropped | node moves, connected bezier edges follow live, position persists on drag-stop | Story 4.2 behavior unchanged |
| Pan / wheel-zoom / fit / zoom ±% | canvas panned, wheel over cursor, toolbar buttons | viewport transforms; zoom-to-cursor; `%` readout updates; user move-end persists viewport, programmatic fit does not | React Flow viewport + custom toolbar reading `useReactFlow`/viewport |
| Row count in header | node data already carries a count | count shown right-aligned in the mono header (`.rows`) | node data carries NO count today → omit it; never add a fetch |
| Empty schema | `tables.length === 0` | neutral empty-state ("no tables to diagram"), restyled to the pivot, no coral | keep existing copy + logic |
| Long identifiers | name/type longer than the 240px card | truncate/ellipsis within the card; no overflow of the node width | mono, single line |
| Light theme | `data-theme="light"` | tokens flip; functional colors stay legible; still no coral | `erd.html` light palette |

</intent-contract>

## Code Map

- `src/ui/erd/erd-graph.ts` (248 lines) — additive-only. Add `isForeignKey: boolean` to `ErdColumn` (currently `{name, dataType, isPrimaryKey}`, ~L27-31) and populate it inside `schemaToGraph` where columns are built (~L197-201) by computing a per-table set of FK column names from the already-present `SchemaTableInfo.foreignKeys[].columns` (source contract ~L274-281; each `SchemaForeignKeyInfo` carries `columns: string[]`, ~L254-259) — mirror the existing `pkSet = new Set(t.primaryKey)` idiom (~L186). Add a pure, exported `typeColorClass(dataType: string): "t-int"|"t-time"|"t-num"|"t-enum"|"t-text"` keyword mapper (int/serial → `t-int`; timestamp/date/time → `t-time`; numeric/decimal/money/float/double → `t-num`; enum/`USER-DEFINED` → `t-enum`; everything else, incl. text/citext/varchar/inet/unknown → `t-text`). `dedupeTables` (~L107-124), dagre setup + `dagre.layout` (~L143-177), the edge build loop + `markerEnd: ArrowClosed` (~L158-175), node/edge ids, and `applyLayout` (~L227-247) stay behavior-identical.
- `src/ui/styles/globals.css` (183 lines) — add the two functional type-color tokens the prototype names, `--t-num` (teal — alias the existing `--t-json` value `#3ec6b6`) and `--t-enum` (amber — alias the existing `--t-bool` value `#e0a458`), plus relationship-edge tokens `--edge` (neutral) and `--edge-hot` (= `--t-int` blue), to the dark-first `:root` (beside the `--t-*` block ~L37-42). ALSO add matching values to the existing `:root[data-theme="light"]` block (beside its `--t-*` overrides ~L96-101) using the prototype's light palette (`--t-num:#157a56`, `--t-enum:#b3781f`, `--edge:#00000026`, `--edge-hot:#2f6fd6`) so the diagram flips correctly in light. Expose `--color-t-num`, `--color-t-enum`, `--color-edge`, `--color-edge-hot` in the `@theme inline` block (beside the existing `--color-t-*` aliases ~L131-136). Do NOT touch `--coral*` (already ink) or the existing `--t-*` values; reintroduce no coral hex.
- `src/ui/workspace/ErdTabView.tsx` (226 lines) — restyle the custom `ErdTableNode` (~L41-75): a mono header with a table-icon glyph + the verbatim `label` (row count OMITTED — node data carries none; do not add one); per-column rows with a PK ink-key badge (replace the 🔑 emoji at ~L60-63), an FK blue-link badge (new, gated on the additive `isForeignKey`), and a hidden spacer badge for plain columns (keeps name alignment); the PK column name in ink+bold; and an uppercase type label colored via `typeColorClass(c.dataType)` (replace the flat `text-[var(--t-text)]` at ~L68). Restyle the canvas: keep the outer `bg-[var(--background)]` wrapper (~L201); swap the bare `<Background />` (~L220) for a dot-grid `<Background variant={BackgroundVariant.Dots} gap={26} />`; replace the default bottom-left `<Controls showInteractive={false} />` (~L221) with a bottom-right neutral zoom-out / `%` readout / zoom-in / fit toolbar (reading `useReactFlow` — `zoomIn`/`zoomOut`/`fitView`/viewport zoom via `useStore`/`getZoom`) and add a bottom-left data-type legend (int / numeric / timestamp / enum / text swatches). Add `onNodeMouseEnter`/`onNodeMouseLeave` (absent today) that set a hovered-node id in local state; drive each edge's class/style from it so edges connected to the hovered node render `--edge-hot` and all others `--edge` — presentationally, WITHOUT mutating the derived `edges` array shape or ids. Leave ALL data props, `savedLayout`/`onLayoutChange`, `initialLayoutRef`/`positionsRef`/`viewportRef` (~L102-198), the drag/move persistence handlers, the `NODE_TYPES` registration (~L78), the ReactFlow config props (~L202-219), and the empty-state branch (~L190-192) untouched — only classes/markup/tokens/hover-state change.
- `src/ui/workspace/ErdTabView.test.tsx` (89 lines) — additive update. The current PK assertion checks for the literal `"🔑"` (~L60); replace it with an assertion on the new PK key-badge marker (e.g. `aria-label`/`title="primary key"` still present, or a stable badge class). Add: an assertion that the FK column (`user_id` in the `SAMPLE` fixture) renders the FK link badge, and that a column's type label carries the mapped type-color class (e.g. `t-int` for `integer`). Keep the empty-state, table-name, and `react-flow__edge` assertions green.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/erd/erd-graph.ts` — add `isForeignKey` to `ErdColumn` (populated from `foreignKeys[].columns`) and a pure exported `typeColorClass(dataType)` mapper — unit-test the mapper's families + fallback and that FK columns are flagged; assert node/edge/position output is otherwise unchanged. (mapper + FK-flag unit tests added in `erd-graph.test.ts`.)
- [x] `src/ui/styles/globals.css` — add `--t-num`/`--t-enum` and `--edge`/`--edge-hot` tokens to dark `:root` AND the `:root[data-theme="light"]` block, and expose `--color-t-num`/`--color-t-enum`/`--color-edge`/`--color-edge-hot` via `@theme inline` — functional-color foundation for the port; no coral.
- [x] `src/ui/workspace/ErdTabView.tsx` — restyle `ErdTableNode` (mono header with table icon; PK ink-key, FK blue-link, spacer badges; type-colored uppercase type labels; row count omitted) and the canvas (dot-grid `<Background>`, hover edge highlight via `onNodeMouseEnter`/`Leave`, bottom-right zoom/fit toolbar with `%`, bottom-left legend); preserve every data/persistence prop, the `NODE_TYPES` registration, the empty-state branch, and the ReactFlow config.
- [x] `src/ui/workspace/ErdTabView.test.tsx` — additively update the PK-marker assertion (🔑 → key badge) and add FK-badge + type-color-class assertions using the existing `SAMPLE` fixture; keep all current assertions green.

**Acceptance Criteria:**
- Given the ERD tab on a connected schema, when it renders, then it matches `design-artifacts/erd.html`: near-black dot-grid canvas, mono table-card nodes (table-icon + verbatim name header, no row count when node data carries none), per-column PK ink-key / FK blue-link / spacer markers, type-colored uppercase type labels, a bottom-right zoom/fit toolbar with a `%` readout, and a bottom-left type legend.
- Given a table node, when the pointer hovers it, then its incoming and outgoing FK edges turn blue (`--edge-hot`) and revert to neutral (`--edge`) on leave, with no change to node positions or persisted layout.
- Given the diagram, when a node is dragged or the canvas is panned/zoomed/fit, then behavior and persistence are byte-for-byte the same as before the redesign (Stories 4.1/4.2 unchanged).
- Given any theme, when the ERD renders in light or dark, then no coral appears and the functional colors stay legible; identifiers render verbatim.
- Given the redesign, when `bunx tsc --noEmit` and `bun test` run, then there are no type errors and all suites pass (only additive test changes for `isForeignKey`/`typeColorClass`).

## Spec Change Log

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 3: (high 0, medium 0, low 3)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` Dot-grid `<Background>` used React Flow's fixed default color (not theme-aware) → added `color="var(--border)"` so the grid tracks the token and flips light/dark (`ErdTabView.tsx`).
  - `[low]` `[patch]` `typeColorClass` mis-bucketed `interval` to `t-int` (substring `int`, checked before the time family) → reordered the time/`interval` check before the loose `int` test and added an `interval → t-time` unit test (`erd-graph.ts`, `erd-graph.test.ts`).
  - `[low]` `[patch]` Light `--edge-hot` was hardcoded `#2f6fd6` (desync risk vs dark's `var(--t-int)`) → aliased light to `var(--t-int)` too (`globals.css`).
  - `[low]` `[patch]` Long column name / type label could clip instead of ellipsizing (spec's long-identifier row wanted truncate) → added `min-w-0` to the name span and `max-w-[55%] truncate` to the type label (`ErdTabView.tsx`).

- **No row-count data source:** the node `data` is `{schema, name, label, columns[]}` — no count exists anywhere in the `schemaToGraph` pipeline, and the prototype's `.rows` values ("89", "1.2k") are hardcoded mockup strings. Per the intent, the header **omits** the row count entirely; do NOT add a Core RPC or count query to produce one (Block/Never).
- **Tokens: alias, don't invent hues.** globals.css already has the teal (`--t-json #3ec6b6`) and amber (`--t-bool #e0a458`) the prototype wants under different names. Add `--t-num`/`--t-enum` pointing at those same values rather than new colors, and `--edge-hot = var(--t-int)` (blue). The prototype's own `--t-*` hex differ slightly from globals (e.g. int `#82aaff` vs `#6ba5ff`); keep the **globals** values — the prototype is the layout/behavior target, globals is the token source of truth.
- **Light theme is in scope here (unlike 7-3).** globals.css has a real `:root[data-theme="light"]` block that overrides every `--t-*`; the new tokens must get light values there too or the ERD would fall back to dark hues on a light canvas. Use the prototype's documented light palette. `--edge`/`--edge-hot` are also theme-dependent (dark `#ffffff2e`/blue, light `#00000026`/`#2f6fd6`).
- **Hover-highlight is pure presentation.** Keep the derived `edges` array (ids, `markerEnd`, `data`) exactly as `schemaToGraph` produced it. Track a `hoveredNodeId` in local component state via `onNodeMouseEnter`/`onNodeMouseLeave`, and derive each edge's `className`/`style` (`--edge` vs `--edge-hot`) from whether its `source`/`target` equals the hovered id — do not rebuild or reorder edges, and do not touch node positions.
- **Custom toolbar replaces `<Controls>`.** React Flow's default `<Controls>` sits bottom-left with its own chrome; the prototype puts a zoom-out / `%` / zoom-in / fit cluster bottom-right. Build it with `useReactFlow().{zoomIn,zoomOut,fitView}` and read the live zoom for the `%` readout (`useStore(s => s.transform[2])` or equivalent). Removing `<Controls>` must not change pan/zoom/fit behavior — those come from the `<ReactFlow>` viewport, which is untouched.
- **Test couples to the emoji.** `ErdTabView.test.tsx` asserts the literal `"🔑"` string via `renderToStaticMarkup`. Replacing the emoji with an SVG/badge WILL break that line — update it in the SAME task (match the badge's stable `aria-label`/`title="primary key"` or class), and add the FK-badge + type-color-class checks against the existing `SAMPLE` fixture (`orders.user_id` is the FK/int column).
- **`BackgroundVariant` import.** The dot grid needs `variant={BackgroundVariant.Dots}` (gap ≈ 26 to match the prototype's 26px) — add `BackgroundVariant` to the existing `@xyflow/react` import; do not hand-roll a background layer.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors across `erd-graph.ts`, `ErdTabView.tsx`, and the touched test.
- `bun test` — expected: all suites pass, including the additive `erd-graph`/`ErdTabView` assertions for FK flagging and type-color mapping.

**Manual checks:**
- Launch the app, open the ERD tab on a seeded schema, and visually diff against `design-artifacts/erd.html`: dot-grid canvas, mono card nodes (table icon + verbatim name, no row count), PK ink key + FK blue link + spacer alignment, type-colored uppercase type labels, hover-to-highlight relations (edges go blue), the bottom-right zoom/`%`/fit toolbar, and the bottom-left legend. Toggle light/dark and confirm no coral in either and legible type colors. Drag a node and pan/zoom to confirm layout persistence is unchanged.

## Auto Run Result

Status: done

### Summary
Presentation-only neutral (ChatGPT-style) port of the ERD tab onto `design-artifacts/erd.html`. `ErdTableNode` became a mono card with a table-glyph header + verbatim `schema.name` (no row count — the node data carries none and no fetch was added), per-column PK ink-key / FK blue-link / hidden-spacer markers, ink+bold PK names, and uppercase type labels color-coded by a new pure `typeColorClass` mapper. The canvas gained a token-driven dot-grid `<Background>`, a hover-to-highlight edge treatment (a connected table's FK edges turn `--edge-hot` blue) implemented as pure presentation over the already-derived edges, a bottom-right zoom-out/`%`/zoom-in/fit toolbar (`useReactFlow` + live-zoom readout), and a bottom-left data-type legend. `erd-graph.ts` was extended additively only: an `isForeignKey` flag on `ErdColumn` (derived from the already-present `foreignKeys[].columns`) and the exported `typeColorClass`. The pure graph derivation (`schemaToGraph`, `dedupeTables`, `applyLayout`, dagre, node/edge ids, `markerEnd`) and the Story 4.2 layout persistence (`savedLayout`/`onLayoutChange`, the mount-time freeze, `positionsRef`/`viewportRef`, drag-stop + programmatic-vs-user move-end handling) are byte-for-byte unchanged. No coral, no hardcoded palette; both light and dark themes flip through existing tokens.

### Files changed
- `src/ui/erd/erd-graph.ts` — additive `isForeignKey: boolean` on `ErdColumn` (populated in `schemaToGraph` from `foreignKeys[].columns`) and a pure exported `typeColorClass(dataType)` mapper (int/serial, timestamp/date/time/interval, numeric/decimal/money/float/double, enum/USER-DEFINED, else text). Derivation otherwise untouched.
- `src/ui/styles/globals.css` — added `--t-num`/`--t-enum` (aliasing the existing teal/amber) and `--edge`/`--edge-hot` (= `var(--t-int)`) to dark `:root` and `:root[data-theme="light"]`, plus `--color-t-num`/`--color-t-enum`/`--color-edge`/`--color-edge-hot` in `@theme inline`. `--coral*` and existing `--t-*` untouched.
- `src/ui/workspace/ErdTabView.tsx` — restyled `ErdTableNode` + canvas (dot grid, hover edge highlight, zoom/fit toolbar, legend); all data/persistence props, `NODE_TYPES`, empty-state, and ReactFlow config preserved.
- `src/ui/workspace/ErdTabView.test.tsx` — additive: PK marker asserted via `aria-label="primary key"` (was the 🔑 emoji), plus FK-badge and `t-int` type-color-class assertions on the `SAMPLE` fixture.
- `src/ui/erd/erd-graph.test.ts` — additive unit tests for `typeColorClass` families + fallback, the `interval → t-time` boundary, and `isForeignKey` flagging.

### Review findings breakdown
- **Patches applied (4):** dot-grid `<Background>` made theme-aware via `color="var(--border)"` (medium — was React Flow's fixed default, off-token in dark-first); `typeColorClass` `interval` mis-bucket fixed by ordering the time family before the loose `int` substring test (+ unit test); light `--edge-hot` aliased to `var(--t-int)` (was a hardcoded duplicate, desync risk); long column-name/type-label truncation hardened (`min-w-0` on the name, `max-w-[55%] truncate` on the type) per the spec's long-identifier row.
- **Deferred (3):** DW-65 PK∩FK column shows only the PK key badge (FK still drawn as an edge; single-badge layout decision); DW-66 `hoveredNodeId` not reconciled against a removed+id-reused node (very narrow, self-correcting); DW-67 sub-11px muted type/legend text contrast unverified (epic-wide a11y, cf. DW-58).
- **Rejected (12):** inert `t-*`/`erd-edge` marker classes and unused `--color-edge*` utilities (color applies via inline style / spec-mandated exposure); blue used for int-type + FK badge + hot edge (spec + prototype mandated); no bool/json family in the mapper (spec + prototype = 5 families); static legend "duplication"; `isForeignKey` non-optional (no external `ErdColumn` constructor); per-hover edge-array reallocation and toolbar re-render (the spec's prescribed presentational approach, negligible for realistic schemas); PK test asserts a stable `aria-label` rather than brittle SVG internals; and the "programmatic zoom/fit persists layout" claim (false — `handleMoveEnd` returns early on the null programmatic event).

### Verification
- `bunx tsc --noEmit` → clean (exit 0), after patches.
- `bun test` → 1056 pass, 0 fail (2611 expect calls, 68 files). ERD-specific: `erd-graph.test.ts` + `ErdTabView.test.tsx` = 34 pass.
- `rg 'coral.*#|#ff[0-9a-fA-F]{4}|amber-[0-9]|red-[0-9]|bg-\[#'` over `ErdTabView.tsx` + `erd-graph.ts` → no matches (no coral / hardcoded palette). Persistence identifiers all present; graph derivation diff confined to the additive flag + mapper.

### Follow-up review recommendation
`false` — the final pass applied four localized, low-consequence presentational patches (one medium: a one-prop theme-aware background; three low: a mapper ordering fix, a token alias, and a truncation-class tweak). No behavior, API, persistence, security, or data-flow change; the graph derivation and Story 4.2 persistence are untouched. Not significant enough to warrant an independent follow-up review.

### Residual risks
- The new `--edge`/`--edge-hot`/`--t-num`/`--t-enum` light values track the prototype but, like the rest of Epic 7, the light theme is opt-in and less battle-tested than dark; the small muted labels carry the un-verified contrast risk tracked in DW-67.
- `typeColorClass` uses substring keyword matching; realistic Postgres types are covered (and `interval` is now guarded + tested), but exotic geometric types (`point`, `lseg`) that contain `int` still fall to `t-int` — cosmetic only, not tracked as it is vanishingly rare and the identifier renders verbatim.
- DW-65/66 are dormant, low-consequence presentational edge cases on join-table PK∩FK columns and a narrow hover/remove race; neither affects derivation or persistence.
