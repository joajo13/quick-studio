/**
 * quick-studio UI (Ring 2) — ChatTabView (Story 5.2, extended in Story 5.3).
 *
 * The chat surface for a `chat` Tab: a provider picker (only CONFIGURED providers,
 * from `providers.list`), a message input (send button + Ctrl/Cmd+Enter, with a
 * re-entrancy guard), a message log, and a per-answer "schema-only · N tables" badge
 * that makes the default policy visible. Session state (messages + picked provider)
 * is lifted to `App` keyed by tab id and is NEVER persisted (mirrors `queryDrafts`).
 *
 * The UI holds NO provider key and issues NO outbound provider call — it sends
 * `chat.ask {provider, message}` and the Core (the sole key holder) makes the only
 * outbound call, returning an answer, a Core-extracted `query`, and a schema-only
 * context summary. No `ai`/`@ai-sdk/*` import exists in this ring.
 *
 * Story 5.3: an assistant message carrying a non-null `query` renders the SQL
 * read-only with a "run" action. Running it drives the SAME `runRawQuery` seam
 * (Story 3.1 guarded `execute`) and the SAME `ConfirmRun` dialog `QueryTabView`
 * uses — the UI never parses/classifies the generated SQL (AR-3), it sends it
 * verbatim. Run state is per-message, keyed by the message's index in the log (the
 * log only ever appends, so an index is a stable key), and kept OUT of `ChatState`
 * — it is transient/local, never lifted or persisted (mirrors `QueryTabView`'s
 * `pendingSql`/`confirm`/`busy`, one instance per runnable message).
 *
 * `sendChat` is exported as a standalone, DOM-free async function (mocking `rpc` is
 * enough to exercise every send outcome) so the round-trip logic is unit-testable
 * without a live DOM — mirroring `runRawQuery`.
 */

import { useEffect, useRef, useState } from "react";
import {
  PROVIDER_KINDS,
  type ChatAskResult,
  type ChatContextSummary,
  type ListProvidersResult,
  type ProviderKind,
} from "../../shared/contract.ts";
import { DataGrid } from "../data/DataGrid.tsx";
import { rpc } from "../rpc/client.ts";
import { envelopeText } from "../rpc/envelope-text.ts";
import {
  appendAnswer,
  appendUserMessage,
  setProvider,
  validateSend,
  type ChatState,
} from "./chat-model.ts";
import { ConfirmRun } from "./ConfirmRun.tsx";
import { runRawQuery, type RunOutcome } from "./run-raw-query.ts";

/**
 * The outcome of one `chat.ask` round-trip, decoupled from React state so the send
 * flow is unit-testable by mocking `rpc` and calling `sendChat` directly (no render /
 * no DOM required).
 */
export type SendOutcome =
  | {
      readonly kind: "answer";
      readonly answer: string;
      readonly query: string | null;
      readonly context: ChatContextSummary;
    }
  | { readonly kind: "error"; readonly message: string };

/**
 * Ask `message` of `provider` through the Core-only `chat.ask` RPC. The UI never
 * holds a key nor calls a provider — the Core resolves the key in Ring 1 and makes
 * the sole outbound call. A failed envelope maps to a terse `error` outcome.
 */
export async function sendChat(provider: ProviderKind, message: string): Promise<SendOutcome> {
  const reply = await rpc<ChatAskResult>("chat.ask", { provider, message });
  if (!reply.ok) return { kind: "error", message: envelopeText(reply.error) };
  return {
    kind: "answer",
    answer: reply.result.answer,
    query: reply.result.query,
    context: reply.result.context,
  };
}

/**
 * Per-message run state for a generated query — keyed by the message's index in
 * `state.messages`. `pendingSql` is the EXACT sql sent for the run currently
 * awaiting confirmation (frozen, mirrors `QueryTabView`'s `pendingSql` — a confirm
 * always re-issues this, never a re-derived/trimmed string). `outcome` is the last
 * `runRawQuery` result (or `null` before any run).
 */
export type ChatRunEntry = {
  readonly pendingSql: string;
  readonly busy: boolean;
  readonly outcome: RunOutcome | null;
  readonly selectedRow: number | null;
};

export const IDLE_RUN: ChatRunEntry = { pendingSql: "", busy: false, outcome: null, selectedRow: null };

/** Run `run` and map a throw to the same `{kind:"error"}` shape a failed envelope would produce. */
async function toOutcome(
  run: typeof runRawQuery,
  sql: string,
  confirmed?: boolean,
): Promise<RunOutcome> {
  try {
    return await run(sql, confirmed);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Run `sql` for one chat message's query block, returning its NEXT `ChatRunEntry`.
 * A no-op (returns `entry` UNCHANGED, `run` never called) while a run is already
 * `busy` or a confirm is pending on this SAME entry — a stray re-click must not
 * silently abandon a destructive confirm mid-decision (mirrors `QueryTabView`'s
 * `run` guard). `run` is the injected `runRawQuery` seam (defaults to the real
 * one) so this is unit-testable with a stub, no rpc/DOM required — mirroring
 * `runRawQuery` itself.
 */
export async function runChatQuery(
  entry: ChatRunEntry,
  sql: string,
  run: typeof runRawQuery = runRawQuery,
): Promise<ChatRunEntry> {
  if (entry.busy || entry.outcome?.kind === "confirm") return entry;
  const outcome = await toOutcome(run, sql);
  return { pendingSql: sql, busy: false, outcome, selectedRow: null };
}

/**
 * Re-issue `entry.pendingSql` — the EXACT sql originally sent, never the (Core-
 * trimmed) preview — with `confirmed:true`, returning the NEXT `ChatRunEntry`. A
 * no-op while already `busy`, and — defense-in-depth for invariant (d) — a no-op
 * unless a confirmation is actually pending (`outcome.kind === "confirm"`), so a
 * `confirmed:true` execute can never fire for a statement Core never gated.
 */
export async function confirmChatQuery(
  entry: ChatRunEntry,
  run: typeof runRawQuery = runRawQuery,
): Promise<ChatRunEntry> {
  if (entry.busy || entry.outcome?.kind !== "confirm") return entry;
  const outcome = await toOutcome(run, entry.pendingSql, true);
  return { pendingSql: entry.pendingSql, busy: false, outcome, selectedRow: null };
}

/** Clear a pending confirm (or any prior result) without executing anything. */
export function cancelChatQuery(entry: ChatRunEntry): ChatRunEntry {
  return { ...entry, outcome: null };
}

/**
 * The generated-query block under an assistant message: the SQL read-only, a "run"
 * action, and — driven by `entry.outcome` — the same result surfaces `QueryTabView`
 * has (a `DataGrid` for rows, an "N rows affected" line, the shared `ConfirmRun`
 * dialog for a destructive/DDL preview, or an error banner). Purely presentational;
 * `ChatTabView` owns all the state and the `runRawQuery` calls.
 */
function ChatQueryRun({
  sql,
  entry,
  onRun,
  onConfirm,
  onCancel,
  onSelectRow,
}: {
  sql: string;
  entry: ChatRunEntry;
  onRun: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onSelectRow: (row: number) => void;
}): React.JSX.Element {
  const outcome = entry.outcome;
  return (
    <div className="flex w-full max-w-[85%] flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] p-2">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-[var(--foreground)]">
        {sql}
      </pre>
      <div>
        <button
          type="button"
          disabled={entry.busy || outcome?.kind === "confirm"}
          onClick={onRun}
          className="rounded-[var(--radius)] border border-[var(--coral-line)] bg-[var(--coral-soft)] px-2 py-0.5 font-mono text-xs lowercase text-[var(--foreground)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {entry.busy ? "running…" : "run"}
        </button>
      </div>

      {outcome?.kind === "confirm" ? (
        <ConfirmRun sql={outcome.sql} risk={outcome.risk} busy={entry.busy} onConfirm={onConfirm} onCancel={onCancel} />
      ) : null}

      {outcome?.kind === "error" ? (
        <p role="alert" className="font-mono text-xs lowercase text-red-400">
          {outcome.message}
        </p>
      ) : null}

      {outcome?.kind === "ok" ? (
        <p className="font-mono text-xs lowercase text-[var(--foreground)]">
          {outcome.rowsAffected} row{outcome.rowsAffected === 1 ? "" : "s"} affected
        </p>
      ) : null}

      {outcome?.kind === "rows" ? (
        <div className="flex flex-col gap-1">
          {outcome.truncated ? (
            <p className="font-mono text-xs lowercase text-amber-400">
              result truncated — only the first {outcome.data.rows.length} rows were returned
            </p>
          ) : null}
          <div className="h-64">
            <DataGrid
              data={outcome.data}
              primaryKeys={[]}
              selectedRow={entry.selectedRow}
              onSelectRow={onSelectRow}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
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
        onStateChange(appendAnswer(afterUser, outcome.answer, outcome.context, outcome.query));
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

  // Per-message run state for a generated query (message index -> ChatRunEntry).
  // Transient/local — never lifted into `state`/`onStateChange`, so it is never
  // persisted and resets whenever this Tab remounts (mirrors `queryDrafts` never
  // storing run results either).
  const [runs, setRuns] = useState<Readonly<Record<number, ChatRunEntry>>>({});
  // Per-message re-entrancy guards (message index -> firing), mirroring `firing`
  // above: `busy` only lands after a re-render, so a synchronous double-fire on the
  // SAME message's run button must still be blocked by a ref, not state.
  const runFiring = useRef<Record<number, boolean>>({});

  const runEntry = (i: number): ChatRunEntry => runs[i] ?? IDLE_RUN;

  const runQuery = async (i: number, sql: string): Promise<void> => {
    const entry = runEntry(i);
    // Blocked while a confirm is pending on THIS message — a stray re-click must
    // not silently abandon the destructive confirm mid-decision (cancel it first).
    // `runChatQuery` re-checks the same condition (defense in depth for any other
    // caller); this ref additionally blocks a SYNCHRONOUS double-fire that could
    // both read `busy === false` before either setRuns lands.
    if (runFiring.current[i] || entry.busy || entry.outcome?.kind === "confirm") return;
    runFiring.current[i] = true;
    setRuns((r) => ({ ...r, [i]: { ...entry, busy: true } }));
    const next = await runChatQuery(entry, sql);
    setRuns((r) => ({ ...r, [i]: next }));
    runFiring.current[i] = false;
  };

  const confirmQuery = async (i: number): Promise<void> => {
    const entry = runEntry(i);
    if (runFiring.current[i] || entry.busy) return;
    runFiring.current[i] = true;
    setRuns((r) => ({ ...r, [i]: { ...entry, busy: true } }));
    const next = await confirmChatQuery(entry);
    setRuns((r) => ({ ...r, [i]: next }));
    runFiring.current[i] = false;
  };

  const cancelQuery = (i: number): void => {
    setRuns((r) => ({ ...r, [i]: cancelChatQuery(runEntry(i)) }));
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
                  <>
                    <span className="font-mono text-[11px] lowercase text-[var(--muted-foreground)]">
                      schema-only · {m.context.tables} {m.context.tables === 1 ? "table" : "tables"}
                    </span>
                    {m.query !== null ? (
                      <ChatQueryRun
                        sql={m.query}
                        entry={runEntry(i)}
                        onRun={() => void runQuery(i, m.query as string)}
                        onConfirm={() => void confirmQuery(i)}
                        onCancel={() => cancelQuery(i)}
                        onSelectRow={(row) =>
                          setRuns((r) => ({ ...r, [i]: { ...runEntry(i), selectedRow: row } }))
                        }
                      />
                    ) : null}
                  </>
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
