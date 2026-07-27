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
import { tableId } from "../erd/erd-graph.ts";
import { ErdHoverPanel, ErdTabView } from "./ErdTabView.tsx";

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
});
