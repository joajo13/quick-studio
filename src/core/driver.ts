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
  /**
   * Whether this column participates in the table's primary key (Story 3.2). Each
   * adapter flags it from the engine's key metadata; {@link assembleSchema} folds
   * the flagged column names (in column order) into `SchemaTableInfo.primaryKey`.
   * Optional so pre-3.2 call sites still type-check — absent is treated as `false`.
   */
  readonly isPrimaryKey?: boolean;
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
 * {@link IntrospectedIndex} and {@link IntrospectedForeignKey} rows) into the grouped
 * neutral {@link DatabaseSchema}. Preserves input order for tables, columns, indexes,
 * index columns, and foreign keys (the adapters order by schema/table/ordinal, by
 * index/position, and by constraint/position), so the wire shape mirrors the live
 * database's own ordering. Index and FK rows are grouped by name within their table,
 * exactly as PK columns are folded. Pure.
 */
export function assembleSchema(
  engine: DbEngine,
  columns: readonly IntrospectedColumn[],
  indexes: readonly IntrospectedIndex[] = [],
  foreignKeys: readonly IntrospectedForeignKey[] = [],
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
    // `pk` is the SAME array stored (read-only) on the table; PK column names are
    // pushed in column order as we fold, so `primaryKey` mirrors the key order.
    entry.cols.push({ name: col.column, dataType: col.dataType, nullable: col.nullable });
    if (col.isPrimaryKey === true) entry.pk.push(col.column);
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
 * MySQL codes to `auth`, DNS codes to `host`, refused/reset/timeout to `network`,
 * and defaults anything unrecognized to `network` (never leaks the raw error).
 * Never returns `unsupported_scheme` — that verdict is {@link createDriver}'s alone.
 */
export function classifyConnectionError(err: unknown): ConnectionFailureKind {
  const { code, errno } = readErrorTags(err);
  if (code !== undefined) {
    if (AUTH_CODES.has(code)) return "auth";
    if (HOST_CODES.has(code)) return "host";
    if (NETWORK_CODES.has(code)) return "network";
  }
  if (errno !== undefined && AUTH_ERRNO.has(errno)) return "auth";
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
 * The value is deliberately GENEROUS (not the 5s teardown bound): the four
 * `information_schema`/system-catalog queries — including the postgres
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
 * Read a URL's scheme (lower-cased, no trailing `:`), or `null` when the string
 * is not a parseable URL at all (e.g. a bare Windows path that even `URL` rejects).
 */
function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return null;
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
 */
export function createDriver(url: string): Driver {
  const scheme = schemeOf(url);
  if (scheme === "postgres" || scheme === "postgresql") {
    return createPostgresDriver(url);
  }
  if (scheme === "mysql") {
    return createMysqlDriver(url);
  }
  const named = scheme === null ? "" : ` "${scheme}"`;
  throw new DriverConnectionError(
    "unsupported_scheme",
    `unsupported database URL scheme${named} (expected postgres or mysql)`,
  );
}
