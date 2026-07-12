/**
 * quick-studio Core — the single guarded SQL executor (Story 3.1).
 *
 * This is the sole system-wide risk classifier. It accepts exactly two request
 * shapes and sets confirmation policy by shape:
 *  - (a) STRUCTURED single-row DML / CREATE TABLE — the Core composes parameterized
 *    SQL from typed fields; it can never widen to raw/multi-row/DDL-beyond-CREATE.
 *  - (b) RAW SQL text — opaque text, classified DEFAULT-DENY, multi-statement rejected
 *    by an engine-aware, comment/string/dollar-quote/backtick-and-escape-aware
 *    statement splitter.
 *
 * Pure except for the injected seams (`runQuery`/`runReadOnly`/`getEngine`/
 * `getSchema`/`quoteIdent`): no SQL is string-spliced from a value (values are always
 * bound), identifiers are only rendered via the engine-correct `quoteIdent`, and a
 * mis-classified read runs inside an engine read-only transaction so any write fails
 * at the engine instead of committing. Raw engine error text is never echoed — a
 * seam throw propagates to `dispatch` → a generic `internal_error`.
 */

import {
  errorReply,
  okReply,
  type DbEngine,
  type ExecuteResult,
  type RpcReply,
  type SchemaTableInfo,
} from "../shared/contract.ts";
import type { ConnectionSeams, ResolvedConnection } from "./connection-targets.ts";
import type { DriverQueryResult } from "./driver.ts";
import { rowsToFrozenData } from "./frozen-map.ts";

/** Hard Core-side cap on rows materialized from a read (full pagination is Story 3.2). */
export const MAX_RESULT_ROWS = 1000;

/**
 * The fixed, engine-blind allowlist of canonical column types the structured
 * `createTable` composer may emit. There is NO raw-text fallback — a type token not
 * in this set is a `bad_request` at validation, and an assertion at compose time.
 */
const CREATE_TABLE_TYPES: ReadonlySet<string> = new Set([
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
]);

/**
 * The executor's ONE dependency: resolve an optional saved-connection id to the
 * {@link ConnectionSeams} to run over (Story 6.2). The default (id null/absent) returns
 * the boot manager's seams, keeping the untargeted path byte-identical. A resolve is
 * done ONCE per `execute` call — targeting logic lives entirely in `connection-targets.ts`,
 * so this module stays the pure risk classifier/composer it was.
 */
export type ExecutorDeps = {
  /** Resolve the target's seams (default boot); `not-found`/`unavailable` → typed error reply. */
  readonly resolveConnection: (connectionId?: string | null) => ResolvedConnection;
};

/** The executor handle: one `execute` capability returning a formed wire reply. */
export type Executor = {
  execute: (request: unknown) => Promise<RpcReply<ExecuteResult>>;
};

/* ------------------------------------------------------------------ *
 * Raw-path statement splitter (path b) — engine-aware, escape-correct
 * ------------------------------------------------------------------ */

/** Is `c` an identifier-continuation character (used for the `E'…'` prefix test)? */
function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

/**
 * Consume a `delim`-delimited span starting at the opening `delim` at `start`,
 * returning the index just past the CLOSING delimiter (or `sql.length` when
 * unterminated). Honors `''`/`""`/`` `` `` DOUBLING (both engines) and, when
 * `backslash` is set, engine backslash escapes (`\<char>` consumes the escaped char,
 * so `\'` does NOT close the string). Correct string boundaries are what stop a
 * `;` inside a crafted escape string from being seen as a top-level separator.
 */
function consumeDelimited(sql: string, start: number, delim: string, backslash: boolean): number {
  const n = sql.length;
  let i = start + 1; // past the opening delimiter
  while (i < n) {
    const c = sql[i]!;
    if (backslash && c === "\\") {
      i += 2; // skip the backslash AND the char it escapes
      continue;
    }
    if (c === delim) {
      if (sql[i + 1] === delim) {
        i += 2; // doubled delimiter → a literal delimiter, stays inside the span
        continue;
      }
      return i + 1; // closing delimiter
    }
    i += 1;
  }
  return n; // unterminated — consume to end (fail-closed: any later `;` stays hidden)
}

/**
 * Match a postgres dollar-quote opening tag (`$$` or `$tag$`) at `i`. Returns the
 * full tag string (e.g. `"$tag$"`) or `null` when `$` does not open a dollar-quote.
 */
function matchDollarTag(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j += 1;
  if (sql[j] === "$") return sql.slice(i, j + 1);
  return null;
}

/**
 * If a special span (comment / quoted string / quoted identifier / dollar-quote /
 * backtick) starts at `i`, return the index just past it; otherwise return `i`
 * (an ORDINARY character the caller handles). `prev`/`prev2` are the two source
 * chars immediately before `i`, used only to detect a postgres `E'…'`/`e'…'` escape
 * string (backslash-escaping active) vs a standard `'…'` string (backslash literal).
 */
function consumeSpan(
  sql: string,
  i: number,
  engine: DbEngine,
  prev: string | undefined,
  prev2: string | undefined,
): number {
  const ch = sql[i]!;
  const next = sql[i + 1];
  const isPg = engine === "postgres";
  const isMysql = engine === "mysql";
  const n = sql.length;

  // Line comment: `-- … <newline>` (newline itself is left for the caller).
  // postgres treats `--` as a comment UNCONDITIONALLY; MySQL only when the dashes
  // are followed by whitespace, a control char, or end-of-input — otherwise `--` is
  // arithmetic (`x --3` is `x - -3`). Being MySQL-faithful here keeps a `;` after a
  // bare `--` (e.g. `SET x=1 --3;DROP …`) a real top-level separator, so the smuggle
  // splits into multiple statements instead of hiding inside a phantom comment.
  if (ch === "-" && next === "-") {
    const after = sql[i + 2];
    const opensComment =
      isPg || after === undefined || /\s/.test(after) || after.charCodeAt(0) < 0x20;
    if (opensComment) {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j += 1;
      return j;
    }
    // mysql bare `--<non-space>`: NOT a comment — fall through, `-` is an ordinary char.
  }
  // Block comment: `/* … */` (non-nested — over-counting a stray `;` fails closed).
  if (ch === "/" && next === "*") {
    let j = i + 2;
    while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j += 1;
    return Math.min(n, j + 2);
  }
  // Postgres dollar-quote: `$tag$ … $tag$`.
  if (isPg && ch === "$") {
    const tag = matchDollarTag(sql, i);
    if (tag !== null) {
      const end = sql.indexOf(tag, i + tag.length);
      return end === -1 ? n : end + tag.length;
    }
    return i; // a lone `$` — ordinary char
  }
  // MySQL backtick identifier: `` `…` `` with `` `` `` doubling (no backslash escapes).
  if (isMysql && ch === "`") {
    return consumeDelimited(sql, i, "`", false);
  }
  // Double-quoted span: postgres IDENTIFIER (only `""` doubling); mysql STRING (also
  // backslash-escaped in default mode).
  if (ch === '"') {
    return consumeDelimited(sql, i, '"', isMysql);
  }
  // Single-quoted string: mysql backslash-escapes always; postgres only inside an
  // `E'…'`/`e'…'` escape string (detected by the immediately-preceding token char).
  if (ch === "'") {
    const isEString = isPg && (prev === "e" || prev === "E") && !isIdentChar(prev2);
    return consumeDelimited(sql, i, "'", isMysql || isEString);
  }
  return i; // ordinary character
}

/**
 * Split `sql` into top-level statements: a `;` is a separator ONLY outside every
 * comment/string/identifier/dollar-quote/backtick span. Segments that tokenize to
 * zero top-level words (a trailing comment after a terminating `;`, whitespace) are
 * DROPPED before the count, so `SELECT 1; -- done` is ONE statement.
 */
export function splitStatements(sql: string, engine: DbEngine): string[] {
  const segments: string[] = [];
  const n = sql.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const prev = i > 0 ? sql[i - 1] : undefined;
    const prev2 = i > 1 ? sql[i - 2] : undefined;
    const end = consumeSpan(sql, i, engine, prev, prev2);
    if (end > i) {
      i = end; // skipped a span — its inner `;` is not a separator
      continue;
    }
    if (sql[i] === ";") {
      segments.push(sql.slice(start, i));
      start = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  segments.push(sql.slice(start));
  return segments.filter((seg) => firstKeyword(seg, engine) !== null);
}

/**
 * The leading keyword of a statement (upper-cased), skipping only leading whitespace
 * and comments. Returns `null` for a comment/whitespace-only segment, `""` for a
 * segment that has content but no leading identifier word (a number, `(`, a lone
 * string), else the first identifier word.
 */
export function firstKeyword(seg: string, _engine: DbEngine): string | null {
  const n = seg.length;
  let i = 0;
  while (i < n) {
    const ch = seg[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && seg[i + 1] === "-") {
      i += 2;
      while (i < n && seg[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && seg[i + 1] === "*") {
      i += 2;
      while (i < n && !(seg[i] === "*" && seg[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let w = "";
      while (i < n && /[A-Za-z0-9_]/.test(seg[i]!)) {
        w += seg[i];
        i += 1;
      }
      return w.toUpperCase();
    }
    return ""; // content present (string / digit / paren / operator), no leading word
  }
  return null; // only comments + whitespace
}

/**
 * Collect the TOP-LEVEL identifier words (upper-cased) of a statement — words that
 * are NOT inside a comment/string/quoted-identifier/dollar-quote span. Used to detect
 * a top-level `INTO` (`SELECT … INTO …` CTAS / `INTO OUTFILE`) that a leading-keyword
 * check cannot see, WITHOUT being fooled by an `INTO` that lives inside a string.
 */
export function topLevelWords(sql: string, engine: DbEngine): string[] {
  const words: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const prev = i > 0 ? sql[i - 1] : undefined;
    const prev2 = i > 1 ? sql[i - 2] : undefined;
    const end = consumeSpan(sql, i, engine, prev, prev2);
    if (end > i) {
      i = end; // skip the span (its words are not top-level)
      continue;
    }
    const ch = sql[i]!;
    if (/[A-Za-z_]/.test(ch)) {
      let w = "";
      while (i < n && /[A-Za-z0-9_]/.test(sql[i]!)) {
        w += sql[i];
        i += 1;
      }
      words.push(w.toUpperCase());
      continue;
    }
    i += 1;
  }
  return words;
}

/* ------------------------------------------------------------------ *
 * Executor
 * ------------------------------------------------------------------ */

/** Short, engine-neutral risk string for a needs-confirm raw statement. */
function riskFor(verb: string): string {
  switch (verb) {
    case "UPDATE":
    case "INSERT":
    case "DELETE":
      return "This statement modifies data.";
    case "DROP":
    case "TRUNCATE":
      return "This statement destroys data.";
    case "ALTER":
    case "CREATE":
      return "This statement changes the schema.";
    default:
      return "This statement is not a read; it may modify data or the schema.";
  }
}

/** Map a driver read result into a Core-capped `rows` outcome. */
function toRowsResult(result: DriverQueryResult): ExecuteResult {
  const names = result.columns.map((c) => c.name);
  const truncated = result.rows.length > MAX_RESULT_ROWS;
  const capped = truncated ? result.rows.slice(0, MAX_RESULT_ROWS) : result.rows;
  const data = rowsToFrozenData(names, capped);
  return { status: "rows", data, truncated };
}

/**
 * Build the guarded executor over the injected seams. `execute` returns an ALREADY-
 * formed {@link RpcReply}: a protocol violation is a `bad_request` envelope; a domain
 * outcome (rows / ok / confirmation_required) rides inside `okReply`. A seam throw
 * (engine/connection failure) propagates → `internal_error` at dispatch.
 */
export function createExecutor(deps: ExecutorDeps): Executor {
  const { resolveConnection } = deps;

  const bad = (message: string): RpcReply<ExecuteResult> => errorReply("bad_request", message);

  /** Map a failed target resolution to its typed wire reply (never echoes a url). */
  function targetError(reason: "not-found" | "unavailable"): RpcReply<ExecuteResult> {
    return reason === "not-found"
      ? errorReply("not_found", "no connection with that id")
      : errorReply("internal_error", "credential store is unavailable");
  }

  /** `schema`-qualify + quote a table identifier (`"s"."t"` / `` `s`.`t` ``). */
  function qualified(quoteIdent: ConnectionSeams["quoteIdent"], schema: string | undefined, table: string): string {
    return schema !== undefined
      ? `${quoteIdent(schema)}.${quoteIdent(table)}`
      : quoteIdent(table);
  }

  /** Engine-correct positional placeholder: postgres `$n`, mysql `?`. */
  function placeholder(engine: DbEngine, index: number): string {
    return engine === "postgres" ? `$${index}` : "?";
  }

  /* ---- Path (b): raw SQL ------------------------------------------------ */

  async function executeRaw(seams: ConnectionSeams, sql: string, confirmed: boolean): Promise<RpcReply<ExecuteResult>> {
    const { runQuery, runReadOnly, getEngine } = seams;
    const engine = await getEngine();
    const statements = splitStatements(sql, engine);
    if (statements.length === 0) {
      return bad("empty statement");
    }
    if (statements.length > 1) {
      return bad("multiple statements are not allowed");
    }
    const stmt = statements[0]!.trim();
    const words = topLevelWords(stmt, engine);
    const verb = words[0];

    // A leading SELECT/SHOW is a READ — UNLESS it carries a top-level `INTO`
    // (`SELECT … INTO` CTAS / mysql `INTO OUTFILE`), which is default-denied because a
    // read-only transaction does not block a filesystem write.
    const isRead = (verb === "SELECT" || verb === "SHOW") && !words.includes("INTO");
    if (isRead) {
      // Auto-run inside an engine READ-ONLY transaction (rolled back): a hidden write
      // (volatile/writing function) then fails at the engine, never commits.
      const result = await runReadOnly(stmt, []);
      return okReply(toRowsResult(result));
    }

    // Everything else is DEFAULT-DENY (needs confirmation): a misclassification fails
    // safe (asks) rather than auto-running a mutation.
    if (!confirmed) {
      return okReply({
        status: "confirmation_required",
        preview: { sql: stmt, risk: riskFor(verb ?? "") },
      });
    }
    const result = await runQuery(stmt, []);
    return okReply({ status: "ok", rowsAffected: result.rowsAffected ?? 0 });
  }

  /* ---- Path (a): structured op ----------------------------------------- */

  async function executeStructured(
    seams: ConnectionSeams,
    op: Record<string, unknown>,
    confirmed: boolean,
  ): Promise<RpcReply<ExecuteResult>> {
    const kind = op.kind;
    if (kind === "insert") return executeInsert(seams, op);
    if (kind === "update") return executeUpdate(seams, op);
    if (kind === "delete") return executeDelete(seams, op, confirmed);
    if (kind === "createTable") return executeCreateTable(seams, op);
    return bad("unknown structured op kind");
  }

  async function executeInsert(seams: ConnectionSeams, op: Record<string, unknown>): Promise<RpcReply<ExecuteResult>> {
    const { runQuery, getEngine, quoteIdent } = seams;
    const table = readTable(op);
    if ("error" in table) return bad(table.error);
    const cols = readColumnValues(op.columns, "columns");
    if ("error" in cols) return bad(cols.error);
    if (cols.values.length === 0) return bad("insert requires at least one column");

    const engine = await getEngine();
    const names = cols.values.map((c) => quoteIdent(c.column));
    const phs = cols.values.map((_c, idx) => placeholder(engine, idx + 1));
    const params = cols.values.map((c) => c.value);
    const sql = `INSERT INTO ${qualified(quoteIdent, table.schema, table.table)} (${names.join(", ")}) VALUES (${phs.join(", ")})`;
    const result = await runQuery(sql, params);
    return okReply({ status: "ok", rowsAffected: result.rowsAffected ?? 0 });
  }

  async function executeUpdate(seams: ConnectionSeams, op: Record<string, unknown>): Promise<RpcReply<ExecuteResult>> {
    const { runQuery, getEngine, getSchema, quoteIdent } = seams;
    const table = readTable(op);
    if ("error" in table) return bad(table.error);
    const set = readColumnValues(op.set, "set");
    if ("error" in set) return bad(set.error);
    if (set.values.length === 0) return bad("update requires at least one column in 'set'");
    const pk = readPk(op.pk);
    if ("error" in pk) return bad(pk.error);

    const target = await resolveSinglePkTable(getSchema, table.schema, table.table, pk.column);
    if ("error" in target) return bad(target.error);

    const engine = await getEngine();
    const setSql = set.values.map((c, idx) => `${quoteIdent(c.column)}=${placeholder(engine, idx + 1)}`);
    const wherePh = placeholder(engine, set.values.length + 1);
    const sql = `UPDATE ${qualified(quoteIdent, target.table.schema, target.table.name)} SET ${setSql.join(", ")} WHERE ${quoteIdent(pk.column)}=${wherePh}`;
    const params = [...set.values.map((c) => c.value), pk.value];
    const result = await runQuery(sql, params);
    return okReply({ status: "ok", rowsAffected: result.rowsAffected ?? 0 });
  }

  async function executeDelete(
    seams: ConnectionSeams,
    op: Record<string, unknown>,
    confirmed: boolean,
  ): Promise<RpcReply<ExecuteResult>> {
    const { runQuery, getEngine, getSchema, quoteIdent } = seams;
    const table = readTable(op);
    if ("error" in table) return bad(table.error);
    const pk = readPk(op.pk);
    if ("error" in pk) return bad(pk.error);

    const target = await resolveSinglePkTable(getSchema, table.schema, table.table, pk.column);
    if ("error" in target) return bad(target.error);

    const engine = await getEngine();
    const sql = `DELETE FROM ${qualified(quoteIdent, target.table.schema, target.table.name)} WHERE ${quoteIdent(pk.column)}=${placeholder(engine, 1)}`;
    const params = [pk.value];

    // Row DELETE requires explicit confirmation — but the PK verification above still
    // runs first, so an unverifiable delete is `bad_request` even when unconfirmed.
    if (!confirmed) {
      return okReply({
        status: "confirmation_required",
        preview: { sql, risk: "This deletes a row." },
      });
    }
    const result = await runQuery(sql, params);
    return okReply({ status: "ok", rowsAffected: result.rowsAffected ?? 0 });
  }

  async function executeCreateTable(seams: ConnectionSeams, op: Record<string, unknown>): Promise<RpcReply<ExecuteResult>> {
    const { runQuery, getEngine, quoteIdent } = seams;
    const table = readTable(op);
    if ("error" in table) return bad(table.error);
    const columns = readColumnDefs(op.columns);
    if ("error" in columns) return bad(columns.error);

    // Effective primary key = the UNION (deduped, order-preserving) of the optional
    // table-level `primaryKey` array and every column flagged `primaryKey: true`, so a
    // column-level flag is HONORED (not a silent no-op on a documented field) and a
    // composite PK declared either way still composes. Table-level entries come first
    // (in their given order), then any column-level PK columns not already listed.
    const pkCols: string[] = [];
    const seenPk = new Set<string>();
    const addPk = (c: string) => {
      if (!seenPk.has(c)) {
        seenPk.add(c);
        pkCols.push(c);
      }
    };
    if (op.primaryKey !== undefined) {
      if (
        !Array.isArray(op.primaryKey) ||
        op.primaryKey.length === 0 ||
        !op.primaryKey.every((c) => typeof c === "string" && c.trim().length > 0)
      ) {
        return bad("createTable 'primaryKey' must be a non-empty array of column names");
      }
      const defined = new Set(columns.defs.map((d) => d.name));
      for (const c of op.primaryKey as string[]) {
        if (!defined.has(c)) return bad(`createTable primaryKey column '${c}' is not a defined column`);
        addPk(c);
      }
    }
    for (const d of columns.defs) {
      if (d.primaryKey) addPk(d.name);
    }

    const engine = await getEngine();
    const defs = columns.defs.map((d) => {
      const type = d.type.trim().toUpperCase();
      // Invariant (never a raw-text fallback): validation already rejected an
      // out-of-allowlist type, so reaching compose with one is a bug, not user input.
      if (!CREATE_TABLE_TYPES.has(type)) {
        throw new Error(`invariant violation: unvalidated createTable type '${type}'`);
      }
      return `${quoteIdent(d.name)} ${type}${d.notNull ? " NOT NULL" : ""}`;
    });
    if (pkCols.length > 0) {
      defs.push(`PRIMARY KEY (${pkCols.map((c) => quoteIdent(c)).join(", ")})`);
    }
    const sql = `CREATE TABLE ${qualified(quoteIdent, table.schema, table.table)} (${defs.join(", ")})`;
    const result = await runQuery(sql, []);
    // engine is read for placeholder parity / future engine-specific DDL; unused here.
    void engine;
    return okReply({ status: "ok", rowsAffected: result.rowsAffected ?? 0 });
  }

  /** Verify `pkColumn` is the table's SINGLE primary-key column against the live schema. */
  async function resolveSinglePkTable(
    getSchema: ConnectionSeams["getSchema"],
    schema: string | undefined,
    table: string,
    pkColumn: string,
  ): Promise<{ table: SchemaTableInfo } | { error: string }> {
    const live = await getSchema();
    const matches = live.tables.filter(
      (t) => t.name === table && (schema === undefined || t.schema === schema),
    );
    if (matches.length === 0) {
      return { error: "update/delete requires a single-column primary key that matches the addressed column" };
    }
    if (matches.length > 1) {
      return { error: "update/delete requires a single-column primary key that matches the addressed column" };
    }
    const target = matches[0]!;
    if (target.primaryKey.length !== 1 || target.primaryKey[0] !== pkColumn) {
      return { error: "update/delete requires a single-column primary key that matches the addressed column" };
    }
    return { table: target };
  }

  /* ---- Public entry ----------------------------------------------------- */

  async function execute(request: unknown): Promise<RpcReply<ExecuteResult>> {
    // Request-SHAPE validation happens BEFORE any engine/schema/connection round-trip,
    // so a malformed request is `bad_request` without a wasted connection.
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      return bad("execute requires a request object");
    }
    const req = request as Record<string, unknown>;
    const confirmed = req.confirmed === true;
    if (req.confirmed !== undefined && typeof req.confirmed !== "boolean") {
      return bad("execute 'confirmed' must be a boolean");
    }
    // The target rides on the request (Story 6.2): a non-null string id, or null/absent
    // ⇒ the boot connection. Validate its SHAPE before any connection round-trip.
    if (req.connectionId !== undefined && req.connectionId !== null && typeof req.connectionId !== "string") {
      return bad("execute 'connectionId' must be a string or null");
    }
    const connectionId = (req.connectionId as string | null | undefined) ?? null;

    if (req.shape === "raw") {
      if (typeof req.sql !== "string") {
        return bad("raw execute requires a string 'sql'");
      }
      const resolved = resolveConnection(connectionId);
      if (!resolved.ok) return targetError(resolved.reason);
      return executeRaw(resolved.seams, req.sql, confirmed);
    }
    if (req.shape === "structured") {
      if (typeof req.op !== "object" || req.op === null || Array.isArray(req.op)) {
        return bad("structured execute requires an 'op' object");
      }
      const resolved = resolveConnection(connectionId);
      if (!resolved.ok) return targetError(resolved.reason);
      return executeStructured(resolved.seams, req.op as Record<string, unknown>, confirmed);
    }
    return bad("execute 'shape' must be 'raw' or 'structured'");
  }

  return { execute };
}

/* ------------------------------------------------------------------ *
 * Structured-op field validation (pure — no I/O, runs before connection)
 * ------------------------------------------------------------------ */

/** Read `{ schema?, table }` off an op, requiring a non-empty table (and schema when present). */
function readTable(op: Record<string, unknown>): { schema?: string; table: string } | { error: string } {
  if (typeof op.table !== "string" || op.table.trim().length === 0) {
    return { error: "op requires a non-empty 'table'" };
  }
  if (op.schema !== undefined && (typeof op.schema !== "string" || op.schema.trim().length === 0)) {
    return { error: "op 'schema' must be a non-empty string when provided" };
  }
  return op.schema === undefined ? { table: op.table } : { schema: op.schema, table: op.table };
}

/**
 * Read a list of `{ column, value }` pairs, enforcing: a non-empty array; each entry
 * an object with a non-empty string `column` and a PRESENT `value` key (an ABSENT
 * `value` is a `bad_request`, never a silent NULL — an explicit `null` is allowed);
 * and no duplicate column identifiers.
 */
function readColumnValues(
  raw: unknown,
  field: string,
): { values: Array<{ column: string; value: unknown }> } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: `op '${field}' must be an array` };
  }
  const values: Array<{ column: string; value: unknown }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { error: `each '${field}' entry must be an object` };
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.column !== "string" || rec.column.trim().length === 0) {
      return { error: `each '${field}' entry requires a non-empty 'column'` };
    }
    if (!Object.hasOwn(rec, "value")) {
      return { error: `'${field}' column '${rec.column}' is missing its 'value' (absent value is not NULL)` };
    }
    if (seen.has(rec.column)) {
      return { error: `duplicate column '${rec.column}' in '${field}'` };
    }
    seen.add(rec.column);
    values.push({ column: rec.column, value: rec.value });
  }
  return { values };
}

/** Read a structured `pk` — one non-empty `column` + a PRESENT `value` key. */
function readPk(raw: unknown): { column: string; value: unknown } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "op requires a 'pk' object with a single column and value" };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.column !== "string" || rec.column.trim().length === 0) {
    return { error: "pk requires a non-empty 'column'" };
  }
  if (!Object.hasOwn(rec, "value")) {
    return { error: "pk is missing its 'value' (an absent pk value must never compose WHERE pk=NULL)" };
  }
  return { column: rec.column, value: rec.value };
}

/**
 * Read `createTable` column defs: a non-empty array of `{ name, type, notNull?,
 * primaryKey? }`, with each `type` in the fixed canonical allowlist (no raw-text
 * fallback) and no duplicate column names. A column-level `primaryKey: true` is
 * carried out so the composer can fold it into the effective PK column set.
 */
function readColumnDefs(
  raw: unknown,
): { defs: Array<{ name: string; type: string; notNull: boolean; primaryKey: boolean }> } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "createTable requires a non-empty 'columns' array" };
  }
  const defs: Array<{ name: string; type: string; notNull: boolean; primaryKey: boolean }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { error: "each 'columns' entry must be an object" };
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || rec.name.trim().length === 0) {
      return { error: "each column requires a non-empty 'name'" };
    }
    if (typeof rec.type !== "string" || rec.type.trim().length === 0) {
      return { error: "each column requires a non-empty 'type'" };
    }
    if (!CREATE_TABLE_TYPES.has(rec.type.trim().toUpperCase())) {
      return { error: `column '${rec.name}' has an unsupported type '${rec.type}'` };
    }
    if (rec.notNull !== undefined && typeof rec.notNull !== "boolean") {
      return { error: `column '${rec.name}' 'notNull' must be a boolean` };
    }
    if (rec.primaryKey !== undefined && typeof rec.primaryKey !== "boolean") {
      return { error: `column '${rec.name}' 'primaryKey' must be a boolean` };
    }
    if (seen.has(rec.name)) {
      return { error: `duplicate column '${rec.name}'` };
    }
    seen.add(rec.name);
    defs.push({
      name: rec.name,
      type: rec.type,
      notNull: rec.notNull === true,
      primaryKey: rec.primaryKey === true,
    });
  }
  return { defs };
}
