/**
 * Unit tests for the pure browse-page planner (Story 3.2). Exercises the
 * safety-critical composition — schema-validated identifiers, PK-vs-all-columns
 * ORDER BY, page/pageSize clamp, offset math, integer-literal LIMIT/OFFSET — and
 * every bad_request / not_found edge from the I/O matrix, with a fake `quoteIdent`.
 */

import { describe, expect, test } from "bun:test";
import type { DatabaseSchema } from "../shared/contract.ts";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  planTableRows,
  readTotal,
} from "./table-rows.ts";

/** A recognizable, injective fake quote so composed SQL is exactly assertable. */
const q = (ident: string): string => `[${ident}]`;

const SCHEMA: DatabaseSchema = {
  engine: "postgres",
  tables: [
    {
      schema: "public",
      name: "users",
      columns: [
        { name: "id", dataType: "integer", nullable: false },
        { name: "email", dataType: "text", nullable: true },
      ],
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [],
    },
    {
      schema: "public",
      name: "events", // keyless table → ORDER BY all columns
      columns: [
        { name: "a", dataType: "text", nullable: false },
        { name: "b", dataType: "text", nullable: false },
      ],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    },
    {
      schema: "reporting",
      name: "users", // same name as public.users → ambiguity source
      columns: [{ name: "id", dataType: "integer", nullable: false }],
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

describe("planTableRows — happy paths", () => {
  test("first page: PK ORDER BY, quoted identifiers, integer LIMIT/OFFSET literals", () => {
    const res = planTableRows(SCHEMA, { schema: "public", table: "users", page: 1, pageSize: 100 }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toBe(
      "SELECT [id], [email] FROM [public].[users] ORDER BY [id] LIMIT 100 OFFSET 0",
    );
    expect(res.plan.countSql).toBe("SELECT COUNT(*) AS total FROM [public].[users]");
    expect(res.plan.page).toBe(1);
    expect(res.plan.pageSize).toBe(100);
    expect(res.plan.offset).toBe(0);
    expect(res.plan.columns.map((c) => c.name)).toEqual(["id", "email"]);
  });

  test("offset math: page 3 of size 50 → OFFSET 100", () => {
    const res = planTableRows(SCHEMA, { schema: "public", table: "users", page: 3, pageSize: 50 }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.offset).toBe(100);
    expect(res.plan.selectSql).toContain("LIMIT 50 OFFSET 100");
  });

  test("keyless table orders by ALL columns (a total, repeatable order)", () => {
    const res = planTableRows(SCHEMA, { schema: "public", table: "events" }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toContain("ORDER BY [a], [b]");
  });

  test("defaults: page 1 and DEFAULT_PAGE_SIZE when omitted", () => {
    const res = planTableRows(SCHEMA, { schema: "public", table: "events" }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.page).toBe(1);
    expect(res.plan.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(res.plan.offset).toBe(0);
  });

  test("pageSize over the cap is clamped to MAX_PAGE_SIZE (and echoed clamped)", () => {
    const res = planTableRows(SCHEMA, { table: "events", pageSize: 100000 }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.pageSize).toBe(MAX_PAGE_SIZE);
    expect(res.plan.selectSql).toContain(`LIMIT ${MAX_PAGE_SIZE} OFFSET 0`);
  });

  test("an unambiguous unqualified table resolves without a schema", () => {
    const res = planTableRows(SCHEMA, { table: "events" }, q);
    expect(res.ok).toBe(true);
  });
});

describe("planTableRows — errors", () => {
  test("missing/blank table → bad_request", () => {
    for (const params of [{}, { table: "" }, { table: "   " }, { table: 5 }]) {
      const res = planTableRows(SCHEMA, params, q);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("bad_request");
    }
  });

  test("non-object params → bad_request", () => {
    for (const params of [undefined, null, 5, "x", [1, 2]]) {
      const res = planTableRows(SCHEMA, params, q);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("bad_request");
    }
  });

  test("non-integer / non-positive page or pageSize → bad_request", () => {
    for (const params of [
      { table: "events", page: 0 },
      { table: "events", page: 1.5 },
      { table: "events", page: "2" },
      { table: "events", pageSize: 0 },
      { table: "events", pageSize: -10 },
      { table: "events", pageSize: 2.5 },
    ]) {
      const res = planTableRows(SCHEMA, params, q);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("bad_request");
    }
  });

  test("unknown table → not_found naming the table", () => {
    const res = planTableRows(SCHEMA, { table: "does_not_exist" }, q);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("not_found");
      expect(res.error.message).toContain("does_not_exist");
    }
  });

  test("ambiguous unqualified table across schemas → bad_request", () => {
    const res = planTableRows(SCHEMA, { table: "users" }, q);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("bad_request");
      expect(res.error.message).toContain("ambiguous");
    }
  });

  test("qualifying an ambiguous name with a schema resolves it", () => {
    const res = planTableRows(SCHEMA, { schema: "reporting", table: "users" }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toContain("FROM [reporting].[users]");
  });

  test("blank schema when provided → bad_request", () => {
    const res = planTableRows(SCHEMA, { schema: "  ", table: "users" }, q);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("bad_request");
  });
});

describe("planTableRows — offset bound (P1)", () => {
  test("a huge page whose offset exceeds MAX_SAFE_INTEGER → bad_request", () => {
    const res = planTableRows(SCHEMA, { schema: "public", table: "users", page: 1e21 }, q);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("bad_request");
      expect(res.error.message).toContain("out of range");
    }
  });

  test("the largest safe page still composes an integer-literal OFFSET (no sci-notation)", () => {
    // (page - 1) * pageSize must stay <= MAX_SAFE_INTEGER.
    const page = Math.floor(Number.MAX_SAFE_INTEGER / 100) + 1; // offset = floor(...)*100 <= MAX_SAFE_INTEGER
    const res = planTableRows(SCHEMA, { schema: "public", table: "users", page, pageSize: 100 }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).not.toContain("e+");
    expect(res.plan.selectSql).not.toContain("Infinity");
    expect(Number.isSafeInteger(res.plan.offset)).toBe(true);
  });
});

describe("planTableRows — keyless ORDER BY skips unorderable types (P2)", () => {
  const schemaWith = (columns: DatabaseSchema["tables"][number]["columns"]): DatabaseSchema => ({
    engine: "postgres",
    tables: [{ schema: "public", name: "t", columns, primaryKey: [], indexes: [], foreignKeys: [] }],
  });

  test("only-unorderable columns → SELECT composed with NO ORDER BY", () => {
    const res = planTableRows(
      schemaWith([
        { name: "doc", dataType: "jsonb", nullable: true },
        { name: "blob", dataType: "bytea", nullable: true },
      ]),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).not.toContain("ORDER BY");
    expect(res.plan.selectSql).toBe("SELECT [doc], [blob] FROM [public].[t] LIMIT 100 OFFSET 0");
  });

  test("mixed columns → ORDER BY only the orderable ones", () => {
    const res = planTableRows(
      schemaWith([
        { name: "id", dataType: "integer", nullable: false },
        { name: "doc", dataType: "json", nullable: true },
        { name: "name", dataType: "text", nullable: true },
      ]),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // [doc] is still SELECTed, but the ORDER BY clause skips it.
    expect(res.plan.selectSql).toContain("ORDER BY [id], [name] LIMIT");
    const orderBy = res.plan.selectSql.slice(res.plan.selectSql.indexOf("ORDER BY"));
    expect(orderBy).not.toContain("[doc]");
  });
});

describe("readTotal", () => {
  test("reads a number, a bigint, or a numeric string from the first cell", () => {
    expect(readTotal([[5000]])).toBe(5000);
    expect(readTotal([["30"]])).toBe(30);
    expect(readTotal([[42n]])).toBe(42);
  });

  test("defaults to 0 for an empty/absent/garbage count", () => {
    expect(readTotal([])).toBe(0);
    expect(readTotal([[]])).toBe(0);
    expect(readTotal([[null]])).toBe(0);
    expect(readTotal([["nope"]])).toBe(0);
  });

  test("clamps a bigint/string above 2^53 to MAX_SAFE_INTEGER (P3)", () => {
    expect(readTotal([[9007199254740993n]])).toBe(Number.MAX_SAFE_INTEGER);
    expect(readTotal([["9007199254740993"]])).toBe(Number.MAX_SAFE_INTEGER);
    expect(readTotal([["1e30"]])).toBe(Number.MAX_SAFE_INTEGER);
  });
});
