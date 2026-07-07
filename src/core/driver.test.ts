/**
 * quick-studio Core — driver selection + error-classification tests.
 *
 * Pure unit tests: no live Postgres/MySQL. `createDriver` is exercised only for
 * its scheme allowlist (it does not connect at factory time), and
 * `classifyConnectionError` is fed synthetic error objects carrying the same
 * `code`/`errno` tags the real drivers surface.
 */

import { describe, expect, test } from "bun:test";
import type { ConnectionFailureKind } from "../shared/contract.ts";
import {
  DriverConnectionError,
  assembleSchema,
  classifyConnectionError,
  createDriver,
} from "./driver.ts";

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
});
