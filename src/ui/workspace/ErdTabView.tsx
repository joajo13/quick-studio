/**
 * quick-studio UI (Ring 2) — ERD tab surface (Story 4.1).
 *
 * A thin `<ReactFlow>` wrapper over the pure {@link schemaToGraph} model: it turns
 * App's already-lifted `allTables` (introspected tables + optimistically-created
 * ones) into a pannable / zoomable node-edge diagram — one node per table listing
 * its columns (PK columns marked), one edge per real foreign key. View-only: no
 * schema mutation through the diagram, and NOTHING about the ERD or its layout is
 * ever written to disk (layout persistence is Story 4.2).
 *
 * The graph derivation + dagre layout live in the pure, unit-tested `erd-graph.ts`;
 * this component only registers the custom node type and feeds React Flow. The
 * custom node ({@link ErdTableNode}) is exported so its presentational structure is
 * testable via `renderToStaticMarkup` without mounting the (DOM-measuring) canvas.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useNodesState,
  type Node,
  type NodeProps,
  type OnMoveEnd,
  type OnNodeDrag,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ErdTabLayout, SchemaTableInfo } from "../../shared/contract.ts";
import { applyLayout, schemaToGraph, type ErdNodeData } from "../erd/erd-graph.ts";

/**
 * The custom table node: a dark, tool-like card (tonal surface + border, no
 * drop-shadow, per the shadcn-style aesthetic) whose header is `schema.name` and
 * whose rows are `column : dataType`, with PK columns marked. Identifiers render
 * VERBATIM — never renamed or normalized. Exported for direct render tests.
 */
export function ErdTableNode({ data }: NodeProps): React.JSX.Element {
  // React Flow's generic `NodeProps.data` is untyped; narrow to our payload.
  const node = data as unknown as ErdNodeData;
  return (
    <div
      className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)]"
      style={{ width: 240, fontFamily: "var(--font-mono)", fontSize: "12px" }}
    >
      {/* Target + source handles so FK edges (incl. self-loops) attach. */}
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="border-b border-[var(--border)] bg-[var(--muted)] px-2 py-1 text-[var(--foreground)]">
        {node.label}
      </div>
      <div className="flex flex-col">
        {node.columns.map((c) => (
          <div
            key={c.name}
            className="flex items-center gap-2 px-2 py-0.5 text-[var(--muted-foreground)]"
          >
            {c.isPrimaryKey ? (
              <span aria-label="primary key" title="primary key" className="text-[var(--t-key)]">
                🔑
              </span>
            ) : (
              <span aria-hidden className="inline-block w-[1em]" />
            )}
            <span className="text-[var(--foreground)]">{c.name}</span>
            <span className="ml-auto text-[var(--t-text)]">{c.dataType}</span>
          </div>
        ))}
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
        nodes={nodes}
        edges={graph.edges as unknown as never[]}
        onNodesChange={onNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onMoveEnd={handleMoveEnd}
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
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
