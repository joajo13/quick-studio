/**
 * quick-studio UI (Ring 2) — Settings surface: Connections management panel.
 *
 * The home for add/edit/remove Connection (Story 2.4), reached from the rail-bottom
 * pinned Settings control. It drives the pure `connections-model` and talks to Core
 * only through the typed `rpc` client. Microcopy is mono, lowercase, terse — a status
 * line, not marketing — and DB identifiers (host, engine) render verbatim in mono.
 *
 * Trust boundary: the UI holds no credential. A url is typed into a draft and sent to
 * Core on submit only; every reply is a credential-free {@link ConnectionSummary}.
 * RPC error envelopes are surfaced distinctly in-panel (never console-only).
 */

import { useEffect, useState } from "react";
import type { ConnectionSummary, RpcErrorEnvelope } from "../../shared/contract.ts";
import { rpc } from "../rpc/client.ts";
import {
  applyAdded,
  applyEdited,
  applyRemoved,
  emptyConnections,
  emptyDraft,
  loadConnections,
  validateDraft,
  type ConnectionsState,
  type Draft,
} from "./connections-model.ts";

/** A terse mono field-error or RPC-envelope banner. */
function ErrorLine({ text }: { text: string }): React.JSX.Element {
  return (
    <p role="alert" className="font-mono text-xs lowercase text-red-400">
      {text}
    </p>
  );
}

/** Render `host · engine` verbatim in mono — the always-mono connection identity line. */
function HostEngine({ summary }: { summary: ConnectionSummary }): React.JSX.Element {
  return (
    <span className="font-mono text-xs text-muted-foreground">
      {summary.host} · {summary.engine}
    </span>
  );
}

/** A labelled mono text input used by both the add and edit forms. */
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
    <label className="flex flex-col gap-1">
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

/** Inline edit row: rename-only (leave url blank) OR repoint (type a new url). */
function EditRow({
  summary,
  onSave,
  onCancel,
  busy,
}: {
  summary: ConnectionSummary;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
  busy: boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>({ name: summary.name, url: "" });
  const validation = validateDraft(draft, "edit");
  const nameInvalid = !validation.ok && validation.field === "name";
  const urlInvalid = !validation.ok && validation.field === "url";

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-border bg-muted p-3">
      <Field
        label="name"
        placeholder="name"
        value={draft.name}
        onChange={(name) => setDraft((d) => ({ ...d, name }))}
        invalid={nameInvalid}
      />
      <Field
        label="url (leave blank to keep current)"
        placeholder="postgres://user:pass@host:5432/db"
        value={draft.url}
        onChange={(url) => setDraft((d) => ({ ...d, url }))}
        invalid={urlInvalid}
      />
      {!validation.ok ? <ErrorLine text={validation.message} /> : null}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!validation.ok || busy}
          onClick={() => onSave(draft)}
          className="rounded-[var(--radius)] border border-border bg-primary px-3 py-1 font-mono text-xs lowercase text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[var(--radius)] border border-border px-3 py-1 font-mono text-xs lowercase text-foreground transition-colors hover:bg-accent"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

/** One saved connection: name + host·engine, with edit / remove (remove confirms). */
function ConnectionRow({
  summary,
  onEdit,
  onRemove,
  busy,
}: {
  summary: ConnectionSummary;
  onEdit: () => void;
  onRemove: () => void;
  busy: boolean;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-card px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{summary.name}</span>
        <HostEngine summary={summary} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {confirming ? (
          <>
            <span className="font-mono text-xs lowercase text-muted-foreground">remove?</span>
            <button
              type="button"
              disabled={busy}
              onClick={onRemove}
              className="rounded-[var(--radius)] border border-red-700 bg-red-600 px-2 py-1 font-mono text-xs lowercase text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              yes
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-[var(--radius)] border border-border px-2 py-1 font-mono text-xs lowercase text-foreground transition-colors hover:bg-accent"
            >
              no
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="rounded-[var(--radius)] border border-border px-2 py-1 font-mono text-xs lowercase text-foreground transition-colors hover:bg-accent"
            >
              edit
            </button>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded-[var(--radius)] border border-border px-2 py-1 font-mono text-xs lowercase text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              remove
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Terse mono description of an RPC error envelope, surfaced in-panel. */
function envelopeText(error: RpcErrorEnvelope): string {
  return error.detail ? `${error.code}: ${error.message} (${error.detail})` : `${error.code}: ${error.message}`;
}

export function SettingsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [state, setState] = useState<ConnectionsState>(emptyConnections);
  const [loading, setLoading] = useState(true);
  // Did the mount-time list actually land? If it errored, `loading` still clears
  // but the local list is a phantom-empty — mutating against it would create a
  // duplicate (add) or silently no-op (edit/remove). Gate mutations on this.
  const [listLoaded, setListLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Load the list once on mount via the proven token-gated channel.
  useEffect(() => {
    let alive = true;
    void rpc<ReadonlyArray<ConnectionSummary>>("connections.list").then((reply) => {
      if (!alive) return;
      if (reply.ok) {
        setState((s) => loadConnections(s, reply.result));
        setError(null);
        setListLoaded(true);
      } else {
        setError(envelopeText(reply.error));
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const addValidation = validateDraft(addDraft, "add");
  const addNameInvalid = !addValidation.ok && addValidation.field === "name";
  const addUrlInvalid = !addValidation.ok && addValidation.field === "url";

  const onAdd = (): void => {
    // Gate on `loading` too: a mount-time `connections.list` resolves LATER and
    // replaces the whole list, which would drop a row added before it lands. Gate
    // on `listLoaded`: if that list errored, adding would fork a duplicate store.
    if (!addValidation.ok || busy || loading || !listLoaded) return;
    setBusy(true);
    void rpc<ConnectionSummary>("connections.add", { name: addDraft.name.trim(), url: addDraft.url.trim() }).then(
      (reply) => {
        if (reply.ok) {
          setState((s) => applyAdded(s, reply.result));
          setAddDraft(emptyDraft());
          setError(null);
        } else {
          setError(envelopeText(reply.error));
        }
        setBusy(false);
      },
    );
  };

  const onSaveEdit = (id: string, draft: Draft): void => {
    if (busy || loading || !listLoaded) return;
    setBusy(true);
    // Rename-only sends name; a non-empty url repoints. The UI never held the
    // stored url, so a blank url means "keep it" — we simply omit it.
    const url = draft.url.trim();
    const params = url.length > 0 ? { id, name: draft.name.trim(), url } : { id, name: draft.name.trim() };
    void rpc<ConnectionSummary>("connections.edit", params).then((reply) => {
      if (reply.ok) {
        setState((s) => applyEdited(s, reply.result));
        setEditingId(null);
        setError(null);
      } else {
        setError(envelopeText(reply.error));
      }
      setBusy(false);
    });
  };

  const onRemove = (id: string): void => {
    if (busy || loading || !listLoaded) return;
    setBusy(true);
    void rpc<{ removed: true }>("connections.remove", { id }).then((reply) => {
      if (reply.ok) {
        setState((s) => applyRemoved(s, id));
        setError(null);
      } else {
        setError(envelopeText(reply.error));
      }
      setBusy(false);
    });
  };

  return (
    <section
      data-testid="settings-panel"
      aria-label="Settings"
      className="flex h-full flex-col bg-background"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground">settings</span>
          <span className="font-mono text-xs lowercase text-muted-foreground">connections</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
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

        {/* Add form */}
        <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-border bg-card p-3">
          <span className="font-mono text-xs lowercase text-muted-foreground">add connection</span>
          <Field
            label="name"
            placeholder="prod db"
            value={addDraft.name}
            onChange={(name) => setAddDraft((d) => ({ ...d, name }))}
            invalid={addNameInvalid}
          />
          <Field
            label="url"
            placeholder="postgres://user:pass@host:5432/db"
            value={addDraft.url}
            onChange={(url) => setAddDraft((d) => ({ ...d, url }))}
            invalid={addUrlInvalid}
          />
          {!addValidation.ok && (addDraft.name.length > 0 || addDraft.url.length > 0) ? (
            <ErrorLine text={addValidation.message} />
          ) : null}
          <div>
            <button
              type="button"
              disabled={!addValidation.ok || busy || loading || !listLoaded}
              onClick={onAdd}
              className="rounded-[var(--radius)] border border-border bg-primary px-3 py-1 font-mono text-xs lowercase text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              add
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex flex-col gap-2">
          {loading ? (
            <p className="font-mono text-xs lowercase text-muted-foreground">loading…</p>
          ) : state.connections.length === 0 ? (
            <p className="font-mono text-xs lowercase text-muted-foreground">no connections yet</p>
          ) : (
            state.connections.map((summary) =>
              editingId === summary.id ? (
                <EditRow
                  key={summary.id}
                  summary={summary}
                  busy={busy}
                  onSave={(draft) => onSaveEdit(summary.id, draft)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <ConnectionRow
                  key={summary.id}
                  summary={summary}
                  busy={busy}
                  onEdit={() => setEditingId(summary.id)}
                  onRemove={() => onRemove(summary.id)}
                />
              ),
            )
          )}
        </div>
      </div>
    </section>
  );
}
