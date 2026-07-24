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
import type { DatabaseSchema, SchemaRelationKind } from "../shared/contract.ts";
import {
  DriverConnectionError,
  INTROSPECTION_TIMEOUT_MS,
  SAFE_FALLBACK_SESSION_MODES,
  assembleSchema,
  postgresSessionModes,
  toDriverConnectionError,
  withTimeout,
  type Driver,
  type DriverQueryResult,
  type IntrospectedColumn,
  type IntrospectedForeignKey,
  type IntrospectedIndex,
  type IntrospectedPrimaryKey,
  type SessionModes,
} from "./driver.ts";

/**
 * One row of the Postgres `information_schema.columns` introspection query.
 *
 * `relkind`/`relhassubclass` are the owning relation's `pg_class` facts, carried in by the
 * DW-33 correlated scalar subqueries. Both are `null` when NO catalog row matched.
 *
 * That NULL arm is a DEFENSIVE fallback, not an expected visibility mechanism:
 * `pg_class`/`pg_namespace` are world-readable (every role has SELECT on them, and they
 * carry no row-level security), so in practice every `information_schema.columns` row HAS
 * a matching catalog row. The arm exists only so an unmatched relation still yields its
 * columns with kind UNKNOWN rather than disappearing from the schema — never because a
 * role is expected to be denied the catalog lookup.
 */
type PgColumnRow = {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly relkind: string | null;
  readonly relhassubclass: boolean | null;
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
 * Map a raw `pg_class.relkind` char (+ its `relhassubclass` flag) to the neutral
 * {@link SchemaRelationKind} (DW-33).
 *
 * Only a relation whose `ctid` is UNIQUE ACROSS ITS OWN SCAN is reported as `"table"` —
 * that, not "has storage", is the fact the browse planner's physical-row-locator branch
 * actually needs, because it orders a whole page by `ctid`.
 *
 * - `r` with `relhassubclass = false` — an ordinary table: one heap, `ctid` total. `"table"`.
 * - `r` with `relhassubclass = true` — a LEGACY INHERITANCE PARENT. `SELECT … FROM parent`
 *   implicitly scans every CHILD heap too, and each child numbers its own tuples, so the
 *   same `(block, offset)` pair recurs across children: `ctid` is NOT unique over the
 *   result and `ORDER BY ctid` is NOT a total order — pages could duplicate or skip rows,
 *   the exact defect DW-33 exists to remove. `"other"`, so it falls through to columns.
 * - `m` — a materialized view. Kept as `"table"` for forward-compatibility ONLY: it does
 *   have a real heap and a usable `ctid`, but this branch is currently UNREACHABLE through
 *   `information_schema.columns`, whose own definition restricts it to
 *   `relkind IN ('r','v','f','p')` — a matview never appears in this query's rows and is
 *   therefore NOT browsable today. The mapping exists so a future catalog-based column
 *   introspection stays correct without re-deriving the taxonomy.
 * - `v` — a plain view: no storage, no `ctid`. `"view"`. Views ARE introspected and
 *   browsable here (`information_schema.columns` carries no `table_type` filter), so
 *   mis-labelling one would turn every view browse into a hard engine error.
 * - everything else — a partitioned parent (`p`) and a foreign table (`f`) in particular,
 *   which look table-like but expose no `ctid` of their own — is `"other"`.
 * - a NULL `relkind` (no `pg_class` row matched) yields `undefined` ⇒ kind unknown ⇒ the
 *   conservative arm.
 *
 * `hasSubclass` is optional so the `relkind`-only taxonomy stays callable; absent/NULL is
 * read as "no children", the same conservative default the catalog reports for a table
 * that never had any.
 *
 * Pure and exported so the relkind taxonomy is unit-testable without a live server —
 * same precedent as {@link pgSupportsConparentid} and {@link pgSchemaScope}.
 */
export function pgRelationKind(
  relkind: string | null | undefined,
  hasSubclass?: boolean | null,
): SchemaRelationKind | undefined {
  if (relkind === null || relkind === undefined) return undefined;
  // Checked BEFORE the `r` → "table" arm: an inheritance parent's scan spans child heaps,
  // so its `ctid` is non-unique and must never unlock the locator branch.
  if (relkind === "r" && hasSubclass === true) return "other";
  if (relkind === "r" || relkind === "m") return "table";
  if (relkind === "v") return "view";
  return "other";
}

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
  readonly columns?: ReadonlyArray<{ readonly name: string; readonly type?: number }> | null;
  readonly count?: number | null;
};

/**
 * Postgres type OID → the canonical lowercase type name (DW-30/34/40). The ad-hoc SQL
 * path has no `information_schema` to lean on, but postgres.js already carries the
 * RowDescription's type OID on each column descriptor — this map turns it into EXACTLY
 * the same spelling `information_schema.columns.data_type` yields for the browse path,
 * so both read paths classify identically and there is one canonical vocabulary.
 *
 * OIDs are stable, built-in `pg_type` values. Anything absent (a domain, an enum, an
 * extension type, `inet`, `geometry`, …) is deliberately left UNMAPPED: `dataType` stays
 * `undefined` and display falls back to the value-inferred cell kind rather than to a
 * guess. Note `1114` (`timestamp`) maps to the SPELLED-OUT `timestamp without time zone`
 * — the naive form (DW-34) — never the bare `timestamp`, which is MySQL's tz-aware type.
 *
 * Every name here is the `information_schema.columns.data_type` SPELLING, not the
 * internal `pg_type` alias and not a collapsed display bucket: `integer` (not `int4`),
 * `smallint` (not `int2`), `character varying` (not `text`), `jsonb` (not `json`),
 * `time without time zone` (not `time`). `dataType` is a whitelisted PUBLIC field
 * documented as "the SQL type as the engine names it", so the ad-hoc path must not
 * invent a private vocabulary that disagrees with the browse path for the same logical
 * column — even where both spellings land in the same display bucket TODAY, the next
 * consumer that keys on the spelling (a richer type label, a CREATE TABLE round-trip, an
 * AI prompt) would inherit a field that lies depending on which read path produced it.
 */
const PG_OID_TO_DATA_TYPE: ReadonlyMap<number, string> = new Map([
  [20, "bigint"],
  [1700, "numeric"],
  [21, "smallint"],
  [23, "integer"],
  [700, "real"],
  [701, "double precision"],
  [16, "boolean"],
  [1114, "timestamp without time zone"],
  [1184, "timestamp with time zone"],
  [1082, "date"],
  [1083, "time without time zone"],
  [1266, "time with time zone"],
  [25, "text"],
  [1043, "character varying"],
  [1042, "character"],
  [2950, "uuid"],
  [114, "json"],
  [3802, "jsonb"],
]);

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
  // The type OID rides on each column descriptor; map it to a canonical SQL type name
  // (DW-30) and OMIT the key entirely when the OID is absent or unmapped, so a result
  // with no usable type metadata is the byte-identical `{name}` shape it always was.
  const columns = (result.columns ?? []).map((c) => {
    const dataType = c.type === undefined ? undefined : PG_OID_TO_DATA_TYPE.get(c.type);
    return dataType === undefined ? { name: c.name } : { name: c.name, dataType };
  });
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

  // DW-39: the connection's detected SQL-parsing modes, filled by the best-effort probe in
  // `connect()`. Initialized to the over-reject-safe fallback so that if `connect` is never
  // reached — or the probe throws — the splitter reads backslash-literal modes (fail-closed)
  // rather than assuming server defaults.
  let modes: SessionModes = SAFE_FALLBACK_SESSION_MODES;

  return {
    async connect(): Promise<void> {
      try {
        // Force an actual connection + round-trip so auth/host/network errors
        // surface here (postgres.js is otherwise lazy) — classified, never raw.
        await sql`select 1`;
      } catch (err) {
        throw toDriverConnectionError(err);
      }
      // Best-effort SQL-mode detection (DW-39). Kept separate from the `select 1` liveness
      // round-trip and swallowed to the over-reject-safe fallback: a server that chokes on the
      // probe still connects rather than regressing a previously-working connect.
      try {
        const [row] = (await sql`SHOW standard_conforming_strings`) as unknown as ReadonlyArray<{
          readonly standard_conforming_strings?: unknown;
        }>;
        modes = postgresSessionModes(row?.standard_conforming_strings);
      } catch {
        modes = SAFE_FALLBACK_SESSION_MODES;
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
      //
      // DW-33: the owning relation's `pg_class` facts (`relkind` + `relhassubclass`) ride
      // along on the row this query ALREADY fetches, so relation kind costs no extra
      // round-trip and no per-table query (an N+1 would be a HALT condition).
      //
      // They are carried by CORRELATED SCALAR SUBQUERIES in the SELECT list, NOT by a
      // join — deliberately, because this is the introspection query EVERY connection
      // depends on: a bug here breaks `connect` outright, not just browse. A scalar
      // subquery is structurally incapable of changing the column row set — it can neither
      // MULTIPLY nor DROP a row whatever the catalogs contain — whereas a join's row count
      // is only as safe as its uniqueness argument. (Concretely: a join on relation NAME
      // is matched under the catalog's collation, and duplicate-by-case names are possible,
      // so a name-based join could match two `pg_class` rows and silently duplicate every
      // column of that relation.) Semantics stay LEFT-JOIN-equivalent: no matching catalog
      // row ⇒ the scalar is NULL ⇒ kind omitted, and the columns are still returned.
      //
      // `colScope` stays spliced UNQUALIFIED and VERBATIM: with `information_schema.columns
      // c` the ONLY source in the outer FROM, a bare `table_schema` resolves unambiguously
      // to `c`, and neither subquery exposes a `table_schema` to compete with it.
      const rows = (await sql`
        SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable,
               (SELECT rel.relkind
                  FROM pg_catalog.pg_class rel
                  JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
                 WHERE ns.nspname = c.table_schema AND rel.relname = c.table_name
                 LIMIT 1) AS relkind,
               (SELECT rel.relhassubclass
                  FROM pg_catalog.pg_class rel
                  JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
                 WHERE ns.nspname = c.table_schema AND rel.relname = c.table_name
                 LIMIT 1) AS relhassubclass
        FROM information_schema.columns c
        WHERE ${colScope}
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
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

      // DW-33: `relationKind` is spread CONDITIONALLY so an unmatched catalog row (NULL
      // `relkind`) leaves the property absent rather than explicitly `undefined` — the
      // assembler then omits `SchemaTableInfo.kind` and the planner reads it as unknown.
      const columns: IntrospectedColumn[] = rows.map((r) => {
        const relationKind = pgRelationKind(r.relkind, r.relhassubclass);
        return {
          schema: r.table_schema,
          table: r.table_name,
          column: r.column_name,
          dataType: r.data_type,
          nullable: r.is_nullable === "YES",
          ...(relationKind === undefined ? {} : { relationKind }),
        };
      });
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

    sessionModes: () => modes,

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
