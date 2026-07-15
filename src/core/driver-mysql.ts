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
import type { DatabaseSchema } from "../shared/contract.ts";
import {
  DriverConnectionError,
  INTROSPECTION_TIMEOUT_MS,
  assembleSchema,
  toDriverConnectionError,
  withTimeout,
  type Driver,
  type DriverQueryResult,
  type IntrospectedColumn,
  type IntrospectedForeignKey,
  type IntrospectedIndex,
} from "./driver.ts";

/** One row of the MySQL `information_schema.columns` introspection query. */
type MysqlColumnRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
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

/** Set-membership key for a PK column: `schema table column`. */
function pkKey(schema: string, table: string, column: string): string {
  return `${schema} ${table} ${column}`;
}

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
    const columns = ((fields as ReadonlyArray<{ name: string }> | undefined) ?? []).map((f) => ({
      name: f.name,
    }));
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
 * Exported so the enforcement is unit-testable without a live mysql.
 */
export function buildMysqlConfig(url: string): ConnectionOptions {
  const u = new URL(url);
  u.searchParams.set("multipleStatements", "false");
  return { uri: u.toString(), multipleStatements: false };
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
    },

    async listSchema(): Promise<DatabaseSchema> {
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
      // Scope to the URL's database when present; otherwise exclude the server's
      // system schemas. Parameterized so the database name is never string-spliced.
      const where =
        database !== null
          ? "table_schema = ?"
          : `table_schema NOT IN (${SYSTEM_SCHEMAS.map(() => "?").join(", ")})`;
      const params = database !== null ? [database] : [...SYSTEM_SCHEMAS];
      const [rows] = await conn.query(
        `SELECT table_schema, table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE ${where}
         ORDER BY table_schema, table_name, ordinal_position`,
        params,
      );

      // Primary-key columns from KEY_COLUMN_USAGE (`constraint_name = 'PRIMARY'` is
      // MySQL's fixed PK constraint name), scoped the same way as the columns query.
      const pkWhere =
        database !== null
          ? "table_schema = ?"
          : `table_schema NOT IN (${SYSTEM_SCHEMAS.map(() => "?").join(", ")})`;
      const pkParams = database !== null ? [database] : [...SYSTEM_SCHEMAS];
      const [pkRows] = await conn.query(
        `SELECT table_schema, table_name, column_name
         FROM information_schema.key_column_usage
         WHERE constraint_name = 'PRIMARY' AND ${pkWhere}`,
        pkParams,
      );
      const pkSet = new Set(
        (pkRows as unknown as readonly MysqlPkRow[]).map((r) =>
          pkKey(r.table_schema, r.table_name, r.column_name),
        ),
      );

      // Index metadata (Story 3.5) from `information_schema.statistics`: one row per
      // (index, column), ordered by `SEQ_IN_INDEX` so the assembler folds columns in
      // INDEX order. `unique = (NON_UNIQUE = 0)`. The PK-backing index (`PRIMARY`) is
      // intentionally NOT filtered out. Same db/system-schema scoping as the columns
      // query; column names are aliased lowercase so they match the row type. A MySQL 8
      // functional key part has a NULL `column_name` (the expression lives in `EXPRESSION`);
      // `column_name IS NOT NULL` drops those parts — the analog of Postgres's `attnum > 0`
      // expression-column filter — so no null ever leaks into the folded columns list.
      const idxScope =
        database !== null
          ? "table_schema = ?"
          : `table_schema NOT IN (${SYSTEM_SCHEMAS.map(() => "?").join(", ")})`;
      const idxWhere = `${idxScope} AND column_name IS NOT NULL`;
      const idxParams = database !== null ? [database] : [...SYSTEM_SCHEMAS];
      const [idxRows] = await conn.query(
        `SELECT table_schema, table_name, index_name, non_unique, column_name
         FROM information_schema.statistics
         WHERE ${idxWhere}
         ORDER BY table_schema, table_name, index_name, seq_in_index`,
        idxParams,
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
      const fkScope =
        database !== null
          ? "table_schema = ?"
          : `table_schema NOT IN (${SYSTEM_SCHEMAS.map(() => "?").join(", ")})`;
      const fkParams = database !== null ? [database] : [...SYSTEM_SCHEMAS];
      const [fkRows] = await conn.query(
        `SELECT table_schema, table_name, constraint_name, column_name,
                referenced_table_schema, referenced_table_name, referenced_column_name
         FROM information_schema.key_column_usage
         WHERE referenced_table_name IS NOT NULL AND ${fkScope}
         ORDER BY table_schema, table_name, constraint_name, ordinal_position`,
        fkParams,
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

      const columns: IntrospectedColumn[] = (rows as unknown as readonly MysqlColumnRow[]).map(
        (r) => ({
          schema: r.table_schema,
          table: r.table_name,
          column: r.column_name,
          dataType: r.data_type,
          nullable: r.is_nullable === "YES",
          isPrimaryKey: pkSet.has(pkKey(r.table_schema, r.table_name, r.column_name)),
        }),
      );
      return assembleSchema("mysql", columns, indexes, foreignKeys);
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
