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
