/**
 * Unit tests for the driver-rows → FrozenData mapping (Story 3.2). Covers the
 * cell-mapping matrix row: null / integer / float / boolean / Date / text / an
 * unknown value → tagged cells with the right per-column type, and the output
 * always satisfies the contract's well-formedness (round-trips through encode).
 *
 * The second half covers the SQL-`dataType` plumbing (DW-30/34/35/40): a carried
 * `dataType`, the exact-string preservation of wide integers, and the tz-INDEPENDENT
 * wall-clock representation of naive timestamps. The tz-independence assertions are
 * written so `TZ=Asia/Tokyo bun test src/core/frozen-map.test.ts` produces byte-identical
 * expectations to a UTC run — that is the whole point of the naive path.
 */

import { describe, expect, test } from "bun:test";
import { encode, type FrozenData } from "../shared/contract.ts";
import { rowsToFrozenData } from "./frozen-map.ts";

/** Ordered name-only column descriptors — the "no `dataType` at all" (legacy) shape. */
const named = (...names: ReadonlyArray<string>): ReadonlyArray<{ readonly name: string }> =>
  names.map((name) => ({ name }));

describe("rowsToFrozenData — per-column type + cell tagging", () => {
  test("maps null/number/boolean/Date/string/unknown to the right cell kinds", () => {
    const cols = ["n_null", "n_int", "n_float", "b", "d", "t", "u"];
    const date = new Date("2026-07-09T12:34:56.000Z");
    const rows = [[null, 42, 3.5, true, date, "hello", { a: 1 }]];
    const fd = rowsToFrozenData(named(...cols), rows);

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
      named("id", "at"),
      [
        [1, new Date("2026-01-01T00:00:00.000Z")],
        [2, new Date("2026-02-02T02:02:02.000Z")],
      ],
    );
    expect(() => encode(fd)).not.toThrow();
  });

  test("a null inside an otherwise-typed column stays a null cell (type unaffected)", () => {
    const fd = rowsToFrozenData(named("id"), [[1], [null], [3]]);
    expect(fd.columns[0]!.type).toBe("number");
    expect(fd.rows.map((r) => r[0])).toEqual([
      { kind: "number", value: 1 },
      { kind: "null" },
      { kind: "number", value: 3 },
    ]);
  });

  test("empty rows still yield the columns (headers present, 0 rows)", () => {
    const fd: FrozenData = rowsToFrozenData(named("a", "b"), []);
    expect(fd.columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(fd.rows).toEqual([]);
  });

  test("bigint values fall back to string (precision-safe)", () => {
    const fd = rowsToFrozenData(named("big"), [[9007199254740993n]]);
    expect(fd.columns[0]!.type).toBe("string");
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: "9007199254740993" });
  });

  test("a heterogeneous column falls back to string for every cell", () => {
    const fd = rowsToFrozenData(named("mixed"), [[1], ["two"]]);
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
      fd = rowsToFrozenData(named("ts"), [[invalid]]);
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
      fd = rowsToFrozenData(named("ts"), [[valid], [invalid]]);
    }).not.toThrow();
    expect(fd.columns[0]!.type).toBe("string");
    expect(fd.rows.every((r) => r[0]!.kind === "string")).toBe(true);
    expect(() => encode(fd)).not.toThrow();
  });

  test("a Uint8Array/Buffer maps to a byte-count placeholder, not a JSON array (P5)", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fd = rowsToFrozenData(named("data"), [[bytes]]);
    expect(fd.columns[0]!.type).toBe("string");
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: "\\x…(4 bytes)" });
    expect(() => encode(fd)).not.toThrow();

    if (typeof Buffer !== "undefined") {
      const buf = Buffer.from([10, 20, 30]);
      const fb = rowsToFrozenData(named("data"), [[buf]]);
      expect(fb.rows[0]![0]).toEqual({ kind: "string", value: "\\x…(3 bytes)" });
    }
  });
});

describe("rowsToFrozenData — SQL dataType carrying (DW-30/35)", () => {
  test("a postgres int8 value above 2^53 survives as the EXACT string, column typed bigint", () => {
    // postgres.js returns int8 as a string already; the mapper must not touch the digits.
    const fd = rowsToFrozenData(
      [{ name: "id", dataType: "bigint" }],
      [["9007199254740993"]],
    );
    expect(fd.columns[0]).toEqual({ name: "id", type: "string", dataType: "bigint" });
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: "9007199254740993" });
  });

  test("a mysql BIGINT arrives as the same exact string (bigNumberStrings, DW-35)", () => {
    const fd = rowsToFrozenData([{ name: "n", dataType: "bigint" }], [["9007199254740993"]]);
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: "9007199254740993" });
    // Round-tripping through Number() would land on …992 — pin that we did NOT.
    expect(String(Number("9007199254740993"))).toBe("9007199254740992");
  });

  test("a wide decimal keeps every digit (no float rounding)", () => {
    const wide = "12345678901234567890.123456789";
    const fd = rowsToFrozenData([{ name: "amount", dataType: "numeric" }], [[wide]]);
    expect(fd.columns[0]!.dataType).toBe("numeric");
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: wide });
  });

  test("a null-only bigint column is a string column of null cells, dataType still carried", () => {
    const fd = rowsToFrozenData([{ name: "id", dataType: "bigint" }], [[null], [null]]);
    expect(fd.columns[0]).toEqual({ name: "id", type: "string", dataType: "bigint" });
    expect(fd.rows.map((r) => r[0])).toEqual([{ kind: "null" }, { kind: "null" }]);
    expect(() => encode(fd)).not.toThrow();
  });

  test("an UNKNOWN engine type is carried verbatim; the kind still comes from the value", () => {
    const fd = rowsToFrozenData(
      [
        { name: "addr", dataType: "inet" },
        { name: "shape", dataType: "geometry" },
      ],
      [["10.0.0.1", "POINT(1 2)"]],
    );
    expect(fd.columns.map((c) => c.dataType)).toEqual(["inet", "geometry"]);
    expect(fd.columns.map((c) => c.type)).toEqual(["string", "string"]);
  });

  test("absent dataType reproduces the pre-change output EXACTLY (columns, kinds, cells)", () => {
    const rows = [[1, "a", true, new Date("2026-03-04T05:06:07.000Z")], [null, null, null, null]];
    const withNone = rowsToFrozenData(named("id", "s", "b", "at"), rows);
    // No `dataType` key is materialized at all — a legacy consumer sees the old shape.
    expect(withNone.columns).toEqual([
      { name: "id", type: "number" },
      { name: "s", type: "string" },
      { name: "b", type: "boolean" },
      { name: "at", type: "date" },
    ]);
    expect(withNone.columns.every((c) => !("dataType" in c))).toBe(true);
    expect(withNone.rows[0]).toEqual([
      { kind: "number", value: 1 },
      { kind: "string", value: "a" },
      { kind: "boolean", value: true },
      { kind: "date", iso: "2026-03-04T05:06:07.000Z" },
    ]);
  });
});

describe("rowsToFrozenData — naive vs aware temporals (DW-34)", () => {
  // Both drivers parse a tz-less `timestamp`/`DATETIME` into a LOCAL-time Date, so the
  // fixture is built with the local-field constructor — exactly what the driver hands over.
  const naiveDate = new Date(2026, 6, 22, 18, 14, 13); // 2026-07-22 18:14:13, local fields

  test("a naive timestamp becomes a literal wall-clock STRING — no Z, no offset shift", () => {
    const fd = rowsToFrozenData(
      [{ name: "at", dataType: "timestamp without time zone" }],
      [[naiveDate]],
    );
    expect(fd.columns[0]).toEqual({
      name: "at",
      type: "string",
      dataType: "timestamp without time zone",
    });
    // Byte-identical under TZ=UTC and TZ=Asia/Tokyo — the whole point of the local getters.
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: "2026-07-22T18:14:13" });
  });

  test("MySQL DATETIME takes the same naive path", () => {
    const fd = rowsToFrozenData([{ name: "at", dataType: "datetime" }], [[naiveDate]]);
    expect(fd.columns[0]!.type).toBe("string");
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: "2026-07-22T18:14:13" });
  });

  test("a sub-1000 year is ZERO-PADDED to four digits", () => {
    // A raw `getFullYear()` renders a Postgres `timestamp` of `0500-01-01 00:00:00` as
    // the malformed `500-01-01T00:00:00` — which is exactly the string the inline editor
    // then seeds and would commit straight back into the row.
    const old = new Date(1970, 0, 1);
    old.setFullYear(500); // the Date constructor maps 0..99 to 1900+n; this does not.
    const fd = rowsToFrozenData([{ name: "at", dataType: "datetime" }], [[old]]);
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: "0500-01-01T00:00:00" });

    const year7 = new Date(1970, 2, 4, 5, 6, 7);
    year7.setFullYear(7);
    const fd7 = rowsToFrozenData([{ name: "at", dataType: "datetime" }], [[year7]]);
    expect((fd7.rows[0]![0] as { value: string }).value.startsWith("0007-")).toBe(true);
  });

  test("milliseconds are appended only when non-zero", () => {
    const withMs = new Date(2026, 0, 2, 3, 4, 5, 60);
    const fd = rowsToFrozenData([{ name: "at", dataType: "datetime" }], [[withMs]]);
    expect(fd.rows[0]![0]).toEqual({ kind: "string", value: "2026-01-02T03:04:05.060" });
  });

  test("an aware timestamp is UNCHANGED — still a date column with a Z-suffixed cell", () => {
    const aware = new Date("2026-07-22T18:14:13.000Z");
    for (const dataType of ["timestamp with time zone", "timestamptz", "timestamp"]) {
      const fd = rowsToFrozenData([{ name: "at", dataType }], [[aware]]);
      expect(fd.columns[0]).toEqual({ name: "at", type: "date", dataType });
      expect(fd.rows[0]![0]).toEqual({ kind: "date", iso: "2026-07-22T18:14:13.000Z" });
      expect(() => encode(fd)).not.toThrow();
    }
  });

  test("a naive column with a NULL and a non-Date value stays a total string column", () => {
    const fd = rowsToFrozenData(
      [{ name: "at", dataType: "datetime" }],
      // A `dateStrings=true` connection yields strings, and mysql2's zero-date is Invalid.
      [[naiveDate], [null], ["2026-07-22 18:14:13"], [new Date("0000-00-00")]],
    );
    expect(fd.columns[0]!.type).toBe("string");
    expect(fd.rows.map((r) => r[0]!.kind)).toEqual(["string", "null", "string", "string"]);
    expect(fd.rows[2]![0]).toEqual({ kind: "string", value: "2026-07-22 18:14:13" });
    expect(() => encode(fd)).not.toThrow();
  });

  test("the naive wall clock is derived from the LOCAL fields, whatever TZ the host runs in", () => {
    // A tautology-free tz-independence proof: whatever the ambient TZ, the emitted string
    // must equal the Date's own local field values — never its UTC ones. Under
    // TZ=Asia/Tokyo the two differ by 9h, so a UTC-based impl fails this outright.
    const fd = rowsToFrozenData([{ name: "at", dataType: "datetime" }], [[naiveDate]]);
    const cell = fd.rows[0]![0] as { kind: "string"; value: string };
    expect(cell.value.startsWith(`${naiveDate.getFullYear()}-`)).toBe(true);
    expect(cell.value).toContain(`T${String(naiveDate.getHours()).padStart(2, "0")}:`);
    expect(cell.value.endsWith("Z")).toBe(false);
  });
});
