/**
 * quick-studio UI (Ring 2) — ChatTabView (Story 5.2).
 *
 * The chat surface for a `chat` Tab: a provider picker (only CONFIGURED providers,
 * from `providers.list`), a message input (send button + Ctrl/Cmd+Enter, with a
 * re-entrancy guard), a message log, and a per-answer "schema-only · N tables" badge
 * that makes the default policy visible. Session state (messages + picked provider)
 * is lifted to `App` keyed by tab id and is NEVER persisted (mirrors `queryDrafts`).
 *
 * The UI holds NO provider key and issues NO outbound provider call — it sends
 * `chat.ask {provider, message}` and the Core (the sole key holder) makes the only
 * outbound call, returning an answer plus a schema-only context summary. No
 * `ai`/`@ai-sdk/*` import exists in this ring.
 *
 * `sendChat` is exported as a standalone, DOM-free async function (mocking `rpc` is
 * enough to exercise every send outcome) so the round-trip logic is unit-testable
 * without a live DOM — mirroring `QueryTabView`'s `runRawQuery`.
 */

import { useEffect, useRef, useState } from "react";
import {
  PROVIDER_KINDS,
  type ChatAskResult,
  type ChatContextSummary,
  type ListProvidersResult,
  type ProviderKind,
} from "../../shared/contract.ts";
import { rpc } from "../rpc/client.ts";
import { envelopeText } from "../rpc/envelope-text.ts";
import {
  appendAnswer,
  appendUserMessage,
  setProvider,
  validateSend,
  type ChatState,
} from "./chat-model.ts";

/**
 * The outcome of one `chat.ask` round-trip, decoupled from React state so the send
 * flow is unit-testable by mocking `rpc` and calling `sendChat` directly (no render /
 * no DOM required).
 */
export type SendOutcome =
  | { readonly kind: "answer"; readonly answer: string; readonly context: ChatContextSummary }
  | { readonly kind: "error"; readonly message: string };

/**
 * Ask `message` of `provider` through the Core-only `chat.ask` RPC. The UI never
 * holds a key nor calls a provider — the Core resolves the key in Ring 1 and makes
 * the sole outbound call. A failed envelope maps to a terse `error` outcome.
 */
export async function sendChat(provider: ProviderKind, message: string): Promise<SendOutcome> {
  const reply = await rpc<ChatAskResult>("chat.ask", { provider, message });
  if (!reply.ok) return { kind: "error", message: envelopeText(reply.error) };
  return { kind: "answer", answer: reply.result.answer, context: reply.result.context };
}

export function ChatTabView({
  state,
  onStateChange,
}: {
  /** The session-only chat state for this Tab (never persisted to disk/snapshot). */
  state: ChatState;
  onStateChange: (next: ChatState) => void;
}): React.JSX.Element {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Configured providers (from `providers.list`) — the picker offers ONLY these; the
  // request must carry an explicit `provider` (there is no active-provider concept).
  const [configured, setConfigured] = useState<ReadonlyArray<ProviderKind>>([]);
  const [providersReady, setProvidersReady] = useState(false);
  // A failed `providers.list` (Core/transport error) is distinct from "none
  // configured" — surfacing it prevents a misleading empty-state dead-end.
  const [providersError, setProvidersError] = useState<string | null>(null);
  // Mounted guard: a send can resolve after this Tab is closed/switched away. Without
  // this, `onStateChange` would re-insert the closed Tab's (already-reclaimed) state.
  const mounted = useRef(true);
  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);
  // Synchronous re-entrancy guard: `busy` only lands after a re-render, so two
  // synchronous fires (double-click / key-repeat) could both pass a `busy === false`
  // check. This ref flips immediately, so a send can never fire twice (mirrors
  // QueryTabView's `firing`).
  const firing = useRef(false);

  // Load the configured providers once on mount. A failed list leaves the picker
  // empty (the empty-state prompt covers "no providers"); the request still can't be
  // issued without a picked provider.
  useEffect(() => {
    let alive = true;
    void rpc<ListProvidersResult>("providers.list").then((reply) => {
      if (!alive) return;
      if (reply.ok) {
        const kinds = reply.result.providers.map((p) => p.provider);
        // Keep the static PROVIDER_KINDS order for a stable picker.
        setConfigured(PROVIDER_KINDS.filter((k) => kinds.includes(k)));
      } else {
        setProvidersError(envelopeText(reply.error));
      }
      setProvidersReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const send = async (): Promise<void> => {
    if (firing.current || busy) return;
    const validation = validateSend(state, input);
    if (!validation.ok) {
      setError(validation.reason);
      return;
    }
    firing.current = true;
    setBusy(true);
    setError(null);
    const { provider, message } = validation;
    // Append the user message immediately; append the answer onto THAT concrete state
    // (the `state` prop is stale within this async handler).
    const afterUser = appendUserMessage(state, message);
    onStateChange(afterUser);
    setInput("");
    try {
      const outcome = await sendChat(provider, message);
      // Tab closed/switched mid-flight — drop the result so we never resurrect the
      // reclaimed Tab's state.
      if (!mounted.current) return;
      if (outcome.kind === "answer") {
        onStateChange(appendAnswer(afterUser, outcome.answer, outcome.context));
      } else {
        setError(outcome.message);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) {
        setBusy(false);
        firing.current = false;
      }
    }
  };

  const hasProviders = configured.length > 0;
  const canSend = hasProviders && state.provider !== null && input.trim() !== "" && !busy;

  return (
    <div className="flex h-full flex-col">
      {/* Header: provider picker + schema-only indicator. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)] px-3 py-2">
        <label className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">
          provider
        </label>
        <select
          aria-label="provider"
          value={state.provider ?? ""}
          disabled={!hasProviders}
          onChange={(e) =>
            onStateChange(setProvider(state, e.target.value === "" ? null : (e.target.value as ProviderKind)))
          }
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-2 py-1 font-mono text-xs lowercase text-[var(--foreground)] outline-none focus:border-[var(--coral-line)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <option value="">{hasProviders ? "select…" : "none configured"}</option>
          {configured.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <span className="ml-auto rounded-full border border-[var(--border)] bg-[var(--muted)] px-2 py-0.5 font-mono text-[11px] lowercase text-[var(--muted-foreground)]">
          schema-only
        </span>
      </div>

      {providersReady && providersError !== null ? (
        <div className="flex items-center border-b border-[var(--border)] bg-[var(--card)] px-3 py-2">
          <p role="alert" className="font-mono text-xs lowercase text-[var(--muted-foreground)]">
            could not load providers: {providersError}
          </p>
        </div>
      ) : providersReady && !hasProviders ? (
        <div className="flex items-center border-b border-[var(--border)] bg-[var(--card)] px-3 py-2">
          <p className="font-mono text-xs lowercase text-[var(--muted-foreground)]">
            no providers configured — add one in settings
          </p>
        </div>
      ) : null}

      {/* Message log. */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {state.messages.length === 0 ? (
          <div
            className="flex h-full items-center justify-center lowercase text-[var(--muted-foreground)]"
            style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
          >
            ask a question about your schema
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {state.messages.map((m, i) => (
              <li
                key={i}
                className={`flex flex-col gap-1 ${m.role === "user" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-[var(--radius)] border px-3 py-2 font-mono text-xs ${
                    m.role === "user"
                      ? "border-[var(--coral-line)] bg-[var(--coral-soft)] text-[var(--foreground)]"
                      : "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{m.text}</p>
                </div>
                {m.role === "assistant" ? (
                  <span className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">
                    schema-only · {m.context.tables} {m.context.tables === 1 ? "table" : "tables"}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error !== null ? (
        <div className="flex items-center gap-3 border-t border-red-700 bg-red-950/40 px-3 py-2">
          <p role="alert" className="font-mono text-xs lowercase text-red-400">
            {error}
          </p>
        </div>
      ) : null}

      {/* Input + send control. */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--border)] bg-[var(--card)] p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void send();
            }
          }}
          spellCheck={false}
          rows={3}
          disabled={!hasProviders}
          aria-label="chat message"
          placeholder="ask about your schema…"
          className="w-full resize-y rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[var(--foreground)] outline-none focus:border-[var(--coral-line)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void send()}
            className="rounded-[var(--radius)] border border-[var(--coral-line)] bg-[var(--coral-soft)] px-3 py-1 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "asking…" : "send"}
          </button>
          <span className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">ctrl/cmd+enter</span>
        </div>
      </div>
    </div>
  );
}
