/**
 * quick-studio Core — MySQL driver adapter (mysql2/promise).
 *
 * The `mysql`-scheme implementation of the uniform {@link Driver}. It keeps every
 * MySQL specific — the `mysql2` connection, the `information_schema` introspection
 * SQL scoped to the URL's database, and the error-code → neutral mapping — behind
 * the interface. `connect` opens a real connection (mysql2 connects eagerly, so
 * auth/host/network surface here as a neutral {@link DriverConnectionError});
 * `listSchema` introspects into the neutral shape; `close` ends the connection.
 * Credentials in the URL are never logged or echoed.
 */

import mysql from "mysql2/promise";
import type { Connection, ConnectionOptions } from "mysql2/promise";
import type { DatabaseSchema, SchemaRelationKind } from "../shared/contract.ts";
import {
  DriverConnectionError,
  INTROSPECTION_TIMEOUT_MS,
  SAFE_FALLBACK_SESSION_MODES,
  assembleSchema,
  mysqlSessionModes,
  toDriverConnectionError,
  withTimeout,
  type Driver,
  type DriverColumn,
  type DriverQueryResult,
  type IntrospectedColumn,
  type IntrospectedForeignKey,
  type IntrospectedIndex,
  type IntrospectedPrimaryKey,
  type SessionModes,
} from "./driver.ts";

/**
 * One row of the MySQL `information_schema.columns` introspection query.
 * `table_type` is the owning relation's `information_schema.tables.table_type` carried in
 * by the DW-33 correlated scalar subquery — `null` when no `tables` row matched, which
 * maps to "kind unknown".
 */
type MysqlColumnRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly table_type: string | null;
};

/** One row of the MySQL primary-key introspection query. */
type MysqlPkRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string;
};

/** One (index, column) row of the MySQL index introspection query (statistics). */
type MysqlIndexRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly index_name: string;
  /** `information_schema.statistics.NON_UNIQUE`: 0 for a unique index, 1 otherwise. */
  readonly non_unique: number;
  readonly column_name: string;
};

/** One (constraint, column) row of the MySQL FK introspection query, pre-ordered by key position. */
type MysqlFkRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly constraint_name: string;
  readonly column_name: string;
  readonly referenced_table_schema: string;
  readonly referenced_table_name: string;
  readonly referenced_column_name: string;
};

/**
 * Bound on graceful teardown (ms). Mirrors the postgres adapter's
 * `sql.end({ timeout: 5 })`: if `conn.end()`'s COM_QUIT does not flush in time
 * (a wedged/half-dead socket), the connection is force-destroyed so shutdown is
 * never blocked past `stop()`.
 */
const CLOSE_TIMEOUT_MS = 5000;

/** MySQL server-side schemas that are never part of the user's database. */
const SYSTEM_SCHEMAS: readonly string[] = [
  "information_schema",
  "performance_schema",
  "mysql",
  "sys",
];

/**
 * A per-driver async mutex: `run(fn)` runs `fn` only after every previously enqueued
 * task has settled, so callers are serialized in FIFO order. Used to ISOLATE the
 * read-only transaction on the single shared mysql connection — without it, two
 * concurrent `execute` RPCs could interleave as `A:START, B:START, A:stmt, …` and,
 * because mysql `START TRANSACTION` implicitly commits the in-flight transaction, B's
 * START would drop A's READ-ONLY scope and A's statement could then commit a write.
 * Exported so the serialization guarantee is unit-testable without a live mysql.
 */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the tail regardless of the previous task's outcome (success or
    // failure), so one rejected task can never wedge the queue for the next.
    const result = tail.then(fn, fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/**
 * mysql2 wire-protocol field-type CODE → the canonical lowercase SQL type name
 * (DW-30/34). The ad-hoc SQL path has no `information_schema` to lean on, but every
 * `FieldPacket` already carries the numeric column type — this map turns it into
 * EXACTLY the spelling `information_schema.columns.data_type` yields for the browse
 * path, so both read paths classify identically.
 *
 * Written out as a LOCAL literal on purpose: `mysql.Types` is an untyped runtime getter
 * that `mysql2/promise.d.ts` does not declare, and it maps a code to the PROTOCOL enum
 * name (`LONGLONG`, `NEWDECIMAL`) rather than to a SQL type name — the wrong vocabulary
 * on top of the wrong typing. Codes verified against `mysql2/lib/constants/types.js`.
 *
 * Two deliberate calls: `TINY` maps to `tinyint` and is NEVER special-cased to boolean
 * (the protocol cannot distinguish `TINYINT(1)` from `TINYINT(4)` here, and guessing
 * would mislabel real small integers); and `TIMESTAMP` maps to the bare `timestamp`
 * while `DATETIME` maps to `datetime`, because MySQL session-tz-converts the former and
 * stores the latter as a bare wall clock — the classifier already treats a bare
 * `timestamp` as tz-AWARE and `datetime` as naive, so the two land in the right buckets
 * with no invented spelling. `timestamp` is exactly what MySQL's own
 * `information_schema.columns.data_type` returns for the column, so the promise above —
 * both read paths emit the SAME name for the same logical column — holds literally;
 * `timestamp with time zone` is a name MySQL does not have anywhere.
 * Anything absent (string/blob/bit/geometry/enum/set/year) stays unmapped.
 */
const MYSQL_TYPE_CODE_TO_DATA_TYPE: ReadonlyMap<number, string> = new Map([
  [0, "decimal"], // DECIMAL
  [246, "decimal"], // NEWDECIMAL
  [8, "bigint"], // LONGLONG
  [1, "tinyint"], // TINY
  [2, "smallint"], // SHORT
  [9, "mediumint"], // INT24
  [3, "int"], // LONG — `information_schema` spells this `int`, never `integer`
  [4, "float"], // FLOAT
  [5, "double"], // DOUBLE
  [12, "datetime"], // DATETIME
  [7, "timestamp"], // TIMESTAMP — the browse path's `information_schema` spelling; AWARE
  [10, "date"], // DATE
  [11, "time"], // TIME
]);

/**
 * Map mysql2's `FieldPacket[]` onto neutral {@link DriverColumn}s (DW-30/34). Each packet
 * carries the wire-protocol type CODE, which becomes the same canonical name the browse
 * path's `information_schema` introspection yields. The `dataType` key is OMITTED when the
 * code is absent or unmapped, so a field with no usable type metadata keeps the
 * byte-identical `{name}` shape this adapter has always produced. Pure and exported so the
 * code→name mapping is unit-testable without a live mysql (same precedent as
 * {@link buildMysqlConfig}); an absent `fields` (a non-row result) yields `[]`.
 */
export function mysqlFieldsToColumns(
  fields: ReadonlyArray<{ readonly name: string; readonly type?: number }> | undefined,
): ReadonlyArray<DriverColumn> {
  return (fields ?? []).map((f) => {
    const dataType = f.type === undefined ? undefined : MYSQL_TYPE_CODE_TO_DATA_TYPE.get(f.type);
    return dataType === undefined ? { name: f.name } : { name: f.name, dataType };
  });
}

/**
 * Run one Core-composed statement on `conn` and map it into the neutral
 * {@link DriverQueryResult}. A SELECT comes back (with `rowsAsArray`) as row arrays +
 * a `fields` descriptor; a DML statement comes back as a `ResultSetHeader` object
 * (not an array) carrying `affectedRows`. `multipleStatements` is forced OFF at
 * connect time (see {@link buildMysqlConfig}) — unconditionally, so a smuggled
 * `;`-statement is refused by the driver even if the URL asks otherwise.
 */
async function execMysql(
  conn: Connection,
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<DriverQueryResult> {
  const [result, fields] = await conn.query(
    { sql: text, rowsAsArray: true },
    params !== undefined ? [...params] : [],
  );
  if (Array.isArray(result)) {
    const columns = mysqlFieldsToColumns(
      fields as ReadonlyArray<{ name: string; type?: number }> | undefined,
    );
    return {
      columns,
      rows: result as unknown as ReadonlyArray<ReadonlyArray<unknown>>,
      rowsAffected: result.length,
    };
  }
  // Non-SELECT: `result` is a ResultSetHeader — no rows, but an affected count.
  const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
  return { columns: [], rows: [], rowsAffected: affected };
}

/**
 * Build the mysql2 connection config from `url`, forcing client-side
 * multi-statements OFF — UNCONDITIONALLY. mysql2 parses query-string params off a
 * connection URI, so a `?multipleStatements=true` in the URL would otherwise
 * silently re-enable the smuggle vector the executor's single-statement guard
 * relies on (the postgres adapter's `{ simple: false }` backstop is always-on; this
 * must be too). We cannot simply pass `multipleStatements: false` alongside `uri`:
 * mysql2's config merge only preserves a *truthy* explicit option, so a URI's
 * `true` overwrites an explicit `false`. Instead we pin the query param itself to
 * `false` in the URL — mysql2 then parses that as the definitive value — and also
 * set the flag explicitly, so multi-statements can never be enabled via the URL.
 *
 * FIVE options are pinned in total, by that same double-pin, because every invariant
 * this adapter now promises rests on them and each is URL-overridable (they all appear
 * in mysql2's `validOptions` and are parsed by `parseUrl`):
 *
 *  - `supportBigNumbers: true` + `bigNumberStrings: true` (DW-35). Without them a
 *    `BIGINT` above 2^53 decodes into a lossy JS number and is displayed — and, worse,
 *    WRITTEN BACK — rounded; with them mysql2 hands back the exact digit string,
 *    matching what postgres.js already does for `int8`. NOTE what this pin does NOT do:
 *    `DECIMAL`/`NEWDECIMAL` already come back as strings unconditionally (mysql2's
 *    `text_parser.js` never numberifies them), so the big-number pin materially affects
 *    `LONGLONG` only — `DECIMAL` precision is protected by `decimalNumbers` below.
 *  - `decimalNumbers: false`. A `?decimalNumbers=true` in the URL would turn every
 *    `DECIMAL` into a JS number and reintroduce exactly the lossy rounding DW-35 exists
 *    to close, on the one type the big-number flags do not cover.
 *  - `dateStrings: false`. The mapper's contract is that a temporal column arrives as a
 *    JS `Date` (it then renders a tz-less one as a literal wall clock, DW-34); a
 *    `?dateStrings=true` would hand it pre-formatted strings instead and silently change
 *    the shape every downstream classification is written against.
 *  - `timezone: "local"`. The wall-clock rendering reads LOCAL `Date` getters precisely
 *    because mysql2 builds a tz-less `DATETIME` in the host's local zone; a `?timezone=Z`
 *    would build it in UTC and the printed wall clock would silently shift by the host
 *    offset.
 *
 * The pin DIRECTION differs per option, which is why both halves are always written.
 * mysql2's URI merge is `if (options[key]) continue;`, i.e. only a TRUTHY explicit option
 * survives it: `supportBigNumbers`/`bigNumberStrings`/`timezone` are therefore safe as
 * explicit options and the query params merely close the reverse hole, while
 * `multipleStatements`/`decimalNumbers`/`dateStrings` are falsy and would be OVERWRITTEN
 * by the URI — for those the query param is the load-bearing half. All six keys are
 * independent, so no pin can displace another.
 *
 * Exported so the enforcement is unit-testable without a live mysql.
 */
export function buildMysqlConfig(url: string): ConnectionOptions {
  const u = new URL(url);
  u.searchParams.set("multipleStatements", "false");
  u.searchParams.set("supportBigNumbers", "true");
  u.searchParams.set("bigNumberStrings", "true");
  u.searchParams.set("decimalNumbers", "false");
  u.searchParams.set("dateStrings", "false");
  u.searchParams.set("timezone", "local");
  return {
    uri: u.toString(),
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: false,
    timezone: "local",
  };
}

/**
 * The scope predicate + bound params shared by all four introspection queries
 * (Story 10.2). Precedence (R2): a pinned `schema` WINS over the URL's own database,
 * so a connection saved with a pin introspects that schema regardless of the path
 * segment; with neither, the server's system schemas are excluded — today's behavior,
 * unchanged. A blank/whitespace pin counts as unset at the driver boundary, and a pin
 * that survives is bound TRIMMED (defensive; the registry already trims, but binding a
 * raw `"  reporting  "` would match zero tables). Every value is a `?` placeholder —
 * a schema name is never string-spliced into the SQL. Returns a FRESH array per call (mysql2 consumes
 * it positionally); each call site copies it into a mutable one at the driver
 * boundary, exactly as {@link execMysql} does. Exported pure so the precedence is
 * unit-testable without a live mysql (same precedent as {@link buildMysqlConfig}).
 */
export function mysqlSchemaScope(
  schema: string | undefined,
  database: string | null,
): { readonly where: string; readonly params: readonly string[] } {
  const pin = schema === undefined || schema.trim().length === 0 ? null : schema.trim();
  const target = pin ?? database;
  return target !== null
    ? { where: "table_schema = ?", params: [target] }
    : {
        where: `table_schema NOT IN (${SYSTEM_SCHEMAS.map(() => "?").join(", ")})`,
        params: [...SYSTEM_SCHEMAS],
      };
}

/**
 * Map a raw `information_schema.tables.table_type` to the neutral
 * {@link SchemaRelationKind} (DW-33). `BASE TABLE` is the physically stored relation,
 * `VIEW`/`SYSTEM VIEW` are virtual, and anything else the server may report (a
 * `TEMPORARY`/`SEQUENCE` row on a MySQL-compatible fork) is `"other"`; NULL/absent yields
 * `undefined` ⇒ kind unknown. Compared case-insensitively and trimmed because the value
 * is server-reported text, not an enum we control.
 *
 * MySQL has no physical row locator the planner can order by, so this kind never unlocks
 * a `ctid`-style branch there — it exists so `SchemaTableInfo.kind` is EQUALLY honest on
 * both engines rather than silently postgres-only (a consumer must never infer "kind
 * absent ⇒ mysql"). Pure and exported for the same unit-testability reason as
 * {@link mysqlSchemaScope}.
 */
export function mysqlRelationKind(tableType: string | null | undefined): SchemaRelationKind | undefined {
  if (tableType === null || tableType === undefined) return undefined;
  const t = tableType.trim().toUpperCase();
  if (t === "BASE TABLE") return "table";
  if (t === "VIEW" || t === "SYSTEM VIEW") return "view";
  return "other";
}

/** Extract the target database name from the URL path (`/db` → `db`), or `null`. */
function databaseOf(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/^\//, "");
    return path.length > 0 ? decodeURIComponent(path) : null;
  } catch {
    return null;
  }
}

/**
 * Build a MySQL {@link Driver} over `url`. mysql2 connects eagerly, so the live
 * connection is created inside `connect` (not at factory time) — that is where
 * auth/host/network errors are caught and classified.
 */
export function createMysqlDriver(url: string): Driver {
  const database = databaseOf(url);
  let connection: Connection | null = null;
  // DW-39: the connection's detected SQL-parsing modes, filled by the best-effort probe in
  // `connect()`. Initialized to the over-reject-safe fallback so an un-probed connection reads
  // backslash-literal modes (fail-closed) rather than assuming server defaults.
  let modes: SessionModes = SAFE_FALLBACK_SESSION_MODES;
  // Serializes `query`/`queryReadOnly` on the single shared connection so the
  // multi-step read-only transaction can never interleave with another query.
  const runExclusive = createMutex();

  return {
    async connect(): Promise<void> {
      try {
        // createConnection resolves only once the handshake (incl. auth) succeeds,
        // so a bad password / unknown host / refused port rejects here — classified,
        // never raw. The config forces `multipleStatements: false` (see
        // buildMysqlConfig) so the URL can never re-enable the smuggle vector.
        connection = await mysql.createConnection(buildMysqlConfig(url));
      } catch (err) {
        throw toDriverConnectionError(err);
      }
      // Best-effort SQL-mode detection (DW-39): never fails the connection — a probe error
      // degrades to the over-reject-safe fallback.
      try {
        const [rows] = await connection.query("SELECT @@session.sql_mode AS sql_mode");
        const raw = (rows as ReadonlyArray<{ readonly sql_mode?: unknown }>)[0]?.sql_mode;
        modes = mysqlSessionModes(raw);
      } catch {
        modes = SAFE_FALLBACK_SESSION_MODES;
      }
    },

    async listSchema(schema?: string): Promise<DatabaseSchema> {
      if (connection === null) {
        // Programming error, not a domain failure — surfaces as `internal_error`.
        // Kept OUTSIDE the classified wrap below so it still throws as a bug rather
        // than being reclassified to a neutral `network` failure.
        throw new Error("listSchema called before connect");
      }
      // Capture the non-null connection so the extracted `introspect` closure reads
      // it without re-narrowing (and TypeScript stays happy).
      const conn = connection;
      // The 4 introspection queries + fold, extracted so `withTimeout` can bound the
      // whole thing (DW-20) and the catch below can classify any failure (DW-19).
      const introspect = async (): Promise<DatabaseSchema> => {
      // Scope to the pinned schema, else the URL's database, else exclude the server's
      // system schemas — see {@link mysqlSchemaScope}. Parameterized so neither name
      // is ever string-spliced.
      //
      // DW-33: the owning relation's `table_type` rides along on the row this query
      // ALREADY fetches (no extra round-trip and no per-table query — an N+1 would be a
      // HALT condition).
      //
      // It is carried by a CORRELATED SCALAR SUBQUERY in the SELECT list, NOT by a join —
      // deliberately, because this is the introspection query EVERY connection depends on:
      // a bug here breaks `connect` outright, not just browse. A scalar subquery is
      // structurally incapable of changing the column row set: it can neither MULTIPLY nor
      // DROP a column row, whatever `information_schema.tables` happens to contain or
      // whichever collation it is matched under. A join's row count, by contrast, is only
      // as safe as its uniqueness argument — and with `lower_case_table_names=0` one schema
      // can legitimately hold both `Foo` and `foo`, which the case-INSENSITIVE
      // `information_schema` collation would have matched BOTH of, duplicating every column
      // row of that relation. Semantics stay LEFT-JOIN-equivalent: no matching `tables` row
      // ⇒ the scalar is NULL ⇒ kind unknown, and the columns are still returned.
      //
      // `mysqlSchemaScope`'s predicate stays spliced UNQUALIFIED and VERBATIM: with
      // `information_schema.columns c` the ONLY source in the outer FROM, a bare
      // `table_schema = ?` resolves unambiguously to `c` — so the derived table that used
      // to exist purely to dodge that ambiguity is no longer needed.
      const { where, params } = mysqlSchemaScope(schema, database);
      const [rows] = await conn.query(
        `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable,
                (SELECT t.table_type
                   FROM information_schema.tables t
                  WHERE t.table_schema = c.table_schema AND t.table_name = c.table_name
                  LIMIT 1) AS table_type
         FROM information_schema.columns c
         WHERE ${where}
         ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
        [...params],
      );

      // Primary-key columns from KEY_COLUMN_USAGE (`constraint_name = 'PRIMARY'` is
      // MySQL's fixed PK constraint name), scoped the same way as the columns query.
      // ORDERED by `ordinal_position` — the column's position WITHIN the PK constraint
      // (key order), not the table ordinal — so `assembleSchema` folds
      // `SchemaTableInfo.primaryKey` in the key's own column order: a composite PK `(b, a)`
      // stays `["b","a"]` even when `a` sits earlier in the table (DW-31).
      const { where: pkWhere, params: pkParams } = mysqlSchemaScope(schema, database);
      const [pkRows] = await conn.query(
        `SELECT table_schema, table_name, column_name
         FROM information_schema.key_column_usage
         WHERE constraint_name = 'PRIMARY' AND ${pkWhere}
         ORDER BY table_schema, table_name, ordinal_position`,
        [...pkParams],
      );
      const primaryKeys: IntrospectedPrimaryKey[] = (
        pkRows as unknown as readonly MysqlPkRow[]
      ).map((r) => ({
        schema: r.table_schema,
        table: r.table_name,
        column: r.column_name,
      }));

      // Index metadata (Story 3.5) from `information_schema.statistics`: one row per
      // (index, column), ordered by `SEQ_IN_INDEX` so the assembler folds columns in
      // INDEX order. `unique = (NON_UNIQUE = 0)`. The PK-backing index (`PRIMARY`) is
      // intentionally NOT filtered out. Same db/system-schema scoping as the columns
      // query; column names are aliased lowercase so they match the row type. A MySQL 8
      // functional key part has a NULL `column_name` (the expression lives in `EXPRESSION`);
      // `column_name IS NOT NULL` drops those parts — the analog of Postgres's `attnum > 0`
      // expression-column filter — so no null ever leaks into the folded columns list.
      const { where: idxScope, params: idxParams } = mysqlSchemaScope(schema, database);
      const idxWhere = `${idxScope} AND column_name IS NOT NULL`;
      const [idxRows] = await conn.query(
        `SELECT table_schema, table_name, index_name, non_unique, column_name
         FROM information_schema.statistics
         WHERE ${idxWhere}
         ORDER BY table_schema, table_name, index_name, seq_in_index`,
        [...idxParams],
      );
      const indexes: IntrospectedIndex[] = (idxRows as unknown as readonly MysqlIndexRow[]).map(
        (r) => ({
          schema: r.table_schema,
          table: r.table_name,
          indexName: r.index_name,
          unique: Number(r.non_unique) === 0,
          column: r.column_name,
        }),
      );

      // Foreign keys (Story 4.1): one row per (constraint, column) from
      // `key_column_usage`, filtered to FK rows by `referenced_table_name IS NOT NULL`
      // (a non-FK key column has NULLs there). `ordinal_position` orders columns WITHIN
      // the constraint, so a COMPOSITE FK's local and referenced columns stay
      // position-aligned. Same db/system-schema scoping as the columns query; column
      // names are aliased lowercase to match the row type. `assembleSchema` groups by
      // `constraint_name` within the table and drops any FK whose owning table the
      // column query never listed. MySQL FK names are not the fixed `PRIMARY`, so no
      // special-casing is needed.
      const { where: fkScope, params: fkParams } = mysqlSchemaScope(schema, database);
      const [fkRows] = await conn.query(
        `SELECT table_schema, table_name, constraint_name, column_name,
                referenced_table_schema, referenced_table_name, referenced_column_name
         FROM information_schema.key_column_usage
         WHERE referenced_table_name IS NOT NULL AND ${fkScope}
         ORDER BY table_schema, table_name, constraint_name, ordinal_position`,
        [...fkParams],
      );
      const foreignKeys: IntrospectedForeignKey[] = (fkRows as unknown as readonly MysqlFkRow[]).map(
        (r) => ({
          schema: r.table_schema,
          table: r.table_name,
          constraintName: r.constraint_name,
          column: r.column_name,
          referencedSchema: r.referenced_table_schema,
          referencedTable: r.referenced_table_name,
          referencedColumn: r.referenced_column_name,
        }),
      );

      // DW-33: `relationKind` is spread CONDITIONALLY so an unmatched `tables` row (NULL
      // `table_type`) leaves the property absent rather than explicitly `undefined` — the
      // assembler then omits `SchemaTableInfo.kind` and consumers read it as unknown.
      const columns: IntrospectedColumn[] = (rows as unknown as readonly MysqlColumnRow[]).map(
        (r) => {
          const relationKind = mysqlRelationKind(r.table_type);
          return {
            schema: r.table_schema,
            table: r.table_name,
            column: r.column_name,
            dataType: r.data_type,
            nullable: r.is_nullable === "YES",
            ...(relationKind === undefined ? {} : { relationKind }),
          };
        },
      );
      return assembleSchema("mysql", columns, indexes, foreignKeys, primaryKeys);
      };
      try {
        return await withTimeout(introspect(), INTROSPECTION_TIMEOUT_MS);
      } catch (err) {
        // DW-19: a post-handshake introspection failure (unprivileged account, a reset,
        // or the DW-20 timeout) exits CLASSIFIED so connection.ts open() returns a neutral
        // status:"failed" instead of letting a raw error escape as internal_error (500).
        throw err instanceof DriverConnectionError ? err : toDriverConnectionError(err);
      }
    },

    async query(text: string, params?: ReadonlyArray<unknown>): Promise<DriverQueryResult> {
      // Serialized behind the mutex so a concurrent read-only transaction cannot
      // interleave on the shared connection. `execMysql` maps SELECT vs DML results;
      // positional `?` binds are forwarded — mysql2's placeholder syntax never leaks.
      return runExclusive(async () => {
        if (connection === null) {
          throw new Error("query called before connect");
        }
        return execMysql(connection, text, params);
      });
    },

    async queryReadOnly(text: string, params?: ReadonlyArray<unknown>): Promise<DriverQueryResult> {
      // ISOLATED read-only transaction: the whole START/statement/ROLLBACK sequence
      // runs inside ONE exclusive mutex slot, so no other `query`/`queryReadOnly` can
      // interleave and drop the read-only scope. Any write attempt fails at the engine
      // (turning a mis-classified read into a safe failure); ROLLBACK runs in `finally`
      // so a failed rollback cannot wedge the connection mid-transaction.
      return runExclusive(async () => {
        if (connection === null) {
          throw new Error("queryReadOnly called before connect");
        }
        const conn = connection;
        await conn.query("START TRANSACTION READ ONLY");
        try {
          return await execMysql(conn, text, params);
        } finally {
          try {
            await conn.query("ROLLBACK");
          } catch {
            /* best-effort — the mutex slot ends regardless */
          }
        }
      });
    },

    sessionModes: () => modes,

    quoteIdent(ident: string): string {
      // MySQL back-tick-quotes identifiers; an embedded backtick is escaped by doubling.
      return `\`${ident.replace(/`/g, "``")}\``;
    },

    async close(): Promise<void> {
      if (connection === null) return;
      const conn = connection;
      connection = null;
      // Bounded end so a wedged socket cannot block shutdown (mirrors the
      // postgres adapter's `sql.end({ timeout: 5 })`). Swallow any teardown
      // error — shutdown must never block or throw.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          conn.end(),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              // Graceful COM_QUIT did not flush in time — force the socket down.
              try {
                conn.destroy();
              } catch {
                /* already gone */
              }
              resolve();
            }, CLOSE_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // `conn.end()` rejected — force-destroy so no socket lingers past stop().
        try {
          conn.destroy();
        } catch {
          /* already gone */
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
