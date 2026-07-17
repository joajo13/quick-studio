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

import { parseChartSpec, type ChartSpec } from "./chart-spec.ts";

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

/**
 * The session run mode surfaced to the UI alongside the active connection. Defined
 * INLINE here (not imported from the Core `RunMode`) so this shared, ring-neutral
 * contract stays free of Core dependencies. The Core `RunMode` is structurally
 * assignable to this literal, so `server.ts` passes `mode` through directly.
 */
export type ConnectionMode = "ephemeral" | "persistent";

/**
 * A credential-free view of the in-memory ACTIVE connection — the ephemeral boot
 * target held in Core memory (the DB an Ephemeral session is browsing) — sent Core→UI
 * for a read-only "active connection" entry in Settings. It carries ONLY non-sensitive
 * fields derived in Core from the (secret-bearing) url via `new URL()` — the raw url,
 * user, and password never cross this boundary, mirroring {@link ConnectionSummary}.
 * `connection` is `null` when no in-memory boot target is set (e.g. a Persistent boot,
 * where per-target browsing is chosen per-request and not surfaced here).
 */
export type ActiveConnectionInfo = {
  readonly mode: ConnectionMode;
  /** Non-sensitive derived identity of the in-memory active target, or null when none is configured. */
  readonly connection: {
    readonly engine: string; // URL.protocol without the trailing colon (e.g. "postgres")
    readonly host: string; // URL.host (host[:port]) — never userinfo
    readonly database?: string; // optional, non-sensitive (URL.pathname sans leading slash); NEVER user/password
  } | null;
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
 * Chat Q&A contract (Story 5.2) — schema-only, Core-sole-caller
 * ------------------------------------------------------------------ */

/**
 * A row-free projection of the live {@link DatabaseSchema} — the ONLY database
 * context that leaves the machine (AR-6 / R5). `text` is the compact, deterministic
 * serialization (table/column names, `dataType`, primary keys, foreign keys — no
 * rows) fed to the model as its system context; `tables` is the table count for the
 * inspectable summary. Assembled Core-side; carries zero row data by construction.
 */
export type SchemaForModel = {
  readonly engine: DbEngine;
  readonly text: string;
  readonly tables: number;
};

/**
 * The outbound provider payload assembled Core-side. `schema` and `rowSample` are
 * DISTINCT fields so the AR-6 separation is structural, not incidental: `rowSample`
 * is ALWAYS `null` through Story 5.3 (zero rows leave the machine — 5.3 produces and
 * runs queries but sends no result rows outbound). A FUTURE per-query row opt-in is
 * what would ever populate `rowSample` — this shape wires that seam now without
 * shipping any row-sending path.
 */
export type ChatProviderPayload = {
  readonly schema: SchemaForModel;
  readonly rowSample: null;
};

/**
 * The schema-only context summary returned alongside an answer — the visible proof
 * of the default policy. `policy` is the literal `"schema-only"`; `tables` is how
 * many tables were summarized; `rowsIncluded` is the literal `0` (no rows sent).
 */
export type ChatContextSummary = {
  readonly policy: "schema-only";
  readonly tables: number;
  readonly rowsIncluded: 0;
};

/**
 * One frame of the streaming chat response (Story 5.4) — the typed SSE wire shape
 * shared across Ring 1 (Core producer) and Ring 2 (UI consumer). A discriminated
 * union carried one-per-`data:` event over `POST /chat/stream`:
 *  - `text-delta` — a token of the final ANSWER channel (rendered incrementally).
 *  - `reasoning-delta` — a token of the model's REASONING channel (rendered in a
 *    visually distinct secondary treatment; absent entirely when the provider emits
 *    no reasoning — never an error).
 *  - `done` — the terminal frame: the Core-extracted `query` (pure fenced-block
 *    extraction over the fully-accumulated answer, `null` when none) plus the
 *    schema-only `context` summary — feeds the unchanged 5.3 run/confirm affordance.
 *  - `error` — a redacted terminal failure (pre-flight validation OR a mid-stream
 *    provider throw). Carries a mapped {@link RpcErrorCode} + a terse message; the
 *    provider key NEVER appears here (redacted, stderr-only in Core).
 * Ring-neutral and types-only — carries no rows and no key by construction.
 */
export type ChatStreamChunk =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "done"; readonly query: string | null; readonly context: ChatContextSummary }
  | { readonly type: "error"; readonly code: RpcErrorCode; readonly message: string };

/* ------------------------------------------------------------------ *
 * Sandbox postMessage protocol (Story 5.5) — one-way data, Ring 3
 * ------------------------------------------------------------------ */

/**
 * Version of the Ring 2 <-> Ring 3 `postMessage` protocol. Bump on any breaking
 * change to {@link SandboxInbound} / {@link SandboxOutbound}. Both directions
 * carry the version so a mismatched host and guest reject each other's frames
 * rather than mis-parsing them.
 */
export const SANDBOX_PROTOCOL_VERSION = 2 as const;
export type SandboxProtocolVersion = typeof SANDBOX_PROTOCOL_VERSION;

/** Upper bound on the (UNTRUSTED, model-authored) Markdown pushed to the guest. */
export const MAX_SANDBOX_MARKDOWN_LENGTH = 20000;

/**
 * The render-frame payload (Story 5.6): the trusted guest bundle draws exactly this —
 * escaped Markdown prose, an optional validated {@link ChartSpec}, and the canonical
 * {@link FrozenData} the chart channels reference. Carries no code, no secret, no handle.
 */
export type SandboxRenderDoc = {
  readonly markdown: string;
  readonly chart: ChartSpec | null;
  readonly data: FrozenData;
};

/**
 * A frame pushed Ring 2 -> guest (host -> Ring 3). One-way for DATA: the ONLY
 * inbound frame is `render`, which carries already-public canonical
 * {@link FrozenData} plus escaped Markdown and an optional validated {@link ChartSpec}
 * (Story 5.6). There is deliberately NO inbound frame that can hand the guest a secret,
 * a live handle, or a capability, and none that asks the guest to request data or trigger
 * a query — that separation is structural, not policy. `markdown` is untrusted text
 * (length-capped); `chart` is `null` or a spec whose channels name existing `data` columns.
 */
export type SandboxInbound = {
  readonly type: "render";
  readonly protocolVersion: SandboxProtocolVersion;
  readonly markdown: string;
  readonly chart: ChartSpec | null;
  readonly data: FrozenData;
};

/**
 * A frame emitted guest -> Ring 2 (Ring 3 -> host). Render-lifecycle and
 * interaction SIGNALS only — never data:
 *  - `ready` — the guest has drawn the current frame.
 *  - `height` — the guest's measured content height in CSS px (for iframe sizing).
 *  - `datum-clicked` — the user clicked a rendered cell at `{row,col}` (grid
 *    coordinates into the pushed `FrozenData`, never the cell's value).
 *  - `error` — the guest failed to render; carries a terse message, never data.
 *    `message` is UNTRUSTED guest-authored text — treat it as opaque, never as
 *    markup/HTML, and the guard caps its length (see {@link isSandboxOutbound}).
 * The union structurally cannot carry `FrozenData` or a query — that is what makes
 * "capability never flows inward" provable at the type level.
 */
export type SandboxOutbound =
  | { readonly type: "ready"; readonly protocolVersion: SandboxProtocolVersion }
  | { readonly type: "height"; readonly protocolVersion: SandboxProtocolVersion; readonly px: number }
  | {
      readonly type: "datum-clicked";
      readonly protocolVersion: SandboxProtocolVersion;
      readonly row: number;
      readonly col: number;
    }
  | { readonly type: "error"; readonly protocolVersion: SandboxProtocolVersion; readonly message: string };

/**
 * Pure runtime guard for an inbound frame (Story 5.6). Accepts ONLY a `render` frame at
 * the current protocol version whose:
 *  - `markdown` is a string capped at {@link MAX_SANDBOX_MARKDOWN_LENGTH} (untrusted text);
 *  - `data` is valid {@link FrozenData} (delegated to {@link decode}, so the guest never
 *    re-derives the schema rules);
 *  - `chart` is `null` OR a {@link ChartSpec} that passes {@link parseChartSpec} against
 *    the decoded `data`'s column names (so no channel can reference an absent column).
 * Rejects a wrong tag, a wrong/absent version, a non-object, bad markdown, an invalid
 * chart, and invalid data. Total: never throws (a `decode` throw is swallowed into `false`).
 */
export function isSandboxInbound(value: unknown): value is SandboxInbound {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as {
    readonly type?: unknown;
    readonly protocolVersion?: unknown;
    readonly markdown?: unknown;
    readonly chart?: unknown;
    readonly data?: unknown;
  };
  if (frame.type !== "render") return false;
  if (frame.protocolVersion !== SANDBOX_PROTOCOL_VERSION) return false;
  if (typeof frame.markdown !== "string" || frame.markdown.length > MAX_SANDBOX_MARKDOWN_LENGTH) return false;
  let data: FrozenData;
  try {
    data = decode(frame.data as FrozenData);
  } catch {
    return false;
  }
  // `chart` MUST be exactly `null` or a spec valid against the pushed columns. `undefined`
  // (an absent field) is not admissible — the frame must carry an explicit chart-or-null.
  if (frame.chart !== null) {
    const columnNames = data.columns.map((c) => c.name);
    if (parseChartSpec(frame.chart, columnNames) === null) return false;
  }
  return true;
}

/**
 * Pure runtime guard for an outbound signal. Validates the tag + version and the
 * per-tag shape. Rejects a wrong/absent version, an unknown tag, a non-object, and
 * a numeric field that is not a finite number. Bounds every untrusted field the
 * guest controls: `height.px` must be non-negative, `datum-clicked` coordinates must
 * be non-negative integers (never a negative index into the grid), and `error.message`
 * — untrusted guest text — is length-capped so a hostile guest cannot flood the host.
 * There is no branch that admits data because the union has no such member. Total:
 * never throws.
 */
export function isSandboxOutbound(value: unknown): value is SandboxOutbound {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as {
    readonly type?: unknown;
    readonly protocolVersion?: unknown;
    readonly px?: unknown;
    readonly row?: unknown;
    readonly col?: unknown;
    readonly message?: unknown;
  };
  if (frame.protocolVersion !== SANDBOX_PROTOCOL_VERSION) return false;
  switch (frame.type) {
    case "ready":
      return true;
    case "height":
      return typeof frame.px === "number" && Number.isFinite(frame.px) && frame.px >= 0;
    case "datum-clicked":
      return (
        typeof frame.row === "number" &&
        Number.isInteger(frame.row) &&
        frame.row >= 0 &&
        typeof frame.col === "number" &&
        Number.isInteger(frame.col) &&
        frame.col >= 0
      );
    case "error":
      // `message` is untrusted guest-authored text — cap its length defensively.
      return typeof frame.message === "string" && frame.message.length <= 1000;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ *
 * Workspace-state persistence contract (Story 2.5) — credential-free
 * ------------------------------------------------------------------ */

/**
 * The kinds of Tab the Workspace can hold — the SINGLE source of truth (Core
 * validation and the UI's `workspace-state.ts` both import this, so they can never
 * drift). The FIRST FIVE are document kinds; their order matches the launcher-rail
 * order (the UI iterates that subset via `LAUNCHER_KINDS`). `"settings"` is a SYSTEM
 * SINGLETON tab (at most one open), NOT a launcher-rail kind — it is reached from the
 * bottom-pinned rail Settings control, never a per-kind launcher button. Added as an
 * ADDITIVE enum member (Story 8.6), so Core validation, both `isTabKind` guards, and
 * the persisted {@link WorkspaceSnapshotTab.kind} accept it with no hand-edit and no
 * snapshot-version bump (a pre-8.6 snapshot of only document kinds still loads).
 */
export const WORKSPACE_TAB_KINDS = ["table", "query", "erd", "chat", "report", "settings"] as const;

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
 *
 * `lastProvider` (Story 8.5) is an ADDITIVE optional field — the last-used chat provider
 * kind, a lightweight UX default hint for the chat provider picker. It follows the same
 * additive-optional posture as `erdLayouts` (a pre-8.5 v1 snapshot has none and loads
 * cleanly, no version bump). It carries NO key and NO row/chat content — chat messages
 * and per-Tab chat state still never touch disk.
 */
export type WorkspaceSnapshot = {
  readonly version: 1;
  readonly panelSizes: ReadonlyArray<number>;
  readonly tabs: ReadonlyArray<WorkspaceSnapshotTab>;
  readonly activeTabId: number | null;
  readonly nextId: number;
  readonly erdLayouts?: Record<string, ErdTabLayout>;
  readonly lastProvider?: ProviderKind;
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
  | { readonly shape: "raw"; readonly sql: string; readonly confirmed?: boolean; readonly connectionId?: string | null }
  | { readonly shape: "structured"; readonly op: StructuredOp; readonly confirmed?: boolean; readonly connectionId?: string | null };

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
 * Result payload for `livereport.publish` (Story 6.4). The Core stores the published
 * layout+SQL {@link LiveReportDoc} (never data, never a credential) under an opaque id and
 * returns the same-origin loopback `path` (`/live/<id>`) the UI opens to view it live. Only
 * the local Core ever sees the doc — nothing is sent to any external service.
 */
export type LiveReportPublishResult = {
  readonly path: string;
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
