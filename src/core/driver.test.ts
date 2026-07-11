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
  type IntrospectedIndex,
} from "./driver.ts";
import { buildMysqlConfig, createMutex } from "./driver-mysql.ts";

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
    ["ECONNREFUSED → network", fakeErr({ code: "ECONNREFUSED" }), "network"],
    ["ETIMEDOUT → network", fakeErr({ code: "ETIMEDOUT" }), "network"],
    ["ECONNRESET → network", fakeErr({ code: "ECONNRESET" }), "network"],
    ["unknown code → network", fakeErr({ code: "EWHATEVER" }), "network"],
    ["no tags → network", new Error("bare"), "network"],
  ];

  for (const [label, err, expected] of cases) {
    test(label, () => {
      expect(classifyConnectionError(err)).toBe(expected);
    });
  }

  test("never returns unsupported_scheme (that is createDriver's verdict alone)", () => {
    expect(classifyConnectionError(fakeErr({ code: "file" }))).toBe("network");
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
