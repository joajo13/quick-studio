/**
 * quick-studio UI (Ring 2) — Settings surface: AI providers section (Story 5.1).
 *
 * The home for set/replace/remove of a user-supplied AI provider API key. It drives
 * the pure `providers-model` and talks to Core only through the typed `rpc` client,
 * mirroring `SettingsPanel`'s connections flow. Microcopy is mono, lowercase, terse.
 *
 * Trust boundary: the UI holds no key. A key is typed into a draft (a password input,
 * never rendered back) and sent to Core on submit only; every reply is a secret-free
 * {@link ProviderSummary} carrying at most a last-4 `keyPreview`. RPC error envelopes
 * are surfaced distinctly in-panel.
 */

import { useEffect, useState } from "react";
import {
  PROVIDER_KINDS,
  type ConnectionMode,
  type ListProvidersResult,
  type ProviderKind,
  type ProviderSummary,
  type RemoveProviderResult,
  type SetProviderResult,
} from "../../shared/contract.ts";
import { rpc } from "../rpc/client.ts";
import { envelopeText } from "../rpc/envelope-text.ts";
import {
  applyRemoved,
  applySet,
  emptyProviders,
  loadProviders,
  summaryFor,
  validateDraft,
  type ProvidersState,
} from "./providers-model.ts";

/** A terse mono field-error or RPC-envelope banner. */
function ErrorLine({ text }: { text: string }): React.JSX.Element {
  return (
    <p role="alert" className="font-mono text-xs lowercase text-err">
      {text}
    </p>
  );
}

/** One provider kind: configured state + keyPreview, a key input to set/replace, remove. */
function ProviderRow({
  provider,
  summary,
  value,
  onChange,
  onSave,
  onRemove,
  busy,
  ready,
}: {
  provider: ProviderKind;
  summary: ProviderSummary | undefined;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onRemove: () => void;
  busy: boolean;
  /** The configured list has loaded; until then mutations no-op, so keep them disabled. */
  ready: boolean;
}): React.JSX.Element {
  const configured = summary !== undefined;
  const canSave = validateDraft({ provider, apiKey: value }).ok && !busy && ready;
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs lowercase text-foreground">{provider}</span>
        {configured ? (
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            configured · <span className="normal-case">{summary.keyPreview}</span>
          </span>
        ) : (
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            not configured
          </span>
        )}
      </div>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          {configured ? "api key (replace)" : "api key"}
        </span>
        <input
          type="password"
          value={value}
          placeholder="sk-…"
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          className="rounded-[var(--radius)] border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-coral focus:shadow-[0_0_0_3px_var(--coral-soft)]"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canSave}
          onClick={onSave}
          className="rounded-[var(--radius)] border border-border bg-coral px-3 py-1 font-mono text-xs lowercase text-coral-ink transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {configured ? "replace" : "save"}
        </button>
        {configured ? (
          <button
            type="button"
            disabled={busy || !ready}
            onClick={onRemove}
            className="rounded-[var(--radius)] border border-border px-3 py-1 font-mono text-xs lowercase text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            remove
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The AI-providers section body (no header/close — hosted inside `SettingsPanel`'s
 * switcher). Loads the configured list once on mount, then lists the three known
 * kinds statically, overlaying "not configured" for the unset ones.
 *
 * `mode` is the already-loaded `connection.active` run mode, threaded from
 * `SettingsPanel` (no duplicate RPC). When it is `ephemeral`, a terse note makes the
 * by-design memory-only behaviour discoverable; `persistent`/absent renders nothing extra.
 */
export function ProvidersPanel({ mode }: { mode?: ConnectionMode }): React.JSX.Element {
  const [state, setState] = useState<ProvidersState>(emptyProviders);
  const [loading, setLoading] = useState(true);
  const [listLoaded, setListLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-kind draft key text (the transient secret while typing).
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const setDraft = (provider: ProviderKind, apiKey: string): void =>
    setDrafts((d) => ({ ...d, [provider]: apiKey }));

  // Load the configured list once on mount via the token-gated channel.
  useEffect(() => {
    let alive = true;
    void rpc<ListProvidersResult>("providers.list").then((reply) => {
      if (!alive) return;
      if (reply.ok) {
        setState((s) => loadProviders(s, reply.result.providers));
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

  const onSave = (provider: ProviderKind): void => {
    const apiKey = (drafts[provider] ?? "").trim();
    if (!validateDraft({ provider, apiKey }).ok || busy || loading || !listLoaded) return;
    setBusy(true);
    void rpc<SetProviderResult>("providers.set", { provider, apiKey }).then((reply) => {
      // Drop the typed key from Ring 2 state regardless of outcome — never retain the
      // secret after submit, even on error (the user re-enters it to retry).
      setDraft(provider, "");
      if (reply.ok) {
        setState((s) => applySet(s, reply.result));
        setError(null);
      } else {
        setError(envelopeText(reply.error));
      }
      setBusy(false);
    });
  };

  const onRemove = (provider: ProviderKind): void => {
    if (busy || loading || !listLoaded) return;
    setBusy(true);
    void rpc<RemoveProviderResult>("providers.remove", { provider }).then((reply) => {
      if (reply.ok) {
        setState((s) => applyRemoved(s, provider));
        setError(null);
      } else {
        setError(envelopeText(reply.error));
      }
      setBusy(false);
    });
  };

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      {error !== null ? (
        <div className="rounded-[var(--radius)] border border-err-line bg-err-soft px-3 py-2">
          <ErrorLine text={error} />
        </div>
      ) : null}

      {mode === "ephemeral" ? (
        <p className="font-mono text-xs lowercase text-muted-foreground">
          ephemeral session · keys are not remembered after restart
        </p>
      ) : null}

      {loading ? (
        <p className="font-mono text-xs lowercase text-muted-foreground">loading…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {PROVIDER_KINDS.map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              summary={summaryFor(state, provider)}
              value={drafts[provider] ?? ""}
              onChange={(v) => setDraft(provider, v)}
              onSave={() => onSave(provider)}
              onRemove={() => onRemove(provider)}
              busy={busy}
              ready={listLoaded}
            />
          ))}
        </div>
      )}
    </div>
  );
}
