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
  resolveDefaultProvider,
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

  test("appendAnswer appends the assistant entry with its context, null query/reasoning/report", () => {
    const s0 = appendUserMessage(setProvider(emptyChatState(), "anthropic"), "hi");
    const s1 = appendAnswer(s0, "there are 3 tables", CONTEXT, null, null, null);
    expect(s1.messages).toHaveLength(2);
    expect(s1.messages[1]).toEqual({
      role: "assistant",
      text: "there are 3 tables",
      query: null,
      reasoning: null,
      report: null,
      context: CONTEXT,
    });
    // Prior state untouched.
    expect(s0.messages).toHaveLength(1);
  });

  test("appendAnswer carries a non-null extracted query and reasoning", () => {
    const s0 = appendUserMessage(setProvider(emptyChatState(), "anthropic"), "how many customers?");
    const s1 = appendAnswer(s0, "run this:", CONTEXT, "SELECT count(*) FROM customers;", "let me think", null);
    expect(s1.messages[1]).toEqual({
      role: "assistant",
      text: "run this:",
      query: "SELECT count(*) FROM customers;",
      reasoning: "let me think",
      report: null,
      context: CONTEXT,
    });
  });

  test("appendAnswer carries a non-null Core-validated report", () => {
    const report = { blocks: [{ kind: "query" as const, sql: "SELECT 1" }] };
    const s0 = appendUserMessage(setProvider(emptyChatState(), "anthropic"), "make a report");
    const s1 = appendAnswer(s0, "here is your report", CONTEXT, null, null, report);
    expect(s1.messages[1]).toEqual({
      role: "assistant",
      text: "here is your report",
      query: null,
      reasoning: null,
      report,
      context: CONTEXT,
    });
  });
});

describe("resolveDefaultProvider (Story 8.5 — default provider resolution)", () => {
  test("exactly one connected, no last-used -> auto-selects that provider", () => {
    expect(resolveDefaultProvider(["anthropic"], null)).toBe("anthropic");
  });

  test("persisted last-used still connected -> takes precedence over the first/single", () => {
    expect(resolveDefaultProvider(["anthropic", "openai", "google"], "openai")).toBe("openai");
    // Even against a single connected provider, a connected last-used still wins.
    expect(resolveDefaultProvider(["openai"], "openai")).toBe("openai");
  });

  test("stale last-used (not connected) -> falls through to the single/first connected", () => {
    // openai persisted but no longer connected -> sole connected anthropic.
    expect(resolveDefaultProvider(["anthropic"], "openai")).toBe("anthropic");
    // openai persisted but not connected -> FIRST connected in stable order.
    expect(resolveDefaultProvider(["anthropic", "google"], "openai")).toBe("anthropic");
  });

  test("multiple connected, no valid last-used -> FIRST connected in stable order", () => {
    expect(resolveDefaultProvider(["anthropic", "openai"], null)).toBe("anthropic");
    expect(resolveDefaultProvider(["openai", "google"], null)).toBe("openai");
  });

  test("no providers connected -> null (no auto-select)", () => {
    expect(resolveDefaultProvider([], null)).toBeNull();
    expect(resolveDefaultProvider([], "openai")).toBeNull();
  });
});

describe("accumulateStream", () => {
  const done: ChatStreamChunk = { type: "done", query: null, report: null, context: CONTEXT };

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

  // DW-35 fallout: a MySQL `COUNT(*)`/`SUM(...)` is a LONGLONG, which the adapter now
  // decodes as an exact digit STRING in a column typed `bigint`. Gated on the raw
  // `type` this card would silently vanish on MySQL and degrade to a bare row count.
  test("a string-encoded bigint scalar (MySQL COUNT(*)) still surfaces as a KPI", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "count", type: "string", dataType: "bigint" }],
      rows: [[{ kind: "string", value: "1284" }]],
    };
    expect(deriveResultKpis(data)).toEqual([
      { label: "count", value: "1,284", kind: "count" },
      { label: "rows", value: "1", kind: "count" },
    ]);
  });

  test("a string-encoded numeric SUM surfaces as a money KPI", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "revenue", type: "string", dataType: "numeric" }],
      rows: [[{ kind: "string", value: "4218.40" }]],
    };
    expect(deriveResultKpis(data)).toEqual([
      { label: "revenue", value: "4,218.4", kind: "money" },
      { label: "rows", value: "1", kind: "count" },
    ]);
  });

  test("an unparseable / empty string in a numeric column degrades to the row count", () => {
    const withValue = (value: string): FrozenData => ({
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "n", type: "string", dataType: "bigint" }],
      rows: [[{ kind: "string", value }]],
    });
    for (const bad of ["", "   ", "not a number"]) {
      expect(deriveResultKpis(withValue(bad))).toEqual([{ label: "rows", value: "1", kind: "count" }]);
    }
  });

  // DW-35 proper: `Number("9007199254740993")` is `9007199254740992`. Routing an exact
  // digit-string through a JS double to format it renders a MySQL `SUM(amount_cents)`
  // above 2^53 with the WRONG digits — precisely the loss this story exists to prevent.
  // An integer-shaped string is therefore grouped from its CHARACTERS.
  test("a wide-integer scalar is grouped EXACTLY, never via Number()", () => {
    const wide = (value: string): FrozenData => ({
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "total", type: "string", dataType: "bigint" }],
      rows: [[{ kind: "string", value }]],
    });
    expect(deriveResultKpis(wide("9007199254740993"))[0]).toEqual({
      label: "total",
      value: "9,007,199,254,740,993",
      kind: "count",
    });
    // The lossy path would have produced `…992`; assert the difference explicitly.
    expect(String(Number("9007199254740993"))).toBe("9007199254740992");
    // Far beyond a double's integer range, where `Number()` also goes exponential.
    expect(deriveResultKpis(wide("123456789012345678901234567890"))[0]?.value).toBe(
      "123,456,789,012,345,678,901,234,567,890",
    );
    // Sign and leading-zero normalization matches what `Intl` does for small values.
    expect(deriveResultKpis(wide("-1234567"))[0]?.value).toBe("-1,234,567");
    expect(deriveResultKpis(wide("+7"))[0]?.value).toBe("7");
    expect(deriveResultKpis(wide("007"))[0]?.value).toBe("7");
    expect(deriveResultKpis(wide("-0"))[0]?.value).toBe("0");
  });

  test("the exact grouping agrees with Intl for every double-representable integer", () => {
    for (const n of [0, 7, 42, 1284, 1000000, 987654321, Number.MAX_SAFE_INTEGER, -1284]) {
      const data: FrozenData = {
        schemaVersion: FROZEN_SCHEMA_VERSION,
        columns: [{ name: "n", type: "string", dataType: "bigint" }],
        rows: [[{ kind: "string", value: String(n) }]],
      };
      expect(deriveResultKpis(data)[0]?.value).toBe(new Intl.NumberFormat("en-US").format(n));
    }
  });

  test("a FRACTIONAL string scalar still goes through the numeric path (money card)", () => {
    // Only the integer shape gets the character-exact treatment; a decimal keeps the
    // existing at-most-two-fractional-digits formatting and its `money` classification.
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "revenue", type: "string", dataType: "numeric" }],
      rows: [[{ kind: "string", value: "1234.567" }]],
    };
    expect(deriveResultKpis(data)[0]).toEqual({ label: "revenue", value: "1,234.57", kind: "money" });
  });

  test("a plain TEXT string scalar is still NOT a KPI (no dataType, no gate)", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "name", type: "string" }],
      rows: [[{ kind: "string", value: "1284" }]],
    };
    expect(deriveResultKpis(data)).toEqual([{ label: "rows", value: "1", kind: "count" }]);
  });
});
