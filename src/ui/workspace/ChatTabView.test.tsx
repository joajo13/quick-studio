/**
 * quick-studio UI (Ring 2) — ChatTabView tests (Story 5.2, extended in Story 5.3).
 *
 * Following the repo convention (no jsdom/testing-library): the `chat.ask`
 * ROUND-TRIP logic lives in the exported, DOM-free `sendChat` (mock the `rpc` client
 * via `bun:test`'s `mock.module`, call it directly) and every send outcome is
 * exercised there; the Story 5.3 run/confirm/cancel/error paths live in the
 * exported, DOM-free `runChatQuery`/`confirmChatQuery`/`cancelChatQuery` (each
 * takes an injectable `run` stub standing in for `runRawQuery` — no rpc/DOM
 * needed) and are exercised there; a couple of `renderToStaticMarkup` checks cover
 * the static structure (the always-visible "schema-only" indicator, the
 * empty-state prompt, a rendered assistant badge, and the generated-SQL block).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  errorReply,
  FROZEN_SCHEMA_VERSION,
  okReply,
  type ChatAskResult,
  type FrozenData,
  type RpcReply,
} from "../../shared/contract.ts";
import { appendAnswer, appendUserMessage, emptyChatState, setProvider } from "./chat-model.ts";
import type { ChatRunEntry } from "./ChatTabView.tsx";
import type { RunOutcome } from "./run-raw-query.ts";

// Mock the RPC client BEFORE the module under test is imported — `sendChat` calls
// `rpc` from this module; the whole point is to observe what it sends with no Core.
const rpcMock = mock(
  async (_method: string, _params?: unknown): Promise<RpcReply<unknown>> =>
    errorReply("internal_error", "unset"),
);
mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }));

const {
  sendChat,
  ChatTabView,
  IDLE_RUN,
  runChatQuery,
  confirmChatQuery,
  cancelChatQuery,
} = await import("./ChatTabView.tsx");

beforeEach(() => {
  rpcMock.mockClear();
});

describe("sendChat", () => {
  test("happy path with a generated query -> answer outcome carries it", async () => {
    const result: ChatAskResult = {
      answer: "run this:\n```sql\nSELECT count(*) FROM t;\n```",
      query: "SELECT count(*) FROM t;",
      context: { policy: "schema-only", tables: 2, rowsIncluded: 0 },
    };
    rpcMock.mockImplementation(async () => okReply(result) as RpcReply<unknown>);
    const outcome = await sendChat("anthropic", "how many rows in t?");
    expect(outcome.kind).toBe("answer");
    if (outcome.kind === "answer") {
      expect(outcome.answer).toBe(result.answer);
      expect(outcome.query).toBe("SELECT count(*) FROM t;");
      expect(outcome.context.rowsIncluded).toBe(0);
      expect(outcome.context.tables).toBe(2);
    }
    // The UI sends exactly the provider + message; it never sends a key.
    expect(rpcMock).toHaveBeenCalledWith("chat.ask", {
      provider: "anthropic",
      message: "how many rows in t?",
    });
  });

  test("prose-only answer -> query: null, no run action", async () => {
    const result: ChatAskResult = {
      answer: "there are 2 tables",
      query: null,
      context: { policy: "schema-only", tables: 2, rowsIncluded: 0 },
    };
    rpcMock.mockImplementation(async () => okReply(result) as RpcReply<unknown>);
    const outcome = await sendChat("anthropic", "how many tables?");
    expect(outcome.kind).toBe("answer");
    if (outcome.kind === "answer") expect(outcome.query).toBeNull();
  });

  test("not-configured envelope -> error outcome via envelopeText", async () => {
    rpcMock.mockImplementation(
      async () => errorReply("not_found", "provider not configured") as RpcReply<unknown>,
    );
    const outcome = await sendChat("openai", "hi");
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("not_found");
      expect(outcome.message).toContain("provider not configured");
    }
  });

  test("internal_error envelope -> error outcome", async () => {
    rpcMock.mockImplementation(
      async () => errorReply("internal_error", "provider call failed") as RpcReply<unknown>,
    );
    const outcome = await sendChat("google", "hi");
    expect(outcome.kind).toBe("error");
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
    );
    const html = renderToStaticMarkup(<ChatTabView state={state} onStateChange={() => {}} />);
    expect(html).toContain("there are 3 tables");
    expect(html).toContain("schema-only · 3 tables");
    // Prose-only answer: no query block, no run action.
    expect(html).not.toContain(">run<");
  });

  test("an assistant answer with a query renders the SQL read-only + a run action", () => {
    let state = setProvider(emptyChatState(), "anthropic");
    state = appendUserMessage(state, "how many customers?");
    state = appendAnswer(
      state,
      "run this:",
      { policy: "schema-only", tables: 2, rowsIncluded: 0 },
      "SELECT count(*) FROM customers;",
    );
    const html = renderToStaticMarkup(<ChatTabView state={state} onStateChange={() => {}} />);
    expect(html).toContain("SELECT count(*) FROM customers;");
    expect(html).toContain(">run<");
  });
});
