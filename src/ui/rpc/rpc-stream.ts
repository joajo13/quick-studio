/**
 * quick-studio UI (Ring 2) — token-gated SSE reader for chat streaming (Story 5.4).
 *
 * The streaming counterpart to `rpc()`: a DOM-free, abortable reader over the Core's
 * `POST /chat/stream` SSE endpoint. The browser's native SSE client is unusable here
 * (GET-only, cannot set the `x-qs-token` header), so this uses `fetch` +
 * `res.body.getReader()` + `TextDecoder`, splits the byte stream into `\n\n`-delimited
 * SSE frames, strips the `data: ` prefix, `JSON.parse`s each into a
 * {@link ChatStreamChunk}, and invokes `onChunk`. A `done`/`error` chunk terminates
 * the read loop.
 *
 * Deliberately NO fixed timeout (a long reasoning stream is legitimate) — the caller
 * aborts via an {@link AbortSignal} instead. A network/HTTP/parse failure is turned
 * into a synthetic `error` chunk (never a throw), so the caller handles exactly one
 * shape. An abort is silent (no post-abort chunk). No `ai`/`@ai-sdk/*` import exists
 * in this ring; the UI never holds a key — the token gates the localhost channel.
 */

import type { ChatStreamChunk, ProviderKind } from "../../shared/contract.ts";

/** Options for {@link streamChat}. `fetchImpl` is the DI seam for unit tests. */
export type StreamChatOptions = {
  /** Abort the in-flight stream (fetch + reader). No chunk is emitted after abort. */
  readonly signal?: AbortSignal;
  /** Injectable `fetch` (defaults to the global) so the reader is unit-tested with a stub. */
  readonly fetchImpl?: typeof fetch;
};

/** A synthetic redacted `error` chunk for a transport/parse failure (never a throw). */
function errorChunk(message: string): ChatStreamChunk {
  return { type: "error", code: "internal_error", message };
}

/**
 * Parse one SSE frame body (its lines) into a {@link ChatStreamChunk}, or `null` when
 * the frame carried no `data:` payload (a keep-alive comment) OR an empty/whitespace-
 * only `data:` payload (an SSE keep-alive ping) — neither is a chunk, and an empty
 * payload must NOT reach `JSON.parse("")` (which would throw a spurious malformed-chunk
 * error). Throws only on a genuinely malformed JSON payload so the caller can map it to
 * a synthetic error chunk.
 */
function parseFrame(frame: string): ChatStreamChunk | null {
  const dataLines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  // Empty / whitespace-only data is a keep-alive, not a chunk — skip it.
  if (payload.trim().length === 0) return null;
  return JSON.parse(payload) as ChatStreamChunk;
}

/**
 * Open the token-gated chat SSE stream for `provider` + `message` and invoke `onChunk`
 * for each parsed {@link ChatStreamChunk} in order. Resolves when the stream ends
 * (`done`/`error` frame, EOF, or abort). Any network/HTTP/parse failure is delivered
 * as a single synthetic `error` chunk before resolving; an abort resolves silently.
 */
export async function streamChat(
  provider: ProviderKind,
  message: string,
  onChunk: (chunk: ChatStreamChunk) => void,
  opts: StreamChatOptions = {},
): Promise<void> {
  const token = (globalThis as { __QS_TOKEN__?: string }).__QS_TOKEN__ ?? "";
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch("/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json", "x-qs-token": token },
      body: JSON.stringify({ provider, message }),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) return;
    onChunk(errorChunk(err instanceof Error ? err.message : String(err)));
    return;
  }

  const body = res.body;
  if (!res.ok || body === null) {
    // Drain any error-response body so the connection/stream isn't left dangling.
    body?.cancel().catch(() => {});
    onChunk(errorChunk(`stream request failed (${res.status})`));
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Drain every complete `\n\n`-delimited frame currently in `buffer`, delivering each
  // parsed chunk in order. Returns `true` once a terminal (`done`/`error`) frame — or a
  // malformed frame — was delivered, signalling the caller to stop reading.
  const pump = (): boolean => {
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let chunk: ChatStreamChunk | null;
      try {
        chunk = parseFrame(frame);
      } catch {
        onChunk(errorChunk("malformed chunk from core"));
        return true;
      }
      if (chunk !== null) {
        onChunk(chunk);
        // A terminal frame ends the read: nothing more will follow.
        if (chunk.type === "done" || chunk.type === "error") return true;
      }
      sep = buffer.indexOf("\n\n");
    }
    return false;
  };

  try {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (pump()) return;
      }
      // EOF: flush the decoder once (no-arg) to recover a trailing multi-byte UTF-8
      // char the streaming decode held back, then parse any remaining complete frame —
      // including a final frame the server sent without a trailing `\n\n`.
      buffer += decoder.decode();
      if (pump()) return;
      if (buffer.trim().length > 0) {
        try {
          const chunk = parseFrame(buffer);
          if (chunk !== null) onChunk(chunk);
        } catch {
          onChunk(errorChunk("malformed chunk from core"));
        }
      }
    } finally {
      // Always release the reader/body — including on the terminal-frame early return.
      reader.cancel().catch(() => {});
    }
  } catch (err) {
    // An abort surfaces here as a reader rejection — stay silent (the caller asked).
    if (opts.signal?.aborted) return;
    onChunk(errorChunk(err instanceof Error ? err.message : String(err)));
  }
}
