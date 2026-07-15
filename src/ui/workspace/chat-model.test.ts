/**
 * quick-studio UI (Ring 2) — Chat view-model tests (pure, no React/DOM).
 *
 * Covers `validateSend` (no provider / blank message rejected), and every reducer
 * transition (setProvider / appendUserMessage / appendAnswer) plus their immutability.
 */

import { describe, expect, test } from "bun:test";
import {
  FROZEN_SCHEMA_VERSION,
  type ChatContextSummary,
  type ChatStreamChunk,
  type FrozenData,
} from "../../shared/contract.ts";
import {
  accumulateStream,
  appendAnswer,
  appendUserMessage,
  deriveResultKpis,
  EMPTY_PARTIAL,
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

  test("appendAnswer appends the assistant entry with its context, null query and reasoning", () => {
    const s0 = appendUserMessage(setProvider(emptyChatState(), "anthropic"), "hi");
    const s1 = appendAnswer(s0, "there are 3 tables", CONTEXT, null, null);
    expect(s1.messages).toHaveLength(2);
    expect(s1.messages[1]).toEqual({
      role: "assistant",
      text: "there are 3 tables",
      query: null,
      reasoning: null,
      context: CONTEXT,
    });
    // Prior state untouched.
    expect(s0.messages).toHaveLength(1);
  });

  test("appendAnswer carries a non-null extracted query and reasoning", () => {
    const s0 = appendUserMessage(setProvider(emptyChatState(), "anthropic"), "how many customers?");
    const s1 = appendAnswer(s0, "run this:", CONTEXT, "SELECT count(*) FROM customers;", "let me think");
    expect(s1.messages[1]).toEqual({
      role: "assistant",
      text: "run this:",
      query: "SELECT count(*) FROM customers;",
      reasoning: "let me think",
      context: CONTEXT,
    });
  });
});

describe("accumulateStream", () => {
  const done: ChatStreamChunk = { type: "done", query: null, context: CONTEXT };

  test("text-delta appends to the answer channel only", () => {
    let p = EMPTY_PARTIAL;
    p = accumulateStream(p, { type: "text-delta", text: "there " });
    p = accumulateStream(p, { type: "text-delta", text: "are 3" });
    expect(p).toEqual({ text: "there are 3", reasoning: "" });
  });

  test("reasoning-delta appends to the reasoning channel only", () => {
    let p = EMPTY_PARTIAL;
    p = accumulateStream(p, { type: "reasoning-delta", text: "let me " });
    p = accumulateStream(p, { type: "reasoning-delta", text: "think" });
    expect(p).toEqual({ text: "", reasoning: "let me think" });
  });

  test("interleaved deltas route to their own channels", () => {
    let p = EMPTY_PARTIAL;
    p = accumulateStream(p, { type: "reasoning-delta", text: "hmm " });
    p = accumulateStream(p, { type: "text-delta", text: "answer " });
    p = accumulateStream(p, { type: "reasoning-delta", text: "done" });
    p = accumulateStream(p, { type: "text-delta", text: "here" });
    expect(p).toEqual({ text: "answer here", reasoning: "hmm done" });
  });

  test("a terminal chunk leaves the partial unchanged and does not mutate", () => {
    const p0 = accumulateStream(EMPTY_PARTIAL, { type: "text-delta", text: "x" });
    const p1 = accumulateStream(p0, done);
    expect(p1).toEqual({ text: "x", reasoning: "" });
    expect(EMPTY_PARTIAL).toEqual({ text: "", reasoning: "" });
  });
});

describe("deriveResultKpis (Story 7.5 KPI strip — real data only)", () => {
  const numberScalar = (value: number, name = "count"): FrozenData => ({
    schemaVersion: FROZEN_SCHEMA_VERSION,
    columns: [{ name, type: "number" }],
    rows: [[{ kind: "number", value }]],
  });

  test("always surfaces the row count as a count KPI", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [
        { name: "product", type: "string" },
        { name: "units", type: "number" },
      ],
      rows: [
        [{ kind: "string", value: "a" }, { kind: "number", value: 3 }],
        [{ kind: "string", value: "b" }, { kind: "number", value: 5 }],
      ],
    };
    // Multi-column result degrades to JUST the row-count KPI.
    expect(deriveResultKpis(data)).toEqual([{ label: "rows", value: "2", kind: "count" }]);
  });

  test("a single 1×1 INTEGER scalar surfaces as a count KPI (+ row count), grouped", () => {
    expect(deriveResultKpis(numberScalar(1284))).toEqual([
      { label: "count", value: "1,284", kind: "count" },
      { label: "rows", value: "1", kind: "count" },
    ]);
  });

  test("a single 1×1 DECIMAL scalar surfaces as a money KPI (+ row count), grouped", () => {
    expect(deriveResultKpis(numberScalar(4218.4, "revenue"))).toEqual([
      { label: "revenue", value: "4,218.4", kind: "money" },
      { label: "rows", value: "1", kind: "count" },
    ]);
  });

  test("a float-artifact scalar is formatted for humans, not raw IEEE-754", () => {
    expect(deriveResultKpis(numberScalar(0.1 + 0.2, "ratio"))).toEqual([
      { label: "ratio", value: "0.3", kind: "money" },
      { label: "rows", value: "1", kind: "count" },
    ]);
  });

  test("a negative decimal scalar still surfaces (grouped, money)", () => {
    expect(deriveResultKpis(numberScalar(-1234.5, "delta"))).toEqual([
      { label: "delta", value: "-1,234.5", kind: "money" },
      { label: "rows", value: "1", kind: "count" },
    ]);
  });

  test("a non-finite scalar (NaN/Infinity) is NOT surfaced — degrades to row count", () => {
    expect(deriveResultKpis(numberScalar(Number.NaN))).toEqual([
      { label: "rows", value: "1", kind: "count" },
    ]);
    expect(deriveResultKpis(numberScalar(Number.POSITIVE_INFINITY))).toEqual([
      { label: "rows", value: "1", kind: "count" },
    ]);
  });

  test("a single 1×1 NON-numeric scalar degrades to just the row count", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "name", type: "string" }],
      rows: [[{ kind: "string", value: "hello" }]],
    };
    expect(deriveResultKpis(data)).toEqual([{ label: "rows", value: "1", kind: "count" }]);
  });

  test("multiple rows of a single numeric column degrade to just the row count", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "id", type: "number" }],
      rows: [[{ kind: "number", value: 1 }], [{ kind: "number", value: 2 }]],
    };
    expect(deriveResultKpis(data)).toEqual([{ label: "rows", value: "2", kind: "count" }]);
  });

  test("a zero-row result still surfaces a row-count KPI of 0", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "id", type: "number" }],
      rows: [],
    };
    expect(deriveResultKpis(data)).toEqual([{ label: "rows", value: "0", kind: "count" }]);
  });
});
