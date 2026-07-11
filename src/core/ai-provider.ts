/**
 * quick-studio Core — unified AI layer (Story 5.1, AR-17 seam).
 *
 * The ONE place a configured provider kind + its user-supplied API key become a
 * Vercel AI SDK model handle. Every provider access in the app funnels through
 * `resolveModel`, so the `@ai-sdk/*` / `ai` imports live in Ring 1 ONLY (they must
 * never appear under `src/ui/`).
 *
 * This layer is deliberately INERT here: `resolveModel` only CONSTRUCTS a model
 * handle — it makes NO network call, no live key validation. Invoking the returned
 * handle (chat / NL→query / streaming) is Story 5.2+.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ProviderKind } from "../shared/contract.ts";

/**
 * The default model each provider resolves to. Story 5.1 only needs a valid handle;
 * model selection per chat is a later story — these are the sane current defaults.
 */
const DEFAULT_MODEL_ID: Record<ProviderKind, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
};

/**
 * The outcome of {@link resolveModel}: a constructed model handle, or a typed
 * failure for an unknown provider kind. Total — never throws.
 */
export type ResolveModelResult =
  | { readonly ok: true; readonly model: LanguageModel }
  | { readonly ok: false; readonly code: "unknown_provider"; readonly detail: string };

/**
 * Map a {@link ProviderKind} + its API key to a Vercel AI SDK model handle. Pure
 * construction only: no network call, no key validation — a malformed key surfaces
 * later, when the handle is actually invoked (Story 5.2+). An unrecognized kind
 * (only reachable via an unchecked cast) returns a typed `unknown_provider` result.
 */
export function resolveModel(provider: ProviderKind, apiKey: string): ResolveModelResult {
  switch (provider) {
    case "anthropic":
      return { ok: true, model: createAnthropic({ apiKey })(DEFAULT_MODEL_ID.anthropic) };
    case "openai":
      return { ok: true, model: createOpenAI({ apiKey })(DEFAULT_MODEL_ID.openai) };
    case "google":
      return { ok: true, model: createGoogle({ apiKey })(DEFAULT_MODEL_ID.google) };
    default: {
      const _exhaustive: never = provider;
      return { ok: false, code: "unknown_provider", detail: `provider=${String(_exhaustive)}` };
    }
  }
}
