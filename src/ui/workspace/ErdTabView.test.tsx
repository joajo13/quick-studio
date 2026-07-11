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
import { tableId } from "../erd/erd-graph.ts";
import { ErdTabView } from "./ErdTabView.tsx";

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
    // PK marker for the primary-key column.
    expect(out).toContain("🔑");
  });

  test("a foreign key renders at least one edge in the canvas", () => {
    const out = renderToStaticMarkup(<ErdTabView tables={SAMPLE} />);
    expect(out).toContain("react-flow__edge");
  });

  test("a supplied saved layout still renders each table's name (positions overlaid, no crash)", () => {
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
});
