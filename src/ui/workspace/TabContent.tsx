/**
 * quick-studio UI (Ring 2) — TabContent.
 *
 * Renders the body of the active Tab. A bound `table` Tab (Story 3.2) fetches one
 * page via `table.rows`, manages page state, and renders the {@link DataGrid} plus
 * a Prev/Next pager and a "rows X–Y of N" summary — one table shown at a time. An
 * unbound `table` Tab shows a "select a table" empty state. A `query` Tab (Story
 * 3.6) renders {@link QueryTabView}, the ad-hoc SQL runner. The remaining kinds
 * (erd / chat / report) stay labelled shell placeholders for later epics.
 */

import { useEffect, useMemo, useState } from "react";
import type {
  ConnectionSummary,
  ErdTabLayout,
  ExecuteResult,
  FrozenRow,
  ProviderKind,
  SchemaIndexInfo,
  SchemaTableInfo,
  StructuredOp,
  TableRowsResult,
} from "../../shared/contract.ts";
import { DataGrid } from "../data/DataGrid.tsx";
import { IndexList } from "../data/IndexList.tsx";
import { filterRows, rowsToCsv } from "../data/grid-view.ts";
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
import {
  buildDeleteOp,
  buildInsertOp,
  buildUpdateOp,
  isMutationError,
  type CellEdit,
  type DraftCell,
} from "../data/row-mutations.ts";
import { rpc } from "../rpc/client.ts";
import { envelopeText } from "../rpc/envelope-text.ts";
import { ChatTabView } from "./ChatTabView.tsx";
import { emptyChatState, type ChatState } from "./chat-model.ts";
import { ErdTabView } from "./ErdTabView.tsx";
import { QueryTabView } from "./QueryTabView.tsx";
import { ReportTabView } from "../report/ReportTabView.tsx";
import type { ReportSpec } from "../../shared/report-spec.ts";
import { emptyReport, type ReportState, type ReportStateUpdate } from "../report/report-state.ts";
import { SettingsPanel } from "../settings/SettingsPanel.tsx";
import { CreateTablePanel } from "../schema/CreateTablePanel.tsx";
import { isTabConnectionMissing, type TabKind, type TableRef, type WorkspaceTab } from "./workspace-state.ts";

/** Short human blurb per Tab kind for the (non-table) placeholder body. */
const KIND_BLURB: Readonly<Record<TabKind, string>> = {
  table: "Browse rows and columns of a table.",
  query: "Compose and run SQL against the connection. (Epic 3.)",
  erd: "Visualize the schema as an entity-relationship diagram. (Epic 4.)",
  chat: "Ask questions about your data in natural language. (Epic 5.)",
  report: "Assemble and export a data report. (Epic 6.)",
  // The `settings` tab renders SettingsPanel, never the placeholder body — this entry
  // only keeps the Record<TabKind,…> exhaustive under tsc.
  settings: "Manage connections and AI providers.",
  // The `create-table` tab renders CreateTablePanel, never the placeholder body — this
  // entry only keeps the Record<TabKind,…> exhaustive under tsc (Story 9.4).
  "create-table": "Author a new table.",
};

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center p-8">
      <div className="text-base font-medium text-foreground">No tab open</div>
      <p className="max-w-sm text-sm text-muted-foreground">
        Open a table, query, ERD, chat, or report from the launcher on the left to
        start working.
      </p>
    </div>
  );
}

/** A bound table Tab: fetches + paginates `table.rows` and renders the grid + pager. */
function TableTabView({
  table,
  primaryKeys,
  indexes,
}: {
  table: TableRef;
  primaryKeys: ReadonlyArray<string>;
  /** The bound table's introspected indexes (already in the schema payload; no fetch). */
  indexes: ReadonlyArray<SchemaIndexInfo>;
}): React.JSX.Element {
  // The `rows | indexes` sub-view. Indexes are already in hand (schema payload), so
  // switching is a pure local toggle — no rpc, no SQL composed in the UI.
  const [view, setView] = useState<"rows" | "indexes">("rows");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TableRowsResult["data"] | null>(null);
  const [grid, setGrid] = useState<DataGridState>(() => createDataGridState());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Presentation-only view state (never a refetch): the live client-side row filter,
  // the last `table.rows` round-trip latency for the result-bar readout, and whether
  // the in-grid insert draft is open (so the result-bar Add-Row can open the same one).
  const [filterQuery, setFilterQuery] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  // Bumped by the error banner's "retry" so the fetch effect re-fires for the
  // CURRENT page — a failed page-N fetch would otherwise leave the pager frozen
  // (Next is a no-op when it targets the already-set page) with no in-tab recovery.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Mutation feedback, owned here (the grid stays presentational). `mutating` gates
  // inputs against a double-submit; `mutationError` surfaces a build/RPC failure
  // inline without touching the page-load `error` banner (the panel stays alive).
  const [mutating, setMutating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Exactly one PK column is the executor's `resolveSinglePkTable` precondition — the two
  // PK-ADDRESSED mutations (inline edit, row delete) are disabled without it, and so is the
  // result bar's Add-Row below.
  //
  // NOT a read-only tab, despite what this comment claimed until the 10.5 follow-up review:
  // INSERT needs no PK (`executeInsert` has no `resolveSinglePkTable` precondition), and
  // `DataGrid` deliberately keeps its own in-grid `+ insert row` draft available whatever
  // `canMutate` says — so an insert stays reachable here. That is SAFE (the draft commits
  // through `runOp`, which spreads `connectionScope`, so it lands in this tab's own
  // database and never another), but it is not the "no catalog ⇒ no writes" property the
  // `primaryKeys` bail was described as buying. The two add-row affordances disagreeing —
  // one gated on `canMutate`, its in-grid twin not — is a pre-existing 7.2/3.3 seam, left
  // for the product call rather than silently resolved by a review.
  //
  // A SAVED-CONNECTION tab always lands here: `primaryKeys` is resolved out of the shared
  // `allTables` catalog, which since Story 10.5 describes the BOOT target only, and
  // `App.tsx` deliberately refuses to answer for a non-null `ref.connectionId` rather
  // than hand a write a same-named boot table's key. Giving such a tab its own
  // per-connection catalog (and with it its editing back) is Story 10.6.
  const canMutate = primaryKeys.length === 1;
  // A blank schema means "the connection's default namespace" (e.g. a table created
  // into the default schema on an otherwise-empty DB, whose optimistic tree entry
  // carries no known schema). Omit it entirely rather than sending `schema:""`, which
  // the Core rejects as `bad_request` ("non-empty string when provided"). Omission
  // lets the Core resolve the default, so browse AND structured mutations both work.
  const effectiveSchema = table.schema.trim() === "" ? undefined : table.schema;
  const target = { schema: effectiveSchema, table: table.name };
  // The connection this tab was activated FROM (Story 10.5). Spread into EVERY Core call
  // this tab makes — the browse read below and the structured-mutation `execute` alike —
  // so rows come from the database on screen and a write can never land in another one.
  // Omitted entirely for the boot target, keeping the default path's wire bytes unchanged.
  const connectionScope =
    table.connectionId == null ? {} : ({ connectionId: table.connectionId } as const);

  // NOTE: per-table state (page/data/grid/error/loading) is reset by REMOUNTING —
  // the parent keys this component by the bound table identity, so a table switch
  // gives fresh state and fires exactly one fetch (no stale error/pager, no
  // redundant fetch with the previous page). See `TabContent`'s `key` below.

  // Fetch the requested page whenever the page changes (the table is fixed for the
  // lifetime of this mount — a table switch remounts fresh instead).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    // Time the existing read for the result-bar `· <ms> ms` readout — a passive
    // measurement around the SAME rpc; it changes neither the call nor the deps.
    const startedAt = performance.now();
    void rpc<TableRowsResult>("table.rows", {
      schema: effectiveSchema,
      table: table.name,
      page,
      ...connectionScope,
    }).then((reply) => {
      if (!alive) return;
      if (!reply.ok) {
        // Don't attribute a latency readout to a failed load — the result bar would
        // otherwise show the previous page's summary next to the failed request's ms.
        setLatencyMs(null);
        setError(envelopeText(reply.error));
        setData(null);
      } else {
        setLatencyMs(Math.round(performance.now() - startedAt));
        setError(null);
        setData(reply.result.data);
        setGrid((g) =>
          applyPage(g, {
            page: reply.result.page,
            pageSize: reply.result.pageSize,
            total: reply.result.total,
            rowCount: reply.result.data.rows.length,
          }),
        );
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [table.schema, table.name, table.connectionId, page, reloadNonce]);

  // Run one structured op through the guarded Core executor. On `ok` (insert/update
  // auto-commit, or a confirmed delete) it refetches the current page via the
  // `reloadNonce` bump; on `confirmation_required` (a delete without the flag — the
  // Core is the real gate) it reports without mutating; any error surfaces inline.
  // Returns the domain status so a caller can branch (e.g. the delete confirm flow).
  const runOp = async (op: StructuredOp, confirmed: boolean): Promise<ExecuteResult["status"] | "error"> => {
    setMutating(true);
    setMutationError(null);
    const reply = await rpc<ExecuteResult>("execute", {
      shape: "structured",
      op,
      confirmed,
      ...connectionScope,
    });
    setMutating(false);
    if (!reply.ok) {
      setMutationError(envelopeText(reply.error));
      return "error";
    }
    if (reply.result.status === "ok") {
      setReloadNonce((n) => n + 1);
      return "ok";
    }
    if (reply.result.status === "confirmation_required") {
      // Defensive: a delete should always carry `confirmed:true` by the time it runs.
      setMutationError(`confirmation required: ${reply.result.preview.risk}`);
      return "confirmation_required";
    }
    return reply.result.status;
  };

  // Fail a build error into the inline banner rather than issuing a doomed RPC.
  // Returns whether the edit was ACCEPTED (validation passed + the op committed `ok`)
  // vs REJECTED — the grid keeps the cell editor open (with its value) on rejection,
  // and only closes it on acceptance.
  const onCommitEdit = async (row: FrozenRow, column: string, edit: CellEdit): Promise<boolean> => {
    if (mutating || !data) return false;
    const op = buildUpdateOp({ target, columns: data.columns, primaryKeys, row, column, edit });
    if (isMutationError(op)) {
      setMutationError(op.error);
      return false;
    }
    return (await runOp(op, false)) === "ok";
  };

  const onDeleteRow = (row: FrozenRow): void => {
    if (mutating || !data) return;
    const op = buildDeleteOp({ target, columns: data.columns, primaryKeys, row });
    if (isMutationError(op)) {
      setMutationError(op.error);
      return;
    }
    // The UI already confirmed (inline yes/no); execute with the Core's gate flag.
    void runOp(op, true);
  };

  // Returns whether the insert SUCCEEDED (`ok`) so the draft row resets/closes only on
  // success — on a validation or RPC error the draft stays open with its values so a
  // re-submit doesn't require re-typing (and a successful insert can't be re-fired as
  // a duplicate).
  const onInsertRow = async (draft: ReadonlyArray<DraftCell>): Promise<boolean> => {
    if (mutating || !data) return false;
    const op = buildInsertOp({ target, columns: data.columns, draft });
    if (isMutationError(op)) {
      setMutationError(op.error);
      return false;
    }
    return (await runOp(op, false)) === "ok";
  };

  // The live filter is presentation-only: it hides/shows already-loaded rows, never a
  // refetch. Memoize so the derived page object keeps a stable identity across unrelated
  // renders — a fresh object every render would thrash `DataGrid`'s edit-reset effect.
  const visibleRows = useMemo(() => filterRows(data?.rows ?? [], filterQuery), [data, filterQuery]);
  const visibleData = useMemo(
    () => (data === null ? null : { ...data, rows: visibleRows }),
    [data, visibleRows],
  );

  // Selection is a positional index into the RENDERED rows; changing the filter reindexes
  // that list, so clear any selection to stop the highlight from landing on a different
  // underlying row. Presentation-only — never touches the pager/data model. (No-op when
  // nothing is selected, so filter keystrokes don't churn grid state.)
  useEffect(() => {
    setGrid((g) => (g.selectedRow === null ? g : selectRow(g, -1)));
  }, [filterQuery]);

  // Export the currently-shown rows to a client-side CSV — no rpc, no contract change.
  const onExport = (): void => {
    if (data === null) return;
    const csv = rowsToCsv(data.columns, visibleRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Qualify with the schema and strip filesystem-hostile characters so a table named
    // with a `/`, `.`, or reserved char yields a valid, non-colliding download filename.
    const base = effectiveSchema === undefined ? table.name : `${effectiveSchema}.${table.name}`;
    a.download = `${base.replace(/[^\w.-]+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Result bar: table name + pager + summary (mono, terse). */}
      <div
        className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--card)] px-3 py-1.5"
        style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
      >
        <span className="text-[var(--foreground)]">
          {table.schema.trim() === "" ? table.name : `${table.schema}.${table.name}`}
        </span>
        {/* rows | indexes sub-view toggle (Story 3.5). Read-only, no round-trip. */}
        <div className="flex items-center gap-0.5" role="tablist" aria-label="table sub-view">
          {(["rows", "indexes"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`rounded-[var(--radius)] border px-2 py-0.5 lowercase transition-colors ${
                view === v
                  ? "border-[var(--coral-line)] bg-[var(--coral-soft)] text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <span className="ml-auto lowercase text-[var(--muted-foreground)]">
          {view === "indexes" ? (
            `${indexes.length} ${indexes.length === 1 ? "index" : "indexes"}`
          ) : loading ? (
            "loading…"
          ) : (
            <>
              {rowRangeSummary(grid)}
              {latencyMs !== null ? (
                <>
                  {" · "}
                  <span className="text-[var(--coral)]">{latencyMs} ms</span>
                </>
              ) : null}
            </>
          )}
        </span>
        {view === "rows" ? (
          <>
            {/* Live client-side row filter — hides/shows loaded rows, never a refetch. */}
            <label className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[var(--muted-foreground)] focus-within:border-[var(--coral-line)]">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden
                className="h-3 w-3"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                type="text"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="filter rows…"
                aria-label="Filter rows"
                spellCheck={false}
                autoComplete="off"
                className="w-32 border-none bg-transparent lowercase text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
              />
            </label>
            {canMutate ? (
              <button
                type="button"
                onClick={() => setInsertOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 lowercase text-[var(--muted-foreground)] transition-colors hover:border-[var(--coral-line)] hover:text-[var(--foreground)]"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="h-3 w-3">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                row
              </button>
            ) : null}
            <button
              type="button"
              onClick={onExport}
              disabled={data === null || loading}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 lowercase text-[var(--muted-foreground)] transition-colors hover:border-[var(--coral-line)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className="h-3 w-3">
                <path d="M12 3v11M8 10l4 4 4-4M5 20h14" />
              </svg>
              export
            </button>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={!canPrev(grid) || loading || error !== null}
                onClick={() => setPage(prevPage(grid))}
                className="rounded-[var(--radius)] border border-[var(--border)] px-2 py-0.5 lowercase text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                prev
              </button>
              <button
                type="button"
                disabled={!canNext(grid) || loading || error !== null}
                onClick={() => setPage(nextPage(grid))}
                className="rounded-[var(--radius)] border border-[var(--border)] px-2 py-0.5 lowercase text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                next
              </button>
            </div>
          </>
        ) : null}
      </div>

      {view === "rows" && error !== null ? (
        <div className="flex items-center gap-3 border-b border-red-700 bg-red-950/40 px-3 py-2">
          <p role="alert" className="font-mono text-xs lowercase text-red-400">
            {error}
          </p>
          <button
            type="button"
            disabled={loading}
            onClick={() => setReloadNonce((n) => n + 1)}
            className="ml-auto rounded-[var(--radius)] border border-red-700 px-2 py-0.5 font-mono text-xs lowercase text-red-300 transition-colors hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            retry
          </button>
        </div>
      ) : null}

      {view === "rows" && mutationError !== null ? (
        <div className="flex items-center gap-3 border-b border-amber-700 bg-amber-950/40 px-3 py-2">
          <p role="alert" className="font-mono text-xs lowercase text-amber-400">
            {mutationError}
          </p>
          <button
            type="button"
            onClick={() => setMutationError(null)}
            className="ml-auto rounded-[var(--radius)] border border-amber-700 px-2 py-0.5 font-mono text-xs lowercase text-amber-300 transition-colors hover:bg-amber-900/40"
          >
            dismiss
          </button>
        </div>
      ) : null}

      {view === "indexes" ? (
        // Indexes ride in the schema payload already held in props — render directly,
        // no fetch, no dependence on the rows load state.
        <IndexList indexes={indexes} />
      ) : visibleData !== null ? (
        <DataGrid
          data={visibleData}
          primaryKeys={primaryKeys}
          selectedRow={grid.selectedRow}
          onSelectRow={(index) => setGrid((g) => selectRow(g, index))}
          canMutate={canMutate}
          busy={mutating}
          insertOpen={insertOpen}
          onInsertOpenChange={setInsertOpen}
          onCommitEdit={onCommitEdit}
          onDeleteRow={onDeleteRow}
          onInsertRow={onInsertRow}
        />
      ) : (
        <div
          className="flex min-h-0 flex-1 items-center justify-center lowercase text-[var(--muted-foreground)]"
          style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
        >
          {loading ? "loading…" : error !== null ? "could not load rows" : ""}
        </div>
      )}
    </div>
  );
}

/** The unbound table Tab prompt (no table selected yet). */
function SelectTablePrompt(): React.JSX.Element {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center lowercase text-[var(--muted-foreground)]"
      style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
    >
      <div>select a table</div>
      <p className="max-w-sm text-[11px]">pick a table from the schema tree on the left to browse its rows.</p>
    </div>
  );
}

/**
 * The missing-connection Tab body (Story 10.6): a Tab restored with a `connectionId` that
 * is no longer in the live `connections.list` — the connection was removed while the
 * workspace was closed (or from the Settings tab just now). It REPLACES the normal table
 * body entirely, `SelectTablePrompt` included — and NOT because the schema tree could not
 * fix it (it can: clicking any table under any surviving root runs `bindTableToActiveTab`,
 * which overwrites `connectionId` and clears this state). The reason is honesty: "select a
 * table" would present a tab that is unbound BECAUSE ITS DATABASE IS GONE as an ordinary
 * never-bound one, hiding the single fact the user needs — the connection this tab
 * remembers no longer exists. The tab itself is never dropped: it keeps its id, kind, title
 * and strip position, and stays closable and reassignable like any other.
 *
 * Purely presentational and EXPORTED so it is assertable under `renderToStaticMarkup`
 * (the repo has no jsdom, so a test can neither run an effect nor click). The reassign
 * picker is therefore a native `<details>` disclosure rather than React state: the live
 * connection list is present in the static markup (just collapsed) and needs no JS at all.
 * The STRINGS are the mockup's, verbatim and in Spanish; the LAYOUT is not — the mockup
 * renders one inline line inside the schema tree, while the spec asks for a tab-BODY state,
 * so the same copy is split across an alert line and a muted line identifying the tab.
 *
 * AR-12: a summary carries only the OPAQUE id plus `name`/`host`/`engine` — there is no url,
 * user or password to render even if this wanted to, and nothing else is read off it here.
 */
export function ConnectionUnavailable({
  tabTitle,
  connections,
  hasBootTarget = false,
  onReassign,
}: {
  /** The tab's title, echoed back so the user knows WHICH tab lost its connection. */
  tabTitle: string;
  /** The live saved connections offered as reassign targets (may be empty). */
  connections: ReadonlyArray<ConnectionSummary>;
  /**
   * Whether a boot/default target is configured (`ActiveConnectionInfo.hasTarget`). When it
   * is, the picker offers it as an extra entry that reassigns to `null` — the ONLY way back
   * to a usable database for a workspace whose saved connections were all deleted but which
   * was relaunched with a boot `--url`.
   */
  hasBootTarget?: boolean;
  /**
   * Point this tab at `connectionId` (the picker's only side effect). `null` = the
   * boot/default target, the same convention `ExecuteRequest.connectionId` uses. ABSENT
   * means there is nowhere to route a click, so the control renders inert rather than
   * pretending: a live-looking button that silently does nothing is worse than a disabled one.
   */
  onReassign?: (connectionId: string | null) => void;
}): React.JSX.Element {
  // Inert when there is nothing to offer OR nowhere to send the choice. The second half is
  // what stops a dropped prop anywhere along `App → Workspace → TabContent` from rendering
  // an enabled picker whose every entry is a no-op.
  const nothingToOffer = !hasBootTarget && connections.length === 0;
  const inert = nothingToOffer || onReassign === undefined;
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center lowercase text-[var(--muted-foreground)]"
      style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
    >
      <div role="alert" className="text-err">
        conexión no disponible (fue eliminada)
      </div>
      {/* `normal-case` because the tab title IS the table name, which is never re-cased
          (AR-19) — the block's `lowercase` would render an `Orders` tab as `orders`. */}
      <p className="max-w-sm text-[11px] normal-case">tab &quot;{tabTitle}&quot;</p>

      {inert ? (
        <>
          {/* Nothing to reassign to (or nowhere to report it): the affordance stays VISIBLE
              but inert, so the state reads as "nothing to reassign to" rather than "this app
              forgot to offer one". The hint names the one place that fixes it. */}
          <button
            type="button"
            disabled
            className="rounded-[var(--radius)] border border-border px-2.5 py-[3px] text-[11px] normal-case text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reasignar conexión…
          </button>
          {nothingToOffer ? (
            <p className="max-w-sm text-[11px]">
              no hay conexiones guardadas — agregá una en settings.
            </p>
          ) : null}
        </>
      ) : (
        <details className="w-full max-w-sm">
          {/* `list-none` alone leaves WebKit drawing its own disclosure triangle, so the
              vendor pseudo-element is hidden explicitly too. */}
          <summary className="mx-auto inline-block cursor-pointer list-none [&::-webkit-details-marker]:hidden rounded-[var(--radius)] border border-border px-2.5 py-[3px] text-[11px] normal-case text-[var(--foreground)] transition-colors hover:bg-muted">
            Reasignar conexión…
          </summary>
          {/* Bounded + scrollable: the body is `h-full … justify-center`, so an unbounded
              list spills off BOTH edges once it outgrows the tab, and an ancestor's
              `overflow-auto` cannot scroll to a negative offset — the alert line itself
              would become unreachable with enough saved connections. */}
          <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto">
            {hasBootTarget ? (
              // ABOVE the saved connections: it is the target that needs no registry entry,
              // and the only one still reachable when the registry is empty.
              <li>
                <button
                  type="button"
                  onClick={() => onReassign?.(null)}
                  className="flex w-full items-center gap-2 rounded-[var(--radius)] border border-border px-2.5 py-[3px] text-left text-[11px] normal-case text-[var(--foreground)] transition-colors hover:bg-muted"
                >
                  <span>conexión por defecto</span>
                  <span className="text-[var(--muted-foreground)]">(boot)</span>
                </button>
              </li>
            ) : null}
            {connections.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onReassign?.(c.id)}
                  className="flex w-full items-center gap-2 rounded-[var(--radius)] border border-border px-2.5 py-[3px] text-left text-[11px] normal-case text-[var(--foreground)] transition-colors hover:bg-muted"
                >
                  <span>{c.name}</span>
                  <span className="text-[var(--muted-foreground)]">· {c.host}</span>
                  <span className="ml-auto rounded-[var(--radius)] bg-muted px-1.5 text-[10px] text-[var(--muted-foreground)]">
                    {c.engine}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function TabContent({
  tab,
  primaryKeys,
  indexes,
  tables,
  queryDraft,
  onQueryDraftChange,
  chatState,
  onChatStateChange,
  lastProvider,
  reportState,
  onReportStateChange,
  onOpenReport,
  erdLayout,
  onErdLayoutChange,
  onCloseTab,
  schemas,
  onTableCreated,
  onRegistryChanged,
  connections,
  hasBootTarget,
  onReassignConnection,
}: {
  tab: WorkspaceTab | null;
  /** PK column names of the active table tab's bound table (for the grid key icon). */
  primaryKeys?: ReadonlyArray<string>;
  /** Introspected indexes of the active table tab's bound table (Story 3.5 sub-view). */
  indexes?: ReadonlyArray<SchemaIndexInfo>;
  /** All tables (introspected + optimistically-created) — the ERD data source (Story 4.1). */
  tables?: ReadonlyArray<SchemaTableInfo>;
  /** The active query tab's session-only draft SQL (Story 3.6; never persisted). */
  queryDraft?: string;
  /** Update the active query tab's draft SQL. */
  onQueryDraftChange?: (sql: string) => void;
  /** The active chat tab's session-only state (Story 5.2; never persisted). */
  chatState?: ChatState;
  /** Update the active chat tab's session state. */
  onChatStateChange?: (next: ChatState) => void;
  /** The last-used chat provider default hint (Story 8.5), or null. */
  lastProvider?: ProviderKind | null;
  /** The active report tab's session-only state (Story 6.1; never persisted). */
  reportState?: ReportState;
  /** Update the active report tab's session state. */
  onReportStateChange?: (next: ReportStateUpdate) => void;
  /** Open a chat-generated ReportSpec as a new Report tab (Story 9.7). */
  onOpenReport?: (spec: ReportSpec) => void;
  /** The active ERD tab's persisted layout (Story 4.2), or undefined for dagre fallback. */
  erdLayout?: ErdTabLayout;
  /** Report the active ERD tab's captured geometry up, keyed by tab id (Story 4.2). */
  onErdLayoutChange?: (tabId: number, layout: ErdTabLayout) => void;
  /** Close a tab by id — wired to the settings tab body's in-panel "close" (Story 8.6). */
  onCloseTab?: (id: number) => void;
  /** Existing schema names for the create-table target selector (Story 9.4). */
  schemas?: ReadonlyArray<string>;
  /** Append a freshly-created table to the App-level list on create success (Story 9.4). */
  onTableCreated?: (table: SchemaTableInfo) => void;
  /**
   * Report that the connection REGISTRY mutated (Story 10.5), so the permanently-mounted
   * schema tree can re-read `connections.list` and reconcile its roots. Fired from the
   * Settings mutation itself — not from a tab close — because the tree and Settings are
   * siblings in one React tree and a mount-only fetch froze the root list for the session.
   * The optional argument names a connection the mutation REPOINTED (see `SettingsPanel`),
   * which the tree needs because such a root survives reconciliation with a stale catalog.
   */
  onRegistryChanged?: (repointedConnectionId?: string) => void;
  /**
   * The live saved connections (Story 10.6), or `null` while the `connections.list` read is
   * in flight / after it failed. `null` is "not known yet" and NEVER flags a tab — see
   * {@link isTabConnectionMissing}. Owned by `Workspace`, which re-reads it on every
   * registry mutation.
   */
  connections?: ReadonlyArray<ConnectionSummary> | null;
  /**
   * Whether a boot/default target is configured (Story 10.5's `ActiveConnectionInfo.hasTarget`),
   * read by `Workspace` in the same round-trip as `connections`. It is what lets the reassign
   * picker offer a way back to the boot target when the registry is empty.
   */
  hasBootTarget?: boolean;
  /**
   * Point this tab at another connection (Story 10.6 reassign affordance). `null` = the
   * boot/default target — the reducer and `setTabConnection` have always accepted it; this
   * is the UI path that can actually produce it.
   */
  onReassignConnection?: (tabId: number, connectionId: string | null) => void;
}): React.JSX.Element {
  if (tab === null) {
    return <EmptyState />;
  }

  if (tab.kind === "table") {
    // The live id set, or `null` when the registry read has not answered. Built inline
    // (no `useMemo`) because this component early-returns per kind and so cannot call
    // hooks; the set is tiny (one entry per saved connection) and rebuilt only on a render
    // of the ACTIVE table tab.
    const liveIds = connections == null ? null : new Set(connections.map((c) => c.id));
    // The unavailable swap sits ABOVE the bound/unbound ternary on purpose: it is keyed on
    // the TAB's persisted `connectionId`, not on the (session-only) bound ref, so it covers
    // the restored-and-unbound case — which is precisely the case a relaunch produces.
    if (isTabConnectionMissing(tab, liveIds)) {
      return (
        <ConnectionUnavailable
          // Keyed by tab id like every sibling branch: this component only ever receives the
          // ACTIVE tab, so without a key two connection-unavailable tabs reuse one element
          // and the `<details>` disclosure state leaks from one tab to the other.
          key={tab.id}
          tabTitle={tab.title}
          connections={connections ?? []}
          hasBootTarget={hasBootTarget ?? false}
          // Forwarded as `undefined` when there is no handler, so the picker renders inert
          // instead of wrapping a no-op in a live-looking button (the wrapper arrow would
          // otherwise always be defined, whatever the prop below it).
          onReassign={
            onReassignConnection === undefined
              ? undefined
              : (connectionId) => onReassignConnection(tab.id, connectionId)
          }
        />
      );
    }
    return tab.table !== undefined ? (
      // Key by the bound table identity so a table switch REMOUNTS with fresh
      // per-table state (page/data/grid/error) and fires a single fetch. The owning
      // connection is part of that identity (Story 10.5) — the same `schema.name` under
      // two different roots is two different tables and must not reuse one mount's rows.
      //
      // A REPOINT (a Settings edit moving a saved connection to another database) leaves
      // every part of this key identical, so it triggers no remount — but it needs none:
      // only the ACTIVE tab's body is mounted, and repointing requires the Settings tab to
      // be active, so this body is unmounted throughout and refetches from the live target
      // when the user comes back. What survives the repoint is the tab's BINDING, which
      // still names a `schema.name` chosen in the old database — the ledger's open 10.6
      // entry, not something a key can fix.
      <TableTabView
        key={`${tab.table.connectionId ?? ""}::${tab.table.schema}.${tab.table.name}`}
        table={tab.table}
        primaryKeys={primaryKeys ?? []}
        indexes={indexes ?? []}
      />
    ) : (
      <SelectTablePrompt />
    );
  }

  if (tab.kind === "query") {
    // Keyed by tab id so each query Tab owns an isolated result/confirm/pending
    // state instance — without this, switching Tabs reuses one component and leaks
    // Tab A's grid AND its pending destructive-confirm into Tab B (mirrors how the
    // table branch above remounts per bound table).
    return (
      <QueryTabView
        key={tab.id}
        draft={queryDraft ?? ""}
        onDraftChange={onQueryDraftChange ?? (() => {})}
        tables={tables}
      />
    );
  }

  if (tab.kind === "chat") {
    // Keyed by tab id (mirroring the query branch) so each chat Tab owns an isolated
    // message log + input/busy state instance; the lifted state keeps its history
    // across Tab switches. Never persisted to the workspace snapshot.
    return (
      <ChatTabView
        key={tab.id}
        state={chatState ?? emptyChatState()}
        onStateChange={onChatStateChange ?? (() => {})}
        lastProvider={lastProvider ?? null}
        onOpenReport={onOpenReport}
      />
    );
  }

  if (tab.kind === "erd") {
    // Keyed by tab id (mirroring the query branch) so each ERD Tab owns an isolated
    // React Flow instance and reads ITS tab's saved layout at mount. Fed App's live
    // `allTables`, so a table created via Epic 3's builder appears without a manual
    // refresh. Layout changes are reported up keyed by this tab id (Story 4.2).
    return (
      <ErdTabView
        key={tab.id}
        tables={tables ?? []}
        savedLayout={erdLayout}
        onLayoutChange={(layout) => onErdLayoutChange?.(tab.id, layout)}
      />
    );
  }

  if (tab.kind === "report") {
    // Keyed by tab id (mirroring the query/chat branches) so each report Tab owns an
    // isolated builder+preview instance; the lifted state keeps its blocks across Tab
    // switches. Never persisted to the workspace snapshot (Story 6.1).
    return (
      <ReportTabView
        key={tab.id}
        state={reportState ?? emptyReport()}
        onStateChange={onReportStateChange ?? (() => {})}
      />
    );
  }

  if (tab.kind === "settings") {
    // The Settings tab body (Story 8.6): SettingsPanel mounts here in the normal tab-body
    // slot (it used to be an overlay). Its in-panel "close" closes this settings tab via
    // the normal closeTab path — a redundant-but-harmless affordance alongside the tab `×`.
    // key={tab.id} mirrors every sibling branch so the body remounts per tab id — a
    // no-op while the singleton holds, but robust if two settings tabs ever coexist
    // (e.g. a legacy snapshot before restore's collapse defense runs).
    return (
      <SettingsPanel
        key={tab.id}
        onClose={() => onCloseTab?.(tab.id)}
        onRegistryChanged={onRegistryChanged}
      />
    );
  }

  if (tab.kind === "create-table") {
    // The create-table tab body (Story 9.4): CreateTablePanel mounts here in the normal
    // tab-body slot (it used to be an overlay). Its "close" button AND its post-create
    // auto-close both call onClose → the normal closeTab path, so the surface self-closes
    // on a successful create exactly as it did in the overlay era. key={tab.id} mirrors
    // every sibling branch so the body remounts per tab id — note only the ACTIVE tab
    // body is mounted, so switching away unmounts the panel and its local draft is
    // discarded (the draft is intentionally not lifted; see openOrFocusCreateTable).
    return (
      <CreateTablePanel
        key={tab.id}
        schemas={schemas ?? []}
        onCreated={onTableCreated ?? (() => {})}
        onClose={() => onCloseTab?.(tab.id)}
      />
    );
  }

  return (
    <section
      className="flex h-full flex-col gap-3 p-6"
      aria-label={`${tab.title} content`}
    >
      <header className="flex items-baseline gap-2">
        <h2 className="text-lg font-semibold text-foreground">{tab.title}</h2>
        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
          {tab.kind}
        </span>
      </header>
      <p className="max-w-prose text-sm text-muted-foreground">{KIND_BLURB[tab.kind]}</p>
      <div className="flex flex-1 items-center justify-center rounded-[var(--radius)] border border-dashed border-border bg-card/40 text-sm text-muted-foreground">
        {tab.kind} placeholder — shell only
      </div>
    </section>
  );
}
