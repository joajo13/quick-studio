/**
 * quick-studio UI (Ring 2) — ERD tab surface (Story 4.1 / 4.2; neutral redesign 7.4).
 *
 * A thin `<ReactFlow>` wrapper over the pure {@link schemaToGraph} model: it turns
 * App's already-lifted `allTables` (introspected tables + optimistically-created
 * ones) into a pannable / zoomable node-edge diagram — one node per table listing
 * its columns (PK / FK columns marked), one edge per real foreign key. View-only: no
 * schema mutation through the diagram, and NOTHING about the ERD or its layout is
 * ever written to disk beyond the Story 4.2 layout-persistence wiring.
 *
 * The graph derivation + dagre layout live in the pure, unit-tested `erd-graph.ts`;
 * this component only registers the custom node type, feeds React Flow, and layers
 * on presentation-only chrome (dot grid, hover edge highlight, zoom/fit toolbar,
 * type legend). Story 7.4 is a presentation-only port of `design-artifacts/erd.html`:
 * markup / class names / tokens / hover state change; derivation + persistence do not.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useNodesState,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps,
  type OnMoveEnd,
  type OnNodeDrag,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ErdTabLayout, SchemaTableInfo } from "../../shared/contract.ts";
import {
  applyLayout,
  connectedNodeIds,
  schemaToGraph,
  typeColorClass,
  type ErdNodeData,
} from "../erd/erd-graph.ts";

/* ---- inline glyphs (ported from design-artifacts/erd.html) ---- */

/** Table glyph in the node header. */
function TableIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[14px] w-[14px]">
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 9h18M9 9v11" />
    </svg>
  );
}

/** PK key glyph. */
function KeyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="h-[13px] w-[13px]">
      <circle cx="8" cy="8" r="4" />
      <path d="M11 11l6 6M14 14l2-2M16 16l2-2" strokeLinecap="round" />
    </svg>
  );
}

/** FK link glyph. */
function LinkIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="h-[13px] w-[13px]">
      <path d="M9 12a3 3 0 0 1 3-3h3M15 12a3 3 0 0 1-3 3H9" />
      <path d="M7 9H6a3 3 0 0 0 0 6h1M17 15h1a3 3 0 0 0 0-6h-1" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The custom table node: a neutral mono card (tonal surface + border) whose header is
 * a table glyph + the verbatim `schema.name`, and whose rows are `column : dataType`
 * with a PK ink-key / FK blue-link / hidden-spacer marker and a type-color-coded,
 * uppercased type label. Identifiers render VERBATIM — never renamed or normalized;
 * the uppercase type label is a CSS `text-transform` only. Exported for render tests.
 *
 * No row count is shown: the node `data` carries none, and per the 7.4 intent we do
 * NOT add a Core RPC / count query to synthesize one.
 */
export function ErdTableNode({ data }: NodeProps): React.JSX.Element {
  // React Flow's generic `NodeProps.data` is untyped; narrow to our payload.
  const node = data as unknown as ErdNodeData;
  return (
    <div
      className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--card)]"
      style={{ width: 240, fontFamily: "var(--font-mono)", fontSize: "12px" }}
    >
      {/* Target + source handles so FK edges (incl. self-loops) attach. */}
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--muted)] px-3 py-2">
        <span className="shrink-0 text-[var(--muted-foreground)]">
          <TableIcon />
        </span>
        <span className="truncate text-[12.5px] font-semibold text-[var(--foreground)]">
          {node.label}
        </span>
      </div>
      <div className="flex flex-col">
        {node.columns.map((c) => {
          const typeClass = typeColorClass(c.dataType);
          return (
            <div
              key={c.name}
              className="flex min-w-0 items-center gap-2 border-t border-[var(--border)] px-3 py-1 first:border-t-0"
            >
              {c.isPrimaryKey ? (
                <span
                  aria-label="primary key"
                  title="primary key"
                  className="inline-flex shrink-0 text-[var(--t-key)]"
                >
                  <KeyIcon />
                </span>
              ) : c.isForeignKey ? (
                <span
                  aria-label="foreign key"
                  title="foreign key"
                  className="inline-flex shrink-0 text-[var(--t-int)]"
                >
                  <LinkIcon />
                </span>
              ) : (
                <span aria-hidden className="inline-block h-[13px] w-[13px] shrink-0" />
              )}
              <span
                className={
                  c.isPrimaryKey
                    ? "min-w-0 truncate font-semibold text-[var(--foreground)]"
                    : "min-w-0 truncate text-[var(--muted-foreground)]"
                }
              >
                {c.name}
              </span>
              <span
                className={`ml-auto max-w-[55%] shrink-0 truncate text-[10px] uppercase tracking-[0.04em] ${typeClass}`}
                style={{ color: `var(--${typeClass})` }}
              >
                {c.dataType}
              </span>
            </div>
          );
        })}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

/** Registered once (stable identity) so React Flow does not warn about a new object each render. */
const NODE_TYPES = { erdTable: ErdTableNode };

/** The empty-state shown when the connected schema has zero tables. */
function ErdEmptyState(): React.JSX.Element {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center lowercase text-[var(--muted-foreground)]"
      style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
    >
      <div>no tables to diagram</div>
      <p className="max-w-sm text-[11px]">
        connect to a database with tables, or create one, to see the entity-relationship diagram.
      </p>
    </div>
  );
}

/**
 * Bottom-right zoom-out / `%` / zoom-in / fit toolbar. Replaces React Flow's default
 * bottom-left `<Controls>`; pan/zoom/fit still come from the untouched `<ReactFlow>`
 * viewport — this only drives it via `useReactFlow` and reads the live zoom for the %.
 */
function ErdToolbar(): React.JSX.Element {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const pct = `${Math.round(zoom * 100)}%`;
  return (
    <div
      className="flex items-center gap-1 rounded-[10px] border border-[var(--border)] bg-[var(--card)] p-1"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => zoomOut()}
        className="grid h-[30px] w-[30px] place-items-center rounded-[7px] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
          <path d="M5 12h14" />
        </svg>
      </button>
      <span className="min-w-[44px] text-center text-[11px] tabular-nums text-[var(--muted-foreground)]">
        {pct}
      </span>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => zoomIn()}
        className="grid h-[30px] w-[30px] place-items-center rounded-[7px] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <span className="mx-0.5 h-5 w-px bg-[var(--border)]" />
      <button
        type="button"
        aria-label="Fit to screen"
        title="Fit to screen"
        onClick={() => fitView()}
        className="grid h-[30px] w-[30px] place-items-center rounded-[7px] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
          <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
        </svg>
      </button>
    </div>
  );
}

/** Bottom-left data-type legend — the same functional colors used on the column labels. */
function ErdLegend(): React.JSX.Element {
  const items: ReadonlyArray<readonly [string, string]> = [
    ["var(--t-int)", "int"],
    ["var(--t-num)", "numeric"],
    ["var(--t-time)", "timestamp"],
    ["var(--t-enum)", "enum"],
    ["var(--t-text)", "text"],
  ];
  return (
    <div
      className="flex items-center gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-3 py-[7px] text-[10.5px] text-[var(--muted-foreground)]"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {items.map(([color, label]) => (
        <span key={label} className="inline-flex items-center gap-[5px]">
          <span className="h-[9px] w-[9px] rounded-[2px]" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * The `top-left` hover detail panel (Story 9.5): a roomy readout of the hovered
 * table's columns as `name : dataType` with PK / FK badges, sourced ENTIRELY from the
 * `ErdNodeData.columns` the node already carries (no new schema derivation, no Core
 * call). It reuses the same `KeyIcon`/`LinkIcon` glyphs and `--t-key`/`--t-int` badge
 * colours as the node rows, on the same `--card`/`--border` surface the toolbar/legend
 * use. Unlike the compact node row (a mutually-exclusive PK-wins chain), a PK∩FK column
 * here shows BOTH badges — the roomier layout closes DW-65 without touching the row.
 * Column names render at the panel's 12px mono base; the data-type label is 10.5px — at or
 * above the node-row's own type size, so DW-67's sub-11px muted-on-tonal contrast risk is
 * not worsened relative to the node rows (this panel does not fix DW-67, only avoids making
 * it worse). Exported for isolated render tests.
 */
export function ErdHoverPanel({ data }: { data: ErdNodeData }): React.JSX.Element {
  return (
    <div
      className="max-h-[70vh] w-[260px] overflow-auto rounded-[10px] border border-[var(--border)] bg-[var(--card)]"
      style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--muted)] px-3 py-2">
        <span className="shrink-0 text-[var(--muted-foreground)]">
          <TableIcon />
        </span>
        <span className="truncate text-[12.5px] font-semibold text-[var(--foreground)]">
          {data.label}
        </span>
      </div>
      <div className="flex flex-col">
        {data.columns.map((c) => {
          const typeClass = typeColorClass(c.dataType);
          return (
            <div
              key={c.name}
              className="flex min-w-0 items-center gap-2 border-t border-[var(--border)] px-3 py-1 first:border-t-0"
            >
              <span className="inline-flex w-[30px] shrink-0 items-center gap-1">
                {c.isPrimaryKey && (
                  <span
                    aria-label="primary key"
                    title="primary key"
                    className="inline-flex shrink-0 text-[var(--t-key)]"
                  >
                    <KeyIcon />
                  </span>
                )}
                {c.isForeignKey && (
                  <span
                    aria-label="foreign key"
                    title="foreign key"
                    className="inline-flex shrink-0 text-[var(--t-int)]"
                  >
                    <LinkIcon />
                  </span>
                )}
                {!c.isPrimaryKey && !c.isForeignKey && (
                  <span aria-hidden className="inline-block h-[13px] w-[13px] shrink-0" />
                )}
              </span>
              <span
                className={
                  c.isPrimaryKey
                    ? "min-w-0 truncate font-semibold text-[var(--foreground)]"
                    : "min-w-0 truncate text-[var(--muted-foreground)]"
                }
              >
                {c.name}
              </span>
              <span
                className={`ml-auto max-w-[55%] shrink-0 truncate text-[10.5px] uppercase tracking-[0.04em] ${typeClass}`}
                style={{ color: `var(--${typeClass})` }}
              >
                {c.dataType}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Build the id→position map the layout report persists, from the live node array. */
function positionsOf(nodes: ReadonlyArray<Node>): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) positions[n.id] = { x: n.position.x, y: n.position.y };
  return positions;
}

export function ErdTabView({
  tables,
  savedLayout,
  onLayoutChange,
}: {
  /** App's lifted `allTables` (introspected + optimistically-created). */
  tables: ReadonlyArray<SchemaTableInfo>;
  /**
   * The persisted geometry for THIS ERD tab (Story 4.2), or undefined to fall back to
   * dagre. Read ONCE at mount (the tab is keyed by tab id, so it remounts per tab):
   * later changes — which flow back down after our own `onLayoutChange` — must NOT
   * reset the canvas, so mount-time values are captured in refs.
   */
  savedLayout?: ErdTabLayout;
  /** Report captured geometry (positions + viewport) up for the debounced persist. */
  onLayoutChange?: (layout: ErdTabLayout) => void;
}): React.JSX.Element {
  // Mount-time saved layout, frozen so the feedback (App → savedLayout → here) after our
  // own reports can never reset positions or re-fit the viewport mid-session.
  const initialLayoutRef = useRef(savedLayout);
  // All positions known this session (seeded from the saved layout, updated on drag stop)
  // — the overlay source when `tables` changes, so already-placed nodes stay put while a
  // NEW table gets a fresh dagre position. A ref (not state): mutating it must not itself
  // re-derive the graph (that happens only on a `tables` change).
  const positionsRef = useRef<Record<string, { x: number; y: number }>>(
    initialLayoutRef.current?.positions ?? {},
  );
  // Latest viewport, seeded from the saved one, updated on move end — reported alongside
  // positions so a pan/zoom persists too.
  const viewportRef = useRef<Viewport | undefined>(initialLayoutRef.current?.viewport);

  // Overlay saved/dragged positions onto the dagre graph. Recomputed only when `tables`
  // changes (add/remove a table); at that point `positionsRef` already holds every
  // dragged position, so existing nodes keep theirs and only new tables are auto-placed.
  const graph = useMemo(
    () => applyLayout(schemaToGraph(tables), positionsRef.current),
    [tables],
  );

  // React Flow needs `onNodesChange` for `nodesDraggable` to be safe (Story 4.1 disabled
  // dragging precisely because `nodes` was controlled with no change handler → error #015).
  // `useNodesState` supplies exactly that handler.
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes as unknown as Node[]);
  // Mirror the live nodes into a ref so drag/move handlers read the freshest positions
  // without being re-created on every node change.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Presentation-only hover state: which table node the pointer is over. Drives the
  // relationship-edge highlight WITHOUT touching the derived `edges` array shape or ids.
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Reconcile drag state with `tables` changes (and seed on mount): when the derived
  // graph changes (mount, or a table created/removed), push the freshly-overlaid node
  // set (existing nodes keep their dragged/saved position; new tables get dagre) into
  // React Flow's controlled state AND snapshot every on-screen position back into
  // `positionsRef`. Re-seeding the ref on every graph — not just at mount — is what keeps
  // a SECOND consecutive create from reshuffling: after the first create, the auto-placed
  // new node's dagre position is captured here, so the next `schemaToGraph` re-dagre is
  // overlaid away for it too and only the newest table gets a fresh spot.
  useEffect(() => {
    setNodes(graph.nodes as unknown as Node[]);
    positionsRef.current = positionsOf(graph.nodes as unknown as Node[]);
  }, [graph, setNodes]);

  // DW-66 reconcile: if the hovered id is no longer among the current node ids (its
  // table was dropped mid-hover with no `mouseleave`), clear the hover so the edge
  // recolor, node dim, and detail panel all release — and a later table reusing the
  // same `tableId` is never spuriously highlighted. Presentation-only; touches no layout.
  useEffect(() => {
    if (hoveredNodeId !== null && !nodes.some((n) => n.id === hoveredNodeId)) {
      setHoveredNodeId(null);
    }
  }, [nodes, hoveredNodeId]);

  // Presentation-only: overlay a `className`/`style` onto each already-derived edge so
  // the ones touching the hovered node render `--edge-hot` (blue) and the rest `--edge`.
  // The edge ids, `markerEnd`, `data`, source/target, and order are all preserved — this
  // maps 1:1 over `graph.edges` without rebuilding or reordering it.
  const edges = useMemo(
    () =>
      graph.edges.map((e) => {
        const hot =
          hoveredNodeId !== null && (e.source === hoveredNodeId || e.target === hoveredNodeId);
        return {
          ...e,
          className: hot ? "erd-edge-hot" : "erd-edge",
          style: {
            stroke: hot ? "var(--edge-hot)" : "var(--edge)",
            strokeWidth: hot ? 2 : 1.5,
          },
        };
      }),
    [graph.edges, hoveredNodeId],
  );

  // The connected-node set for the hovered table (itself + FK neighbours), from the pure,
  // unit-tested helper. `null` when nothing is hovered OR when the hovered id is not (yet /
  // no longer) present among `nodes` → no dim overlay. The presence check keeps this in step
  // with the panel's own `nodes.find` guard, so when the hovered table is dropped mid-hover
  // the dim releases in the SAME render the panel does — no one-frame "whole canvas dimmed"
  // flash before the DW-66 effect fires. Derived from `graph.edges`; never mutates the graph.
  const connected = useMemo(
    () =>
      hoveredNodeId !== null && nodes.some((n) => n.id === hoveredNodeId)
        ? connectedNodeIds(graph.edges, hoveredNodeId)
        : null,
    [graph.edges, hoveredNodeId, nodes],
  );

  // Presentation-only node overlay (mirrors the edge overlay above). At rest
  // (`connected === null`) return the controlled `nodes` array VERBATIM — same reference,
  // no per-node object churn on every drag frame, and React Flow's internal diff + drag are
  // wholly undisturbed. Only while hovering do we build overlay objects: spread each node
  // through (preserving `id`/`position`/`type`/`data`) and add ONLY `style.opacity` —
  // full-strength for connected nodes, dimmed for the rest. Fed to `<ReactFlow nodes={…}>`
  // while `onNodesChange` still targets the underlying controlled `nodes` (error-#015
  // contract intact), and drag-stop persistence keeps reading `nodesRef`/`nodes`.
  const displayNodes = useMemo(
    () =>
      connected === null
        ? nodes
        : nodes.map((n) => ({
            ...n,
            style: { ...n.style, opacity: connected.has(n.id) ? 1 : 0.4 },
          })),
    [nodes, connected],
  );

  // Report the full captured layout (positions + viewport) up for the debounced persist,
  // and keep `positionsRef` current so a later `tables` change overlays the latest spots.
  const report = useCallback((): void => {
    const positions = positionsOf(nodesRef.current);
    positionsRef.current = positions;
    const layout: ErdTabLayout =
      viewportRef.current !== undefined
        ? { positions, viewport: viewportRef.current }
        : { positions };
    onLayoutChange?.(layout);
  }, [onLayoutChange]);

  // Capture node positions when a drag ends (not on every intermediate change).
  const handleNodeDragStop: OnNodeDrag = useCallback(() => report(), [report]);
  // Capture the viewport when a pan/zoom ends. React Flow fires `onMoveEnd` for
  // PROGRAMMATIC viewport changes too — notably the mount-time `fitView` — passing a
  // null event; only real user gestures carry an event. Ignore the programmatic ones so
  // opening a tab never self-persists a viewport the developer never chose.
  const handleMoveEnd: OnMoveEnd = useCallback(
    (event, viewport) => {
      if (event == null) return;
      viewportRef.current = viewport;
      report();
    },
    [report],
  );

  // Presentation-only hover handlers (Story 7.4): highlight a hovered table's FK edges.
  const handleNodeMouseEnter = useCallback(
    (_event: React.MouseEvent, node: Node) => setHoveredNodeId(node.id),
    [],
  );
  const handleNodeMouseLeave = useCallback(() => setHoveredNodeId(null), []);

  if (tables.length === 0) {
    return <ErdEmptyState />;
  }

  // Restore the saved viewport via `defaultViewport` (read once by React Flow at mount)
  // and disable `fitView` when a viewport was saved, so a restored pan/zoom is honored
  // instead of auto-fitting. With no saved viewport we fit to the (possibly restored)
  // node positions so everything — including dragged nodes — is on screen.
  const initialViewport = initialLayoutRef.current?.viewport;

  return (
    <div className="h-full w-full bg-[var(--background)]">
      <ReactFlow
        nodes={displayNodes}
        edges={edges as unknown as never[]}
        onNodesChange={onNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onMoveEnd={handleMoveEnd}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        nodeTypes={NODE_TYPES}
        fitView={initialViewport === undefined}
        defaultViewport={initialViewport}
        // Story 4.2 enables node dragging so a developer can rearrange the diagram and
        // have it persist. Dragging is safe now because `onNodesChange` is wired (see
        // above). Still VIEW-ONLY otherwise: no connections drawn, no selection — the
        // schema is never mutated through the diagram (editing is v2).
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} color="var(--border)" />
        {hoveredNodeId !== null &&
          (() => {
            // Look up the hovered node's data in the live node array. Guarded on presence
            // so a just-reconciled (DW-66) id never renders a stale panel.
            const hoveredData = nodes.find((n) => n.id === hoveredNodeId)?.data as
              | ErdNodeData
              | undefined;
            return hoveredData ? (
              <Panel position="top-left">
                <ErdHoverPanel data={hoveredData} />
              </Panel>
            ) : null;
          })()}
        <Panel position="bottom-right">
          <ErdToolbar />
        </Panel>
        <Panel position="bottom-left">
          <ErdLegend />
        </Panel>
      </ReactFlow>
    </div>
  );
}
