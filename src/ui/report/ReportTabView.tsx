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

import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionSummary, FrozenData, LiveReportPublishResult } from "../../shared/contract.ts";
import { MARK_KINDS, parseChartSpec, type MarkKind } from "../../shared/chart-spec.ts";
import { DataGrid } from "../data/DataGrid.tsx";
import { rpc } from "../rpc/client.ts";
import { ConfirmRun } from "../workspace/ConfirmRun.tsx";
import { runRawQuery } from "../workspace/run-raw-query.ts";
import { runExport, triggerHtmlDownload } from "./export-snapshot.ts";
import { runExport as runLiveExport } from "./export-live-report.ts";
import { mapChart } from "./report-chart.ts";
import { renderReportMarkdown } from "./report-markdown.ts";
import { planRetarget } from "./retarget-plan.ts";
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
  setReportTarget,
  updateProse,
  updateQuerySql,
  type ReportBlock,
  type ReportState,
  type ReportStateUpdate,
} from "./report-state.ts";

/** Transient (never-lifted) per-block run state, keyed by block id. */
type RunEntry = {
  readonly busy: boolean;
  /**
   * A pending `confirmation_required` preview, awaiting the author's confirm. It
   * TARGET-STAMPS the connection that produced the preview (Story 6.2): `confirmBlock`
   * fires the confirmed (possibly destructive) statement against `target`, not the live
   * picker value — so a `DELETE` previewed against test A can never commit onto prod B.
   */
  readonly confirm: { readonly sql: string; readonly risk: string; readonly target: string | null } | null;
  readonly selectedRow: number | null;
};

const IDLE: RunEntry = { busy: false, confirm: null, selectedRow: null };

/**
 * Run `runRawQuery` and map a throw to the same `{kind:"error"}` shape a failed envelope
 * produces. `connectionId` (Story 6.2) is the Report's re-target — forwarded verbatim to
 * the Core, which resolves it to a live connection in-Ring-1 (the url never crosses back).
 */
async function toOutcome(
  sql: string,
  confirmed?: boolean,
  connectionId?: string | null,
): Promise<Awaited<ReturnType<typeof runRawQuery>>> {
  try {
    return await runRawQuery(sql, confirmed, connectionId);
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
  // LOCAL draft of the in-progress pick. The editor renders from its OWN draft (not from
  // `block.chart`) so a partial selection — x chosen while y is still empty — is NOT wiped:
  // `onChange` parses the draft to a `ChartSpec | null` for the chart preview (an incomplete
  // draft degrades to the table view), but the pickers keep showing the raw draft so the
  // author can accumulate x AND y across separate picks. Seeded once from the stored spec;
  // the instance is stable per block id (the `<li key={block.id}>`), so the draft survives
  // re-renders and only resets when the block unmounts.
  const [draft, setDraft] = useState<{ mark: MarkKind; x: string; y: string; series: string }>(() => ({
    mark: (spec?.mark ?? "bar") as MarkKind,
    x: spec?.x ?? "",
    y: spec?.y ?? "",
    series: spec?.series ?? "",
  }));
  const update = (next: { mark: MarkKind; x: string; y: string; series: string }): void => {
    setDraft(next);
    onChange(next);
  };
  const select = "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-2 py-1 font-mono text-[11px] lowercase text-[var(--foreground)] outline-none focus:border-[var(--coral-line)]";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">mark</label>
      <select aria-label="mark" className={select} value={draft.mark} onChange={(e) => update({ ...draft, mark: e.target.value as MarkKind })}>
        {MARK_KINDS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <label className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">x</label>
      <select aria-label="x column" className={select} value={draft.x} onChange={(e) => update({ ...draft, x: e.target.value })}>
        <option value="">select…</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <label className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">y</label>
      <select aria-label="y column" className={select} value={draft.y} onChange={(e) => update({ ...draft, y: e.target.value })}>
        <option value="">select…</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <label className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">series</label>
      <select aria-label="series column" className={select} value={draft.series} onChange={(e) => update({ ...draft, series: e.target.value })}>
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
  // Per-block RUN generation. A re-target deliberately re-fires an already-busy block, so
  // two runs can be in flight for one id at once. Each `fireAgainst` bumps the id's gen and
  // captures it; only the LATEST run may touch that block's transient run state (busy/firing)
  // on completion — otherwise an old (superseded) run finishing first would falsely un-busy a
  // block whose newer re-fire is still running, re-opening the manual double-fire window.
  const runGen = useRef<Record<number, number>>({});
  const runEntry = (id: number): RunEntry => runs[id] ?? IDLE;

  // Available re-target connections (Story 6.2): fetched ONCE on mount over the proven
  // token-gated channel. Credential-free {@link ConnectionSummary} (`{id,name,…}`) only —
  // the picker sends just the id; the Core resolves the url in-Ring-1. An error/empty
  // list degrades gracefully (the picker still offers the default/launch target).
  const [connections, setConnections] = useState<ReadonlyArray<ConnectionSummary>>([]);
  useEffect(() => {
    let alive = true;
    void rpc<ReadonlyArray<ConnectionSummary>>("connections.list").then((reply) => {
      if (alive && reply.ok) setConnections(reply.result);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Fold one run completion, guarding against a stale write (FR-18 + Story 6.2):
   *  - a block REMOVED mid-run → drop entirely (no UI to clean).
   *  - a completion whose `firedTarget` differs from the report's CURRENT target → it is
   *    SUPERSEDED (the author re-targeted since it fired): its result is DROPPED, but its
   *    transient run state is STILL cleared (`busy=false`, release `firing`) so the
   *    still-present block never strands "running…" and can re-fire. (This differs from
   *    the removed-block no-op, which needs no cleanup because a removed block has no UI.)
   */
  const applyOutcome = (
    id: number,
    outcome: Awaited<ReturnType<typeof runRawQuery>>,
    firedTarget: string | null,
    isLatest: boolean,
  ): void => {
    if (!stateRef.current.blocks.some((b) => b.id === id)) return;
    if (stateRef.current.targetConnectionId !== firedTarget) {
      // Superseded by a re-target: discard the stale completion. Only clear the block's
      // transient run state if THIS is its latest run — a newer re-fire (higher gen) against
      // the new target owns the busy state now, and clearing it here would falsely un-busy a
      // block that is still running. Preserve the current grid selection.
      if (isLatest) {
        setRuns((r) => ({ ...r, [id]: { busy: false, confirm: null, selectedRow: (r[id] ?? IDLE).selectedRow } }));
      }
      return;
    }
    // Same-target completion, but NOT the latest run (an older re-fire against this same
    // target, with a newer one still in flight): last-FIRED wins, not last-COMPLETED. Drop
    // it entirely — folding its (possibly older) snapshot would let a slow gen-1 run against
    // B overwrite the fresh gen-3 run against B under a rapid A→B→C→B retarget, showing stale
    // data. The latest run owns BOTH the result fold and the transient state, so bail here.
    if (!isLatest) return;
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
        // Stay UNRUN: surface the Core's preview, STAMPED with the target that produced it
        // (`firedTarget`) so `confirmBlock` commits against THAT target, never the live picker.
        setRuns((r) => ({
          ...r,
          [id]: { busy: false, confirm: { sql: outcome.sql, risk: outcome.risk, target: firedTarget }, selectedRow: null },
        }));
        return;
    }
  };

  /**
   * Fire a query block against an EXPLICIT target (never read back from not-yet-committed
   * React state) — the unconditional run path. It sets the block busy + clears any pending
   * confirm, runs, then folds via {@link applyOutcome}. Used both for a normal run and for
   * a re-target re-fire (which must re-fire even busy/confirm-pending blocks).
   */
  const fireAgainst = async (id: number, sql: string, target: string | null, confirmed?: boolean): Promise<void> => {
    // Bump + capture this run's generation. If a later re-fire bumps it again before we
    // settle, this run is no longer the latest and must not touch transient run state.
    const gen = (runGen.current[id] = (runGen.current[id] ?? 0) + 1);
    firing.current[id] = true;
    setRuns((r) => ({ ...r, [id]: { busy: true, confirm: null, selectedRow: (r[id] ?? IDLE).selectedRow } }));
    const outcome = await toOutcome(sql, confirmed, target);
    const isLatest = runGen.current[id] === gen;
    applyOutcome(id, outcome, target, isLatest);
    if (isLatest) firing.current[id] = false;
  };

  const runBlock = async (id: number, sql: string): Promise<void> => {
    const entry = runEntry(id);
    if (firing.current[id] || entry.busy || entry.confirm !== null) return;
    await fireAgainst(id, sql, stateRef.current.targetConnectionId);
  };

  const confirmBlock = async (id: number): Promise<void> => {
    const entry = runEntry(id);
    if (firing.current[id] || entry.busy || entry.confirm === null) return;
    // Fire the confirmed statement against the CAPTURED target that produced the preview,
    // NOT the live picker value — belt-and-suspenders with retarget-cancels-confirm.
    await fireAgainst(id, entry.confirm.sql, entry.confirm.target, true);
  };

  const cancelConfirm = (id: number): void => {
    setRuns((r) => ({ ...r, [id]: { ...runEntry(id), confirm: null } }));
  };

  /**
   * Re-target the whole Report (Story 6.2). Commits the new target, then — driven by the
   * pure {@link planRetarget} — re-fires EVERY query block against the NEW target passed
   * EXPLICITLY (idle, in-flight, and confirm-pending alike; a pending confirm is dropped
   * by the reset). A superseded old-target completion is discarded by `applyOutcome`'s
   * guard, so rapid A→B→C settles every block on C with none left stuck or showing stale
   * data. Layout (order/prose/chart/view) is untouched — `setReportTarget` never mutates it.
   */
  // Export-snapshot state (Story 6.3): an in-flight flag (so a double-click cannot launch
  // overlapping exports/downloads) + a user-visible transient error surface (so a failed
  // fetch / non-OK response / assembly error is never a silent unhandled rejection and never
  // welds an error body into the file).
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // Synchronous in-flight guard: `exporting` state only lands after a re-render, so two
  // synchronous clicks in one render both see it `false`. The ref is the real correctness
  // guard against overlapping exports; the state just drives the disabled/label UI.
  const exportingRef = useRef(false);

  /**
   * Freeze the CURRENT block results into a self-contained `.html` and download it (Story 6.3).
   * Reads Ring-2 state only — runs no query, opens no connection. Guards concurrency and wraps
   * the whole export in try/catch; on failure surfaces a message and downloads NOTHING.
   */
  const handleExport = async (): Promise<void> => {
    if (exportingRef.current) return; // in-flight guard: ignore a synchronous double-click
    exportingRef.current = true;
    setExporting(true);
    setExportError(null);
    try {
      await runExport({
        blocks: stateRef.current.blocks,
        // Fetch the data-free runtime once, same-origin; a non-OK / empty body throws BEFORE
        // any assembly, so nothing is ever downloaded on a failed fetch.
        fetchRuntime: async () => {
          const res = await fetch("/snapshot-runtime.js");
          if (!res.ok) throw new Error(`snapshot runtime unavailable (${res.status})`);
          const js = await res.text();
          if (js.length === 0) throw new Error("snapshot runtime is empty");
          return js;
        },
        download: triggerHtmlDownload,
      });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "export failed");
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };

  // Export-live-report state (Story 6.4): a SEPARATE in-flight flag + error surface from the
  // snapshot export (so the two controls never share a busy/error state), plus a synchronous
  // ref guard so a double-click cannot launch overlapping publishes/downloads.
  const [exportingLive, setExportingLive] = useState(false);
  const [exportLiveError, setExportLiveError] = useState<string | null>(null);
  const exportingLiveRef = useRef(false);

  /**
   * Publish the CURRENT layout+SQL to the local Core, open the loopback live view, and download
   * a portable, secret-free `.html` copy (Story 6.4). Reads Ring-2 state only — runs no query,
   * bakes no data/token into the portable file. Guards concurrency and wraps the whole export in
   * try/catch; on failure surfaces a message and never welds an error body into a file.
   */
  const handleExportLive = async (): Promise<void> => {
    if (exportingLiveRef.current) return; // in-flight guard: ignore a synchronous double-click
    exportingLiveRef.current = true;
    setExportingLive(true);
    setExportLiveError(null);
    try {
      await runLiveExport({
        blocks: stateRef.current.blocks,
        // Publish the layout+SQL doc to the LOCAL Core; only the loopback Core ever sees it.
        rpc: (method, params) => rpc<LiveReportPublishResult>(method, params),
        // Reserve the live-view tab SYNCHRONOUSLY inside the click gesture (runExport calls this
        // before any await) so the browser's popup blocker honours it. `about:blank` is navigated
        // to `/live/<id>` once publish resolves; `null` (blocked) surfaces an "allow popups" note.
        reserveWindow: () => (typeof window !== "undefined" ? window.open("about:blank") : null),
        navigate: (w, path) => {
          w.location.href = path;
        },
        closeWindow: (w) => w.close(),
        // Fetch the data-free runtime once, same-origin; a non-OK / empty body throws BEFORE any
        // assembly, so nothing is ever downloaded on a failed fetch.
        fetchRuntime: async () => {
          const res = await fetch("/live-report-runtime.js");
          if (!res.ok) throw new Error(`live report runtime unavailable (${res.status})`);
          const js = await res.text();
          if (js.length === 0) throw new Error("live report runtime is empty");
          return js;
        },
        download: triggerHtmlDownload,
      });
    } catch (e) {
      setExportLiveError(e instanceof Error ? e.message : "live export failed");
    } finally {
      exportingLiveRef.current = false;
      setExportingLive(false);
    }
  };

  const handleRetarget = (target: string | null): void => {
    if (target === stateRef.current.targetConnectionId) return;
    onStateChange((prev) => setReportTarget(prev, target));
    const actions = planRetarget(stateRef.current.blocks, runs);
    for (const action of actions) {
      if (action.refire) {
        void fireAgainst(action.id, action.sql, target);
      } else {
        setRuns((r) => ({ ...r, [action.id]: { ...action.reset } }));
      }
    }
  };

  const totalBlocks = state.blocks.length;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar: re-target picker + add a block. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)] px-3 py-2">
        <span className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">report</span>
        {/* Re-target picker (Story 6.2): "Default (launch connection)" = null, plus each
            saved connection by name. Changing it re-runs every query block against the new
            target — only the connection id crosses to the Core (credentials stay in Ring 1). */}
        <label htmlFor="report-target" className="ml-2 font-mono text-[11px] lowercase text-[var(--muted-foreground)]">
          target
        </label>
        <select
          id="report-target"
          aria-label="report target"
          value={state.targetConnectionId ?? ""}
          onChange={(e) => handleRetarget(e.target.value === "" ? null : e.target.value)}
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-2 py-1 font-mono text-[11px] lowercase text-[var(--foreground)] outline-none focus:border-[var(--coral-line)]"
        >
          <option value="">Default (launch connection)</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          {/* Quiet ghost/secondary export control (Story 6.3): freezes the current block
              results into a self-contained .html download. Disabled while an export is in
              flight so a double-click cannot launch overlapping exports. Never mutates blocks. */}
          {exportError !== null ? (
            <span role="alert" className="font-mono text-[11px] lowercase text-red-400">
              {exportError}
            </span>
          ) : null}
          {exportLiveError !== null ? (
            <span role="alert" className="font-mono text-[11px] lowercase text-red-400">
              {exportLiveError}
            </span>
          ) : null}
          <button
            type="button"
            className={ghostBtn}
            disabled={exporting}
            aria-label="export snapshot"
            onClick={() => void handleExport()}
          >
            {exporting ? "exporting…" : "export snapshot"}
          </button>
          {/* Sibling quiet ghost/secondary export control (Story 6.4): publishes the current
              layout+SQL to the local Core, opens the loopback live view, and downloads a
              portable secret-free .html. Disabled while a live export is in flight so a
              double-click cannot launch overlapping exports. Never mutates blocks. */}
          <button
            type="button"
            className={ghostBtn}
            disabled={exportingLive}
            aria-label="export live report"
            onClick={() => void handleExportLive()}
          >
            {exportingLive ? "exporting…" : "export live report"}
          </button>
          <button type="button" className={btn} onClick={() => onStateChange((prev) => addProseBlock(prev))}>
            + prose
          </button>
          <button type="button" className={btn} onClick={() => onStateChange((prev) => addQueryBlock(prev))}>
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
                  onUp={() => onStateChange((prev) => moveBlock(prev, block.id, "up"))}
                  onDown={() => onStateChange((prev) => moveBlock(prev, block.id, "down"))}
                  onRemove={() => {
                    onStateChange((prev) => removeBlock(prev, block.id));
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
                    onChange={(md) => onStateChange((prev) => updateProse(prev, block.id, md))}
                  />
                ) : (
                  <QueryBlock
                    block={block}
                    entry={runEntry(block.id)}
                    onSqlChange={(sql) => onStateChange((prev) => updateQuerySql(prev, block.id, sql))}
                    onRun={() => void runBlock(block.id, block.sql)}
                    onConfirm={() => void confirmBlock(block.id)}
                    onCancel={() => cancelConfirm(block.id)}
                    onView={(view) => onStateChange((prev) => setBlockView(prev, block.id, view))}
                    onSelectRow={(row) => setRuns((r) => ({ ...r, [block.id]: { ...runEntry(block.id), selectedRow: row } }))}
                    onChartChange={(raw) => {
                      // Validate the composed spec against THIS result's columns; an incomplete /
                      // invalid pick clears the chart (mapChart then degrades to the table view).
                      // Functional updater (like the async run writes) so a concurrent block's
                      // just-stored result is never clobbered by this render-snapshot write (FR-18).
                      const columnNames = block.result?.columns.map((c) => c.name) ?? [];
                      const spec = parseChartSpec(
                        { mark: raw.mark, x: raw.x, y: raw.y, ...(raw.series !== "" ? { series: raw.series } : {}) },
                        columnNames,
                      );
                      onStateChange((prev) => setBlockChart(prev, block.id, spec));
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
