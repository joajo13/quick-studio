/**
 * Unit tests for the pure result-grid presentation helpers (Story 7.2). No DOM /
 * React harness — the client-side row filter and the CSV serializer are pure
 * functions over already-loaded `FrozenData` rows.
 */

import { describe, expect, test } from "bun:test";
import type { FrozenColumn, FrozenRow } from "../../shared/contract.ts";
import { filterRows, rowsToCsv } from "./grid-view.ts";

const columns: ReadonlyArray<FrozenColumn> = [
  { name: "id", type: "number" },
  { name: "name", type: "string" },
  { name: "note", type: "string" },
];

const rows: ReadonlyArray<FrozenRow> = [
  [
    { kind: "number", value: 1 },
    { kind: "string", value: "Alice" },
    { kind: "null" },
  ],
  [
    { kind: "number", value: 2 },
    { kind: "string", value: "Bob" },
    { kind: "string", value: "hello, world" },
  ],
];

describe("filterRows", () => {
  test("keeps rows whose any cell contains the query (case-insensitive)", () => {
    const out = filterRows(rows, "ALI");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(rows[0]);
  });

  test("matches on non-string cells' display text (e.g. a numeric id)", () => {
    const out = filterRows(rows, "2");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(rows[1]);
  });

  test("no match returns an empty array", () => {
    expect(filterRows(rows, "zzz")).toHaveLength(0);
  });

  test("an empty query returns all rows (same reference)", () => {
    expect(filterRows(rows, "")).toBe(rows);
  });

  test("a whitespace-only query returns all rows (same reference)", () => {
    expect(filterRows(rows, "   ")).toBe(rows);
  });

  test("a null cell is never matched (empty display text)", () => {
    // "null" as a needle must not select the row whose note cell is SQL NULL.
    expect(filterRows(rows, "null")).toHaveLength(0);
  });
});

describe("rowsToCsv", () => {
  test("emits a header row then one line per row", () => {
    const csv = rowsToCsv(columns, [rows[0]!]);
    expect(csv).toBe("id,name,note\n1,Alice,");
  });

  test("null cells serialize as an empty field", () => {
    const csv = rowsToCsv(columns, [rows[0]!]);
    expect(csv.split("\n")[1]).toBe("1,Alice,");
  });

  test("quotes fields containing a comma", () => {
    const csv = rowsToCsv(columns, [rows[1]!]);
    expect(csv).toBe('id,name,note\n2,Bob,"hello, world"');
  });

  test("quotes and doubles interior quotes", () => {
    const csv = rowsToCsv(columns, [[{ kind: "string", value: 'a "quoted" b' }]]);
    expect(csv.split("\n")[1]).toBe('"a ""quoted"" b"');
  });

  test("quotes fields containing a newline", () => {
    const csv = rowsToCsv(columns, [[{ kind: "string", value: "line1\nline2" }]]);
    expect(csv.split("\n").slice(1).join("\n")).toBe('"line1\nline2"');
  });

  test("header-only output when there are no rows", () => {
    expect(rowsToCsv(columns, [])).toBe("id,name,note");
  });

  test("prefixes a string cell that starts with a formula sigil", () => {
    const csv = rowsToCsv(columns, [[{ kind: "string", value: "=SUM(A1)" }]]);
    expect(csv.split("\n")[1]).toBe("'=SUM(A1)");
  });

  // One case per sigil so a regression names the sigil that broke instead of aborting the
  // rest. The CR case is additionally quoted by `csvField` (CR is structural); the tab is
  // not, since a tab is not an RFC-4180 special character.
  test.each([
    ["+cmd", "'+cmd"],
    ["-2+3", "'-2+3"],
    ["@foo", "'@foo"],
    ["\tx", "'\tx"],
    ["\rx", "\"'\rx\""],
  ])("guards the sigil in %j", (value, expected) => {
    const csv = rowsToCsv(columns, [[{ kind: "string", value }]]);
    expect(csv.split("\n")[1]).toBe(expected);
  });

  test("the guard lands inside the RFC-4180 quoting, not outside it", () => {
    const csv = rowsToCsv(columns, [[{ kind: "string", value: "=a,b" }]]);
    expect(csv.split("\n")[1]).toBe("\"'=a,b\"");
  });

  test("guards a column name that starts with a formula sigil", () => {
    const hostile: ReadonlyArray<FrozenColumn> = [{ name: "=1+1", type: "string" }];
    expect(rowsToCsv(hostile, [])).toBe("'=1+1");
  });

  test("a guarded column name is quoted the same way a guarded cell is", () => {
    const hostile: ReadonlyArray<FrozenColumn> = [{ name: "=a,b", type: "string" }];
    expect(rowsToCsv(hostile, [])).toBe("\"'=a,b\"");
  });

  test("a value that already starts with the guard character is left alone", () => {
    const csv = rowsToCsv(columns, [[{ kind: "string", value: "'=x" }]]);
    expect(csv.split("\n")[1]).toBe("'=x");
  });

  test("leaves a negative number cell unguarded (a real minus sign)", () => {
    const csv = rowsToCsv(columns, [[{ kind: "number", value: -5 }]]);
    expect(csv.split("\n")[1]).toBe("-5");
  });

  test("leaves a sigil that is not the first character alone", () => {
    const csv = rowsToCsv(columns, [[{ kind: "string", value: "a=b" }]]);
    expect(csv.split("\n")[1]).toBe("a=b");
  });

  test("empty and null cells stay empty fields", () => {
    const csv = rowsToCsv(columns, [[{ kind: "string", value: "" }, { kind: "null" }]]);
    expect(csv.split("\n")[1]).toBe(",");
  });
});
