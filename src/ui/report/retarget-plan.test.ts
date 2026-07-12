/**
 * quick-studio UI (Ring 2) — pure re-target planner tests (Story 6.2).
 *
 * DOM-free coverage of the retarget↔run lifecycle (this repo has no jsdom, so the
 * lifecycle lives in `planRetarget`, not a fired `<select>` change). Proves a retarget
 * plans a re-fire for idle, in-flight(busy), AND confirm-pending query blocks; clears a
 * pending confirm; never leaves a block busy with no re-fire (no stuck state); and leaves
 * prose blocks untouched.
 */

import { describe, expect, test } from "bun:test";
import {
  addProseBlock,
  addQueryBlock,
  emptyReport,
  updateProse,
  updateQuerySql,
} from "./report-state.ts";
import { planRetarget, type RetargetRunState } from "./retarget-plan.ts";

/** A report: prose(1) + three query blocks(2 idle, 3 busy, 4 confirm-pending). */
function fixture() {
  let s = addProseBlock(emptyReport()); // id 1 (prose)
  s = updateProse(s, 1, "narrative");
  s = addQueryBlock(s); // id 2
  s = updateQuerySql(s, 2, "select 2");
  s = addQueryBlock(s); // id 3
  s = updateQuerySql(s, 3, "select 3");
  s = addQueryBlock(s); // id 4
  s = updateQuerySql(s, 4, "delete from t where id=1");
  const runs: Record<number, RetargetRunState> = {
    2: { busy: false, confirm: null }, // idle
    3: { busy: true, confirm: null }, // in-flight against the old target
    4: { busy: false, confirm: { sql: "delete from t where id=1", risk: "deletes a row" } }, // confirm-pending
  };
  return { blocks: s.blocks, runs };
}

describe("planRetarget", () => {
  test("emits an action for EVERY query block (idle, busy, confirm-pending) and none for prose", () => {
    const { blocks, runs } = fixture();
    const actions = planRetarget(blocks, runs);
    expect(actions.map((a) => a.id)).toEqual([2, 3, 4]); // prose id 1 absent
    expect(actions.every((a) => a.refire)).toBe(true); // every query block re-fires
  });

  test("carries each block's SQL so the caller re-fires the right statement", () => {
    const { blocks, runs } = fixture();
    const byId = new Map(planRetarget(blocks, runs).map((a) => [a.id, a]));
    expect(byId.get(2)!.sql).toBe("select 2");
    expect(byId.get(4)!.sql).toBe("delete from t where id=1");
  });

  test("clears a pending confirm — the reset drops confirm (old-target preview invalidated)", () => {
    const { blocks, runs } = fixture();
    const confirmBlock = planRetarget(blocks, runs).find((a) => a.id === 4)!;
    expect(confirmBlock.hadConfirm).toBe(true);
    expect(confirmBlock.reset.confirm).toBeNull();
    expect(confirmBlock.refire).toBe(true); // it is re-run against the new target
  });

  test("never leaves a block busy with no re-fire — every reset clears busy AND re-fires", () => {
    const { blocks, runs } = fixture();
    for (const a of planRetarget(blocks, runs)) {
      expect(a.reset.busy).toBe(false); // no stuck "running…"
      expect(a.reset.selectedRow).toBeNull();
      expect(a.refire).toBe(true);
    }
    // The busy block (id 3) is explicitly re-fired, not skipped.
    const busyBlock = planRetarget(blocks, runs).find((a) => a.id === 3)!;
    expect(busyBlock.wasBusy).toBe(true);
    expect(busyBlock.refire).toBe(true);
  });

  test("skips a query block with blank/whitespace SQL — no spurious error on a pristine block", () => {
    let s = addQueryBlock(emptyReport()); // id 1: never given SQL (blank)
    s = addQueryBlock(s); // id 2
    s = updateQuerySql(s, 2, "select 2");
    s = addQueryBlock(s); // id 3: whitespace only
    s = updateQuerySql(s, 3, "   ");
    const actions = planRetarget(s.blocks, {});
    expect(actions.map((a) => a.id)).toEqual([2]); // only the block with real SQL re-fires
  });

  test("a report with only prose plans nothing (target stored, nothing to re-run)", () => {
    let s = addProseBlock(emptyReport());
    s = updateProse(s, 1, "just prose");
    expect(planRetarget(s.blocks, {})).toEqual([]);
  });

  test("a block absent from the runs map still plans a re-fire (idle by default)", () => {
    let s = addQueryBlock(emptyReport()); // id 1, not in runs
    s = updateQuerySql(s, 1, "select 1");
    const actions = planRetarget(s.blocks, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]!.refire).toBe(true);
    expect(actions[0]!.wasBusy).toBe(false);
    expect(actions[0]!.hadConfirm).toBe(false);
  });
});
