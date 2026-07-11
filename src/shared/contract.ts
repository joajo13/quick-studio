/**
 * quick-studio — shared contract (Ring-neutral, dependency-free).
 *
 * This module is the single canonical source of the Core<->UI wire contract and
 * the versioned frozen-data schema. It MUST NOT import any runtime dependency:
 * only TypeScript types, plain data, and pure/total functions live here. It is
 * imported by every ring (core / ui / sandbox) and data flows outward only.
 *
 * Wire conventions (AD-13):
 *  - Dates on every boundary are ISO-8601 UTC strings, never native `Date`.
 *  - Every RPC reply is a typed result OR a single error envelope.
 */

/* ------------------------------------------------------------------ *
 * Frozen-data schema — versioned, typed cell values
 * ------------------------------------------------------------------ */

/**
 * Version of the frozen-data schema. Bump on any breaking change to the
 * on-the-wire shape of {@link FrozenCell} / {@link FrozenData}.
 */
export const FROZEN_SCHEMA_VERSION = 1 as const;
export type FrozenSchemaVersion = typeof FROZEN_SCHEMA_VERSION;

/**
 * A typed cell value. Every value carried across a boundary is tagged so that
 * decoders never have to guess a JS runtime type. Dates are transported as an
 * ISO-8601 UTC string inside a `date` cell — never as a live `Date` object.
 */
export type FrozenCell =
  | { readonly kind: "null" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly iso: string };

export type FrozenColumn = {
  readonly name: string;
  /** Neutral cell kind expected for this column. */
  readonly type: FrozenCell["kind"];
};

export type FrozenRow = ReadonlyArray<FrozenCell>;

/**
 * The single canonical frozen-data shape (AD-13). This is the only shape pushed
 * to the Sandbox and the only shape embedded in a Snapshot.
 */
export type FrozenData = {
  readonly schemaVersion: FrozenSchemaVersion;
  readonly columns: ReadonlyArray<FrozenColumn>;
  readonly rows: ReadonlyArray<FrozenRow>;
};

/* ------------------------------------------------------------------ *
 * ISO-8601 UTC date helpers — pure & total, throw on invalid
 * ------------------------------------------------------------------ */

/**
 * Strict ISO-8601 UTC pattern: `YYYY-MM-DDTHH:MM:SS(.sss)?Z`.
 * Only the trailing `Z` (Zulu / UTC) is accepted — numeric offsets are rejected
 * so there is exactly one canonical encoding on the wire.
 */
const ISO_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Assert that `iso` is a valid ISO-8601 UTC instant. Throws (never returns a
 * falsy value) so callers can rely on totality: after this returns, `iso` is a
 * canonical UTC string.
 */
export function assertIsoUtc(iso: string): void {
  if (typeof iso !== "string" || !ISO_UTC_RE.test(iso)) {
    throw new TypeError(
      `Invalid ISO-8601 UTC date: ${JSON.stringify(iso)} (expected e.g. 2026-07-06T12:00:00Z)`,
    );
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new TypeError(`Unparseable ISO-8601 UTC date: ${JSON.stringify(iso)}`);
  }
  // Re-serialize to guarantee the calendar values are real (rejects 2026-13-40).
  const roundTrip = new Date(ms).toISOString();
  const normalize = (s: string) => s.replace(/\.0+Z$/, "Z").replace(/(\.\d*?)0+Z$/, "$1Z");
  if (normalize(roundTrip) !== normalize(iso)) {
    throw new TypeError(
      `Non-canonical or invalid calendar date: ${JSON.stringify(iso)} (normalizes to ${roundTrip})`,
    );
  }
}

/**
 * Convert a `Date` to a canonical ISO-8601 UTC string. Pure and total over its
 * domain: an invalid `Date` (e.g. `new Date("garbage")`) throws a `TypeError`
 * rather than letting `toISOString()` surface a raw `RangeError`.
 */
export function toIsoUtc(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid Date passed to toIsoUtc: ${String(date)}`);
  }
  return date.toISOString(); // always Zulu
}

/* ------------------------------------------------------------------ *
 * encode / decode — pure, total, round-trip safe
 * ------------------------------------------------------------------ */

/**
 * Assert the canonical well-formedness invariants before (de)serialization:
 *  - `columns` and `rows` are arrays and every row has exactly one cell per
 *    column (rectangularity); a ragged table must never round-trip clean.
 *  - every cell's `kind` matches its column's declared `type`, so the declared
 *    schema is authoritative rather than decorative. A SQL NULL (`kind: "null"`)
 *    is admissible in any column regardless of its declared type.
 */
function assertWellFormed(data: FrozenData): void {
  if (!Array.isArray(data.columns) || !Array.isArray(data.rows)) {
    throw new TypeError("FrozenData.columns and FrozenData.rows must both be arrays");
  }
  const width = data.columns.length;
  for (let i = 0; i < data.rows.length; i++) {
    const row = data.rows[i];
    if (!Array.isArray(row)) {
      throw new TypeError(`FrozenData row ${i} is not an array`);
    }
    if (row.length !== width) {
      throw new TypeError(
        `FrozenData row ${i} has ${row.length} cells; expected ${width} (one per column)`,
      );
    }
    for (let c = 0; c < width; c++) {
      const cellKind = (row[c] as FrozenCell).kind;
      const colType = (data.columns[c] as FrozenColumn).type;
      if (cellKind !== "null" && cellKind !== colType) {
        throw new TypeError(
          `FrozenData row ${i} col ${c} ('${(data.columns[c] as FrozenColumn).name}'): ` +
            `cell kind '${cellKind}' does not match column type '${colType}'`,
        );
      }
    }
  }
}

/**
 * Encode a {@link FrozenData} value into its canonical wire form. Pure and
 * total: validates every date cell is ISO-8601 UTC and throws on any invalid or
 * non-UTC date. `decode(encode(x))` deep-equals `x`.
 */
export function encode(data: FrozenData): FrozenData {
  if (data.schemaVersion !== FROZEN_SCHEMA_VERSION) {
    throw new TypeError(
      `Unsupported frozen schema version: ${String(data.schemaVersion)} (expected ${FROZEN_SCHEMA_VERSION})`,
    );
  }
  assertWellFormed(data);
  const columns = data.columns.map((c) => ({ name: c.name, type: c.type }));
  const rows = data.rows.map((row) => row.map(encodeCell));
  return { schemaVersion: FROZEN_SCHEMA_VERSION, columns, rows };
}

/**
 * Decode a wire-form {@link FrozenData} back into the in-memory shape. Pure and
 * total: enforces the same ISO-8601 UTC invariant on every date cell.
 */
export function decode(data: FrozenData): FrozenData {
  if (data.schemaVersion !== FROZEN_SCHEMA_VERSION) {
    throw new TypeError(
      `Unsupported frozen schema version: ${String(data.schemaVersion)} (expected ${FROZEN_SCHEMA_VERSION})`,
    );
  }
  assertWellFormed(data);
  const columns = data.columns.map((c) => ({ name: c.name, type: c.type }));
  const rows = data.rows.map((row) => row.map(decodeCell));
  return { schemaVersion: FROZEN_SCHEMA_VERSION, columns, rows };
}

function encodeCell(cell: FrozenCell): FrozenCell {
  switch (cell.kind) {
    case "null":
      return { kind: "null" };
    case "string":
      return { kind: "string", value: cell.value };
    case "number":
      if (!Number.isFinite(cell.value)) {
        throw new TypeError(`Non-finite number cell: ${String(cell.value)}`);
      }
      // Canonicalize -0 to 0: `JSON.stringify(-0)` is `"0"`, so leaving -0 here
      // would make the value diverge across the real JSON wire boundary and
      // break `decode(JSON.parse(JSON.stringify(encode(x))))` deep-equality.
      return { kind: "number", value: cell.value === 0 ? 0 : cell.value };
    case "boolean":
      return { kind: "boolean", value: cell.value };
    case "date":
      assertIsoUtc(cell.iso);
      return { kind: "date", iso: cell.iso };
    default: {
      const _exhaustive: never = cell;
      throw new TypeError(`Unknown cell kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// decode enforces exactly the same invariants (symmetric contract).
const decodeCell = encodeCell;

/* ------------------------------------------------------------------ *
 * Engine-neutral database schema + connect outcome (AR-10)
 * ------------------------------------------------------------------ */

/**
 * The relational engines quick-studio speaks to. Selected by URL scheme in the
 * Core (`postgres`/`postgresql` → `"postgres"`, `mysql` → `"mysql"`); all engine
 * specifics stay behind the Core-side driver — every ring sees only this tag.
 */
export type DbEngine = "postgres" | "mysql";

/**
 * One column of a table, in the single engine-neutral shape both rings share.
 * `dataType` mirrors the live database's own type name verbatim (identifiers are
 * never rewritten); `nullable` reflects the column's `IS NULLABLE` flag.
 */
export type SchemaColumnInfo = {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
};

/**
 * One index of a table, in the engine-neutral shape both rings share (Story 3.5).
 * `name` is the index's own name verbatim (`<table>_pkey` / `PRIMARY` for the
 * PK-backing index — it is NOT filtered out); `columns` lists the indexed columns
 * in INDEX ORDER (Postgres `indkey` position, MySQL `SEQ_IN_INDEX`), not table or
 * alphabetical order; `unique` is true iff the index is a unique index. Only these
 * three facets are surfaced — method/type, partial predicates, sort direction,
 * covering columns, and expression columns are deliberately out of scope.
 */
export type SchemaIndexInfo = {
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly unique: boolean;
};

/**
 * One foreign key of a table, in the engine-neutral shape both rings share
 * (Story 4.1) — the ONLY source of ERD edges. A composite FK is ONE entry whose
 * `columns` and `referencedColumns` are position-aligned (local column `columns[i]`
 * references `referencedColumns[i]`), listed in constraint/key-position order.
 * `referencedSchema`/`referencedTable` name the referenced relation verbatim as the
 * engine reports it; a self-referential FK simply names its own table. Edges come
 * ONLY from these real introspected constraints — never inferred from column names.
 */
export type SchemaForeignKeyInfo = {
  readonly columns: ReadonlyArray<string>;
  readonly referencedSchema: string;
  readonly referencedTable: string;
  readonly referencedColumns: ReadonlyArray<string>;
};

/**
 * One table (or view) of the introspected schema. `schema` is the owning
 * namespace/database as the engine reports it; `name` and `columns` mirror the
 * live database verbatim, ordered as introspected (schema/table/ordinal).
 * `primaryKey` lists the primary-key column names in column order (empty when
 * the table has none) — the deterministic browse ORDER-BY key and the source of
 * the grid's PK key-icon (Story 3.2). `indexes` lists the table's indexes
 * (Story 3.5), each with its ordered columns and uniqueness (empty when the table
 * has none) — mirroring how `primaryKey` is always present. `foreignKeys` lists the
 * table's outbound foreign keys (Story 4.1) — the ERD's edge source (empty when the
 * table has none). All three are introspected eagerly at connect time and folded in
 * the assembler.
 */
export type SchemaTableInfo = {
  readonly schema: string;
  readonly name: string;
  readonly columns: ReadonlyArray<SchemaColumnInfo>;
  readonly primaryKey: ReadonlyArray<string>;
  readonly indexes: ReadonlyArray<SchemaIndexInfo>;
  readonly foreignKeys: ReadonlyArray<SchemaForeignKeyInfo>;
};

/**
 * The single engine-neutral schema shape (AR-10). Regardless of engine, Ring 2
 * receives exactly this — an engine tag plus a flat, ordered list of tables.
 */
export type DatabaseSchema = {
  readonly engine: DbEngine;
  readonly tables: ReadonlyArray<SchemaTableInfo>;
};

/**
 * How a connection attempt failed, classified behind the driver from the raw
 * engine/OS error so no naked exception ever crosses a boundary:
 *  - `host` — the host does not resolve (DNS / unknown host).
 *  - `auth` — the credentials were rejected by the engine.
 *  - `network` — reachable-but-refused / timeout / reset (the default bucket).
 *  - `unsupported_scheme` — the URL scheme is not a relational engine we speak.
 */
export type ConnectionFailureKind =
  | "host"
  | "auth"
  | "network"
  | "unsupported_scheme";

/**
 * The outcome of a `connect` RPC. This is a DOMAIN result carried inside a
 * successful {@link RpcReply} — NOT a transport error — discriminated by `status`
 * (deliberately not `ok`, to avoid confusion with `RpcReply.ok`). A `failed`
 * result carries a neutral, credential-free message; only a genuine bug throws.
 */
export type ConnectResult =
  | { readonly status: "connected"; readonly schema: DatabaseSchema }
  | {
      readonly status: "failed";
      readonly failure: ConnectionFailureKind;
      readonly message: string;
    };

/* ------------------------------------------------------------------ *
 * Browse-rows contract (Story 3.2) — Core-paginated, read-only SELECT
 * ------------------------------------------------------------------ */

/**
 * Params for `table.rows`. `table` is required; `schema` disambiguates a table
 * name that exists in more than one schema (omit it when the name is unique).
 * `page` is 1-based; `pageSize` is the requested rows-per-page (Core clamps it to
 * `MAX_PAGE_SIZE` and defaults it when absent). No user value is ever spliced into
 * SQL — identifiers are schema-validated + engine-quoted and LIMIT/OFFSET are
 * Core-computed integer literals.
 */
export type TableRowsRequest = {
  readonly schema?: string;
  readonly table: string;
  readonly page?: number;
  readonly pageSize?: number;
};

/**
 * Result of `table.rows`: exactly ONE page of the table as {@link FrozenData}
 * (columns always present, even for an empty page), the effective `page` and
 * `pageSize` (the latter reflecting any clamp to `MAX_PAGE_SIZE`), and the table's
 * `total` row count for the pager. The whole result set is never shipped.
 */
export type TableRowsResult = {
  readonly data: FrozenData;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
};

/* ------------------------------------------------------------------ *
 * Manage-connections contract (Story 2.4) — credential-free by design
 * ------------------------------------------------------------------ */

/**
 * A credential-free view of a saved Connection sent Core→UI. It carries ONLY the
 * fields the UI is allowed to see: the id, the user-chosen `name`, and the `host`
 * + `engine` DERIVED in Core from the (secret-bearing) url. It never carries the
 * url, user, or password — the trust boundary is credential-flow-directional
 * (credentials travel UI→Core on submit only). `engine` is the url protocol with
 * the trailing colon stripped (e.g. `postgres`), `host` is `URL.host` (host[:port]).
 */
export type ConnectionSummary = {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly engine: string;
};

/** Params for `connections.add`. The url carries the credentials (UI→Core only). */
export type AddConnectionParams = {
  readonly name: string;
  readonly url: string;
};

/**
 * Params for `connections.edit`. Partial by design: a rename sends `name` only
 * (Core keeps the stored url the UI never held); a repoint sends the new `url`.
 */
export type EditConnectionParams = {
  readonly id: string;
  readonly name?: string;
  readonly url?: string;
};

/** Params for `connections.remove`. */
export type RemoveConnectionParams = {
  readonly id: string;
};

/** Result of `connections.list`: N credential-free summaries. */
export type ListConnectionsResult = ReadonlyArray<ConnectionSummary>;

/** Result of `connections.add`/`connections.edit`: the credential-free summary. */
export type ConnectionMutationResult = ConnectionSummary;

/** Result of `connections.remove`: idempotent success. */
export type RemoveConnectionResult = {
  readonly removed: true;
};

/* ------------------------------------------------------------------ *
 * AI provider-key contract (Story 5.1) — secret-free by design
 * ------------------------------------------------------------------ */

/**
 * The AI providers quick-studio can hold a user-supplied API key for — the SINGLE
 * source of truth (Core validation and the UI's `providers-model.ts` both import
 * this, so they can never drift). Identity is the provider kind: at most one key
 * per kind. Order matches the Settings-panel listing order.
 */
export const PROVIDER_KINDS = ["anthropic", "openai", "google"] as const;

/** A provider kind, derived from {@link PROVIDER_KINDS} (not hand-duplicated). */
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * Params for `providers.set`. The `apiKey` is the user's own secret, sent UI→Core
 * on submit ONLY — it is never returned. `providers.set` upserts by `provider`.
 */
export type SetProviderParams = {
  readonly provider: ProviderKind;
  readonly apiKey: string;
};

/** Params for `providers.remove`. Idempotent by design. */
export type RemoveProviderParams = {
  readonly provider: ProviderKind;
};

/**
 * A secret-free view of a configured provider sent Core→UI. It carries ONLY the
 * provider kind and a `keyPreview` — the last few characters of the key (never the
 * raw key, never the whole key). The trust boundary is one-directional: the key
 * travels UI→Core on submit only and stays in Ring 1.
 */
export type ProviderSummary = {
  readonly provider: ProviderKind;
  readonly keyPreview: string;
};

/** Result of `providers.list`: only the CONFIGURED providers as secret-free summaries. */
export type ListProvidersResult = {
  readonly providers: ReadonlyArray<ProviderSummary>;
};

/** Result of `providers.set`: the secret-free summary of the stored key. */
export type SetProviderResult = ProviderSummary;

/** Result of `providers.remove`: idempotent success. */
export type RemoveProviderResult = {
  readonly removed: true;
};

/* ------------------------------------------------------------------ *
 * Workspace-state persistence contract (Story 2.5) — credential-free
 * ------------------------------------------------------------------ */

/**
 * The five kinds of document Tab the Workspace can hold — the SINGLE source of
 * truth (Core validation and the UI's `workspace-state.ts` both import this, so
 * they can never drift). Order matches the launcher-rail order.
 */
export const WORKSPACE_TAB_KINDS = ["table", "query", "erd", "chat", "report"] as const;

/** A Tab kind, derived from {@link WORKSPACE_TAB_KINDS} (not hand-duplicated). */
export type WorkspaceTabKind = (typeof WORKSPACE_TAB_KINDS)[number];

/** Version of the on-disk/wire {@link WorkspaceSnapshot} shape. */
export const WORKSPACE_SNAPSHOT_VERSION = 1 as const;

/** One persisted Tab: id, kind, and the human title shown in the Tab strip. */
export type WorkspaceSnapshotTab = {
  readonly id: number;
  readonly kind: WorkspaceTabKind;
  readonly title: string;
};

/**
 * A persisted ERD tab layout (Story 4.2) — GEOMETRY ONLY. Deliberately carries no
 * credentials, connection urls, row data, or query text (the three-ring trust model:
 * the snapshot stays credential-free). `positions` maps a node id (the NUL-separated
 * `tableId(schema, name)`) to its saved TOP-LEFT corner, so a rearranged diagram
 * restores node-for-node after a relaunch (and re-introspection). `viewport` is the
 * saved pan/zoom, restored via React Flow's `defaultViewport`; it is optional (an
 * absent viewport falls back to fit-view).
 */
export type ErdTabLayout = {
  readonly positions: Record<string, { readonly x: number; readonly y: number }>;
  readonly viewport?: { readonly x: number; readonly y: number; readonly zoom: number };
};

/**
 * The persisted Workspace shape (FR-24 restore half, AR-9): Panel sizes + open
 * Tabs + active Tab + the next-id counter. Deliberately credential-free and
 * non-secret — never a connection url, row data, or query text.
 *
 * `erdLayouts` (Story 4.2) is an ADDITIVE optional field keyed by STRINGIFIED tab id,
 * holding each ERD tab's saved geometry (see {@link ErdTabLayout}). It is optional so
 * a pre-4.2 v1 snapshot (no ERD-layout data) still loads cleanly and falls back to the
 * dagre layout — hence {@link WORKSPACE_SNAPSHOT_VERSION} stays `1` (no version bump,
 * which would discard existing persisted workspaces).
 */
export type WorkspaceSnapshot = {
  readonly version: 1;
  readonly panelSizes: ReadonlyArray<number>;
  readonly tabs: ReadonlyArray<WorkspaceSnapshotTab>;
  readonly activeTabId: number | null;
  readonly nextId: number;
  readonly erdLayouts?: Record<string, ErdTabLayout>;
};

/** Params for `workspace.save` — the snapshot to persist (or no-op in Ephemeral). */
export type SaveWorkspaceParams = WorkspaceSnapshot;

/** Result of `workspace.save`: `true` only when Persistent mode actually wrote. */
export type SaveWorkspaceResult = {
  readonly saved: boolean;
};

/** Result of `workspace.load`: `null` on first launch, Ephemeral mode, or any degrade. */
export type LoadWorkspaceResult = {
  readonly snapshot: WorkspaceSnapshot | null;
};

/* ------------------------------------------------------------------ *
 * Guarded-executor contract (Story 3.1) — two request shapes
 * ------------------------------------------------------------------ */

/**
 * One column's value in a structured `insert`/`update`. The `value` key MUST be
 * present (an ABSENT `value` is a `bad_request` at the executor, never a silent
 * SQL `NULL`); an explicit `null` binds a real NULL. `value` is always bound as a
 * parameter — never string-spliced.
 */
export type StructuredColumnValue = {
  readonly column: string;
  readonly value: unknown;
};

/**
 * The primary-key address of a structured `update`/`delete`: exactly one column +
 * one value. Structural only — the executor additionally verifies (against the live
 * schema) that `column` is the table's SINGLE primary-key column, so a composed
 * `WHERE <column>=$n` can never match more than one row.
 */
export type StructuredPk = {
  readonly column: string;
  readonly value: unknown;
};

/**
 * One typed column definition for a structured `createTable`. `type` must be a
 * canonical token from the executor's fixed allowlist (there is NO raw-text
 * fallback); `notNull`/`primaryKey` are optional flags.
 */
export type StructuredColumnDef = {
  readonly name: string;
  readonly type: string;
  readonly notNull?: boolean;
  readonly primaryKey?: boolean;
};

/**
 * The four structured operations (path a). There is deliberately NO field that can
 * carry raw SQL, so widening to raw/multi-statement/arbitrary-DDL is unrepresentable
 * — not merely rejected. Each carries an optional `schema` to disambiguate a table
 * name across schemas.
 */
export type StructuredOp =
  | {
      readonly kind: "insert";
      readonly schema?: string;
      readonly table: string;
      readonly columns: ReadonlyArray<StructuredColumnValue>;
    }
  | {
      readonly kind: "update";
      readonly schema?: string;
      readonly table: string;
      readonly pk: StructuredPk;
      readonly set: ReadonlyArray<StructuredColumnValue>;
    }
  | {
      readonly kind: "delete";
      readonly schema?: string;
      readonly table: string;
      readonly pk: StructuredPk;
    }
  | {
      readonly kind: "createTable";
      readonly schema?: string;
      readonly table: string;
      readonly columns: ReadonlyArray<StructuredColumnDef>;
      readonly primaryKey?: ReadonlyArray<string>;
    };

/**
 * The single `execute` request shape, discriminated by `shape`:
 *  - `raw` — opaque SQL text, classified default-deny + multi-statement-rejected.
 *  - `structured` — a typed single-row DML / CREATE TABLE op (path a).
 * `confirmed` gates any statement the executor classifies as needing confirmation
 * (raw mutations/DDL, structured `delete`); absent/`false` ⇒ nothing runs.
 */
export type ExecuteRequest =
  | { readonly shape: "raw"; readonly sql: string; readonly confirmed?: boolean }
  | { readonly shape: "structured"; readonly op: StructuredOp; readonly confirmed?: boolean };

/**
 * The outcome of an `execute` RPC — a DOMAIN result carried inside a successful
 * {@link RpcReply} (mirroring {@link ConnectResult}), discriminated by `status`:
 *  - `rows` — a read ran; `data` is the Core-capped {@link FrozenData}, `truncated`
 *    is set when the result set exceeded the Core row cap.
 *  - `ok` — a mutation/DDL committed; `rowsAffected` is the engine's count.
 *  - `confirmation_required` — a needs-confirm statement was NOT executed; `preview`
 *    carries the composed/echoed SQL + a short risk string for the confirm prompt.
 * A protocol violation (smuggling, multi-statement, malformed op) is NOT here — it
 * surfaces as a `bad_request` error envelope.
 */
export type ExecuteResult =
  | { readonly status: "rows"; readonly data: FrozenData; readonly truncated: boolean }
  | { readonly status: "ok"; readonly rowsAffected: number }
  | {
      readonly status: "confirmation_required";
      readonly preview: { readonly sql: string; readonly risk: string };
    };

/* ------------------------------------------------------------------ *
 * RPC contract — request / reply / error envelope
 * ------------------------------------------------------------------ */

/** Canonical error codes for the single error envelope. */
export type RpcErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "unknown_method"
  | "bad_request"
  | "not_found"
  | "method_not_allowed"
  | "internal_error";

/**
 * The single error envelope shape (AD wire conventions). Every failed RPC reply
 * is exactly this — never a naked/untyped error.
 */
export type RpcErrorEnvelope = {
  readonly code: RpcErrorCode;
  readonly message: string;
  readonly detail?: string;
};

/** A typed RPC request. `method` selects a dispatch entry; `params` is method-typed. */
export type RpcRequest = {
  readonly method: string;
  readonly params?: unknown;
};

/** Result payload for the `health` method. */
export type HealthResult = {
  readonly status: "ok";
  readonly schemaVersion: FrozenSchemaVersion;
};

/** Result payload for the `shutdown` method. Ack-before-teardown (AD-notes). */
export type ShutdownResult = {
  readonly stopping: true;
};

/**
 * Boot-time port-exposure state, handed to the UI via the `window.__QS_EXPOSURE__`
 * global (NOT an RPC — it is known at boot and static for the session). When
 * `exposed` is true the server bound a non-loopback address, so the UI renders
 * the Port-Exposure Warning banner. `host`/`port` name the bound authority so
 * the banner's revert copy can be composed in the UI.
 */
export type ExposureInfo = {
  readonly exposed: boolean;
  readonly host: string;
  readonly port: number;
};

/**
 * A discriminated RPC reply: either a typed OK result or the error envelope.
 * `T` is the method's typed result payload.
 */
export type RpcReply<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: RpcErrorEnvelope };

/** Construct a successful typed reply. */
export function okReply<T>(result: T): RpcReply<T> {
  return { ok: true, result };
}

/** Construct a failed reply carrying the single error envelope. */
export function errorReply(
  code: RpcErrorCode,
  message: string,
  detail?: string,
): RpcReply<never> {
  const error: RpcErrorEnvelope =
    detail === undefined ? { code, message } : { code, message, detail };
  return { ok: false, error };
}
