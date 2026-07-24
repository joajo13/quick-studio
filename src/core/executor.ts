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
  isExactNumericType,
  okReply,
  type DbEngine,
  type ExecuteResult,
  type RpcReply,
  type SchemaTableInfo,
} from "../shared/contract.ts";
import { NoConnectionTargetError } from "./connection.ts";
import { targetError, type ConnectionSeams, type ResolvedConnection } from "./connection-targets.ts";
import { DEFAULT_SESSION_MODES, type DriverQueryResult, type SessionModes } from "./driver.ts";
import { rowsToFrozenData } from "./frozen-map.ts";

/** Hard Core-side cap on rows materialized from a read (full pagination is Story 3.2). */
export const MAX_RESULT_ROWS = 1000;

/**
 * The engine-aware DDL map: each canonical column token → the exact DDL fragment
 * that is VALID on that engine. Two tiers of validation hang off this one table:
 *  1. shape gate — the union of all keys (`CREATE_TABLE_TYPES`), applied engine-blind
 *     before any connection round-trip;
 *  2. compose gate — per-engine lookup once the target engine is known, so MySQL never
 *     composes DDL the engine would reject (bare `VARCHAR` needs a length; `UUID` has no
 *     native MySQL type). A shape-valid token absent from the target engine's map is a
 *     contract-level `bad_request` BEFORE any DDL runs — never an opaque engine
 *     `internal_error`. There is NO raw-text fallback.
 * `Record<DbEngine, …>` keeps this exhaustive: if `DbEngine` ever grows a third value the
 * compiler forces a new engine map here rather than silently falling through.
 */
const CREATE_TABLE_TYPE_DDL: Record<DbEngine, Record<string, string>> = {
  postgres: {
    INTEGER: "INTEGER",
    BIGINT: "BIGINT",
    SMALLINT: "SMALLINT",
    TEXT: "TEXT",
    VARCHAR: "VARCHAR",
    BOOLEAN: "BOOLEAN",
    DATE: "DATE",
    TIMESTAMP: "TIMESTAMP",
    NUMERIC: "NUMERIC",
    REAL: "REAL",
    "DOUBLE PRECISION": "DOUBLE PRECISION",
    UUID: "UUID",
    JSON: "JSON",
  },
  // MySQL differs on exactly two tokens: bare `VARCHAR` is invalid (needs a length) so it
  // renders `VARCHAR(255)`, and there is no native `UUID` type so the key is OMITTED —
  // `UUID` is postgres-only and rejected on MySQL rather than silently remapped to CHAR(36).
  mysql: {
    INTEGER: "INTEGER",
    BIGINT: "BIGINT",
    SMALLINT: "SMALLINT",
    TEXT: "TEXT",
    VARCHAR: "VARCHAR(255)",
    BOOLEAN: "BOOLEAN",
    DATE: "DATE",
    TIMESTAMP: "TIMESTAMP",
    NUMERIC: "NUMERIC",
    REAL: "REAL",
    "DOUBLE PRECISION": "DOUBLE PRECISION",
    JSON: "JSON",
  },
};

/**
 * The fixed, engine-blind shape allowlist the structured `createTable` composer accepts.
 * Derived as the UNION of the per-engine map keys — single source of truth, so the shape
 * gate can never drift from the engine-aware DDL map. A token not in this set is a
 * `bad_request` at validation, and an assertion at compose time.
 */
const CREATE_TABLE_TYPES: ReadonlySet<string> = new Set([
  ...Object.keys(CREATE_TABLE_TYPE_DDL.postgres),
  ...Object.keys(CREATE_TABLE_TYPE_DDL.mysql),
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
 *
 * `modes` are the connection's detected SQL-parsing modes (DW-39): the single- and
 * double-quote arms consult them so the span boundaries match the REAL server session rather
 * than assuming defaults. The default {@link DEFAULT_SESSION_MODES} keeps a caller that passes
 * none byte-identical to pre-DW-39.
 */
function consumeSpan(
  sql: string,
  i: number,
  engine: DbEngine,
  prev: string | undefined,
  prev2: string | undefined,
  modes: SessionModes,
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
  // Double-quoted span: postgres IDENTIFIER (only `""` doubling). mysql `"` is a STRING with
  // backslash escapes in default mode; under ANSI_QUOTES it is an IDENTIFIER, and under
  // NO_BACKSLASH_ESCAPES the backslash is literal — either case ⇒ no backslash escaping (DW-39).
  if (ch === '"') {
    const dqBackslash = isMysql && !modes.ansiQuotes && !modes.noBackslashEscapes;
    return consumeDelimited(sql, i, '"', dqBackslash);
  }
  // Single-quoted string: backslash-active for a pg E'…' escape string, for pg plain strings
  // when standard_conforming_strings=off, and for mysql unless NO_BACKSLASH_ESCAPES is set (DW-39).
  if (ch === "'") {
    const isEString = isPg && (prev === "e" || prev === "E") && !isIdentChar(prev2);
    const sqBackslash =
      isEString ||
      (isPg && !modes.standardConformingStrings) ||
      (isMysql && !modes.noBackslashEscapes);
    return consumeDelimited(sql, i, "'", sqBackslash);
  }
  return i; // ordinary character
}

/**
 * Split `sql` into top-level statements: a `;` is a separator ONLY outside every
 * comment/string/identifier/dollar-quote/backtick span. Segments that tokenize to
 * zero top-level words (a trailing comment after a terminating `;`, whitespace) are
 * DROPPED before the count, so `SELECT 1; -- done` is ONE statement.
 *
 * `modes` are the connection's detected SQL-parsing modes (DW-39), now HONORED for the
 * string/identifier boundaries instead of assumed — so the split matches the real server
 * session. Defaulting to {@link DEFAULT_SESSION_MODES} keeps a two-arg call byte-identical to
 * pre-DW-39.
 */
export function splitStatements(
  sql: string,
  engine: DbEngine,
  modes: SessionModes = DEFAULT_SESSION_MODES,
): string[] {
  const segments: string[] = [];
  const n = sql.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const prev = i > 0 ? sql[i - 1] : undefined;
    const prev2 = i > 1 ? sql[i - 2] : undefined;
    const end = consumeSpan(sql, i, engine, prev, prev2, modes);
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
 * check cannot see, WITHOUT being fooled by an `INTO` that lives inside a string. `modes`
 * (DW-39) are honored so string/identifier boundaries match the real session; defaulting to
 * {@link DEFAULT_SESSION_MODES} keeps a two-arg call byte-identical to pre-DW-39.
 */
export function topLevelWords(
  sql: string,
  engine: DbEngine,
  modes: SessionModes = DEFAULT_SESSION_MODES,
): string[] {
  const words: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const prev = i > 0 ? sql[i - 1] : undefined;
    const prev2 = i > 1 ? sql[i - 2] : undefined;
    const end = consumeSpan(sql, i, engine, prev, prev2, modes);
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
  const truncated = result.rows.length > MAX_RESULT_ROWS;
  const capped = truncated ? result.rows.slice(0, MAX_RESULT_ROWS) : result.rows;
  // The full DESCRIPTORS go through, not just the names: the adapters derive each
  // column's canonical SQL `dataType` from the wire protocol's type metadata, and the
  // mapper needs it to classify wide integers and tz-less temporals (DW-30/34/35/40).
  const data = rowsToFrozenData(result.columns, capped);
  return { status: "rows", data, truncated };
}

/**
 * Bound the FETCH — not just the display slice — of an auto-classified raw SELECT read
 * by appending a Core-computed `LIMIT` before the statement reaches `runReadOnly` (DW-36).
 * Without this the driver (postgres.js / mysql2) buffers EVERY row into Core memory and
 * only afterwards does `toRowsResult` slice to {@link MAX_RESULT_ROWS}, so a
 * `SELECT * FROM huge_table` OOMs the Core process before the cap ever applies — the cap
 * bounds the response payload, not the fetch.
 *
 * The bound is `MAX_RESULT_ROWS + 1`: the `+ 1` is the exact sentinel `toRowsResult` already
 * reads to set `truncated`, so a bounded fetch of MAX+1 detects "there were more rows" the
 * same way an unbounded fetch did — `toRowsResult` needs NO change.
 *
 * The bound is appended ONLY for a `SELECT` whose top-level words contain NONE of
 * {@link NO_FETCH_BOUND_WORDS} — the conservative "provably safe to append `LIMIT`" set.
 * When any appears the statement is returned verbatim and only the Core-side cap applies
 * (byte-identical to today — safe, never a syntax error). The reasons, per word:
 *  - `LIMIT` / `FETCH` — the statement already carries a row-count clause (`LIMIT n`,
 *    SQL-standard `FETCH FIRST n ROWS ONLY`); appending a second is a syntax error, and a
 *    user-supplied bound is left as the user's own choice.
 *  - `UPDATE` / `SHARE` / `LOCK` — a row-locking tail (`FOR UPDATE`, `FOR SHARE`,
 *    `FOR NO KEY UPDATE`, `FOR KEY SHARE`, MySQL `LOCK IN SHARE MODE`) must FOLLOW `LIMIT`;
 *    appending `LIMIT` after it is a syntax error on both engines.
 * A `SHOW` (verb !== `SELECT`) is likewise passed verbatim — it returns small fixed
 * metadata and does not reliably accept a trailing `LIMIT`.
 *
 * KNOWN LIMITATIONS (the fetch stays unbounded — no worse than before this change, i.e.
 * NOT a regression, just not covered): `words` is the flat `topLevelWords` output, which
 * does NOT track parenthesis depth, so a `LIMIT`/`FETCH` inside a subquery or one arm of a
 * `UNION` suppresses the outer bound (`(SELECT … LIMIT 5) UNION SELECT * FROM huge` is left
 * unbounded); Postgres `LIMIT ALL` counts as a `LIMIT` yet means "no limit"; and an explicit
 * large `LIMIT 500000` is honored as the user's bound. These exotic shapes fall back to the
 * Core-side cap; the common `SELECT * FROM huge_table` (the OOM vector DW-36 targets) is bounded.
 *
 * The bound is a Core integer literal (never a value spliced from user text — same precedent
 * as `table-rows.ts`), and the leading newline defeats a trailing `-- …` line comment that
 * would otherwise swallow the appended clause.
 */
export function boundRawRead(stmt: string, verb: string | undefined, words: readonly string[]): string {
  if (verb !== "SELECT" || words.some((w) => NO_FETCH_BOUND_WORDS.has(w))) return stmt;
  return `${stmt}\nLIMIT ${MAX_RESULT_ROWS + 1}`;
}

/**
 * Top-level words whose presence makes appending a trailing `LIMIT` either a syntax error
 * or redundant, so {@link boundRawRead} leaves the statement verbatim: an existing row-count
 * clause (`LIMIT`, `FETCH FIRST … ROWS`) and a row-locking tail (`FOR UPDATE`/`FOR SHARE`/
 * MySQL `LOCK IN SHARE MODE`) that must itself follow `LIMIT`. Matching a rare unquoted
 * identifier here only over-suppresses (falls back to the Core cap) — never breaks a query.
 */
const NO_FETCH_BOUND_WORDS: ReadonlySet<string> = new Set([
  "LIMIT",
  "FETCH",
  "UPDATE",
  "SHARE",
  "LOCK",
]);

/**
 * Build the guarded executor over the injected seams. `execute` returns an ALREADY-
 * formed {@link RpcReply}: a protocol violation is a `bad_request` envelope; a domain
 * outcome (rows / ok / confirmation_required) rides inside `okReply`. A seam throw
 * (engine/connection failure) propagates → `internal_error` at dispatch.
 */
export function createExecutor(deps: ExecutorDeps): Executor {
  const { resolveConnection } = deps;

  const bad = (message: string): RpcReply<ExecuteResult> => errorReply("bad_request", message);

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

  /**
   * The PK placeholder of an `update`/`delete` WHERE clause — the ONE spot where a
   * wide-integer address can still go wrong after DW-40's string binding (see
   * `StructuredPk.exactNumeric` in the contract).
   *
   * mysql2 escapes a JS string parameter into a QUOTED SQL literal, and MySQL compares
   * an integer column against a string operand as a FLOATING-POINT number — the manual's
   * own example, `SELECT '18015376320243458' = 18015376320243459`, evaluates to `1`. So
   * on a `BIGINT` PK holding both `9007199254740992` and `9007199254740993`, the bare
   * `WHERE id=?` bound with the exact digit string float-matches BOTH rows, and neither
   * the composed UPDATE nor the DELETE carries a `LIMIT 1`. Wrapping the placeholder in
   * `CAST(? AS DECIMAL(65,<scale>))` forces MySQL's EXACT decimal comparison path instead.
   *
   * `scale` is `null` for "no cast at all", else the number of FRACTIONAL digits in the
   * validated PK literal (see {@link resolvePkCastScale}) — never client-supplied text.
   * The precision stays at MySQL's maximum of 65 TOTAL digits, of which `65 - scale` are
   * integral. A fixed `DECIMAL(65,30)` therefore held only 35 integral digits, which a
   * legal `DECIMAL(40,0)` PK overflows: the cast CLAMPS the value, the WHERE matches
   * nothing, `affectedRows` is 0 and the executor still reports `status:"ok"` — a delete
   * that "succeeded" and changed nothing. Deriving the scale from the literal gives an
   * integer PK the full 65 integral digits (MySQL's own ceiling, so nothing storable can
   * overflow) while a fractional PK keeps its fraction exactly.
   *
   * Postgres deliberately keeps its bare `$n`: postgres.js sends the parameter UNTYPED
   * and the server parses the literal directly into the column's own type, which is
   * already exact. The cast is therefore engine-gated, never unconditional — do not
   * "simplify" it into an always-on wrapper.
   */
  function pkPlaceholder(engine: DbEngine, index: number, scale: number | null): string {
    const ph = placeholder(engine, index);
    return engine === "mysql" && scale !== null ? `CAST(${ph} AS DECIMAL(65,${scale}))` : ph;
  }

  /* ---- Path (b): raw SQL ------------------------------------------------ */

  async function executeRaw(seams: ConnectionSeams, sql: string, confirmed: boolean): Promise<RpcReply<ExecuteResult>> {
    const { runQuery, runReadOnly, getEngine, getSessionModes } = seams;
    const engine = await getEngine();
    // DW-39: detected SQL-parsing modes, threaded into the splitter so the split matches the
    // real server session (a `;` smuggled after a `\'` under scs=off / default mysql is hidden
    // inside the string exactly as the server would see it) rather than an assumed default.
    //
    // These modes are captured ONCE at connect and never re-probed (mirroring `getEngine`'s memo).
    // Unlike the engine, the session GUCs ARE mutable: a confirmed `SET standard_conforming_strings`
    // / `SET sql_mode = …NO_BACKSLASH_ESCAPES…` mid-session moves the server from backslash-active
    // to backslash-literal, leaving these cached modes stale on the ACTIVE side — under which the
    // splitter could UNDER-count a subsequent statement. We deliberately do NOT re-probe here (or
    // sniff the confirmed statement for a `SET`): DW-45 keeps a confirmed statement OPAQUE, and the
    // load-bearing guarantee for that window is the ALWAYS-ON driver backstop — postgres
    // `{ simple: false }` (extended protocol, one command) and mysql `multipleStatements: false`,
    // both unconditional — which rejects the smuggled second command at the server regardless of
    // the splitter. So a mid-session mode flip degrades to an over-reject at worst, never a smuggle.
    const modes = await getSessionModes();
    const statements = splitStatements(sql, engine, modes);
    if (statements.length === 0) {
      return bad("empty statement");
    }
    if (statements.length > 1) {
      return bad("multiple statements are not allowed");
    }
    const stmt = statements[0]!.trim();
    const words = topLevelWords(stmt, engine, modes);
    const verb = words[0];

    // A leading SELECT/SHOW is a READ — UNLESS it carries a top-level `INTO`
    // (`SELECT … INTO` CTAS / mysql `INTO OUTFILE`), which is default-denied because a
    // read-only transaction does not block a filesystem write.
    const isRead = (verb === "SELECT" || verb === "SHOW") && !words.includes("INTO");
    if (isRead) {
      // Auto-run inside an engine READ-ONLY transaction (rolled back): a hidden write
      // (volatile/writing function) then fails at the engine, never commits.
      const result = await runReadOnly(boundRawRead(stmt, verb, words), []);
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
    // DW-45: a confirmed raw statement is OPAQUE text — this file classifies it
    // default-deny precisely because it refuses to guess what the statement does, so
    // sniffing for a `CREATE`/`DROP`/`ALTER` verb here to decide whether the catalog
    // changed would re-introduce exactly that guessing. Invalidate unconditionally on
    // the mutating branch: under-invalidating re-serves a stale schema to the tree and
    // the AI (the DW-45 bug), while over-invalidating costs ONE extra `listSchema` — five
    // introspection queries on Postgres — charged to the next reader that actually needs
    // the catalog, and only once no matter how many statements busted it in between
    // (`getEngine` deliberately does not honor the stale flag, so consecutive statements
    // do not each pay a refresh).
    // Only AFTER a successful run (a throw skips it), and only on the seams we just
    // mutated — no other target's memo is touched.
    seams.invalidateSchema();
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

    // Validate the untrusted `exactNumeric` hint against the RESOLVED table's own
    // introspected PK column before it can change composition (see `resolvePkCastScale`).
    const cast = resolvePkCastScale(target.table, pk);
    if ("error" in cast) return bad(cast.error);

    const engine = await getEngine();
    const setSql = set.values.map((c, idx) => `${quoteIdent(c.column)}=${placeholder(engine, idx + 1)}`);
    // The PK placeholder — CAST on MySQL when the address is verified exact-numeric, bare
    // `$n` on Postgres (see `pkPlaceholder`). The SET placeholders keep the plain form: an
    // assignment does not go through the integer-vs-string comparison rule.
    const wherePh = pkPlaceholder(engine, set.values.length + 1, cast.scale);
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

    // Same schema-verified, engine-gated exact-numeric PK cast as the UPDATE path — a
    // DELETE that float-matches a neighbouring wide-integer row (or, with an unvalidated
    // hint on a TEXT PK, every row that coerces to 0) is the worse of the two failures.
    const cast = resolvePkCastScale(target.table, pk);
    if ("error" in cast) return bad(cast.error);

    const engine = await getEngine();
    const sql = `DELETE FROM ${qualified(quoteIdent, target.table.schema, target.table.name)} WHERE ${quoteIdent(pk.column)}=${pkPlaceholder(engine, 1, cast.scale)}`;
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
    // Compose the column fragments engine-aware: the shape gate above (union allowlist)
    // proves the token is canonical, but a token can be shape-valid yet unsupported on THIS
    // engine (e.g. UUID on MySQL). We build defs imperatively so such a token can short-
    // circuit with a contract-level `bad_request` BEFORE any DDL runs — never an opaque
    // engine `internal_error`.
    const defs: string[] = [];
    for (const d of columns.defs) {
      const type = d.type.trim().toUpperCase();
      // Invariant (never a raw-text fallback): validation already rejected an
      // out-of-allowlist type, so reaching compose with one is a bug, not user input.
      if (!CREATE_TABLE_TYPES.has(type)) {
        throw new Error(`invariant violation: unvalidated createTable type '${type}'`);
      }
      const ddl = CREATE_TABLE_TYPE_DDL[engine][type];
      // Shape-valid but no representation on this engine (UUID on MySQL): reject with an
      // honest bad_request naming column/token/engine, before runQuery — not an engine error.
      if (ddl === undefined) {
        return bad(`column '${d.name}' type '${type}' is not supported on ${engine}`);
      }
      defs.push(`${quoteIdent(d.name)} ${ddl}${d.notNull ? " NOT NULL" : ""}`);
    }
    if (pkCols.length > 0) {
      defs.push(`PRIMARY KEY (${pkCols.map((c) => quoteIdent(c)).join(", ")})`);
    }
    const sql = `CREATE TABLE ${qualified(quoteIdent, table.schema, table.table)} (${defs.join(", ")})`;
    const result = await runQuery(sql, []);
    // DW-45: the ONLY structured op that changes the catalog — the new table must appear
    // in the next `getSchema` for this target instead of the memo taken at first connect.
    // `insert`/`update`/`delete` change rows only, so they deliberately do NOT invalidate.
    seams.invalidateSchema();
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

    // The driver-seam-executing region: a `NoConnectionTargetError` (no connection
    // configured at all) is translated into a neutral `bad_request` "no active
    // connection" reply — NOT the generic `internal_error`. Any OTHER seam throw
    // (a genuine engine/driver bug) is re-thrown so `dispatch`'s catch-all still
    // wraps it as `internal_error`.
    try {
      if (req.shape === "raw") {
        if (typeof req.sql !== "string") {
          return bad("raw execute requires a string 'sql'");
        }
        const resolved = resolveConnection(connectionId);
        if (!resolved.ok) return targetError(resolved.reason);
        return await executeRaw(resolved.seams, req.sql, confirmed);
      }
      if (req.shape === "structured") {
        if (typeof req.op !== "object" || req.op === null || Array.isArray(req.op)) {
          return bad("structured execute requires an 'op' object");
        }
        const resolved = resolveConnection(connectionId);
        if (!resolved.ok) return targetError(resolved.reason);
        return await executeStructured(resolved.seams, req.op as Record<string, unknown>, confirmed);
      }
      return bad("execute 'shape' must be 'raw' or 'structured'");
    } catch (err) {
      if (err instanceof NoConnectionTargetError) return bad("no active connection");
      throw err; // genuine driver bug → dispatch → internal_error (unchanged)
    }
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

/**
 * A well-formed exact numeric LITERAL, with an optional sign and an optional fractional
 * part: `42`, `-7`, `+0.5`, `.5`. No exponent, no whitespace, no separators, no
 * `Infinity`/`NaN` — the same shape the mutation builder's client-side gate admits, and
 * the only shape whose fractional-digit count can be read off the characters.
 */
const PK_EXACT_NUMERIC_LITERAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** MySQL's `DECIMAL` maxima: 65 total digits, of which at most 30 may be fractional. */
const MYSQL_DECIMAL_MAX_SCALE = 30;

/**
 * Decide how an `update`/`delete` PK placeholder must be composed — the SERVER-SIDE
 * validation of the client's `exactNumeric` hint (see `StructuredPk.exactNumeric`).
 *
 * `pk.exactNumeric` arrives on an RPC payload and is therefore UNTRUSTED, yet it changes
 * SQL COMPOSITION. Taken at face value, a frame setting it `true` on a TEXT primary key
 * composes `WHERE name=CAST(? AS DECIMAL(65,30))`; MySQL then coerces the VARCHAR column
 * to a number as well, EVERY non-numeric row evaluates to `0`, and a single-row
 * UPDATE/DELETE silently hits MANY rows. The flag is consequently honored only when the
 * server's own introspected schema agrees, which it can check right here because
 * `resolveSinglePkTable` has already resolved the real table and its `SchemaColumnInfo`
 * carries `dataType`:
 *
 *  (a) the RESOLVED PK column's own `dataType` must be exact-numeric. If it is not, the
 *      hint is IGNORED ENTIRELY and the plain placeholder is emitted — today's safe
 *      behavior, and a lie in the payload costs the caller nothing but the cast.
 *  (b) `String(pk.value)` must be a well-formed numeric literal. If (a) holds but (b)
 *      fails, we cannot compose a comparison we can promise is exact (and the scale is
 *      unreadable), so this is a `bad_request` rather than a quiet fallback to a
 *      float-compared placeholder.
 *
 * Returns the CAST's scale — the literal's fractional-digit count, clamped to MySQL's
 * 0..30 — or `null` for "no cast". The scale is a small integer computed HERE from a
 * regex-validated literal; no client text is ever interpolated into SQL.
 */
function resolvePkCastScale(
  table: SchemaTableInfo,
  pk: { column: string; value: unknown; exactNumeric: boolean },
): { scale: number | null } | { error: string } {
  if (!pk.exactNumeric) return { scale: null };
  const col = table.columns.find((c) => c.name === pk.column);
  if (col === undefined || !isExactNumericType(col.dataType)) return { scale: null };
  const literal = String(pk.value);
  if (!PK_EXACT_NUMERIC_LITERAL_RE.test(literal)) {
    return {
      error: `pk value for '${pk.column}' is not a well-formed exact-numeric literal — refusing to compose an inexact comparison`,
    };
  }
  const dot = literal.indexOf(".");
  const fractionDigits = dot < 0 ? 0 : literal.length - dot - 1;
  return { scale: Math.min(fractionDigits, MYSQL_DECIMAL_MAX_SCALE) };
}

/**
 * Read a structured `pk` — one non-empty `column` + a PRESENT `value` key, plus the
 * OPTIONAL `exactNumeric` hint (DW-40). The hint is accepted only as a real boolean
 * `true`; anything else (absent, `"true"`, `1`) degrades to `false`. It is a HINT and
 * nothing more: {@link resolvePkCastScale} re-derives the truth from the introspected
 * schema before it can influence composition.
 */
function readPk(
  raw: unknown,
): { column: string; value: unknown; exactNumeric: boolean } | { error: string } {
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
  return { column: rec.column, value: rec.value, exactNumeric: rec.exactNumeric === true };
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
