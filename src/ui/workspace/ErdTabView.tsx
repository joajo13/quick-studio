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

import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { SchemaTableInfo } from "../../shared/contract.ts";
import { schemaToGraph, type ErdNodeData } from "../erd/erd-graph.ts";

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

export function ErdTabView({
  tables,
}: {
  /** App's lifted `allTables` (introspected + optimistically-created). */
  tables: ReadonlyArray<SchemaTableInfo>;
}): React.JSX.Element {
  const graph = useMemo(() => schemaToGraph(tables), [tables]);

  if (tables.length === 0) {
    return <ErdEmptyState />;
  }

  return (
    <div className="h-full w-full bg-[var(--background)]">
      <ReactFlow
        nodes={graph.nodes as unknown as never[]}
        edges={graph.edges as unknown as never[]}
        nodeTypes={NODE_TYPES}
        fitView
        // View-only (v1): no schema mutation through the diagram. The ERD supports
        // pan and zoom navigation only — no connections can be drawn, and node
        // rearrangement + layout persistence are out of scope for this story
        // (Story 4.2 owns node dragging and persistence). `nodesDraggable={false}`
        // is required: React Flow defaults it to `true`, and since `nodes` is a
        // controlled prop with no `onNodesChange`, leaving drag enabled both
        // contradicts the view-only scope and trips React Flow's error #015.
        nodesDraggable={false}
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
