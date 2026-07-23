/**
 * quick-studio UI (Ring 2) — QueryTabView (Story 3.6; CodeMirror 6 swap Story 8.8).
 *
 * The ad-hoc SQL runner for a `query` Tab: a CodeMirror 6 editor (syntax-highlighted,
 * schema-completed) bound to a session-only draft (lifted to `App`, see
 * `workspace-state.ts`'s Block-If — the snapshot never stores query text), a Run
 * control (button + Ctrl/Cmd+Enter), and a result area over whatever the Story 3.1
 * guarded `execute` RAW path returns.
 *
 * The UI never parses, splits, classifies, or composes SQL (AR-3) — CodeMirror's
 * grammar tokenizes ONLY to color (the `--sql-*`-mapped `HighlightStyle` below) and
 * to complete (the schema-driven `sql-completions.ts` source); the typed text is
 * sent verbatim as `{shape:"raw", sql}` and the Core is the sole risk gate:
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
 *
 * The CodeMirror `EditorView` is mounted into a `useRef` container inside a
 * `useEffect` (created once on mount, `view.destroy()` on unmount) — everything
 * else in the tree (the editor bar chrome, the ink-filled Run control, the pager,
 * the result banners, the `DataGrid`) stays React-rendered and unchanged. The
 * schema-driven completion source is built from the ALREADY-loaded `tables` prop
 * (`App.allTables → Workspace → TabContent`, the same list the ERD consumes — no
 * new RPC) via the pure, DOM-free `sql-completions.ts`, and reconfigured through a
 * `Compartment` whenever `tables`' identity changes.
 */

import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { sql, StandardSQL } from "@codemirror/lang-sql";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder, tooltips } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef, useState } from "react";
import type { FrozenData, SchemaTableInfo } from "../../shared/contract.ts";
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
import { schemaCompletionSource } from "./sql-completions.ts";

/** Whether `sql` has any non-whitespace content — the sole Run-enable gate. */
export function isRunnable(sql: string): boolean {
  return sql.trim() !== "";
}

/** The rows of `rows` belonging to 1-based `page`, sliced client-side. */
function pageSlice(rows: FrozenData["rows"], page: number, pageSize: number): FrozenData["rows"] {
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

/**
 * The `--sql-*`-mapped token colors (Story 8.8, `globals.css`), keyed to the SQL
 * grammar's own `styleTags` mapping (`@codemirror/lang-sql`: `Keyword`→keyword,
 * `Type`→typeName, `Builtin`→standard(name), `String`/`Bytes`→string,
 * `Number`/`Bits`/`Bool`/`Null`→number-ish, `Identifier`→name,
 * `Operator`/`Punctuation`/parens→punctuation). Colors resolve ONLY through
 * `var(--sql-*)` — no hardcoded hex, matching the dark-first, no-light-override
 * tokens added to `globals.css`. Comments fall back to the existing
 * `--muted-foreground` shell token (no dedicated `--sql-*` comment color exists).
 */
const sqlHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.typeName], color: "var(--sql-kw)" },
  { tag: [t.standard(t.name), t.special(t.name)], color: "var(--sql-fn)" },
  { tag: [t.string, t.special(t.string)], color: "var(--sql-str)" },
  { tag: [t.number, t.bool, t.null], color: "var(--sql-num)" },
  { tag: t.name, color: "var(--sql-idn)" },
  { tag: [t.operator, t.punctuation, t.paren, t.brace, t.squareBracket], color: "var(--sql-pun)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
]);

/**
 * A neutral CodeMirror chrome theme resolved ONLY off `globals.css` tokens
 * (background/foreground/font-mono/coral-soft selection/card+border+radius
 * autocomplete popup) — no coral hex, no hardcoded Tailwind palette utilities.
 * CM's own focus outline is suppressed (`&.cm-focused { outline: none }`) so the
 * container's existing `:focus-visible` ink-ring idiom (`globals.css`) shows
 * through instead of a harsh default.
 */
const sqlEditorTheme = EditorView.theme({
  "&": {
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontSize: "13px",
    // Cap the editor and let it scroll internally so a long/pasted query never
    // grows the (shrink-0) editor bar unbounded and squeezes the flex-1 result
    // grid off-screen — restoring the bounded, scrollable feel of the old
    // `rows={6}` textarea while keeping the fixed mono pane look of workspace.html.
    maxHeight: "40vh",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.7",
    minHeight: "112px",
    padding: "8px 10px",
    caretColor: "var(--foreground)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    overflow: "auto",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--foreground)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--coral-soft)",
  },
  ".cm-placeholder": {
    color: "var(--muted-foreground)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--coral-soft)",
    color: "var(--coral)",
  },
});

export function QueryTabView({
  draft,
  onDraftChange,
  tables,
}: {
  /** The session-only draft SQL for this Tab (never persisted to disk/snapshot). */
  draft: string;
  onDraftChange: (sql: string) => void;
  /** All tables (introspected + optimistically-created) — the schema-completion source (Story 8.8), same list the ERD already consumes. */
  tables?: ReadonlyArray<SchemaTableInfo>;
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

  // CodeMirror mount plumbing (Story 8.8). `editorRef` is the mount container;
  // `viewRef` holds the live `EditorView` (created once on mount, destroyed on
  // unmount). `completionCompartment` lets the schema completion source be
  // reconfigured in place when `tables`' identity changes (`allTables` is
  // memoized and grows as tables are created), without tearing down the whole
  // editor. `runRef`/`onDraftChangeRef` are refreshed every render so the
  // CM keymap/updateListener — fixed at construction time — always see the
  // LATEST `run`/`onDraftChange` closures rather than the ones captured at mount.
  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const completionCompartment = useRef(new Compartment());
  // Set while WE apply an external `draft` prop into the doc, so the
  // updateListener can ignore its own programmatic write (no redundant
  // onDraftChange echo, and no feedback loop if a parent ever normalized draft).
  const applyingExternal = useRef(false);
  const runRef = useRef<() => void>(() => {});
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;

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
    // Read the LIVE CodeMirror doc — never the possibly-stale `draft` prop — so a
    // Mod-Enter fired in the same tick as a keystroke still sends exactly what's
    // on screen. Falls back to `draft` only if the view hasn't mounted yet.
    const sql = viewRef.current !== null ? viewRef.current.state.doc.toString() : draft;
    // Blocked while a confirm is pending: a stray Run / Ctrl+Enter must not silently
    // abandon the destructive confirm the user is mid-decision on (cancel it first).
    if (firing.current || busy || confirm !== null || !isRunnable(sql)) return;
    firing.current = true;
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
  runRef.current = () => void run();

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

  // Create the EditorView once on mount; destroy it on unmount. `draft`/`tables`
  // are intentionally NOT in the dependency array — the initial doc/completion
  // config is seeded from whatever they are AT MOUNT time, and subsequent changes
  // are applied by the two effects below (external-draft reconcile, completion
  // reconfigure) rather than by recreating the editor.
  useEffect(() => {
    if (editorRef.current === null) return;
    const state = EditorState.create({
      doc: draft,
      extensions: [
        sql(),
        completionCompartment.current.of(
          StandardSQL.language.data.of({ autocomplete: schemaCompletionSource(tables ?? []) }),
        ),
        autocompletion({ activateOnTyping: true }),
        // Render tooltips (the autocomplete popup) in a viewport-fixed layer so the
        // mount container's `overflow-hidden` (which clips the editor's rounded
        // corners) can't clip the completion popup when the caret sits near the
        // bottom of the short editor.
        tooltips({ position: "fixed" }),
        history(),
        syntaxHighlighting(sqlHighlightStyle),
        sqlEditorTheme,
        placeholder("select * from ..."),
        EditorView.contentAttributes.of({ "aria-label": "sql query editor", spellcheck: "false" }),
        keymap.of([
          { key: "Mod-Enter", run: () => { runRef.current(); return true; } },
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingExternal.current) {
            onDraftChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once by design; see comment above.
  }, []);

  // Reconcile an external `draft` change (e.g. switching Tabs and back) into the
  // live CM doc — but ONLY when it actually differs from the doc's current text,
  // so our OWN `updateListener` → `onDraftChange` → lifted-state → this-prop round
  // trip never feeds back into a redundant/looping dispatch.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current !== draft) {
      // Preserve the caret: clamp the prior anchor into the new doc rather than
      // letting a full-doc replace collapse the selection to the end.
      const anchor = Math.min(view.state.selection.main.anchor, draft.length);
      applyingExternal.current = true;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: draft },
        selection: { anchor },
      });
      applyingExternal.current = false;
    }
  }, [draft]);

  // Reconfigure the schema completion source (via the Compartment) whenever
  // `tables`' identity changes — `allTables` is memoized in `App` and grows as
  // tables are optimistically created, so this keeps completion in sync without
  // tearing down/recreating the whole editor (which would drop undo history).
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: completionCompartment.current.reconfigure(
        StandardSQL.language.data.of({ autocomplete: schemaCompletionSource(tables ?? []) }),
      ),
    });
  }, [tables]);

  return (
    <div className="flex h-full flex-col">
      {/* Editor + run control. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--border)] bg-[var(--card)] p-3">
        <div
          ref={editorRef}
          data-testid="sql-editor"
          className="w-full overflow-hidden bg-transparent"
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
