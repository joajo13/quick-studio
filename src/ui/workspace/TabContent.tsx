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

import { useEffect, useState } from "react";
import type {
  ErdTabLayout,
  ExecuteResult,
  FrozenRow,
  SchemaIndexInfo,
  SchemaTableInfo,
  StructuredOp,
  TableRowsResult,
} from "../../shared/contract.ts";
import { DataGrid } from "../data/DataGrid.tsx";
import { IndexList } from "../data/IndexList.tsx";
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
import { ErdTabView } from "./ErdTabView.tsx";
import { QueryTabView } from "./QueryTabView.tsx";
import type { TabKind, TableRef, WorkspaceTab } from "./workspace-state.ts";

/** Short human blurb per Tab kind for the (non-table) placeholder body. */
const KIND_BLURB: Readonly<Record<TabKind, string>> = {
  table: "Browse rows and columns of a table.",
  query: "Compose and run SQL against the connection. (Epic 3.)",
  erd: "Visualize the schema as an entity-relationship diagram. (Epic 4.)",
  chat: "Ask questions about your data in natural language. (Epic 5.)",
  report: "Assemble and export a data report. (Epic 6.)",
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
  // Bumped by the error banner's "retry" so the fetch effect re-fires for the
  // CURRENT page — a failed page-N fetch would otherwise leave the pager frozen
  // (Next is a no-op when it targets the already-set page) with no in-tab recovery.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Mutation feedback, owned here (the grid stays presentational). `mutating` gates
  // inputs against a double-submit; `mutationError` surfaces a build/RPC failure
  // inline without touching the page-load `error` banner (the panel stays alive).
  const [mutating, setMutating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Exactly one PK column is the executor's `resolveSinglePkTable` precondition;
  // without it inline edit + delete are disabled (insert stays available).
  const canMutate = primaryKeys.length === 1;
  // A blank schema means "the connection's default namespace" (e.g. a table created
  // into the default schema on an otherwise-empty DB, whose optimistic tree entry
  // carries no known schema). Omit it entirely rather than sending `schema:""`, which
  // the Core rejects as `bad_request` ("non-empty string when provided"). Omission
  // lets the Core resolve the default, so browse AND structured mutations both work.
  const effectiveSchema = table.schema.trim() === "" ? undefined : table.schema;
  const target = { schema: effectiveSchema, table: table.name };

  // NOTE: per-table state (page/data/grid/error/loading) is reset by REMOUNTING —
  // the parent keys this component by the bound table identity, so a table switch
  // gives fresh state and fires exactly one fetch (no stale error/pager, no
  // redundant fetch with the previous page). See `TabContent`'s `key` below.

  // Fetch the requested page whenever the page changes (the table is fixed for the
  // lifetime of this mount — a table switch remounts fresh instead).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void rpc<TableRowsResult>("table.rows", { schema: effectiveSchema, table: table.name, page }).then((reply) => {
      if (!alive) return;
      if (!reply.ok) {
        setError(envelopeText(reply.error));
        setData(null);
      } else {
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
  }, [table.schema, table.name, page, reloadNonce]);

  // Run one structured op through the guarded Core executor. On `ok` (insert/update
  // auto-commit, or a confirmed delete) it refetches the current page via the
  // `reloadNonce` bump; on `confirmation_required` (a delete without the flag — the
  // Core is the real gate) it reports without mutating; any error surfaces inline.
  // Returns the domain status so a caller can branch (e.g. the delete confirm flow).
  const runOp = async (op: StructuredOp, confirmed: boolean): Promise<ExecuteResult["status"] | "error"> => {
    setMutating(true);
    setMutationError(null);
    const reply = await rpc<ExecuteResult>("execute", { shape: "structured", op, confirmed });
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
          {view === "indexes"
            ? `${indexes.length} ${indexes.length === 1 ? "index" : "indexes"}`
            : loading
              ? "loading…"
              : rowRangeSummary(grid)}
        </span>
        {view === "rows" ? (
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
      ) : data !== null ? (
        <DataGrid
          data={data}
          primaryKeys={primaryKeys}
          selectedRow={grid.selectedRow}
          onSelectRow={(index) => setGrid((g) => selectRow(g, index))}
          canMutate={canMutate}
          busy={mutating}
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

export function TabContent({
  tab,
  primaryKeys,
  indexes,
  tables,
  queryDraft,
  onQueryDraftChange,
  erdLayout,
  onErdLayoutChange,
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
  /** The active ERD tab's persisted layout (Story 4.2), or undefined for dagre fallback. */
  erdLayout?: ErdTabLayout;
  /** Report the active ERD tab's captured geometry up, keyed by tab id (Story 4.2). */
  onErdLayoutChange?: (tabId: number, layout: ErdTabLayout) => void;
}): React.JSX.Element {
  if (tab === null) {
    return <EmptyState />;
  }

  if (tab.kind === "table") {
    return tab.table !== undefined ? (
      // Key by the bound table identity so a table switch REMOUNTS with fresh
      // per-table state (page/data/grid/error) and fires a single fetch.
      <TableTabView
        key={`${tab.table.schema}.${tab.table.name}`}
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
