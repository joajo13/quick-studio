/**
 * quick-studio UI (Ring 2) — ChatTabView tests (Story 5.2/5.3; streamed in Story 5.4).
 *
 * Following the repo convention (no jsdom/testing-library): the stream-driven send
 * logic lives in the exported, DOM-free `streamSend` (fed a STUB `streamChat`, called
 * directly) and every partial/terminal outcome is exercised there; the Story 5.3
 * run/confirm/cancel/error paths live in the exported, DOM-free
 * `runChatQuery`/`confirmChatQuery`/`cancelChatQuery` (each takes an injectable `run`
 * stub) and are exercised there; a few `renderToStaticMarkup` checks cover the static
 * structure (the "schema-only" indicator, the empty-state prompt, a rendered assistant
 * badge + reasoning block, and the generated-SQL block).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  errorReply,
  FROZEN_SCHEMA_VERSION,
  MAX_SANDBOX_MARKDOWN_LENGTH,
  type ChatStreamChunk,
  type FrozenData,
  type ProviderKind,
  type RpcReply,
  type SandboxRenderDoc,
} from "../../shared/contract.ts";
import type { ChatMessage, StreamPartial } from "./chat-model.ts";
import { appendAnswer, appendUserMessage, emptyChatState, setProvider } from "./chat-model.ts";
import type { streamChat } from "../rpc/rpc-stream.ts";
import type { ChatRunEntry } from "./ChatTabView.tsx";
import type { RunOutcome } from "./run-raw-query.ts";

// Mock the RPC client BEFORE the module under test is imported — `ChatTabView` calls
// `rpc` (providers.list) on mount; the stub keeps the import inert for these tests.
const rpcMock = mock(
  async (_method: string, _params?: unknown): Promise<RpcReply<unknown>> =>
    errorReply("internal_error", "unset"),
);
mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }));

const {
  streamSend,
  ChatTabView,
  IDLE_RUN,
  runChatQuery,
  confirmChatQuery,
  cancelChatQuery,
  buildChartDoc,
  truncateMarkdown,
  reconcileChartDocs,
  decideMessageView,
} = await import("./ChatTabView.tsx");

beforeEach(() => {
  rpcMock.mockClear();
});

/** A stub `streamChat` that emits `chunks` in order (records what it was sent). */
function stubStream(chunks: ChatStreamChunk[]): {
  fn: typeof streamChat;
  sent: () => { provider: ProviderKind; message: string } | null;
} {
  let sent: { provider: ProviderKind; message: string } | null = null;
  const fn: typeof streamChat = async (provider, message, onChunk) => {
    sent = { provider, message };
    for (const c of chunks) onChunk(c);
  };
  return { fn, sent: () => sent };
}

describe("streamSend", () => {
  test("streams reasoning + answer deltas, then commits a done outcome carrying the query", async () => {
    const partials: StreamPartial[] = [];
    const { fn, sent } = stubStream([
      { type: "reasoning-delta", text: "let me think" },
      { type: "text-delta", text: "run:\n```sql\n" },
      { type: "text-delta", text: "SELECT 1;\n```" },
      {
        type: "done",
        query: "SELECT 1;",
        context: { policy: "schema-only", tables: 2, rowsIncluded: 0 },
      },
    ]);
    const outcome = await streamSend("anthropic", "how many?", (p) => partials.push(p), fn);
    // Incremental partials arrived (reasoning routed separately from the answer).
    expect(partials.at(0)).toEqual({ text: "", reasoning: "let me think" });
    expect(partials.at(-1)).toEqual({ text: "run:\n```sql\nSELECT 1;\n```", reasoning: "let me think" });
    // Terminal outcome carries the accumulated text, reasoning, and Core's query.
    expect(outcome.kind).toBe("answer");
    if (outcome.kind === "answer") {
      expect(outcome.answer).toBe("run:\n```sql\nSELECT 1;\n```");
      expect(outcome.reasoning).toBe("let me think");
      expect(outcome.query).toBe("SELECT 1;");
      expect(outcome.context.tables).toBe(2);
    }
    // The UI sends exactly provider + message; it never sends a key.
    expect(sent()).toEqual({ provider: "anthropic", message: "how many?" });
  });

  test("answer-only stream (no reasoning) -> reasoning outcome is null", async () => {
    const { fn } = stubStream([
      { type: "text-delta", text: "there are 2 tables" },
      { type: "done", query: null, context: { policy: "schema-only", tables: 2, rowsIncluded: 0 } },
    ]);
    const outcome = await streamSend("openai", "how many tables?", () => {}, fn);
    expect(outcome.kind).toBe("answer");
    if (outcome.kind === "answer") {
      expect(outcome.reasoning).toBeNull();
      expect(outcome.query).toBeNull();
    }
  });

  test("an error chunk -> error outcome (mapped via envelopeText, feeds the banner)", async () => {
    const { fn } = stubStream([{ type: "error", code: "not_found", message: "provider not configured" }]);
    const outcome = await streamSend("openai", "hi", () => {}, fn);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("not_found");
      expect(outcome.message).toContain("provider not configured");
    }
  });

  test("a stream that ends with no terminal frame -> neutral error outcome", async () => {
    const { fn } = stubStream([{ type: "text-delta", text: "partial" }]);
    const outcome = await streamSend("google", "hi", () => {}, fn);
    expect(outcome.kind).toBe("error");
  });

  test("done with an empty/whitespace answer AND no reasoning -> error (no blank bubble)", async () => {
    const { fn } = stubStream([
      { type: "text-delta", text: "   " }, // only whitespace streamed
      { type: "done", query: null, context: { policy: "schema-only", tables: 2, rowsIncluded: 0 } },
    ]);
    const outcome = await streamSend("openai", "hi", () => {}, fn);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).toContain("empty response");
  });

  test("done with an empty answer but WITH reasoning still commits (reasoning is informative)", async () => {
    const { fn } = stubStream([
      { type: "reasoning-delta", text: "thinking about it" },
      { type: "done", query: null, context: { policy: "schema-only", tables: 2, rowsIncluded: 0 } },
    ]);
    const outcome = await streamSend("anthropic", "hi", () => {}, fn);
    expect(outcome.kind).toBe("answer");
    if (outcome.kind === "answer") {
      expect(outcome.answer).toBe("");
      expect(outcome.reasoning).toBe("thinking about it");
    }
  });
});

/** A minimal one-column `FrozenData` with `n` numeric rows (1..n). */
function makeData(n: number): FrozenData {
  return {
    schemaVersion: FROZEN_SCHEMA_VERSION,
    columns: [{ name: "id", type: "number" }],
    rows: Array.from({ length: n }, (_, i) => [{ kind: "number", value: i + 1 }]),
  };
}

describe("runChatQuery / confirmChatQuery / cancelChatQuery — I/O Matrix", () => {
  test("Run a read query: rows land in the entry, sent verbatim with no `confirmed` key", async () => {
    const data = makeData(3);
    const run = mock(async (_sql: string, _confirmed?: boolean): Promise<RunOutcome> => ({
      kind: "rows",
      data,
      truncated: false,
    }));
    const next = await runChatQuery(IDLE_RUN, "select * from t", run);
    expect(next).toEqual({ pendingSql: "select * from t", busy: false, outcome: { kind: "rows", data, truncated: false }, selectedRow: null });
    expect(run.mock.calls.length).toBe(1);
    expect(run.mock.calls[0]).toEqual(["select * from t", undefined]);
  });

  test("Run a destructive query: confirmation_required lands in the entry, nothing else runs", async () => {
    const sql = "DELETE FROM t WHERE id = 1";
    const run = mock(async (): Promise<RunOutcome> => ({ kind: "confirm", sql, risk: "deletes 1 row" }));
    const next = await runChatQuery(IDLE_RUN, sql, run);
    expect(next.outcome).toEqual({ kind: "confirm", sql, risk: "deletes 1 row" });
    expect(next.pendingSql).toBe(sql);
  });

  test("Confirm: re-issues the FROZEN pendingSql with confirmed:true (not a re-derived string)", async () => {
    const sql = "DELETE FROM t WHERE id = 1";
    const pending: ChatRunEntry = {
      pendingSql: sql,
      busy: false,
      outcome: { kind: "confirm", sql, risk: "deletes 1 row" },
      selectedRow: null,
    };
    const run = mock(async (_sql: string, _confirmed?: boolean): Promise<RunOutcome> => ({
      kind: "ok",
      rowsAffected: 1,
    }));
    const next = await confirmChatQuery(pending, run);
    expect(next.outcome).toEqual({ kind: "ok", rowsAffected: 1 });
    expect(run.mock.calls.length).toBe(1);
    expect(run.mock.calls[0]).toEqual([sql, true]);
  });

  test("Cancel: clears the pending confirm outcome, calls no run function", () => {
    const pending: ChatRunEntry = {
      pendingSql: "DROP TABLE t",
      busy: false,
      outcome: { kind: "confirm", sql: "DROP TABLE t", risk: "drops the table" },
      selectedRow: null,
    };
    const next = cancelChatQuery(pending);
    expect(next.outcome).toBeNull();
    expect(next.pendingSql).toBe("DROP TABLE t");
  });

  test("Multi-statement / engine error: a thrown or error-outcome run maps to an error entry", async () => {
    const run = mock(async (): Promise<RunOutcome> => ({
      kind: "error",
      message: "bad_request: multiple statements are not allowed",
    }));
    const next = await runChatQuery(IDLE_RUN, "SELECT 1; DROP TABLE t", run);
    expect(next.outcome).toEqual({
      kind: "error",
      message: "bad_request: multiple statements are not allowed",
    });
  });

  test("A thrown run function maps to the same error-entry shape (no unhandled rejection)", async () => {
    const run = mock(async (): Promise<RunOutcome> => {
      throw new Error("network down");
    });
    const next = await runChatQuery(IDLE_RUN, "select 1", run);
    expect(next.outcome).toEqual({ kind: "error", message: "network down" });
  });

  test("Re-entrancy: runChatQuery is a no-op while the entry is already busy", async () => {
    const busyEntry = { ...IDLE_RUN, busy: true };
    const run = mock(async (): Promise<RunOutcome> => ({ kind: "ok", rowsAffected: 1 }));
    const next = await runChatQuery(busyEntry, "select 1", run);
    expect(next).toBe(busyEntry);
    expect(run.mock.calls.length).toBe(0);
  });

  test("Re-entrancy: runChatQuery is a no-op while a confirm is already pending on this entry", async () => {
    const pendingEntry = {
      pendingSql: "DROP TABLE t",
      busy: false,
      outcome: { kind: "confirm" as const, sql: "DROP TABLE t", risk: "drops the table" },
      selectedRow: null,
    };
    const run = mock(async (): Promise<RunOutcome> => ({ kind: "ok", rowsAffected: 1 }));
    const next = await runChatQuery(pendingEntry, "DROP TABLE t", run);
    expect(next).toBe(pendingEntry);
    expect(run.mock.calls.length).toBe(0);
  });

  test("Re-entrancy: confirmChatQuery is a no-op while already busy", async () => {
    const busyEntry = { ...IDLE_RUN, busy: true, pendingSql: "DROP TABLE t" };
    const run = mock(async (): Promise<RunOutcome> => ({ kind: "ok", rowsAffected: 1 }));
    const next = await confirmChatQuery(busyEntry, run);
    expect(next).toBe(busyEntry);
    expect(run.mock.calls.length).toBe(0);
  });

  test("Defense-in-depth: confirmChatQuery never fires confirmed:true unless a confirm is pending", async () => {
    const run = mock(async (): Promise<RunOutcome> => ({ kind: "ok", rowsAffected: 1 }));
    // outcome is null (no Core-gated confirmation) — must not re-issue a confirmed execute.
    const noConfirm = { ...IDLE_RUN, pendingSql: "DROP TABLE t", outcome: null };
    const next = await confirmChatQuery(noConfirm, run);
    expect(next).toBe(noConfirm);
    expect(run.mock.calls.length).toBe(0);
  });
});

/** A two-column FrozenData (month:string, revenue:number) with `n` rows. */
function makeChartData(n: number): FrozenData {
  return {
    schemaVersion: FROZEN_SCHEMA_VERSION,
    columns: [
      { name: "month", type: "string" },
      { name: "revenue", type: "number" },
    ],
    rows: Array.from({ length: n }, (_, i) => [
      { kind: "string", value: `m${i}` },
      { kind: "number", value: i * 10 },
    ]),
  };
}

const rowsEntry = (data: FrozenData): ChatRunEntry => ({
  pendingSql: "select month, revenue from t",
  busy: false,
  outcome: { kind: "rows", data, truncated: false },
  selectedRow: null,
});

describe("buildChartDoc (Story 5.6 chart-doc composition)", () => {
  const answer =
    "here is the trend:\n\n```chart\n{ \"mark\": \"line\", \"x\": \"month\", \"y\": \"revenue\", \"title\": \"revenue\" }\n```\n\n```sql\nSELECT month, revenue FROM t;\n```";

  test("composes a render doc when a valid chart spec AND query rows are present", () => {
    const data = makeChartData(3);
    const composed = buildChartDoc(answer, rowsEntry(data));
    expect(composed).not.toBeNull();
    expect(composed!.chart).toEqual({ mark: "line", x: "month", y: "revenue", title: "revenue" });
    expect(composed!.data).toEqual(data);
    // The chart fence is stripped from the prose (the sql fence + prose stay intact).
    expect(composed!.markdown).toContain("here is the trend");
    expect(composed!.markdown).not.toContain("```chart");
    expect(composed!.markdown).toContain("```sql");
  });

  test("returns null when the run produced no rows (nothing to chart yet)", () => {
    expect(buildChartDoc(answer, IDLE_RUN)).toBeNull();
    expect(buildChartDoc(answer, { ...IDLE_RUN, outcome: { kind: "ok", rowsAffected: 1 } })).toBeNull();
  });

  test("returns null when the answer has no chart fence (plain / chart-less message)", () => {
    expect(buildChartDoc("just prose, no chart here", rowsEntry(makeChartData(2)))).toBeNull();
  });

  test("returns null when a chart channel names a column absent from the run's data", () => {
    const bad = "```chart\n{ \"mark\": \"bar\", \"x\": \"month\", \"y\": \"nope\" }\n```";
    expect(buildChartDoc(bad, rowsEntry(makeChartData(2)))).toBeNull();
  });

  test("P7: a ZERO-row rows outcome renders prose but drops the chart (chart:null)", () => {
    const composed = buildChartDoc(answer, rowsEntry(makeChartData(0)));
    expect(composed).not.toBeNull();
    // Prose is still rendered, but Plot is never handed an empty dataset.
    expect(composed!.chart).toBeNull();
    expect(composed!.markdown).toContain("here is the trend");
    expect(composed!.data.rows).toHaveLength(0);
  });

  test("P3: the composed prose is length-clamped to MAX_SANDBOX_MARKDOWN_LENGTH (valid frame always sent)", () => {
    const huge = "x".repeat(30000);
    const bigAnswer = `${huge}\n\n\`\`\`chart\n{ "mark": "line", "x": "month", "y": "revenue" }\n\`\`\``;
    const composed = buildChartDoc(bigAnswer, rowsEntry(makeChartData(2)));
    expect(composed).not.toBeNull();
    // The guard drops markdown.length > MAX; clamping host-side keeps the frame valid.
    expect(composed!.markdown.length).toBeLessThanOrEqual(MAX_SANDBOX_MARKDOWN_LENGTH);
  });
});

describe("truncateMarkdown (Story 5.6, P3 boundary)", () => {
  test("passes short prose through unchanged", () => {
    expect(truncateMarkdown("hello", MAX_SANDBOX_MARKDOWN_LENGTH)).toBe("hello");
  });

  test("prose EXACTLY at the limit is unchanged (guard accepts length === limit)", () => {
    const atLimit = "a".repeat(MAX_SANDBOX_MARKDOWN_LENGTH);
    const out = truncateMarkdown(atLimit, MAX_SANDBOX_MARKDOWN_LENGTH);
    expect(out).toBe(atLimit);
    expect(out.length).toBe(MAX_SANDBOX_MARKDOWN_LENGTH);
  });

  test("prose ONE over the limit is clamped to ≤ limit with a trailing marker", () => {
    const over = "a".repeat(MAX_SANDBOX_MARKDOWN_LENGTH + 1);
    const out = truncateMarkdown(over, MAX_SANDBOX_MARKDOWN_LENGTH);
    expect(out.length).toBeLessThanOrEqual(MAX_SANDBOX_MARKDOWN_LENGTH);
    expect(out.endsWith("(truncated)")).toBe(true);
  });
});

describe("reconcileChartDocs (Story 5.6, P2 — stable doc identity)", () => {
  const chartAnswer =
    "trend:\n\n```chart\n{ \"mark\": \"line\", \"x\": \"month\", \"y\": \"revenue\" }\n```";
  const msg = (text: string): ChatMessage => ({
    role: "assistant",
    text,
    query: null,
    reasoning: null,
    context: { policy: "schema-only", tables: 1, rowsIncluded: 0 },
  });

  test("reuses a prior doc's OBJECT IDENTITY when text + run entry are unchanged", () => {
    const messages = [msg(chartAnswer)];
    const entry = rowsEntry(makeChartData(3));
    const entryFor = (): ChatRunEntry => entry;
    const first = reconcileChartDocs(new Map(), messages, entryFor);
    const second = reconcileChartDocs(first, messages, entryFor);
    // Same inputs → the exact same doc object (so SandboxFrame's useEffect([doc]) never refires).
    expect(second.get(0)!.doc).toBe(first.get(0)!.doc);
    expect(second.get(0)).toBe(first.get(0));
    expect(first.get(0)!.doc).not.toBeNull();
  });

  test("recomposes a FRESH doc when the run entry changes (new data → new identity)", () => {
    const messages = [msg(chartAnswer)];
    const first = reconcileChartDocs(new Map(), messages, () => rowsEntry(makeChartData(3)));
    const second = reconcileChartDocs(first, messages, () => rowsEntry(makeChartData(5)));
    expect(second.get(0)!.doc).not.toBe(first.get(0)!.doc);
  });

  test("skips non-assistant messages (no doc entry for a user message)", () => {
    const messages: ChatMessage[] = [{ role: "user", text: "hi" }];
    const out = reconcileChartDocs(new Map(), messages, () => IDLE_RUN);
    expect(out.has(0)).toBe(false);
  });
});

describe("decideMessageView (Story 5.6, P1 — no raw JSON, no duplicate prose)", () => {
  const chartAnswer =
    "here is the trend:\n\n```chart\n{ \"mark\": \"line\", \"x\": \"month\", \"y\": \"revenue\" }\n```\n\nthanks";
  const chartMsg: ChatMessage = {
    role: "assistant",
    text: chartAnswer,
    query: null,
    reasoning: null,
    context: { policy: "schema-only", tables: 1, rowsIncluded: 0 },
  };
  const composedDoc: SandboxRenderDoc = { markdown: "here is the trend:", chart: null, data: makeChartData(2) };

  test("before the run (chartDoc null): shows fence-STRIPPED prose, never the raw ```chart``` JSON", () => {
    const { bubbleText, showBubble } = decideMessageView(chartMsg, null);
    expect(showBubble).toBe(true);
    expect(bubbleText).toContain("here is the trend");
    expect(bubbleText).toContain("thanks");
    expect(bubbleText).not.toContain("```chart");
    expect(bubbleText).not.toContain("\"mark\"");
  });

  test("a MALFORMED ```chart``` spec (JSON parse fails) still strips the fence — never the raw JSON (P1)", () => {
    // A well-formed fence whose BODY is invalid JSON: the chart coerces to null, but the
    // fence must still be stripped from the bubble — the old code keyed on parse success and
    // leaked the raw ```chart``` block for exactly this "invalid chart" edge.
    const badJson: ChatMessage = { ...chartMsg, text: "trend below:\n\n```chart\n{ mark: line, }\n```\n\ndone" };
    const { bubbleText, showBubble } = decideMessageView(badJson, null);
    expect(showBubble).toBe(true);
    expect(bubbleText).toContain("trend below");
    expect(bubbleText).toContain("done");
    expect(bubbleText).not.toContain("```chart");
    expect(bubbleText).not.toContain("mark: line");
  });

  test("after the run (chartDoc mounted): the plain bubble is SUPPRESSED (no duplicate prose)", () => {
    const { showBubble } = decideMessageView(chartMsg, composedDoc);
    expect(showBubble).toBe(false);
  });

  test("a non-chart assistant message is unchanged (full text, bubble shown)", () => {
    const plain: ChatMessage = { ...chartMsg, text: "just a plain answer" };
    const { bubbleText, showBubble } = decideMessageView(plain, null);
    expect(bubbleText).toBe("just a plain answer");
    expect(showBubble).toBe(true);
  });
});

describe("static structure", () => {
  test("renders the always-visible schema-only indicator + empty prompt", () => {
    const html = renderToStaticMarkup(
      <ChatTabView state={emptyChatState()} onStateChange={() => {}} />,
    );
    expect(html).toContain("schema-only");
    expect(html).toContain("ask a question about your schema");
  });

  test("renders an assistant answer with its schema-only · N tables badge", () => {
    let state = setProvider(emptyChatState(), "anthropic");
    state = appendUserMessage(state, "how many tables?");
    state = appendAnswer(
      state,
      "there are 3 tables",
      { policy: "schema-only", tables: 3, rowsIncluded: 0 },
      null,
      null,
    );
    const html = renderToStaticMarkup(<ChatTabView state={state} onStateChange={() => {}} />);
    expect(html).toContain("there are 3 tables");
    expect(html).toContain("schema-only · 3 tables");
    // Prose-only answer: no query block, no run action.
    expect(html).not.toContain(">run<");
    // No reasoning present -> the reasoning channel is not rendered.
    expect(html).not.toContain("reasoning");
  });

  test("an assistant answer with reasoning renders a distinct reasoning block", () => {
    let state = setProvider(emptyChatState(), "anthropic");
    state = appendUserMessage(state, "how many tables?");
    state = appendAnswer(
      state,
      "there are 3 tables",
      { policy: "schema-only", tables: 3, rowsIncluded: 0 },
      null,
      "counting the tables in the schema",
    );
    const html = renderToStaticMarkup(<ChatTabView state={state} onStateChange={() => {}} />);
    expect(html).toContain("reasoning");
    expect(html).toContain("counting the tables in the schema");
  });

  test("a plain assistant answer mounts NO SandboxFrame (no iframe)", () => {
    let state = setProvider(emptyChatState(), "anthropic");
    state = appendUserMessage(state, "how many tables?");
    state = appendAnswer(
      state,
      "there are 3 tables",
      { policy: "schema-only", tables: 3, rowsIncluded: 0 },
      null,
      null,
    );
    const html = renderToStaticMarkup(<ChatTabView state={state} onStateChange={() => {}} />);
    // No chart spec + no run rows -> buildChartDoc is null -> no sandbox iframe mounted.
    expect(html).not.toContain("<iframe");
  });

  test("an assistant answer with a query renders the SQL read-only + a run action", () => {
    let state = setProvider(emptyChatState(), "anthropic");
    state = appendUserMessage(state, "how many customers?");
    state = appendAnswer(
      state,
      "run this:",
      { policy: "schema-only", tables: 2, rowsIncluded: 0 },
      "SELECT count(*) FROM customers;",
      null,
    );
    const html = renderToStaticMarkup(<ChatTabView state={state} onStateChange={() => {}} />);
    expect(html).toContain("SELECT count(*) FROM customers;");
    expect(html).toContain(">run<");
  });

  test("an assistant answer with a fenced code block renders <pre>/<code>, not literal backticks (Story 8.4)", () => {
    let state = setProvider(emptyChatState(), "anthropic");
    state = appendUserMessage(state, "show me some sql");
    state = appendAnswer(
      state,
      "here you go:\n\n```sql\nSELECT 1\n```",
      { policy: "schema-only", tables: 3, rowsIncluded: 0 },
      null,
      null,
    );
    const html = renderToStaticMarkup(<ChatTabView state={state} onStateChange={() => {}} />);
    // The fence is rendered as a styled code block, not shown as literal markdown.
    expect(html).toContain("<pre><code");
    expect(html).toContain("SELECT 1");
    expect(html).not.toContain("```");
  });

  test("an assistant answer with raw HTML is escaped at the chat mount, never mounted live (Story 8.4)", () => {
    let state = setProvider(emptyChatState(), "anthropic");
    state = appendUserMessage(state, "hi");
    state = appendAnswer(
      state,
      "<script>alert(1)</script> and <img src=x onerror=alert(2)>",
      { policy: "schema-only", tables: 3, rowsIncluded: 0 },
      null,
      null,
    );
    const html = renderToStaticMarkup(<ChatTabView state={state} onStateChange={() => {}} />);
    // micromark (allowDangerousHtml:false) escapes untrusted model HTML rather than emitting it:
    // it survives only as inert escaped text (`&lt;…&gt;`), never as a live <script>/<img> tag.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });
});
