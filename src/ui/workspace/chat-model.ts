/**
 * quick-studio UI (Ring 2) — Chat view-model (pure, dependency-free).
 *
 * The message-log + picked-provider state for a chat Tab, kept OUT of React so it is
 * unit-testable with no DOM and no RPC harness (mirrors `providers-model.ts`). It
 * holds only rendered text — no api key, no row data ever reaches this ring. The
 * whole state is session-only (lifted to `App`, keyed by tab id) and is NEVER written
 * to the workspace snapshot.
 *
 * Everything is pure and total: reducers return new state; `validateSend` is a total
 * classifier. No I/O, no React, no `window`.
 */

import type { ChatContextSummary, ChatStreamChunk, ProviderKind } from "../../shared/contract.ts";

/**
 * One entry in the message log. An assistant answer carries its schema-only
 * context plus the Core-extracted `query` (Story 5.3) — the SQL statement the
 * model emitted in a fenced block, or `null` when the answer was prose-only. The
 * UI never derives `query` itself (AR-3); it is whatever Core's `extractQuery`
 * returned, rendered read-only with a run action.
 *
 * `reasoning` (Story 5.4) is the model's accumulated thinking channel — rendered in a
 * visually distinct secondary treatment, or `null` when the provider emitted none (an
 * empty channel is never an error). It is session-only, never persisted to disk.
 */
export type ChatMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly query: string | null;
      readonly reasoning: string | null;
      readonly context: ChatContextSummary;
    };

/** The chat Tab's session state. Immutable — reducers return new values. */
export type ChatState = {
  readonly messages: ReadonlyArray<ChatMessage>;
  /** The provider the user picked to ask (null until one is chosen). */
  readonly provider: ProviderKind | null;
};

/** The initial empty chat state (no messages, no provider picked). */
export function emptyChatState(): ChatState {
  return { messages: [], provider: null };
}

/** The outcome of {@link validateSend}: ok, or a terse reason the send is blocked. */
export type SendValidation =
  | { readonly ok: true; readonly provider: ProviderKind; readonly message: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate a send attempt against the current state + typed message. A provider must
 * be picked and the message non-blank (trimmed) — the same gate the Core enforces,
 * surfaced UI-side so no doomed request is issued. Terse lowercase reasons.
 */
export function validateSend(state: ChatState, message: string): SendValidation {
  if (state.provider === null) {
    return { ok: false, reason: "pick a provider" };
  }
  if (message.trim().length === 0) {
    return { ok: false, reason: "message required" };
  }
  return { ok: true, provider: state.provider, message };
}

/* ------------------------------------------------------------------ *
 * Reducers — all pure & total
 * ------------------------------------------------------------------ */

/** Pick (or clear) the provider to ask. */
export function setProvider(state: ChatState, provider: ProviderKind | null): ChatState {
  return { ...state, provider };
}

/** Append a user message to the log. */
export function appendUserMessage(state: ChatState, text: string): ChatState {
  return { ...state, messages: [...state.messages, { role: "user", text }] };
}

/**
 * Append an assistant answer (with its extracted `query`, its streamed `reasoning`,
 * and the schema-only context) to the log. `reasoning` is `null` when the provider
 * emitted no thinking channel.
 */
export function appendAnswer(
  state: ChatState,
  text: string,
  context: ChatContextSummary,
  query: string | null,
  reasoning: string | null,
): ChatState {
  return {
    ...state,
    messages: [...state.messages, { role: "assistant", text, query, reasoning, context }],
  };
}

/**
 * The transient streaming partial (Story 5.4): the answer + reasoning accumulated so
 * far. Held session-only in component-local state (never lifted/persisted); flushed
 * into the rendered bubble on `requestAnimationFrame`.
 */
export type StreamPartial = {
  readonly text: string;
  readonly reasoning: string;
};

/** The empty partial — both channels blank (the start of a stream). */
export const EMPTY_PARTIAL: StreamPartial = { text: "", reasoning: "" };

/**
 * Pure delta-accumulation for the streaming partial: route a `text-delta` to the
 * ANSWER channel and a `reasoning-delta` to the REASONING channel; any terminal
 * (`done`/`error`) chunk leaves the partial unchanged (the component handles those).
 * Total & DOM-free so it is unit-tested with no jsdom.
 */
export function accumulateStream(partial: StreamPartial, chunk: ChatStreamChunk): StreamPartial {
  switch (chunk.type) {
    case "text-delta":
      return { ...partial, text: partial.text + chunk.text };
    case "reasoning-delta":
      return { ...partial, reasoning: partial.reasoning + chunk.text };
    default:
      return partial;
  }
}
