/**
 * quick-studio Core — engine-neutral driver interface + error classification.
 *
 * This is the single seam behind which every engine specific lives (AR-10). A
 * {@link Driver} exposes only three verbs — `connect`, `listSchema`, `close` —
 * and always yields the neutral {@link DatabaseSchema} shape. {@link createDriver}
 * picks the adapter by URL scheme (an allowlist — anything else is refused as
 * `unsupported_scheme` BEFORE any socket is opened), and
 * {@link classifyConnectionError} maps a raw engine/OS error to a neutral
 * {@link ConnectionFailureKind}. No credentials or raw exceptions ever escape:
 * failures surface as a typed {@link DriverConnectionError} carrying only a
 * `kind` and a fixed, credential-free message.
 */

import type {
  ConnectionFailureKind,
  DatabaseSchema,
  DbEngine,
  SchemaIndexInfo,
  SchemaTableInfo,
} from "../shared/contract.ts";
// The adapters import `DriverConnectionError`/`toDriverConnectionError` back from
// here. The cycle is safe: nothing below is used at module-eval time — the
// adapter factories are only invoked at runtime from `createDriver`.
import { createMysqlDriver } from "./driver-mysql.ts";
import { createPostgresDriver } from "./driver-postgres.ts";

/**
 * The uniform, engine-neutral driver. All engine-specific SQL, introspection,
 * and error mapping live behind this interface inside Core; callers see only the
 * neutral {@link DatabaseSchema}. Contract: `connect` opens (and liveness-checks)
 * exactly one connection; `listSchema` introspects it; `close` releases it.
 */
export type Driver = {
  /** Open and liveness-verify the connection. Rejects with {@link DriverConnectionError}. */
  connect(): Promise<void>;
  /** Introspect the live connection into the neutral schema shape. */
  listSchema(): Promise<DatabaseSchema>;
  /**
   * Run a row-returning query and yield its rows as ordered arrays plus the
   * ordered column descriptors — the one engine-neutral read seam (Story 3.2).
   * `params` carries bound values for the future raw path; each adapter maps them
   * onto its own placeholder syntax (`$n` / `?`) so that dialect never leaks above
   * the driver. The browse SELECT passes NO params (it carries only quoted
   * identifiers + Core-computed integer literals).
   */
  query(text: string, params?: ReadonlyArray<unknown>): Promise<DriverQueryResult>;
  /**
   * Run a statement inside an engine-level READ-ONLY transaction (postgres
   * `BEGIN`/`SET TRANSACTION READ ONLY` on a reserved connection; mysql
   * `START TRANSACTION READ ONLY` under a per-driver mutex), then ROLL BACK in a
   * `finally`. This is the seam the executor's `runReadOnly` auto-classified-read
   * path uses so a mis-classified write (e.g. `SELECT … INTO`, a volatile/writing
   * function) fails at the engine instead of committing. Isolated so concurrent
   * calls cannot interleave and drop the read-only scope.
   */
  queryReadOnly(text: string, params?: ReadonlyArray<unknown>): Promise<DriverQueryResult>;
  /**
   * Quote a single identifier for safe interpolation into composed SQL, escaping
   * the engine's quote char (Postgres `"` doubled, MySQL `` ` `` doubled). The ONLY
   * sanctioned way a Core-composed identifier reaches SQL — never string-concat.
   */
  quoteIdent(ident: string): string;
  /** Release the connection/pool. Idempotent and never throws for the caller. */
  close(): Promise<void>;
};

/** One column descriptor of a {@link DriverQueryResult} — its live name, verbatim. */
export type DriverColumn = {
  readonly name: string;
};

/**
 * The engine-neutral shape of a row-returning query result: ordered column
 * descriptors plus rows as position-aligned value arrays (raw JS values — the
 * pure `frozen-map` layer tags them into {@link import("../shared/contract.ts").FrozenCell}).
 */
export type DriverQueryResult = {
  readonly columns: ReadonlyArray<DriverColumn>;
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
  /**
   * Rows affected by a mutation (`INSERT`/`UPDATE`/`DELETE`) or `0` for a read /
   * DDL. Optional so a pre-3.1 fake driver still type-checks; the real adapters
   * always populate it (postgres `result.count`, mysql `ResultSetHeader.affectedRows`).
   */
  readonly rowsAffected?: number;
};

/** Builds a {@link Driver} for a connection URL. Injected in tests (DI seam). */
export type DriverFactory = (url: string) => Driver;

/**
 * A single introspected column, flattened and engine-neutral. Each adapter maps
 * its engine's `information_schema.columns` rows into this shape, pre-ordered by
 * schema → table → ordinal, and {@link assembleSchema} folds them into the
 * grouped {@link DatabaseSchema}. This is the one place engine rows become neutral.
 */
export type IntrospectedColumn = {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly dataType: string;
  readonly nullable: boolean;
};

/**
 * A single introspected primary-key column, flattened and engine-neutral (DW-31).
 * Each adapter maps its engine's PK constraint metadata (Postgres/MySQL
 * `key_column_usage`) into ONE row per (table, PK column), pre-ordered by schema ->
 * table -> the key's OWN `ordinal_position` (the column's position WITHIN the PK
 * constraint, not the table ordinal), so {@link assembleSchema} folds them into
 * `SchemaTableInfo.primaryKey` preserving the key's own column order — mirroring the
 * {@link IntrospectedForeignKey}/{@link IntrospectedIndex} folds. A composite PK
 * arrives as several rows for one table, in key order.
 */
export type IntrospectedPrimaryKey = {
  readonly schema: string;
  readonly table: string;
  /** One PK column; rows arrive in key-position order (the PK's own ordinal). */
  readonly column: string;
};

/**
 * A single introspected index column, flattened and engine-neutral (Story 3.5).
 * Each adapter maps its engine's index metadata (Postgres `pg_index`/`pg_class`/
 * `pg_attribute`, MySQL `information_schema.statistics`) into ONE row per
 * (index, column), pre-ordered by schema -> table -> index -> column position, so
 * {@link assembleSchema} folds them into grouped `SchemaIndexInfo` preserving both
 * index and column order. The PK-backing index is included, not filtered.
 */
export type IntrospectedIndex = {
  readonly schema: string;
  readonly table: string;
  /** The index's own name (e.g. `users_pkey`, `PRIMARY`, `ix_orders_customer`). */
  readonly indexName: string;
  /** True iff the index is a unique index (Postgres `indisunique`, MySQL `NON_UNIQUE = 0`). */
  readonly unique: boolean;
  /** One indexed column; rows arrive in index-column order (position, not table ordinal). */
  readonly column: string;
};

/**
 * A single introspected foreign-key column, flattened and engine-neutral (Story 4.1).
 * Each adapter maps its engine's referential-constraint metadata (Postgres
 * `pg_constraint`/`unnest(conkey,confkey)`, MySQL `key_column_usage`) into ONE row per
 * (constraint, column), pre-ordered by schema -> table -> constraint -> key position, so
 * {@link assembleSchema} folds them into grouped `SchemaForeignKeyInfo` preserving both
 * constraint grouping and the position-aligned local/referenced column order. A composite
 * FK arrives as several rows sharing one `constraintName`; a self-referential FK simply
 * names its own `referencedTable`.
 */
export type IntrospectedForeignKey = {
  readonly schema: string;
  readonly table: string;
  /** The constraint's own name — the grouping key for a (possibly composite) FK. */
  readonly constraintName: string;
  /** One local column of the FK; rows arrive in key-position order. */
  readonly column: string;
  readonly referencedSchema: string;
  readonly referencedTable: string;
  /** The referenced column position-aligned with `column`. */
  readonly referencedColumn: string;
};

/**
 * Fold a pre-ordered flat list of {@link IntrospectedColumn} (and, optionally,
 * {@link IntrospectedIndex}, {@link IntrospectedForeignKey}, and
 * {@link IntrospectedPrimaryKey} rows) into the grouped neutral {@link DatabaseSchema}.
 * Preserves input order for tables, columns, primary-key columns, indexes, index
 * columns, and foreign keys (the adapters order by schema/table/ordinal, by the PK's
 * own key position, by index/position, and by constraint/position), so the wire shape
 * mirrors the live database's own ordering. Index, FK, and PK rows are grouped within
 * their table and only DECORATE tables the column query already produced. Pure.
 */
export function assembleSchema(
  engine: DbEngine,
  columns: readonly IntrospectedColumn[],
  indexes: readonly IntrospectedIndex[] = [],
  foreignKeys: readonly IntrospectedForeignKey[] = [],
  primaryKeys: readonly IntrospectedPrimaryKey[] = [],
): DatabaseSchema {
  const tables: SchemaTableInfo[] = [];
  // Insertion-ordered index from "schema table" to the mutable columns array
  // of the table being accumulated — the input is already grouped by ordering, but
  // keying defensively tolerates any adjacent-but-not-identical duplication.
  const index = new Map<
    string,
    {
      readonly cols: SchemaColumnAccumulator;
      readonly pk: string[];
      readonly idx: SchemaIndexAccumulator;
      // Per-index mutable column arrays, keyed by index name, so a multi-column
      // index folds its columns (in index order) into one grouped SchemaIndexInfo.
      readonly idxByName: Map<string, string[]>;
      readonly fk: SchemaForeignKeyAccumulator;
      // Per-FK mutable local/referenced column arrays, keyed by constraint name, so a
      // composite FK folds its columns (in key order) into one grouped SchemaForeignKeyInfo.
      readonly fkByName: Map<string, { cols: string[]; refCols: string[] }>;
    }
  >();

  const ensureEntry = (schema: string, table: string) => {
    const key = `${schema} ${table}`;
    let e = index.get(key);
    if (e === undefined) {
      const cols: SchemaColumnAccumulator = [];
      const pk: string[] = [];
      const idx: SchemaIndexAccumulator = [];
      const fk: SchemaForeignKeyAccumulator = [];
      const info: SchemaTableInfo = { schema, name: table, columns: cols, primaryKey: pk, indexes: idx, foreignKeys: fk };
      e = { cols, pk, idx, idxByName: new Map(), fk, fkByName: new Map() };
      index.set(key, e);
      tables.push(info);
    }
    return e;
  };

  for (const col of columns) {
    const entry = ensureEntry(col.schema, col.table);
    entry.cols.push({ name: col.column, dataType: col.dataType, nullable: col.nullable });
  }

  // Fold PK rows (DW-31): `entry.pk` is the SAME array stored (read-only) on the
  // table; PK column names are pushed in ARRIVAL order — and the adapters pre-order
  // the PK rows by the key's OWN `ordinal_position` — so `primaryKey` mirrors the
  // key's own column order rather than table-column order. Like indexes/FKs, PK rows
  // only DECORATE tables produced by column introspection: a PK row for a relation the
  // column query never listed is dropped rather than materializing a phantom table.
  for (const pk of primaryKeys) {
    const entry = index.get(`${pk.schema} ${pk.table}`);
    if (entry === undefined) continue;
    entry.pk.push(pk.column);
  }

  // Fold index rows the same way: grouped by index name within the table, columns
  // appended in index order (the adapters pre-order by index/position). Indexes only
  // DECORATE tables produced by column introspection — never materialize a table from
  // an index row. (Postgres surfaces indexes from the system catalogs, which include
  // `pg_toast` toast indexes and materialized-view indexes that `information_schema.columns`
  // never lists; without this guard each would spawn a phantom column-less table.)
  for (const ix of indexes) {
    const entry = index.get(`${ix.schema} ${ix.table}`);
    if (entry === undefined) continue;
    let colsAcc = entry.idxByName.get(ix.indexName);
    if (colsAcc === undefined) {
      // First row for this index: create the grouped entry and stash its mutable
      // columns array so subsequent rows append (in index order) into the same one.
      colsAcc = [];
      entry.idxByName.set(ix.indexName, colsAcc);
      entry.idx.push({ name: ix.indexName, columns: colsAcc, unique: ix.unique });
    }
    colsAcc.push(ix.column);
  }

  // Fold FK rows the same way: grouped by constraint name within the table, local and
  // referenced columns appended (position-aligned) in key order (the adapters pre-order
  // by constraint/position). A composite FK becomes ONE grouped SchemaForeignKeyInfo, not
  // one per column. Like indexes, FK rows only DECORATE tables produced by column
  // introspection — a constraint on a relation the column query never listed is dropped
  // rather than materializing a phantom table. The map key mirrors `ensureEntry`'s
  // NUL-joined `schema table` composite so a `.` in an identifier can never collide.
  for (const constraint of foreignKeys) {
    const entry = index.get(`${constraint.schema} ${constraint.table}`);
    if (entry === undefined) continue;
    let acc = entry.fkByName.get(constraint.constraintName);
    if (acc === undefined) {
      // First row for this constraint: create the grouped entry and stash its mutable
      // column arrays so subsequent rows append (in key order) into the same one. The
      // referenced schema/table are fixed by the constraint (identical across its rows).
      const cols: string[] = [];
      const refCols: string[] = [];
      acc = { cols, refCols };
      entry.fkByName.set(constraint.constraintName, acc);
      entry.fk.push({
        columns: cols,
        referencedSchema: constraint.referencedSchema,
        referencedTable: constraint.referencedTable,
        referencedColumns: refCols,
      });
    }
    acc.cols.push(constraint.column);
    acc.refCols.push(constraint.referencedColumn);
  }

  return { engine, tables };
}

/** Mutable column accumulator that is exposed read-only via `SchemaTableInfo.columns`. */
type SchemaColumnAccumulator = Array<{
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
}>;

/** Mutable index accumulator that is exposed read-only via `SchemaTableInfo.indexes`. */
type SchemaIndexAccumulator = Array<{
  readonly name: string;
  readonly columns: string[];
  readonly unique: boolean;
}>;

/** Mutable FK accumulator that is exposed read-only via `SchemaTableInfo.foreignKeys`. */
type SchemaForeignKeyAccumulator = Array<{
  readonly columns: string[];
  readonly referencedSchema: string;
  readonly referencedTable: string;
  readonly referencedColumns: string[];
}>;

/**
 * Neutral, credential-free failure messages — one per {@link ConnectionFailureKind}.
 * These are the ONLY strings that ever reach a client `message`; the URL, the
 * credentials, and the raw engine text are never interpolated in.
 */
const NEUTRAL_MESSAGE: Readonly<Record<ConnectionFailureKind, string>> = {
  host: "could not resolve the database host",
  auth: "the database rejected the provided credentials",
  network:
    "could not reach the database (connection refused, reset, or timed out)",
  unsupported_scheme: "unsupported database URL scheme",
  // Host+auth succeeded but the URL names a catalog that does not exist on the
  // server (PG `3D000`, MySQL `ER_BAD_DB_ERROR`/`1049`, DW-18). Neutral: the
  // database name itself is never echoed back.
  "database-does-not-exist": "the named database does not exist on the server",
  // A supported-scheme URL that `new URL()` cannot parse (bad/out-of-range port,
  // unparseable authority). Structural — the raw URL is never echoed.
  "malformed-url": "the database URL is malformed",
  // No connection target configured at all (`databaseUrl === null`). A driver never
  // produces this (it is emitted by `doConnect` before any driver exists); the entry
  // exists only to keep this map exhaustive over ConnectionFailureKind.
  "no-target": "no connection target configured",
};

/**
 * A typed connection failure. Carries the classified {@link ConnectionFailureKind}
 * and a neutral message only — it is the sanctioned way a driver reports host /
 * auth / network / unsupported-scheme without leaking a secret or a raw engine
 * exception. The connection manager turns it into a `status:"failed"` payload.
 */
export class DriverConnectionError extends Error {
  readonly kind: ConnectionFailureKind;
  constructor(kind: ConnectionFailureKind, message: string) {
    super(message);
    this.name = "DriverConnectionError";
    this.kind = kind;
  }
}

/**
 * Auth: PG SQLSTATE + MySQL error codes (mysql2 surfaces both `code` and `errno`).
 * Covers two situations that both mean "the account cannot proceed": a connect-time
 * handshake rejection (bad password / DB access), AND a post-handshake INTROSPECTION
 * privilege denial — an authenticated-but-unprivileged account whose `listSchema`
 * `information_schema` reads are refused (DW-19). The neutral 4-kind taxonomy has no
 * `permission` bucket and the intent forbids adding one, so these privilege codes map
 * to `auth` (the closest neutral bucket — "the database rejected …"); `select 1` at
 * connect needs no table privileges, so extending this set does NOT regress connect-time
 * classification.
 */
const AUTH_CODES: ReadonlySet<string> = new Set([
  "28P01", // PG: invalid_password
  "28000", // PG: invalid_authorization_specification
  "42501", // PG: insufficient_privilege (post-handshake introspection denial, DW-19)
  "ER_ACCESS_DENIED_ERROR", // MySQL: 1045
  "ER_DBACCESS_DENIED_ERROR", // MySQL: 1044
  "ER_TABLEACCESS_DENIED_ERROR", // MySQL: 1142 (introspection table privilege denied, DW-19)
  "ER_COLUMNACCESS_DENIED_ERROR", // MySQL: 1143 (introspection column privilege denied, DW-19)
  "ER_SPECIFIC_ACCESS_DENIED_ERROR", // MySQL: 1227 (introspection privilege denied, DW-19)
]);
/**
 * MySQL access-denied errnos (paired with the `AUTH_CODES` entries above): `1045`/`1044`
 * are the connect-time denials; `1142`/`1143`/`1227` are the post-handshake introspection
 * privilege denials (DW-19) mapped to `auth` for the same reason.
 */
const AUTH_ERRNO: ReadonlySet<number> = new Set([1045, 1044, 1142, 1143, 1227]);
/** Host: DNS resolution failed / unknown host. */
const HOST_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN"]);
/** Network: reachable-but-refused / reset / timed out. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "CONNECT_TIMEOUT", // postgres.js connect-timeout code (mysql2 surfaces ETIMEDOUT)
]);
/**
 * Database-does-not-exist: host+auth were fine but the URL names a missing catalog
 * (DW-18). PG SQLSTATE `3D000` is `invalid_catalog_name`; MySQL `ER_BAD_DB_ERROR`
 * (errno `1049`) is "Unknown database". Disjoint from the auth/host/network sets, so
 * classification order is immaterial.
 */
const DB_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "3D000", // PG: invalid_catalog_name
  "ER_BAD_DB_ERROR", // MySQL: 1049 (Unknown database)
]);
/** MySQL "Unknown database" errno, paired with `ER_BAD_DB_ERROR` above (DW-18). */
const DB_NOT_FOUND_ERRNO: ReadonlySet<number> = new Set([1049]);

/** Extract the string `code` and numeric `errno` an engine/OS error may carry. */
function readErrorTags(err: unknown): {
  readonly code: string | undefined;
  readonly errno: number | undefined;
} {
  if (err !== null && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      errno: typeof e.errno === "number" ? e.errno : undefined,
    };
  }
  return { code: undefined, errno: undefined };
}

/**
 * Classify a raw engine/OS connection error into a neutral {@link ConnectionFailureKind}.
 * Pure and total: reads the error's `code`/`errno` tags, maps PG SQLSTATE +
 * MySQL codes to `auth`, DNS codes to `host`, missing-catalog codes/errno to
 * `database-does-not-exist` (DW-18), refused/reset/timeout to `network`, and
 * defaults anything unrecognized to `network` (never leaks the raw error).
 * Never returns `unsupported_scheme` OR `malformed-url` — both are structural URL
 * verdicts that are {@link createDriver}'s alone.
 */
export function classifyConnectionError(err: unknown): ConnectionFailureKind {
  const { code, errno } = readErrorTags(err);
  if (code !== undefined) {
    if (AUTH_CODES.has(code)) return "auth";
    if (HOST_CODES.has(code)) return "host";
    if (NETWORK_CODES.has(code)) return "network";
    // Missing catalog (DW-18): disjoint from the sets above, so order does not matter.
    if (DB_NOT_FOUND_CODES.has(code)) return "database-does-not-exist";
  }
  if (errno !== undefined && AUTH_ERRNO.has(errno)) return "auth";
  if (errno !== undefined && DB_NOT_FOUND_ERRNO.has(errno)) return "database-does-not-exist";
  // Unmapped → network (the safe default per the intent contract).
  return "network";
}

/**
 * Wrap a raw engine/OS error as a neutral {@link DriverConnectionError}. Adapters
 * call this from their `connect` catch so only a classified, credential-free
 * error ever propagates out of the driver.
 */
export function toDriverConnectionError(err: unknown): DriverConnectionError {
  const kind = classifyConnectionError(err);
  return new DriverConnectionError(kind, NEUTRAL_MESSAGE[kind]);
}

/**
 * Client-side bound (ms) on the post-handshake introspection query, so a hung
 * `listSchema` (a lock on `information_schema`, a stalled server) cannot block
 * `close()` → `Core.stop()` INDEFINITELY and leak the port (DW-20). It is scoped
 * to `listSchema` ONLY and never touches the browse `query`/`queryReadOnly` paths.
 *
 * The value is deliberately GENEROUS (not the 5s teardown bound): the
 * `information_schema`/system-catalog introspection queries (four on MySQL, five on
 * postgres — the latter adds a server-version probe) — including the postgres
 * `pg_index`/`pg_constraint` lateral-unnest joins — can legitimately take several
 * seconds on a very large catalog, and a false timeout would misreport a healthy
 * database as unreachable (`network`) with no way to recover. 30s comfortably
 * clears a slow-but-healthy large-schema read while still bounding a genuinely
 * wedged query, so shutdown always completes (worst case: teardown starts ~30s
 * after a quit that lands exactly mid-hang — rare, and finite instead of infinite).
 */
export const INTROSPECTION_TIMEOUT_MS = 30_000;

/**
 * Race `op` against a timer that rejects after `ms`, clearing the timer on settle
 * so no dangling handle keeps the event loop alive. The timer rejects with a plain
 * `Error` on purpose: the adapter catch then classifies it via
 * {@link toDriverConnectionError} (no `code` → `network`), keeping one classification
 * seam for the DW-20 timeout. Exported for unit testing.
 */
export async function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("introspection timed out")), ms);
  });
  try {
    return await Promise.race([op, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Read a URL's scheme (lower-cased, no trailing `:`) AND whether the URL is
 * well-formed. On a successful `new URL()` parse: `{ scheme, wellFormed: true }`.
 * When `new URL()` throws (a bad/out-of-range port or an unparseable authority),
 * the scheme is RECOVERED structurally via a leading RFC-3986 scheme match so a
 * malformed-but-supported URL stays distinguishable from a genuinely unsupported
 * one (DW-21) — `{ scheme, wellFormed: false }`, or `{ scheme: null }` when no
 * scheme is extractable at all (e.g. a bare Windows path or `://nonsense`).
 */
function schemeOf(url: string): { scheme: string | null; wellFormed: boolean } {
  try {
    return { scheme: new URL(url).protocol.replace(/:$/, "").toLowerCase(), wellFormed: true };
  } catch {
    // new URL() threw (bad/out-of-range port, unparseable authority): recover the
    // leading RFC-3986 scheme so a malformed-but-supported URL is not misread as
    // an unsupported scheme. Normalize first to MATCH what the WHATWG parser would
    // have seen — it strips ASCII tab/newline anywhere and trims leading/trailing
    // C0-control-or-space — so ` postgres://…:99999/db` still recovers `postgres`
    // (else the position-0 anchor would miss the scheme past a stray space and
    // misreport a supported-but-malformed URL as `unsupported_scheme`). `null` when
    // no scheme is extractable at all.
    const normalized = url.replace(/[\t\n\r]/g, "").trim();
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized);
    return { scheme: m?.[1] !== undefined ? m[1].toLowerCase() : null, wellFormed: false };
  }
}

/**
 * Select and build the engine adapter for `url` by its scheme (the allowlist):
 * `postgres`/`postgresql` → the postgres.js adapter, `mysql` → the mysql2 adapter.
 * ANY other scheme (`file:`, `javascript:`, `data:`, a Windows-drive `C:\…`, or an
 * unparseable string) is refused with a `unsupported_scheme` {@link DriverConnectionError}
 * BEFORE any connection is attempted — the sanctioned rejection point for the
 * shallow URL carried from Story 1.2. The scheme name is non-secret, so it is
 * safe to name in the message; the rest of the URL is never echoed.
 *
 * A supported scheme whose URL is NOT well-formed (a bad/out-of-range port or an
 * unparseable authority that makes `new URL()` throw) is a distinct, truthful
 * verdict — `malformed-url` — NOT `unsupported_scheme`: the scheme IS one we speak,
 * the URL is merely broken (DW-21). This is caught structurally here, before any
 * socket opens; the raw URL is never echoed, only the (non-secret) scheme name.
 */
export function createDriver(url: string): Driver {
  // A supported scheme whose URL is malformed (`new URL()` threw) → `malformed-url`,
  // credential-free and naming only the (non-secret) scheme. Hoisted so the postgres
  // and mysql branches cannot drift a future wording edit apart.
  const malformedUrlError = (scheme: string): DriverConnectionError =>
    new DriverConnectionError("malformed-url", `malformed "${scheme}" database URL (could not be parsed)`);

  const { scheme, wellFormed } = schemeOf(url);
  if (scheme === "postgres" || scheme === "postgresql") {
    if (!wellFormed) throw malformedUrlError(scheme);
    return createPostgresDriver(url);
  }
  if (scheme === "mysql") {
    if (!wellFormed) throw malformedUrlError(scheme);
    return createMysqlDriver(url);
  }
  const named = scheme === null ? "" : ` "${scheme}"`;
  throw new DriverConnectionError(
    "unsupported_scheme",
    `unsupported database URL scheme${named} (expected postgres or mysql)`,
  );
}
