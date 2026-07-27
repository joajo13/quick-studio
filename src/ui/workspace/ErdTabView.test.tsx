/**
 * quick-studio UI (Ring 2) — ErdTabView render tests (Story 4.1).
 *
 * Pure, DOM-free render tests in the project convention (no jsdom / testing-library;
 * see `IndexList.test.tsx`). The graph-derivation logic is exhaustively covered by
 * `erd-graph.test.ts`; here we assert the tab's STRUCTURE via `renderToStaticMarkup`:
 * the empty-state renders for a zero-table schema, and a sample schema renders its
 * table names, columns (PK marked), and at least one FK edge. React Flow renders its
 * node content synchronously (it provides its own context), so the custom node's
 * markup is present in the static output even without a live DOM.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SchemaTableInfo } from "../../shared/contract.ts";
import type { ErdNodeData } from "../erd/erd-graph.ts";
import { schemaToGraph, tableId } from "../erd/erd-graph.ts";
import {
  erdEdgeOverlay,
  erdEdgeStyle,
  erdHoverPanelData,
  ErdHoverPanel,
  ErdTabView,
} from "./ErdTabView.tsx";

// DW-44: a schema whose FK points outside the introspected set (`ghost` is never
// listed) — used by both the external-node render test and (implicitly, via
// `ErdTabView`) proves the dashed edge never crashes the surface.
const EXTERNAL_SAMPLE: SchemaTableInfo[] = [
  {
    schema: "public",
    name: "orders",
    columns: [
      { name: "id", dataType: "integer", nullable: false },
      { name: "ghost_id", dataType: "integer", nullable: false },
    ],
    primaryKey: ["id"],
    indexes: [],
    foreignKeys: [
      { columns: ["ghost_id"], referencedSchema: "public", referencedTable: "ghost", referencedColumns: ["id"] },
    ],
  },
];

// DW-65: a join/junction table shape with a plain PK, a plain (non-key) column, a
// plain FK, and a PK∩FK identifying-relationship column — the case the compact node
// row's old mutually-exclusive badge ternary lost the FK cue on.
const JOIN_SAMPLE: SchemaTableInfo[] = [
  {
    schema: "public",
    name: "order_items",
    columns: [
      { name: "id", dataType: "integer", nullable: false },
      { name: "note", dataType: "text", nullable: true },
      { name: "product_id", dataType: "integer", nullable: false },
      { name: "order_id", dataType: "bigint", nullable: false },
    ],
    primaryKey: ["id", "order_id"],
    indexes: [],
    foreignKeys: [
      { columns: ["product_id"], referencedSchema: "public", referencedTable: "products", referencedColumns: ["id"] },
      { columns: ["order_id"], referencedSchema: "public", referencedTable: "orders", referencedColumns: ["id"] },
    ],
  },
];

const SAMPLE: SchemaTableInfo[] = [
  {
    schema: "public",
    name: "orders",
    columns: [
      { name: "id", dataType: "integer", nullable: false },
      { name: "user_id", dataType: "integer", nullable: false },
    ],
    primaryKey: ["id"],
    indexes: [],
    foreignKeys: [
      { columns: ["user_id"], referencedSchema: "public", referencedTable: "users", referencedColumns: ["id"] },
    ],
  },
  {
    schema: "public",
    name: "users",
    columns: [{ name: "id", dataType: "integer", nullable: false }],
    primaryKey: ["id"],
    indexes: [],
    foreignKeys: [],
  },
];

describe("ErdTabView", () => {
  test("a zero-table schema renders the empty-state (nothing crashes)", () => {
    const out = renderToStaticMarkup(<ErdTabView tables={[]} />);
    expect(out).toContain("no tables to diagram");
  });

  test("a sample schema renders each table's name", () => {
    const out = renderToStaticMarkup(<ErdTabView tables={SAMPLE} />);
    expect(out).toContain("public.orders");
    expect(out).toContain("public.users");
  });

  test("a sample schema renders columns with the PK column marked", () => {
    const out = renderToStaticMarkup(<ErdTabView tables={SAMPLE} />);
    expect(out).toContain("user_id");
    expect(out).toContain("integer");
    // PK marker for the primary-key column (neutral key badge replaced the 🔑 emoji).
    expect(out).toContain('aria-label="primary key"');
  });

  test("a foreign-key column renders the FK link badge", () => {
    const out = renderToStaticMarkup(<ErdTabView tables={SAMPLE} />);
    // `orders.user_id` is the FK/int column in SAMPLE.
    expect(out).toContain('aria-label="foreign key"');
  });

  test("a column's type label carries the mapped type-color class", () => {
    const out = renderToStaticMarkup(<ErdTabView tables={SAMPLE} />);
    // `integer` maps to the `t-int` family via typeColorClass.
    expect(out).toContain("t-int");
  });

  test("a foreign key renders at least one edge in the canvas", () => {
    const out = renderToStaticMarkup(<ErdTabView tables={SAMPLE} />);
    expect(out).toContain("react-flow__edge");
  });

  // SCOPE NOTE: `renderToStaticMarkup` never runs effects and never measures a canvas, so
  // these are SMOKE tests — they prove the saved-layout props are accepted and the surface
  // still renders, NOT that any position was applied. The layout correctness surface is the
  // pure `applyLayout` / `positionsOf` / `reconcilePositions` / `sanitizeViewport` helpers in
  // `erd-graph.ts`, which are unit-tested directly (there is no jsdom in this repo, by
  // convention). Do not read a green run here as coverage of the capture/reconcile paths.
  test("a supplied saved layout still renders each table's name (props accepted, no crash)", () => {
    // Keys MUST be the real NUL-separated `tableId` node ids — a space-separated literal
    // never matches, so the overlay would silently no-op and the test would prove nothing.
    const savedLayout = {
      positions: {
        [tableId("public", "orders")]: { x: 100, y: 200 },
        [tableId("public", "users")]: { x: 300, y: 400 },
      },
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const out = renderToStaticMarkup(<ErdTabView tables={SAMPLE} savedLayout={savedLayout} />);
    expect(out).toContain("public.orders");
    expect(out).toContain("public.users");
  });

  test("an empty schema with a saved layout still renders the empty-state", () => {
    const out = renderToStaticMarkup(
      <ErdTabView tables={[]} savedLayout={{ positions: { [tableId("public", "orders")]: { x: 1, y: 2 } } }} />,
    );
    expect(out).toContain("no tables to diagram");
  });

  test("the hover panel is absent at rest (gated on hoveredNodeId; only toolbar + legend panels)", () => {
    // The interactive hover transition needs a live DOM (documented convention); at rest
    // `hoveredNodeId` is null so no top-left detail panel is emitted — only the two bottom
    // panels (toolbar, legend) render. React Flow splits a `position` into space-separated
    // classes, so a `top-left` panel would add a `top` class; none appears at rest.
    const out = renderToStaticMarkup(<ErdTabView tables={SAMPLE} />);
    const panelCount = out.split("react-flow__panel").length - 1;
    expect(panelCount).toBe(2);
  });
});

describe("ErdHoverPanel — hovered-table column detail (Story 9.5)", () => {
  // A join-table shape: a plain PK column, a plain FK column, and a PK∩FK column.
  const DATA: ErdNodeData = {
    schema: "public",
    name: "order_items",
    label: "public.order_items",
    columns: [
      { name: "id", dataType: "integer", isPrimaryKey: true, isForeignKey: false },
      { name: "note", dataType: "text", isPrimaryKey: false, isForeignKey: false },
      { name: "product_id", dataType: "integer", isPrimaryKey: false, isForeignKey: true },
      { name: "order_id", dataType: "bigint", isPrimaryKey: true, isForeignKey: true },
    ],
  };

  test("renders the table label and each column name : dataType", () => {
    const out = renderToStaticMarkup(<ErdHoverPanel data={DATA} />);
    expect(out).toContain("public.order_items");
    expect(out).toContain("product_id");
    expect(out).toContain("order_id");
    expect(out).toContain("bigint");
    expect(out).toContain("integer");
  });

  test("renders PK and FK badges", () => {
    const out = renderToStaticMarkup(<ErdHoverPanel data={DATA} />);
    expect(out).toContain('aria-label="primary key"');
    expect(out).toContain('aria-label="foreign key"');
  });

  test("a PK∩FK column surfaces BOTH badges (DW-65 closed in the panel)", () => {
    // `order_id` is both PK and FK; the roomy panel shows both glyphs (unlike the compact
    // node row's PK-wins chain). Count both aria-labels: the FK-only `product_id` gives
    // one FK badge, `order_id` gives a second — so >=2 FK badges proves order_id shows FK.
    const out = renderToStaticMarkup(<ErdHoverPanel data={DATA} />);
    const pkBadges = out.split('aria-label="primary key"').length - 1;
    const fkBadges = out.split('aria-label="foreign key"').length - 1;
    // `id` (PK) + `order_id` (PK∩FK) → 2 PK badges; `product_id` (FK) + `order_id` → 2 FK.
    expect(pkBadges).toBe(2);
    expect(fkBadges).toBe(2);
  });

  test("a column-less external node renders NO column rows (no crash on empty data.columns)", () => {
    // The DW-44 shape: an `erdExternal` node's data carries no columns at all.
    const EXTERNAL_DATA: ErdNodeData = {
      schema: "public",
      name: "ghost",
      label: "public.ghost",
      columns: [],
    };
    const out = renderToStaticMarkup(<ErdHoverPanel data={EXTERNAL_DATA} />);
    expect(out).toContain("public.ghost");
    // No column row was rendered, so neither badge (nor any column name) appears.
    expect(out).not.toContain('aria-label="primary key"');
    expect(out).not.toContain('aria-label="foreign key"');
  });
});

describe("ErdTableNode row — dual PK+FK badges (DW-65) via ErdTabView", () => {
  test("a PK∩FK column's row shows BOTH the PK and FK badges, other rows stay aligned", () => {
    const out = renderToStaticMarkup(<ErdTabView tables={JOIN_SAMPLE} />);
    const pkBadges = out.split('aria-label="primary key"').length - 1;
    const fkBadges = out.split('aria-label="foreign key"').length - 1;
    // `id` (PK only) + `order_id` (PK∩FK) → 2 PK badges.
    // `product_id` (FK only) + `order_id` (PK∩FK) → 2 FK badges.
    expect(pkBadges).toBe(2);
    expect(fkBadges).toBe(2);
    // Every column name still renders, proving the fixed badge slot didn't drop a row.
    expect(out).toContain("note");
    expect(out).toContain("product_id");
    expect(out).toContain("order_id");
  });
});

describe("ErdExternalNode — DW-44 out-of-scope FK target", () => {
  test("an FK to an absent table renders a dashed external node naming the target verbatim", () => {
    const out = renderToStaticMarkup(<ErdTabView tables={EXTERNAL_SAMPLE} />);
    // The real table still renders normally.
    expect(out).toContain("public.orders");
    // The external node renders the verbatim target namespace + table.
    expect(out).toContain("public.ghost");
    // P1: a VISIBLE caption marks the card as an out-of-scope reference — legible to a
    // sighted user who cannot resolve the dashed border, not just to a screen reader
    // (the old hand-rolled `aria-label` this replaces was invisible text-only).
    expect(out).toContain("external reference");
  });

  // P2: the old assertion here (`expect(out).toContain("react-flow__edge")`) was
  // vacuously true — React Flow renders `<div class="react-flow__edges">`
  // UNCONDITIONALLY, and "react-flow__edge" is a substring of that wrapper's own class,
  // so the check passed even for a table set with ZERO foreign keys. The relationship-
  // never-dropped guarantee is instead verified at the derivation + style layer, which
  // CAN fail: the edge exists, targets the external node, and is flagged for the dashed
  // treatment.
  // SCOPE NOTE: `renderToStaticMarkup` never runs layout and never paints an edge
  // `<path>` (no DOM measurement), so edge *painting* is verified here — at the
  // derivation/style layer — rather than by grepping rendered markup.
  test("the external edge is never dropped and is flagged for the dashed stroke treatment", () => {
    const graph = schemaToGraph(EXTERNAL_SAMPLE);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.data.isExternal).toBe(true);
    expect(
      erdEdgeStyle({ hot: false, isExternal: graph.edges[0]!.data.isExternal }).strokeDasharray,
    ).toBe("6 4");
  });
});

describe("erdEdgeStyle — pure edge stroke treatment (P3)", () => {
  test("cold, in-scope edge: --edge / 1.5, no dasharray", () => {
    expect(erdEdgeStyle({ hot: false, isExternal: false })).toEqual({
      stroke: "var(--edge)",
      strokeWidth: 1.5,
    });
  });

  test("hot, in-scope edge: --edge-hot / 2, no dasharray", () => {
    expect(erdEdgeStyle({ hot: true, isExternal: false })).toEqual({
      stroke: "var(--edge-hot)",
      strokeWidth: 2,
    });
  });

  test("cold, external edge: --edge / 1.5, dasharray present", () => {
    expect(erdEdgeStyle({ hot: false, isExternal: true })).toEqual({
      stroke: "var(--edge)",
      strokeWidth: 1.5,
      strokeDasharray: "6 4",
    });
  });

  test("hot, external edge: --edge-hot / 2, dasharray present", () => {
    expect(erdEdgeStyle({ hot: true, isExternal: true })).toEqual({
      stroke: "var(--edge-hot)",
      strokeWidth: 2,
      strokeDasharray: "6 4",
    });
  });
});

// P15: `erdEdgeStyle` alone left the seam that MATTERS untested — the wiring that feeds
// it `e.data.isExternal` and computes `hot`. Replacing that argument with a literal
// `false` kept the whole suite green, so the dashed treatment's only real evidence was
// still a source read. These exercise the mapping itself.
describe("erdEdgeOverlay — the hover/dashed wiring over the derived edges (P15)", () => {
  const ORDERS = tableId("public", "orders");
  const GHOST = tableId("public", "ghost");

  test("nothing hovered: every edge is cold, and the external one is still dashed", () => {
    const graph = schemaToGraph(EXTERNAL_SAMPLE);
    const [edge] = erdEdgeOverlay(graph.edges, null);
    expect(edge?.className).toBe("erd-edge");
    expect(edge?.style).toEqual({
      stroke: "var(--edge)",
      strokeWidth: 1.5,
      strokeDasharray: "6 4",
    });
  });

  test("hovering the SOURCE table heats its edge and keeps the dash (both flags wired)", () => {
    const graph = schemaToGraph(EXTERNAL_SAMPLE);
    const [edge] = erdEdgeOverlay(graph.edges, ORDERS);
    expect(edge?.className).toBe("erd-edge-hot");
    expect(edge?.style).toEqual({
      stroke: "var(--edge-hot)",
      strokeWidth: 2,
      strokeDasharray: "6 4",
    });
  });

  test("hovering the external TARGET also heats the edge (target side of the comparison)", () => {
    const graph = schemaToGraph(EXTERNAL_SAMPLE);
    expect(erdEdgeOverlay(graph.edges, GHOST)[0]?.className).toBe("erd-edge-hot");
  });

  // `SAMPLE` is the fully in-scope pair (orders -> users, both introspected), so nothing
  // in it may come out dashed — the assertion a hardcoded `isExternal: true` would fail.
  test("an in-scope edge never gets a dasharray — the isExternal argument is really read", () => {
    const graph = schemaToGraph(SAMPLE);
    const overlaid = erdEdgeOverlay(graph.edges, null);
    expect(overlaid.length).toBeGreaterThan(0);
    expect(overlaid.every((e) => e.style.strokeDasharray === undefined)).toBe(true);
  });

  test("ids, source/target, data and ORDER pass through untouched (a 1:1 overlay)", () => {
    const graph = schemaToGraph(JOIN_SAMPLE);
    const overlaid = erdEdgeOverlay(graph.edges, ORDERS);
    expect(overlaid.map((e) => e.id)).toEqual(graph.edges.map((e) => e.id));
    expect(overlaid.map((e) => e.target)).toEqual(graph.edges.map((e) => e.target));
    expect(overlaid.map((e) => e.data)).toEqual(graph.edges.map((e) => e.data));
  });
});

// P15: the panel-suppression rules are new production behaviour reachable only through a
// real pointer hover, which `renderToStaticMarkup` cannot produce — so before this they
// had no coverage at all, while the only related test drove `ErdHoverPanel` directly with
// a shape the canvas can no longer hand it.
describe("erdHoverPanelData — which hovered node gets a panel (P15)", () => {
  const ORDERS_DATA: ErdNodeData = {
    schema: "public",
    name: "orders",
    label: "public.orders",
    columns: [{ name: "id", dataType: "integer", isPrimaryKey: true, isForeignKey: false }],
  };
  const GHOST_DATA: ErdNodeData = {
    schema: "public",
    name: "ghost",
    label: "public.ghost",
    columns: [],
  };
  const NODES = [
    { id: tableId("public", "orders"), type: "erdTable", data: ORDERS_DATA },
    { id: tableId("public", "ghost"), type: "erdExternal", data: GHOST_DATA },
  ];

  test("nothing hovered: no panel", () => {
    expect(erdHoverPanelData(NODES, null)).toBeNull();
  });

  test("a hovered real table: its data, for the panel to render", () => {
    expect(erdHoverPanelData(NODES, tableId("public", "orders"))).toEqual(ORDERS_DATA);
  });

  test("a hovered DW-44 external node: no panel at all (not an empty one)", () => {
    expect(erdHoverPanelData(NODES, tableId("public", "ghost"))).toBeNull();
  });

  test("a hovered id no longer among the nodes (DW-66): no stale panel", () => {
    expect(erdHoverPanelData(NODES, tableId("public", "dropped"))).toBeNull();
  });
});
