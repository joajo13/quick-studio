/**
 * Unit tests for the pure create-table builder (Story 3.4). No DOM / React harness —
 * validation, op build (per-column PK folding, allowlist token pass-through), and the
 * synthesized `SchemaTableInfo` are all pure. Covers the spec's I/O & Edge-Case Matrix
 * rows decidable without a live DB.
 */

import { describe, expect, test } from "bun:test";
import {
  buildCreateTableOp,
  CREATE_TABLE_TYPES,
  isCreateTableError,
  synthesizeSchemaTable,
  validateCreateTableDraft,
  type CreateTableDraft,
} from "./create-table.ts";

const validDraft: CreateTableDraft = {
  schema: "public",
  table: "widgets",
  columns: [
    { name: "id", type: "INTEGER", notNull: true, primaryKey: true },
    { name: "label", type: "TEXT", notNull: false, primaryKey: false },
  ],
};

describe("validateCreateTableDraft", () => {
  test("a well-formed draft validates", () => {
    expect(validateCreateTableDraft(validDraft)).toEqual({ ok: true });
  });

  test("a PK-less table is allowed (primary key is optional)", () => {
    const draft: CreateTableDraft = {
      table: "notes",
      columns: [{ name: "body", type: "TEXT", notNull: false, primaryKey: false }],
    };
    expect(validateCreateTableDraft(draft)).toEqual({ ok: true });
  });

  test("missing table name is rejected", () => {
    expect(validateCreateTableDraft({ ...validDraft, table: "   " }).ok).toBe(false);
  });

  test("zero columns is rejected", () => {
    expect(validateCreateTableDraft({ ...validDraft, columns: [] }).ok).toBe(false);
  });

  test("an empty column name is rejected", () => {
    const draft: CreateTableDraft = { table: "t", columns: [{ name: "  ", type: "TEXT", notNull: false, primaryKey: false }] };
    expect(validateCreateTableDraft(draft).ok).toBe(false);
  });

  test("duplicate column names are rejected", () => {
    const draft: CreateTableDraft = {
      table: "t",
      columns: [
        { name: "id", type: "INTEGER", notNull: false, primaryKey: false },
        { name: "id", type: "TEXT", notNull: false, primaryKey: false },
      ],
    };
    expect(validateCreateTableDraft(draft).ok).toBe(false);
  });

  test("a non-allowlisted type is rejected (drift fails closed)", () => {
    const draft: CreateTableDraft = { table: "t", columns: [{ name: "c", type: "SERIAL", notNull: false, primaryKey: false }] };
    expect(validateCreateTableDraft(draft).ok).toBe(false);
  });

  test("an unselected (empty) type is rejected", () => {
    const draft: CreateTableDraft = { table: "t", columns: [{ name: "c", type: "", notNull: false, primaryKey: false }] };
    expect(validateCreateTableDraft(draft).ok).toBe(false);
  });
});

describe("buildCreateTableOp", () => {
  test("builds a createTable op; PK/notNull flags fold in per-column, false flags omitted", () => {
    expect(buildCreateTableOp(validDraft)).toEqual({
      kind: "createTable",
      schema: "public",
      table: "widgets",
      columns: [
        { name: "id", type: "INTEGER", notNull: true, primaryKey: true },
        { name: "label", type: "TEXT" },
      ],
    });
  });

  test("multiple PK flags all fold into per-column primaryKey:true (composite PK)", () => {
    const op = buildCreateTableOp({
      table: "membership",
      columns: [
        { name: "user_id", type: "INTEGER", notNull: true, primaryKey: true },
        { name: "group_id", type: "INTEGER", notNull: true, primaryKey: true },
      ],
    });
    expect(isCreateTableError(op)).toBe(false);
    const cols = (op as { columns: ReadonlyArray<{ primaryKey?: boolean }> }).columns;
    expect(cols.every((c) => c.primaryKey === true)).toBe(true);
  });

  test("allowlist tokens pass through verbatim (incl. the multi-word DOUBLE PRECISION)", () => {
    const op = buildCreateTableOp({
      table: "measures",
      columns: CREATE_TABLE_TYPES.map((type, i) => ({ name: `c${i}`, type, notNull: false, primaryKey: false })),
    });
    expect(isCreateTableError(op)).toBe(false);
    const cols = (op as { columns: ReadonlyArray<{ type: string }> }).columns;
    expect(cols.map((c) => c.type)).toEqual([...CREATE_TABLE_TYPES]);
  });

  test("schema is omitted when absent/blank so the Core default applies", () => {
    const op = buildCreateTableOp({ table: "t", columns: [{ name: "c", type: "TEXT", notNull: false, primaryKey: false }] });
    expect(op).toEqual({ kind: "createTable", table: "t", columns: [{ name: "c", type: "TEXT" }] });
    expect("schema" in (op as object)).toBe(false);
  });

  test("an invalid draft returns an error, not an op", () => {
    expect(isCreateTableError(buildCreateTableOp({ table: "", columns: [] }))).toBe(true);
  });

  test("column names are trimmed into the op", () => {
    const op = buildCreateTableOp({ table: "  t  ", columns: [{ name: "  c  ", type: "TEXT", notNull: false, primaryKey: false }] });
    expect(op).toEqual({ kind: "createTable", table: "t", columns: [{ name: "c", type: "TEXT" }] });
  });
});

describe("synthesizeSchemaTable", () => {
  test("derives columns (dataType/nullable) and PK names from the draft", () => {
    expect(synthesizeSchemaTable(validDraft)).toEqual({
      schema: "public",
      name: "widgets",
      columns: [
        { name: "id", dataType: "INTEGER", nullable: false },
        { name: "label", dataType: "TEXT", nullable: true },
      ],
      primaryKey: ["id"],
    });
  });

  test("nullable is the inverse of notNull; a PK-less table yields an empty primaryKey", () => {
    const table = synthesizeSchemaTable({
      schema: "app",
      table: "logs",
      columns: [{ name: "msg", type: "TEXT", notNull: false, primaryKey: false }],
    });
    expect(table.columns[0]).toEqual({ name: "msg", dataType: "TEXT", nullable: true });
    expect(table.primaryKey).toEqual([]);
  });

  test("schema is exactly the submitted schema (empty string when absent)", () => {
    const table = synthesizeSchemaTable({ table: "t", columns: [{ name: "c", type: "TEXT", notNull: false, primaryKey: false }] });
    expect(table.schema).toBe("");
  });

  test("a primary-key column is NOT NULL even when notNull was left unchecked", () => {
    const table = synthesizeSchemaTable({
      table: "t",
      columns: [{ name: "id", type: "UUID", notNull: false, primaryKey: true }],
    });
    expect(table.columns[0]).toEqual({ name: "id", dataType: "UUID", nullable: false });
    expect(table.primaryKey).toEqual(["id"]);
  });

  test("schema is trimmed to match the op's effective target", () => {
    const table = synthesizeSchemaTable({
      schema: "  public  ",
      table: "t",
      columns: [{ name: "c", type: "TEXT", notNull: false, primaryKey: false }],
    });
    expect(table.schema).toBe("public");
  });

  test("a composite PK lists every flagged column in order", () => {
    const table = synthesizeSchemaTable({
      table: "membership",
      columns: [
        { name: "user_id", type: "INTEGER", notNull: true, primaryKey: true },
        { name: "group_id", type: "INTEGER", notNull: true, primaryKey: true },
      ],
    });
    expect(table.primaryKey).toEqual(["user_id", "group_id"]);
  });
});
