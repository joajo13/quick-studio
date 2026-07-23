/**
 * quick-studio Core — driver selection + error-classification tests.
 *
 * Pure unit tests: no live Postgres/MySQL. `createDriver` is exercised only for
 * its scheme allowlist (it does not connect at factory time), and
 * `classifyConnectionError` is fed synthetic error objects carrying the same
 * `code`/`errno` tags the real drivers surface.
 */

import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import mysql2 from "mysql2";
import type { ConnectionFailureKind } from "../shared/contract.ts";
import {
  DriverConnectionError,
  assembleSchema,
  classifyConnectionError,
  createDriver,
  withTimeout,
  type IntrospectedForeignKey,
  type IntrospectedIndex,
} from "./driver.ts";
import { buildMysqlConfig, createMutex, mysqlSchemaScope } from "./driver-mysql.ts";
import {
  mapUnsafeResult,
  pgIndexColumnVisibility,
  pgSchemaScope,
  pgSupportsConparentid,
} from "./driver-postgres.ts";

/** A synthetic engine/OS error carrying the `code`/`errno` tags drivers surface. */
function fakeErr(tags: { code?: string; errno?: number }): Error {
  return Object.assign(new Error("synthetic"), tags);
}

describe("createDriver scheme selection", () => {
  for (const url of [
    "postgres://u:p@h:5432/db",
    "postgresql://u:p@h:5432/db",
    "mysql://u:p@h:3306/db",
  ]) {
    test(`returns a driver for a supported scheme: ${url.split("://")[0]}`, async () => {
      const driver = createDriver(url);
      expect(typeof driver.connect).toBe("function");
      expect(typeof driver.listSchema).toBe("function");
      expect(typeof driver.close).toBe("function");
      // Factory does not open a socket; close a never-connected driver so no
      // client handle lingers for the runner.
      await driver.close();
    });
  }

  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/plain,hi",
    "C:\\db\\thing", // Windows drive path carried from Story 1.2
  ]) {
    test(`refuses an unsupported scheme as unsupported_scheme: ${url}`, () => {
      let thrown: unknown;
      try {
        createDriver(url);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DriverConnectionError);
      expect((thrown as DriverConnectionError).kind).toBe("unsupported_scheme");
      // The message must never echo credentials — only the (non-secret) scheme.
      expect((thrown as DriverConnectionError).message).not.toContain("passwd");
    });
  }

  // DW-21 — a supported scheme whose URL is malformed (bad/out-of-range port or an
  // unparseable authority that makes `new URL()` throw) is a distinct `malformed-url`
  // verdict, NOT `unsupported_scheme`: the scheme IS one we speak, the URL is broken.
  // Decided structurally before any socket opens; credentials are never echoed. Covers
  // both supported schemes AND the `postgresql` alias, an out-of-range port, a truly
  // unparseable non-port authority, and a leading-whitespace URL (which `new URL()`
  // trims before throwing, so scheme recovery must normalize to match).
  for (const url of [
    "postgres://user:secret@host:99999/db", // out-of-range port, supported scheme
    "postgres://user:secret@host:5432x/db", // unparseable port authority
    "postgresql://user:secret@host:99999/db", // out-of-range port, `postgresql` alias
    "postgres://user:secret@ho st:5432/db", // space in authority → unparseable (non-port)
    "mysql://user:secret@host:99999/db", // out-of-range port, supported scheme (mysql)
    "  postgres://user:secret@host:99999/db", // leading whitespace + bad port
  ]) {
    test(`refuses a malformed supported-scheme URL as malformed-url: ${url.trim().split("://")[0]}`, () => {
      let thrown: unknown;
      try {
        createDriver(url);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DriverConnectionError);
      expect((thrown as DriverConnectionError).kind).toBe("malformed-url");
      // Credential-freedom is an ALLOWLIST invariant, not a denylist: the message must
      // be EXACTLY the neutral literal (naming only the non-secret scheme) — so a
      // regression that spliced any part of the raw URL back in would fail here, even
      // if it didn't happen to contain the words "secret"/"user".
      const scheme = url.trim().split(":")[0];
      expect((thrown as DriverConnectionError).message).toBe(
        `malformed "${scheme}" database URL (could not be parsed)`,
      );
    });
  }

  // A string with NO extractable scheme AND that `new URL()` rejects stays
  // `unsupported_scheme` (no recovered scheme → not a supported-but-malformed URL).
  test("refuses a string with no extractable scheme as unsupported_scheme", () => {
    let thrown: unknown;
    try {
      createDriver("://nonsense");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DriverConnectionError);
    expect((thrown as DriverConnectionError).kind).toBe("unsupported_scheme");
  });

  // The load-bearing distinction: a malformed URL whose scheme is UNSUPPORTED must
  // still be `unsupported_scheme`, NOT `malformed-url` — recovery only escalates a
  // malformed URL when its recovered scheme is one we actually speak.
  test("refuses a malformed UNsupported-scheme URL as unsupported_scheme", () => {
    let thrown: unknown;
    try {
      createDriver("redis://host:99999/db"); // supported-looking, but redis is not spoken
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DriverConnectionError);
    expect((thrown as DriverConnectionError).kind).toBe("unsupported_scheme");
  });
});

describe("classifyConnectionError", () => {
  const cases: ReadonlyArray<[string, Error, ConnectionFailureKind]> = [
    ["ENOTFOUND → host", fakeErr({ code: "ENOTFOUND" }), "host"],
    ["EAI_AGAIN → host", fakeErr({ code: "EAI_AGAIN" }), "host"],
    ["PG 28P01 → auth", fakeErr({ code: "28P01" }), "auth"],
    ["PG 28000 → auth", fakeErr({ code: "28000" }), "auth"],
    ["MySQL ER_ACCESS_DENIED_ERROR → auth", fakeErr({ code: "ER_ACCESS_DENIED_ERROR" }), "auth"],
    ["MySQL errno 1045 → auth", fakeErr({ code: "SOMETHING", errno: 1045 }), "auth"],
    ["MySQL ER_DBACCESS_DENIED_ERROR → auth", fakeErr({ code: "ER_DBACCESS_DENIED_ERROR" }), "auth"],
    // Post-handshake introspection privilege denials (DW-19) map to `auth`.
    ["PG 42501 (insufficient_privilege) → auth", fakeErr({ code: "42501" }), "auth"],
    ["MySQL ER_TABLEACCESS_DENIED_ERROR → auth", fakeErr({ code: "ER_TABLEACCESS_DENIED_ERROR" }), "auth"],
    ["MySQL errno 1142 → auth", fakeErr({ code: "SOMETHING", errno: 1142 }), "auth"],
    ["MySQL ER_COLUMNACCESS_DENIED_ERROR → auth", fakeErr({ code: "ER_COLUMNACCESS_DENIED_ERROR" }), "auth"],
    ["MySQL ER_SPECIFIC_ACCESS_DENIED_ERROR → auth", fakeErr({ code: "ER_SPECIFIC_ACCESS_DENIED_ERROR" }), "auth"],
    ["ECONNREFUSED → network", fakeErr({ code: "ECONNREFUSED" }), "network"],
    ["ETIMEDOUT → network", fakeErr({ code: "ETIMEDOUT" }), "network"],
    ["ECONNRESET → network", fakeErr({ code: "ECONNRESET" }), "network"],
    ["unknown code → network", fakeErr({ code: "EWHATEVER" }), "network"],
    ["no tags → network", new Error("bare"), "network"],
    // DW-18 — missing catalog (host+auth were fine, the named database does not exist).
    ["PG 3D000 → database-does-not-exist", fakeErr({ code: "3D000" }), "database-does-not-exist"],
    ["MySQL ER_BAD_DB_ERROR → database-does-not-exist", fakeErr({ code: "ER_BAD_DB_ERROR" }), "database-does-not-exist"],
    ["MySQL errno 1049 → database-does-not-exist", fakeErr({ code: "SOMETHING", errno: 1049 }), "database-does-not-exist"],
  ];

  for (const [label, err, expected] of cases) {
    test(label, () => {
      expect(classifyConnectionError(err)).toBe(expected);
    });
  }

  test("never returns unsupported_scheme (that is createDriver's verdict alone)", () => {
    expect(classifyConnectionError(fakeErr({ code: "file" }))).toBe("network");
  });

  test("never returns malformed-url (that is createDriver's structural verdict alone)", () => {
    // No engine/OS error carries a URL-parse verdict — an unrecognized code defaults
    // to `network`, never `malformed-url`.
    expect(classifyConnectionError(fakeErr({ code: "malformed-url" }))).toBe("network");
    expect(classifyConnectionError(fakeErr({ errno: 99999 }))).toBe("network");
  });
});

// DW-20 — the client-side bound wrapping `listSchema` introspection. It must pass a
// fast op's value/rejection straight through, reject a never-settling op after the
// bound, and — critically — clear its timer on settle so no lingering handle keeps the
// runner alive. Exercised directly with plain promises, no live DB.
describe("withTimeout (introspection bound)", () => {
  test("resolves passthrough: a settled op's value comes straight through", async () => {
    expect(await withTimeout(Promise.resolve(42), 1000)).toBe(42);
  });

  test("rejects after the bound when the op never settles", async () => {
    // A never-settling promise + a tiny bound → the timer wins and rejects.
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow("timed out");
  });

  test("a fast-settling op clears the timer and does not hang the runner", async () => {
    // The bound is huge (100s): if the timer were NOT cleared on settle, its dangling
    // handle would keep the process alive ~100s. A prompt resolve proves it is cleared.
    expect(await withTimeout(Promise.resolve("ok"), 100000)).toBe("ok");
  });

  test("propagates the op's own rejection (not the timer's)", async () => {
    // The op loses no error identity: its rejection — not a "timed out" — surfaces.
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
  });
});

describe("assembleSchema", () => {
  test("folds pre-ordered flat columns into grouped tables, preserving order", () => {
    const schema = assembleSchema("postgres", [
      { schema: "public", table: "users", column: "id", dataType: "integer", nullable: false },
      { schema: "public", table: "users", column: "email", dataType: "text", nullable: true },
      { schema: "public", table: "orders", column: "id", dataType: "integer", nullable: false },
    ]);

    expect(schema.engine).toBe("postgres");
    expect(schema.tables.map((t) => t.name)).toEqual(["users", "orders"]);
    expect(schema.tables[0]?.columns).toEqual([
      { name: "id", dataType: "integer", nullable: false },
      { name: "email", dataType: "text", nullable: true },
    ]);
  });

  test("an empty column set yields an empty table list", () => {
    expect(assembleSchema("mysql", [])).toEqual({ engine: "mysql", tables: [] });
  });

  test("a table with no indexes still carries an empty `indexes` array", () => {
    const schema = assembleSchema("postgres", [
      { schema: "public", table: "logs", column: "msg", dataType: "text", nullable: true },
    ]);
    expect(schema.tables[0]?.indexes).toEqual([]);
  });
});

describe("assembleSchema — index folding (Story 3.5)", () => {
  test("groups flat index rows by name, preserves column order, and derives unique", () => {
    const indexes: IntrospectedIndex[] = [
      // PK-backing index (unique) — must appear, not be filtered out.
      { schema: "public", table: "users", indexName: "users_pkey", unique: true, column: "id" },
      // Single-column unique secondary index.
      { schema: "public", table: "users", indexName: "users_email_key", unique: true, column: "email" },
      // Composite non-unique index on (b, a) — columns arrive in INDEX order b, a.
      { schema: "public", table: "users", indexName: "ix_users_ba", unique: false, column: "b" },
      { schema: "public", table: "users", indexName: "ix_users_ba", unique: false, column: "a" },
    ];
    const schema = assembleSchema(
      "postgres",
      [
        { schema: "public", table: "users", column: "id", dataType: "integer", nullable: false },
        { schema: "public", table: "users", column: "email", dataType: "text", nullable: true },
        { schema: "public", table: "users", column: "a", dataType: "integer", nullable: true },
        { schema: "public", table: "users", column: "b", dataType: "integer", nullable: true },
      ],
      indexes,
    );

    expect(schema.tables[0]?.indexes).toEqual([
      { name: "users_pkey", columns: ["id"], unique: true },
      { name: "users_email_key", columns: ["email"], unique: true },
      { name: "ix_users_ba", columns: ["b", "a"], unique: false },
    ]);
  });

  test("attaches indexes to the correct table when several tables are present", () => {
    const schema = assembleSchema(
      "mysql",
      [
        { schema: "db", table: "orders", column: "id", dataType: "int", nullable: false },
        { schema: "db", table: "items", column: "id", dataType: "int", nullable: false },
      ],
      [
        { schema: "db", table: "orders", indexName: "PRIMARY", unique: true, column: "id" },
        { schema: "db", table: "items", indexName: "ix_items_sku", unique: false, column: "sku" },
      ],
    );
    const orders = schema.tables.find((t) => t.name === "orders");
    const items = schema.tables.find((t) => t.name === "items");
    expect(orders?.indexes).toEqual([{ name: "PRIMARY", columns: ["id"], unique: true }]);
    expect(items?.indexes).toEqual([{ name: "ix_items_sku", columns: ["sku"], unique: false }]);
  });

  test("omitting the indexes argument leaves every table with an empty `indexes`", () => {
    const schema = assembleSchema("postgres", [
      { schema: "public", table: "t", column: "c", dataType: "text", nullable: true },
    ]);
    expect(schema.tables[0]?.indexes).toEqual([]);
  });

  test("index rows for a table absent from the column list never spawn a phantom table", () => {
    // Postgres surfaces indexes from the system catalogs (pg_toast toast indexes,
    // materialized-view indexes) for relations that `information_schema.columns` never
    // lists. Those index rows must be dropped, not materialized into a column-less table.
    const schema = assembleSchema(
      "postgres",
      [{ schema: "public", table: "users", column: "id", dataType: "integer", nullable: false }],
      [
        { schema: "public", table: "users", indexName: "users_pkey", unique: true, column: "id" },
        // No `pg_toast.pg_toast_16384` / matview table exists in the column list:
        { schema: "pg_toast", table: "pg_toast_16384", indexName: "pg_toast_16384_index", unique: true, column: "chunk_id" },
        { schema: "public", table: "mv_report", indexName: "mv_report_idx", unique: false, column: "day" },
      ],
    );
    expect(schema.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(["public.users"]);
    expect(schema.tables[0]?.indexes).toEqual([{ name: "users_pkey", columns: ["id"], unique: true }]);
  });
});

describe("assembleSchema — foreign-key folding (Story 4.1)", () => {
  test("groups flat FK rows by constraint name and attaches them to the owning table", () => {
    const foreignKeys: IntrospectedForeignKey[] = [
      {
        schema: "public",
        table: "orders",
        constraintName: "orders_user_id_fkey",
        column: "user_id",
        referencedSchema: "public",
        referencedTable: "users",
        referencedColumn: "id",
      },
    ];
    const schema = assembleSchema(
      "postgres",
      [
        { schema: "public", table: "orders", column: "id", dataType: "integer", nullable: false },
        { schema: "public", table: "orders", column: "user_id", dataType: "integer", nullable: false },
        { schema: "public", table: "users", column: "id", dataType: "integer", nullable: false },
      ],
      [],
      foreignKeys,
    );
    const orders = schema.tables.find((t) => t.name === "orders");
    const users = schema.tables.find((t) => t.name === "users");
    expect(orders?.foreignKeys).toEqual([
      { columns: ["user_id"], referencedSchema: "public", referencedTable: "users", referencedColumns: ["id"] },
    ]);
    // A table with no outbound FK still carries an empty `foreignKeys` array.
    expect(users?.foreignKeys).toEqual([]);
  });

  test("a COMPOSITE FK folds into ONE entry with position-aligned columns (not one per column)", () => {
    const foreignKeys: IntrospectedForeignKey[] = [
      // Two rows sharing one constraint name → one composite FK, in key order.
      {
        schema: "public",
        table: "line_items",
        constraintName: "line_items_op_fkey",
        column: "order_id",
        referencedSchema: "public",
        referencedTable: "order_products",
        referencedColumn: "order_id",
      },
      {
        schema: "public",
        table: "line_items",
        constraintName: "line_items_op_fkey",
        column: "product_id",
        referencedSchema: "public",
        referencedTable: "order_products",
        referencedColumn: "product_id",
      },
    ];
    const schema = assembleSchema(
      "postgres",
      [
        { schema: "public", table: "line_items", column: "order_id", dataType: "integer", nullable: false },
        { schema: "public", table: "line_items", column: "product_id", dataType: "integer", nullable: false },
        { schema: "public", table: "order_products", column: "order_id", dataType: "integer", nullable: false },
      ],
      [],
      foreignKeys,
    );
    expect(schema.tables.find((t) => t.name === "line_items")?.foreignKeys).toEqual([
      {
        columns: ["order_id", "product_id"],
        referencedSchema: "public",
        referencedTable: "order_products",
        referencedColumns: ["order_id", "product_id"],
      },
    ]);
  });

  test("a SELF-referential FK references its own table", () => {
    const schema = assembleSchema(
      "mysql",
      [
        { schema: "app", table: "employees", column: "id", dataType: "int", nullable: false },
        { schema: "app", table: "employees", column: "manager_id", dataType: "int", nullable: true },
      ],
      [],
      [
        {
          schema: "app",
          table: "employees",
          constraintName: "fk_manager",
          column: "manager_id",
          referencedSchema: "app",
          referencedTable: "employees",
          referencedColumn: "id",
        },
      ],
    );
    expect(schema.tables[0]?.foreignKeys).toEqual([
      { columns: ["manager_id"], referencedSchema: "app", referencedTable: "employees", referencedColumns: ["id"] },
    ]);
  });

  test("FK rows for a table absent from the column list never spawn a phantom table", () => {
    const schema = assembleSchema(
      "postgres",
      [{ schema: "public", table: "users", column: "id", dataType: "integer", nullable: false }],
      [],
      [
        {
          schema: "public",
          table: "ghost",
          constraintName: "ghost_fk",
          column: "x",
          referencedSchema: "public",
          referencedTable: "users",
          referencedColumn: "id",
        },
      ],
    );
    expect(schema.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(["public.users"]);
    expect(schema.tables[0]?.foreignKeys).toEqual([]);
  });

  test("omitting the foreignKeys argument leaves every table with an empty `foreignKeys`", () => {
    const schema = assembleSchema("postgres", [
      { schema: "public", table: "t", column: "c", dataType: "text", nullable: true },
    ]);
    expect(schema.tables[0]?.foreignKeys).toEqual([]);
  });
});

describe("assembleSchema — primary-key folding (DW-31 key order)", () => {
  test("a composite PK folds in KEY order, not table-column order", () => {
    // Columns arrive in table order [a, b]; the PK's own ordinal order is [b, a].
    // `primaryKey` must mirror the KEY order (the adapters pre-order the PK rows by the
    // key's own `ordinal_position`), so it comes out ["b", "a"], not ["a", "b"].
    const schema = assembleSchema(
      "postgres",
      [
        { schema: "public", table: "t", column: "a", dataType: "integer", nullable: false },
        { schema: "public", table: "t", column: "b", dataType: "integer", nullable: false },
      ],
      [],
      [],
      [
        { schema: "public", table: "t", column: "b" },
        { schema: "public", table: "t", column: "a" },
      ],
    );
    expect(schema.tables[0]?.primaryKey).toEqual(["b", "a"]);
  });

  test("a single-column PK folds to a one-element list", () => {
    const schema = assembleSchema(
      "postgres",
      [{ schema: "public", table: "users", column: "id", dataType: "integer", nullable: false }],
      [],
      [],
      [{ schema: "public", table: "users", column: "id" }],
    );
    expect(schema.tables[0]?.primaryKey).toEqual(["id"]);
  });

  test("a table with no PK rows carries an empty `primaryKey`", () => {
    const schema = assembleSchema(
      "postgres",
      [{ schema: "public", table: "logs", column: "msg", dataType: "text", nullable: true }],
      [],
      [],
      [],
    );
    expect(schema.tables[0]?.primaryKey).toEqual([]);
  });

  test("a PK row for a table absent from the column list never spawns a phantom table", () => {
    const schema = assembleSchema(
      "postgres",
      [{ schema: "public", table: "users", column: "id", dataType: "integer", nullable: false }],
      [],
      [],
      [
        { schema: "public", table: "users", column: "id" },
        // No `ghost` table exists in the column list — this PK row must be dropped.
        { schema: "public", table: "ghost", column: "x" },
      ],
    );
    expect(schema.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(["public.users"]);
    expect(schema.tables[0]?.primaryKey).toEqual(["id"]);
  });
});

// DW-42: `pg_constraint.conparentid` exists only on PostgreSQL 11+
// (`server_version_num >= 110000`), so the FK query gates the partition-copy filter on
// this boundary. Prove the boundary directly (no live DB needed).
describe("pgSupportsConparentid — PG 11 version boundary (DW-42)", () => {
  test("PG 10 (100000) is unsupported; PG 11 (110000) and PG 16 (160001) are supported", () => {
    expect(pgSupportsConparentid(100000)).toBe(false);
    expect(pgSupportsConparentid(110000)).toBe(true);
    expect(pgSupportsConparentid(160001)).toBe(true);
  });
});

// Story 10.2 — the pinned-schema scope predicate shared by the four mysql
// introspection queries. Pure, so the precedence rule (R2: the pin wins over the
// URL's own database) and the untouched no-pin path are provable without a live mysql.
describe("mysqlSchemaScope — pinned introspection scope (Story 10.2)", () => {
  const SYSTEM = ["information_schema", "performance_schema", "mysql", "sys"];

  test("pinned + URL database: the PIN wins (R2)", () => {
    expect(mysqlSchemaScope("reporting", "appdb")).toEqual({
      where: "table_schema = ?",
      params: ["reporting"],
    });
  });

  test("pinned only (URL has no database path): scoped to the pin", () => {
    expect(mysqlSchemaScope("reporting", null)).toEqual({
      where: "table_schema = ?",
      params: ["reporting"],
    });
  });

  test("no pin + URL database: today's behavior, scoped to the URL's database", () => {
    expect(mysqlSchemaScope(undefined, "appdb")).toEqual({
      where: "table_schema = ?",
      params: ["appdb"],
    });
  });

  test("neither: today's behavior, the system schemas excluded by placeholder", () => {
    expect(mysqlSchemaScope(undefined, null)).toEqual({
      where: "table_schema NOT IN (?, ?, ?, ?)",
      params: SYSTEM,
    });
  });

  test("a blank/whitespace pin counts as UNSET at the driver boundary", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      expect(mysqlSchemaScope(blank, "appdb")).toEqual({
        where: "table_schema = ?",
        params: ["appdb"],
      });
      expect(mysqlSchemaScope(blank, null)).toEqual({
        where: "table_schema NOT IN (?, ?, ?, ?)",
        params: SYSTEM,
      });
    }
  });

  test("the schema name is a bound VALUE, never spliced into the predicate text", () => {
    const scope = mysqlSchemaScope("evil'; DROP TABLE t; --", null);
    expect(scope.where).toBe("table_schema = ?");
    expect(scope.params).toEqual(["evil'; DROP TABLE t; --"]);
  });

  test("returns FRESH arrays per call (mysql2 consumes them positionally)", () => {
    expect(mysqlSchemaScope(undefined, null).params).not.toBe(
      mysqlSchemaScope(undefined, null).params,
    );
  });

  // The TRIMMED pin is what gets bound, not the raw stored string: `"  reporting  "`
  // would match zero tables as a value comparison against `table_schema`.
  test("a padded pin is bound TRIMMED, not raw", () => {
    expect(mysqlSchemaScope("  reporting  ", "appdb")).toEqual({
      where: "table_schema = ?",
      params: ["reporting"],
    });
  });
});

// Story 10.2 — the postgres counterpart. No live DB: postgres.js builds a `sql`…``
// fragment LAZILY, exposing the literal text parts as `strings` and the values it will
// BIND as `args`, so both arms are fully provable against a never-connected client
// (same trick as the extended-protocol backstop below, which never opens a socket
// against the non-routable 127.0.0.1:1).
//
// This locks the two properties nothing else in the suite can: (a) the UNPINNED arms
// reproduce the pre-10.2 predicates VERBATIM — a one-character drift in
// `n.nspname !~ '^pg_'` would silently resurface every `pg_toast` index for every
// existing connection — and (b) the PINNED arms carry the schema as a bound ARG, never
// spliced into the query text.
/**
 * The literal SQL text of a fragment: its `strings` parts with each bind slot marked.
 *
 * `strings`/`args` are postgres.js INTERNALS, not public API — reached through `unknown`
 * on purpose. If a postgres.js bump ever renamed them these helpers would throw rather
 * than fail an assertion, and the real damage would be that every predicate lock below
 * silently stopped meaning anything. Shared by the 10.2 and 10.3 blocks so that coupling
 * lives in exactly one place.
 */
const textOf = (fragment: unknown): string =>
  (fragment as { strings: readonly string[] }).strings.join("$?");
/** The values postgres.js will BIND for a fragment (empty ⇒ pure literal predicate). */
const argsOf = (fragment: unknown): readonly unknown[] =>
  (fragment as { args: readonly unknown[] }).args;

/**
 * Run `fn` against a never-connected postgres.js client (non-routable 127.0.0.1:1), then
 * end it. `fn` may be async — its promise is awaited BEFORE teardown, so a future async
 * assertion cannot run after the client is gone or be skipped outright.
 */
const withSql = async (
  run: (sql: ReturnType<typeof postgres>) => void | Promise<void>,
): Promise<void> => {
  const sql = postgres("postgres://u:p@127.0.0.1:1/db", { max: 1 });
  try {
    await run(sql);
  } finally {
    await sql.end({ timeout: 1 });
  }
};

describe("pgSchemaScope — pinned introspection scope (Story 10.2)", () => {
  test("UNPINNED: the four predicates are today's, verbatim, with NOTHING bound", async () => {
    await withSql((sql) => {
      const scope = pgSchemaScope(sql, undefined);
      expect(textOf(scope.colScope)).toBe(
        "table_schema NOT IN ('pg_catalog', 'information_schema')",
      );
      expect(textOf(scope.pkScope)).toBe(
        "tc.table_schema NOT IN ('pg_catalog', 'information_schema')",
      );
      expect(textOf(scope.idxScope)).toBe(
        "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'",
      );
      expect(textOf(scope.fkScope)).toBe(
        "con_ns.nspname !~ '^pg_' AND con_ns.nspname <> 'information_schema'",
      );
      for (const fragment of Object.values(scope)) expect(argsOf(fragment)).toEqual([]);
    });
  });

  test("PINNED: each predicate is an equality whose value is a BOUND arg, never text", async () => {
    await withSql((sql) => {
      const scope = pgSchemaScope(sql, "reporting");
      expect(textOf(scope.colScope)).toBe("table_schema = $?");
      expect(textOf(scope.pkScope)).toBe("tc.table_schema = $?");
      expect(textOf(scope.idxScope)).toBe("n.nspname = $?");
      expect(textOf(scope.fkScope)).toBe("con_ns.nspname = $?");
      for (const fragment of Object.values(scope)) {
        expect(argsOf(fragment)).toEqual(["reporting"]);
        // The name lives ONLY in the bind slot — no fragment's text mentions it.
        expect(textOf(fragment)).not.toContain("reporting");
      }
    });
  });

  test("a hostile schema name stays a bound VALUE (no splice, no injection)", async () => {
    await withSql((sql) => {
      const evil = "public'; DROP TABLE t; --";
      const scope = pgSchemaScope(sql, evil);
      expect(textOf(scope.colScope)).toBe("table_schema = $?");
      expect(argsOf(scope.colScope)).toEqual([evil]);
    });
  });

  test("a blank/whitespace pin falls back to the UNPINNED arms (driver-boundary defense)", async () => {
    await withSql((sql) => {
      for (const blank of ["", "   ", "\t\n"]) {
        const scope = pgSchemaScope(sql, blank);
        expect(textOf(scope.colScope)).toBe(
          "table_schema NOT IN ('pg_catalog', 'information_schema')",
        );
        expect(argsOf(scope.colScope)).toEqual([]);
      }
    });
  });

  test("a padded pin is bound TRIMMED, not raw", async () => {
    await withSql((sql) => {
      const scope = pgSchemaScope(sql, "  reporting  ");
      for (const fragment of Object.values(scope)) expect(argsOf(fragment)).toEqual(["reporting"]);
    });
  });
});

// Story 10.3 — the index query's per-column PRIVILEGE alignment, locked on two axes.
//
// (1) The fragment's text. Ground truth is Postgres's own `information_schema.columns`
// view — `src/backend/catalog/information_schema.sql` in the server source, whose WHERE
// ends with `pg_has_role(c.relowner, 'USAGE') OR has_column_privilege(c.oid, a.attnum,
// 'SELECT, INSERT, UPDATE, REFERENCES')`. `EXPECTED` below is that clause re-aliased to
// the index query's `t`/`a`. Being a literal copy, this test is a change-DETECTOR: it
// catches accidental drift, NOT a deliberate edit made in both places at once. Anyone
// touching it must re-check the predicate against the view definition above, since a
// silently weaker check would let the index query surface a (table, column) pair the
// columns query hides. If a future PG release adds a privilege to that list, the two
// diverge and this test will not notice.
//
// (2) The SPLICE. A correct fragment nobody interpolates is worth nothing, and deleting
// `AND ${idxVisibility}` from the query would still compile and still pass every
// assertion about the fragment itself. The composed query is only reachable through a
// live connection, so the splice is asserted against the module's own SOURCE TEXT
// instead — the one offline way to prove the predicate actually reaches the WHERE.
describe("pgIndexColumnVisibility — index/columns privilege alignment (Story 10.3)", () => {
  // Postgres's own `information_schema.columns` privilege check, re-aliased to `t`/`a`.
  const EXPECTED =
    "(pg_has_role(t.relowner, 'USAGE') OR has_column_privilege(t.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES'))";

  test("the predicate is information_schema.columns' own check, character for character", async () => {
    await withSql((sql) => {
      expect(textOf(pgIndexColumnVisibility(sql))).toBe(EXPECTED);
    });
  });

  test("it binds NOTHING — a pure literal predicate, no parameters", async () => {
    await withSql((sql) => {
      expect(argsOf(pgIndexColumnVisibility(sql))).toEqual([]);
    });
  });

  // The fragment carries no FROM clause of its own: it is only correct because the index
  // query already binds `pg_class t` and `pg_attribute a`. It must also be parenthesized
  // as ONE unit, or `AND ${fragment}` would re-associate with the sibling conjuncts
  // (`${idxScope}`, `a.attnum > 0`) around its internal `OR` and widen the result set —
  // so depth must never return to 0 before the final character.
  test("it is one parenthesized unit over the t./a. aliases the index query binds", async () => {
    await withSql((sql) => {
      const text = textOf(pgIndexColumnVisibility(sql));
      expect(text).toContain("t.relowner");
      expect(text).toContain("t.oid");
      expect(text).toContain("a.attnum");
      let depth = 0;
      let closedEarly = false;
      for (const [i, ch] of [...text].entries()) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (depth === 0 && i < text.length - 1) closedEarly = true;
      }
      expect(closedEarly).toBe(false);
      expect(depth).toBe(0);
    });
  });

  // The splice itself. Reads the adapter's source rather than trusting that the one call
  // site stays wired — an unused `const idxVisibility` compiles clean, so nothing else in
  // the suite would notice the privilege filter quietly leaving the query.
  test("the index query's WHERE actually splices the predicate, beside scope and attnum", async () => {
    const source = await Bun.file(
      new URL("./driver-postgres.ts", import.meta.url).pathname,
    ).text();
    const where = source.slice(
      source.indexOf("FROM pg_index ix"),
      source.indexOf("ORDER BY n.nspname, t.relname, i.relname"),
    );
    expect(where).toContain("WHERE ${idxScope}");
    expect(where).toContain("AND a.attnum > 0");
    expect(where).toContain("AND ${idxVisibility}");
  });
});

// Story 3.1 — mysql read-only-transaction ISOLATION: the driver serializes
// `query`/`queryReadOnly` behind this mutex so two concurrent `execute` RPCs cannot
// interleave the START/statement/ROLLBACK sequence on the single shared connection
// (mysql `START TRANSACTION` implicitly commits the in-flight tx). Here we prove the
// serialization guarantee directly, without a live mysql.
describe("createMutex — serializes overlapping tasks (mysql read-only isolation)", () => {
  test("a second task never begins until the first has settled", async () => {
    const run = createMutex();
    const trace: string[] = [];
    const gate = { resolve: (): void => {} };
    const first = new Promise<void>((r) => {
      gate.resolve = r;
    });

    const a = run(async () => {
      trace.push("A:start");
      await first; // hold the mutex open across an await point
      trace.push("A:end");
    });
    const b = run(async () => {
      trace.push("B:start");
      trace.push("B:end");
    });

    // B was enqueued while A holds the slot: it must NOT have started yet.
    await Promise.resolve();
    expect(trace).toEqual(["A:start"]);

    gate.resolve();
    await Promise.all([a, b]);
    // Strict ordering — no interleave: A fully finishes before B begins.
    expect(trace).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  test("a rejected task does not wedge the queue for the next", async () => {
    const run = createMutex();
    const a = run(async () => {
      throw new Error("boom");
    });
    await expect(a).rejects.toThrow("boom");
    const b = await run(async () => 42);
    expect(b).toBe(42);
  });
});

// Story 3.1 — postgres DRIVER-BOUNDARY BACKSTOP: raw execution must NOT use the
// simple-query protocol (which runs every `;`-command). The adapter forces the
// EXTENDED protocol by passing `{ simple: false }` to `sql.unsafe`. postgres.js
// builds the query lazily (it only hits the wire on await), so we can inspect the
// protocol choice WITHOUT a live postgres: extended = the multi-command backstop.
describe("postgres extended-protocol backstop (no live DB)", () => {
  test("default sql.unsafe(text) with no params selects the SIMPLE protocol (the vulnerable default)", async () => {
    const sql = postgres("postgres://u:p@127.0.0.1:1/db", { max: 1 });
    try {
      const q = sql.unsafe("SELECT 1; DROP TABLE users") as unknown as { options: { simple: boolean } };
      expect(q.options.simple).toBe(true);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  test("forcing { simple: false } selects the EXTENDED protocol (rejects multi-command at the server)", async () => {
    const sql = postgres("postgres://u:p@127.0.0.1:1/db", { max: 1 });
    try {
      const opts = { simple: false } as unknown as { prepare?: boolean };
      const q = sql.unsafe("SELECT 1; DROP TABLE users", [], opts) as unknown as { options: { simple: boolean } };
      expect(q.options.simple).toBe(false);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

// DW-29 / DW-38 — the postgres raw-read path maps rows POSITIONALLY (`.values()`
// array row-mode) so duplicate/aliased output columns (`SELECT id, id`) keep their
// distinct per-position values instead of collapsing to the last name-keyed value.
// `mapUnsafeResult` is the pure mapping seam; the values-mode result is an Array that
// also carries `columns`/`count`, fabricated here via `Object.assign([...rows], …)`.
describe("postgres runUnsafe positional row mapping (DW-29 / DW-38)", () => {
  test("duplicate output names do NOT collapse — both values survive at their positions", () => {
    const result = Object.assign(
      [
        [1, 2],
        [3, 4],
      ],
      { columns: [{ name: "id" }, { name: "id" }], count: 2 },
    );
    const mapped = mapUnsafeResult(result);
    expect(mapped.columns).toEqual([{ name: "id" }, { name: "id" }]);
    expect(mapped.rows).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(mapped.rowsAffected).toBe(2);
  });

  test("unique columns (browse) map unchanged", () => {
    const result = Object.assign([[7, "a"]], {
      columns: [{ name: "id" }, { name: "name" }],
      count: 1,
    });
    const mapped = mapUnsafeResult(result);
    expect(mapped.columns).toEqual([{ name: "id" }, { name: "name" }]);
    expect(mapped.rows).toEqual([[7, "a"]]);
    expect(mapped.rowsAffected).toBe(1);
  });

  test("empty result keeps columns and reports zero rows", () => {
    const result = Object.assign([] as unknown[][], { columns: [{ name: "id" }], count: 0 });
    const mapped = mapUnsafeResult(result);
    expect(mapped.columns).toEqual([{ name: "id" }]);
    expect(mapped.rows).toEqual([]);
    expect(mapped.rowsAffected).toBe(0);
  });

  test("missing count falls back to rows.length", () => {
    const result = Object.assign([] as unknown[][], { columns: [] });
    const mapped = mapUnsafeResult(result);
    expect(mapped.columns).toEqual([]);
    expect(mapped.rows).toEqual([]);
    expect(mapped.rowsAffected).toBe(0);
  });

  // A mutation (INSERT/UPDATE/DELETE) reaches `runUnsafe` too: postgres.js returns an
  // EMPTY row array whose `count` is the AFFECTED-row count and whose `columns` is the
  // real `null` default (no RowDescription). So `rowsAffected` must come from `count`,
  // NOT `rows.length` — pinning that provenance (an impl that used `rows.length` would
  // report 0 affected for every UPDATE/DELETE) and exercising the real `columns ?? []`
  // null branch that the other cases (which pass `[]`) never hit.
  test("mutation: count drives rowsAffected even when it differs from rows.length; null columns → []", () => {
    const result = Object.assign([] as unknown[][], { columns: null, count: 3 });
    const mapped = mapUnsafeResult(result);
    expect(mapped.columns).toEqual([]);
    expect(mapped.rows).toEqual([]);
    expect(mapped.rowsAffected).toBe(3);
  });

  // No live DB: postgres.js builds the query lazily and `.values()` flips the query's
  // internal `isRaw` to 'values' before it ever hits the wire, so we can prove the
  // raw-read is issued in array row-mode without a server. Crucially we inspect the
  // FULL production call shape — `.unsafe(text, params, { simple: false }).values()` —
  // and assert BOTH invariants on the SAME chained query: `isRaw === 'values'` (the
  // positional fix) AND `options.simple === false` (the multi-command backstop must
  // survive the `.values()` chaining — a refactor that drops FORCE_EXTENDED on this
  // path would reopen the SQL-injection vector, so it is pinned here, not just in the
  // separate extended-protocol test that omits `.values()`).
  test("the raw-read query is issued in values row-mode AND keeps the { simple: false } backstop", async () => {
    const sql = postgres("postgres://u:p@127.0.0.1:1/db", { max: 1 });
    try {
      const q = sql
        .unsafe("SELECT id, id FROM t", [], { simple: false } as unknown as { prepare?: boolean })
        .values() as unknown as { isRaw?: unknown; options: { simple: boolean } };
      expect(q.isRaw).toBe("values");
      expect(q.options.simple).toBe(false);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

describe("mysql multi-statement backstop (no live DB)", () => {
  // mysql2's real ConnectionConfig applies the SAME URI-parse + option-merge the live
  // driver hits at connect time, so feeding it `buildMysqlConfig(url)` proves the
  // effective, post-merge `multipleStatements` value the server would actually use.
  const ConnectionConfig = (
    mysql2 as unknown as {
      ConnectionConfig: new (opts: unknown) => {
        multipleStatements: boolean;
        host: string;
        database: string;
      };
    }
  ).ConnectionConfig;

  test("a plain mysql URL yields multipleStatements:false (backstop always on)", () => {
    const cfg = new ConnectionConfig(buildMysqlConfig("mysql://u:p@localhost:3306/db"));
    expect(cfg.multipleStatements).toBe(false);
  });

  test("a URL carrying ?multipleStatements=true is OVERRIDDEN to false (explicit wins)", () => {
    const cfg = new ConnectionConfig(
      buildMysqlConfig("mysql://u:p@localhost:3306/db?multipleStatements=true"),
    );
    expect(cfg.multipleStatements).toBe(false);
    // …while the rest of the URL still flows through unchanged.
    expect(cfg.host).toBe("localhost");
    expect(cfg.database).toBe("db");
  });

  test("buildMysqlConfig pins the flag off in its returned options object", () => {
    expect(
      buildMysqlConfig("mysql://u:p@h/db?multipleStatements=true").multipleStatements,
    ).toBe(false);
  });
});
