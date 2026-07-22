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
import type { ActiveConnectionInfo, ConnectionSummary, RpcErrorEnvelope } from "../../shared/contract.ts";
import { rpc } from "../rpc/client.ts";
import { ProvidersPanel } from "./ProvidersPanel.tsx";
import {
  applyAdded,
  applyEdited,
  applyRemoved,
  editConnectionParams,
  emptyConnections,
  emptyDraft,
  loadConnections,
  validateDraft,
  type ConnectionsState,
  type Draft,
} from "./connections-model.ts";

/** Which Settings section is active — connections management or AI provider keys. */
type SettingsSection = "connections" | "providers";

/** A terse mono field-error or RPC-envelope banner. */
function ErrorLine({ text }: { text: string }): React.JSX.Element {
  return (
    <p role="alert" className="font-mono text-xs lowercase text-err">
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
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        className={`rounded-[var(--radius)] border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none ${
          invalid
            ? "border-err focus:border-err focus:shadow-[0_0_0_3px_var(--err-soft)]"
            : "border-border focus:border-coral focus:shadow-[0_0_0_3px_var(--coral-soft)]"
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
  // `schema` IS carried on the summary (unlike the url), so the field is pre-filled —
  // which is what makes blanking it an unambiguous "clear the pin" on save.
  const [draft, setDraft] = useState<Draft>({
    name: summary.name,
    url: "",
    schema: summary.schema ?? "",
  });
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
      <Field
        label="schema (optional, blank to clear)"
        placeholder="public"
        value={draft.schema}
        onChange={(schema) => setDraft((d) => ({ ...d, schema }))}
        invalid={false}
      />
      {!validation.ok ? <ErrorLine text={validation.message} /> : null}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!validation.ok || busy}
          onClick={() => onSave(draft)}
          className="rounded-[var(--radius)] border border-border bg-coral px-3 py-1 font-mono text-xs lowercase text-coral-ink transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
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
              className="rounded-[var(--radius)] border border-err-line bg-err px-2 py-1 font-mono text-xs lowercase text-white transition-colors hover:opacity-90 disabled:opacity-50"
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

export function SettingsPanel({
  onClose,
  onRegistryChanged,
}: {
  onClose: () => void;
  /**
   * Fired after every SUCCESSFUL registry mutation (add / edit / remove), so the
   * permanently-mounted schema tree can re-read `connections.list` and reconcile its
   * roots without an app restart (Story 10.5). Wired from the mutation itself rather
   * than from a tab-close event: the tree and this panel are siblings in one React tree,
   * both live for the whole session, and a saved connection must appear in the tree the
   * moment it is saved — that is what the empty-state's "Agregá una conexión en Ajustes"
   * promises. Never fired on a failed mutation (nothing changed to reconcile).
   */
  onRegistryChanged?: () => void;
}): React.JSX.Element {
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
  const [section, setSection] = useState<SettingsSection>("connections");
  // The in-memory active connection (Story 8.7). Loaded by a SECOND, independent mount
  // effect below — deliberately NOT tied to `loading`/`listLoaded`/`busy` (those gate the
  // saved-list mutations). A `connection.active` failure leaves this null (entry absent)
  // without disturbing the saved list. Read-only display; never part of the saved state.
  const [active, setActive] = useState<ActiveConnectionInfo | null>(null);

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

  // Load the read-only active connection INDEPENDENTLY of the saved list (Story 8.7).
  // Its own state, its own effect — a failure here must not touch `loading`/`listLoaded`/
  // `busy` nor break the saved list; the active entry simply stays absent.
  useEffect(() => {
    let alive = true;
    void rpc<ActiveConnectionInfo>("connection.active").then((reply) => {
      if (!alive) return;
      if (reply.ok) setActive(reply.result);
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
    // `schema` is sent ONLY when non-blank so an unpinned add stays byte-identical to
    // the pre-10.2 request (nothing to clear on a connection that does not exist yet).
    const addSchema = addDraft.schema.trim();
    void rpc<ConnectionSummary>("connections.add", {
      name: addDraft.name.trim(),
      url: addDraft.url.trim(),
      ...(addSchema.length > 0 ? { schema: addSchema } : {}),
    }).then((reply) => {
      if (reply.ok) {
        setState((s) => applyAdded(s, reply.result));
        setAddDraft(emptyDraft());
        setError(null);
        onRegistryChanged?.();
      } else {
        setError(envelopeText(reply.error));
      }
      setBusy(false);
    });
  };

  const onSaveEdit = (id: string, draft: Draft, storedSchema: string | undefined): void => {
    if (busy || loading || !listLoaded) return;
    setBusy(true);
    // Which keys the partial patch actually carries — url omitted when blank, schema
    // omitted unless it differs from the pin the row was rendered from. Pure and
    // unit-tested in `connections-model.ts`; see `editConnectionParams`.
    const params = editConnectionParams(id, draft, storedSchema);
    void rpc<ConnectionSummary>("connections.edit", params).then((reply) => {
      if (reply.ok) {
        setState((s) => applyEdited(s, reply.result));
        setEditingId(null);
        setError(null);
        onRegistryChanged?.();
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
        onRegistryChanged?.();
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
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold text-foreground">settings</span>
          <nav className="flex items-baseline gap-2">
            <button
              type="button"
              onClick={() => setSection("connections")}
              className={`border-b-2 pb-0.5 font-mono text-xs lowercase transition-colors ${
                section === "connections"
                  ? "border-coral text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              connections
            </button>
            <button
              type="button"
              onClick={() => setSection("providers")}
              className={`border-b-2 pb-0.5 font-mono text-xs lowercase transition-colors ${
                section === "providers"
                  ? "border-coral text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              ai providers
            </button>
          </nav>
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

      {section === "providers" ? (
        <ProvidersPanel mode={active?.mode} />
      ) : (
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {error !== null ? (
          <div className="rounded-[var(--radius)] border border-err-line bg-err-soft px-3 py-2">
            <ErrorLine text={error} />
          </div>
        ) : null}

        {/* Active connection (read-only) — the in-memory target the session is browsing
            (Story 8.7). Distinct from the saved list: labelled, no edit/remove controls. */}
        {active !== null && active.connection !== null ? (
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              active connection
            </span>
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-card px-3 py-2">
              <span className="truncate font-mono text-xs text-muted-foreground">
                {active.connection.host} · {active.connection.engine}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{active.mode}</span>
            </div>
          </div>
        ) : null}

        {/* Add form */}
        <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-border bg-card p-4">
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            add connection
          </span>
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
          <Field
            label="schema (optional)"
            placeholder="public"
            value={addDraft.schema}
            onChange={(schema) => setAddDraft((d) => ({ ...d, schema }))}
            invalid={false}
          />
          {/* Stay silent on a pristine form, but speak up as soon as ANY field has been
              typed into — including `schema`, which alone leaves the Add button disabled
              (name + url are still required) and would otherwise explain nothing. */}
          {!addValidation.ok &&
          (addDraft.name.length > 0 || addDraft.url.length > 0 || addDraft.schema.length > 0) ? (
            <ErrorLine text={addValidation.message} />
          ) : null}
          <div>
            <button
              type="button"
              disabled={!addValidation.ok || busy || loading || !listLoaded}
              onClick={onAdd}
              className="rounded-[var(--radius)] border border-border bg-coral px-3 py-1 font-mono text-xs lowercase text-coral-ink transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
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
                  onSave={(draft) => onSaveEdit(summary.id, draft, summary.schema)}
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
      )}
    </section>
  );
}
