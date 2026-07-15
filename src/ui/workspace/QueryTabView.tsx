/**
 * quick-studio UI (Ring 2) — QueryTabView (Story 3.6).
 *
 * The ad-hoc SQL runner for a `query` Tab: a monospace textarea bound to a
 * session-only draft (lifted to `App`, see `workspace-state.ts`'s Block-If — the
 * snapshot never stores query text), a Run control (button + Ctrl/Cmd+Enter), and
 * a result area over whatever the Story 3.1 guarded `execute` RAW path returns.
 *
 * The UI never parses, splits, classifies, or composes SQL (AR-3) — the typed
 * text is sent verbatim as `{shape:"raw", sql}` and the Core is the sole risk
 * gate:
 *  - `status:"rows"` renders a read-only `DataGrid` (no PKs, no mutation
 *    affordances) paginated CLIENT-SIDE over the Core-capped rows via the pure
 *    `data-grid-state.ts` helpers; a `truncated` reply shows a "first 1000 rows"
 *    banner.
 *  - `status:"confirmation_required"` shows the shared `ConfirmRun` dialog
 *    (mirroring `DataGrid`'s delete confirm / `SettingsPanel`'s remove-connection
 *    confirm — no modal framework) with the preview SQL + risk; confirming
 *    re-issues the IDENTICAL request with `confirmed:true` (the dialog is UX
 *    only, never the gate). Esc/cancel runs nothing.
 *  - `status:"ok"` (a confirmed mutation/DDL) shows "N rows affected".
 *  - a failed envelope renders inline via the shared `envelopeText`.
 *
 * `runRawQuery`/`RunOutcome` (Story 5.3: extracted to `run-raw-query.ts`, the
 * single execution seam now also driven by `ChatTabView`) and `ConfirmRun`
 * (Story 5.3: extracted, shared confirm presentational component) live in their
 * own DOM-free modules so the round-trip logic and the dialog stay
 * unit-testable without a live DOM — this repo has no jsdom/testing-library,
 * only `bun:test` + `react-dom/server` for presentational components.
 */

import { useRef, useState } from "react";
import type { FrozenData } from "../../shared/contract.ts";
import { DataGrid } from "../data/DataGrid.tsx";
import {
  applyPage,
  canNext,
  canPrev,
  createDataGridState,
  nextPage,
  prevPage,
  rowRangeSummary,
  selectRow,
  type DataGridState,
} from "../data/data-grid-state.ts";
import { ConfirmRun } from "./ConfirmRun.tsx";
import { runRawQuery, type RunOutcome } from "./run-raw-query.ts";

/** Whether `sql` has any non-whitespace content — the sole Run-enable gate. */
export function isRunnable(sql: string): boolean {
  return sql.trim() !== "";
}

/** The rows of `rows` belonging to 1-based `page`, sliced client-side. */
function pageSlice(rows: FrozenData["rows"], page: number, pageSize: number): FrozenData["rows"] {
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

export function QueryTabView({
  draft,
  onDraftChange,
}: {
  /** The session-only draft SQL for this Tab (never persisted to disk/snapshot). */
  draft: string;
  onDraftChange: (sql: string) => void;
}): React.JSX.Element {
  const [data, setData] = useState<FrozenData | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [grid, setGrid] = useState<DataGridState>(() => createDataGridState());
  // The SQL actually sent for the run currently awaiting confirmation — kept
  // separate from `draft` (which the user may keep editing while the confirm
  // banner is up) so a confirm always re-issues the EXACT original request.
  const [pendingSql, setPendingSql] = useState<string>("");
  const [confirm, setConfirm] = useState<{ sql: string; risk: string } | null>(null);
  const [affected, setAffected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A synchronous re-entrancy guard: `busy` is React state and only lands after a
  // re-render, so two synchronous fires (double-click / key-repeat) can both pass a
  // `busy === false` check. This ref flips immediately, so a confirmed destructive
  // statement can never be executed twice — mirroring `DataGrid`'s insert `firing`.
  const firing = useRef(false);

  const applyOutcome = (outcome: RunOutcome): void => {
    if (outcome.kind === "error") {
      setError(outcome.message);
      setConfirm(null);
      setData(null);
      setTruncated(false);
      setAffected(null);
      return;
    }
    if (outcome.kind === "confirm") {
      setConfirm({ sql: outcome.sql, risk: outcome.risk });
      setError(null);
      // Clear any prior result so a stale grid / "N rows affected" / truncated banner
      // can never sit beneath a confirm describing an unrelated statement.
      setData(null);
      setTruncated(false);
      setAffected(null);
      return;
    }
    setConfirm(null);
    setError(null);
    if (outcome.kind === "ok") {
      setAffected(outcome.rowsAffected);
      setData(null);
      setTruncated(false);
      return;
    }
    // outcome.kind === "rows"
    setAffected(null);
    setData(outcome.data);
    setTruncated(outcome.truncated);
    setGrid((g) =>
      applyPage(g, {
        page: 1,
        pageSize: g.pageSize,
        total: outcome.data.rows.length,
        rowCount: pageSlice(outcome.data.rows, 1, g.pageSize).length,
      }),
    );
  };

  const run = async (): Promise<void> => {
    // Blocked while a confirm is pending: a stray Run / Ctrl+Enter must not silently
    // abandon the destructive confirm the user is mid-decision on (cancel it first).
    if (firing.current || busy || confirm !== null || !isRunnable(draft)) return;
    firing.current = true;
    const sql = draft;
    setPendingSql(sql);
    setBusy(true);
    try {
      applyOutcome(await runRawQuery(sql));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      firing.current = false;
    }
  };

  const confirmRun = async (): Promise<void> => {
    if (firing.current || busy) return;
    firing.current = true;
    setBusy(true);
    try {
      applyOutcome(await runRawQuery(pendingSql, true));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      firing.current = false;
    }
  };

  const gotoPage = (page: number): void => {
    if (data === null) return;
    setGrid((g) =>
      applyPage(g, {
        page,
        pageSize: g.pageSize,
        total: g.total,
        rowCount: pageSlice(data.rows, page, g.pageSize).length,
      }),
    );
  };

  const pagedData: FrozenData | null =
    data !== null ? { ...data, rows: pageSlice(data.rows, grid.page, grid.pageSize) } : null;

  return (
    <div className="flex h-full flex-col">
      {/* Editor + run control. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--border)] bg-[var(--card)] p-3">
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          spellCheck={false}
          rows={6}
          aria-label="sql query editor"
          placeholder="select * from ..."
          className="w-full resize-y rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[var(--foreground)] outline-none focus:border-[var(--coral-line)]"
          style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!isRunnable(draft) || busy || confirm !== null}
            onClick={() => void run()}
            className="inline-flex items-center gap-2 rounded-[7px] bg-[var(--coral)] px-3 py-1.5 text-xs font-semibold text-[var(--coral-ink)] transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="h-3 w-3" aria-hidden="true">
              <path d="M12 19V5M6 11l6-6 6 6" />
            </svg>
            {busy ? "running…" : "Run"}
            <span
              className="rounded-[4px] border px-1 font-mono text-[10px] opacity-75"
              style={{ borderColor: "color-mix(in srgb, var(--coral-ink) 30%, transparent)" }}
            >
              {typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? "⌘↵" : "Ctrl ↵"}
            </span>
          </button>
          {data !== null ? (
            <>
              <span className="ml-auto font-mono text-[12px] lowercase text-[var(--muted-foreground)]">
                {rowRangeSummary(grid)}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={!canPrev(grid)}
                  onClick={() => gotoPage(prevPage(grid))}
                  className="rounded-[var(--radius)] border border-[var(--border)] px-2 py-0.5 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  prev
                </button>
                <button
                  type="button"
                  disabled={!canNext(grid)}
                  onClick={() => gotoPage(nextPage(grid))}
                  className="rounded-[var(--radius)] border border-[var(--border)] px-2 py-0.5 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  next
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {truncated && data !== null ? (
        <div className="flex items-center border-b border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2">
          <p className="font-mono text-xs lowercase text-[var(--warn)]">
            result truncated — only the first {data.rows.length} rows were returned
          </p>
        </div>
      ) : null}

      {confirm !== null ? (
        <ConfirmRun
          sql={confirm.sql}
          risk={confirm.risk}
          busy={busy}
          onConfirm={() => void confirmRun()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      {error !== null ? (
        <div className="flex items-center gap-3 border-b border-[var(--err-line)] bg-[var(--err-soft)] px-3 py-2">
          <p role="alert" className="font-mono text-xs lowercase text-[var(--err)]">
            {error}
          </p>
        </div>
      ) : null}

      {affected !== null ? (
        <div className="flex items-center border-b border-[var(--border)] bg-[var(--card)] px-3 py-2">
          <p className="font-mono text-xs lowercase text-[var(--foreground)]">
            {affected} row{affected === 1 ? "" : "s"} affected
          </p>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {pagedData !== null ? (
          <DataGrid
            data={pagedData}
            primaryKeys={[]}
            selectedRow={grid.selectedRow}
            onSelectRow={(index) => setGrid((g) => selectRow(g, index))}
          />
        ) : (
          <div
            className="flex h-full items-center justify-center lowercase text-[var(--muted-foreground)]"
            style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
          >
            run a query to see results
          </div>
        )}
      </div>
    </div>
  );
}
