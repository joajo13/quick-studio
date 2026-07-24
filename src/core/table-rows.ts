/**
 * quick-studio Core — browse page planning (pure, safety-critical).
 *
 * `planTableRows` validates + normalizes a `table.rows` request against the LIVE
 * introspected schema and composes the read-only SELECT/COUNT for exactly one page
 * (Story 3.2). It is the safety seam: the table/schema identifiers are looked up in
 * the schema and rendered only via the injected `quoteIdent`; `LIMIT`/`OFFSET` are
 * Core-computed, validated non-negative integers rendered as literals. NO user
 * value is ever concatenated into SQL. Pagination is deterministic — ORDER BY the
 * primary key (a total, repeatable order).
 *
 * ORDER BY precedence for ONE page (DW-33):
 *  1. the primary key — a total, repeatable order; pages never overlap or skip;
 *  2. the engine's PHYSICAL ROW LOCATOR when the relation provably has one (Postgres
 *     `ctid` on a physically stored relation) — also total, and available even when
 *     every column is of an unorderable type;
 *  3. every ORDERABLE column, decided by a per-engine ALLOWLIST — best-effort, and not
 *     strict when rows are fully duplicated;
 *  4. no ORDER BY at all, when none of the above yields a column.
 *
 * The allowlist is the safety property: `planTableRows` must never compose an
 * `ORDER BY` the target engine would REJECT (a type with no default ordering operator
 * raises "could not identify an ordering operator" and collapses the whole page into
 * `internal_error`). A denylist fails OPEN — an unknown/new type is assumed orderable
 * and can hard-fail; the allowlist fails CLOSED — an unknown type is simply skipped,
 * costing at worst a weaker order. Prevention only: there is deliberately no
 * catch-and-retry degrade path.
 *
 * Residual, by design: a keyless relation with NO physical locator (a view, a
 * partitioned parent) whose columns are all unorderable still gets no ORDER BY, so its
 * page order is non-total. That is strictly better than also hard-failing, and closing it
 * needs keyset pagination, which is out of scope. See also the DW-32 snapshot note on
 * `tableRows` in `server.ts`: the COUNT and the page SELECT are two non-atomic
 * round-trips, so `total` and the page can disagree under concurrent writes.
 *
 * Pure and dependency-injectable: `quoteIdent` is passed in so composition is
 * unit-testable without a live driver.
 */

import type {
  DatabaseSchema,
  DbEngine,
  SchemaColumnInfo,
  SchemaTableInfo,
} from "../shared/contract.ts";

/** Default rows-per-page when the request omits `pageSize`. */
export const DEFAULT_PAGE_SIZE = 100;
/** Hard cap on rows-per-page — a larger requested `pageSize` is clamped to this. */
export const MAX_PAGE_SIZE = 200;

/** A validation failure carrying the wire error code + a specific message. */
export type PlanError = {
  readonly code: "bad_request" | "not_found";
  readonly message: string;
};

/** The composed, ready-to-run page plan. */
export type TableRowsPlan = {
  /** `SELECT <cols> FROM <table> ORDER BY <order> LIMIT n OFFSET m` — one page. */
  readonly selectSql: string;
  /** `SELECT COUNT(*) AS total FROM <table>` — the pager's total. */
  readonly countSql: string;
  /** Effective 1-based page (echoed to the client). */
  readonly page: number;
  /** Effective page size after clamping to {@link MAX_PAGE_SIZE}. */
  readonly pageSize: number;
  /** Zero-based row offset (`(page - 1) * pageSize`). */
  readonly offset: number;
  /** The table's columns in select order — column names for `frozen-map`. */
  readonly columns: ReadonlyArray<SchemaColumnInfo>;
};

/** Discriminated result of {@link planTableRows}. */
export type PlanResult =
  | { readonly ok: true; readonly plan: TableRowsPlan }
  | { readonly ok: false; readonly error: PlanError };

function fail(code: PlanError["code"], message: string): PlanResult {
  return { ok: false, error: { code, message } };
}

/** A positive integer (`>= 1`)? Used for `page`/`pageSize` validation. */
function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/**
 * The per-engine ALLOWLIST of column types that provably have a default ordering
 * operator, i.e. the only types the keyless fallback may name in an `ORDER BY` (DW-33).
 *
 * Keyed on {@link DbEngine} and matched EXACTLY (not by prefix) against
 * `dataType.toLowerCase().trim()`. `dataType` is `information_schema.columns.data_type`
 * verbatim on both engines, so these are the spellings the catalogs actually report —
 * Postgres says `character varying` and `timestamp without time zone`, and reports an
 * enum/composite as `USER-DEFINED` and any array as `ARRAY`, none of which appear here.
 *
 * This REPLACES the former `UNORDERABLE_TYPE_PREFIXES` denylist, which failed open twice
 * over: an unlisted-but-unorderable type (`USER-DEFINED`, `ARRAY`, `record`, `tsvector`,
 * `pg_lsn`, MySQL `geometry`) sailed through and made the engine reject the page, and
 * prefix matching mis-classified in both directions (`point` also matched a hypothetical
 * `point_id`-ish type name). An unknown type is now NOT orderable — the conservative arm.
 * Never widen this by adding a type that lacks a default ordering operator.
 *
 * The allowlist must also not UNDER-approximate: the recorded decision is "order by the
 * FULL set of orderable columns", so a type the OLD denylist admitted and that provably
 * DOES have a default ordering operator has to stay in, or a keyless relation silently
 * loses an `ORDER BY` it used to have. Hence, each with its proof:
 *  - MySQL `json` — MySQL defines a TOTAL ordering over JSON values since 5.7 (the
 *    documented cross-type comparison order), so `ORDER BY <json col>` is accepted.
 *  - MySQL `tinyblob`/`blob`/`mediumblob`/`longblob` — BLOBs sort as binary strings,
 *    truncated to the first `max_sort_length` bytes; the engine accepts the sort (and the
 *    old prefix denylist only ever matched the bare `blob` spelling anyway, so
 *    `mediumblob`/`longblob`/`tinyblob` columns were ordered by before this change).
 *  - Postgres `jsonb` — has had a btree opclass (`jsonb_ops`, a total ordering) since 9.4.
 *    Plain `json` does NOT and must stay OUT: it has no equality/ordering operator at all
 *    and `ORDER BY <json col>` raises "could not identify an ordering operator".
 *  - Postgres `oid` and `name` — both are ordinary btree-ordered catalog types (`oid` is an
 *    unsigned 4-byte integer, `name` a fixed-length C string) and reachable as a user
 *    column type; both sorted fine under the old denylist.
 */
const ORDERABLE_TYPES: Readonly<Record<DbEngine, ReadonlySet<string>>> = {
  postgres: new Set([
    "smallint",
    "integer",
    "bigint",
    "numeric",
    "decimal",
    "real",
    "double precision",
    "money",
    "boolean",
    "character",
    "character varying",
    "text",
    "uuid",
    "date",
    "timestamp without time zone",
    "timestamp with time zone",
    "time without time zone",
    "time with time zone",
    "interval",
    "bytea",
    "inet",
    "cidr",
    "macaddr",
    "macaddr8",
    "bit",
    "bit varying",
    // btree-ordered since 9.4 — unlike plain `json`, which has NO ordering operator.
    "jsonb",
    "oid",
    "name",
  ]),
  mysql: new Set([
    "tinyint",
    "smallint",
    "mediumint",
    "int",
    "integer",
    "bigint",
    "decimal",
    "numeric",
    "float",
    "double",
    "real",
    "bit",
    "char",
    "varchar",
    "binary",
    "varbinary",
    "tinytext",
    "text",
    "mediumtext",
    "longtext",
    "enum",
    "set",
    "date",
    "datetime",
    "timestamp",
    "time",
    "year",
    // Total ordering over JSON values since 5.7.
    "json",
    // Sorted as binary strings (first `max_sort_length` bytes) — accepted by the engine.
    "tinyblob",
    "blob",
    "mediumblob",
    "longblob",
  ]),
};

/**
 * Postgres's physical row locator: the system column every physically stored relation
 * carries, giving a TOTAL order even when no column of the table is orderable. It is used
 * for ordering ONLY — never projected into the SELECT list — so `TableRowsResult.data`
 * keeps exactly the introspected columns. MySQL has no equivalent (InnoDB exposes no
 * stable per-row locator as a selectable column), hence the postgres-only gate below.
 */
const PHYSICAL_ROW_LOCATOR = "ctid";

/** Is this column's type in `engine`'s orderable allowlist? Unknown ⇒ NOT orderable. */
function isOrderable(engine: DbEngine, column: SchemaColumnInfo): boolean {
  return ORDERABLE_TYPES[engine].has(column.dataType.toLowerCase().trim());
}

/**
 * May the browse plan order `target` by the engine's physical row locator (DW-33)?
 *
 * Only Postgres has one, and only on a PHYSICALLY STORED relation: `kind === "table"`
 * (`pg_class.relkind` `r`/`m`). Everything else falls through to column ordering —
 * a `view` (Postgres views ARE introspected and browsable, and never have a PK, so an
 * unguarded "keyless ⇒ ctid" would turn every view browse into a hard engine error),
 * an `other` (a partitioned parent or foreign table looks table-like but exposes no
 * `ctid` of its own), and an ABSENT `kind`, which means "unknown" and must never be
 * optimistically read as "table".
 */
function hasPhysicalRowLocator(engine: DbEngine, target: SchemaTableInfo): boolean {
  return engine === "postgres" && target.kind === "table";
}

/**
 * Validate + normalize a `table.rows` request against `schema`, and compose the
 * page SELECT + COUNT. Never throws for bad input — every rejection is a typed
 * {@link PlanError} (`bad_request` for shape/param problems and cross-schema
 * ambiguity, `not_found` when the named table is not in the live schema).
 */
export function planTableRows(
  schema: DatabaseSchema,
  params: unknown,
  quoteIdent: (ident: string) => string,
): PlanResult {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return fail("bad_request", "table.rows requires a params object");
  }
  const p = params as Record<string, unknown>;

  // table — required, non-blank string.
  if (typeof p.table !== "string" || p.table.trim().length === 0) {
    return fail("bad_request", "table.rows requires a non-empty 'table'");
  }
  const table = p.table;

  // schema — optional, but when present must be a non-blank string.
  let requestedSchema: string | undefined;
  if (p.schema !== undefined) {
    if (typeof p.schema !== "string" || p.schema.trim().length === 0) {
      return fail("bad_request", "table.rows 'schema' must be a non-empty string when provided");
    }
    requestedSchema = p.schema;
  }

  // page — optional, defaults to 1; must be a positive integer.
  let page = 1;
  if (p.page !== undefined) {
    if (!isPositiveInt(p.page)) {
      return fail("bad_request", "table.rows 'page' must be a positive integer");
    }
    page = p.page;
  }

  // pageSize — optional, defaults to DEFAULT_PAGE_SIZE; positive integer, clamped.
  let pageSize = DEFAULT_PAGE_SIZE;
  if (p.pageSize !== undefined) {
    if (!isPositiveInt(p.pageSize)) {
      return fail("bad_request", "table.rows 'pageSize' must be a positive integer");
    }
    pageSize = Math.min(p.pageSize, MAX_PAGE_SIZE);
  }

  // Resolve the table against the LIVE schema — the identifiers that reach SQL are
  // taken from THIS match, never from the raw request string.
  const matches = schema.tables.filter(
    (t) => t.name === table && (requestedSchema === undefined || t.schema === requestedSchema),
  );
  if (matches.length === 0) {
    const qualified = requestedSchema !== undefined ? `${requestedSchema}.${table}` : table;
    return fail("not_found", `table '${qualified}' not found in the connected schema`);
  }
  if (matches.length > 1) {
    const schemas = matches.map((t) => t.schema).join(", ");
    return fail(
      "bad_request",
      `table '${table}' is ambiguous across schemas (${schemas}); qualify it with a 'schema'`,
    );
  }
  const target: SchemaTableInfo = matches[0]!;

  const offset = (page - 1) * pageSize;

  // Guard against a `page` so large the offset falls outside the safe-integer
  // range: it would stringify to scientific notation ("1e+23") or Infinity and
  // produce malformed SQL. Reject before any literal is rendered.
  if (!Number.isSafeInteger(offset)) {
    return fail("bad_request", "table.rows 'page' is out of range");
  }

  // Column list (select order) and deterministic ORDER BY, in strict precedence
  // (DW-33): the primary key when present (a total, repeatable order so pages never
  // overlap); else the engine's physical row locator when the relation provably has one
  // (also total, and immune to the column types); else every ORDERABLE column, which is
  // best-effort. Every name that reaches the clause comes from the live schema match or
  // is the fixed locator literal — never from the request.
  const columns = target.columns;
  const orderCols =
    target.primaryKey.length > 0
      ? target.primaryKey
      : hasPhysicalRowLocator(schema.engine, target)
        ? [PHYSICAL_ROW_LOCATOR]
        : columns.filter((c) => isOrderable(schema.engine, c)).map((c) => c.name);

  const qualifiedTable = `${quoteIdent(target.schema)}.${quoteIdent(target.name)}`;
  // The SELECT list is the introspected columns ONLY — the row locator orders the page
  // but is never projected, so the wire result shape is unchanged.
  const colList = columns.map((c) => quoteIdent(c.name)).join(", ");

  // Omit ORDER BY entirely when no orderable column remains (rather than emit an
  // empty clause) — a non-total page order, but never one the engine rejects. The PK and
  // row-locator paths always have at least one column. The locator goes through
  // `quoteIdent` like every other identifier: no raw name is ever concatenated.
  const orderBy = orderCols.length > 0 ? ` ORDER BY ${orderCols.map((name) => quoteIdent(name)).join(", ")}` : "";

  // LIMIT/OFFSET are validated non-negative integers rendered as literals — no bind
  // param, no user string. `pageSize >= 1` and `offset >= 0` are guaranteed above.
  const selectSql = `SELECT ${colList} FROM ${qualifiedTable}${orderBy} LIMIT ${pageSize} OFFSET ${offset}`;
  const countSql = `SELECT COUNT(*) AS total FROM ${qualifiedTable}`;

  return { ok: true, plan: { selectSql, countSql, page, pageSize, offset, columns } };
}

/**
 * Read the scalar total out of a COUNT(*) result's first cell. Engines return it
 * as a number (mysql2), a string (postgres.js `bigint`→string), or a `bigint`;
 * all three coerce to a finite number here (0 when absent/unparseable).
 */
export function readTotal(rows: ReadonlyArray<ReadonlyArray<unknown>>): number {
  const cell = rows[0]?.[0];
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : 0;
  if (typeof cell === "bigint") {
    const n = Number(cell);
    return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
  }
  if (typeof cell === "string") {
    const n = Number(cell);
    if (!Number.isFinite(n)) return 0;
    return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
  }
  return 0;
}
