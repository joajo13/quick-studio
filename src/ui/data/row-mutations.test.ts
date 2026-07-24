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
  coerceValueForColumn,
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

// DW-40 — a `bigint`/`numeric` value cannot survive a JS `number`. These columns carry
// their SQL `dataType`, so both the SET value and the PK ADDRESS bind exact strings and
// no `Number()` ever touches them. `9007199254740993` is the canonical witness: it is
// 2^53+1, so `Number()` silently lands on …992 — a different row.
const WIDE = "9007199254740993";

const exactColumns: ReadonlyArray<FrozenColumn> = [
  { name: "id", type: "string", dataType: "bigint" },
  { name: "amount", type: "string", dataType: "numeric" },
  { name: "label", type: "string" },
];

const exactRow: FrozenRow = [
  { kind: "string", value: WIDE },
  { kind: "string", value: "1.25" },
  { kind: "string", value: "alice" },
];

describe("coerceValueForColumn — exact-numeric columns bind validated strings (DW-40)", () => {
  test("a wide integer is bound as the EXACT string, never through Number()", () => {
    const coerced = coerceValueForColumn(exactColumns[0]!, WIDE);
    expect(coerced).toEqual({ value: WIDE });
    // Pin the trap this guards against: the numeric route would lose the last digit.
    expect(String(Number(WIDE))).toBe("9007199254740992");
  });

  test("decimals, signs and surrounding whitespace are accepted (and trimmed)", () => {
    expect(coerceValueForColumn(exactColumns[1]!, "  -12345678901234567890.0987  ")).toEqual({
      value: "-12345678901234567890.0987",
    });
    expect(coerceValueForColumn(exactColumns[1]!, "+7")).toEqual({ value: "+7" });
    expect(coerceValueForColumn(exactColumns[1]!, ".5")).toEqual({ value: ".5" });
  });

  test("a malformed exact-numeric edit is rejected BEFORE an op is built", () => {
    expect(coerceValueForColumn(exactColumns[1]!, "12ab")).toEqual({ error: "not a number: 12ab" });
    for (const bad of ["", "  ", "1e5", "Infinity", "NaN", "1,000", "0x10", "--1"]) {
      expect(isMutationError(coerceValueForColumn(exactColumns[1]!, bad))).toBe(true);
    }
  });

  test("a FRACTIONAL literal is rejected for bigint but accepted for numeric", () => {
    // A `bigint` has no fractional part: shipping `12.5` would be rounded away by
    // Postgres or hard-error under MySQL strict mode — either way not what was typed.
    for (const frac of ["12.5", ".5", "-0.1"]) {
      expect(isMutationError(coerceValueForColumn(exactColumns[0]!, frac))).toBe(true);
      expect(coerceValueForColumn(exactColumns[1]!, frac)).toEqual({ value: frac });
    }
    expect(coerceValueForColumn(exactColumns[0]!, "12.5")).toEqual({ error: "not an integer: 12.5" });
    // The integer gate still accepts signs and whitespace around a whole number.
    expect(coerceValueForColumn(exactColumns[0]!, "  -42 ")).toEqual({ value: "-42" });
    expect(coerceValueForColumn(exactColumns[0]!, "+7")).toEqual({ value: "+7" });
  });

  test("a TRAILING-DOT literal (`12.`) is rejected by BOTH exact gates", () => {
    // This branch forwards the user's characters verbatim as a bound parameter — it never
    // goes through `Number()` — and `12.` is not a literal every engine parses (Postgres
    // rejects it as `numeric` input). Admitting it would trade the clean client-side
    // message for a raw driver error at the server. `.5` and `+7` stay accepted.
    expect(coerceValueForColumn(exactColumns[0]!, "12.")).toEqual({ error: "not an integer: 12." });
    expect(coerceValueForColumn(exactColumns[1]!, "12.")).toEqual({ error: "not a number: 12." });
    expect(coerceValueForColumn(exactColumns[1]!, "-0.")).toEqual({ error: "not a number: -0." });
    expect(coerceValueForColumn(exactColumns[1]!, ".5")).toEqual({ value: ".5" });
    expect(coerceValueForColumn(exactColumns[1]!, "+7")).toEqual({ value: "+7" });
  });

  test("`int8` is treated exactly like `bigint` (the pg internal spelling)", () => {
    const int8: FrozenColumn = { name: "id", type: "string", dataType: "int8" };
    expect(coerceValueForColumn(int8, WIDE)).toEqual({ value: WIDE });
    expect(isMutationError(coerceValueForColumn(int8, "1.5"))).toBe(true);
  });

  test("a TEMPORAL column still validates as a date even though its type is string", () => {
    // Forcing a naive column to `type: "string"` (so a wall clock never becomes a false-Z
    // date cell) would otherwise silently drop the editor's date validation while the
    // grid header still reads "time".
    const naive: FrozenColumn = {
      name: "at",
      type: "string",
      dataType: "timestamp without time zone",
    };
    expect(isMutationError(coerceValueForColumn(naive, "not a date"))).toBe(true);
    expect(coerceValueForColumn(naive, "2026-07-22T18:14:13")).toEqual({
      value: "2026-07-22T18:14:13",
    });
    // An AWARE temporal column takes the same branch (its runtime type is `date`).
    const aware: FrozenColumn = { name: "at", type: "date", dataType: "timestamptz" };
    expect(isMutationError(coerceValueForColumn(aware, "not a date"))).toBe(true);
    // And MySQL's naive `datetime`.
    const dt: FrozenColumn = { name: "at", type: "string", dataType: "datetime" };
    expect(isMutationError(coerceValueForColumn(dt, "nonsense"))).toBe(true);
    // The raw literal is sent, never a JS Date — same rule `coerceValue("date")` holds.
    expect(coerceValueForColumn(dt, "2026-07-22 18:14:13")).toEqual({
      value: "2026-07-22 18:14:13",
    });
  });

  test("a column with NO dataType delegates to coerceValue unchanged (legacy parity)", () => {
    for (const col of columns) {
      for (const raw of ["42", "abc", "true", "2026-07-10T12:00", ""]) {
        expect(coerceValueForColumn(col, raw)).toEqual(coerceValue(col.type, raw));
      }
    }
  });

  test("a non-exact dataType (int4, text) also delegates to the kind-based path", () => {
    const int4: FrozenColumn = { name: "n", type: "number", dataType: "int4" };
    expect(coerceValueForColumn(int4, "42")).toEqual({ value: 42 });
    const text: FrozenColumn = { name: "s", type: "string", dataType: "text" };
    expect(coerceValueForColumn(text, " keep me ")).toEqual({ value: " keep me " });
  });
});

describe("wide-integer op building + PK addressing (DW-40)", () => {
  test("an update on a bigint column sets the exact string", () => {
    const op = buildUpdateOp({
      target,
      columns: exactColumns,
      primaryKeys: ["id"],
      row: exactRow,
      column: "id",
      edit: { raw: WIDE },
    });
    expect(op).toEqual({
      kind: "update",
      schema: "public",
      table: "users",
      pk: { column: "id", value: WIDE, exactNumeric: true },
      set: [{ column: "id", value: WIDE }],
    });
  });

  test("a bigint PK addresses the row with the exact string from its cell", () => {
    expect(pkForRow(exactColumns, ["id"], exactRow)).toEqual({
      column: "id",
      value: WIDE,
      exactNumeric: true,
    });
    expect(buildDeleteOp({ target, columns: exactColumns, primaryKeys: ["id"], row: exactRow })).toEqual({
      kind: "delete",
      schema: "public",
      table: "users",
      pk: { column: "id", value: WIDE, exactNumeric: true },
    });
  });

  test("the exactNumeric flag is set ONLY for an exact-numeric PK column", () => {
    // It is what makes the executor compose MySQL's `CAST(? AS DECIMAL(65,30))`; binding
    // the exact digits as a string is not enough there, because MySQL compares an integer
    // column against a string operand as a FLOAT.
    const numericPk = pkForRow(
      [{ name: "amount", type: "string", dataType: "numeric" }],
      ["amount"],
      [{ kind: "string", value: "1.25" }],
    );
    expect(numericPk).toEqual({ column: "amount", value: "1.25", exactNumeric: true });
    // A plain int4 / a column with no dataType keeps the byte-identical legacy pk shape.
    const int4Pk = pkForRow(
      [{ name: "id", type: "number", dataType: "int4" }],
      ["id"],
      [{ kind: "number", value: 7 }],
    );
    expect(int4Pk).toEqual({ column: "id", value: 7 });
    expect("exactNumeric" in (int4Pk as object)).toBe(false);
    expect("exactNumeric" in (pkForRow(columns, ["id"], row) as object)).toBe(false);
  });

  test("a malformed decimal aborts the update — no op reaches the executor", () => {
    const op = buildUpdateOp({
      target,
      columns: exactColumns,
      primaryKeys: ["id"],
      row: exactRow,
      column: "amount",
      edit: { raw: "12ab" },
    });
    expect(isMutationError(op)).toBe(true);
  });

  test("an exact-numeric insert binds the string; an explicit NULL still wins", () => {
    expect(
      buildInsertOp({
        target,
        columns: exactColumns,
        draft: [
          { column: "id", edit: { raw: WIDE } },
          { column: "amount", edit: { setNull: true } },
        ],
      }),
    ).toEqual({
      kind: "insert",
      schema: "public",
      table: "users",
      columns: [
        { column: "id", value: WIDE },
        { column: "amount", value: null },
      ],
    });
  });

  test("an exact-numeric PK that arrived as a JS NUMBER cell is refused, not repaired", () => {
    // Unreachable through either driver after this change (both stringify these columns),
    // so this is the belt-and-braces invariant: a lossy address would hit the WRONG row.
    const lossyRow: FrozenRow = [
      { kind: "number", value: 9007199254740992 },
      { kind: "string", value: "1.25" },
      { kind: "string", value: "alice" },
    ];
    const pk = pkForRow(exactColumns, ["id"], lossyRow);
    expect(isMutationError(pk)).toBe(true);
    expect((pk as { error: string }).error).toContain("precision");
    // The same number cell in a column with NO dataType is untouched (legacy parity).
    expect(pkForRow(columns, ["id"], row)).toEqual({ column: "id", value: 7 });
  });
});
