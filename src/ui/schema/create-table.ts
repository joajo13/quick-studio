/**
 * quick-studio UI (Ring 2) — structured create-table builder (pure).
 *
 * The tested seam between the presentational {@link CreateTablePanel} and the Story
 * 3.1 guarded Core executor. Given a table name, target schema, and typed column
 * drafts it produces a typed `createTable` {@link StructuredOp} (path (a)) or a
 * `{ error }` — never raw SQL/DDL text. It also synthesizes the {@link SchemaTableInfo}
 * for the optimistic schema-tree append on a successful create (the Core's
 * connect-time schema is memoized and cannot be re-introspected without a Core
 * change), so the new table appears with no manual refresh.
 *
 * `type` is never free text: it is a canonical token from {@link CREATE_TABLE_TYPES},
 * a deliberate MIRROR of the executor's own allowlist. If the two ever drift, an
 * unknown token fails CLOSED as a Core `bad_request` surfaced inline — never a
 * silent bad DDL.
 */

import type {
  SchemaColumnInfo,
  SchemaTableInfo,
  StructuredColumnDef,
  StructuredOp,
} from "../../shared/contract.ts";

/**
 * The create-table type vocabulary. This MUST mirror `CREATE_TABLE_TYPES` in
 * `src/core/executor.ts` (Ring 0), which is the single source of truth — it lives
 * in the Core (not `shared/contract.ts`), so the UI keeps a mirrored constant here
 * rather than importing across the trust boundary. Drift fails closed: a token the
 * Core does not recognize yields a `bad_request` envelope surfaced inline, so this
 * list can never smuggle invalid DDL past the guard.
 */
export const CREATE_TABLE_TYPES: readonly string[] = [
  "INTEGER",
  "BIGINT",
  "SMALLINT",
  "TEXT",
  "VARCHAR",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
  "NUMERIC",
  "REAL",
  "DOUBLE PRECISION",
  "UUID",
  "JSON",
];

/** One column row of the create-table form: name + allowlisted type + flags. */
export type ColumnDraft = {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
};

/**
 * The whole create-table form as pure data. `schema` is the target namespace
 * (chosen from existing schemas, defaulted to the first — typically `public`); an
 * empty/absent schema falls back to the Core default and self-corrects on the next
 * reconnect (the empty-DB / brand-new-schema edge).
 */
export type CreateTableDraft = {
  readonly schema?: string;
  readonly table: string;
  readonly columns: ReadonlyArray<ColumnDraft>;
};

/** A validation/build failure carrying a terse, in-panel-displayable message. */
export type CreateTableError = { readonly error: string };

/** Discriminate a builder result from a build failure. */
export function isCreateTableError(v: unknown): v is CreateTableError {
  return typeof v === "object" && v !== null && "error" in v;
}

/** Result of {@link validateCreateTableDraft}: ok, or the first blocking reason. */
export type CreateTableValidation = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Validate a draft BEFORE enabling submit (never send an RPC on invalid input):
 * a non-empty table name, ≥1 column, every column with a non-empty name and an
 * allowlisted type, and unique column names. A primary key is OPTIONAL — a PK-less
 * table is allowed. Column names are compared trimmed (the identifiers the Core
 * would quote).
 */
export function validateCreateTableDraft(draft: CreateTableDraft): CreateTableValidation {
  if (draft.table.trim() === "") return { ok: false, message: "table name is required" };
  if (draft.columns.length === 0) return { ok: false, message: "at least one column is required" };

  const seen = new Set<string>();
  for (const col of draft.columns) {
    const name = col.name.trim();
    if (name === "") return { ok: false, message: "every column needs a name" };
    if (col.type.trim() === "") return { ok: false, message: `column "${name}" needs a type` };
    if (!CREATE_TABLE_TYPES.includes(col.type)) return { ok: false, message: `unknown type: ${col.type}` };
    if (seen.has(name)) return { ok: false, message: `duplicate column name: ${name}` };
    seen.add(name);
  }
  return { ok: true };
}

/**
 * Build a `createTable` structured op from a validated draft. Per-column
 * `notNull`/`primaryKey` flags are emitted ONLY when true (undefined/false are
 * omitted); primary-key membership travels as those per-column flags — the Core
 * folds them into the effective PK, so there is no table-level PK array. An absent
 * or empty `schema` is omitted so the Core default applies.
 */
export function buildCreateTableOp(draft: CreateTableDraft): StructuredOp | CreateTableError {
  const validation = validateCreateTableDraft(draft);
  if (!validation.ok) return { error: validation.message };

  const columns: StructuredColumnDef[] = draft.columns.map((col) => ({
    name: col.name.trim(),
    type: col.type,
    ...(col.notNull ? { notNull: true } : {}),
    ...(col.primaryKey ? { primaryKey: true } : {}),
  }));

  const schema = draft.schema?.trim();
  const base = { kind: "createTable" as const, table: draft.table.trim(), columns };
  return schema ? { ...base, schema } : base;
}

/**
 * Synthesize the {@link SchemaTableInfo} for the optimistic tree append after a
 * `createTable` `ok`. A committed DDL is all-or-nothing, so the table exists exactly
 * as submitted: columns map to `{name, dataType:type, nullable:!notNull}`,
 * `primaryKey` lists the flagged columns' names, and `schema` is exactly the
 * submitted schema (so the tree grouping and a later click→`bindTable` browse agree
 * with how introspection lists it). Superseded by introspected truth on the next
 * reconnect.
 */
export function synthesizeSchemaTable(draft: CreateTableDraft): SchemaTableInfo {
  const columns: SchemaColumnInfo[] = draft.columns.map((col) => ({
    name: col.name.trim(),
    dataType: col.type,
    // A primary-key column is NOT NULL in the database even if the user did not tick
    // NOT NULL (the engine implies it), so reflect that in the optimistic row.
    nullable: !(col.notNull || col.primaryKey),
  }));
  return {
    // Trim to match `buildCreateTableOp`'s schema so the optimistic key and the op's
    // effective target agree (an empty/blank schema stays "" = the default namespace).
    schema: draft.schema?.trim() ?? "",
    name: draft.table.trim(),
    columns,
    primaryKey: draft.columns.filter((col) => col.primaryKey).map((col) => col.name.trim()),
  };
}
