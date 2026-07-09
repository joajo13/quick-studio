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
import type { Connection } from "mysql2/promise";
import type { DatabaseSchema } from "../shared/contract.ts";
import {
  assembleSchema,
  toDriverConnectionError,
  type Driver,
  type DriverQueryResult,
  type IntrospectedColumn,
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

  return {
    async connect(): Promise<void> {
      try {
        // createConnection resolves only once the handshake (incl. auth) succeeds,
        // so a bad password / unknown host / refused port rejects here — classified,
        // never raw.
        connection = await mysql.createConnection(url);
      } catch (err) {
        throw toDriverConnectionError(err);
      }
    },

    async listSchema(): Promise<DatabaseSchema> {
      if (connection === null) {
        // Programming error, not a domain failure — surfaces as `internal_error`.
        throw new Error("listSchema called before connect");
      }
      // Scope to the URL's database when present; otherwise exclude the server's
      // system schemas. Parameterized so the database name is never string-spliced.
      const where =
        database !== null
          ? "table_schema = ?"
          : `table_schema NOT IN (${SYSTEM_SCHEMAS.map(() => "?").join(", ")})`;
      const params = database !== null ? [database] : [...SYSTEM_SCHEMAS];
      const [rows] = await connection.query(
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
      const [pkRows] = await connection.query(
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
      return assembleSchema("mysql", columns);
    },

    async query(text: string, params?: ReadonlyArray<unknown>): Promise<DriverQueryResult> {
      if (connection === null) {
        throw new Error("query called before connect");
      }
      // `rowsAsArray` returns rows as position-aligned arrays; `fields` carry the
      // ordered column names. The browse SELECT passes no params (only quoted
      // identifiers + integer literals); positional `?` binds are forwarded when a
      // caller supplies them — mysql2's placeholder syntax never leaks above here.
      const [rows, fields] = await connection.query(
        { sql: text, rowsAsArray: true },
        params !== undefined ? [...params] : [],
      );
      const columns = ((fields as ReadonlyArray<{ name: string }> | undefined) ?? []).map((f) => ({
        name: f.name,
      }));
      return { columns, rows: rows as unknown as ReadonlyArray<ReadonlyArray<unknown>> };
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
