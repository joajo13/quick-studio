/**
 * quick-studio UI (Ring 2) — Chat view-model tests (pure, no React/DOM).
 *
 * Covers `validateSend` (no provider / blank message rejected), and every reducer
 * transition (setProvider / appendUserMessage / appendAnswer) plus their immutability.
 */

import { describe, expect, test } from "bun:test";
import type { ChatContextSummary } from "../../shared/contract.ts";
import {
  appendAnswer,
  appendUserMessage,
  emptyChatState,
  setProvider,
  validateSend,
} from "./chat-model.ts";

const CONTEXT: ChatContextSummary = { policy: "schema-only", tables: 3, rowsIncluded: 0 };

describe("validateSend", () => {
  test("no provider picked -> blocked", () => {
    const r = validateSend(emptyChatState(), "hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("pick a provider");
  });

  test("blank message -> blocked", () => {
    const state = setProvider(emptyChatState(), "anthropic");
    for (const msg of ["", "   "]) {
      const r = validateSend(state, msg);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("message required");
    }
  });

  test("provider + non-blank message -> ok, carries both", () => {
    const state = setProvider(emptyChatState(), "openai");
    const r = validateSend(state, "how many rows?");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe("openai");
      expect(r.message).toBe("how many rows?");
    }
  });
});

describe("reducers", () => {
  test("setProvider sets and clears without mutating", () => {
    const s0 = emptyChatState();
    const s1 = setProvider(s0, "google");
    expect(s1.provider).toBe("google");
    expect(s0.provider).toBeNull();
    expect(setProvider(s1, null).provider).toBeNull();
  });

  test("appendUserMessage appends immutably", () => {
    const s0 = setProvider(emptyChatState(), "anthropic");
    const s1 = appendUserMessage(s0, "hi");
    expect(s1.messages).toEqual([{ role: "user", text: "hi" }]);
    expect(s0.messages).toEqual([]);
    expect(s1.provider).toBe("anthropic");
  });

  test("appendAnswer appends the assistant entry with its context", () => {
    const s0 = appendUserMessage(setProvider(emptyChatState(), "anthropic"), "hi");
    const s1 = appendAnswer(s0, "there are 3 tables", CONTEXT);
    expect(s1.messages).toHaveLength(2);
    expect(s1.messages[1]).toEqual({
      role: "assistant",
      text: "there are 3 tables",
      context: CONTEXT,
    });
    // Prior state untouched.
    expect(s0.messages).toHaveLength(1);
  });
});
