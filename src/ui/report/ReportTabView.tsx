/**
 * quick-studio UI (Ring 2) — ReportTabView (builder + preview) — Story 6.1.
 *
 * The Report tab UI: compose an ordered list of content Blocks (narrative prose +
 * query blocks), each rendered live in the SAME column (build == preview). Prose
 * blocks render as SANITIZED HTML (`renderReportMarkdown`, raw HTML disabled). Query
 * blocks run their OWN SQL through the shared `runRawQuery` seam (loopback Core, AR-2),
 * hold the returned {@link FrozenData}, and render read-only either as a {@link DataGrid}
 * (table) or an in-app {@link ReportChart} (Recharts, Ring 2, AR-14). Two or more query
 * blocks are independent — each owns its own SQL/result, so one failing never affects
 * another (FR-18).
 *
 * State split (mirrors `ChatTabView`): the ordered block list + each block's result /
 * error / view / chart is the LIFTED {@link ReportState} (`state` / `onStateChange`,
 * held in `App` keyed by tab id, session-only, never persisted). Transient run state
 * (busy, a pending destructive `confirmation_required`, the selected grid row) lives in
 * LOCAL component state keyed by block id — never lifted, reset on remount.
 *
 * The Core is the sole risk gate (AR-3): the UI sends SQL verbatim and surfaces a
 * `confirmation_required` preview via the shared `ConfirmRun` dialog — a guarded op
 * stays unrun until the author confirms. No data leaves the machine (R5): the only
 * outbound call is `runRawQuery`.
 */

import { useMemo, useRef, useState } from "react";
import type { FrozenData } from "../../shared/contract.ts";
import { MARK_KINDS, parseChartSpec, type MarkKind } from "../../shared/chart-spec.ts";
import { DataGrid } from "../data/DataGrid.tsx";
import { ConfirmRun } from "../workspace/ConfirmRun.tsx";
import { runRawQuery } from "../workspace/run-raw-query.ts";
import { mapChart } from "./report-chart.ts";
import { renderReportMarkdown } from "./report-markdown.ts";
import { ReportChart } from "./ReportChart.tsx";
import {
  addProseBlock,
  addQueryBlock,
  moveBlock,
  removeBlock,
  setBlockChart,
  setBlockError,
  setBlockOk,
  setBlockResult,
  setBlockView,
  updateProse,
  updateQuerySql,
  type ReportBlock,
  type ReportState,
  type ReportStateUpdate,
} from "./report-state.ts";

/** Transient (never-lifted) per-block run state, keyed by block id. */
type RunEntry = {
  readonly busy: boolean;
  /** A pending `confirmation_required` preview, awaiting the author's confirm. */
  readonly confirm: { readonly sql: string; readonly risk: string } | null;
  readonly selectedRow: number | null;
};

const IDLE: RunEntry = { busy: false, confirm: null, selectedRow: null };

/** Run `run` and map a throw to the same `{kind:"error"}` shape a failed envelope produces. */
async function toOutcome(sql: string, confirmed?: boolean): Promise<Awaited<ReturnType<typeof runRawQuery>>> {
  try {
    return await runRawQuery(sql, confirmed);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

const btn =
  "rounded-[var(--radius)] border border-[var(--coral-line)] bg-[var(--coral-soft)] px-2 py-0.5 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
const ghostBtn =
  "rounded-[var(--radius)] border border-[var(--border)] px-2 py-0.5 font-mono text-[11px] lowercase text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-40";

/** The per-block header: an ordinal label + reorder/remove controls. */
function BlockControls({
  label,
  onUp,
  onDown,
  onRemove,
}: {
  label: string;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">{label}</span>
      <div className="ml-auto flex items-center gap-1">
        <button type="button" aria-label="move up" className={ghostBtn} onClick={onUp}>
          ↑
        </button>
        <button type="button" aria-label="move down" className={ghostBtn} onClick={onDown}>
          ↓
        </button>
        <button type="button" aria-label="remove block" className={ghostBtn} onClick={onRemove}>
          remove
        </button>
      </div>
    </div>
  );
}

/** The inline chart-spec editor: mark + x/y/series column pickers, validated against the result. */
function ChartSpecEditor({
  data,
  block,
  onChange,
}: {
  data: FrozenData;
  block: Extract<ReportBlock, { kind: "query" }>;
  onChange: (raw: { mark: MarkKind; x: string; y: string; series: string }) => void;
}): React.JSX.Element {
  const columns = data.columns.map((c) => c.name);
  const spec = block.chart;
  const cur = {
    mark: (spec?.mark ?? "bar") as MarkKind,
    x: spec?.x ?? "",
    y: spec?.y ?? "",
    series: spec?.series ?? "",
  };
  const select = "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-2 py-1 font-mono text-[11px] lowercase text-[var(--foreground)] outline-none focus:border-[var(--coral-line)]";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">mark</label>
      <select aria-label="mark" className={select} value={cur.mark} onChange={(e) => onChange({ ...cur, mark: e.target.value as MarkKind })}>
        {MARK_KINDS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <label className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">x</label>
      <select aria-label="x column" className={select} value={cur.x} onChange={(e) => onChange({ ...cur, x: e.target.value })}>
        <option value="">select…</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <label className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">y</label>
      <select aria-label="y column" className={select} value={cur.y} onChange={(e) => onChange({ ...cur, y: e.target.value })}>
        <option value="">select…</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <label className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">series</label>
      <select aria-label="series column" className={select} value={cur.series} onChange={(e) => onChange({ ...cur, series: e.target.value })}>
        <option value="">none</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ReportTabView({
  state,
  onStateChange,
}: {
  /** The session-only Report state for this Tab (never persisted to disk/snapshot). */
  state: ReportState;
  onStateChange: (next: ReportStateUpdate) => void;
}): React.JSX.Element {
  // Latest lifted state, read ONLY as a presence guard in async run callbacks: if a block
  // was removed while its run was in flight, its completion must no-op (never resurrect a
  // now-absent block). The state WRITE itself goes through a functional updater on
  // `onStateChange`, so two runs completing in the same React batch both survive. FR-18.
  const stateRef = useRef(state);
  stateRef.current = state;

  const [runs, setRuns] = useState<Readonly<Record<number, RunEntry>>>({});
  // Synchronous re-entrancy guards per block id (a `busy` setState only lands after a
  // re-render; a ref blocks a synchronous double-fire on the same run button).
  const firing = useRef<Record<number, boolean>>({});
  const runEntry = (id: number): RunEntry => runs[id] ?? IDLE;

  const applyOutcome = (id: number, outcome: Awaited<ReturnType<typeof runRawQuery>>): void => {
    // If the block was removed mid-run, drop the outcome entirely — do not fold a result
    // onto an absent block nor re-create its transient run state (busy/confirm/result).
    if (!stateRef.current.blocks.some((b) => b.id === id)) return;
    switch (outcome.kind) {
      case "rows":
        // Functional updater: fold against the LATEST state so a sibling block's result
        // stored in the same tick is preserved. Carry `truncated` (partial data flag).
        onStateChange((prev) => setBlockResult(prev, id, outcome.data, outcome.truncated));
        setRuns((r) => ({ ...r, [id]: { busy: false, confirm: null, selectedRow: null } }));
        return;
      case "error":
        onStateChange((prev) => setBlockError(prev, id, outcome.message));
        setRuns((r) => ({ ...r, [id]: { busy: false, confirm: null, selectedRow: null } }));
        return;
      case "ok":
        // A successful DML/DDL — NEUTRAL info note, not an error (no red, no role=alert).
        onStateChange((prev) =>
          setBlockOk(prev, id, `${outcome.rowsAffected} row${outcome.rowsAffected === 1 ? "" : "s"} affected`),
        );
        setRuns((r) => ({ ...r, [id]: { busy: false, confirm: null, selectedRow: null } }));
        return;
      case "confirm":
        // Stay UNRUN: surface the Core's preview for the author to confirm/cancel.
        setRuns((r) => ({ ...r, [id]: { busy: false, confirm: { sql: outcome.sql, risk: outcome.risk }, selectedRow: null } }));
        return;
    }
  };

  const runBlock = async (id: number, sql: string): Promise<void> => {
    const entry = runEntry(id);
    if (firing.current[id] || entry.busy || entry.confirm !== null) return;
    firing.current[id] = true;
    setRuns((r) => ({ ...r, [id]: { ...entry, busy: true } }));
    const outcome = await toOutcome(sql);
    applyOutcome(id, outcome);
    firing.current[id] = false;
  };

  const confirmBlock = async (id: number): Promise<void> => {
    const entry = runEntry(id);
    if (firing.current[id] || entry.busy || entry.confirm === null) return;
    firing.current[id] = true;
    const sql = entry.confirm.sql;
    setRuns((r) => ({ ...r, [id]: { ...entry, busy: true } }));
    const outcome = await toOutcome(sql, true);
    applyOutcome(id, outcome);
    firing.current[id] = false;
  };

  const cancelConfirm = (id: number): void => {
    setRuns((r) => ({ ...r, [id]: { ...runEntry(id), confirm: null } }));
  };

  const totalBlocks = state.blocks.length;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar: add a block. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)] px-3 py-2">
        <span className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">report</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={btn} onClick={() => onStateChange(addProseBlock(state))}>
            + prose
          </button>
          <button type="button" className={btn} onClick={() => onStateChange(addQueryBlock(state))}>
            + query
          </button>
        </div>
      </div>

      {/* Block list == live preview. */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {totalBlocks === 0 ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 text-center lowercase text-[var(--muted-foreground)]"
            style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
          >
            <div>empty report</div>
            <p className="max-w-sm text-[11px]">add a prose or query block to start building.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {state.blocks.map((block, i) => (
              <li
                key={block.id}
                className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-3"
              >
                <BlockControls
                  label={`${block.kind} · block ${i + 1}/${totalBlocks}`}
                  onUp={() => onStateChange(moveBlock(state, block.id, "up"))}
                  onDown={() => onStateChange(moveBlock(state, block.id, "down"))}
                  onRemove={() => {
                    onStateChange(removeBlock(state, block.id));
                    setRuns((r) => {
                      if (!(block.id in r)) return r;
                      const next = { ...r };
                      delete next[block.id];
                      return next;
                    });
                  }}
                />

                {block.kind === "prose" ? (
                  <ProseBlock
                    markdown={block.markdown}
                    onChange={(md) => onStateChange(updateProse(state, block.id, md))}
                  />
                ) : (
                  <QueryBlock
                    block={block}
                    entry={runEntry(block.id)}
                    onSqlChange={(sql) => onStateChange(updateQuerySql(state, block.id, sql))}
                    onRun={() => void runBlock(block.id, block.sql)}
                    onConfirm={() => void confirmBlock(block.id)}
                    onCancel={() => cancelConfirm(block.id)}
                    onView={(view) => onStateChange(setBlockView(state, block.id, view))}
                    onSelectRow={(row) => setRuns((r) => ({ ...r, [block.id]: { ...runEntry(block.id), selectedRow: row } }))}
                    onChartChange={(raw) => {
                      // Validate the composed spec against THIS result's columns; an incomplete /
                      // invalid pick clears the chart (mapChart then degrades to the table view).
                      const columnNames = block.result?.columns.map((c) => c.name) ?? [];
                      const spec = parseChartSpec(
                        { mark: raw.mark, x: raw.x, y: raw.y, ...(raw.series !== "" ? { series: raw.series } : {}) },
                        columnNames,
                      );
                      onStateChange(setBlockChart(state, block.id, spec));
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * One prose block: a Markdown editor + its live sanitized-HTML preview. The render is
 * MEMOIZED on the block's Markdown so `renderReportMarkdown` is not re-run for every other
 * prose block on each keystroke (only the edited block's memo invalidates).
 */
function ProseBlock({
  markdown,
  onChange,
}: {
  markdown: string;
  onChange: (markdown: string) => void;
}): React.JSX.Element {
  const html = useMemo(() => renderReportMarkdown(markdown), [markdown]);
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={markdown}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={4}
        aria-label="prose markdown"
        placeholder="write narrative markdown…"
        className="w-full resize-y rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[var(--foreground)] outline-none focus:border-[var(--coral-line)]"
        style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
      />
      {markdown.trim() !== "" ? (
        <div
          className="report-prose max-w-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
          // Sanitized HTML: `renderReportMarkdown` disables raw HTML and neutralizes
          // dangerous URL schemes, so no script/embed can execute (R5).
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : null}
    </div>
  );
}

/** One query block: SQL editor + run, then the result as a table or an in-app chart. */
function QueryBlock({
  block,
  entry,
  onSqlChange,
  onRun,
  onConfirm,
  onCancel,
  onView,
  onSelectRow,
  onChartChange,
}: {
  block: Extract<ReportBlock, { kind: "query" }>;
  entry: RunEntry;
  onSqlChange: (sql: string) => void;
  onRun: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onView: (view: "table" | "chart") => void;
  onSelectRow: (row: number) => void;
  onChartChange: (raw: { mark: MarkKind; x: string; y: string; series: string }) => void;
}): React.JSX.Element {
  const result = block.result;
  const chartData = result !== null ? mapChart(result, block.chart) : null;
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={block.sql}
        onChange={(e) => onSqlChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onRun();
          }
        }}
        spellCheck={false}
        rows={3}
        aria-label="block sql"
        placeholder="select … from …"
        className="w-full resize-y rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[var(--foreground)] outline-none focus:border-[var(--coral-line)]"
        style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
      />
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={entry.busy || entry.confirm !== null} onClick={onRun}>
          {entry.busy ? "running…" : "run"}
        </button>
        {result !== null ? (
          <div className="ml-auto flex items-center gap-0.5" role="tablist" aria-label="result view">
            {(["table", "chart"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={block.view === v}
                onClick={() => onView(v)}
                className={`rounded-[var(--radius)] border px-2 py-0.5 font-mono text-[11px] lowercase transition-colors ${
                  block.view === v
                    ? "border-[var(--coral-line)] bg-[var(--coral-soft)] text-[var(--foreground)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {entry.confirm !== null ? (
        <ConfirmRun sql={entry.confirm.sql} risk={entry.confirm.risk} busy={entry.busy} onConfirm={onConfirm} onCancel={onCancel} />
      ) : null}

      {block.error !== undefined ? (
        <p role="alert" className="font-mono text-xs lowercase text-red-400">
          {block.error}
        </p>
      ) : null}

      {/* A successful DML/DDL run: NEUTRAL note (not an error) — no red, no role=alert. */}
      {block.info !== undefined ? (
        <p className="font-mono text-xs lowercase text-[var(--muted-foreground)]">{block.info}</p>
      ) : null}

      {/* Partial data guard: a truncated result never presents as complete in a report. */}
      {result !== null && block.truncated === true ? (
        <p className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">
          showing first {result.rows.length} rows (truncated)
        </p>
      ) : null}

      {result !== null && block.view === "table" ? (
        <div className="h-64">
          <DataGrid data={result} primaryKeys={[]} selectedRow={entry.selectedRow} onSelectRow={onSelectRow} />
        </div>
      ) : null}

      {result !== null && block.view === "chart" ? (
        <div className="flex flex-col gap-2">
          <ChartSpecEditor data={result} block={block} onChange={onChartChange} />
          {chartData !== null ? (
            <div className="h-64 w-full">
              <ReportChart chart={chartData} />
            </div>
          ) : (
            // Degrade without a crash (I/O matrix): no valid spec → prompt + fall back to the table.
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">
                pick valid x/y columns to draw a chart — showing the table meanwhile
              </p>
              <div className="h-64">
                <DataGrid data={result} primaryKeys={[]} selectedRow={entry.selectedRow} onSelectRow={onSelectRow} />
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
