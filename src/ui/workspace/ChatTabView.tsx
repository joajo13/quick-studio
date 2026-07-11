/**
 * quick-studio UI (Ring 2) — ChatTabView (Story 5.2, 5.3; streamed in Story 5.4).
 *
 * The chat surface for a `chat` Tab: a provider picker (only CONFIGURED providers,
 * from `providers.list`), a message input (send button + Ctrl/Cmd+Enter, with a
 * re-entrancy guard), a message log, and a per-answer "schema-only · N tables" badge
 * that makes the default policy visible. Session state (messages + picked provider)
 * is lifted to `App` keyed by tab id and is NEVER persisted (mirrors `queryDrafts`).
 *
 * The UI holds NO provider key and issues NO outbound provider call — it opens the
 * token-gated `POST /chat/stream` SSE stream (`streamChat`) and the Core (the sole
 * key holder) makes the only outbound call, streaming back `reasoning-delta` /
 * `text-delta` tokens and a terminal `done{query,context}`. No `ai`/`@ai-sdk/*`
 * import exists in this ring.
 *
 * Story 5.4: the answer types in incrementally and the model's reasoning renders in a
 * visually distinct muted channel as it thinks. Deltas are accumulated into a
 * component-local partial and flushed on `requestAnimationFrame` (coalesced — no
 * per-token `setState` thrash, NFR-6); the fetch is aborted on unmount. On `done` the
 * message is committed via `appendAnswer` (incl. `reasoning` + `query`) so the 5.3
 * run/confirm affordance renders unchanged.
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
 * `streamSend` is exported as a standalone, DOM-free async function (feed it a stub
 * `streamChat` — no live DOM required) so the stream-driven send logic (incremental
 * partials, reasoning routing, done/error terminal) is unit-testable.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_SANDBOX_MARKDOWN_LENGTH,
  PROVIDER_KINDS,
  type ChatContextSummary,
  type ListProvidersResult,
  type ProviderKind,
  type SandboxRenderDoc,
} from "../../shared/contract.ts";
import { extractChartFence, parseChartSpec } from "../../shared/chart-spec.ts";
import { SandboxFrame } from "../sandbox/SandboxFrame.tsx";
import { DataGrid } from "../data/DataGrid.tsx";
import { rpc } from "../rpc/client.ts";
import { streamChat } from "../rpc/rpc-stream.ts";
import { envelopeText } from "../rpc/envelope-text.ts";
import {
  accumulateStream,
  appendAnswer,
  appendUserMessage,
  EMPTY_PARTIAL,
  setProvider,
  validateSend,
  type ChatMessage,
  type ChatState,
  type StreamPartial,
} from "./chat-model.ts";
import { ConfirmRun } from "./ConfirmRun.tsx";
import { runRawQuery, type RunOutcome } from "./run-raw-query.ts";

/**
 * The terminal outcome of one streamed send, decoupled from React state so the flow
 * is unit-testable by feeding a stub `streamChat` and calling `streamSend` directly
 * (no render / no DOM required). Incremental partials arrive via `onPartial`.
 */
export type SendOutcome =
  | {
      readonly kind: "answer";
      readonly answer: string;
      readonly query: string | null;
      readonly reasoning: string | null;
      readonly context: ChatContextSummary;
    }
  | { readonly kind: "error"; readonly message: string };

/**
 * Drive one streamed chat response: open the SSE stream via `stream` (defaults to the
 * real `streamChat`), accumulate `text-delta`/`reasoning-delta` tokens into a partial
 * (emitting each accumulated snapshot to `onPartial` for incremental render), and
 * resolve to the terminal {@link SendOutcome} — an `answer` (carrying the final text,
 * reasoning, and Core-extracted query/context on `done`) or a terse `error`. The UI
 * never holds a key nor parses SQL — `query` is whatever Core's `done` chunk carried.
 */
export async function streamSend(
  provider: ProviderKind,
  message: string,
  onPartial: (partial: StreamPartial) => void,
  stream: typeof streamChat = streamChat,
  opts?: { signal?: AbortSignal },
): Promise<SendOutcome> {
  let partial: StreamPartial = EMPTY_PARTIAL;
  let outcome: SendOutcome | null = null;
  await stream(
    provider,
    message,
    (chunk) => {
      if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
        partial = accumulateStream(partial, chunk);
        onPartial(partial);
      } else if (chunk.type === "done") {
        const reasoning = partial.reasoning.length > 0 ? partial.reasoning : null;
        // An empty/whitespace answer with NO reasoning is a dead response — surface it
        // as an error rather than committing a blank assistant bubble. A response that
        // DID stream reasoning still commits normally (the reasoning block is informative,
        // even when the answer text is empty).
        if (partial.text.trim().length === 0 && reasoning === null) {
          outcome = { kind: "error", message: "empty response" };
        } else {
          outcome = {
            kind: "answer",
            answer: partial.text,
            query: chunk.query,
            reasoning,
            context: chunk.context,
          };
        }
      } else {
        outcome = { kind: "error", message: envelopeText({ code: chunk.code, message: chunk.message }) };
      }
    },
    opts,
  );
  // A stream that ended without a terminal frame (EOF/abort) is a neutral failure.
  return outcome ?? { kind: "error", message: "stream ended without a result" };
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
 * The trailing marker appended to prose truncated at {@link MAX_SANDBOX_MARKDOWN_LENGTH}.
 */
const TRUNCATION_MARKER = "\n\n…(truncated)";

/**
 * Truncate untrusted prose so a valid frame is ALWAYS sent (Story 5.6, P3). The guest's
 * `isSandboxInbound` DROPS a frame whose `markdown` exceeds {@link MAX_SANDBOX_MARKDOWN_LENGTH}
 * — silently blanking the iframe. Clamping host-side (reusing the exported limit) guarantees
 * the length invariant holds, so an oversized answer degrades to a truncated-but-rendered
 * block rather than a blank 120px frame. The result length is ≤ the limit (the guard accepts
 * `length ≤ limit`). Pure and total.
 */
export function truncateMarkdown(md: string, limit = MAX_SANDBOX_MARKDOWN_LENGTH): string {
  if (md.length <= limit) return md;
  const keep = Math.max(0, limit - TRUNCATION_MARKER.length);
  return md.slice(0, keep) + TRUNCATION_MARKER;
}

/**
 * Compose the Ring 3 render doc for an assistant message (Story 5.6), or `null` when the
 * message is not chart-bearing. A doc is produced ONLY when BOTH hold:
 *  - the message's query run produced ROWS (`entry.outcome.kind === "rows"`) — the chart
 *    needs real result data, and its channels are validated against THAT data's columns;
 *  - the answer `text` carries a valid ` ```chart ` spec (`extractChartFence` yields a raw
 *    spec that `parseChartSpec` accepts against the run's column names).
 * The doc's `markdown` is the prose with the chart fence stripped (and length-clamped, P3);
 * `chart` is the validated spec; `data` is the run's canonical {@link FrozenData}. Pure and
 * total — a missing fence, malformed JSON, unknown mark, or a channel naming an absent column
 * all yield `null`.
 *
 * P7: a `rows` outcome with ZERO rows still renders the prose but drops the chart
 * (`chart: null`) — Plot must never be handed an empty/degenerate dataset.
 */
export function buildChartDoc(text: string, entry: ChatRunEntry): SandboxRenderDoc | null {
  const outcome = entry.outcome;
  if (outcome === null || outcome.kind !== "rows") return null;
  const { markdown, rawChart } = extractChartFence(text);
  if (rawChart === null) return null;
  const columnNames = outcome.data.columns.map((c) => c.name);
  const chart = parseChartSpec(rawChart, columnNames);
  if (chart === null) return null;
  // Zero-row result → render prose only; a chart over an empty dataset is degenerate (P7).
  const finalChart = outcome.data.rows.length === 0 ? null : chart;
  return { markdown: truncateMarkdown(markdown), chart: finalChart, data: outcome.data };
}

/**
 * Decide how one message's PLAIN bubble renders (Story 5.6, P1). For a chart-bearing
 * assistant message (its text carries a ` ```chart ` fence) the bubble shows the fence-
 * STRIPPED prose — never the raw ```chart``` JSON — and is SUPPRESSED entirely once the
 * sandbox is mounted (`chartDoc !== null`), so the rich block renders the prose (+ chart)
 * exactly once instead of duplicating it. Net: before the query runs, the stripped prose
 * shows as plain text; after it runs, the sandbox owns the prose+chart and the plain bubble
 * is hidden. Non-chart / user messages are unchanged (`m.text`, always shown). Pure and total.
 */
export function decideMessageView(
  message: ChatMessage,
  chartDoc: SandboxRenderDoc | null,
): { readonly bubbleText: string; readonly showBubble: boolean } {
  if (message.role !== "assistant") {
    return { bubbleText: message.text, showBubble: true };
  }
  // Show the fence-STRIPPED prose whenever a well-formed ```chart``` fence was present —
  // `extractChartFence` returns `markdown === message.text` only when NO fence matched, so
  // using `markdown` directly is correct in every case. Keying the bubble on the parsed
  // spec (`rawChart !== null`) instead would leak the RAW ```chart``` block for a fence whose
  // JSON is malformed (parse fails → rawChart null) — exactly the "invalid chart" edge the
  // I/O matrix says must render Markdown only, never the raw JSON (P1).
  const { markdown } = extractChartFence(message.text);
  return { bubbleText: markdown, showBubble: chartDoc === null };
}

/** A memo entry pairing a composed doc with the (text, run-entry) inputs it was built from. */
type ChartDocCacheEntry = {
  readonly text: string;
  readonly entry: ChatRunEntry;
  readonly doc: SandboxRenderDoc | null;
};

/**
 * Reconcile per-message chart docs against a previous cache, REUSING a prior doc's object
 * identity when the message text AND its run entry are both unchanged (Story 5.6, P2).
 * `buildChartDoc` returns a fresh object literal every call, so recomposing on every render
 * (e.g. each keystroke in the prompt box) would hand `SandboxFrame` a new `doc` identity and
 * refire its `useEffect([doc])` — re-posting the frame and re-running micromark + Plot. Keying
 * on `(text, entry)` keeps identity stable across unrelated re-renders, so the guest is only
 * re-pushed when a message's text or its query outcome actually changes. Pure over its inputs.
 */
export function reconcileChartDocs(
  prev: ReadonlyMap<number, ChartDocCacheEntry>,
  messages: ReadonlyArray<ChatMessage>,
  entryFor: (i: number) => ChatRunEntry,
): Map<number, ChartDocCacheEntry> {
  const next = new Map<number, ChartDocCacheEntry>();
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    const entry = entryFor(i);
    const cached = prev.get(i);
    // Same text + same run-entry identity → reuse the exact prior doc object (stable identity).
    if (cached !== undefined && cached.text === m.text && cached.entry === entry) {
      next.set(i, cached);
      return;
    }
    next.set(i, { text: m.text, entry, doc: buildChartDoc(m.text, entry) });
  });
  return next;
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

/**
 * The model's REASONING channel, rendered VISUALLY DISTINCT from the final answer
 * (Story 5.4, UX-DR3): a muted/secondary `<details>` (smaller italic mono on the
 * `--muted` surface) vs the answer's primary `--foreground`. Only rendered when
 * reasoning is present — an empty channel never shows. `live` keeps it open while the
 * model is still thinking. Honors `prefers-reduced-motion` (no animation used here).
 */
function ReasoningBlock({ text, live }: { text: string; live?: boolean }): React.JSX.Element {
  return (
    <details
      open={live}
      className="max-w-[85%] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-3 py-1.5"
    >
      <summary className="cursor-pointer font-mono text-[11px] lowercase text-[var(--muted-foreground)]">
        reasoning{live ? " · thinking…" : ""}
      </summary>
      <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] italic text-[var(--muted-foreground)]">
        {text}
      </p>
    </details>
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
  // The transient streaming partial (Story 5.4): the answer + reasoning accumulated so
  // far for the IN-FLIGHT response, or `null` when nothing is streaming. Session-only,
  // like `ChatRunEntry` — never lifted into `state`/`onStateChange`, never persisted.
  const [partial, setPartial] = useState<StreamPartial | null>(null);
  // The latest accumulated partial, held in a ref so rapid deltas coalesce: each delta
  // updates the ref synchronously and schedules ONE `requestAnimationFrame` flush into
  // `setPartial` (not one setState per token) — NFR-6, no main-thread thrash.
  const partialRef = useRef<StreamPartial>(EMPTY_PARTIAL);
  const frameRef = useRef<number | null>(null);
  // Aborts the in-flight `fetch` when the Tab unmounts (or a stream is superseded).
  const abortRef = useRef<AbortController | null>(null);

  // Mounted guard: a send can resolve after this Tab is closed/switched away. Without
  // this, `onStateChange` would re-insert the closed Tab's (already-reclaimed) state.
  const mounted = useRef(true);
  useEffect(() => {
    return () => {
      mounted.current = false;
      // Abort the in-flight stream and cancel any pending flush — no post-unmount
      // fetch, no post-unmount state push.
      abortRef.current?.abort();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);
  // Synchronous re-entrancy guard: `busy` only lands after a re-render, so two
  // synchronous fires (double-click / key-repeat) could both pass a `busy === false`
  // check. This ref flips immediately, so a send can never fire twice (mirrors
  // QueryTabView's `firing`).
  const firing = useRef(false);

  // Coalesced flush: record the newest partial, then flush it to render on the next
  // animation frame (at most one pending frame). Deltas arriving in the same frame are
  // collapsed into a single re-render.
  const schedulePartial = (next: StreamPartial): void => {
    partialRef.current = next;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (mounted.current) setPartial(partialRef.current);
    });
  };

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
    // Start the live streaming bubble empty; each delta coalesces into it via rAF.
    partialRef.current = EMPTY_PARTIAL;
    setPartial(EMPTY_PARTIAL);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const outcome = await streamSend(provider, message, schedulePartial, streamChat, {
        signal: controller.signal,
      });
      // Tab closed/switched mid-flight — drop the result so we never resurrect the
      // reclaimed Tab's state.
      if (!mounted.current) return;
      // Cancel any pending flush: the transient bubble is about to be committed/cleared.
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (outcome.kind === "answer") {
        onStateChange(
          appendAnswer(afterUser, outcome.answer, outcome.context, outcome.query, outcome.reasoning),
        );
      } else {
        setError(outcome.message);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) {
        setBusy(false);
        firing.current = false;
        setPartial(null);
        abortRef.current = null;
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

  // Per-message guest render errors surfaced via `SandboxFrame`'s `onError` (Story 5.6, P3):
  // a guest failure is never swallowed — it is logged and shown as a small inline note.
  const [sandboxErrors, setSandboxErrors] = useState<Readonly<Record<number, string>>>({});

  // Memoized per-message chart docs (Story 5.6, P2): recomposed ONLY when the message list or
  // a run outcome changes — NOT on unrelated re-renders (e.g. each keystroke in the prompt
  // box). Keeping each doc's object identity stable stops `SandboxFrame`'s `useEffect([doc])`
  // from refiring — no per-keystroke re-post / micromark + Plot rebuild. The prior cache is
  // held in a ref so `reconcileChartDocs` can reuse unchanged docs' identities across renders.
  const chartDocCacheRef = useRef<Map<number, ChartDocCacheEntry>>(new Map());
  const chartDocs = useMemo(() => {
    const next = reconcileChartDocs(chartDocCacheRef.current, state.messages, (i) => runs[i] ?? IDLE_RUN);
    chartDocCacheRef.current = next;
    return next;
    // `runs`/`state.messages` are the only inputs; `input` (keystrokes) is deliberately absent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.messages, runs]);

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
        {state.messages.length === 0 && partial === null ? (
          <div
            className="flex h-full items-center justify-center lowercase text-[var(--muted-foreground)]"
            style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
          >
            ask a question about your schema
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {state.messages.map((m, i) => {
              // A chart-bearing assistant message whose run produced rows composes a Ring 3
              // render doc (memoized for stable identity, P2); everything else keeps the
              // plain-text bubble (chartDoc === null).
              const chartDoc = m.role === "assistant" ? chartDocs.get(i)?.doc ?? null : null;
              // The plain bubble shows fence-STRIPPED prose (never raw ```chart``` JSON) and is
              // suppressed once the sandbox renders the rich block — no duplicated prose (P1).
              const { bubbleText, showBubble } = decideMessageView(m, chartDoc);
              return (
              <li
                key={i}
                className={`flex flex-col gap-1 ${m.role === "user" ? "items-end" : "items-start"}`}
              >
                {m.role === "assistant" && m.reasoning !== null ? (
                  <ReasoningBlock text={m.reasoning} />
                ) : null}
                {showBubble ? (
                  <div
                    className={`max-w-[85%] rounded-[var(--radius)] border px-3 py-2 font-mono text-xs ${
                      m.role === "user"
                        ? "border-[var(--coral-line)] bg-[var(--coral-soft)] text-[var(--foreground)]"
                        : "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]"
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{bubbleText}</p>
                  </div>
                ) : null}
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
                    {/* Story 5.6: a validated chart spec + query rows renders rich Markdown +
                        an Observable Plot chart inside the Ring 3 sandbox iframe, beside the
                        query run. Sized to its content via the guest's `height` signal. */}
                    {chartDoc !== null ? (
                      <div className="w-full max-w-[85%]">
                        <SandboxFrame
                          doc={chartDoc}
                          onError={(message) => {
                            // Never swallow a guest render error (P3): log it + show an inline note.
                            console.error(`sandbox render error (message ${i}): ${message}`);
                            setSandboxErrors((e) => ({ ...e, [i]: message }));
                          }}
                        />
                      </div>
                    ) : null}
                    {sandboxErrors[i] !== undefined ? (
                      <p role="alert" className="font-mono text-[11px] lowercase text-amber-400">
                        chart render failed: {sandboxErrors[i]}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </li>
              );
            })}
            {/* Live streaming bubble (Story 5.4): the in-flight reasoning + incremental
                answer, coalesced per animation frame. Committed to a real message on
                `done`; cleared on completion/error/unmount. */}
            {partial !== null ? (
              <li className="flex flex-col items-start gap-1">
                {partial.reasoning.length > 0 ? (
                  <ReasoningBlock text={partial.reasoning} live />
                ) : null}
                <div className="max-w-[85%] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-3 py-2 font-mono text-xs text-[var(--foreground)]">
                  <p className="whitespace-pre-wrap break-words">
                    {partial.text.length > 0 ? partial.text : "…"}
                  </p>
                </div>
              </li>
            ) : null}
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
