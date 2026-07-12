/**
 * quick-studio — Live Report document schema (Ring-neutral, dependency-light) — Story 6.4.
 *
 * The canonical shape of the token/credential/data-free portable payload embedded inside an
 * exported Live Report `.html` AND published to the local Core to be served at `/live/<id>`.
 * Unlike a Snapshot ({@link ./snapshot.ts}), a Live Report carries **no {@link FrozenData} at
 * rest** — each query block holds its `sql` + `view` + `chart` spec, and the running Core
 * re-queries on view. So there is deliberately NO `data` field on any block: the doc is layout
 * + SQL only (AR-12/AD-9).
 *
 * This module carries ONLY the TYPES + the {@link isLiveReportDoc} guard — it MUST NOT import
 * from `ui/`, `core/`, or `sandbox/`. The `ReportBlock → LiveReportDoc` mapping is a Ring-2
 * concern and lives in `src/ui/report/export-live-report.ts` (because `ReportBlock` is a UI
 * type). Final chart validation is `parseChartSpec` at render time (against the LIVE result
 * columns) — the guard only shape-checks `chart` as `null` or an object here, because the doc
 * carries no columns to validate against yet.
 */

import type { ChartSpec } from "./chart-spec.ts";

/** Version of the Live-Report-document schema. Bump on any breaking change to {@link LiveReportDoc}. */
export const LIVE_REPORT_SCHEMA_VERSION = 1 as const;
export type LiveReportSchemaVersion = typeof LIVE_REPORT_SCHEMA_VERSION;

/**
 * How a query block's live result renders: the read-only grid, or a chart.
 * Mirrors the UI `BlockView` but is redeclared here so `shared/` owns no `ui/` import.
 */
export type LiveReportView = "table" | "chart";

/**
 * One block of a Live Report, discriminated by `kind`:
 *  - `prose` — narrative Markdown (rendered sanitized on view).
 *  - `query` — the block's `sql`, its `view` toggle, and an optional stored `chart` spec.
 *    Carries NO data — the running Core re-queries the `sql` on view (AR-12).
 *  - `empty` — a neutral placeholder note (a query block whose SQL is blank).
 */
export type LiveReportBlock =
  | { readonly kind: "prose"; readonly markdown: string }
  | { readonly kind: "query"; readonly sql: string; readonly view: LiveReportView; readonly chart: ChartSpec | null }
  | { readonly kind: "empty"; readonly note: string };

/** The embedded/published Live Report payload: schema-version stamp + the ordered blocks. */
export type LiveReportDoc = {
  readonly schemaVersion: LiveReportSchemaVersion;
  readonly blocks: ReadonlyArray<LiveReportBlock>;
};

/** Guard one block: shape + per-kind field checks (query carries SQL, never data). */
function isLiveReportBlock(value: unknown): value is LiveReportBlock {
  if (typeof value !== "object" || value === null) return false;
  const b = value as {
    readonly kind?: unknown;
    readonly markdown?: unknown;
    readonly sql?: unknown;
    readonly view?: unknown;
    readonly chart?: unknown;
    readonly note?: unknown;
  };
  switch (b.kind) {
    case "prose":
      return typeof b.markdown === "string";
    case "query":
      // `sql` must be a string; `view` in the closed set; `chart` is null or an object —
      // final spec validation (against live columns) is `parseChartSpec` at render time.
      if (typeof b.sql !== "string") return false;
      if (b.view !== "table" && b.view !== "chart") return false;
      return b.chart === null || (typeof b.chart === "object" && !Array.isArray(b.chart));
    case "empty":
      return typeof b.note === "string";
    default:
      return false;
  }
}

/**
 * Pure runtime guard for the embedded/published Live Report payload. Accepts ONLY a doc at
 * the current {@link LIVE_REPORT_SCHEMA_VERSION} whose `blocks` is an array of well-formed
 * blocks. Rejects a wrong doc `schemaVersion`, a missing/non-array `blocks`, an unknown block
 * `kind`, a non-string `sql`, an invalid `view`, and a `chart` that is neither null nor an
 * object. Total: never throws. This is the SOLE trust gate the serve/runtime path leans on.
 */
export function isLiveReportDoc(value: unknown): value is LiveReportDoc {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as { readonly schemaVersion?: unknown; readonly blocks?: unknown };
  if (doc.schemaVersion !== LIVE_REPORT_SCHEMA_VERSION) return false;
  if (!Array.isArray(doc.blocks)) return false;
  return doc.blocks.every(isLiveReportBlock);
}
