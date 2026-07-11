/**
 * Covers the unified AI layer (Story 5.1, AR-17): `resolveModel` CONSTRUCTS a model
 * handle for each known provider kind (no network call — pure construction) and
 * returns a typed failure for an unknown kind. Invoking the handle is Story 5.2+; here
 * we only assert a handle is produced.
 */

import { describe, expect, test } from "bun:test";
import {
  REASONING_BUDGET_TOKENS,
  REASONING_MAX_OUTPUT_TOKENS,
  reasoningProviderOptions,
  resolveModel,
} from "./ai-provider.ts";
import { PROVIDER_KINDS } from "../shared/contract.ts";

describe("ai-provider — resolveModel", () => {
  test("constructs a handle for every known provider kind (no network)", () => {
    for (const provider of PROVIDER_KINDS) {
      const r = resolveModel(provider, "sk-test-key");
      expect(r.ok).toBe(true);
      if (r.ok) {
        // A model handle was constructed (a non-null object/string reference).
        expect(r.model).toBeDefined();
      }
    }
  });

  test("distinct kinds produce distinct model handles", () => {
    const a = resolveModel("anthropic", "k");
    const o = resolveModel("openai", "k");
    expect(a.ok && o.ok).toBe(true);
    if (a.ok && o.ok) expect(a.model).not.toBe(o.model);
  });

  test("unknown provider -> typed failure, never a throw", () => {
    const r = resolveModel("bogus" as never, "k");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_provider");
  });
});

describe("ai-provider — reasoningProviderOptions", () => {
  test("anthropic enables thinking AND carries the output ceiling (> the budget)", () => {
    expect(reasoningProviderOptions("anthropic")).toEqual({
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budgetTokens: REASONING_BUDGET_TOKENS } },
      },
      maxOutputTokens: REASONING_MAX_OUTPUT_TOKENS,
    });
    // The anthropic constraint: maxOutputTokens must exceed the thinking budget.
    expect(REASONING_MAX_OUTPUT_TOKENS).toBeGreaterThan(REASONING_BUDGET_TOKENS);
  });

  test("google enables includeThoughts AND carries the output ceiling", () => {
    expect(reasoningProviderOptions("google")).toEqual({
      providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
      maxOutputTokens: REASONING_MAX_OUTPUT_TOKENS,
    });
  });

  test("openai emits NO reasoning options AND NO maxOutputTokens cap (never capped)", () => {
    const opts = reasoningProviderOptions("openai");
    expect(opts).toEqual({});
    // The regression guard: gpt-4o must not receive a silent output ceiling.
    expect(opts.maxOutputTokens).toBeUndefined();
    expect(opts.providerOptions).toBeUndefined();
  });
});
