/**
 * quick-studio Core — browse page planning (pure, safety-critical).
 *
 * `planTableRows` validates + normalizes a `table.rows` request against the LIVE
 * introspected schema and composes the read-only SELECT/COUNT for exactly one page
 * (Story 3.2). It is the safety seam: the table/schema identifiers are looked up in
 * the schema and rendered only via the injected `quoteIdent`; `LIMIT`/`OFFSET` are
 * Core-computed, validated non-negative integers rendered as literals. NO user
 * value is ever concatenated into SQL. Pagination is deterministic — ORDER BY the
 * primary key (a total, repeatable order). Keyless tables have no total order to
 * lean on: the fallback orders by every ORDERABLE column (unorderable types like
 * `json`/`bytea` are skipped), which is best-effort and may not be strict when
 * rows are fully duplicated; if no column is orderable the ORDER BY is omitted.
 *
 * Pure and dependency-injectable: `quoteIdent` is passed in so composition is
 * unit-testable without a live driver.
 */

import type { DatabaseSchema, SchemaColumnInfo, SchemaTableInfo } from "../shared/contract.ts";

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
 * Known column types with no default ordering operator — `ORDER BY` on one of
 * these errors ("could not identify an ordering operator"), so the keyless
 * fallback skips them. Matched case-insensitively by prefix against `dataType`.
 */
const UNORDERABLE_TYPE_PREFIXES: ReadonlyArray<string> = [
  "json",
  "jsonb",
  "xml",
  "point",
  "line",
  "lseg",
  "box",
  "path",
  "polygon",
  "circle",
  "bytea",
  "blob",
  "geometry",
];

/** Is this column orderable — i.e. NOT one of the known-unorderable types? */
function isOrderable(column: SchemaColumnInfo): boolean {
  const t = column.dataType.toLowerCase().trim();
  return !UNORDERABLE_TYPE_PREFIXES.some((prefix) => t.startsWith(prefix));
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

  // Column list (select order) and deterministic ORDER BY: the primary key when
  // present (a total, repeatable order so pages never overlap), else every
  // ORDERABLE column (unorderable types like json/bytea are skipped — best-effort).
  const columns = target.columns;
  const orderCols =
    target.primaryKey.length > 0
      ? target.primaryKey
      : columns.filter(isOrderable).map((c) => c.name);

  const qualifiedTable = `${quoteIdent(target.schema)}.${quoteIdent(target.name)}`;
  const colList = columns.map((c) => quoteIdent(c.name)).join(", ");

  // Omit ORDER BY entirely when no orderable column remains (rather than emit an
  // empty clause). PK path always has at least one column.
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
