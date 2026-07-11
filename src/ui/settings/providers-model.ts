/**
 * quick-studio UI (Ring 2) — AI providers view-model (pure, dependency-free).
 *
 * The set/replace/remove-key logic for the AI-providers Settings section, kept OUT
 * of React so it is unit-testable with no DOM and no RPC harness (mirrors
 * `connections-model.ts`). It holds only secret-free {@link ProviderSummary} values
 * — the api key a user types lives transiently in a {@link Draft} and is NEVER
 * retained here (the trust boundary: keys travel UI→Core on submit only).
 *
 * Everything is pure and total: the reducers return new state; `validateDraft` is a
 * total classifier. No I/O, no React, no `window`.
 */

import type { ProviderKind, ProviderSummary } from "../../shared/contract.ts";

/** The configured-providers state the panel renders. Immutable — reducers return new values. */
export type ProvidersState = {
  readonly providers: ReadonlyArray<ProviderSummary>;
};

/** An empty list — the initial state before `providers.list` resolves. */
export function emptyProviders(): ProvidersState {
  return { providers: [] };
}

/**
 * A transient set-key draft. `apiKey` carries the secret while typing and is sent to
 * Core on submit only; the model never stores it beyond the draft. `provider` is the
 * kind the key is being set for.
 */
export type Draft = {
  readonly provider: ProviderKind;
  readonly apiKey: string;
};

/** An empty draft for a given provider kind (blank key). */
export function emptyDraft(provider: ProviderKind): Draft {
  return { provider, apiKey: "" };
}

/** The outcome of {@link validateDraft}: ok, or the offending field + a terse message. */
export type DraftValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly field: "apiKey"; readonly message: string };

/**
 * Validate a draft. The api key is required (non-empty once trimmed) — a blank key is
 * never a usable secret and is rejected UI-side consistently with the Core registry.
 * Terse lowercase message.
 */
export function validateDraft(draft: Draft): DraftValidation {
  if (draft.apiKey.trim().length === 0) {
    return { ok: false, field: "apiKey", message: "api key required" };
  }
  return { ok: true };
}

/**
 * Look up the summary for a provider kind, or `undefined` when it is not configured.
 * The panel uses this to overlay "not configured" for the statically-known kinds.
 */
export function summaryFor(
  state: ProvidersState,
  provider: ProviderKind,
): ProviderSummary | undefined {
  return state.providers.find((p) => p.provider === provider);
}

/* ------------------------------------------------------------------ *
 * Reducers — load / set / remove, all pure & total
 * ------------------------------------------------------------------ */

/** Replace the whole list (from a `providers.list` reply). */
export function loadProviders(
  _state: ProvidersState,
  providers: ReadonlyArray<ProviderSummary>,
): ProvidersState {
  return { providers: [...providers] };
}

/**
 * Upsert a summary by provider kind (from a `providers.set` reply): replace in place
 * when the kind is already configured (preserving order), else append. Identity is
 * the kind — there is at most one summary per provider.
 */
export function applySet(
  state: ProvidersState,
  summary: ProviderSummary,
): ProvidersState {
  const exists = state.providers.some((p) => p.provider === summary.provider);
  return {
    providers: exists
      ? state.providers.map((p) => (p.provider === summary.provider ? summary : p))
      : [...state.providers, summary],
  };
}

/** Drop a summary by provider kind (from a successful `providers.remove`). */
export function applyRemoved(
  state: ProvidersState,
  provider: ProviderKind,
): ProvidersState {
  return { providers: state.providers.filter((p) => p.provider !== provider) };
}
