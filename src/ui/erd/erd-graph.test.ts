/**
 * quick-studio UI (Ring 2) — pure ERD graph derivation tests (Story 4.1).
 *
 * DOM-free `bun:test` units for `schemaToGraph`, covering every row of the story's
 * I/O & Edge-Case Matrix: FK edges, no-FK schemas, self-referential FKs, FKs to an
 * absent table, composite FKs (one edge, not one per column), and the empty schema.
 * Positions come from dagre; we assert they are finite numbers rather than exact
 * pixels (layout is deterministic but its exact coordinates are an implementation
 * detail of dagre).
 */

import { describe, expect, test } from "bun:test";
import { MarkerType } from "@xyflow/react";
import type { SchemaForeignKeyInfo, SchemaTableInfo } from "../../shared/contract.ts";
import { schemaToGraph, tableId } from "./erd-graph.ts";

function col(name: string, dataType = "integer"): SchemaTableInfo["columns"][number] {
  return { name, dataType, nullable: false };
}

function table(
  name: string,
  columns: ReadonlyArray<{ name: string; dataType?: string }>,
  opts: {
    schema?: string;
    primaryKey?: ReadonlyArray<string>;
    foreignKeys?: ReadonlyArray<SchemaForeignKeyInfo>;
  } = {},
): SchemaTableInfo {
  return {
    schema: opts.schema ?? "public",
    name,
    columns: columns.map((c) => col(c.name, c.dataType)),
    primaryKey: opts.primaryKey ?? [],
    indexes: [],
    foreignKeys: opts.foreignKeys ?? [],
  };
}

describe("schemaToGraph — I/O & Edge-Case Matrix", () => {
  test("tables with FKs: one node per table, one edge per FK (source → referenced)", () => {
    const tables = [
      table("orders", [{ name: "id" }, { name: "user_id" }], {
        primaryKey: ["id"],
        foreignKeys: [
          { columns: ["user_id"], referencedSchema: "public", referencedTable: "users", referencedColumns: ["id"] },
        ],
      }),
      table("users", [{ name: "id" }], { primaryKey: ["id"] }),
    ];
    const graph = schemaToGraph(tables);

    expect(graph.nodes.map((n) => n.data.name)).toEqual(["orders", "users"]);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.source).toBe(tableId("public", "orders"));
    expect(graph.edges[0]?.target).toBe(tableId("public", "users"));
    // Every node has a finite dagre-computed position.
    for (const n of graph.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  test("PK columns are flagged; label reflects schema.name", () => {
    const graph = schemaToGraph([
      table("users", [{ name: "id" }, { name: "email", dataType: "text" }], { primaryKey: ["id"] }),
    ]);
    const cols = graph.nodes[0]?.data.columns ?? [];
    expect(cols.find((c) => c.name === "id")?.isPrimaryKey).toBe(true);
    expect(cols.find((c) => c.name === "email")?.isPrimaryKey).toBe(false);
    expect(graph.nodes[0]?.data.label).toBe("public.users");
  });

  test("no foreign keys: nodes only, zero edges", () => {
    const graph = schemaToGraph([
      table("a", [{ name: "id" }]),
      table("b", [{ name: "id" }]),
    ]);
    expect(graph.nodes.length).toBe(2);
    expect(graph.edges).toEqual([]);
  });

  test("self-referential FK: a self-loop edge on that node", () => {
    const graph = schemaToGraph([
      table("employees", [{ name: "id" }, { name: "manager_id" }], {
        primaryKey: ["id"],
        foreignKeys: [
          { columns: ["manager_id"], referencedSchema: "public", referencedTable: "employees", referencedColumns: ["id"] },
        ],
      }),
    ]);
    expect(graph.edges.length).toBe(1);
    const id = tableId("public", "employees");
    expect(graph.edges[0]?.source).toBe(id);
    expect(graph.edges[0]?.target).toBe(id);
  });

  test("FK to an absent table: edge omitted, no throw", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "ghost_id" }], {
        foreignKeys: [
          { columns: ["ghost_id"], referencedSchema: "public", referencedTable: "ghost", referencedColumns: ["id"] },
        ],
      }),
    ]);
    expect(graph.nodes.length).toBe(1);
    expect(graph.edges).toEqual([]);
  });

  test("composite FK: a single edge (not one per column)", () => {
    const graph = schemaToGraph([
      table("line_items", [{ name: "order_id" }, { name: "product_id" }], {
        foreignKeys: [
          {
            columns: ["order_id", "product_id"],
            referencedSchema: "public",
            referencedTable: "order_products",
            referencedColumns: ["order_id", "product_id"],
          },
        ],
      }),
      table("order_products", [{ name: "order_id" }, { name: "product_id" }], {
        primaryKey: ["order_id", "product_id"],
      }),
    ]);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.data.columns).toEqual(["order_id", "product_id"]);
    expect(graph.edges[0]?.data.referencedColumns).toEqual(["order_id", "product_id"]);
  });

  test("empty schema: empty graph", () => {
    const graph = schemaToGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  test("two distinct FKs between the same pair of tables yield two edges", () => {
    const graph = schemaToGraph([
      table("messages", [{ name: "id" }, { name: "sender_id" }, { name: "recipient_id" }], {
        foreignKeys: [
          { columns: ["sender_id"], referencedSchema: "public", referencedTable: "users", referencedColumns: ["id"] },
          { columns: ["recipient_id"], referencedSchema: "public", referencedTable: "users", referencedColumns: ["id"] },
        ],
      }),
      table("users", [{ name: "id" }], { primaryKey: ["id"] }),
    ]);
    expect(graph.edges.length).toBe(2);
    // Edge ids are unique so React Flow can key them.
    expect(new Set(graph.edges.map((e) => e.id)).size).toBe(2);
  });

  test("duplicate schema+name input: one node, no duplicate edge ids (FK-bearing entry wins)", () => {
    // An optimistically-created empty entry AND its re-introspected twin (carrying the
    // real FK) appear in the same input — mirrors App's `[...schemaTables, ...createdTables]`.
    const optimistic = table("orders", [{ name: "id" }, { name: "user_id" }], { primaryKey: ["id"] });
    const introspected = table("orders", [{ name: "id" }, { name: "user_id" }], {
      primaryKey: ["id"],
      foreignKeys: [
        { columns: ["user_id"], referencedSchema: "public", referencedTable: "users", referencedColumns: ["id"] },
      ],
    });
    const graph = schemaToGraph([optimistic, introspected, table("users", [{ name: "id" }], { primaryKey: ["id"] })]);

    // Exactly one node for the duplicated id.
    const ordersId = tableId("public", "orders");
    expect(graph.nodes.filter((n) => n.id === ordersId).length).toBe(1);
    // No duplicate node ids overall.
    expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(graph.nodes.length);
    // The FK-bearing entry won, so the edge survives — and edge ids stay unique.
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.source).toBe(ordersId);
    expect(graph.edges[0]?.target).toBe(tableId("public", "users"));
    expect(new Set(graph.edges.map((e) => e.id)).size).toBe(graph.edges.length);
  });

  test("every FK edge carries a directional arrowhead marker", () => {
    const graph = schemaToGraph([
      table("employees", [{ name: "id" }, { name: "manager_id" }], {
        primaryKey: ["id"],
        foreignKeys: [
          { columns: ["manager_id"], referencedSchema: "public", referencedTable: "employees", referencedColumns: ["id"] },
        ],
      }),
    ]);
    // Self-referential edge included: it must still get an arrowhead.
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.markerEnd).toEqual({ type: MarkerType.ArrowClosed });
  });

  test("an FK across schemas resolves to the referenced schema's node", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "customer_id" }], {
        schema: "sales",
        foreignKeys: [
          { columns: ["customer_id"], referencedSchema: "crm", referencedTable: "customers", referencedColumns: ["id"] },
        ],
      }),
      table("customers", [{ name: "id" }], { schema: "crm", primaryKey: ["id"] }),
    ]);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.source).toBe(tableId("sales", "orders"));
    expect(graph.edges[0]?.target).toBe(tableId("crm", "customers"));
  });
});
