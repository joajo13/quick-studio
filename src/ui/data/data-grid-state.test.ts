/**
 * Unit tests for the pure result-grid pagination + selection model (Story 3.2).
 * No DOM / React harness — page bounds, canPrev/canNext, the "0 rows" and
 * "rows X–Y of N" summaries, and single-select behavior are pure functions.
 */

import { describe, expect, test } from "bun:test";
import {
  applyPage,
  canNext,
  canPrev,
  createDataGridState,
  lastPage,
  nextPage,
  prevPage,
  rowRangeSummary,
  selectRow,
} from "./data-grid-state.ts";

/** Build a state as if a page just resolved. */
function page(p: { page: number; pageSize: number; total: number; rowCount: number }) {
  return applyPage(createDataGridState(p.pageSize), p);
}

describe("page bounds + canPrev/canNext", () => {
  test("first page of a large table: Prev disabled, Next enabled", () => {
    const s = page({ page: 1, pageSize: 100, total: 5000, rowCount: 100 });
    expect(canPrev(s)).toBe(false);
    expect(canNext(s)).toBe(true);
    expect(lastPage(s)).toBe(50);
  });

  test("last page: Next disabled, Prev enabled", () => {
    const s = page({ page: 50, pageSize: 100, total: 5000, rowCount: 100 });
    expect(canPrev(s)).toBe(true);
    expect(canNext(s)).toBe(false);
  });

  test("single short page: both disabled", () => {
    const s = page({ page: 1, pageSize: 100, total: 30, rowCount: 30 });
    expect(canPrev(s)).toBe(false);
    expect(canNext(s)).toBe(false);
  });

  test("page past the end: Next disabled (0 rows on page)", () => {
    const s = page({ page: 999, pageSize: 100, total: 30, rowCount: 0 });
    expect(canNext(s)).toBe(false);
  });

  test("prevPage clamps at 1, nextPage clamps at the last page", () => {
    const first = page({ page: 1, pageSize: 100, total: 5000, rowCount: 100 });
    expect(prevPage(first)).toBe(1);
    const last = page({ page: 50, pageSize: 100, total: 5000, rowCount: 100 });
    expect(nextPage(last)).toBe(50);
    const mid = page({ page: 2, pageSize: 100, total: 5000, rowCount: 100 });
    expect(prevPage(mid)).toBe(1);
    expect(nextPage(mid)).toBe(3);
  });
});

describe("rowRangeSummary", () => {
  test("0 rows for an empty table", () => {
    expect(rowRangeSummary(page({ page: 1, pageSize: 100, total: 0, rowCount: 0 }))).toBe("0 rows");
  });

  test("0 rows for a page past the end", () => {
    expect(rowRangeSummary(page({ page: 999, pageSize: 100, total: 30, rowCount: 0 }))).toBe("0 rows");
  });

  test("rows X–Y of N on the first page", () => {
    expect(rowRangeSummary(page({ page: 1, pageSize: 100, total: 5000, rowCount: 100 }))).toBe(
      "rows 1–100 of 5000",
    );
  });

  test("rows X–Y of N on a later, partial last page", () => {
    expect(rowRangeSummary(page({ page: 3, pageSize: 100, total: 230, rowCount: 30 }))).toBe(
      "rows 201–230 of 230",
    );
  });
});

describe("selectRow (single-select)", () => {
  test("selects a valid in-range index", () => {
    const s = page({ page: 1, pageSize: 100, total: 5000, rowCount: 100 });
    expect(selectRow(s, 4).selectedRow).toBe(4);
  });

  test("re-selecting the same row is a no-op (same reference)", () => {
    const s = selectRow(page({ page: 1, pageSize: 100, total: 5000, rowCount: 100 }), 4);
    expect(selectRow(s, 4)).toBe(s);
  });

  test("an out-of-range index clears the selection", () => {
    const s = selectRow(page({ page: 1, pageSize: 100, total: 5000, rowCount: 100 }), 4);
    expect(selectRow(s, 999).selectedRow).toBeNull();
    expect(selectRow(s, -1).selectedRow).toBeNull();
  });

  test("applyPage clears any prior selection", () => {
    const s = selectRow(page({ page: 1, pageSize: 100, total: 5000, rowCount: 100 }), 4);
    const next = applyPage(s, { page: 2, pageSize: 100, total: 5000, rowCount: 100 });
    expect(next.selectedRow).toBeNull();
    expect(next.page).toBe(2);
  });
});
