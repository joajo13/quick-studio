/**
 * quick-studio UI (Ring 2) — SSE chat-stream reader tests (Story 5.4).
 *
 * DOM-free, no jsdom: `streamChat` takes an injectable `fetchImpl` seam, so the whole
 * matrix is exercised with a stub `fetch` returning a `ReadableStream` body — SSE
 * frame parsing → ordered `onChunk` sequence, a terminal `error` frame, a malformed
 * frame → synthetic error, a non-OK response → synthetic error, a network throw →
 * synthetic error, and an abort → silent (no post-abort chunk).
 */

import { describe, expect, test } from "bun:test";
import type { ChatStreamChunk } from "../../shared/contract.ts";
import { streamChat } from "./rpc-stream.ts";

/** A stub `fetch` returning a 200 SSE stream whose body emits `frames` (raw strings). */
function sseFetch(frames: string[], init?: { ok?: boolean; status?: number }): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    return new Response(stream, { status: init?.status ?? 200 });
  }) as unknown as typeof fetch;
}

/** Encode a chunk as one well-formed SSE frame. */
function frame(chunk: ChatStreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** A stub `fetch` returning a 200 SSE stream whose body emits raw byte chunks verbatim. */
function byteFetch(chunks: Uint8Array[]): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("streamChat", () => {
  test("parses SSE frames into an ordered onChunk sequence, done terminates", async () => {
    const got: ChatStreamChunk[] = [];
    const fetchImpl = sseFetch([
      frame({ type: "reasoning-delta", text: "think" }),
      frame({ type: "text-delta", text: "hi" }),
      frame({ type: "done", query: null, report: null, context: { policy: "schema-only", tables: 1, rowsIncluded: 0 } }),
      // Anything after `done` must never be delivered.
      frame({ type: "text-delta", text: "LATE" }),
    ]);
    await streamChat("anthropic", "q", (c) => got.push(c), { fetchImpl });
    expect(got).toEqual([
      { type: "reasoning-delta", text: "think" },
      { type: "text-delta", text: "hi" },
      { type: "done", query: null, report: null, context: { policy: "schema-only", tables: 1, rowsIncluded: 0 } },
    ]);
  });

  test("frames split across read boundaries are reassembled", async () => {
    const got: ChatStreamChunk[] = [];
    // A single logical frame delivered in two byte chunks.
    const full = frame({ type: "text-delta", text: "hello world" });
    const mid = Math.floor(full.length / 2);
    const fetchImpl = sseFetch([full.slice(0, mid), full.slice(mid)]);
    await streamChat("anthropic", "q", (c) => got.push(c), { fetchImpl });
    expect(got).toEqual([{ type: "text-delta", text: "hello world" }]);
  });

  test("a terminal error frame is delivered and ends the read", async () => {
    const got: ChatStreamChunk[] = [];
    const fetchImpl = sseFetch([
      frame({ type: "text-delta", text: "partial" }),
      frame({ type: "error", code: "internal_error", message: "provider call failed" }),
      frame({ type: "text-delta", text: "LATE" }),
    ]);
    await streamChat("anthropic", "q", (c) => got.push(c), { fetchImpl });
    expect(got).toEqual([
      { type: "text-delta", text: "partial" },
      { type: "error", code: "internal_error", message: "provider call failed" },
    ]);
  });

  test("an empty / whitespace-only data: keep-alive frame is skipped (no chunk, no error)", async () => {
    const got: ChatStreamChunk[] = [];
    const fetchImpl = sseFetch([
      "data: \n\n", // SSE keep-alive: empty payload — JSON.parse("") must NOT be reached
      frame({ type: "text-delta", text: "hi" }),
      "data:   \n\n", // whitespace-only payload — also a keep-alive, not a chunk
      frame({ type: "done", query: null, report: null, context: { policy: "schema-only", tables: 1, rowsIncluded: 0 } }),
    ]);
    await streamChat("anthropic", "q", (c) => got.push(c), { fetchImpl });
    expect(got).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "done", query: null, report: null, context: { policy: "schema-only", tables: 1, rowsIncluded: 0 } },
    ]);
  });

  test("flushes the decoder and parses a final frame sent without a trailing \\n\\n", async () => {
    const got: ChatStreamChunk[] = [];
    const enc = new TextEncoder();
    // A final frame with NO trailing "\n\n" (server closed right after it). The multi-
    // byte 'é' is split across two reads (its first byte is held back by the streaming
    // decode), so this also exercises the no-arg flush recovering a trailing char.
    const bytes = enc.encode(`data: ${JSON.stringify({ type: "text-delta", text: "café" })}`);
    const idx = bytes.indexOf(0xc3); // first byte of 'é'
    const fetchImpl = byteFetch([bytes.slice(0, idx + 1), bytes.slice(idx + 1)]);
    await streamChat("anthropic", "q", (c) => got.push(c), { fetchImpl });
    expect(got).toEqual([{ type: "text-delta", text: "café" }]);
  });

  test("a malformed data frame yields a synthetic error chunk", async () => {
    const got: ChatStreamChunk[] = [];
    const fetchImpl = sseFetch(["data: {not json\n\n"]);
    await streamChat("anthropic", "q", (c) => got.push(c), { fetchImpl });
    expect(got).toHaveLength(1);
    expect(got[0]?.type).toBe("error");
    if (got[0]?.type === "error") expect(got[0].message).toContain("malformed");
  });

  test("a non-OK response yields a synthetic error chunk", async () => {
    const got: ChatStreamChunk[] = [];
    const fetchImpl = sseFetch([], { status: 403 });
    await streamChat("anthropic", "q", (c) => got.push(c), { fetchImpl });
    expect(got).toHaveLength(1);
    expect(got[0]?.type).toBe("error");
    if (got[0]?.type === "error") expect(got[0].message).toContain("403");
  });

  test("a network throw yields a synthetic error chunk", async () => {
    const got: ChatStreamChunk[] = [];
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await streamChat("anthropic", "q", (c) => got.push(c), { fetchImpl });
    expect(got).toHaveLength(1);
    expect(got[0]?.type).toBe("error");
    if (got[0]?.type === "error") expect(got[0].message).toContain("network down");
  });

  test("an abort during fetch is silent (no chunk delivered)", async () => {
    const got: ChatStreamChunk[] = [];
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("");
    }) as unknown as typeof fetch;
    await streamChat("anthropic", "q", (c) => got.push(c), {
      fetchImpl,
      signal: controller.signal,
    });
    expect(got).toEqual([]);
  });
});
