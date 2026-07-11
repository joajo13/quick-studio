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
 *  - `status:"confirmation_required"` shows an inline confirm (mirroring
 *    `DataGrid`'s delete confirm / `SettingsPanel`'s remove-connection confirm —
 *    no modal framework) with the preview SQL + risk; confirming re-issues the
 *    IDENTICAL request with `confirmed:true` (the dialog is UX only, never the
 *    gate). Esc/cancel runs nothing.
 *  - `status:"ok"` (a confirmed mutation/DDL) shows "N rows affected".
 *  - a failed envelope renders inline via the shared `envelopeText`.
 *
 * `runRawQuery` is exported as a standalone, DOM-free async function (mocking
 * `rpc` is enough to exercise every Run/confirm outcome) so the round-trip logic
 * is unit-testable without a live DOM — this repo has no jsdom/testing-library,
 * only `bun:test` + `react-dom/server` for presentational components.
 */

import { useRef, useState } from "react";
import type { ExecuteResult, FrozenData } from "../../shared/contract.ts";
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
import { rpc } from "../rpc/client.ts";
import { envelopeText } from "../rpc/envelope-text.ts";

/** Whether `sql` has any non-whitespace content — the sole Run-enable gate. */
export function isRunnable(sql: string): boolean {
  return sql.trim() !== "";
}

/**
 * The outcome of one raw `execute` round-trip, decoupled from React state so the
 * Run/confirm flow is unit-testable by mocking `rpc` and calling `runRawQuery`
 * directly (no rendering / no DOM required).
 */
export type RunOutcome =
  | { readonly kind: "rows"; readonly data: FrozenData; readonly truncated: boolean }
  | { readonly kind: "ok"; readonly rowsAffected: number }
  | { readonly kind: "confirm"; readonly sql: string; readonly risk: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Run `sql` verbatim through the raw `execute` path. The UI never parses,
 * splits, classifies, or composes SQL — the Core guarded executor is the sole
 * gate (AR-3). Pass `confirmed:true` to re-issue the IDENTICAL request after an
 * inline confirm accepts a `confirmation_required` preview.
 */
export async function runRawQuery(sql: string, confirmed?: boolean): Promise<RunOutcome> {
  const reply = await rpc<ExecuteResult>(
    "execute",
    confirmed ? { shape: "raw", sql, confirmed: true } : { shape: "raw", sql },
  );
  if (!reply.ok) return { kind: "error", message: envelopeText(reply.error) };
  const result = reply.result;
  switch (result.status) {
    case "rows":
      return { kind: "rows", data: result.data, truncated: result.truncated };
    case "ok":
      return { kind: "ok", rowsAffected: result.rowsAffected };
    case "confirmation_required":
      return { kind: "confirm", sql: result.preview.sql, risk: result.preview.risk };
    default: {
      // Exhaustiveness guard: if `ExecuteResult` ever gains a new status, this is a
      // compile error rather than a silent mislabel-as-confirm (which would then
      // dereference a missing `.preview`). Caught by the caller's try/catch.
      const unexpected: never = result;
      throw new Error(`unexpected execute status: ${JSON.stringify(unexpected)}`);
    }
  }
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
            className="rounded-[var(--radius)] border border-[var(--coral-line)] bg-[var(--coral-soft)] px-3 py-1 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "running…" : "run"}
          </button>
          <span className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">ctrl/cmd+enter</span>
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
        <div className="flex items-center border-b border-amber-700 bg-amber-950/40 px-3 py-2">
          <p className="font-mono text-xs lowercase text-amber-400">
            result truncated — only the first {data.rows.length} rows were returned
          </p>
        </div>
      ) : null}

      {confirm !== null ? (
        <div className="flex flex-col gap-2 border-b border-amber-700 bg-amber-950/40 px-3 py-2">
          <p className="font-mono text-xs lowercase text-amber-400">{confirm.risk}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-amber-200">
            {confirm.sql}
          </pre>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirmRun()}
              className="rounded-[var(--radius)] border border-red-700 bg-red-600 px-2 py-0.5 font-mono text-xs lowercase text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              confirm
            </button>
            <button
              type="button"
              autoFocus
              disabled={busy}
              onClick={() => setConfirm(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setConfirm(null);
              }}
              className="rounded-[var(--radius)] border border-[var(--border)] px-2 py-0.5 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              cancel
            </button>
          </div>
        </div>
      ) : null}

      {error !== null ? (
        <div className="flex items-center gap-3 border-b border-red-700 bg-red-950/40 px-3 py-2">
          <p role="alert" className="font-mono text-xs lowercase text-red-400">
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
