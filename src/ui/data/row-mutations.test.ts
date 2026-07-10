/**
 * Unit tests for the pure structured row-mutation builders (Story 3.3). No DOM /
 * React harness — coercion by kind, the single-PK guard, PK-value extraction by
 * column index, and omit-empty insert are all pure functions. Covers the spec's
 * I/O & Edge-Case Matrix rows that are decidable without a live DB.
 */

import { describe, expect, test } from "bun:test";
import type { FrozenColumn, FrozenRow } from "../../shared/contract.ts";
import {
  buildDeleteOp,
  buildInsertOp,
  buildUpdateOp,
  coerceValue,
  isMutationError,
  pkForRow,
} from "./row-mutations.ts";

const columns: ReadonlyArray<FrozenColumn> = [
  { name: "id", type: "number" },
  { name: "name", type: "string" },
  { name: "active", type: "boolean" },
  { name: "created", type: "date" },
];

const row: FrozenRow = [
  { kind: "number", value: 7 },
  { kind: "string", value: "alice" },
  { kind: "boolean", value: true },
  { kind: "date", iso: "2026-01-02T03:04:05.000Z" },
];

const target = { schema: "public", table: "users" };

describe("coerceValue", () => {
  test("number: parses numeric text, rejects non-numeric and empty", () => {
    expect(coerceValue("number", "42")).toEqual({ value: 42 });
    expect(isMutationError(coerceValue("number", "abc"))).toBe(true);
    expect(isMutationError(coerceValue("number", ""))).toBe(true);
  });

  test("number: rejects non-finite (Infinity / 1e400)", () => {
    expect(isMutationError(coerceValue("number", "1e400"))).toBe(true);
    expect(isMutationError(coerceValue("number", "Infinity"))).toBe(true);
    expect(isMutationError(coerceValue("number", "-Infinity"))).toBe(true);
  });

  test("boolean: parses true/false spellings, rejects garbage", () => {
    expect(coerceValue("boolean", "true")).toEqual({ value: true });
    expect(coerceValue("boolean", "FALSE")).toEqual({ value: false });
    expect(coerceValue("boolean", "1")).toEqual({ value: true });
    expect(isMutationError(coerceValue("boolean", "yes"))).toBe(true);
  });

  test("date: forwards the RAW literal string (not a Date), rejects invalid", () => {
    // The literal must cross the wire verbatim — no round-trip through `new Date()`
    // (which would serialize to UTC ISO and shift a tz-less input).
    expect(coerceValue("date", "2026-07-10T12:00")).toEqual({ value: "2026-07-10T12:00" });
    expect(coerceValue("date", "2026-07-10T00:00:00.000Z")).toEqual({ value: "2026-07-10T00:00:00.000Z" });
    expect(isMutationError(coerceValue("date", "not-a-date"))).toBe(true);
  });

  test("string and un-inferable null-kind column bind the raw string", () => {
    expect(coerceValue("string", "hello")).toEqual({ value: "hello" });
    expect(coerceValue("null", "0007")).toEqual({ value: "0007" });
  });
});

describe("pkForRow — single-PK guard + value by column index", () => {
  test("single PK: reads the value from the row's cell at the PK column index", () => {
    expect(pkForRow(columns, ["id"], row)).toEqual({ column: "id", value: 7 });
  });

  test("PK value comes from the column INDEX, not position 0", () => {
    expect(pkForRow(columns, ["name"], row)).toEqual({ column: "name", value: "alice" });
  });

  test("date PK is extracted as the raw ISO string literal (not a Date)", () => {
    const pk = pkForRow(columns, ["created"], row);
    expect(pk).toEqual({ column: "created", value: "2026-01-02T03:04:05.000Z" });
  });

  test("a NULL primary-key cell is rejected — the row cannot be addressed", () => {
    const nullPkRow: FrozenRow = [
      { kind: "null" },
      { kind: "string", value: "alice" },
      { kind: "boolean", value: true },
      { kind: "date", iso: "2026-01-02T03:04:05.000Z" },
    ];
    expect(isMutationError(pkForRow(columns, ["id"], nullPkRow))).toBe(true);
  });

  test("composite PK rejected", () => {
    expect(isMutationError(pkForRow(columns, ["id", "name"], row))).toBe(true);
  });

  test("no PK rejected", () => {
    expect(isMutationError(pkForRow(columns, [], row))).toBe(true);
  });
});

describe("buildUpdateOp", () => {
  test("valid update: PK + one coerced set, value typed by kind", () => {
    const op = buildUpdateOp({ target, columns, primaryKeys: ["id"], row, column: "name", edit: { raw: "bob" } });
    expect(op).toEqual({
      kind: "update",
      schema: "public",
      table: "users",
      pk: { column: "id", value: 7 },
      set: [{ column: "name", value: "bob" }],
    });
  });

  test("number column coerces to a native number, not a string", () => {
    const op = buildUpdateOp({ target, columns, primaryKeys: ["id"], row, column: "id", edit: { raw: "99" } });
    expect(isMutationError(op)).toBe(false);
    expect((op as unknown as { set: { value: unknown }[] }).set[0]!.value).toBe(99);
  });

  test("non-numeric text into a number cell is rejected — no op built", () => {
    const op = buildUpdateOp({ target, columns, primaryKeys: ["id"], row, column: "id", edit: { raw: "abc" } });
    expect(isMutationError(op)).toBe(true);
  });

  test("explicit NULL sets value:null (a real NULL, key present)", () => {
    const op = buildUpdateOp({ target, columns, primaryKeys: ["id"], row, column: "name", edit: { setNull: true } });
    expect(op).toEqual({
      kind: "update",
      schema: "public",
      table: "users",
      pk: { column: "id", value: 7 },
      set: [{ column: "name", value: null }],
    });
  });

  test("composite-PK table cannot build an update", () => {
    const op = buildUpdateOp({ target, columns, primaryKeys: ["id", "name"], row, column: "name", edit: { raw: "x" } });
    expect(isMutationError(op)).toBe(true);
  });
});

describe("buildDeleteOp", () => {
  test("single PK: builds a delete addressed by the row PK", () => {
    expect(buildDeleteOp({ target, columns, primaryKeys: ["id"], row })).toEqual({
      kind: "delete",
      schema: "public",
      table: "users",
      pk: { column: "id", value: 7 },
    });
  });

  test("no-PK table cannot build a delete", () => {
    expect(isMutationError(buildDeleteOp({ target, columns, primaryKeys: [], row }))).toBe(true);
  });
});

describe("buildInsertOp — omit empties, keep explicit NULL, coerce by kind", () => {
  test("only filled columns are sent; empty text inputs are omitted", () => {
    const op = buildInsertOp({
      target,
      columns,
      draft: [
        { column: "id", edit: { raw: "" } }, // serial PK left blank → omitted
        { column: "name", edit: { raw: "carol" } },
        { column: "active", edit: { raw: "true" } },
        { column: "created", edit: { raw: "" } }, // defaulted → omitted
      ],
    });
    expect(op).toEqual({
      kind: "insert",
      schema: "public",
      table: "users",
      columns: [
        { column: "name", value: "carol" },
        { column: "active", value: true },
      ],
    });
  });

  test("explicit NULL is kept (forces NULL over a default)", () => {
    const op = buildInsertOp({
      target,
      columns,
      draft: [{ column: "name", edit: { setNull: true } }],
    });
    expect(op).toEqual({
      kind: "insert",
      schema: "public",
      table: "users",
      columns: [{ column: "name", value: null }],
    });
  });

  test("a coercion failure aborts the whole insert", () => {
    const op = buildInsertOp({
      target,
      columns,
      draft: [{ column: "id", edit: { raw: "abc" } }],
    });
    expect(isMutationError(op)).toBe(true);
  });

  test("all-empty draft is an error (nothing to insert)", () => {
    const op = buildInsertOp({ target, columns, draft: [{ column: "name", edit: { raw: "" } }] });
    expect(isMutationError(op)).toBe(true);
  });

  test("schema omitted when target has none", () => {
    const op = buildInsertOp({
      target: { table: "users" },
      columns,
      draft: [{ column: "name", edit: { raw: "dave" } }],
    });
    expect(op).toEqual({ kind: "insert", table: "users", columns: [{ column: "name", value: "dave" }] });
  });
});
