/**
 * quick-studio — Snapshot document schema (Ring-neutral, dependency-light) — Story 6.3.
 *
 * The canonical shape embedded inside an exported static Snapshot `.html`: an ordered list
 * of {@link SnapshotBlock}s (prose / table / chart / empty) that the offline runtime draws
 * on reopen with NO quick-studio, NO database, and NO network. This module carries ONLY the
 * TYPES + the {@link isSnapshotDoc} guard — it MUST NOT import from `ui/`, `core/`, or
 * `sandbox/`. The `ReportBlock → SnapshotDoc` mapping is a Ring-2 concern and lives in
 * `src/ui/report/export-snapshot.ts` (because `ReportBlock` is a UI type).
 *
 * Every table/chart block embeds the canonical AR-11 {@link FrozenData} (schema-version
 * stamped, the SAME shape the sandbox consumes) plus a `truncated` flag so a Snapshot never
 * presents partial (row-capped) data as complete. `isSnapshotDoc` DEEP-validates each block —
 * a table/chart whose `data` is not well-formed `FrozenData`, or whose inner
 * `schemaVersion` differs from {@link FROZEN_SCHEMA_VERSION}, is rejected (never rendered) —
 * so the offline runtime can trust the payload it just parsed out of a possibly hand-edited,
 * corrupted, or schema-drifted file.
 */

import { decode, FROZEN_SCHEMA_VERSION, type FrozenData } from "./contract.ts";
import { parseChartSpec, type ChartSpec } from "./chart-spec.ts";

/** Version of the Snapshot-document schema. Bump on any breaking change to {@link SnapshotDoc}. */
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;
export type SnapshotSchemaVersion = typeof SNAPSHOT_SCHEMA_VERSION;

/**
 * One rendered block of a Snapshot, discriminated by `kind`:
 *  - `prose` — narrative Markdown (rendered sanitized, raw HTML disabled).
 *  - `table` — the frozen {@link FrozenData} drawn as an escaped grid; `truncated` rides
 *    through so the runtime can show a "partial data" affordance.
 *  - `chart` — a validated {@link ChartSpec} + its frozen {@link FrozenData} drawn with
 *    Observable Plot; `truncated` as for `table`.
 *  - `empty` — a neutral placeholder note (unrun/errored query, a non-SELECT `info` line,
 *    or a block whose data could not be frozen).
 */
export type SnapshotBlock =
  | { readonly kind: "prose"; readonly markdown: string }
  | { readonly kind: "table"; readonly data: FrozenData; readonly truncated: boolean }
  | { readonly kind: "chart"; readonly chart: ChartSpec; readonly data: FrozenData; readonly truncated: boolean }
  | { readonly kind: "empty"; readonly note: string };

/** The embedded Snapshot payload: schema-version stamp + the ordered blocks. */
export type SnapshotDoc = {
  readonly schemaVersion: SnapshotSchemaVersion;
  readonly blocks: ReadonlyArray<SnapshotBlock>;
};

/**
 * Deep-validate an embedded `data` field as canonical {@link FrozenData}: the inner
 * `schemaVersion` MUST equal {@link FROZEN_SCHEMA_VERSION} (a drifted version is rejected,
 * not silently rendered) AND `decode(data)` must succeed (columns/rows are arrays, every
 * row is rectangular, every cell kind matches its column). Total — a `decode` throw is
 * swallowed into `false`.
 */
function isValidFrozen(value: unknown): value is FrozenData {
  if (typeof value !== "object" || value === null) return false;
  if ((value as { schemaVersion?: unknown }).schemaVersion !== FROZEN_SCHEMA_VERSION) return false;
  try {
    decode(value as FrozenData);
    return true;
  } catch {
    return false;
  }
}

/** Guard one block: shape + (for table/chart) the deep {@link FrozenData} + spec checks. */
function isSnapshotBlock(value: unknown): value is SnapshotBlock {
  if (typeof value !== "object" || value === null) return false;
  const b = value as {
    readonly kind?: unknown;
    readonly markdown?: unknown;
    readonly data?: unknown;
    readonly chart?: unknown;
    readonly truncated?: unknown;
    readonly note?: unknown;
  };
  switch (b.kind) {
    case "prose":
      return typeof b.markdown === "string";
    case "table":
      return typeof b.truncated === "boolean" && isValidFrozen(b.data);
    case "chart": {
      if (typeof b.truncated !== "boolean" || !isValidFrozen(b.data)) return false;
      const columnNames = b.data.columns.map((c) => c.name);
      return parseChartSpec(b.chart, columnNames) !== null;
    }
    case "empty":
      return typeof b.note === "string";
    default:
      return false;
  }
}

/**
 * Pure runtime guard for the embedded Snapshot payload. Accepts ONLY a doc at the current
 * {@link SNAPSHOT_SCHEMA_VERSION} whose `blocks` is an array of well-formed blocks (each
 * deep-validated). Rejects a wrong doc `schemaVersion`, a missing/non-array `blocks`, an
 * unknown block `kind`, a table/chart `data` that is not valid {@link FrozenData}, and a
 * block whose inner `data.schemaVersion` drifted. Total: never throws.
 */
export function isSnapshotDoc(value: unknown): value is SnapshotDoc {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as { readonly schemaVersion?: unknown; readonly blocks?: unknown };
  if (doc.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return false;
  if (!Array.isArray(doc.blocks)) return false;
  return doc.blocks.every(isSnapshotBlock);
}

/**
 * Return a copy of `doc` whose every `table`/`chart` block carries `decode(block.data)` — the
 * CANONICALIZED payload (an over-precise date cell floored to millisecond precision, DW-6) —
 * rather than the original object the guard proved valid but never rewrote (`isValidFrozen`
 * uses `decode` only as a throw/no-throw oracle and discards its result). `prose`/`empty`
 * blocks pass through by reference. Pure; it may assume `doc` already passed {@link isSnapshotDoc},
 * so `decode` cannot throw here. This is the helper {@link mountSnapshot} renders so the offline
 * runtime draws the millisecond form, not the microsecond string it parsed out of the file.
 */
export function normalizeSnapshotDoc(doc: SnapshotDoc): SnapshotDoc {
  const blocks = doc.blocks.map((block) =>
    block.kind === "table" || block.kind === "chart"
      ? { ...block, data: decode(block.data) }
      : block,
  );
  return { ...doc, blocks };
}
