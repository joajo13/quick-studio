/**
 * quick-studio UI (Ring 2) — Create-table surface.
 *
 * A rail-toggled form (mirroring {@link SettingsPanel}) that collects a table name,
 * a target schema, and typed column defs (name, allowlisted type, NOT NULL, primary
 * key) and issues them through the Story 3.1 guarded Core executor as a STRUCTURED
 * op — `execute {shape:"structured", op:{kind:"createTable", …}}`, path (a). The UI
 * never composes SQL and never uses the `raw` shape.
 *
 * CREATE TABLE auto-commits dialog-free: submit sends NO `confirmed` and shows NO
 * dialog. On `status:"ok"` the panel optimistically appends the synthesized
 * {@link SchemaTableInfo} to the schema tree (the Core's connect-time schema is
 * memoized and cannot be re-introspected without a Core change) and closes; any error
 * — including a defensive, never-expected `confirmation_required` — surfaces inline
 * with the draft preserved.
 *
 * Double-submit guard: an in-flight `useRef` flips BEFORE the `await`, because the
 * `busy`/`disabled` gate only lands after a re-render — two fast synchronous clicks
 * would otherwise both pass the closure-captured check and fire two creates (the exact
 * duplicate-op class of bug fixed in Story 3.3).
 */

import { useRef, useState } from "react";
import type { ExecuteResult, SchemaTableInfo } from "../../shared/contract.ts";
import { rpc } from "../rpc/client.ts";
import { envelopeText } from "../rpc/envelope-text.ts";
import {
  buildCreateTableOp,
  CREATE_TABLE_TYPES,
  isCreateTableError,
  synthesizeSchemaTable,
  validateCreateTableDraft,
  type ColumnDraft,
} from "./create-table.ts";

/** A terse mono field-error or RPC-envelope banner. */
function ErrorLine({ text }: { text: string }): React.JSX.Element {
  return (
    <p role="alert" className="font-mono text-xs lowercase text-red-400">
      {text}
    </p>
  );
}

/** A labelled mono text input mirroring `SettingsPanel`'s `Field`. */
function Field({
  label,
  placeholder,
  value,
  onChange,
  invalid,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
}): React.JSX.Element {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="font-mono text-[11px] lowercase text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        className={`rounded-[var(--radius)] border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary ${
          invalid ? "border-red-500" : "border-border"
        }`}
      />
    </label>
  );
}

/** A column draft plus a stable identity, so React keys survive a non-tail removal. */
type DraftColumn = ColumnDraft & { readonly _key: number };

/** Monotonic source of stable row keys — keying on the array index would misattach
 * focus/transient DOM state to the wrong row when a non-last column is removed. */
let columnKeySeq = 0;

/** A blank column row seed — a real allowlisted default type so a fresh row is valid. */
function emptyColumn(): DraftColumn {
  return { _key: ++columnKeySeq, name: "", type: CREATE_TABLE_TYPES[0] ?? "TEXT", notNull: false, primaryKey: false };
}

/** One repeatable column-definition row: name + type `<select>` + NOT NULL + PK + remove. */
function ColumnRow({
  column,
  onChange,
  onRemove,
  removable,
}: {
  column: ColumnDraft;
  onChange: (patch: Partial<ColumnDraft>) => void;
  onRemove: () => void;
  removable: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-end gap-2 rounded-[var(--radius)] border border-border bg-card p-2">
      <Field
        label="column"
        placeholder="id"
        value={column.name}
        onChange={(name) => onChange({ name })}
        invalid={false}
      />
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[11px] lowercase text-muted-foreground">type</span>
        <select
          value={column.type}
          onChange={(e) => onChange({ type: e.target.value })}
          className="rounded-[var(--radius)] border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
        >
          {CREATE_TABLE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <label className="flex select-none flex-col items-center gap-1">
        <span className="font-mono text-[11px] lowercase text-muted-foreground">not null</span>
        <input
          type="checkbox"
          checked={column.notNull}
          onChange={(e) => onChange({ notNull: e.target.checked })}
          className="h-4 w-4 accent-[var(--coral)]"
        />
      </label>
      <label className="flex select-none flex-col items-center gap-1">
        <span className="font-mono text-[11px] lowercase text-muted-foreground">pk</span>
        <input
          type="checkbox"
          checked={column.primaryKey}
          onChange={(e) => onChange({ primaryKey: e.target.checked })}
          className="h-4 w-4 accent-[var(--coral)]"
        />
      </label>
      <button
        type="button"
        onClick={onRemove}
        disabled={!removable}
        aria-label="Remove column"
        className="rounded-[var(--radius)] border border-border px-2 py-1 font-mono text-xs lowercase text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        ✕
      </button>
    </div>
  );
}

export function CreateTablePanel({
  schemas,
  onCreated,
  onClose,
}: {
  /** Existing schema names — the target selector's options; the first is the default. */
  schemas: ReadonlyArray<string>;
  /** Optimistically append the synthesized table to the tree + PK lookup on success. */
  onCreated: (table: SchemaTableInfo) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [table, setTable] = useState("");
  // Default the target schema to the first existing schema (typically `public`); an
  // empty-DB fallback of "" is omitted from the op → the Core default applies.
  const [schema, setSchema] = useState<string>(schemas[0] ?? "");
  const [columns, setColumns] = useState<ReadonlyArray<DraftColumn>>(() => [emptyColumn()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Flips BEFORE the await so two fast synchronous submits issue exactly one create —
  // the `busy`/`disabled` gate only takes effect after a re-render.
  const inFlight = useRef(false);

  const draft = { schema: schema.trim() === "" ? undefined : schema, table, columns };
  const validation = validateCreateTableDraft(draft);

  const patchColumn = (index: number, patch: Partial<ColumnDraft>): void => {
    setColumns((cols) => cols.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };
  const addColumn = (): void => setColumns((cols) => [...cols, emptyColumn()]);
  const removeColumn = (index: number): void => setColumns((cols) => cols.filter((_, i) => i !== index));

  const onSubmit = async (): Promise<void> => {
    // Ref guard first (pre-await), then the render-gated checks.
    if (inFlight.current || busy || !validation.ok) return;
    const op = buildCreateTableOp(draft);
    if (isCreateTableError(op)) {
      setError(op.error);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    // NO `confirmed`: createTable auto-commits and never gates.
    const reply = await rpc<ExecuteResult>("execute", { shape: "structured", op });
    inFlight.current = false;
    setBusy(false);
    if (!reply.ok) {
      setError(envelopeText(reply.error)); // keep the panel open with the draft
      return;
    }
    if (reply.result.status === "ok") {
      onCreated(synthesizeSchemaTable(draft));
      onClose(); // close/reset (unmount discards the draft)
      return;
    }
    // Defensive: createTable never gates — treat an unexpected shape as an inline error.
    if (reply.result.status === "confirmation_required") {
      setError(`unexpected confirmation required: ${reply.result.preview.risk}`);
      return;
    }
    setError(`unexpected result: ${reply.result.status}`);
  };

  // Surface the reason only once the user has started (a fresh empty form is not "wrong").
  const dirty = table.length > 0 || columns.some((c) => c.name.length > 0);

  return (
    <section data-testid="create-table-panel" aria-label="Create table" className="flex h-full flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground">create table</span>
          <span className="font-mono text-xs lowercase text-muted-foreground">structured ddl</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close create table"
          className="rounded-[var(--radius)] border border-border px-3 py-1 font-mono text-xs lowercase text-foreground transition-colors hover:bg-accent"
        >
          close
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {error !== null ? (
          <div className="rounded-[var(--radius)] border border-red-700 bg-red-950/40 px-3 py-2">
            <ErrorLine text={error} />
          </div>
        ) : null}

        {/* Table identity: name + target schema. */}
        <div className="flex items-end gap-2">
          <Field label="table name" placeholder="widgets" value={table} onChange={setTable} invalid={false} />
          {schemas.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] lowercase text-muted-foreground">schema</span>
              <select
                value={schema}
                onChange={(e) => setSchema(e.target.value)}
                className="rounded-[var(--radius)] border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
              >
                {schemas.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {/* Columns. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs lowercase text-muted-foreground">columns</span>
            <button
              type="button"
              onClick={addColumn}
              className="rounded-[var(--radius)] border border-border px-2 py-1 font-mono text-xs lowercase text-foreground transition-colors hover:bg-accent"
            >
              + add column
            </button>
          </div>
          {columns.map((column, i) => (
            <ColumnRow
              key={column._key}
              column={column}
              onChange={(patch) => patchColumn(i, patch)}
              onRemove={() => removeColumn(i)}
              removable={columns.length > 1}
            />
          ))}
        </div>

        {!validation.ok && dirty ? <ErrorLine text={validation.message} /> : null}

        <div>
          <button
            type="button"
            disabled={!validation.ok || busy}
            onClick={() => void onSubmit()}
            className="rounded-[var(--radius)] border border-border bg-primary px-3 py-1 font-mono text-xs lowercase text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "creating…" : "create table"}
          </button>
        </div>
      </div>
    </section>
  );
}
