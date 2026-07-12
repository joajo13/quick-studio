/**
 * quick-studio UI (Ring 2) — pure re-target lifecycle planner (Story 6.2).
 *
 * A re-target is a WHOLE-REPORT lifecycle transition, not N independent re-runs: when
 * the author picks a new connection, EVERY query block must end up consistent with the
 * new target. Blocks are not always idle when the picker changes — one may be mid-run
 * against the old target, another may be sitting in a pending destructive-confirm. The
 * naive `if (busy || confirm) return` guard skips exactly the blocks that most need
 * re-firing, leaving the report in a mixed old/new-target state (or a block stuck
 * "running…", or a `DELETE` previewed on test A confirmable onto prod B).
 *
 * This module is the SINGLE source of truth for that decision, kept pure + DOM-free so
 * the lifecycle is unit-testable without jsdom (this repo has none). It decides, per
 * block:
 *  - **prose** → untouched (no action emitted).
 *  - **query with blank SQL** → untouched (no action): a never-run/blank block has nothing
 *    to re-target, and re-firing it would send an empty statement to the Core and paint a
 *    spurious error onto a pristine block.
 *  - **query with SQL, idle / in-flight(busy) / confirm-pending** → the transient run state
 *    is RESET (clear `busy`, DROP any pending `confirm`) and the block is RE-FIRED against
 *    the new target. No such block keeps old-target data, stays stuck busy, or retains a
 *    confirm that belonged to the old target.
 *
 * The caller (`ReportTabView`) applies each action's `reset` then fires the block with
 * the NEW target passed EXPLICITLY — never read back from not-yet-committed React state.
 */

import type { ReportBlock } from "./report-state.ts";

/**
 * The minimal transient run-state shape the planner reads, per block id. A structural
 * subset of `ReportTabView`'s `RunEntry` so the planner never depends on the component.
 */
export type RetargetRunState = {
  readonly busy: boolean;
  readonly confirm: unknown | null;
};

/** The reset transient entry a re-target applies to a block BEFORE re-firing it. */
export type RetargetReset = {
  /** Cleared: a superseded/old run must never leave the block stuck "running…". */
  readonly busy: false;
  /** Dropped: a pending confirm belonged to the OLD target and must be invalidated. */
  readonly confirm: null;
  /** Cleared: the prior grid selection is meaningless against fresh data. */
  readonly selectedRow: null;
};

/** One planned per-block action of a re-target. Only query blocks appear here. */
export type RetargetAction = {
  readonly id: number;
  readonly sql: string;
  /** Whether the block must be re-fired against the new target (always true for query blocks). */
  readonly refire: boolean;
  /** Whether this block had a pending confirm the re-target is invalidating (for diagnostics/tests). */
  readonly hadConfirm: boolean;
  /** Whether this block was mid-run (busy) against the old target (for diagnostics/tests). */
  readonly wasBusy: boolean;
  /** The transient run entry to set before re-firing. */
  readonly reset: RetargetReset;
};

const RESET: RetargetReset = { busy: false, confirm: null, selectedRow: null };

/**
 * Plan the re-target: for EVERY query block (regardless of idle/busy/confirm-pending),
 * emit an action that resets its transient state and re-fires it against the new target.
 * Prose blocks are inert and produce no action. Pure and total — never throws, never
 * reads a DOM. The `runs` map is consulted only to annotate `wasBusy`/`hadConfirm`; the
 * decision itself is uniform (every query block re-fires) so no block can be skipped.
 */
export function planRetarget(
  blocks: ReadonlyArray<ReportBlock>,
  runs: Readonly<Record<number, RetargetRunState>>,
): ReadonlyArray<RetargetAction> {
  const actions: RetargetAction[] = [];
  for (const block of blocks) {
    if (block.kind !== "query") continue; // prose is inert — untouched by a re-target
    if (block.sql.trim() === "") continue; // never-run/blank block: re-firing it would send
    // an empty statement to the Core and paint a spurious error onto a pristine block. A
    // block with no SQL has nothing to re-target — skip it (its layout is left untouched).
    const entry = runs[block.id];
    actions.push({
      id: block.id,
      sql: block.sql,
      refire: true,
      hadConfirm: entry !== undefined && entry.confirm !== null,
      wasBusy: entry !== undefined && entry.busy,
      reset: RESET,
    });
  }
  return actions;
}
