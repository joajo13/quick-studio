/**
 * quick-studio UI (Ring 2) — result-grid pagination + selection model (pure).
 *
 * Dependency-free, DOM-free state for the browse grid (Story 3.2): the current
 * page/pageSize/total, the number of rows actually on the page, and the single
 * selected row. All navigation math (page bounds, `canPrev`/`canNext`, the
 * "rows X–Y of N" summary) lives here as pure, total functions so it is unit-
 * testable with no React harness — the `DataGrid` component is a thin view over it.
 *
 * The page/total are authoritative from the Core `table.rows` reply; the model
 * never fetches. Page moves return the NEXT page number for the caller to request.
 */

/** Default rows-per-page mirrored from the Core (`table-rows.ts` DEFAULT_PAGE_SIZE). */
export const DEFAULT_PAGE_SIZE = 100;

/** Immutable grid pagination + selection state. Helpers return new values. */
export type DataGridState = {
  /** 1-based current page. */
  readonly page: number;
  /** Effective page size (from the Core reply, already clamped). */
  readonly pageSize: number;
  /** Total row count of the table (for the pager). */
  readonly total: number;
  /** Rows actually present on the current page (0 for an empty/past-end page). */
  readonly rowCount: number;
  /** Selected row index within the current page, or `null`. */
  readonly selectedRow: number | null;
};

/** An empty grid before the first page resolves. */
export function createDataGridState(pageSize: number = DEFAULT_PAGE_SIZE): DataGridState {
  return { page: 1, pageSize, total: 0, rowCount: 0, selectedRow: null };
}

/**
 * Fold a resolved `table.rows` page into the model: adopt its page/pageSize/total
 * and row count, and CLEAR the selection (a new page invalidates the old row).
 */
export function applyPage(
  _state: DataGridState,
  page: { readonly page: number; readonly pageSize: number; readonly total: number; readonly rowCount: number },
): DataGridState {
  return {
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    rowCount: page.rowCount,
    selectedRow: null,
  };
}

/** The last page number for the current total/pageSize (always at least 1). */
export function lastPage(state: DataGridState): number {
  if (state.total <= 0 || state.pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(state.total / state.pageSize));
}

/** Can we page backward? (Not on page 1.) */
export function canPrev(state: DataGridState): boolean {
  return state.page > 1;
}

/**
 * Can we page forward? True only when rows beyond the current page exist, i.e.
 * `page * pageSize < total`. False on the last page, an empty table, and a
 * page-past-end request (so Next stays disabled there).
 */
export function canNext(state: DataGridState): boolean {
  return state.page * state.pageSize < state.total;
}

/** The previous page number, clamped at 1 (for the Prev button's request). */
export function prevPage(state: DataGridState): number {
  return Math.max(1, state.page - 1);
}

/** The next page number, clamped at the last page (for the Next button's request). */
export function nextPage(state: DataGridState): number {
  return Math.min(lastPage(state), state.page + 1);
}

/**
 * The pager summary. "0 rows" for an empty page (empty table or past-end);
 * otherwise "rows X–Y of N" where X..Y is the 1-based slice of the current page.
 */
export function rowRangeSummary(state: DataGridState): string {
  if (state.rowCount <= 0) return "0 rows";
  const start = (state.page - 1) * state.pageSize + 1;
  const end = start + state.rowCount - 1;
  return `rows ${start}–${end} of ${state.total}`;
}

/**
 * Select a row by its index within the current page (single-select). An index out
 * of range clears the selection; selecting the already-selected row is a no-op.
 */
export function selectRow(state: DataGridState, index: number): DataGridState {
  if (index < 0 || index >= state.rowCount) return { ...state, selectedRow: null };
  if (state.selectedRow === index) return state;
  return { ...state, selectedRow: index };
}
