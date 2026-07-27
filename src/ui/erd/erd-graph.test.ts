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
  positionsOf,
  reconcilePositions,
  sanitizeViewport,
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

  test("FK to an absent table (DW-44): a materialized erdExternal node + dashed-flagged edge, no throw", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "ghost_id" }], {
        foreignKeys: [
          { columns: ["ghost_id"], referencedSchema: "public", referencedTable: "ghost", referencedColumns: ["id"] },
        ],
      }),
    ]);
    // One real table node plus one synthesized external node for the absent target.
    expect(graph.nodes.length).toBe(2);
    const externalId = tableId("public", "ghost");
    const external = graph.nodes.find((n) => n.id === externalId);
    expect(external?.type).toBe("erdExternal");
    expect(external?.data.schema).toBe("public");
    expect(external?.data.name).toBe("ghost");
    expect(external?.data.label).toBe("public.ghost");
    // External node carries no column list.
    expect(external?.data.columns).toEqual([]);
    // The edge is never dropped — it now points at the external node, flagged.
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.source).toBe(tableId("public", "orders"));
    expect(graph.edges[0]?.target).toBe(externalId);
    expect(graph.edges[0]?.data.isExternal).toBe(true);
  });

  test("external node height is header + one caption row (P10), not header + row-container padding", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "ghost_id" }], {
        foreignKeys: [
          { columns: ["ghost_id"], referencedSchema: "public", referencedTable: "ghost", referencedColumns: ["id"] },
        ],
      }),
    ]);
    const external = graph.nodes.find((n) => n.id === tableId("public", "ghost"));
    // HEADER_HEIGHT (34) + ROW_HEIGHT (22) = 56 — NOT the old nodeHeight(0) (42), which
    // added NODE_PADDING for a rows container this column-less card never renders.
    expect(external?.height).toBe(56);
  });

  test("MySQL cross-database FK: external node labelled with the target database verbatim", () => {
    // `referencedSchema` holds the *database* name on MySQL; a pinned-database
    // introspection scopes the owning side but leaves the referenced side unfiltered,
    // so `auth` never appears in the input table list.
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "user_id" }], {
        schema: "shop",
        foreignKeys: [
          { columns: ["user_id"], referencedSchema: "auth", referencedTable: "users", referencedColumns: ["id"] },
        ],
      }),
    ]);
    const externalId = tableId("auth", "users");
    const external = graph.nodes.find((n) => n.id === externalId);
    expect(external?.type).toBe("erdExternal");
    expect(external?.data.label).toBe("auth.users");
    expect(graph.edges[0]?.data.isExternal).toBe(true);
  });

  test("two FKs (from different tables) targeting the same absent table: ONE external node, TWO dashed edges", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "user_id" }], {
        foreignKeys: [
          { columns: ["user_id"], referencedSchema: "auth", referencedTable: "users", referencedColumns: ["id"] },
        ],
      }),
      table("sessions", [{ name: "id" }, { name: "user_id" }], {
        foreignKeys: [
          { columns: ["user_id"], referencedSchema: "auth", referencedTable: "users", referencedColumns: ["id"] },
        ],
      }),
    ]);
    const externalId = tableId("auth", "users");
    expect(graph.nodes.filter((n) => n.id === externalId).length).toBe(1);
    const externalEdges = graph.edges.filter((e) => e.target === externalId);
    expect(externalEdges.length).toBe(2);
    expect(externalEdges.every((e) => e.data.isExternal)).toBe(true);
  });

  test("an in-scope FK still carries isExternal: false", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "user_id" }], {
        foreignKeys: [
          { columns: ["user_id"], referencedSchema: "public", referencedTable: "users", referencedColumns: ["id"] },
        ],
      }),
      table("users", [{ name: "id" }], { primaryKey: ["id"] }),
    ]);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.data.isExternal).toBe(false);
    // No external node was created — the target was in scope.
    expect(graph.nodes.every((n) => n.type === "erdTable")).toBe(true);
  });

  test("applyLayout positions the external node like any other node", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "ghost_id" }], {
        foreignKeys: [
          { columns: ["ghost_id"], referencedSchema: "public", referencedTable: "ghost", referencedColumns: ["id"] },
        ],
      }),
    ]);
    const externalId = tableId("public", "ghost");
    // Dagre already gave it a finite position.
    const external = graph.nodes.find((n) => n.id === externalId);
    expect(Number.isFinite(external?.position.x)).toBe(true);
    expect(Number.isFinite(external?.position.y)).toBe(true);
    // The overlay treats it like any positioned node id.
    const out = applyLayout(graph, { [externalId]: { x: 42, y: 84 } });
    expect(out.nodes.find((n) => n.id === externalId)?.position).toEqual({ x: 42, y: 84 });
  });

  test("connectedNodeIds includes the external node as a hover neighbour", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "ghost_id" }], {
        foreignKeys: [
          { columns: ["ghost_id"], referencedSchema: "public", referencedTable: "ghost", referencedColumns: ["id"] },
        ],
      }),
    ]);
    const ordersId = tableId("public", "orders");
    const externalId = tableId("public", "ghost");
    expect([...connectedNodeIds(graph.edges, ordersId)].sort()).toEqual(
      [ordersId, externalId].sort(),
    );
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

  test("a blank referencedTable names nothing to point at: the FK is skipped entirely, no ghost node", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "user_id" }], {
        foreignKeys: [
          { columns: ["user_id"], referencedSchema: "public", referencedTable: "", referencedColumns: ["id"] },
        ],
      }),
    ]);
    // Only the real table node — no synthesized node for the blank target, and no edge.
    expect(graph.nodes.length).toBe(1);
    expect(graph.nodes[0]?.type).toBe("erdTable");
    expect(graph.edges).toEqual([]);
  });

  test("a whitespace-only referencedTable is treated the same as blank: skipped", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "user_id" }], {
        foreignKeys: [
          { columns: ["user_id"], referencedSchema: "public", referencedTable: "   ", referencedColumns: ["id"] },
        ],
      }),
    ]);
    expect(graph.nodes.length).toBe(1);
    expect(graph.edges).toEqual([]);
  });

  // P13: the blank-target skip is a guard against synthesizing a NAMELESS external card
  // — it must never fire for a target that is actually PRESENT. `"   "` is a legal
  // quoted identifier (`CREATE TABLE "   "` in Postgres, MySQL backticks), so a table
  // really named that way can be in the introspected set, and dropping its FK would
  // lose a real in-scope relationship: the very failure DW-44 exists to prevent.
  test("a whitespace-named table that IS in scope keeps its FK edge (the blank guard is absent-target only)", () => {
    const graph = schemaToGraph([
      table("   ", [{ name: "id" }], { primaryKey: ["id"] }),
      table("orders", [{ name: "id" }, { name: "user_id" }], {
        foreignKeys: [
          { columns: ["user_id"], referencedSchema: "public", referencedTable: "   ", referencedColumns: ["id"] },
        ],
      }),
    ]);
    // Two REAL nodes and no synthesized stand-in — the target was in scope all along.
    expect(graph.nodes.length).toBe(2);
    expect(graph.nodes.every((n) => n.type === "erdTable")).toBe(true);
    // The relationship survives, solid (in-scope), pointing at the real node.
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.target).toBe(tableId("public", "   "));
    expect(graph.edges[0]?.data.isExternal).toBe(false);
  });

  test("a blank referencedSchema with a REAL referencedTable is unaffected: still external, label falls back to the bare table name", () => {
    const graph = schemaToGraph([
      table("orders", [{ name: "id" }, { name: "ghost_id" }], {
        foreignKeys: [
          { columns: ["ghost_id"], referencedSchema: "", referencedTable: "ghost", referencedColumns: ["id"] },
        ],
      }),
    ]);
    const externalId = tableId("", "ghost");
    const external = graph.nodes.find((n) => n.id === externalId);
    expect(external?.type).toBe("erdExternal");
    expect(external?.data.label).toBe("ghost");
    expect(graph.edges.length).toBe(1);
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

describe("positionsOf — layout capture (Story 4.2)", () => {
  test("maps every node id to its position", () => {
    expect(
      positionsOf([
        { id: "a", position: { x: 1, y: 2 } },
        { id: "b", position: { x: -3, y: 4.5 } },
      ]),
    ).toEqual({ a: { x: 1, y: 2 }, b: { x: -3, y: 4.5 } });
  });

  test("returns an empty map for no nodes", () => {
    expect(positionsOf([])).toEqual({});
  });

  test("SKIPS a non-finite coordinate instead of persisting it", () => {
    // One NaN/Infinity reaching `workspace.save` is a bad_request for the WHOLE snapshot,
    // which would silently stop every save for the rest of the session.
    expect(
      positionsOf([
        { id: "ok", position: { x: 1, y: 2 } },
        { id: "nan", position: { x: Number.NaN, y: 0 } },
        { id: "inf", position: { x: 0, y: Number.POSITIVE_INFINITY } },
      ]),
    ).toEqual({ ok: { x: 1, y: 2 } });
  });
});

describe("reconcilePositions — graph-change re-seed (Story 4.2)", () => {
  const ORDERS = tableId("public", "orders");
  const USERS = tableId("public", "users");
  const SAVED = { [ORDERS]: { x: 10, y: 20 } };

  test("re-seeds from the on-screen nodes when the graph is non-empty", () => {
    expect(reconcilePositions(SAVED, [{ id: ORDERS, position: { x: 99, y: 98 } }])).toEqual({
      [ORDERS]: { x: 99, y: 98 },
    });
  });

  test("drops a vanished node's entry when the graph is non-empty", () => {
    expect(reconcilePositions(SAVED, [{ id: USERS, position: { x: 1, y: 1 } }])).toEqual({
      [USERS]: { x: 1, y: 1 },
    });
  });

  test("KEEPS the previous map verbatim when the graph is empty", () => {
    // The restore regression: a restored ACTIVE ERD tab mounts before introspection answers,
    // so the first derived graph has zero nodes. Re-seeding there would wipe the saved
    // arrangement, and the tables-arrival re-derivation would silently fall back to dagre.
    expect(reconcilePositions(SAVED, [])).toBe(SAVED);
  });

  test("an empty graph after a real drag still keeps the dragged positions", () => {
    const dragged = reconcilePositions(SAVED, [{ id: ORDERS, position: { x: 5, y: 6 } }]);
    expect(reconcilePositions(dragged, [])).toEqual({ [ORDERS]: { x: 5, y: 6 } });
  });

  test("the kept map still restores through applyLayout once the tables arrive", () => {
    // End-to-end of the regression: empty mount → tables land → the saved position wins.
    const kept = reconcilePositions(SAVED, []);
    const laid = applyLayout(schemaToGraph([table("orders", [{ name: "id" }])]), kept);
    expect(laid.nodes[0]?.id).toBe(ORDERS);
    expect(laid.nodes[0]?.position).toEqual({ x: 10, y: 20 });
  });
});

describe("sanitizeViewport — viewport capture (Story 4.2)", () => {
  test("passes a finite, positively-zoomed viewport through", () => {
    expect(sanitizeViewport({ x: -10, y: 20, zoom: 1.5 })).toEqual({ x: -10, y: 20, zoom: 1.5 });
  });

  test("returns undefined for an absent viewport", () => {
    expect(sanitizeViewport(undefined)).toBeUndefined();
  });

  test("rejects a non-finite offset or zoom", () => {
    expect(sanitizeViewport({ x: Number.NaN, y: 0, zoom: 1 })).toBeUndefined();
    expect(sanitizeViewport({ x: 0, y: Number.POSITIVE_INFINITY, zoom: 1 })).toBeUndefined();
    expect(sanitizeViewport({ x: 0, y: 0, zoom: Number.NaN })).toBeUndefined();
  });

  test("rejects a zero or negative zoom (degenerate, blank canvas on restore)", () => {
    expect(sanitizeViewport({ x: 0, y: 0, zoom: 0 })).toBeUndefined();
    expect(sanitizeViewport({ x: 0, y: 0, zoom: -1 })).toBeUndefined();
  });
});
