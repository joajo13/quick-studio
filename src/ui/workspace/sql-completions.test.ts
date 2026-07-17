/**
 * quick-studio UI (Ring 2) — sql-completions tests (Story 8.8).
 *
 * Pure, DOM-free `bun:test` units over the schema-completion builder: this repo
 * has no jsdom/testing-library (see `QueryTabView.test.tsx`'s own note), so the
 * CM-wiring itself is left to the live manual check — these units cover the
 * name-derivation / prefix-filtering / qualified-lookup logic that IS testable
 * without mounting an editor, mirroring `run-raw-query.test.ts`'s seam coverage.
 */

import { describe, expect, test } from "bun:test";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { SchemaTableInfo } from "../../shared/contract.ts";
import {
  collectSqlCompletionEntries,
  filterSqlCompletionEntries,
  resolveQualifiedColumns,
  resolveQualifiedEntries,
  schemaCompletionSource,
} from "./sql-completions.ts";

/**
 * `schemaCompletionSource`'s declared `CompletionSource` type allows an async
 * result (`Promise<CompletionResult | null>`), but this module's implementation
 * is always synchronous — this thin wrapper narrows the return for the tests
 * below without an `await` on every call.
 */
function runSync(
  source: ReturnType<typeof schemaCompletionSource>,
  context: CompletionContext,
): CompletionResult | null {
  return source(context) as CompletionResult | null;
}

const SAMPLE_TABLES: ReadonlyArray<SchemaTableInfo> = [
  {
    schema: "public",
    name: "orders",
    columns: [
      { name: "id", dataType: "int4", nullable: false },
      { name: "customer_id", dataType: "int4", nullable: false },
      { name: "total", dataType: "numeric", nullable: false },
    ],
    primaryKey: ["id"],
    indexes: [],
    foreignKeys: [],
  },
  {
    schema: "public",
    name: "order_items",
    columns: [
      { name: "id", dataType: "int4", nullable: false },
      { name: "order_id", dataType: "int4", nullable: false },
    ],
    primaryKey: ["id"],
    indexes: [],
    foreignKeys: [],
  },
  {
    schema: "audit",
    name: "orders",
    columns: [
      { name: "id", dataType: "int4", nullable: false },
      { name: "changed_at", dataType: "timestamp", nullable: false },
    ],
    primaryKey: ["id"],
    indexes: [],
    foreignKeys: [],
  },
];

describe("collectSqlCompletionEntries", () => {
  test("every schema, table, and column name completes", () => {
    const entries = collectSqlCompletionEntries(SAMPLE_TABLES);
    const labelsByKind = (kind: "schema" | "table" | "column") =>
      entries.filter((e) => e.kind === kind).map((e) => e.label).sort();

    expect(labelsByKind("schema")).toEqual(["audit", "public"]);
    // `orders` appears in two schemas but is one deduplicated TABLE-kind entry.
    expect(labelsByKind("table")).toEqual(["order_items", "orders"]);
    expect(labelsByKind("column").sort()).toEqual(
      ["changed_at", "customer_id", "id", "order_id", "total"].sort(),
    );
  });

  test("a schema/table/column name repeated across rows is offered exactly once", () => {
    const entries = collectSqlCompletionEntries(SAMPLE_TABLES);
    const idColumnEntries = entries.filter((e) => e.kind === "column" && e.label === "id");
    expect(idColumnEntries.length).toBe(1);
    const publicSchemaEntries = entries.filter((e) => e.kind === "schema" && e.label === "public");
    expect(publicSchemaEntries.length).toBe(1);
  });

  test("empty tables yields an empty entry list (safe, no crash)", () => {
    expect(collectSqlCompletionEntries([])).toEqual([]);
  });
});

describe("filterSqlCompletionEntries", () => {
  test("an empty prefix (explicit Ctrl+Space, nothing typed) returns every entry", () => {
    const entries = collectSqlCompletionEntries(SAMPLE_TABLES);
    expect(filterSqlCompletionEntries(entries, "")).toEqual(entries);
  });

  test("a prefix filters to the matching subset, case-insensitively", () => {
    const entries = collectSqlCompletionEntries(SAMPLE_TABLES);
    const matches = filterSqlCompletionEntries(entries, "ord").map((e) => e.label).sort();
    expect(matches).toEqual(["order_id", "order_items", "orders"]);

    const upperMatches = filterSqlCompletionEntries(entries, "ORD").map((e) => e.label).sort();
    expect(upperMatches).toEqual(matches);
  });

  test("a non-matching prefix filters to nothing", () => {
    const entries = collectSqlCompletionEntries(SAMPLE_TABLES);
    expect(filterSqlCompletionEntries(entries, "zzz")).toEqual([]);
  });
});

describe("resolveQualifiedColumns", () => {
  test("a schema-qualified table name resolves its own column names", () => {
    expect(resolveQualifiedColumns(SAMPLE_TABLES, "public", "orders")).toEqual([
      "id",
      "customer_id",
      "total",
    ]);
    expect(resolveQualifiedColumns(SAMPLE_TABLES, "audit", "orders")).toEqual([
      "id",
      "changed_at",
    ]);
  });

  test("an unqualified/unknown pair resolves to no columns (never throws)", () => {
    expect(resolveQualifiedColumns(SAMPLE_TABLES, "public", "does_not_exist")).toEqual([]);
    expect(resolveQualifiedColumns([], "public", "orders")).toEqual([]);
  });
});

describe("schemaCompletionSource", () => {
  test("explicit request with no typed prefix offers every entry", () => {
    const source = schemaCompletionSource(SAMPLE_TABLES);
    const context = {
      explicit: true,
      matchBefore: (_expr: RegExp) => ({ from: 0, to: 0, text: "" }),
    } as unknown as import("@codemirror/autocomplete").CompletionContext;
    const result = runSync(source, context);
    expect(result).not.toBeNull();
    expect(result?.options.length).toBe(collectSqlCompletionEntries(SAMPLE_TABLES).length);
  });

  test("as-you-type with a typed prefix narrows the options", () => {
    const source = schemaCompletionSource(SAMPLE_TABLES);
    const context = {
      explicit: false,
      matchBefore: (_expr: RegExp) => ({ from: 3, to: 6, text: "ord" }),
    } as unknown as import("@codemirror/autocomplete").CompletionContext;
    const result = runSync(source, context);
    expect(result).not.toBeNull();
    const labels = (result?.options ?? []).map((o) => o.label).sort();
    expect(labels).toEqual(["order_id", "order_items", "orders"]);
  });

  test("as-you-type with an empty (not-yet-started) word and no explicit request yields no popup", () => {
    const source = schemaCompletionSource(SAMPLE_TABLES);
    const context = {
      explicit: false,
      matchBefore: (_expr: RegExp) => ({ from: 0, to: 0, text: "" }),
    } as unknown as import("@codemirror/autocomplete").CompletionContext;
    expect(source(context)).toBeNull();
  });

  test("empty schema is safe: no crash, no popup", () => {
    const source = schemaCompletionSource([]);
    const context = {
      explicit: true,
      matchBefore: (_expr: RegExp) => ({ from: 0, to: 0, text: "" }),
    } as unknown as import("@codemirror/autocomplete").CompletionContext;
    expect(source(context)).toBeNull();
  });
});

describe("resolveQualifiedEntries", () => {
  test("a `schema.table` path resolves to that table's columns", () => {
    const entries = resolveQualifiedEntries(SAMPLE_TABLES, ["public", "orders"]) ?? [];
    expect(entries.map((e) => e.label)).toEqual(["id", "customer_id", "total"]);
    expect(entries.every((e) => e.kind === "column")).toBe(true);
  });

  test("a bare `table` path offers the union of that table's columns across schemas (deduped)", () => {
    const entries = resolveQualifiedEntries(SAMPLE_TABLES, ["orders"]) ?? [];
    // `orders` exists in both `public` and `audit`; columns dedupe by name.
    expect(entries.map((e) => e.label).sort()).toEqual(["changed_at", "customer_id", "id", "total"]);
    expect(entries.every((e) => e.kind === "column")).toBe(true);
  });

  test("a bare `schema` path offers that schema's table names", () => {
    const entries = resolveQualifiedEntries(SAMPLE_TABLES, ["public"]) ?? [];
    expect(entries.map((e) => e.label).sort()).toEqual(["order_items", "orders"]);
    expect(entries.every((e) => e.kind === "table")).toBe(true);
  });

  test("an unknown qualifier resolves to null (so the caller offers nothing, not the flat list)", () => {
    expect(resolveQualifiedEntries(SAMPLE_TABLES, ["nope"])).toBeNull();
    expect(resolveQualifiedEntries(SAMPLE_TABLES, ["public", "does_not_exist"])).toBeNull();
    expect(resolveQualifiedEntries(SAMPLE_TABLES, ["a", "b", "c"])).toBeNull();
  });
});

/**
 * A faithful `CompletionContext` stand-in: `matchBefore(expr)` returns the
 * longest match ENDING at the caret (end of `before`), exactly like CodeMirror —
 * so the two different regexes the source uses (the word matcher for the partial
 * word, the dotted matcher for the qualifier) each resolve correctly.
 */
function ctxFor(before: string, explicit: boolean): CompletionContext {
  return {
    explicit,
    matchBefore: (expr: RegExp) => {
      const m = new RegExp(`(?:${expr.source})$`).exec(before);
      if (m === null) return null;
      const text = m[0];
      return { from: before.length - text.length, to: before.length, text };
    },
  } as unknown as CompletionContext;
}

describe("schemaCompletionSource — qualified drill-down", () => {
  const source = schemaCompletionSource(SAMPLE_TABLES);

  test("`schema.table.` scopes to that table's columns (as-you-type, no explicit needed)", () => {
    const result = runSync(source, ctxFor("select * from public.orders.", false));
    expect(result).not.toBeNull();
    expect((result?.options ?? []).map((o) => o.label)).toEqual(["id", "customer_id", "total"]);
  });

  test("`schema.table.<prefix>` filters that table's columns", () => {
    const result = runSync(source, ctxFor("select * from public.orders.cust", false));
    expect((result?.options ?? []).map((o) => o.label)).toEqual(["customer_id"]);
    // insertion replaces only the trailing partial word, not the whole path.
    expect(result?.from).toBe("select * from public.orders.".length);
  });

  test("bare `table.` scopes to that table's columns (union across schemas)", () => {
    const result = runSync(source, ctxFor("select orders.", true));
    expect((result?.options ?? []).map((o) => o.label).sort()).toEqual([
      "changed_at",
      "customer_id",
      "id",
      "total",
    ]);
  });

  test("an unknown qualifier offers nothing (no flat-list explosion)", () => {
    expect(runSync(source, ctxFor("select * from nope.", true))).toBeNull();
  });

  test("an unqualified word still offers the flat list as before", () => {
    const result = runSync(source, ctxFor("select ord", false));
    expect((result?.options ?? []).map((o) => o.label).sort()).toEqual([
      "order_id",
      "order_items",
      "orders",
    ]);
  });
});
