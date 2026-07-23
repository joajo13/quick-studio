/**
 * quick-studio UI (Ring 2) — Report state model (pure, dependency-free) — Story 6.1.
 *
 * The ordered block list for a `report` Tab, kept OUT of React so it is unit-testable
 * with no DOM and no RPC harness (mirrors `workspace-state.ts` / `chat-model.ts`). A
 * Report composes content Blocks — narrative prose (Markdown) and query blocks (each
 * driven by its OWN SQL run through the Core `runRawQuery` seam, holding the returned
 * {@link FrozenData} and an optional {@link ChartSpec}). One Report may combine results
 * from more than one independent query (FR-18): each query block owns its own SQL and
 * result, so one block failing never touches another.
 *
 * The whole state is session-only (lifted to `App`, keyed by tab id) and is NEVER
 * written to the workspace snapshot — like `queryDrafts` and `chatStates`, Report
 * content does not touch disk in 6.1.
 *
 * Everything is pure and total: reducers return new state; an unknown block id is a
 * no-op (never a throw). Ids are a monotonic counter carried in {@link ReportState}
 * (`nextId`) rather than `Math.random`/`Date.now`, so every transition is deterministic
 * and tests are stable (mirrors `workspace-state.ts`).
 */

import type { FrozenData } from "../../shared/contract.ts";
import type { ChartSpec } from "../../shared/chart-spec.ts";
import type { ReportSpec } from "../../shared/report-spec.ts";

/** How a query block's result renders: the read-only grid, or the in-app chart. */
export type BlockView = "table" | "chart";

/**
 * One content block of a Report, discriminated by `kind`:
 *  - `prose` — narrative Markdown, rendered as sanitized HTML in the preview.
 *  - `query` — its own `sql`, the last-run `result` (or `null` before a run / after an
 *    error), the `view` toggle (table | chart), an optional `chart` spec, and an
 *    optional `error` string from the last failed run. Each query block is independent
 *    — it holds its own result and never shares a "results registry" (FR-18).
 */
export type ReportBlock =
  | { readonly id: number; readonly kind: "prose"; readonly markdown: string }
  | {
      readonly id: number;
      readonly kind: "query";
      readonly sql: string;
      readonly result: FrozenData | null;
      readonly view: BlockView;
      readonly chart: ChartSpec | null;
      readonly error?: string;
      /** A neutral (non-error) note for a successful DML/DDL run (`ok` outcome). */
      readonly info?: string;
      /** Whether the stored `result` is the Core's first-N truncation (partial data). */
      readonly truncated?: boolean;
    };

/** The complete in-memory Report state. Immutable — reducers return new values. */
export type ReportState = {
  readonly blocks: ReadonlyArray<ReportBlock>;
  /** Next block id to assign. Monotonic; never reused, even after a remove. */
  readonly nextId: number;
  /**
   * The session-only re-target (Story 6.2): a saved-connection id every query block
   * runs against, or `null` for the boot/launch connection (the default). NEVER a url
   * or credential — only the id — and never persisted (session-only, like the blocks).
   * Changing it re-runs every query block against the new target; it never mutates layout.
   */
  readonly targetConnectionId: string | null;
};

/**
 * A lifted-state change: either the next {@link ReportState} value, or a functional
 * updater folded against the LATEST state. Async run completions MUST use the updater
 * form so two query blocks resolving in the same React batch both survive (FR-18).
 */
export type ReportStateUpdate = ReportState | ((prev: ReportState) => ReportState);

/** An empty Report: no blocks, ids start at 1, default (boot) target. */
export function emptyReport(): ReportState {
  return { blocks: [], nextId: 1, targetConnectionId: null };
}

/** Append a new (empty) prose block and make room for the next id. Pure. */
export function addProseBlock(state: ReportState): ReportState {
  const block: ReportBlock = { id: state.nextId, kind: "prose", markdown: "" };
  return { ...state, blocks: [...state.blocks, block], nextId: state.nextId + 1 };
}

/** Append a new (empty) query block: blank SQL, no result, table view, no chart. Pure. */
export function addQueryBlock(state: ReportState): ReportState {
  const block: ReportBlock = {
    id: state.nextId,
    kind: "query",
    sql: "",
    result: null,
    view: "table",
    chart: null,
  };
  return { ...state, blocks: [...state.blocks, block], nextId: state.nextId + 1 };
}

/** Map the block with `id` through `fn` (only when the kind guard holds). Pure helper. */
function mapBlock(
  state: ReportState,
  id: number,
  fn: (block: ReportBlock) => ReportBlock,
): ReportState {
  let changed = false;
  const blocks = state.blocks.map((b) => {
    if (b.id !== id) return b;
    const next = fn(b);
    // Preserve reference identity on a no-op (e.g. a wrong-kind target `fn` returns
    // unchanged), so a caller can rely on `updateProse(s, queryId, x) === s`.
    if (next !== b) changed = true;
    return next;
  });
  return changed ? { ...state, blocks } : state;
}

/** Replace a prose block's Markdown. No-op on an unknown id or a non-prose block. Pure. */
export function updateProse(state: ReportState, id: number, markdown: string): ReportState {
  return mapBlock(state, id, (b) => (b.kind === "prose" ? { ...b, markdown } : b));
}

/**
 * Store a successful run's {@link FrozenData} on a query block, carry whether it was
 * TRUNCATED (first-N rows only — so a shared report never presents partial data as
 * complete), and CLEAR any prior error/info. No-op on an unknown id or a non-query
 * block. Pure.
 */
export function setBlockResult(
  state: ReportState,
  id: number,
  result: FrozenData,
  truncated: boolean,
): ReportState {
  return mapBlock(state, id, (b) =>
    b.kind === "query"
      ? { id: b.id, kind: "query", sql: b.sql, result, view: b.view, chart: b.chart, truncated }
      : b,
  );
}

/**
 * Record a failed run's error on a query block and CLEAR the stale result/info (a block
 * that failed shows the error, not last run's rows — per the I/O matrix). No-op on an
 * unknown id or a non-query block. Pure.
 */
export function setBlockError(state: ReportState, id: number, error: string): ReportState {
  return mapBlock(state, id, (b) =>
    b.kind === "query"
      ? { id: b.id, kind: "query", sql: b.sql, result: null, view: b.view, chart: b.chart, error }
      : b,
  );
}

/**
 * Record a successful DML/DDL run's NEUTRAL note (an `ok` outcome — e.g. "N rows
 * affected") on a query block and CLEAR any prior result/error. This is NOT an error
 * state — the UI paints it as a small non-red note, never `role="alert"`. No-op on an
 * unknown id or a non-query block. Pure.
 */
export function setBlockOk(state: ReportState, id: number, info: string): ReportState {
  return mapBlock(state, id, (b) =>
    b.kind === "query"
      ? { id: b.id, kind: "query", sql: b.sql, result: null, view: b.view, chart: b.chart, info }
      : b,
  );
}

/** Replace a query block's SQL text (a fresh edit before the next run). Pure. */
export function updateQuerySql(state: ReportState, id: number, sql: string): ReportState {
  return mapBlock(state, id, (b) => (b.kind === "query" ? { ...b, sql } : b));
}

/** Toggle a query block's view between the table grid and the in-app chart. Pure. */
export function setBlockView(state: ReportState, id: number, view: BlockView): ReportState {
  return mapBlock(state, id, (b) => (b.kind === "query" ? { ...b, view } : b));
}

/** Set (or clear, with `null`) a query block's {@link ChartSpec}. Pure. */
export function setBlockChart(state: ReportState, id: number, chart: ChartSpec | null): ReportState {
  return mapBlock(state, id, (b) => (b.kind === "query" ? { ...b, chart } : b));
}

/**
 * Remove the block with `id`. Total — an unknown id returns the state unchanged, and
 * removing the last/only block yields an empty (but valid) Report. Pure.
 */
export function removeBlock(state: ReportState, id: number): ReportState {
  const blocks = state.blocks.filter((b) => b.id !== id);
  return blocks.length === state.blocks.length ? state : { ...state, blocks };
}

/**
 * Set (or clear, with `null`) the Report's session-only re-target — the saved-connection
 * id every query block runs against (Story 6.2). Touches ONLY `targetConnectionId`:
 * `blocks`/`nextId` are preserved by reference so re-targeting can NEVER mutate layout
 * (block order, prose, chart specs, view toggles). A no-op (same id) returns the same
 * reference. Pure.
 */
export function setReportTarget(state: ReportState, id: string | null): ReportState {
  if (state.targetConnectionId === id) return state;
  return { ...state, targetConnectionId: id };
}

/**
 * Build a fresh {@link ReportState} from a chat-generated, Core-validated
 * {@link ReportSpec} (Story 9.7) — the "open in report tab" seam. Folds the spec
 * through the EXISTING reducers (no new state/render code): an optional non-empty
 * `spec.title` becomes a LEADING prose block (`# {title}`), since `ReportState` has
 * no title field of its own; each `prose` spec block becomes a prose block seeded
 * with its markdown; each `query` spec block becomes a query block seeded with its
 * SQL, UNRUN (`result: null`); a `chart` intent on a query block is applied via
 * `setBlockChart` + `setBlockView(_, id, "chart")` so the render-time `mapChart`
 * guard (`ReportTabView.tsx`) validates it once the block runs — a chart-less query
 * block stays `view:"table"`, `chart:null`. Pure and total; reads `nextId` BEFORE
 * each add to know the id the reducer is about to mint.
 */
export function reportStateFromSpec(spec: ReportSpec): ReportState {
  let s = emptyReport();
  if (spec.title !== undefined && spec.title.trim() !== "") {
    const id = s.nextId;
    s = updateProse(addProseBlock(s), id, `# ${spec.title}`);
  }
  for (const b of spec.blocks) {
    const id = s.nextId;
    if (b.kind === "prose") {
      s = updateProse(addProseBlock(s), id, b.markdown);
    } else {
      s = updateQuerySql(addQueryBlock(s), id, b.sql);
      if (b.chart !== undefined) {
        s = setBlockView(setBlockChart(s, id, b.chart), id, "chart");
      }
    }
  }
  return s;
}

/**
 * Move the block with `id` one slot toward the start (`"up"`) or end (`"down"`) of the
 * ordered list. Total — an unknown id, or a move that would fall off either end, is a
 * no-op (never a throw). Pure.
 */
export function moveBlock(state: ReportState, id: number, direction: "up" | "down"): ReportState {
  const index = state.blocks.findIndex((b) => b.id === id);
  if (index === -1) return state;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= state.blocks.length) return state;
  const blocks = [...state.blocks];
  const moved = blocks[index] as ReportBlock;
  const swapped = blocks[target] as ReportBlock;
  blocks[index] = swapped;
  blocks[target] = moved;
  return { ...state, blocks };
}
