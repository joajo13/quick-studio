/**
 * quick-studio UI (Ring 2) — result grid (DataGrid).
 *
 * A thin, presentational view over a {@link FrozenData} page (Story 3.2) that now
 * also hosts the Story 3.3 mutation affordances: double-click a cell to edit it
 * inline (kind-appropriate control; Enter commits, Esc cancels, a "null" action sets
 * SQL NULL), a per-row delete with an INLINE confirm (mirroring `SettingsPanel`'s
 * `ConnectionRow` — there is no modal framework), and an insert-row draft.
 *
 * The grid owns ONLY transient edit UI state (which cell is open, the draft-row
 * inputs, the row pending delete-confirm). All persistence is delegated to the
 * `onCommitEdit`/`onDeleteRow`/`onInsertRow` callbacks; `busy`/`mutationError` are
 * owned by the parent. Edit + delete are disabled when `!canMutate` (a table without
 * exactly one PK column); insert stays available.
 */

import { useEffect, useRef, useState } from "react";
import { frozenColumnDisplayKind } from "../../shared/contract.ts";
import type { FrozenCell, FrozenColumn, FrozenData, FrozenRow } from "../../shared/contract.ts";
import { revealInsertDraft, shouldRevealInsertDraft } from "./insert-draft-ux.ts";
import type { CellEdit } from "./row-mutations.ts";

/**
 * Map a column's DISPLAY kind — `frozenColumnDisplayKind`, i.e. its SQL `dataType`
 * classification when it has one, else its neutral cell type — to its DESIGN.md `t-*`
 * color var + a short SQL-ish label. Keying on the display kind rather than the raw
 * `type` is what makes a driver-stringified `bigint`/`numeric` read as a numeric column
 * instead of TEXT (DW-30); a column with no `dataType` is unaffected.
 */
function typeMeta(kind: FrozenCell["kind"]): { readonly color: string; readonly label: string } {
  switch (kind) {
    case "number":
      return { color: "var(--t-int)", label: "num" };
    case "date":
      return { color: "var(--t-time)", label: "time" };
    case "boolean":
      return { color: "var(--t-bool)", label: "bool" };
    default:
      return { color: "var(--t-text)", label: "text" };
  }
}

/**
 * Render one cell in the neutral prototype idiom: numeric right-aligned `tabular-nums`
 * in ink (inherits the `<td>`'s color — ink, or `--coral` on a PK column — value AS-IS,
 * no thousands grouping); date dimmed; boolean as an ok/muted state pill; NULL faint
 * italic; string base ink. Data-type color lives in the header tag, not the cell.
 */
function Cell({ cell, numeric }: { cell: FrozenCell; numeric: boolean }): React.JSX.Element {
  if (cell.kind === "null") {
    return <span className="italic text-[color:var(--t-text)] opacity-60">null</span>;
  }
  if (cell.kind === "number") {
    return <span className="tabular-nums">{cell.value}</span>;
  }
  if (cell.kind === "boolean") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]"
        style={
          cell.value
            ? { color: "var(--ok)", backgroundColor: "var(--ok-soft)" }
            : { color: "var(--muted-foreground)", backgroundColor: "var(--muted)" }
        }
      >
        <span className="inline-block h-[5px] w-[5px] rounded-full bg-current" aria-hidden />
        {cell.value ? "true" : "false"}
      </span>
    );
  }
  if (cell.kind === "date") {
    return <span className="text-[color:var(--muted-foreground)]">{cell.iso}</span>;
  }
  return <span className={numeric ? "tabular-nums" : undefined}>{cell.value}</span>;
}

/** The seed text an editor opens with, from the cell's current displayed value. */
function cellText(cell: FrozenCell): string {
  switch (cell.kind) {
    case "null":
      return "";
    case "date":
      return cell.iso;
    case "boolean":
      return cell.value ? "true" : "false";
    case "number":
      return String(cell.value);
    default:
      return cell.value;
  }
}

/** Which cell (row+column) is currently open in the inline editor. */
type EditingCell = { readonly row: number; readonly col: number };

/**
 * The inline cell editor: a kind-appropriate control seeded from the current value.
 * Enter (or the ✓ button) commits the raw text; Esc (or ✗) cancels; "null" commits a
 * real SQL NULL. Coercion/validation happens in the parent (via `row-mutations`), so
 * this stays a dumb input that only emits `{raw}` or `{setNull}`.
 */
function CellEditor({
  column,
  seed,
  busy,
  onCommit,
  onCancel,
}: {
  column: FrozenColumn;
  seed: string;
  busy: boolean;
  onCommit: (edit: CellEdit) => void;
  onCancel: () => void;
}): React.JSX.Element {
  // The `<select>` branch stays keyed on the RAW `column.type`: it is a REPRESENTATION
  // decision (the cell genuinely holds a JS boolean), not a display one — and the intent
  // forbids DB-type-aware editors, so `dataType` may only change the text input's
  // alignment class below, never which control is rendered.
  const displayKind = frozenColumnDisplayKind(column);
  // A boolean editor opened on a NULL cell has an empty seed, which matches no <option>:
  // the <select> would DISPLAY "true" while its state is "" and commit an empty raw
  // (→ coercion error). Seed a valid default so the shown option is what commits; the
  // explicit "null" action still sets a real SQL NULL.
  const [text, setText] = useState(
    column.type === "boolean" && seed !== "true" && seed !== "false" ? "true" : seed,
  );
  const commit = (): void => onCommit({ raw: text });

  const control =
    column.type === "boolean" ? (
      <select
        autoFocus
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onCancel();
        }}
        className="rounded-[var(--radius)] border border-[var(--coral-line)] bg-[var(--background)] px-1 py-0.5 font-mono text-xs text-[var(--foreground)] outline-none focus-visible:border-[var(--coral)]"
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    ) : (
      <input
        autoFocus
        type="text"
        value={text}
        disabled={busy}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onCancel();
        }}
        onClick={(e) => e.stopPropagation()}
        className={`w-full min-w-[6rem] rounded-[var(--radius)] border border-[var(--coral-line)] bg-[var(--background)] px-1 py-0.5 font-mono text-xs text-[var(--foreground)] outline-none focus-visible:border-[var(--coral)] ${
          displayKind === "number" ? "text-right tabular-nums" : ""
        }`}
      />
    );

  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {control}
      <button
        type="button"
        aria-label="commit edit"
        title="commit (Enter)"
        disabled={busy}
        onClick={commit}
        className="rounded-[var(--radius)] border border-[var(--coral-line)] bg-[var(--coral-soft)] px-1 font-mono text-xs text-[var(--foreground)] disabled:opacity-50"
      >
        ✓
      </button>
      <button
        type="button"
        aria-label="set null"
        title="set NULL"
        disabled={busy}
        onClick={() => onCommit({ setNull: true })}
        className="rounded-[var(--radius)] border border-[var(--border)] px-1 font-mono text-[10px] lowercase text-[var(--muted-foreground)] disabled:opacity-50"
      >
        null
      </button>
      <button
        type="button"
        aria-label="cancel edit"
        title="cancel (Esc)"
        onClick={onCancel}
        className="rounded-[var(--radius)] border border-[var(--border)] px-1 font-mono text-xs text-[var(--muted-foreground)]"
      >
        ✗
      </button>
    </div>
  );
}

/** The draft row appended below the data: one input per column + commit/cancel. */
function InsertDraftRow({
  columns,
  busy,
  actionsCol,
  open,
  onOpenChange,
  onInsert,
}: {
  columns: ReadonlyArray<FrozenColumn>;
  busy: boolean;
  /** A trailing per-row actions column exists on the data rows — pad the draft to match. */
  actionsCol: boolean;
  /** Whether the draft is expanded — lifted so the result-bar Add-Row can open it too. */
  open: boolean;
  /** Report an open/close (collapsed toggle, cancel, or commit-success reset). */
  onOpenChange: (open: boolean) => void;
  onInsert: (draft: ReadonlyArray<{ column: string; edit: CellEdit }>) => boolean | Promise<boolean>;
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const [nulls, setNulls] = useState<Record<string, boolean>>({});
  // `busy`/`disabled` only lands after the parent re-renders, so two synchronous
  // clicks can both pass it and fire two inserts (a duplicate row). A ref flips
  // instantly, before any await, so only one insert is ever in flight per draft.
  const firing = useRef(false);
  // The draft is the last child of `<tbody>` inside the grid's `overflow-auto`
  // container, so opening it from the result-bar Add-Row can leave it off-screen.
  // Ref lives on the TRAILING commit/cancel row so the reveal lands the draft's
  // BOTTOM edge inside the viewport; the inputs row directly above comes with it
  // whenever the container can fit both rows (it cannot help if it fits neither).
  const rowRef = useRef<HTMLTableRowElement | null>(null);
  // Seeded closed, NOT with `open`: this component can mount already-open — the
  // `rows`/`indexes` toggle unmounts the grid while `insertOpen` stays lifted, and
  // Add-Row is clickable while the grid is absent (loading / load error). Seeding
  // with `open` would classify that mount as "already open" and skip the reveal,
  // which is the exact inert-click symptom DW-56 is about.
  const prevOpenRef = useRef(false);

  // The draft row must span every data-row cell, including the actions column.
  const span = Math.max(1, columns.length + (actionsCol ? 1 : 0));

  useEffect(() => {
    // Reveal only on the closed→open edge — never on an unrelated re-render, which
    // would yank the viewport away from wherever the user scrolled to.
    if (shouldRevealInsertDraft(prevOpenRef.current, open)) revealInsertDraft(rowRef.current);
    // A parent-driven close (e.g. page navigation) must discard the draft exactly like
    // Cancel does. Functional updates that bail when already empty: with deps `[open]`
    // this cannot loop today, but a fresh `{}` would still cost a pointless re-render on
    // every close, and the bail keeps it safe if the deps ever widen. Never calls
    // `onOpenChange`: this effect reacts to `open`, it does not drive it.
    if (!open) {
      setValues((v) => (Object.keys(v).length === 0 ? v : {}));
      setNulls((n) => (Object.keys(n).length === 0 ? n : {}));
    }
    prevOpenRef.current = open;
  }, [open]);

  const reset = (): void => {
    setValues({});
    setNulls({});
    onOpenChange(false);
  };

  const commit = async (): Promise<void> => {
    if (firing.current) return;
    firing.current = true;
    try {
      const draft = columns.map((c) => ({
        column: c.name,
        edit: nulls[c.name] ? ({ setNull: true } as CellEdit) : ({ raw: values[c.name] ?? "" } as CellEdit),
      }));
      // Reset (close + clear) ONLY on success, so a committed insert can't be re-fired as
      // a duplicate; on error the draft stays open with its values for a fixup + retry.
      if (await onInsert(draft)) reset();
    } finally {
      firing.current = false;
    }
  };

  if (!open) {
    return (
      <tr style={{ borderBottom: "1px solid var(--border)" }}>
        <td colSpan={span} className="px-3 py-1.5">
          <button
            type="button"
            onClick={() => onOpenChange(true)}
            className="rounded-[var(--radius)] border border-[var(--coral-line)] bg-[var(--coral-soft)] px-2 py-0.5 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:opacity-90"
          >
            + insert row
          </button>
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr style={{ backgroundColor: "var(--coral-soft)", borderBottom: "1px solid var(--coral-line)" }}>
        {columns.map((col) => {
          const isNull = nulls[col.name] === true;
          return (
            <td key={col.name} className="px-3 py-1">
              <input
                type="text"
                disabled={busy || isNull}
                value={isNull ? "" : values[col.name] ?? ""}
                placeholder={isNull ? "null" : "default"}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setValues((v) => ({ ...v, [col.name]: e.target.value }))}
                className={`w-full min-w-[5rem] rounded-[var(--radius)] border border-[var(--coral-line)] bg-[var(--background)] px-1 py-0.5 font-mono text-xs text-[var(--foreground)] outline-none focus-visible:border-[var(--coral)] disabled:opacity-50 ${
                  frozenColumnDisplayKind(col) === "number" ? "text-right tabular-nums" : ""
                }`}
              />
              <button
                type="button"
                onClick={() => setNulls((n) => ({ ...n, [col.name]: !n[col.name] }))}
                className={`mt-0.5 rounded-[var(--radius)] border px-1 font-mono text-[10px] lowercase transition-colors ${
                  isNull
                    ? "border-[var(--coral-line)] bg-[var(--coral-soft)] text-[var(--foreground)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)]"
                }`}
              >
                null
              </button>
            </td>
          );
        })}
        {actionsCol ? <td className="px-3 py-1" aria-hidden /> : null}
      </tr>
      <tr ref={rowRef} style={{ borderBottom: "1px solid var(--border)" }}>
        <td colSpan={span} className="px-3 py-1.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={commit}
              className="rounded-[var(--radius)] border border-[var(--coral-line)] bg-[var(--coral-soft)] px-2 py-0.5 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              commit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={reset}
              className="rounded-[var(--radius)] border border-[var(--border)] px-2 py-0.5 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-50"
            >
              cancel
            </button>
          </div>
        </td>
      </tr>
    </>
  );
}

export function DataGrid({
  data,
  primaryKeys,
  selectedRow,
  onSelectRow,
  canMutate = false,
  busy = false,
  insertOpen,
  onInsertOpenChange,
  onCommitEdit,
  onDeleteRow,
  onInsertRow,
}: {
  data: FrozenData;
  primaryKeys: ReadonlyArray<string>;
  selectedRow: number | null;
  onSelectRow: (index: number) => void;
  /** When false (composite/no-PK table), inline edit + delete are disabled. */
  canMutate?: boolean;
  /** A mutation is in flight — inputs disable to avoid a double-submit. */
  busy?: boolean;
  /** Controlled insert-draft open state — lets the result-bar Add-Row open the same
   * in-grid draft. Omit to let the grid's own "+ insert row" toggle manage it. */
  insertOpen?: boolean;
  /** Report insert-draft open/close when controlled. */
  onInsertOpenChange?: (open: boolean) => void;
  /**
   * Commit a single-cell edit (parent builds the structured `update`). Resolves
   * `true` when the edit was ACCEPTED (validation passed + committed) so the editor
   * closes; `false` on rejection so the editor stays open with the typed value.
   */
  onCommitEdit?: (row: FrozenRow, column: string, edit: CellEdit) => boolean | Promise<boolean>;
  /** Delete a row after the inline confirm (parent runs the `confirmed` delete). */
  onDeleteRow?: (row: FrozenRow) => void;
  /** Commit an insert draft (parent omits empties + builds the `insert`). Resolves
   * `true` on success so the draft resets/closes; `false` keeps the draft open. */
  onInsertRow?: (draft: ReadonlyArray<{ column: string; edit: CellEdit }>) => boolean | Promise<boolean>;
}): React.JSX.Element {
  const pkSet = new Set(primaryKeys);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  // Insert-draft open state: controlled by the parent when `insertOpen` is provided
  // (so the result-bar Add-Row can open the same draft), else self-managed here.
  const [internalInsertOpen, setInternalInsertOpen] = useState(false);
  const draftOpen = insertOpen ?? internalInsertOpen;
  const setDraftOpen = onInsertOpenChange ?? setInternalInsertOpen;

  // `editing`/`confirmingDelete` are keyed by ROW INDEX. A post-mutation refetch swaps
  // in a new `data` object with (potentially) reindexed rows, so any open editor or
  // delete-confirm would then point at the WRONG row. Reset both whenever the
  // underlying page changes so no stale index survives a refetch.
  useEffect(() => {
    setEditing(null);
    setConfirmingDelete(null);
  }, [data]);

  const mutable = canMutate && onCommitEdit !== undefined;
  const deletable = canMutate && onDeleteRow !== undefined;
  // A trailing actions column exists whenever the row can be deleted.
  const actionsCol = deletable;

  return (
    <div className="min-h-0 flex-1 overflow-auto" style={{ fontFamily: "var(--font-mono)" }}>
      <table className="w-full border-collapse text-left" style={{ fontSize: "var(--data-cell-size)" }}>
        <thead className="sticky top-0 z-10">
          <tr className="bg-[var(--muted)]" style={{ borderBottom: "1px solid var(--border)" }}>
            {data.columns.map((col) => {
              // One display kind per column drives BOTH the type tag and the alignment,
              // so a `bigint`/`numeric` column carried as strings still reads as numeric.
              const displayKind = frozenColumnDisplayKind(col);
              const meta = typeMeta(displayKind);
              const isPk = pkSet.has(col.name);
              const numeric = displayKind === "number";
              return (
                <th
                  key={col.name}
                  scope="col"
                  className={`whitespace-nowrap px-3 py-1.5 align-bottom font-normal ${numeric ? "text-right" : "text-left"}`}
                >
                  <div className={`flex items-center gap-1.5 ${numeric ? "justify-end" : ""}`}>
                    {isPk ? (
                      <span aria-label="primary key" title="primary key" style={{ color: "var(--t-key)" }}>
                        ⚿
                      </span>
                    ) : null}
                    <span className="text-[var(--foreground)]">{col.name}</span>
                  </div>
                  <div
                    className="uppercase"
                    style={{ color: meta.color, fontSize: "var(--label-size)", letterSpacing: "0.08em" }}
                  >
                    {meta.label}
                  </div>
                </th>
              );
            })}
            {actionsCol ? <th scope="col" className="px-3 py-1.5" aria-label="row actions" /> : null}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, r) => {
            const selected = selectedRow === r;
            return (
              <tr
                key={r}
                onClick={() => onSelectRow(r)}
                className="cursor-pointer transition-colors"
                style={{
                  backgroundColor: selected ? "var(--coral-soft)" : undefined,
                  boxShadow: selected ? "inset 2px 0 0 var(--coral)" : undefined,
                  borderBottom: "1px solid var(--border)",
                }}
                onMouseEnter={(e) => {
                  if (!selected) e.currentTarget.style.backgroundColor = "var(--coral-soft)";
                }}
                onMouseLeave={(e) => {
                  if (!selected) e.currentTarget.style.backgroundColor = "";
                }}
              >
                {row.map((cell, c) => {
                  const col = data.columns[c];
                  const numeric = col !== undefined && frozenColumnDisplayKind(col) === "number";
                  // PK-column cells render in ink `--coral` (the prototype's `.pk-cell`);
                  // string/number cells inherit it, while pill/date/null set their own.
                  const isPk = col !== undefined && pkSet.has(col.name);
                  const isEditing = editing !== null && editing.row === r && editing.col === c;
                  return (
                    <td
                      key={c}
                      onDoubleClick={() => {
                        if (mutable && col !== undefined) setEditing({ row: r, col: c });
                      }}
                      className={`whitespace-nowrap px-3 py-1 ${isPk ? "text-[var(--coral)]" : "text-[var(--foreground)]"} ${numeric ? "text-right" : "text-left"} ${
                        mutable ? "cursor-text" : ""
                      }`}
                    >
                      {isEditing && col !== undefined ? (
                        <CellEditor
                          column={col}
                          seed={cellText(cell)}
                          busy={busy}
                          onCommit={(edit) => {
                            // Close ONLY if accepted — a validation reject keeps the
                            // editor open (with the typed value) and sends no RPC.
                            void Promise.resolve(onCommitEdit?.(row, col.name, edit)).then((accepted) => {
                              if (accepted) setEditing(null);
                            });
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <Cell cell={cell} numeric={numeric} />
                      )}
                    </td>
                  );
                })}
                {actionsCol ? (
                  <td className="whitespace-nowrap px-3 py-1 text-right">
                    {confirmingDelete === r ? (
                      <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <span className="font-mono text-xs lowercase text-[var(--muted-foreground)]">delete?</span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirmingDelete(null);
                            onDeleteRow?.(row);
                          }}
                          className="rounded-[var(--radius)] border border-red-700 bg-red-600 px-1.5 py-0.5 font-mono text-xs lowercase text-white transition-colors hover:opacity-90 disabled:opacity-50"
                        >
                          yes
                        </button>
                        <button
                          type="button"
                          autoFocus
                          onClick={() => setConfirmingDelete(null)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setConfirmingDelete(null);
                          }}
                          className="rounded-[var(--radius)] border border-[var(--border)] px-1.5 py-0.5 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
                        >
                          no
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingDelete(r);
                        }}
                        className="rounded-[var(--radius)] border border-[var(--border)] px-1.5 py-0.5 font-mono text-xs lowercase text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                      >
                        delete
                      </button>
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
          {onInsertRow !== undefined ? (
            <InsertDraftRow
              columns={data.columns}
              busy={busy}
              actionsCol={actionsCol}
              open={draftOpen}
              onOpenChange={setDraftOpen}
              onInsert={onInsertRow}
            />
          ) : null}
        </tbody>
      </table>

      {data.rows.length === 0 ? (
        <div
          className="flex items-center justify-center px-3 py-6 lowercase text-[var(--muted-foreground)]"
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--data-cell-size)" }}
        >
          0 rows
        </div>
      ) : null}
    </div>
  );
}
