/**
 * quick-studio Core — PostgreSQL driver adapter (postgres.js).
 *
 * The `postgres`-scheme implementation of the uniform {@link Driver}. It keeps
 * every Postgres specific — the `postgres.js` client, the liveness probe, the
 * `information_schema` introspection SQL, and the SQLSTATE → neutral error
 * mapping — behind the interface. `connect` opens a single-connection client and
 * verifies liveness (surfacing auth/host/network as a neutral
 * {@link DriverConnectionError}); `listSchema` introspects into the neutral shape;
 * `close` ends the client. Credentials in the URL are never logged or echoed.
 */

import postgres from "postgres";
import type { DatabaseSchema } from "../shared/contract.ts";
import {
  assembleSchema,
  toDriverConnectionError,
  type Driver,
  type IntrospectedColumn,
} from "./driver.ts";

/** One row of the Postgres `information_schema.columns` introspection query. */
type PgColumnRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
};

/**
 * Build a PostgreSQL {@link Driver} over `url`. The client is created lazily
 * (postgres.js does not connect until the first query), single-connection
 * (`max: 1`) since this story only introspects, with a bounded connect timeout so
 * an unreachable host fails fast as `network` rather than hanging.
 */
export function createPostgresDriver(url: string): Driver {
  // `onnotice` is silenced so server NOTICE chatter never reaches stderr and can
  // never carry a fragment of the connection into a log line.
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });

  return {
    async connect(): Promise<void> {
      try {
        // Force an actual connection + round-trip so auth/host/network errors
        // surface here (postgres.js is otherwise lazy) — classified, never raw.
        await sql`select 1`;
      } catch (err) {
        throw toDriverConnectionError(err);
      }
    },

    async listSchema(): Promise<DatabaseSchema> {
      // Exclude the two system schemas; order by schema/table/ordinal so the
      // neutral shape mirrors the live database's own column order.
      const rows = (await sql`
        SELECT table_schema, table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name, ordinal_position
      `) as unknown as readonly PgColumnRow[];

      const columns: IntrospectedColumn[] = rows.map((r) => ({
        schema: r.table_schema,
        table: r.table_name,
        column: r.column_name,
        dataType: r.data_type,
        nullable: r.is_nullable === "YES",
      }));
      return assembleSchema("postgres", columns);
    },

    async close(): Promise<void> {
      // Bounded end so a wedged socket cannot block shutdown; swallow any error
      // (we are tearing down regardless — see the connection manager / lifecycle).
      try {
        await sql.end({ timeout: 5 });
      } catch {
        /* best-effort teardown */
      }
    },
  };
}
