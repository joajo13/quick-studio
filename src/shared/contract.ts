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
import type { ReportSpec } from "./report-spec.ts";

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

/**
 * The five legal {@link FrozenCell} kinds, as runtime data. Exists because the boundary
 * validator has to CHECK a column's declared `type` against them — TypeScript's union
 * evaporates at runtime, and a `columns` array arriving from a `postMessage` frame or a
 * persisted snapshot has never been through the compiler. Kept adjacent to the union so
 * a new kind cannot be added to one without the other staring back.
 */
const FROZEN_CELL_KINDS: ReadonlySet<FrozenCell["kind"]> = new Set([
  "null",
  "string",
  "number",
  "boolean",
  "date",
]);

export type FrozenColumn = {
  readonly name: string;
  /** Neutral cell kind expected for this column. */
  readonly type: FrozenCell["kind"];
  /**
   * The column's SQL type as the engine names it, canonicalized to trimmed lowercase
   * (e.g. `bigint`, `numeric`, `double precision`, `timestamp without time zone`) —
   * a parallel DISPLAY/BINDING hint, never the runtime cell kind (DW-30/34/35/40).
   *
   * OPTIONAL by design, so {@link FROZEN_SCHEMA_VERSION} stays `1`: a persisted
   * snapshot, a hand-built fixture, or a driver with no type metadata simply has none
   * and every consumer must reproduce its pre-`dataType` behavior byte-for-byte.
   * `type` remains the TRUTHFUL runtime kind (a driver-stringified `bigint` is a
   * `string` column; a tz-less wall-clock is a `string` column), which is what keeps
   * `assertWellFormed`'s kind-matches-type rule and the `date`-cell `Z` invariant
   * intact — `dataType` only tells the grid how to COLOUR/ALIGN it and tells the
   * mutation builder to bind it as an exact string rather than through `Number()`.
   */
  readonly dataType?: string;
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
 * SQL `dataType` classification — the one ring-neutral source of truth
 * ------------------------------------------------------------------ */

/**
 * The exact-INTEGER SQL types: the subset of the exact numerics that admits no
 * fractional part at all. Split out because the two halves validate DIFFERENTLY on
 * write — a `12.5` typed into a `bigint` cell must be rejected client-side rather than
 * shipped to an engine that would round it (Postgres) or error (MySQL strict mode) —
 * even though both halves bind as exact strings. `int8` is the Postgres internal
 * spelling of `bigint`; both appear depending on whether the name came from
 * `information_schema` or from the ad-hoc OID map.
 */
const EXACT_INTEGER_TYPES: ReadonlySet<string> = new Set(["bigint", "int8"]);

/** The exact-DECIMAL SQL types: arbitrary-precision, fractional part allowed. */
const EXACT_DECIMAL_TYPES: ReadonlySet<string> = new Set(["numeric", "decimal"]);

/**
 * The exact-numeric SQL types (DW-35/DW-40): values that do NOT fit a JS `number`
 * without silently losing digits. They travel as STRINGS end-to-end — on read (both
 * drivers hand back strings), on write, and in PK addressing — so no code path may
 * ever run one through `Number()`.
 */
const EXACT_NUMERIC_TYPES: ReadonlySet<string> = new Set([
  ...EXACT_INTEGER_TYPES,
  ...EXACT_DECIMAL_TYPES,
]);

/**
 * Numeric SQL types that are DISPLAY-only: they fit a JS `number` losslessly (or are
 * inexact by nature), so they need the grid's numeric colour/label/right-alignment but
 * no exact-string binding. Deliberately disjoint from {@link EXACT_NUMERIC_TYPES}.
 */
const DISPLAY_NUMERIC_TYPES: ReadonlySet<string> = new Set([
  "integer",
  "int",
  "int2",
  "int4",
  "smallint",
  "mediumint",
  "tinyint",
  "real",
  "float",
  "double",
  "double precision",
  "money",
]);

/**
 * The tz-LESS temporal types (DW-34). A value in one of these has no instant attached:
 * `2026-07-22 18:14:13` means that wall-clock reading, not a moment in UTC. Both drivers
 * nonetheless materialize it as a LOCAL-time JS `Date`, so routing it through `toIsoUtc`
 * would stamp a false `Z` and shift the printed value by the host's offset. It is
 * therefore mapped to a literal wall-clock `string` cell instead — never a `date` cell
 * with a stripped suffix, which would violate the `date`-cell `Z` invariant.
 *
 * Note MySQL's bare `timestamp` is deliberately ABSENT (it is session-tz converted, i.e.
 * genuinely tz-aware) while MySQL's `datetime` is present; Postgres never emits a bare
 * `timestamp` from `information_schema.columns`, so the name is unambiguous.
 */
const NAIVE_DATETIME_TYPES: ReadonlySet<string> = new Set([
  "timestamp without time zone",
  "datetime",
]);

/** The tz-AWARE temporal types — these keep today's UTC `date` cell, untouched. */
const AWARE_DATETIME_TYPES: ReadonlySet<string> = new Set([
  "timestamp with time zone",
  "timestamptz",
  "timestamp",
]);

/** Canonicalize an engine type name for lookup: trimmed, lowercase. */
function canonicalSqlType(dataType: string | undefined): string | null {
  if (typeof dataType !== "string") return null;
  const t = dataType.trim().toLowerCase();
  return t.length === 0 ? null : t;
}

/**
 * True iff `dataType` names an exact-numeric SQL type whose values must be carried,
 * bound, and PK-addressed as STRINGS (see {@link EXACT_NUMERIC_TYPES}). Total: an
 * absent/unknown `dataType` is `false`, which is exactly the pre-`dataType` behavior.
 */
export function isExactNumericType(dataType?: string): boolean {
  const t = canonicalSqlType(dataType);
  return t !== null && EXACT_NUMERIC_TYPES.has(t);
}

/**
 * True iff `dataType` names an exact-numeric type that admits NO fractional part
 * (see {@link EXACT_INTEGER_TYPES}) — the write-side gate that rejects `12.5` for a
 * `bigint` column while `numeric` accepts it. A strict subset of
 * {@link isExactNumericType}; total in the same way.
 */
export function isExactIntegerType(dataType?: string): boolean {
  const t = canonicalSqlType(dataType);
  return t !== null && EXACT_INTEGER_TYPES.has(t);
}

/**
 * True iff `dataType` names a tz-less temporal type whose values must be emitted as
 * literal wall-clock strings rather than UTC `date` cells (DW-34). Total: an absent or
 * unrecognized `dataType` is `false`, so the aware/legacy path is unchanged.
 */
export function isNaiveDateTimeType(dataType?: string): boolean {
  const t = canonicalSqlType(dataType);
  return t !== null && NAIVE_DATETIME_TYPES.has(t);
}

/**
 * Classify a SQL `dataType` into the neutral cell kind the UI should DISPLAY it as —
 * independent of how the value is actually represented on the wire. This is what makes
 * a string-encoded `bigint`/`numeric` render as a right-aligned numeric column (DW-30)
 * and a wall-clock `string` column still read as temporal.
 *
 * Returns `undefined` for an absent `dataType` AND for any engine type outside the
 * canonical maps (`inet`, `geometry`, `date`, `time`, `uuid`, `json`, …), so the caller
 * falls back to the neutral cell kind — the pre-change behavior, byte-for-byte.
 */
export function classifySqlDisplayKind(dataType?: string): "number" | "date" | "boolean" | undefined {
  const t = canonicalSqlType(dataType);
  if (t === null) return undefined;
  if (EXACT_NUMERIC_TYPES.has(t) || DISPLAY_NUMERIC_TYPES.has(t)) return "number";
  if (NAIVE_DATETIME_TYPES.has(t) || AWARE_DATETIME_TYPES.has(t)) return "date";
  if (t === "boolean") return "boolean";
  return undefined;
}

/**
 * The kind a {@link FrozenColumn} should be PRESENTED as: its SQL classification when
 * one exists, else its neutral runtime `type`. The single accessor every display-side
 * decision (type colour, type label, right-alignment, `tabular-nums`) goes through, so
 * a column with no `dataType` behaves exactly as it did before this field existed.
 */
export function frozenColumnDisplayKind(col: FrozenColumn): FrozenCell["kind"] {
  return classifySqlDisplayKind(col.dataType) ?? col.type;
}

/* ------------------------------------------------------------------ *
 * ISO-8601 UTC date helpers — pure & total, throw on invalid
 * ------------------------------------------------------------------ */

/**
 * Strict ISO-8601 UTC pattern: `YYYY-MM-DDTHH:MM:SS(.sss)?Z`.
 * Only the trailing `Z` (Zulu / UTC) is accepted — numeric offsets are rejected
 * so there is exactly one canonical encoding on the wire. Milliseconds (`\.\d{1,3}`)
 * are the canonical precision limit (DW-6); {@link normalizeIsoUtc} floors an
 * over-precise instant down to this before {@link assertIsoUtc} ever sees it.
 * Exported for the drift property test in `contract.test.ts` only.
 */
export const ISO_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * A `Z`-only, capture-grouped MIRROR of {@link ISO_UTC_RE} used solely by
 * {@link normalizeIsoUtc} to split off the fractional-seconds field for truncation.
 * It differs from the strict pattern in exactly one way — it admits any number of
 * fractional digits (`\.(\d+)`) rather than 1-3 — so an over-precise instant can be
 * matched and floored; it must NOT admit any new timezone form (still `Z`-only), so a
 * non-UTC offset stays un-matched and falls through to {@link assertIsoUtc}'s verdict.
 * Exported for the drift property test in `contract.test.ts` only.
 */
export const ISO_UTC_LENIENT_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

/**
 * Build the error message for a rejected ISO input, shared by {@link assertIsoUtc} and
 * {@link normalizeIsoUtc} so the whole defect class has one message shape. NEVER calls
 * `JSON.stringify` on the raw value — a BigInt or a cyclic object (both reachable from an
 * untrusted `postMessage` frame) would make it throw — and caps the echoed text at ~80
 * chars so an unbounded untrusted string cannot be reflected whole into the message.
 */
function describeIsoInput(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value);
  const echo = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
  return `Invalid ISO-8601 UTC date: ${JSON.stringify(echo)} (expected e.g. 2026-07-06T12:00:00Z)`;
}

/**
 * Assert that `iso` is a valid ISO-8601 UTC instant. Throws (never returns a
 * falsy value) so callers can rely on totality: after this returns, `iso` is a
 * canonical UTC string. Stays STRICT — a 4+-digit fractional field is non-canonical
 * and rejected; canonicalizing precision is {@link normalizeIsoUtc}'s job, not this one.
 */
export function assertIsoUtc(iso: string): void {
  if (typeof iso !== "string" || !ISO_UTC_RE.test(iso)) {
    throw new TypeError(describeIsoInput(iso));
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
 * Canonicalize the *precision* of an ISO-8601 UTC instant to the frozen-date model's
 * millisecond limit (DW-6): a fractional-seconds field with more than 3 digits is
 * TRUNCATED (never rounded) to its first 3, so a Postgres/MySQL microsecond timestamp
 * that reached this boundary — from a hand-edited Snapshot or a `postMessage` frame —
 * is canonicalized instead of failing the whole payload. Everything else is delegated to
 * {@link assertIsoUtc} for the verdict: a non-UTC offset, an impossible calendar date, an
 * empty fractional part, and 0-3 in-policy digits behave exactly as before (an in-policy
 * string is returned byte-identical, so this is idempotent and existing round-trip equality
 * holds). Truncation is a `slice(0, 3)` on the captured DIGIT STRING — no arithmetic and no
 * `Date` — so it cannot round and cannot carry into the seconds field: `…:59.999999Z` floors
 * to `…:59.999Z` with the second unchanged, and the instant never moves forward in time. This
 * canonicalizes precision ONLY, not spelling — `.5Z`/`.50Z`/`.500Z` stay three distinct
 * in-policy strings, since the wire contract locks byte-identical passthrough for anything
 * already within policy.
 */
export function normalizeIsoUtc(iso: string): string {
  if (typeof iso !== "string") throw new TypeError(describeIsoInput(iso));
  const m = ISO_UTC_LENIENT_RE.exec(iso);
  const frac = m?.[2];
  // No match, or already in policy → pass through and let assertIsoUtc render the verdict.
  const out = m && frac !== undefined && frac.length > 3 ? `${m[1]}.${frac.slice(0, 3)}Z` : iso;
  assertIsoUtc(out);
  return out;
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
  // This loop is the FIRST thing in the whole assertion to dereference a column entry,
  // so it owns the entry's ENTIRE shape check — nothing downstream re-validates it, and
  // `rebuildColumn` copies `name`/`type` through verbatim. Four rules, in the order a
  // malformed entry would otherwise blow up:
  //
  //  1. The entry is a non-null, non-ARRAY object. `columns: [null]` would otherwise die
  //     with an unlabelled `Cannot read properties of null`, losing the index that tells
  //     the caller WHICH entry is bad; `columns: [[]]` is worse still — an array passes
  //     `typeof === "object"`, carries `name: undefined`/`type: undefined`, and sails
  //     through to an exported snapshot that renders the header as `[object Object]`.
  //  2. `name` is a string. It is interpolated into this function's own error messages
  //     (below, and in the cell-kind loop), so the rest of the assertion already assumes
  //     it — and it becomes a rendered column header downstream.
  //  3. `type` is one of the five {@link FrozenCell} kinds. The cell-kind rule below
  //     compares each cell's `kind` against it; a bogus `type` makes that comparison
  //     vacuously reject every non-null cell (or, on an all-null page, pass silently and
  //     ship a column whose declared kind names nothing).
  //  4. `dataType`, which is OPTIONAL, is a STRING when present — it is carried verbatim
  //     through encode/decode and read by the grid and the mutation builder, so a
  //     non-string (a number, an object from a hand-edited snapshot or a `postMessage`
  //     frame) must be rejected here rather than reaching those consumers.
  //
  // All four produce the same LABELLED boundary error shape (`column <index>`), because
  // the caller's only handle on a rejected frame is which entry failed and why.
  for (let c = 0; c < width; c++) {
    const col = data.columns[c] as FrozenColumn | null | undefined;
    if (typeof col !== "object" || col === null || Array.isArray(col)) {
      const got = col === null ? "null" : Array.isArray(col) ? "array" : typeof col;
      throw new TypeError(`FrozenData column ${c} is not an object (got ${got})`);
    }
    if (typeof col.name !== "string") {
      throw new TypeError(`FrozenData column ${c}: name must be a string, got ${typeof col.name}`);
    }
    if (!FROZEN_CELL_KINDS.has(col.type)) {
      throw new TypeError(
        `FrozenData column ${c} ('${col.name}'): ` +
          `type must be one of ${[...FROZEN_CELL_KINDS].join("/")}, got ${JSON.stringify(col.type)}`,
      );
    }
    const dataType = col.dataType;
    if (dataType !== undefined && typeof dataType !== "string") {
      throw new TypeError(
        `FrozenData column ${c} ('${col.name}'): ` +
          `dataType must be a string when present, got ${typeof dataType}`,
      );
    }
  }
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
 * non-UTC date, while canonicalizing an over-precise date cell's precision to
 * milliseconds (see {@link normalizeIsoUtc}). `decode(encode(x))` deep-equals `x`
 * when every date cell is already within policy (≤3 fractional digits); an over-precise
 * cell is floored, so the round-trip law holds from `encode(x)` onward.
 */
export function encode(data: FrozenData): FrozenData {
  if (data.schemaVersion !== FROZEN_SCHEMA_VERSION) {
    throw new TypeError(
      `Unsupported frozen schema version: ${String(data.schemaVersion)} (expected ${FROZEN_SCHEMA_VERSION})`,
    );
  }
  assertWellFormed(data);
  const columns = data.columns.map(rebuildColumn);
  const rows = data.rows.map((row) => row.map(encodeCell));
  return { schemaVersion: FROZEN_SCHEMA_VERSION, columns, rows };
}

/**
 * Decode a wire-form {@link FrozenData} back into the in-memory shape. Pure and
 * total: applies the same ISO-8601 UTC invariant on every date cell, canonicalizing an
 * over-precise instant's precision down to milliseconds (see {@link normalizeIsoUtc})
 * rather than only enforcing it.
 */
export function decode(data: FrozenData): FrozenData {
  if (data.schemaVersion !== FROZEN_SCHEMA_VERSION) {
    throw new TypeError(
      `Unsupported frozen schema version: ${String(data.schemaVersion)} (expected ${FROZEN_SCHEMA_VERSION})`,
    );
  }
  assertWellFormed(data);
  const columns = data.columns.map(rebuildColumn);
  const rows = data.rows.map((row) => row.map(decodeCell));
  return { schemaVersion: FROZEN_SCHEMA_VERSION, columns, rows };
}

/**
 * Rebuild ONE column from an explicit field WHITELIST — deliberately not a blind
 * `{...c}` spread, so an unknown/hostile property on an inbound frame can never be
 * laundered into the canonical wire shape. `dataType` joins the whitelist (it is real
 * contract, not decoration) and is OMITTED ENTIRELY when absent rather than written as
 * `dataType: undefined`: a pre-`dataType` payload must round-trip to a byte-identical
 * object, and `JSON.stringify` would drop the key anyway — leaving it in would make
 * `decode(encode(x))` differ from `x` under a strict structural comparison.
 */
function rebuildColumn(c: FrozenColumn): FrozenColumn {
  return c.dataType === undefined
    ? { name: c.name, type: c.type }
    : { name: c.name, type: c.type, dataType: c.dataType };
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
      // Canonicalize precision (DW-6): an over-precise instant is floored to milliseconds
      // rather than rejected; an in-policy `iso` comes back byte-identical. `normalizeIsoUtc`
      // hands the result to `assertIsoUtc`, so a non-UTC / bad-calendar date still throws.
      return { kind: "date", iso: normalizeIsoUtc(cell.iso) };
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
 * What KIND of relation a {@link SchemaTableInfo} describes — a neutral STRUCTURAL
 * fact, not an ordering/UI hint (DW-33):
 *  - `table` — a physically stored, directly scannable relation (Postgres `relkind`
 *    `r`/`m`, MySQL `BASE TABLE`). Only such a relation is guaranteed to expose the
 *    engine's physical row locator.
 *  - `view` — a virtual relation computed on read (Postgres `v`, MySQL `VIEW`/
 *    `SYSTEM VIEW`). Introspected and browsable like a table, but has no storage.
 *  - `other` — anything else the engine reports (a Postgres partitioned parent `p` or
 *    foreign table `f`, a MySQL non-standard `table_type`): browsable, but NOT known
 *    to be physically stored.
 * Deliberately absent from this union is "unknown": the field itself is OPTIONAL, so a
 * schema assembled without relation metadata simply omits it and every consumer must
 * treat the absent case as unknown (the conservative arm).
 */
export type SchemaRelationKind = "table" | "view" | "other";

/**
 * One table (or view) of the introspected schema. `schema` is the owning
 * namespace/database as the engine reports it; `name` and `columns` mirror the
 * live database verbatim, ordered as introspected (schema/table/ordinal).
 * `primaryKey` lists the primary-key column names in key order (the PK's own
 * column ordinal order, empty when the table has none) — the deterministic browse
 * ORDER-BY key and the source of the grid's PK key-icon (Story 3.2). `indexes` lists the table's indexes
 * (Story 3.5), each with its ordered columns and uniqueness (empty when the table
 * has none) — mirroring how `primaryKey` is always present. `foreignKeys` lists the
 * table's outbound foreign keys (Story 4.1) — the ERD's edge source (empty when the
 * table has none). All three are introspected eagerly at connect time and folded in
 * the assembler.
 *
 * `kind` (DW-33) is the OPTIONAL structural {@link SchemaRelationKind}. It is absent
 * whenever the schema was assembled without relation metadata (a pre-DW-33 fixture, a
 * hand-built test schema, an engine row whose catalog join found nothing), and absent
 * MUST be read as "unknown", never as "table" — the browse planner's physical-row-locator
 * branch keys on it, and a wrong "table" on a view would compose an `ORDER BY ctid` the
 * engine rejects. It states a neutral fact about the relation only; no ordering semantics
 * leak into the wire contract.
 */
export type SchemaTableInfo = {
  readonly schema: string;
  readonly name: string;
  readonly columns: ReadonlyArray<SchemaColumnInfo>;
  readonly primaryKey: ReadonlyArray<string>;
  readonly indexes: ReadonlyArray<SchemaIndexInfo>;
  readonly foreignKeys: ReadonlyArray<SchemaForeignKeyInfo>;
  readonly kind?: SchemaRelationKind;
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
 *  - `database-does-not-exist` — host+auth were fine but the named catalog is
 *    missing (PG SQLSTATE `3D000`, MySQL `ER_BAD_DB_ERROR`/errno `1049`, DW-18).
 *  - `malformed-url` — a supported-scheme URL that `new URL()` cannot parse (a
 *    bad/out-of-range port or unparseable authority) — structurally rejected by
 *    {@link createDriver} before any socket opens; distinct from an unsupported scheme.
 *  - `no-target` — no connection target is configured at all (`databaseUrl === null`).
 *    The normal shape of a Persistent boot before any connection is saved — NOT a URL
 *    problem, and distinct from `unsupported_scheme` (which is a genuinely bad scheme).
 */
export type ConnectionFailureKind =
  | "host"
  | "auth"
  | "network"
  | "unsupported_scheme"
  | "database-does-not-exist"
  | "malformed-url"
  | "no-target";

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

/**
 * Params for `connect` (Story 10.4). `connectionId` names a SAVED connection to open +
 * introspect; absent/`null` ⇒ the boot connection (the byte-identical pre-10.4 call, which
 * is what every current UI call site still sends). Only the opaque id crosses the loopback
 * — the url/user/password are resolved in Core (AR-12) and never echoed back.
 */
export type ConnectRequest = {
  readonly connectionId?: string | null;
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
  /**
   * The saved connection to browse (Story 10.4), resolved in Core through the same
   * per-target pool `execute` uses; absent/`null` ⇒ the boot connection. Only the opaque
   * id crosses the loopback — never a url or credential (AR-12). Note this is the THIRD
   * `schema`-adjacent axis in one request: `schema` above qualifies the table NAME within
   * the target, while `connectionId` selects WHICH database is introspected at all.
   */
  readonly connectionId?: string | null;
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
  /**
   * Optional pinned introspection scope (Story 10.2): the single schema introspection
   * is restricted to WHEREVER this saved connection is resolved as a target (the
   * per-connection resolver); absent means every non-system schema, the pre-10.2
   * default. Since Story 10.4 every read path — `connect`, `table.rows`, and chat —
   * resolves through that per-connection resolver, so a request carrying this record's
   * `connectionId` DOES honor the pin. The boot connection (a CLI `--url`, i.e. no saved
   * record) has no pin to honor and stays the default target for a request that sends no
   * id — which is still every UI call site today; adopting the id in the tree and the
   * tabs is Story 10.5 / 10.6. Distinct from the two
   * other `schema` meanings in this file: {@link TableRowsRequest.schema} qualifies a
   * single table name, and {@link ConnectResult.schema} IS the introspected catalog.
   * Additive-optional and credential-free, so a UI that does not know the field still
   * round-trips.
   */
  readonly schema?: string;
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
  /**
   * Whether a boot target is CONFIGURED at all (Story 10.5). Deliberately a single
   * boolean, not a tri-state: `connection` collapses "nothing configured" and
   * "configured but not describable" (a url that parses with no host, e.g.
   * `postgres:///shop`) into the same `null`, so the multi-root schema tree could not
   * tell a genuinely-empty boot from a broken one and showed the calm empty-state for
   * both. With this, `hasTarget && connection === null` renders the boot root in
   * `error` (its own `connect` supplies the Core's engine-neutral verdict) while
   * `!hasTarget` contributes no root. Credential-free: a bare yes/no about existence.
   */
  readonly hasTarget: boolean;
};

/** Params for `connections.add`. The url carries the credentials (UI→Core only). */
export type AddConnectionParams = {
  readonly name: string;
  readonly url: string;
  /** Optional pinned introspection scope (Story 10.2). Blank/absent ⇒ unpinned. */
  readonly schema?: string;
};

/**
 * Params for `connections.edit`. Partial by design: a rename sends `name` only
 * (Core keeps the stored url the UI never held); a repoint sends the new `url`.
 */
export type EditConnectionParams = {
  readonly id: string;
  readonly name?: string;
  readonly url?: string;
  /**
   * Optional pinned introspection scope (Story 10.2). Unlike `name`/`url`, a BLANK
   * value is meaningful: it CLEARS the pin. `schema` rides on {@link ConnectionSummary},
   * so the edit form pre-fills it and an emptied field is unambiguous user intent —
   * whereas the credential-bearing url the UI never held stays "absent ⇒ keep".
   */
  readonly schema?: string;
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
 * The documented `POST /chat/stream` request body (Story 5.4; `connectionId` added by
 * Story 10.4). `provider` selects the configured key, `message` is the user's question,
 * and `connectionId` names the SAVED connection whose schema is introspected for the
 * outbound context — absent/`null` ⇒ the boot connection, the byte-identical pre-10.4
 * call the UI still makes. Targeting changes only WHICH schema is summarized: the payload
 * stays schema-only (`rowSample: null`, AR-6/R5) and no url/credential ever leaves Core.
 * Types-only — the Core still narrows the parsed body by hand (there is no validator lib).
 */
export type ChatStreamRequest = {
  readonly provider: ProviderKind;
  readonly message: string;
  readonly connectionId?: string | null;
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
 *    Story 9.7 additively widens this frame with the Core-validated `report`: a
 *    `ReportSpec` when the model emitted a well-formed ` ```report ` fence that passed
 *    `parseReportSpec`, else `null` — the sole gate for the chat's "open in report tab"
 *    affordance.
 *  - `error` — a redacted terminal failure (pre-flight validation OR a mid-stream
 *    provider throw). Carries a mapped {@link RpcErrorCode} + a terse message; the
 *    provider key NEVER appears here (redacted, stderr-only in Core).
 * Ring-neutral and types-only — carries no rows and no key by construction.
 */
export type ChatStreamChunk =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | {
      readonly type: "done";
      readonly query: string | null;
      readonly report: ReportSpec | null;
      readonly context: ChatContextSummary;
    }
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
 * inbound frame is `render`, which carries the user's own query output as canonical
 * {@link FrozenData} plus escaped Markdown and an optional validated {@link ChartSpec}
 * (Story 5.6). "The user's own output" is the honest characterization and it is doing
 * real work here (DW-47): these are the same rows already on screen in the results pane,
 * which is why handing them to an opaque-origin guest over `targetOrigin: "*"` — the only
 * target an opaque origin admits — is an accepted trade rather than a leak, even though
 * the guest's `connect-src 'none'` cannot stop scripted same-frame navigation from
 * carrying them off-machine. The canonical record of that trade, its mitigations and its
 * revisit trigger lives on `GUEST_CSP` in `core/sandbox-server.ts` — this is a pointer,
 * not a second copy. Revisit if untrusted or shared reports are ever introduced.
 * There is deliberately NO inbound frame that can hand the guest a secret,
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
  /**
   * Which connection this Tab was pointed at (Story 10.6) — an ADDITIVE optional field,
   * so {@link WORKSPACE_SNAPSHOT_VERSION} stays `1` (a pre-10.6 snapshot simply has none
   * and loads cleanly; bumping the version would DISCARD every persisted workspace).
   * ABSENT or `null` ⇒ the boot/default target — the same convention
   * {@link ConnectRequest.connectionId}, {@link TableRowsRequest.connectionId} and
   * {@link ChatStreamRequest.connectionId} already spell out, so there is exactly one
   * "default target" encoding across the codebase.
   *
   * It carries the OPAQUE saved-connection id ONLY (AR-12) — never a url, user, password
   * or engine string, so the snapshot stays credential-free like every other field here.
   * It is deliberately INDEPENDENT of the live table binding: `schema`/`name` still never
   * persist (Story 3.2 stands), so a restored table Tab remembers WHICH database it was
   * browsing while still reopening unbound. Because the connection may have been removed
   * between two launches, the id is a HINT the render layer reconciles against the live
   * `connections.list` — never something a loader may assume still resolves.
   */
  readonly connectionId?: string | null;
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
 *
 * Per-tab `connectionId` (Story 10.6, see {@link WorkspaceSnapshotTab.connectionId}) is
 * the third field in that same additive-optional family: it is written only when a Tab
 * actually targets a SAVED connection, so a boot-only workspace still serializes exactly
 * as it did pre-10.6 — and, like the two above, it costs no version bump.
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
  /**
   * Set when the PK column's SQL type is EXACT-numeric (`bigint`/`int8`/`numeric`/
   * `decimal`, see `isExactNumericType`), i.e. when `value` is a digit STRING carrying
   * more precision than a JS `number` could hold (DW-40).
   *
   * It exists because binding those digits as a string is not sufficient on MySQL:
   * mysql2 escapes a JS string into a QUOTED SQL literal, and MySQL compares an integer
   * column against a string operand as a FLOATING-POINT number — the manual's own
   * example, `SELECT '18015376320243458' = 18015376320243459`, yields `1`. So
   * `WHERE id='9007199254740993'` also matches `…992`, and neither the composed UPDATE
   * nor the DELETE carries a `LIMIT 1`. The executor therefore wraps the placeholder in
   * `CAST(? AS DECIMAL(65,30))` when this flag is set AND the engine is MySQL, forcing
   * the exact-decimal comparison path. Postgres needs no cast (postgres.js sends the
   * parameter untyped and the server parses it into the column's own type exactly), so
   * the flag is a HINT the executor may act on per engine — never an unconditional cast.
   *
   * OPTIONAL: an absent flag means "not known to be exact-numeric" and reproduces the
   * pre-`dataType` behavior on both engines.
   */
  readonly exactNumeric?: boolean;
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
