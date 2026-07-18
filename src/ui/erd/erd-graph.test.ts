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
import {
  applyLayout,
  connectedNodeIds,
  schemaToGraph,
  tableId,
  typeColorClass,
} from "./erd-graph.ts";

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

describe("applyLayout — saved-position overlay I/O & Edge-Case Matrix (Story 4.2)", () => {
  /** A two-table graph (orders → users) reused across the overlay scenarios. */
  function sample(): ReturnType<typeof schemaToGraph> {
    return schemaToGraph([
      table("orders", [{ name: "id" }, { name: "user_id" }], {
        primaryKey: ["id"],
        foreignKeys: [
          { columns: ["user_id"], referencedSchema: "public", referencedTable: "users", referencedColumns: ["id"] },
        ],
      }),
      table("users", [{ name: "id" }], { primaryKey: ["id"] }),
    ]);
  }

  const ordersId = tableId("public", "orders");
  const usersId = tableId("public", "users");

  test("full saved layout: every node uses its saved {x,y}, dagre overridden", () => {
    const graph = sample();
    const saved = { [ordersId]: { x: 100, y: 200 }, [usersId]: { x: 300, y: 400 } };
    const out = applyLayout(graph, saved);
    expect(out.nodes.find((n) => n.id === ordersId)?.position).toEqual({ x: 100, y: 200 });
    expect(out.nodes.find((n) => n.id === usersId)?.position).toEqual({ x: 300, y: 400 });
    // Edges are untouched by the overlay.
    expect(out.edges).toEqual(graph.edges);
  });

  test("partial saved layout: a new (unsaved) table keeps its dagre position", () => {
    const graph = sample();
    const dagreUsers = graph.nodes.find((n) => n.id === usersId)?.position;
    const out = applyLayout(graph, { [ordersId]: { x: 100, y: 200 } });
    expect(out.nodes.find((n) => n.id === ordersId)?.position).toEqual({ x: 100, y: 200 });
    // users had no saved position → keeps the exact dagre position it started with.
    expect(out.nodes.find((n) => n.id === usersId)?.position).toEqual(dagreUsers!);
  });

  test("stale saved layout: a position for an absent node id is ignored (no phantom node)", () => {
    const graph = sample();
    const out = applyLayout(graph, {
      [ordersId]: { x: 100, y: 200 },
      [tableId("public", "dropped")]: { x: 999, y: 999 },
    });
    // Still exactly the two real nodes; the dropped-table entry created nothing.
    expect(out.nodes.map((n) => n.id).sort()).toEqual([ordersId, usersId].sort());
    expect(out.nodes.find((n) => n.id === ordersId)?.position).toEqual({ x: 100, y: 200 });
  });

  test("no saved layout (undefined): all nodes keep their dagre positions unchanged", () => {
    const graph = sample();
    const out = applyLayout(graph, undefined);
    expect(out).toBe(graph); // returned unchanged (Story 4.1 behaviour)
  });

  test("no saved layout (empty map): all nodes keep their dagre positions", () => {
    const graph = sample();
    const out = applyLayout(graph, {});
    for (const n of out.nodes) {
      const original = graph.nodes.find((g) => g.id === n.id)!;
      expect(n.position).toEqual(original.position);
    }
  });

  test("empty graph: empty graph returned, nothing applied", () => {
    const empty = schemaToGraph([]);
    const out = applyLayout(empty, { [ordersId]: { x: 10, y: 20 } });
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  test("malformed coordinate (non-finite x or y): entry skipped, node falls back to dagre", () => {
    const graph = sample();
    const dagreOrders = graph.nodes.find((n) => n.id === ordersId)?.position;
    for (const bad of [
      { x: Number.NaN, y: 10 },
      { x: 10, y: Number.POSITIVE_INFINITY },
      { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY },
    ]) {
      const out = applyLayout(graph, { [ordersId]: bad });
      expect(out.nodes.find((n) => n.id === ordersId)?.position).toEqual(dagreOrders!);
    }
  });

  test("null/non-object saved entry: skipped without throwing, node falls back to dagre", () => {
    const graph = sample();
    const dagreOrders = graph.nodes.find((n) => n.id === ordersId)?.position;
    for (const bad of [null, undefined, 5, "x"] as unknown[]) {
      const out = applyLayout(graph, { [ordersId]: bad } as never);
      expect(out.nodes.find((n) => n.id === ordersId)?.position).toEqual(dagreOrders!);
    }
  });
});

describe("typeColorClass — functional data-type color families (Story 7.4)", () => {
  test("int / serial family → t-int", () => {
    for (const t of ["int8", "int4", "integer", "serial", "bigserial", "smallint"]) {
      expect(typeColorClass(t)).toBe("t-int");
    }
  });

  test("timestamp / date / time family → t-time", () => {
    for (const t of ["timestamptz", "timestamp", "date", "time", "timetz"]) {
      expect(typeColorClass(t)).toBe("t-time");
    }
  });

  test("interval → t-time (not int, despite the 'int' substring)", () => {
    expect(typeColorClass("interval")).toBe("t-time");
  });

  test("numeric / decimal / money / float / double family → t-num", () => {
    for (const t of ["numeric", "decimal", "money", "float8", "double precision"]) {
      expect(typeColorClass(t)).toBe("t-num");
    }
  });

  test("enum / USER-DEFINED family → t-enum (case-insensitive)", () => {
    for (const t of ["order_status_enum", "USER-DEFINED", "user-defined"]) {
      expect(typeColorClass(t)).toBe("t-enum");
    }
  });

  test("text / citext / varchar / inet / unknown fall back to t-text", () => {
    for (const t of ["text", "citext", "varchar", "inet", "bytea", "uuid", ""]) {
      expect(typeColorClass(t)).toBe("t-text");
    }
  });
});

describe("connectedNodeIds — connected-set derivation (Story 9.5)", () => {
  const ordersId = tableId("public", "orders");
  const usersId = tableId("public", "users");

  /** orders → users (single FK) reused across the with-FK / no-FK scenarios. */
  function withFks(): ReturnType<typeof schemaToGraph> {
    return schemaToGraph([
      table("orders", [{ name: "id" }, { name: "user_id" }], {
        primaryKey: ["id"],
        foreignKeys: [
          { columns: ["user_id"], referencedSchema: "public", referencedTable: "users", referencedColumns: ["id"] },
        ],
      }),
      table("users", [{ name: "id" }], { primaryKey: ["id"] }),
    ]);
  }

  test("hover a table WITH FKs → the hovered id plus its neighbour", () => {
    const { edges } = withFks();
    expect([...connectedNodeIds(edges, ordersId)].sort()).toEqual([ordersId, usersId].sort());
  });

  test("hover the referenced table → the hovered id plus the referencing neighbour", () => {
    const { edges } = withFks();
    // Direction-independent: hovering `users` still surfaces `orders` (edge target match).
    expect([...connectedNodeIds(edges, usersId)].sort()).toEqual([ordersId, usersId].sort());
  });

  test("table with NO FKs → the singleton { self }", () => {
    const { edges } = schemaToGraph([
      table("a", [{ name: "id" }]),
      table("b", [{ name: "id" }]),
    ]);
    const aId = tableId("public", "a");
    expect([...connectedNodeIds(edges, aId)]).toEqual([aId]);
  });

  test("self-referential FK → the singleton { self } (no phantom neighbour)", () => {
    const { edges } = schemaToGraph([
      table("employees", [{ name: "id" }, { name: "manager_id" }], {
        primaryKey: ["id"],
        foreignKeys: [
          { columns: ["manager_id"], referencedSchema: "public", referencedTable: "employees", referencedColumns: ["id"] },
        ],
      }),
    ]);
    const id = tableId("public", "employees");
    const connected = connectedNodeIds(edges, id);
    expect(connected.size).toBe(1);
    expect([...connected]).toEqual([id]);
  });

  test("composite FK → the single neighbour appears once (not per column)", () => {
    const { edges } = schemaToGraph([
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
    const lineItemsId = tableId("public", "line_items");
    const orderProductsId = tableId("public", "order_products");
    const connected = connectedNodeIds(edges, lineItemsId);
    expect(connected.size).toBe(2);
    expect([...connected].sort()).toEqual([lineItemsId, orderProductsId].sort());
  });

  test("an id absent from every edge → the singleton { id } (never throws)", () => {
    const { edges } = withFks();
    const ghostId = tableId("public", "ghost");
    expect([...connectedNodeIds(edges, ghostId)]).toEqual([ghostId]);
  });
});

describe("schemaToGraph — additive isForeignKey column flag (Story 7.4)", () => {
  test("columns participating in an outbound FK are flagged; others are not", () => {
    const graph = schemaToGraph([
      table(
        "orders",
        [{ name: "id" }, { name: "user_id" }, { name: "note", dataType: "text" }],
        {
          primaryKey: ["id"],
          foreignKeys: [
            {
              columns: ["user_id"],
              referencedSchema: "public",
              referencedTable: "users",
              referencedColumns: ["id"],
            },
          ],
        },
      ),
      table("users", [{ name: "id" }], { primaryKey: ["id"] }),
    ]);
    const orders = graph.nodes.find((n) => n.id === tableId("public", "orders"))!;
    const byName = new Map(orders.data.columns.map((c) => [c.name, c]));
    expect(byName.get("user_id")?.isForeignKey).toBe(true);
    expect(byName.get("id")?.isForeignKey).toBe(false);
    expect(byName.get("note")?.isForeignKey).toBe(false);
  });
});
