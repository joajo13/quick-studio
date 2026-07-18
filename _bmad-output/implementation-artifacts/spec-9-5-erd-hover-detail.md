---
title: 'Story 9.5: ERD hover — column detail, PK/FK badges, and connected-relationship highlight'
type: 'feature'
created: '2026-07-18'
status: 'draft'
context:
  - '{project-root}/design-artifacts/erd.html'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-1-render-erd.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-4-redesign-erd-neutral.md'
---

<intent-contract>

## Intent

**Problem:** Hovering a table node in the ERD "feels empty." Today (`src/ui/workspace/ErdTabView.tsx`) the only hover feedback is a presentation-only edge recolor: `onNodeMouseEnter`/`onNodeMouseLeave` (**372-377**) set a local `hoveredNodeId` (**309**), and an `edges` `useMemo` (**328-343**) recolors every edge touching that id to `--edge-hot` (a thin blue line) while leaving the rest `--edge`. Two gaps: (1) only the *edges* change — the RELATED TABLES themselves do not stand out (the connected nodes look identical to the twenty unrelated ones, so on a 60–70 table canvas you cannot actually see "what does `orders` connect to"), and (2) there is NO column readout on hover — the node card already lists columns, but at a fit-to-screen zoom that text is illegible, and nothing surfaces a table's columns/types/PK-FK at a glance. Separately, the hover state is never reconciled against the live node set (DW-66): if the hovered table is removed (and its NUL-joined `tableId` later reused) mid-hover without a `mouseleave`, the stale id spuriously highlights a different table.

**Approach:** Build on the EXISTING `hoveredNodeId` seam — do not add a new hover mechanism. On hover-in: (a) keep the edge recolor exactly as-is, and ADDITIONALLY compute the set of *connected* node ids (the hovered node plus its FK neighbours) from the already-derived edges via a new pure `connectedNodeIds(edges, hoveredNodeId)` helper in `erd-graph.ts`, then overlay a presentation-only emphasis/dim treatment onto the `nodes` array (connected nodes stay full-strength, the rest dim) — mirroring the exact `className`/`style` overlay pattern the edges already use, never touching node positions, ids, or the derived graph; and (b) render a hover DETAIL panel (a React Flow `<Panel>`, mirroring the existing `ErdToolbar`/`ErdLegend` panels at **412-417**) listing the hovered table's columns as `name : dataType` with PK and FK badges, sourced from the SAME `ErdNodeData.columns` payload the node already carries (`{ name, dataType, isPrimaryKey, isForeignKey }`, `erd-graph.ts:244-249`) — zero new schema derivation. On hover-out: `hoveredNodeId` returns to `null`, which clears the edge recolor, the node emphasis, AND the detail panel in one shot. Add a reconciling effect so a `nodes`/`graph` change while hovering clears a now-absent `hoveredNodeId` (fixes DW-66; guarantees "no stale highlight if the node set changes mid-hover"). Pan/zoom, dagre derivation, drag, and layout persistence (Story 4.2) are untouched — all changes are presentation-only over already-derived data.

## Boundaries & Constraints

**Always:**
- Reuse the ONE existing hover seam: `hoveredNodeId` state (`ErdTabView.tsx:309`), set by `handleNodeMouseEnter`/`handleNodeMouseLeave` (**372-377**) wired to `<ReactFlow>`'s `onNodeMouseEnter`/`onNodeMouseLeave` (**397-398**). No new pointer listeners, no DOM measurement, no second hover source of truth.
- Keep the existing edge-highlight verbatim: the `edges` `useMemo` (**328-343**) still maps 1:1 over `graph.edges` preserving every edge id, `markerEnd`, `data`, `source`/`target`, and order, only overlaying `className` (`erd-edge-hot`/`erd-edge`) and `style` (`--edge-hot`/`--edge`, stroke width 2/1.5). Node emphasis is a PARALLEL overlay of the same shape onto the nodes.
- The connected-node set is derived by a PURE, DOM-free helper in `erd-graph.ts` (`connectedNodeIds(edges, hoveredId)` returning a `Set<string>` of the hovered id + every neighbour reachable via an edge whose `source` or `target` equals it), unit-tested with `bun test` — the canvas stays a thin consumer. A self-referential FK contributes only the node's own id (no phantom neighbour); a table with no FKs yields a singleton set (itself), so hovering it emphasises just itself and dims the rest.
- The hover detail panel renders the hovered table's columns from the EXISTING `ErdNodeData.columns` (looked up in the live node array by `hoveredNodeId`) — `name` (verbatim), `dataType` (verbatim; uppercase is CSS `text-transform` only), a PK badge when `isPrimaryKey`, an FK badge when `isForeignKey`. It reuses the same `KeyIcon`/`LinkIcon` glyphs and `--t-key`/`--t-int` badge colours the node rows already use (`ErdTabView.tsx:112-130`), and the same `--card`/`--border` panel surface `ErdToolbar`/`ErdLegend` use.
- Reconcile `hoveredNodeId` against the live node set: add an effect (or fold into the existing graph-change effect at **319-322**) that clears `hoveredNodeId` when it is not present among the current node ids — closing DW-66 and making "node removed mid-hover" clear cleanly.
- Identifiers (table name, column names, data types) render VERBATIM — never renamed, normalized, or truncated in meaning (CSS `truncate`/`text-transform` for presentation only), consistent with Story 4.1's "render identifiers verbatim" boundary.
- Pan/zoom/fit (`onMoveEnd`/`handleMoveEnd`, **363-370**), node drag (`onNodeDragStop`/`handleNodeDragStop`, **358**), the dagre-derived graph (`schemaToGraph`/`applyLayout`), and layout persistence (`onLayoutChange`, `positionsRef`, `viewportRef`, `initialLayoutRef`) all keep their exact current behaviour — the hover feature reads state, it never writes positions, viewport, or the persisted layout.

**Block If:**
- If node emphasis/dim cannot be applied without rebuilding the controlled `nodes` array in a way that breaks React Flow's drag contract (i.e. it would require dropping `useNodesState`/`onNodesChange`, re-tripping error #015 the way Story 4.1 hit) — HALT `blocked`, condition `node hover emphasis cannot be applied without breaking the controlled-nodes drag contract`. (Expected safe: overlay `style`/`className` in a derived `displayNodes` `useMemo` fed to `<ReactFlow nodes={…}>`, leaving the underlying controlled `nodes` + `onNodesChange` intact — confirm the exact seam in step-02.)
- If the hover detail panel cannot mount as a React Flow `<Panel>` without occluding the existing `ErdToolbar` (bottom-right) / `ErdLegend` (bottom-left) panels or the canvas — HALT `blocked`, condition `hover detail panel cannot mount without colliding with the existing toolbar/legend panels`. (Expected safe: a `top-left` or `top-right` `<Panel>` slot is free — confirm placement in step-02.)

**Never:**
- Never change `schemaToGraph`'s node/edge derivation, edge ids, `markerEnd`, `data`, or the dagre positions — the hover feature is a pure presentation overlay over the already-derived graph (mirrors the Story 7.4 boundary: "hover-highlight is pure presentation").
- Never persist, restore, or write anything about hover state to disk — hover is ephemeral React memory only; `ErdTabLayout` (positions + viewport) is the ONLY thing that persists, and it is not touched.
- Never mutate the schema through the diagram; never add a Core RPC / count / re-introspection call to feed the tooltip — it renders only from `ErdNodeData.columns` already in hand (view-only, per Story 4.1).
- Never let a stale `hoveredNodeId` outlive its node — no highlight, dim, or panel may reference a table that is no longer in the node set (the DW-66 fix is mandatory here, not deferred).
- Never regress DW-65: a column that is BOTH PK and FK still renders at least the PK badge on the node row. The hover panel MAY additionally show the FK badge for such a column (an opportunity to close DW-65 in the panel's roomier layout) — confirm whether to surface both badges in step-02; at minimum it must not make the PK∩FK case worse than today.
- Never introduce coral / off-brand hover chrome — emphasis uses the existing neutral `--edge-hot` (== `--t-int`) accent and the node/panel reuse `--card`/`--border`/`--muted-foreground` tokens (Epic 7 neutral system).

## I/O & Edge-Case Matrix

Hover behaviour is driven by `hoveredNodeId`; the connected-set logic (`connectedNodeIds`) is the pure, unit-tested surface. `nodeId` below is the NUL-separated `tableId(schema, name)` (`erd-graph.ts:130-132`).

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hover-in, table WITH FKs | pointer enters `orders` (FK → `customers`) | `hoveredNodeId = orders`; edges touching `orders` recolor `--edge-hot` (existing); `orders` + `customers` stay full-strength, all other nodes dim; detail panel shows `orders`' columns with types + PK/FK badges (`customer_id` gets the FK link badge) | No error |
| Hover-out | pointer leaves the node | `hoveredNodeId = null`; edges revert to `--edge`; all nodes return to full-strength; detail panel unmounts — one clean clear | No error |
| Node removed mid-hover | hovered table dropped from `tables` (or its id no longer in the derived node set) while pointer is over it, no `mouseleave` | reconciling effect clears `hoveredNodeId` → highlight, dim, and panel all clear; a later table reusing the same `tableId` is NOT spuriously highlighted (closes DW-66) | Cleared, no stale state |
| Table with NO FKs | hover a table whose `foreignKeys` is empty | `connectedNodeIds` = `{ self }`; no edges recolor (none touch it); only that node stays full-strength, the rest dim; panel lists its columns (all PK/plain badges, no FK badge) | No error |
| Self-referential FK | hover a table whose FK references itself | its self-loop edge recolors `--edge-hot` (existing); `connectedNodeIds` = `{ self }` only (no phantom neighbour); panel shows the self-referencing column with an FK badge | No error |
| PK∩FK column (DW-65) | hover a join table whose column is both PK and FK | node row still shows the PK badge (DW-65 unchanged); panel row for that column shows the PK badge and MAY also show the FK badge (confirm in step-02) — never worse than today | No regression |
| Composite FK | hover a table with a multi-column FK | the SINGLE composite edge recolors (one edge, per Story 4.1); all participating local columns carry the FK badge in the panel (`isForeignKey` is true for each) | No error |
| Empty schema | `tables: []` | empty-state renders (`ErdTabView.tsx:379-381`); no nodes to hover, no panel | No error |
| Hover during pan/zoom or after drag | hover a node then pan/zoom, or hover a dragged node | highlight/dim/panel follow the node; pan/zoom (`onMoveEnd`) and drag persistence (`onNodeDragStop`) are unaffected — hover never writes layout | No error |
| Connected-set derivation (pure) | `connectedNodeIds(edges, id)` for hover-in / no-FK / self-ref / composite / absent id | returns `{ id } ∪ neighbours`; absent id → `{ id }` (or empty — confirm) with no throw; deterministic, order-independent | Never throws |

</intent-contract>

## Acceptance Criteria

- **Given** a connected database and an open ERD tab, **when** I hover a table node that has foreign keys (e.g. `orders`, which references `customers` in the seed), **then** the FK edges touching it highlight (existing behaviour), the connected tables (`orders` + `customers`) stay visually full-strength while unrelated tables dim, and a detail panel appears listing `orders`' columns as `name : type` with PK and FK badges.
- **Given** I am hovering a table, **when** the pointer leaves the node, **then** the edge highlight, the node emphasis/dim, and the detail panel all clear together in a single transition — no residual highlight and no orphaned panel.
- **Given** I am hovering a table, **when** that table is removed from the schema (or the node set otherwise changes so the hovered id is gone) before a `mouseleave` fires, **then** the highlight, dim, and panel clear, and no other table inherits the highlight (DW-66 closed).
- **Given** I hover a table that has no foreign keys, **then** no edges recolor, only that node stays full-strength (the rest dim), and the panel lists its columns with no FK badges.
- **Given** I hover a table with a self-referential foreign key, **then** its self-loop edge highlights, only that one node is treated as connected (no phantom neighbour), and the panel shows the self-referencing column with an FK badge.
- **Given** a column that is both a primary key and a foreign key, **when** I hover its table, **then** the node row still shows at least the PK badge (DW-65 not regressed) and the panel surfaces the column with its PK (and optionally FK) badge.
- **Given** the ERD, **when** I pan, zoom, fit, drag a node, or reload the tab, **then** pan/zoom/fit, node drag, and layout persistence behave exactly as before — hover changes nothing about positions, viewport, or the persisted `ErdTabLayout`.
- **Given** the suite, **when** run, **then** `bunx tsc --noEmit` is clean, `bun test` is green with new `connectedNodeIds` unit tests in `erd-graph.test.ts` and no existing `ErdTabView.test.tsx` / `erd-graph.test.ts` assertion broken, and `bun run build` succeeds.

## Code Map

<!-- Line anchors reconciled to the current tree (post-7.4). Confirm any uncertain seam in step-02; do NOT invent React Flow APIs. -->

- `src/ui/erd/erd-graph.ts` — ADD a pure, DOM-free `connectedNodeIds(edges: ReadonlyArray<ErdEdge>, hoveredId: string): ReadonlySet<string>` (near `tableId` **130-132** / the `ErdEdge` type **102-111**): start with `{ hoveredId }`, then for every edge where `source === hoveredId` add `target` and where `target === hoveredId` add `source` (a self-loop adds only `hoveredId` again — no phantom). Pure and total; never throws on an absent id (returns the singleton). No change to `schemaToGraph`, `applyLayout`, edge ids, `markerEnd`, `data`, or dagre positions. The tooltip needs NO new derivation — it reads the existing `ErdNodeData.columns` (`{ name, dataType, isPrimaryKey, isForeignKey }`, built at **244-249**).
- `src/ui/erd/erd-graph.test.ts` — ADD `connectedNodeIds` cases mirroring the I/O matrix: hover a table with FKs → self + neighbours; table with no FKs → singleton; self-referential FK → singleton (no phantom); composite FK → single neighbour once (not per column); an id absent from the edges → singleton/empty (confirm which in step-02). Existing `schemaToGraph`/`applyLayout` tests stay green (additive only).
- `src/ui/workspace/ErdTabView.tsx` — the primary change, all presentation-only:
  - Keep `hoveredNodeId` (**309**) and `handleNodeMouseEnter`/`handleNodeMouseLeave` (**372-377**) and the `<ReactFlow>` `onNodeMouseEnter`/`onNodeMouseLeave` wiring (**397-398**) — the hover seam is reused, not replaced.
  - Keep the existing edge overlay `useMemo` (**328-343**) verbatim (edge recolor).
  - ADD a `connected` set: `const connected = useMemo(() => hoveredNodeId ? connectedNodeIds(graph.edges, hoveredNodeId) : null, [graph.edges, hoveredNodeId])`.
  - ADD a derived `displayNodes` `useMemo` over the live controlled `nodes` (from `useNodesState`, **301**) that overlays a presentation-only `style`/`className` (e.g. dim `opacity`/muted for nodes NOT in `connected`; full-strength for those in it; no overlay when `hoveredNodeId === null`), preserving each node's `id`, `position`, `type`, and `data`. Feed `displayNodes` (not raw `nodes`) to `<ReactFlow nodes={…}>` (**392**) while `onNodesChange` still targets the underlying `nodes` so drag is unaffected (confirm this seam preserves the Story-4.1 error-#015 fix in step-02).
  - ADD a hover DETAIL panel: a new `<Panel position="top-left">` (or `top-right` — confirm no collision with `ErdToolbar` bottom-right **412-414** / `ErdLegend` bottom-left **415-417**) rendered only when `hoveredNodeId !== null`, that looks up the hovered node's `data` (`nodes.find(n => n.id === hoveredNodeId)?.data as ErdNodeData`) and lists its `columns` as `name : dataType` with the existing `KeyIcon` (`--t-key`, PK) / `LinkIcon` (`--t-int`, FK) glyphs (**57-74, 112-130**) and `--card`/`--border` surface. Factor a small `ErdHoverPanel` component beside `ErdToolbar`/`ErdLegend` (exported for a render test, mirroring `ErdTableNode`).
  - ADD the DW-66 reconcile: extend the graph-change effect (**319-322**) — or add a sibling effect — to `setHoveredNodeId(null)` when `hoveredNodeId` is not among the current node ids. This makes "node removed mid-hover" clear cleanly and closes DW-66.
  - Do NOT touch `report`/`handleNodeDragStop`/`handleMoveEnd`/`positionsRef`/`viewportRef`/`initialLayoutRef` (**278-370**) — layout persistence and pan/zoom are unchanged.
- `src/ui/workspace/ErdTabView.test.tsx` — EXTEND (renderToStaticMarkup, no jsdom — the project convention, **1-11**): the hover panel is gated on `hoveredNodeId !== null`, which is null at rest, so it does NOT appear in static output — keep the existing structural assertions green (panel absence at rest is correct). Add coverage for the hover PANEL by exporting `ErdHoverPanel` and rendering it directly with a sample `ErdNodeData` (assert it emits `aria-label="primary key"` / `aria-label="foreign key"` and the column/type text), mirroring how `ErdTableNode` markup is asserted today. The interactive hover transition itself is not unit-testable without a DOM (documented convention); the pure `connectedNodeIds` test carries the logic coverage.
- `src/ui/workspace/TabContent.tsx` — NO change: the `erd` branch (**548-560**) already passes `tables`, `savedLayout`, `onLayoutChange` and keys by `tab.id`; the hover feature is internal to `ErdTabView`.
- `src/shared/contract.ts` — NO change: `SchemaTableInfo.primaryKey` (**278**), `SchemaTableInfo.foreignKeys` (**280**), `SchemaColumnInfo` (**224-228**), and `SchemaForeignKeyInfo` (**254-259**) already carry every field the badges need; `ErdNodeData.columns` folds them (`pkSet`/`fkSet`, `erd-graph.ts:230-249`). No wire-type or RPC change.
- `src/ui/styles/globals.css` — likely NO new token: `--edge`/`--edge-hot` (**50-51, 152-153**), `--t-key`/`--t-int`, `--card`/`--border`/`--muted-foreground`/`--foreground` all exist and are already used by `ErdTabView`. If node dimming needs a dedicated muted value beyond `opacity`, reuse an existing token rather than adding one — confirm in step-02. (Be aware of DW-67: the panel's small type labels inherit the same sub-11px muted-on-tonal contrast risk — do not make it worse; ideally the roomier panel uses a legible size.)
- `design-artifacts/erd.html` — reference only (visual source of truth): its hover logic (`highlightFor(name)` **482-491**, `pointerenter`/`pointerleave` **479-480**) lights up FK edges only; the connected-table emphasis and the column detail panel are the NEW parts Story 9.5 adds on top of that prototype baseline.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors. New `connectedNodeIds` signature and the `displayNodes`/`ErdHoverPanel` additions must type-check against `ErdEdge`/`ErdNodeData` and React Flow's `Node`/`Panel` props.
- `bun test` — expected: full suite green. `src/ui/erd/erd-graph.test.ts` gains `connectedNodeIds` cases (hover-with-FKs, no-FK singleton, self-ref no-phantom, composite-once, absent-id); `src/ui/workspace/ErdTabView.test.tsx` gains an `ErdHoverPanel` render test and keeps its existing structural assertions. No existing assertion weakened.
- `bun run build` — expected: OK (regenerates the UI bundle with the hover panel + node-emphasis overlay; React Flow `<Panel>`/`useStore` already bundle).

**Live check (manual, per the epic fidelity gate at http://127.0.0.1:6061):**
- Launch against the seeded database (`docker/seed.sql` defines `orders.customer_id → customers(id)`), open a New ERD tab.
- Hover `orders`: confirm its FK edge to `customers` highlights, `orders` + `customers` stay full-strength while the other tables dim, and a detail panel lists `orders`' columns with a PK badge on `id` and an FK link badge on `customer_id`.
- Move the pointer off `orders`: confirm the highlight, dim, and panel all clear together with no residue.
- Hover a table with no FKs (only that node emphasised, no edges hot, panel with no FK badges) and, if reachable, a self-referential FK table (self-loop hot, only itself connected).
- Confirm pan, zoom, fit, node drag, and tab reload (layout persistence) are unchanged while hovering and after.

## Design Notes

- **Reuse the seam, add two overlays.** The edge recolor already proves the pattern: map over a derived array (`graph.edges`) adding `className`/`style` from `hoveredNodeId`, never mutating the source. Node emphasis is the same overlay onto `displayNodes`, and the connected-set is the only new *logic* — pushed into the pure `erd-graph.ts` so it is unit-tested without a DOM (the project has no jsdom; interactive hover is asserted only structurally). The tooltip is pure rendering of data already in hand — no new derivation, no Core call.
- **DW-66 is in-scope, not deferred.** The story explicitly demands "no stale highlight if the node set changes mid-hover," which is exactly DW-66. A one-line reconcile effect (clear `hoveredNodeId` when absent from the node ids) closes it. DW-65 (PK∩FK single badge) and DW-67 (sub-11px contrast) are adjacent and must not regress; the roomier hover panel is a natural place to surface both PK and FK badges (optional DW-65 win — confirm in step-02).
- **Uncertain seams flagged for step-02:** (1) exact React Flow mechanism for per-node dim/emphasis without breaking the controlled-nodes drag contract (derived `displayNodes` vs a `data` flag consumed by `ErdTableNode`); (2) the `<Panel>` slot for the detail panel that avoids the toolbar/legend; (3) whether the detail panel shows both badges for a PK∩FK column; (4) whether `connectedNodeIds` returns a singleton or empty set for an id absent from the edges. None invent new wire types or RPCs.
