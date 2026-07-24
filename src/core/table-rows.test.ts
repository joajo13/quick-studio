/**
 * Unit tests for the pure browse-page planner (Story 3.2). Exercises the
 * safety-critical composition — schema-validated identifiers, the ORDER BY precedence
 * (primary key → physical row locator → allowlisted columns → none, DW-33),
 * page/pageSize clamp, offset math, integer-literal LIMIT/OFFSET — and every
 * bad_request / not_found edge from the I/O matrix, with a fake `quoteIdent`.
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

  test("keyless table of UNKNOWN kind orders by all ORDERABLE columns (no ctid)", () => {
    // `events` carries no `kind`, so the relation is not provably physically stored and
    // the physical-row-locator branch must NOT fire (DW-33) — it falls through to columns.
    const res = planTableRows(SCHEMA, { schema: "public", table: "events" }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toContain("ORDER BY [a], [b]");
    expect(res.plan.selectSql).not.toContain("ctid");
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

describe("planTableRows — keyless ORDER BY: allowlist + physical row locator (DW-33)", () => {
  type Columns = DatabaseSchema["tables"][number]["columns"];
  type Kind = DatabaseSchema["tables"][number]["kind"];

  /** A one-table schema whose single relation is KEYLESS, with an optional `kind`. */
  const keyless = (engine: DatabaseSchema["engine"], columns: Columns, kind?: Kind): DatabaseSchema => ({
    engine,
    tables: [
      {
        schema: "public",
        name: "t",
        columns,
        primaryKey: [],
        indexes: [],
        foreignKeys: [],
        ...(kind === undefined ? {} : { kind }),
      },
    ],
  });

  /** The columns of a relation NO allowlisted type can order — the DW-33 worst case. */
  const EXOTIC: Columns = [
    { name: "flavor", dataType: "USER-DEFINED", nullable: true }, // enum / composite
    { name: "tags", dataType: "ARRAY", nullable: true },
    { name: "doc", dataType: "xml", nullable: true },
    { name: "row", dataType: "record", nullable: true },
    { name: "search", dataType: "tsvector", nullable: true },
    { name: "lsn", dataType: "pg_lsn", nullable: true },
  ];

  test("postgres keyless BASE TABLE orders by the quoted ctid, never projecting it", () => {
    const res = planTableRows(keyless("postgres", EXOTIC, "table"), { table: "t" }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toContain("ORDER BY [ctid] LIMIT 100 OFFSET 0");
    // The locator orders the page but is NOT in the SELECT list — the wire shape is unchanged.
    expect(res.plan.selectSql.slice(0, res.plan.selectSql.indexOf("FROM"))).not.toContain("ctid");
    expect(res.plan.columns.map((c) => c.name)).toEqual(EXOTIC.map((c) => c.name));
  });

  test("the physical row locator WINS over orderable columns — precedence, not last resort", () => {
    // The relation HAS perfectly orderable columns, so this distinguishes "ctid because it
    // outranks them" from "ctid because nothing else was left": the locator is a TOTAL
    // order, the columns are not, and precedence (PK → locator → columns) says so.
    const res = planTableRows(
      keyless(
        "postgres",
        [
          { name: "id", dataType: "integer", nullable: false },
          { name: "created_at", dataType: "timestamp with time zone", nullable: true },
        ],
        "table",
      ),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toBe(
      "SELECT [id], [created_at] FROM [public].[t] ORDER BY [ctid] LIMIT 100 OFFSET 0",
    );
  });

  test("postgres keyless VIEW never gets a ctid — it orders by allowlisted columns only", () => {
    const res = planTableRows(
      keyless(
        "postgres",
        [
          { name: "id", dataType: "integer", nullable: false },
          { name: "payload", dataType: "jsonb", nullable: true },
        ],
        "view",
      ),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).not.toContain("ctid");
    // BOTH columns are allowlisted — `jsonb` has a btree opclass, so ordering by it is
    // accepted by the engine and the full orderable set is used.
    expect(res.plan.selectSql).toBe(
      "SELECT [id], [payload] FROM [public].[t] ORDER BY [id], [payload] LIMIT 100 OFFSET 0",
    );
  });

  // `view` and an ABSENT kind each already have a dedicated test above (the VIEW case) and
  // in the happy-path block (`events`, no kind → orders by its columns), so only `other`
  // needs its own fall-through case here.
  test("postgres keyless kind `other` falls through to orderable columns", () => {
    const res = planTableRows(
      keyless("postgres", [{ name: "id", dataType: "integer", nullable: false }], "other"),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).not.toContain("ctid");
    expect(res.plan.selectSql).toContain("ORDER BY [id] LIMIT");
  });

  test("a kind-less relation with only exotic columns composes NO ORDER BY at all", () => {
    // Non-total order, but never an ORDER BY the engine would reject (the documented
    // residual: closing it needs keyset pagination, which is out of scope).
    const res = planTableRows(keyless("postgres", EXOTIC), { table: "t" }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).not.toContain("ORDER BY");
    expect(res.plan.selectSql).toContain("FROM [public].[t] LIMIT 100 OFFSET 0");
  });

  test("mixed columns → ORDER BY only the allowlisted ones (postgres `json` is skipped)", () => {
    const res = planTableRows(
      keyless("postgres", [
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

  test("mysql keyless never emits a ctid, even for a BASE TABLE", () => {
    // MySQL has no physical row locator — the branch is postgres-only by construction.
    const res = planTableRows(
      keyless(
        "mysql",
        [
          { name: "id", dataType: "int", nullable: false },
          { name: "g", dataType: "geometry", nullable: true },
        ],
        "table",
      ),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).not.toContain("ctid");
    expect(res.plan.selectSql).toBe(
      "SELECT [id], [g] FROM [public].[t] ORDER BY [id] LIMIT 100 OFFSET 0",
    );
  });

  test("mysql keyless BASE TABLE with only unlisted types → no ORDER BY (fails closed)", () => {
    const res = planTableRows(
      keyless("mysql", [{ name: "g", dataType: "geometry", nullable: true }], "table"),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).not.toContain("ORDER BY");
  });

  // The allowlist must not UNDER-approximate either: a type that provably HAS a default
  // ordering operator — and that the old prefix denylist admitted — has to stay orderable,
  // or a keyless relation silently loses an ORDER BY it used to have.
  test("postgres `jsonb` is orderable (btree opclass) while plain `json` is NOT", () => {
    const res = planTableRows(
      keyless("postgres", [
        { name: "doc", dataType: "json", nullable: true }, // no ordering operator at all
        { name: "meta", dataType: "jsonb", nullable: true }, // jsonb_ops btree, since 9.4
        { name: "oid_col", dataType: "oid", nullable: true },
        { name: "name_col", dataType: "name", nullable: true },
      ]),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toContain("ORDER BY [meta], [oid_col], [name_col] LIMIT");
    const orderBy = res.plan.selectSql.slice(res.plan.selectSql.indexOf("ORDER BY"));
    expect(orderBy).not.toContain("[doc]");
  });

  test("mysql `json` and every BLOB width are orderable (the engine accepts the sort)", () => {
    // MySQL has a total ordering over JSON since 5.7 and sorts BLOBs by their first
    // `max_sort_length` bytes. `mediumblob`/`longblob`/`tinyblob` never matched the old
    // `"blob"` PREFIX denylist either, so they were ordered by before this change too.
    const res = planTableRows(
      keyless("mysql", [
        { name: "doc", dataType: "json", nullable: true },
        { name: "tiny", dataType: "tinyblob", nullable: true },
        { name: "plain", dataType: "blob", nullable: true },
        { name: "medium", dataType: "mediumblob", nullable: true },
        { name: "long", dataType: "longblob", nullable: true },
        { name: "g", dataType: "geometry", nullable: true }, // still NOT orderable
      ]),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toContain(
      "ORDER BY [doc], [tiny], [plain], [medium], [long] LIMIT",
    );
    const orderBy = res.plan.selectSql.slice(res.plan.selectSql.indexOf("ORDER BY"));
    expect(orderBy).not.toContain("[g]");
  });

  test("an UNKNOWN/unlisted dataType is excluded — the allowlist fails closed", () => {
    const res = planTableRows(
      keyless("postgres", [
        { name: "id", dataType: "integer", nullable: false },
        // A type this planner has never heard of (a future/extension type). A denylist
        // would have passed it through and let the engine reject the whole page.
        { name: "weird", dataType: "quantum_flux", nullable: true },
      ]),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toContain("ORDER BY [id] LIMIT");
  });

  test("dataType matching is exact-after-normalization, not by prefix", () => {
    const res = planTableRows(
      keyless("postgres", [
        { name: "padded", dataType: "  INTEGER  ", nullable: false }, // case + whitespace normalized
        { name: "notatext", dataType: "textish", nullable: true }, // prefix of "text" ⇒ still excluded
      ]),
      { table: "t" },
      q,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toContain("ORDER BY [padded] LIMIT");
  });

  test("a PRIMARY KEY still wins over the physical row locator", () => {
    const withPk: DatabaseSchema = {
      engine: "postgres",
      tables: [
        {
          schema: "public",
          name: "t",
          columns: [{ name: "id", dataType: "integer", nullable: false }],
          primaryKey: ["id"],
          indexes: [],
          foreignKeys: [],
          kind: "table",
        },
      ],
    };
    const res = planTableRows(withPk, { table: "t" }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toContain("ORDER BY [id] LIMIT");
    expect(res.plan.selectSql).not.toContain("ctid");
  });

  test("a mysql PRIMARY KEY table is unchanged by DW-33", () => {
    const withPk: DatabaseSchema = {
      engine: "mysql",
      tables: [
        {
          schema: "app",
          name: "users",
          columns: [
            { name: "id", dataType: "bigint", nullable: false },
            { name: "blob", dataType: "longblob", nullable: true },
          ],
          primaryKey: ["id"],
          indexes: [],
          foreignKeys: [],
          kind: "table",
        },
      ],
    };
    const res = planTableRows(withPk, { table: "users" }, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.selectSql).toBe(
      "SELECT [id], [blob] FROM [app].[users] ORDER BY [id] LIMIT 100 OFFSET 0",
    );
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
