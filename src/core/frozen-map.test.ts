/**
 * Unit tests for the driver-rows → FrozenData mapping (Story 3.2). Covers the
 * cell-mapping matrix row: null / integer / float / boolean / Date / text / an
 * unknown value → tagged cells with the right per-column type, and the output
 * always satisfies the contract's well-formedness (round-trips through encode).
 */

import { describe, expect, test } from "bun:test";
import { encode, type FrozenData } from "../shared/contract.ts";
import { rowsToFrozenData } from "./frozen-map.ts";

describe("rowsToFrozenData — per-column type + cell tagging", () => {
  test("maps null/number/boolean/Date/string/unknown to the right cell kinds", () => {
    const cols = ["n_null", "n_int", "n_float", "b", "d", "t", "u"];
    const date = new Date("2026-07-09T12:34:56.000Z");
    const rows = [[null, 42, 3.5, true, date, "hello", { a: 1 }]];
    const fd = rowsToFrozenData(cols, rows);

    // A column whose only value is NULL defaults to `string` type.
    expect(fd.columns.map((c) => c.type)).toEqual([
      "string", // n_null (all-null → string default)
      "number", // n_int
      "number", // n_float
      "boolean", // b
      "date", // d
      "string", // t
      "string", // u (unknown object → string fallback)
    ]);

    const row = fd.rows[0]!;
    expect(row[0]).toEqual({ kind: "null" });
    expect(row[1]).toEqual({ kind: "number", value: 42 });
    expect(row[2]).toEqual({ kind: "number", value: 3.5 });
    expect(row[3]).toEqual({ kind: "boolean", value: true });
    expect(row[4]).toEqual({ kind: "date", iso: "2026-07-09T12:34:56.000Z" });
    expect(row[5]).toEqual({ kind: "string", value: "hello" });
    expect(row[6]).toEqual({ kind: "string", value: JSON.stringify({ a: 1 }) });
  });

  test("the result round-trips through encode (well-formed, ISO-UTC dates)", () => {
    const fd = rowsToFrozenData(
      ["id", "at"],
      [
        [1, new Date("2026-01-01T00:00:00.000Z")],
        [2, new Date("2026-02-02T02:02:02.000Z")],
      ],
    );
    expect(() => encode(fd)).not.toThrow();
  });

  test("a null inside an otherwise-typed column stays a null cell (type unaffected)", () => {
    const fd = rowsToFrozenData(["id"], [[1], [null], [3]]);
    expect(fd.columns[0]!.type).toBe("number");
    expect(fd.rows.map((r) => r[0])).toEqual([
      { kind: "number", value: 1 },
      { kind: "null" },
      { kind: "number", value: 3 },
    ]);
  });

  test("empty rows still yield the columns (headers present, 0 rows)", () => {
    const fd: FrozenData = rowsToFrozenData(["a", "b"], []);
    expect(fd.columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(fd.rows).toEqual([]);
  });

  test("bigint values fall back to string (precision-safe)", () => {
    const fd = rowsToFrozenData(["big"], [[9007199254740993n]]);
    expect(fd.columns[0]!.type).toBe("string");
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: "9007199254740993" });
  });

  test("a heterogeneous column falls back to string for every cell", () => {
    const fd = rowsToFrozenData(["mixed"], [[1], ["two"]]);
    expect(fd.columns[0]!.type).toBe("string");
    expect(fd.rows.map((r) => r[0])).toEqual([
      { kind: "string", value: "1" },
      { kind: "string", value: "two" },
    ]);
  });

  test("an Invalid Date maps to a string cell and never throws (P4)", () => {
    const invalid = new Date("0000-00-00"); // mysql2 zero-timestamp → Invalid Date
    expect(Number.isNaN(invalid.getTime())).toBe(true);
    let fd!: FrozenData;
    expect(() => {
      fd = rowsToFrozenData(["ts"], [[invalid]]);
    }).not.toThrow();
    expect(fd.columns[0]!.type).toBe("string");
    const cell = fd.rows[0]![0]!;
    expect(cell.kind).toBe("string");
    expect(() => encode(fd)).not.toThrow();
  });

  test("a mix of a valid and an invalid Date stays a total string column (P4)", () => {
    const valid = new Date("2026-07-09T12:00:00.000Z");
    const invalid = new Date("nonsense");
    let fd!: FrozenData;
    expect(() => {
      fd = rowsToFrozenData(["ts"], [[valid], [invalid]]);
    }).not.toThrow();
    expect(fd.columns[0]!.type).toBe("string");
    expect(fd.rows.every((r) => r[0]!.kind === "string")).toBe(true);
    expect(() => encode(fd)).not.toThrow();
  });

  test("a Uint8Array/Buffer maps to a byte-count placeholder, not a JSON array (P5)", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fd = rowsToFrozenData(["data"], [[bytes]]);
    expect(fd.columns[0]!.type).toBe("string");
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: "\\x…(4 bytes)" });
    expect(() => encode(fd)).not.toThrow();

    if (typeof Buffer !== "undefined") {
      const buf = Buffer.from([10, 20, 30]);
      const fb = rowsToFrozenData(["data"], [[buf]]);
      expect(fb.rows[0]![0]).toEqual({ kind: "string", value: "\\x…(3 bytes)" });
    }
  });
});
