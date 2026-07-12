/**
 * quick-studio UI (Ring 2) — Report state model tests (Story 6.1).
 *
 * Pure, DOM-free unit tests over every reducer + the I/O-matrix state transitions:
 * add/remove/reorder, multi-query independence (FR-18), and the view/chart toggles.
 * Totality: an unknown id / a wrong-kind target / an out-of-range move is a no-op,
 * never a throw.
 */

import { describe, expect, test } from "bun:test";
import { FROZEN_SCHEMA_VERSION, type FrozenData } from "../../shared/contract.ts";
import type { ChartSpec } from "../../shared/chart-spec.ts";
import {
  addProseBlock,
  addQueryBlock,
  emptyReport,
  moveBlock,
  removeBlock,
  setBlockChart,
  setBlockError,
  setBlockOk,
  setBlockResult,
  setBlockView,
  setReportTarget,
  updateProse,
  updateQuerySql,
  type ReportBlock,
} from "./report-state.ts";

const data = (col: string, n: number): FrozenData => ({
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [{ name: col, type: "number" }],
  rows: Array.from({ length: n }, (_, i) => [{ kind: "number", value: i } as const]),
});

const queryAt = (blocks: ReadonlyArray<ReportBlock>, i: number): Extract<ReportBlock, { kind: "query" }> => {
  const b = blocks[i];
  if (b === undefined || b.kind !== "query") throw new Error("expected a query block");
  return b;
};

describe("emptyReport", () => {
  test("is empty, ids start at 1, and the target defaults to null (boot connection)", () => {
    expect(emptyReport()).toEqual({ blocks: [], nextId: 1, targetConnectionId: null });
  });
});

describe("setReportTarget (Story 6.2) — target model, no layout mutation", () => {
  test("sets and clears the target, preserving blocks + nextId (layout invariant)", () => {
    // Build a non-trivial layout: prose + query with a result + chart.
    let s = addProseBlock(emptyReport()); // id 1
    s = updateProse(s, 1, "# title");
    s = addQueryBlock(s); // id 2
    s = setBlockResult(s, 2, data("a", 3), false);
    s = setBlockView(s, 2, "chart");
    const layoutBefore = s.blocks;
    const nextIdBefore = s.nextId;

    const targeted = setReportTarget(s, "conn-b");
    expect(targeted.targetConnectionId).toBe("conn-b");
    // Layout is untouched — same block array reference, same nextId.
    expect(targeted.blocks).toBe(layoutBefore);
    expect(targeted.nextId).toBe(nextIdBefore);

    const cleared = setReportTarget(targeted, null);
    expect(cleared.targetConnectionId).toBeNull();
    expect(cleared.blocks).toBe(layoutBefore);
  });

  test("a no-op set (same id) returns the same reference", () => {
    const s = setReportTarget(emptyReport(), "x");
    expect(setReportTarget(s, "x")).toBe(s);
    const base = emptyReport();
    expect(setReportTarget(base, null)).toBe(base); // null → null
  });

  test("add/remove/reorder preserve the target", () => {
    let s = setReportTarget(emptyReport(), "conn-a");
    s = addProseBlock(s);
    s = addQueryBlock(s);
    expect(s.targetConnectionId).toBe("conn-a");
    s = moveBlock(s, 2, "up");
    expect(s.targetConnectionId).toBe("conn-a");
    s = removeBlock(s, 1);
    expect(s.targetConnectionId).toBe("conn-a");
  });
});

describe("add blocks", () => {
  test("addProseBlock appends an empty prose block and bumps nextId", () => {
    const s = addProseBlock(emptyReport());
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toEqual({ id: 1, kind: "prose", markdown: "" });
    expect(s.nextId).toBe(2);
  });

  test("addQueryBlock appends a blank query block (table view, no result/chart)", () => {
    const s = addQueryBlock(emptyReport());
    expect(s.blocks[0]).toEqual({ id: 1, kind: "query", sql: "", result: null, view: "table", chart: null });
    expect(s.nextId).toBe(2);
  });

  test("ids are monotonic across mixed adds and never reused after a remove", () => {
    let s = addProseBlock(emptyReport()); // id 1
    s = addQueryBlock(s); // id 2
    s = removeBlock(s, 1);
    s = addProseBlock(s); // id 3 (not 1)
    expect(s.blocks.map((b) => b.id)).toEqual([2, 3]);
    expect(s.nextId).toBe(4);
  });
});

describe("prose + sql edits", () => {
  test("updateProse replaces markdown on the prose block only", () => {
    let s = addProseBlock(emptyReport());
    s = updateProse(s, 1, "# hi");
    expect((s.blocks[0] as { markdown: string }).markdown).toBe("# hi");
  });

  test("updateProse is a no-op on a query block / unknown id (same reference)", () => {
    const s = addQueryBlock(emptyReport());
    expect(updateProse(s, 1, "x")).toBe(s); // wrong kind
    expect(updateProse(s, 99, "x")).toBe(s); // unknown id
  });

  test("updateQuerySql replaces sql on the query block", () => {
    let s = addQueryBlock(emptyReport());
    s = updateQuerySql(s, 1, "select 1");
    expect(queryAt(s.blocks, 0).sql).toBe("select 1");
  });
});

describe("run outcomes on a query block", () => {
  test("setBlockResult stores FrozenData, carries truncated, and clears a prior error", () => {
    let s = addQueryBlock(emptyReport());
    s = setBlockError(s, 1, "boom");
    expect(queryAt(s.blocks, 0).error).toBe("boom");
    s = setBlockResult(s, 1, data("a", 3), false);
    const b = queryAt(s.blocks, 0);
    expect(b.result?.rows).toHaveLength(3);
    expect(b.error).toBeUndefined();
    expect(b.truncated).toBe(false);
    // A truncated result carries the flag so the UI can flag partial data.
    s = setBlockResult(s, 1, data("a", 2), true);
    expect(queryAt(s.blocks, 0).truncated).toBe(true);
  });

  test("setBlockError records the error and clears the stale result", () => {
    let s = addQueryBlock(emptyReport());
    s = setBlockResult(s, 1, data("a", 2), false);
    s = setBlockError(s, 1, "syntax error");
    const b = queryAt(s.blocks, 0);
    expect(b.result).toBeNull();
    expect(b.error).toBe("syntax error");
  });

  test("setBlockOk records a neutral info note and clears prior result + error", () => {
    let s = addQueryBlock(emptyReport());
    s = setBlockResult(s, 1, data("a", 2), false);
    s = setBlockError(s, 1, "boom");
    s = setBlockOk(s, 1, "3 rows affected");
    const b = queryAt(s.blocks, 0);
    expect(b.info).toBe("3 rows affected");
    expect(b.error).toBeUndefined();
    expect(b.result).toBeNull();
  });

  test("setBlockView toggles table/chart; setBlockChart sets/clears the spec", () => {
    const chart: ChartSpec = { mark: "bar", x: "a", y: "a" };
    let s = addQueryBlock(emptyReport());
    s = setBlockView(s, 1, "chart");
    expect(queryAt(s.blocks, 0).view).toBe("chart");
    s = setBlockChart(s, 1, chart);
    expect(queryAt(s.blocks, 0).chart).toEqual(chart);
    s = setBlockChart(s, 1, null);
    expect(queryAt(s.blocks, 0).chart).toBeNull();
  });
});

describe("multi-query independence (FR-18)", () => {
  test("two query blocks hold their own results; one failing does not touch the other", () => {
    let s = addQueryBlock(emptyReport()); // id 1
    s = addQueryBlock(s); // id 2
    s = setBlockResult(s, 1, data("a", 5), false);
    s = setBlockError(s, 2, "block 2 failed");
    const b1 = queryAt(s.blocks, 0);
    const b2 = queryAt(s.blocks, 1);
    expect(b1.result?.rows).toHaveLength(5);
    expect(b1.error).toBeUndefined();
    expect(b2.result).toBeNull();
    expect(b2.error).toBe("block 2 failed");
  });
});

describe("reorder + remove (totality)", () => {
  test("moveBlock swaps neighbours up/down", () => {
    let s = addProseBlock(emptyReport()); // id 1
    s = addQueryBlock(s); // id 2
    s = addProseBlock(s); // id 3
    s = moveBlock(s, 3, "up");
    expect(s.blocks.map((b) => b.id)).toEqual([1, 3, 2]);
    s = moveBlock(s, 1, "down");
    expect(s.blocks.map((b) => b.id)).toEqual([3, 1, 2]);
  });

  test("moveBlock off either end / unknown id is a no-op (same reference)", () => {
    let s = addProseBlock(emptyReport()); // id 1
    s = addQueryBlock(s); // id 2
    expect(moveBlock(s, 1, "up")).toBe(s); // first block up
    expect(moveBlock(s, 2, "down")).toBe(s); // last block down
    expect(moveBlock(s, 99, "up")).toBe(s); // unknown id
  });

  test("removeBlock drops the block; removing the last yields a valid empty report", () => {
    let s = addProseBlock(emptyReport()); // id 1
    s = removeBlock(s, 1);
    expect(s.blocks).toEqual([]);
    expect(s.nextId).toBe(2); // ids never reused
    expect(removeBlock(s, 99)).toBe(s); // unknown id no-op
  });
});
