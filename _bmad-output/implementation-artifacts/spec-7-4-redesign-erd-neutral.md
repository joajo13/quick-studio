---
title: 'Redesign the ERD to neutral — port the design-artifacts/erd.html look onto the React Flow diagram (presentation-only)'
type: 'refactor'
created: '2026-07-13'
status: 'backlog'
context:
  - '{project-root}/design-artifacts/erd.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
---

<intent-contract>

## Intent

**Problem:** The ERD tab (Stories 4.1/4.2) renders and behaves correctly but still wears the OLD visual language — a plain shadcn-style card node with an emoji (🔑) PK marker, a single muted color (`--t-text`) on every column type, no FK marker, default React Flow chrome (bottom-left `<Controls>`, bare `<Background>`), and no functional type/relationship color coding. The neutral pivot makes `design-artifacts/*.html` the VISUAL SOURCE OF TRUTH, superseding the coral described in DESIGN.md/EXPERIENCE.md. `design-artifacts/erd.html` redefines the ERD look: a near-black canvas with a dot grid, ink accent (no coral), table nodes as mono cards (table-icon + name + row count in the header; per-column PK ink-key / FK blue-link markers and type-colored type labels), FK relations as bezier edges that light up on hover, a bottom-right zoom/fit toolbar with a % readout, and a bottom-left type legend. That prototype is the pixel target.

**Approach:** A **presentation-only** port. Keep the React Flow architecture and the pure `erd-graph.ts` data derivation (`schemaToGraph` nodes/edges/dagre positions, `dedupeTables`, `applyLayout`) and the Story 4.2 layout-persistence wiring (`savedLayout`/`onLayoutChange`, `positionsRef`/`viewportRef`, drag-stop + real-move-end persistence, mount-time freeze) exactly as they are; change only markup, class names, tokens, and presentational interaction state. Restyle the custom `ErdTableNode` into the prototype card, color-code each column's type through a pure `typeColorClass` mapper, mark PK columns with an ink key and FK columns with a blue link (the FK flag added additively from the already-present `SchemaTableInfo.foreignKeys`), give the canvas the neutral dot-grid background, edges that turn blue while a connected table is hovered, a bottom-right zoom/fit toolbar with a percentage readout, and a bottom-left data-type legend. No Core/RPC/data changes and no new fetches — the row count is shown only if it is already carried in the node data; otherwise it is omitted (no count query is added). No coral anywhere.

## Boundaries & Constraints

**Always:**
- Only markup, class names, CSS tokens, and presentational interaction state change, and only in the three files below. The pure graph derivation (`schemaToGraph`, `applyLayout`, `dedupeTables`, dagre layout, node/edge ids, `markerEnd`) and the Story 4.2 persistence contract (`savedLayout`, `onLayoutChange`, `positionsRef`/`viewportRef`, drag-stop + programmatic-vs-user move-end handling, the mount-time `initialLayoutRef` freeze) behave byte-for-byte as before.
- Color is FUNCTIONAL only: data-type column labels use the `t-*` tokens (int → `--t-int`, timestamp/date/time → `--t-time`, numeric/decimal/money → `--t-num`, enum/user-defined → `--t-enum`, everything else → `--t-text`); the PK marker and PK column name use ink `--t-key`; the FK marker uses blue `--t-int`; relationship edges are neutral `--edge` at rest and `--edge-hot` (blue) only while a connected table is hovered. Every other surface is neutral (near-black canvas/cards, ink text/accent).
- The look tracks `design-artifacts/erd.html`, which is the visual source of truth and SUPERSEDES any coral in DESIGN.md/EXPERIENCE.md.
- Identifiers (schema, table name, column names, data types) render VERBATIM — never renamed, normalized, or lowercased. The uppercase styling of the type label is a CSS `text-transform` only; the underlying string is unchanged.
- Both light and dark themes render with no coral and legible functional colors (tokens flip through the existing theme handling; `erd.html` documents both palettes).
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
| Row count in header | node data already carries a count | count shown right-aligned in the mono header (`.rows`) | if NOT present in node data, omit it — never add a fetch |
| Empty schema | `tables.length === 0` | neutral empty-state ("no tables to diagram"), restyled to the pivot, no coral | keep existing copy + logic |
| Long identifiers | name/type longer than the 240px card | truncate/ellipsis within the card; no overflow of the node width | mono, single line |
| Light theme | `data-theme="light"` (or system light) | tokens flip; functional colors stay legible; still no coral | `erd.html` light palette |

</intent-contract>

## Code Map

- `src/ui/workspace/ErdTabView.tsx` -- restyle the custom `ErdTableNode` into the prototype card: a mono header (table-icon + verbatim `label` + optional row count), and per-column rows with a PK ink-key badge / FK blue-link badge / hidden spacer, an ink PK name, and an uppercase type label colored via the pure `typeColorClass` mapper. Restyle the canvas: neutral `--background`, dot-grid `<Background variant={Dots} gap≈26>`, edges neutral (`--edge`) at rest and blue (`--edge-hot`) while a connected table is hovered (`onNodeMouseEnter`/`onNodeMouseLeave` driving edge class/style), a bottom-right neutral zoom-out/`%`/zoom-in/fit toolbar (reading the React Flow viewport), and a bottom-left data-type legend. Leave ALL data props, `savedLayout`/`onLayoutChange`, the refs, drag/move persistence, the `NODE_TYPES` registration, and the empty-state logic untouched — only classes/markup/tokens change.
- `src/ui/erd/erd-graph.ts` -- additive-only: add `isForeignKey: boolean` to `ErdColumn` and populate it in `schemaToGraph` from the already-present `foreignKeys[].columns` (so the FK badge can render); add a pure, exported `typeColorClass(dataType: string): string` keyword mapper (int/time/num/enum → `t-*`, fallback `t-text`). Node/edge derivation, `dedupeTables`, dagre layout, `applyLayout`, node/edge ids, and `markerEnd` stay behavior-identical.
- `src/ui/styles/globals.css` -- add the two functional type-color tokens the prototype names — `--t-num` (teal) and `--t-enum` (amber) (alias to the existing teal/amber values if preferred) — and the relationship-edge tokens `--edge` (neutral) and `--edge-hot` (= `--t-int` blue); expose them through `@theme inline`. Everything already-neutral stays; no coral hex is reintroduced.

## Tasks & Acceptance

**Execution:**
- [ ] `src/ui/erd/erd-graph.ts` -- add `isForeignKey` to `ErdColumn` (populated from `foreignKeys`) and a pure exported `typeColorClass(dataType)` mapper -- unit-test the mapper's families + fallback and that FK columns are flagged; assert node/edge/position output is otherwise unchanged.
- [ ] `src/ui/styles/globals.css` -- add `--t-num`/`--t-enum` and `--edge`/`--edge-hot` tokens (dark + light) and expose via `@theme inline` -- functional-color foundation for the port; no coral.
- [ ] `src/ui/workspace/ErdTabView.tsx` -- restyle `ErdTableNode` (mono header + row count; PK ink-key, FK blue-link, spacer badges; type-colored uppercase type labels) and the canvas (dot-grid background, hover edge highlight, bottom-right zoom/fit toolbar with `%`, bottom-left legend); preserve every data/persistence prop and behavior.
- [ ] Update the `ErdTableNode` static-render test additively for the new badge structure + type-color classes -- keep existing assertions green.

**Acceptance Criteria:**
- Given the ERD tab on a connected schema, when it renders, then it matches `design-artifacts/erd.html`: near-black dot-grid canvas, mono table-card nodes (table-icon + name + row count header), per-column PK ink-key / FK blue-link / spacer markers, type-colored uppercase type labels, a bottom-right zoom/fit toolbar with a `%` readout, and a bottom-left type legend.
- Given a table node, when the pointer hovers it, then its incoming and outgoing FK edges turn blue (`--edge-hot`) and revert to neutral (`--edge`) on leave, with no change to node positions or persisted layout.
- Given the diagram, when a node is dragged or the canvas is panned/zoomed/fit, then behavior and persistence are byte-for-byte the same as before the redesign (Stories 4.1/4.2 unchanged).
- Given any theme, when the ERD renders in light or dark, then no coral appears and the functional colors stay legible; identifiers render verbatim.
- Given the redesign, when `bunx tsc --noEmit` and `bun test` run, then there are no type errors and all suites pass (only additive test changes for `isForeignKey`/`typeColorClass`).

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors across `erd-graph.ts`, `ErdTabView.tsx`, and any touched tests.
- `bun test` -- expected: all suites pass, including the additive `erd-graph`/`ErdTableNode` assertions for FK flagging and type-color mapping.

**Manual checks:**
- Launch the app, open the ERD tab on a seeded schema, and visually diff against `design-artifacts/erd.html`: dot-grid canvas, mono card nodes with header row count, PK ink key + FK blue link + spacer alignment, type-colored uppercase type labels, hover-to-highlight relations (edges go blue), the bottom-right zoom/`%`/fit toolbar, and the bottom-left legend. Toggle light/dark and confirm no coral in either. Drag a node and pan/zoom to confirm layout persistence is unchanged.
