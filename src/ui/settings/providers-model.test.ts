/**
 * quick-studio UI (Ring 2) — AI providers view-model tests (pure, no React/DOM).
 *
 * Covers `validateDraft` (blank key rejected), `summaryFor`, and every reducer
 * transition (load / set-upsert / remove) plus their immutability and no-op edges.
 */

import { describe, expect, test } from "bun:test";
import type { ProviderKind, ProviderSummary } from "../../shared/contract.ts";
import {
  applyRemoved,
  applySet,
  emptyDraft,
  emptyProviders,
  loadProviders,
  summaryFor,
  validateDraft,
} from "./providers-model.ts";

const summary = (provider: ProviderKind, keyPreview = "…abcd"): ProviderSummary => ({
  provider,
  keyPreview,
});

describe("validateDraft", () => {
  test("blank / whitespace key -> apiKey error", () => {
    for (const apiKey of ["", "   "]) {
      const r = validateDraft({ provider: "anthropic", apiKey });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.field).toBe("apiKey");
    }
  });

  test("a non-blank key -> ok", () => {
    expect(validateDraft({ provider: "openai", apiKey: "sk-123" }).ok).toBe(true);
  });

  test("emptyDraft is blank for the given kind", () => {
    expect(emptyDraft("google")).toEqual({ provider: "google", apiKey: "" });
  });
});

describe("summaryFor", () => {
  test("finds a configured kind, undefined for an unset one", () => {
    const state = loadProviders(emptyProviders(), [summary("anthropic")]);
    expect(summaryFor(state, "anthropic")?.provider).toBe("anthropic");
    expect(summaryFor(state, "openai")).toBeUndefined();
  });
});

describe("reducers", () => {
  test("emptyProviders is empty", () => {
    expect(emptyProviders().providers).toEqual([]);
  });

  test("loadProviders replaces the whole list (and copies it)", () => {
    const input = [summary("anthropic"), summary("openai")];
    const next = loadProviders(emptyProviders(), input);
    expect(next.providers).toHaveLength(2);
    expect(next.providers).not.toBe(input); // defensive copy
  });

  test("applySet appends a new kind without mutating prior state", () => {
    const prev = loadProviders(emptyProviders(), [summary("anthropic")]);
    const next = applySet(prev, summary("openai"));
    expect(next.providers.map((p) => p.provider)).toEqual(["anthropic", "openai"]);
    expect(prev.providers).toHaveLength(1); // immutable
  });

  test("applySet replaces in place by kind (upsert), keeping order", () => {
    const prev = loadProviders(emptyProviders(), [
      summary("anthropic", "…1111"),
      summary("openai", "…2222"),
    ]);
    const next = applySet(prev, summary("anthropic", "…9999"));
    expect(next.providers.map((p) => p.provider)).toEqual(["anthropic", "openai"]);
    expect(summaryFor(next, "anthropic")?.keyPreview).toBe("…9999");
  });

  test("applyRemoved drops the matching kind", () => {
    const prev = loadProviders(emptyProviders(), [summary("anthropic"), summary("openai")]);
    const next = applyRemoved(prev, "anthropic");
    expect(next.providers.map((p) => p.provider)).toEqual(["openai"]);
  });

  test("applyRemoved for an absent kind leaves the list unchanged", () => {
    const prev = loadProviders(emptyProviders(), [summary("anthropic")]);
    const next = applyRemoved(prev, "google");
    expect(next.providers.map((p) => p.provider)).toEqual(["anthropic"]);
  });
});
