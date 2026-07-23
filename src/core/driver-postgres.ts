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
  type IntrospectedPrimaryKey,
} from "./driver.ts";

/** One row of the Postgres `information_schema.columns` introspection query. */
type PgColumnRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
};

/** One row of the primary-key introspection query (schema/table/column of a PK). */
type PgPkRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string;
};

/** One (index, column) row of the index introspection query, pre-ordered by index position. */
type PgIndexRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly index_name: string;
  readonly is_unique: boolean;
  readonly column_name: string;
};

/** One (constraint, column) row of the FK introspection query, pre-ordered by key position. */
type PgFkRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly constraint_name: string;
  readonly column_name: string;
  readonly referenced_schema: string;
  readonly referenced_table: string;
  readonly referenced_column: string;
};

/**
 * Whether the server exposes `pg_constraint.conparentid` (DW-42). That column — which
 * links an inherited partition constraint back to its parent — was added in PostgreSQL
 * 11 (`server_version_num >= 110000`). On PG <= 10 the column does not exist, so the FK
 * query must OMIT any reference to it entirely (a bare `con.conparentid` fails to PARSE,
 * which no runtime CASE can rescue). Exported pure so the boundary is unit-testable.
 */
export function pgSupportsConparentid(serverVersionNum: number): boolean {
  return serverVersionNum >= 110000;
}

/**
 * A postgres.js template FRAGMENT — the value `sql`…`` produces and re-accepts when
 * interpolated into an outer template. Its `strings`/`args` are the query text parts
 * and the values postgres.js will bind, which is what makes {@link pgSchemaScope}
 * assertable without a live server.
 */
type PgFragment = postgres.PendingQuery<ReadonlyArray<never>>;

/** The four scope predicates the introspection queries splice into their WHERE clauses. */
export type PgScopeFragments = {
  /** `information_schema.columns` — unqualified `table_schema`. */
  readonly colScope: PgFragment;
  /** `information_schema.table_constraints` — aliased `tc.table_schema`. */
  readonly pkScope: PgFragment;
  /** `pg_index` → `pg_namespace` — the OWNING relation's `n.nspname`. */
  readonly idxScope: PgFragment;
  /** `pg_constraint` → `pg_namespace` — the OWNING relation's `con_ns.nspname`. */
  readonly fkScope: PgFragment;
};

/**
 * Build the four introspection scope predicates for an optional pinned schema
 * (Story 10.2). Mirrors the `partitionFilter` idiom below: a conditional `sql`
 * FRAGMENT interpolated into the query text, never a concatenated string.
 *
 * The UNPINNED arms reproduce the pre-10.2 predicates VERBATIM — that is the
 * regression-critical back-compat contract, and a one-character drift (dropping the
 * `!~ '^pg_'` that hides `pg_toast`/`pg_temp_*` indexes, say) would silently change
 * every existing connection's introspection. The PINNED arms bind `${pin}` as a real
 * parameter: this is a VALUE comparison against a catalog column, so `quoteIdent` is
 * deliberately not involved. A blank/whitespace pin counts as unset at the driver
 * boundary (defensive; the registry already trims), and a pin that survives is used
 * TRIMMED — binding the raw `"  reporting  "` would match zero tables.
 *
 * Exported pure (it takes the `sql` tag rather than closing over one) so both arms are
 * unit-testable against a never-connected client, same precedent as
 * {@link pgSupportsConparentid} and driver-mysql's `mysqlSchemaScope`.
 */
export function pgSchemaScope(sql: postgres.Sql, schema: string | undefined): PgScopeFragments {
  const pin = schema === undefined || schema.trim().length === 0 ? undefined : schema.trim();
  return {
    colScope:
      pin === undefined
        ? sql`table_schema NOT IN ('pg_catalog', 'information_schema')`
        : sql`table_schema = ${pin}`,
    pkScope:
      pin === undefined
        ? sql`tc.table_schema NOT IN ('pg_catalog', 'information_schema')`
        : sql`tc.table_schema = ${pin}`,
    idxScope:
      pin === undefined
        ? sql`n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`
        : sql`n.nspname = ${pin}`,
    fkScope:
      pin === undefined
        ? sql`con_ns.nspname !~ '^pg_' AND con_ns.nspname <> 'information_schema'`
        : sql`con_ns.nspname = ${pin}`,
  };
}

/**
 * The per-column PRIVILEGE predicate for the INDEX query (Story 10.3).
 *
 * The index query reads the raw system catalogs (`pg_index`/`pg_class`/`pg_attribute`),
 * which carry NO privilege filter of their own; the columns query reads
 * `information_schema.columns`, which does. This fragment is the privilege clause of
 * that view's OWN `WHERE` — `pg_has_role(relowner, 'USAGE') OR has_column_privilege(oid,
 * attnum, 'SELECT, INSERT, UPDATE, REFERENCES')` — not an invented approximation, so a
 * (table, column) pair a restricted role may not read is never FETCHED by the index
 * query either. In-query on purpose: a post-`assembleSchema` trim would already have
 * carried the index name, uniqueness flag and out-of-grant column name across the wire.
 *
 * It mirrors the PRIVILEGE axis ONLY — not that view's full visibility predicate, which
 * also applies `NOT a.attisdropped`, `c.relkind IN ('r','v','f','p')` and
 * `NOT pg_is_other_temp_schema(...)`. Deliberate: a dropped column cannot appear in
 * `ix.indkey` at all, and a surviving non-table relkind (a matview's index, say) still
 * cannot spawn a phantom tree node, because `assembleSchema` only decorates tables the
 * COLUMNS query already produced. Widening past the privilege axis is out of scope here.
 *
 * The aliases are the ones the index query ALREADY binds — `pg_class t` (`t.oid`,
 * `t.relowner`) and `pg_attribute a` (`a.attnum`) — so this needs no extra join and
 * evaluates against exactly the (table, column) pair its row describes. It references no
 * version-gated catalog column (unlike `conparentid`/DW-42), so no server-version
 * branching. Per row it costs a syscache lookup, but `pg_has_role` short-circuits true
 * for the owner/superuser case, which is the common one.
 *
 * `sql` is passed purely as the template TAG (the fragment binds nothing) rather than
 * closed over, which is what makes the exact predicate text assertable from a
 * never-connected client — same precedent as {@link pgSchemaScope} and
 * {@link pgSupportsConparentid}.
 */
export function pgIndexColumnVisibility(sql: postgres.Sql): PgFragment {
  return sql`(pg_has_role(t.relowner, 'USAGE') OR has_column_privilege(t.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES'))`;
}

/**
 * Force the EXTENDED/parameterized protocol. postgres.js decides simple vs extended
 * by `'simple' in options ? options.simple : args.length === 0`, so with no bind
 * params it defaults to the SIMPLE protocol (which runs every `;`-command). The
 * runtime honours a `simple` option, but the shipped `.d.ts` only declares `prepare`
 * — so we build the option object and cast it. `simple: false` routes through Parse/
 * Bind/Execute, which parses exactly one command and rejects a multi-command string.
 */
const FORCE_EXTENDED = { simple: false } as unknown as { prepare?: boolean };

/**
 * postgres.js `.values()` result: an array of positional row-arrays that also carries
 * `columns` + `count`. Both are typed `| null` because postgres.js's `Result` initialises
 * them to `null` (not `undefined`) for a command with no RowDescription (DDL/DML) — see
 * `node_modules/postgres/src/result.js` — so the mapper's `?? …` fallbacks must (and do)
 * catch `null`, and the declared type stays honest about the real runtime shape.
 */
type PgUnsafeResult = ReadonlyArray<ReadonlyArray<unknown>> & {
  readonly columns?: ReadonlyArray<{ readonly name: string }> | null;
  readonly count?: number | null;
};

/**
 * Map a postgres.js VALUES-mode result into the neutral {@link DriverQueryResult}.
 *
 * The result is consumed in `.values()` (array) row-mode, so each row is already a
 * position-aligned array keyed to the ordered `result.columns` metadata rather than a
 * name-keyed object. That keeps duplicate/aliased output columns (`SELECT id, id`)
 * distinct at their positions instead of collapsing them to the last value (DW-29 /
 * DW-38) — mirroring mysql2's `rowsAsArray` positional shape. `rows` is the result
 * array itself; `rowsAffected` comes from `result.count`, falling back to `rows.length`.
 */
export function mapUnsafeResult(result: PgUnsafeResult): DriverQueryResult {
  const columns = (result.columns ?? []).map((c) => ({ name: c.name }));
  // `result` IS the positional row array (its declared base type), so no cast is needed.
  const rows: ReadonlyArray<ReadonlyArray<unknown>> = result;
  return { columns, rows, rowsAffected: result.count ?? rows.length };
}

/**
 * Run Core-composed text and map the result into the neutral {@link DriverQueryResult}.
 *
 * Rows are projected POSITIONALLY via postgres.js's `.values()` (array) row-mode: each
 * row is a position-aligned array keyed to the ordered `result.columns`, so duplicate/
 * aliased output columns (`SELECT id, id`) stay distinct instead of collapsing to the
 * last value (DW-29 / DW-38) — aligning with the MySQL adapter's `rowsAsArray`. The
 * mapping itself lives in {@link mapUnsafeResult}.
 *
 * DRIVER-BOUNDARY BACKSTOP (defense-in-depth): `sql.unsafe(text)` with no bind
 * parameters would use postgres.js's SIMPLE-query protocol, which executes ALL
 * `;`-separated commands — making the executor's splitter the ONLY guard against a
 * smuggled second statement on postgres. We pass `{ simple: false }` UNCONDITIONALLY
 * so the query always runs through the EXTENDED/parameterized protocol, which parses
 * exactly one command and rejects a multi-command string at the server ("cannot
 * insert multiple commands into a prepared statement"). This is not solely load-
 * bearing on the splitter: a smuggled `; DROP …` is refused at the driver even if the
 * splitter ever errs. (postgres.js chooses simple vs extended by
 * `'simple' in options ? options.simple : args.length === 0`, so the explicit flag is
 * required to force extended when no params are bound.)
 */
async function runUnsafe(
  sql: ReturnType<typeof postgres>,
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<DriverQueryResult> {
  const result = (await sql
    .unsafe(text, (params ?? []) as never[], FORCE_EXTENDED)
    .values()) as unknown as PgUnsafeResult;
  return mapUnsafeResult(result);
}

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

    async listSchema(schema?: string): Promise<DatabaseSchema> {
      // The 5 introspection queries (columns, PK, index, server-version probe, FK) +
      // fold, extracted so `withTimeout` can bound the whole thing (DW-20) and the catch
      // below can classify any failure (DW-19).
      const introspect = async (): Promise<DatabaseSchema> => {
      // Story 10.2 — the optional pinned scope, as four conditional `sql` FRAGMENTS
      // (see {@link pgSchemaScope}: unpinned reproduces today's predicates verbatim,
      // pinned binds the trimmed value as a real parameter). Built once, spliced into
      // the four WHERE clauses below exactly like `partitionFilter`.
      const { colScope, pkScope, idxScope, fkScope } = pgSchemaScope(sql, schema);

      // Exclude the two system schemas (or narrow to the pinned one); order by
      // schema/table/ordinal so the neutral shape mirrors the live database's own
      // column order.
      const rows = (await sql`
        SELECT table_schema, table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE ${colScope}
        ORDER BY table_schema, table_name, ordinal_position
      `) as unknown as readonly PgColumnRow[];

      // Primary-key columns, from the constraint metadata. Joined the same way
      // across all user schemas. One row per (table, PK column), ORDERED by the key's
      // OWN `kcu.ordinal_position` (the column's position WITHIN the PK constraint, not
      // the table ordinal), so `assembleSchema` folds `SchemaTableInfo.primaryKey` in
      // the key's own column order — a composite PK `(b, a)` stays `["b","a"]` even when
      // `a` sits earlier in the table (DW-31).
      const pkRows = (await sql`
        SELECT tc.table_schema, tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND ${pkScope}
        ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position
      `) as unknown as readonly PgPkRow[];
      const primaryKeys: IntrospectedPrimaryKey[] = pkRows.map((r) => ({
        schema: r.table_schema,
        table: r.table_name,
        column: r.column_name,
      }));

      // Index metadata (Story 3.5): one row per (index, column), ordered by the
      // column's position within `indkey` so the assembler folds columns in INDEX
      // order. Joins `pg_index` → the index/table `pg_class` rows, `pg_namespace`,
      // and `pg_attribute`; `indisunique` gives uniqueness. Expression-index columns
      // (`attnum = 0`) are out of scope, excluded by `a.attnum > 0`. The PK-backing
      // index (`<table>_pkey`) is intentionally NOT filtered out. This query reads the
      // system catalogs (not information_schema), so its UNPINNED scope must exclude
      // EVERY `pg_*` system schema — `n.nspname !~ '^pg_'` drops `pg_catalog`,
      // `pg_toast`, and `pg_temp_*` (a `pg_toast` toast index exists for every table
      // with a varlena column; user schemas can never start with `pg_`). Matview indexes
      // that survive this filter still can't spawn a phantom table: `assembleSchema` only
      // attaches indexes to tables already produced by the column query.
      //
      // Story 10.3 — the third conjunct. `${idxScope}` answers *which schema*;
      // `${idxVisibility}` answers *which (table, column) the role may see*, using
      // `information_schema.columns`'s own privilege clause so this query hides what the
      // columns query hides. Orthogonal, both required — rationale in
      // {@link pgIndexColumnVisibility}.
      const idxVisibility = pgIndexColumnVisibility(sql);
      const indexRows = (await sql`
        SELECT
          n.nspname AS table_schema,
          t.relname AS table_name,
          i.relname AS index_name,
          ix.indisunique AS is_unique,
          a.attname AS column_name
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE ${idxScope}
          AND a.attnum > 0
          AND ${idxVisibility}
        ORDER BY n.nspname, t.relname, i.relname,
                 array_position(string_to_array(ix.indkey::text, ' ')::int[], a.attnum::int)
      `) as unknown as readonly PgIndexRow[];

      const indexes: IntrospectedIndex[] = indexRows.map((r) => ({
        schema: r.table_schema,
        table: r.table_name,
        indexName: r.index_name,
        unique: r.is_unique === true,
        column: r.column_name,
      }));

      // Read the server version so the FK query below can decide whether the
      // `pg_constraint.conparentid` column is safe to reference (DW-42). It exists only
      // on PG 11+ (`server_version_num >= 110000`); on older servers the column must be
      // OMITTED from the SQL text entirely — a bare reference fails to parse.
      const versionRows = (await sql`
        SELECT current_setting('server_version_num')::int AS server_version_num
      `) as unknown as readonly { server_version_num: number }[];
      // Default to 0 (→ unsupported) if the single row is somehow absent, which safely
      // degrades to today's PG <= 10 behavior rather than emitting an unparseable column.
      const serverVersionNum = versionRows[0]?.server_version_num ?? 0;
      // On PG 11+ drop the inherited partition copies of an FK; on PG <= 10 the column
      // does not exist, so interpolate an EMPTY fragment (no `conparentid` in the text).
      const partitionFilter = pgSupportsConparentid(serverVersionNum)
        ? sql`AND con.conparentid = 0`
        : sql``;

      // Foreign keys (Story 4.1): one row per (constraint, column) from `pg_constraint`
      // (`contype = 'f'`). `unnest(conkey, confkey) WITH ORDINALITY` walks the local and
      // referenced attnum arrays IN LOCKSTEP so a COMPOSITE FK's local and referenced
      // columns stay position-aligned (a `key_column_usage`⋈`constraint_column_usage`
      // join would instead cross-product them and misalign composites). `ORDER BY … k.ord`
      // preserves key-column order. Same OWNING-side scope as the index query
      // (`${fkScope}`); the REFERENCED side (`ref_ns.nspname`) stays deliberately
      // unfiltered so an FK pointing OUT of the pinned schema is still reported as
      // metadata on its owning table (the ERD then drops that edge, because the
      // referenced table is not in scope and so was never materialized — only the
      // column query can materialize a table). `assembleSchema` likewise drops any FK
      // whose OWNING table the column query never listed, so no phantom table is
      // materialized from either side. On a PARTITIONED parent,
      // every partition inherits a near-identical copy of the parent's FK carrying
      // `conparentid <> 0`; `${partitionFilter}` adds `AND con.conparentid = 0` on PG 11+
      // to keep only the parent-defined constraint (one ERD edge, not one per partition),
      // and degrades to an empty fragment on PG <= 10 where the column does not exist (DW-42).
      //
      // KNOWN GAP, deliberate (Story 10.3): unlike the index query above, this one has NO
      // per-column privilege predicate — it reads `pg_constraint`/`pg_attribute` raw, so a
      // restricted role can still see FK column names outside its grants. Explicitly out of
      // 10.3's scope (its AC covers the index queries); tracked in the deferred-work ledger.
      const fkRows = (await sql`
        SELECT
          con_ns.nspname AS table_schema,
          con_rel.relname AS table_name,
          con.conname AS constraint_name,
          att.attname AS column_name,
          ref_ns.nspname AS referenced_schema,
          ref_rel.relname AS referenced_table,
          ref_att.attname AS referenced_column
        FROM pg_constraint con
        JOIN pg_class con_rel ON con_rel.oid = con.conrelid
        JOIN pg_namespace con_ns ON con_ns.oid = con_rel.relnamespace
        JOIN pg_class ref_rel ON ref_rel.oid = con.confrelid
        JOIN pg_namespace ref_ns ON ref_ns.oid = ref_rel.relnamespace
        JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord) ON true
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
        JOIN pg_attribute ref_att ON ref_att.attrelid = con.confrelid AND ref_att.attnum = k.refattnum
        WHERE con.contype = 'f' ${partitionFilter}
          AND ${fkScope}
        ORDER BY con_ns.nspname, con_rel.relname, con.conname, k.ord
      `) as unknown as readonly PgFkRow[];

      const foreignKeys: IntrospectedForeignKey[] = fkRows.map((r) => ({
        schema: r.table_schema,
        table: r.table_name,
        constraintName: r.constraint_name,
        column: r.column_name,
        referencedSchema: r.referenced_schema,
        referencedTable: r.referenced_table,
        referencedColumn: r.referenced_column,
      }));

      const columns: IntrospectedColumn[] = rows.map((r) => ({
        schema: r.table_schema,
        table: r.table_name,
        column: r.column_name,
        dataType: r.data_type,
        nullable: r.is_nullable === "YES",
      }));
      return assembleSchema("postgres", columns, indexes, foreignKeys, primaryKeys);
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
      return runUnsafe(sql, text, params);
    },

    async queryReadOnly(text: string, params?: ReadonlyArray<unknown>): Promise<DriverQueryResult> {
      // Reserve the (single) connection so the BEGIN/statement/ROLLBACK sequence is
      // ISOLATED — no concurrent query can interleave and drop the read-only scope
      // (mirrors the postgres discipline the spec calls out). Everything runs on the
      // reserved handle, and the connection is released in `finally` so a failed
      // rollback can never wedge it mid-transaction.
      const reserved = await sql.reserve();
      try {
        // `BEGIN READ ONLY` opens a transaction in which any write (INTO/CTAS, a
        // volatile/writing function, DDL) fails at the engine — turning a
        // mis-classified read into a safe failure instead of a committed mutation.
        await reserved.unsafe("begin read only", [], FORCE_EXTENDED);
        return await runUnsafe(reserved, text, params);
      } finally {
        try {
          await reserved.unsafe("rollback", [], FORCE_EXTENDED);
        } catch {
          /* best-effort: the reserved connection is released regardless */
        }
        reserved.release();
      }
    },

    quoteIdent(ident: string): string {
      // Postgres double-quotes identifiers; an embedded `"` is escaped by doubling.
      return `"${ident.replace(/"/g, '""')}"`;
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
