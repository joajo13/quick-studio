/**
 * quick-studio UI (Ring 2) — ChatTabView tests (Story 5.2).
 *
 * Following the repo convention (no jsdom/testing-library): the `chat.ask`
 * ROUND-TRIP logic lives in the exported, DOM-free `sendChat` (mock the `rpc` client
 * via `bun:test`'s `mock.module`, call it directly) and every send outcome is
 * exercised there; a couple of `renderToStaticMarkup` checks cover the static
 * structure (the always-visible "schema-only" indicator, the empty-state prompt, and
 * a rendered assistant badge) observable without a live DOM.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  errorReply,
  okReply,
  type ChatAskResult,
  type RpcReply,
} from "../../shared/contract.ts";
import { appendAnswer, appendUserMessage, emptyChatState, setProvider } from "./chat-model.ts";

// Mock the RPC client BEFORE the module under test is imported — `sendChat` calls
// `rpc` from this module; the whole point is to observe what it sends with no Core.
const rpcMock = mock(
  async (_method: string, _params?: unknown): Promise<RpcReply<unknown>> =>
    errorReply("internal_error", "unset"),
);
mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }));

const { sendChat, ChatTabView } = await import("./ChatTabView.tsx");

beforeEach(() => {
  rpcMock.mockClear();
});

describe("sendChat", () => {
  test("happy path -> answer outcome with schema-only context", async () => {
    const result: ChatAskResult = {
      answer: "there are 2 tables",
      context: { policy: "schema-only", tables: 2, rowsIncluded: 0 },
    };
    rpcMock.mockImplementation(async () => okReply(result) as RpcReply<unknown>);
    const outcome = await sendChat("anthropic", "how many tables?");
    expect(outcome.kind).toBe("answer");
    if (outcome.kind === "answer") {
      expect(outcome.answer).toBe("there are 2 tables");
      expect(outcome.context.rowsIncluded).toBe(0);
      expect(outcome.context.tables).toBe(2);
    }
    // The UI sends exactly the provider + message; it never sends a key.
    expect(rpcMock).toHaveBeenCalledWith("chat.ask", {
      provider: "anthropic",
      message: "how many tables?",
    });
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
    state = appendAnswer(state, "there are 3 tables", {
      policy: "schema-only",
      tables: 3,
      rowsIncluded: 0,
    });
    const html = renderToStaticMarkup(<ChatTabView state={state} onStateChange={() => {}} />);
    expect(html).toContain("there are 3 tables");
    expect(html).toContain("schema-only · 3 tables");
  });
});
