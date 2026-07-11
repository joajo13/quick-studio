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

import type { ChatContextSummary, ProviderKind } from "../../shared/contract.ts";

/** One entry in the message log. An assistant answer carries its schema-only context. */
export type ChatMessage =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly text: string; readonly context: ChatContextSummary };

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

/** Append an assistant answer (with its schema-only context) to the log. */
export function appendAnswer(
  state: ChatState,
  text: string,
  context: ChatContextSummary,
): ChatState {
  return { ...state, messages: [...state.messages, { role: "assistant", text, context }] };
}
