---
title: 'Streaming responses with visible reasoning'
type: 'feature'
created: '2026-07-11'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'e3d8231b9ad7dc91a9f0763fe391f3494bb1fa24'
final_revision: '986a94de75d3b687e3c3bedb570a6a8f48502f6b'
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Story 5.2/5.3 made the chat answer and run queries, but the reply only appears once the whole `chat.ask` round-trip resolves — the assistant feels dead while the model works, and the model's reasoning is never surfaced. UJ-3 wants a response that streams token-by-token with the reasoning shown as it thinks (FR-16, AR-13, UX-DR3), without janking the UI thread (NFR-6).

**Approach:** The Core opens a streaming provider call (`streamText`, still the sole outbound caller, still schema-only) and pipes its parts Core→UI over a new SSE route as a typed `ChatStreamChunk` sequence: `reasoning-delta` and `text-delta` tokens, then a terminal `done` carrying the extracted `query` + `context`. The chat UI consumes the SSE stream through a new DOM-free reader, renders the answer incrementally and the reasoning in a **visually distinct secondary channel**, and coalesces token updates per animation frame so rapid deltas never thrash the main thread. The single-shot `chat.ask` path is superseded by streaming.

## Boundaries & Constraints

**Always:**
- **Core stays the sole provider caller, schema-only.** Streaming reuses the exact validate→getKey→getSchema→resolveModel→`assemblePayload`→`buildChatSystemPrompt` pipeline (extracted into one shared helper); the outbound payload is unchanged — schema stanzas only, `rowSample` stays `null`, zero rows leave the machine. `ai`/`@ai-sdk/*` stay confined to `src/core/`.
- **Streaming is delivered over SSE on the localhost HTTP channel.** A new `POST /chat/stream` route reuses the existing `validateOrigin` + `validateToken` gates, then returns a `text/event-stream` `ReadableStream` emitting one `data: <json ChatStreamChunk>\n\n` per part. The provider key never appears in any chunk; provider errors are redacted (stderr-only) exactly as `answer()` does today.
- **Reasoning is a distinct channel.** `fullStream` `reasoning-delta` parts route to the reasoning channel; `text-delta` parts route to the answer channel. The reasoning channel renders visually distinct from the final answer (muted/secondary treatment) and only when reasoning is present. Provider thinking is enabled where the configured provider supports it via a pure `reasoningProviderOptions(provider)` seam; a provider that emits no reasoning simply leaves the channel empty (never an error).
- **Query extraction stays Core-side and deterministic.** `extractQuery` runs once on the fully-accumulated answer text at end-of-stream and travels in the terminal `done` chunk; the existing 5.3 run/confirm path consumes `query` unchanged.
- **No jank (NFR-6).** The UI accumulates deltas and flushes them into the rendered partial on `requestAnimationFrame` (coalesced), not one `setState` per token. Preserve the `firing`/`busy` re-entrancy guard and the `mounted.current` guard — abort the in-flight `fetch` on unmount and push no state after unmount.
- **Mirror established patterns:** DOM-free exported stream/consume functions with an injectable transport seam; pure React-free reducers + co-located tests; session-only chat state (partial stream held transiently, never written to the workspace snapshot).

**Block If:**
- The installed `ai` v7 `streamText` `fullStream` does not expose `reasoning-delta`/`text-delta` parts as investigated, so reasoning and answer cannot be separated Core-side without provider-specific parsing. If the two channels cannot be split from the SDK stream, HALT.

**Never:**
- No MDX/sandbox rendering (5.5/5.6); no markdown parser (answer stays plain incremental text).
- **No sending query-result rows to the provider** — outbound stays schema-only, `rowSample: null`. No new executor, SQL classifier, or UI-side SQL parsing. No editable chat SQL. No per-tab connection/model/temperature picker.
- No persisting chat messages, reasoning, or partial streams to the workspace snapshot. No auto-executing any generated statement (the 5.3 confirm gate is unchanged).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Reasoning + answer stream | provider emits reasoning then text parts | `reasoning-delta` chunks fill the reasoning channel, `text-delta` chunks fill the answer channel; both render incrementally | none |
| Answer-only (no reasoning) | provider emits only text (e.g. openai `gpt-4o`) | only `text-delta` chunks; reasoning channel stays empty/hidden | none |
| Query in stream | accumulated answer contains a ```sql block | terminal `done.query` = extracted SQL; the 5.3 run affordance renders under the message | none |
| Provider call fails mid-stream | `streamText` throws / provider 401 | `error` chunk (redacted message); UI shows a banner; no key in any chunk | key redacted, stderr-only |
| Pre-flight validation fails | bad provider / blank message / key not configured / no active connection | single `error` chunk before any delta; UI banner; no streaming bubble committed | mapped from `RegistryResult` |
| Tab closed mid-stream | unmount while streaming | `fetch` aborted via `AbortController`; `mounted.current` blocks any post-unmount state push | none |
| Re-entrancy | send fired while a stream is in flight | guarded by `firing`/`busy` — a single in-flight stream, no double send | none |
| Delta storm | many tokens arrive in one frame | deltas coalesced and flushed once per `requestAnimationFrame` | none |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- add the Ring-neutral `ChatStreamChunk` discriminated union (`reasoning-delta` | `text-delta` | `done{query,context}` | `error{code,message}`). Reuse `ChatContextSummary`/`RpcErrorCode`. No other contract change; keep it types-only.
- `src/core/chat.ts` (+ `.test.ts`) -- extract the shared request-prep (validate params, `getKey`, `getSchema`, `resolveModel`, `assemblePayload`, `buildChatSystemPrompt`) into one helper returning `RegistryResult<{model,system,prompt,tables}>`. Add `answerStream(params): AsyncGenerator<ChatStreamChunk>` behind an injected `GenerateStreamFn` seam (default = `streamText`): map `fullStream` parts to chunks, accumulate answer text, emit terminal `done{ query: extractQuery(full), context }`; yield a single `error` chunk for pre-flight failures and mid-stream throws (redacted). Remove the now-superseded `answer()`; keep `buildChatSystemPrompt`/`extractQuery`/`assemblePayload` pure and reused.
- `src/core/ai-provider.ts` (+ `.test.ts`) -- add pure `reasoningProviderOptions(provider): Record<string, unknown>` (thinking config for anthropic/google, `{}` for openai) passed into the stream call. Model resolution otherwise unchanged.
- `src/core/server.ts` -- add `POST /chat/stream`: reuse `validateOrigin` + `validateToken`, then return a `text/event-stream` `Response` whose `ReadableStream` pumps `responder.answerStream(params)` as `data: <json>\n\n`. Wire the default `streamText` seam. Remove the `chat.ask` dispatch wiring left unused.
- `src/core/rpc.ts` (+ `rpc.test.ts`) -- remove the now-unused `chat.ask` handler and its test stub (streaming does not go through `dispatch`).
- `src/ui/rpc/rpc-stream.ts` (NEW, + `.test.ts`) -- DOM-free `streamChat(provider, message, onChunk, opts?)`: `fetch("/chat/stream", POST, x-qs-token)`, `res.body.getReader()` + `TextDecoder`, parse SSE `data:` lines into `ChatStreamChunk`, invoke `onChunk`; abortable via `AbortController`; no fixed 10s timeout. Network/parse failure → synthetic `error` chunk.
- `src/ui/workspace/chat-model.ts` (+ `.test.ts`) -- assistant `ChatMessage` gains `reasoning: string | null`; `appendAnswer(state, text, context, query, reasoning)` threads it; add pure `accumulateStream(partial, chunk)` for the transient `{text,reasoning}` partial (answer/reasoning routing).
- `src/ui/workspace/ChatTabView.tsx` (+ `.test.tsx`) -- `send()` drives `streamChat`; hold the transient partial `{text,reasoning}` in component-local `useState`, flush accumulated deltas on `requestAnimationFrame`; render a live streaming bubble (incremental answer + distinct muted reasoning block) and, on `done`, commit via `appendAnswer` (incl. `reasoning`+`query`) so the 5.3 `ChatQueryRun` affordance renders; render the reasoning block for finalized messages with non-null reasoning; preserve `firing`/`busy`/`mounted` guards; abort the stream on unmount. Remove the old single-shot `sendChat`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `ChatStreamChunk` discriminated union -- typed SSE wire shape shared across rings
- [x] `src/core/chat.ts` (+ `.test.ts`) -- extract shared request-prep; add `answerStream` over an injected `GenerateStreamFn`; map reasoning/text parts, accumulate answer, terminal `done` with `extractQuery` + `context`, `error` chunk on pre-flight/mid-stream failure (redacted); remove `answer()`. Unit-test (fake stream): reasoning vs text routing, `done.query` extracted from accumulated text, schema-only payload (`rowSample:null`, zero rows), pre-flight error chunk, mid-stream throw → redacted error chunk with no key
- [x] `src/core/ai-provider.ts` (+ `.test.ts`) -- add pure `reasoningProviderOptions`; unit-test per-provider (anthropic/google thinking enabled, openai `{}`)
- [x] `src/core/server.ts` -- add `POST /chat/stream` SSE route (origin+token gated) pumping `answerStream` as `data:` events; wire default `streamText`; drop unused `chat.ask` wiring
- [x] `src/core/rpc.ts` (+ `rpc.test.ts`) -- remove unused `chat.ask` handler + stub
- [x] `src/ui/rpc/rpc-stream.ts` (NEW, + `.test.ts`) -- DOM-free abortable SSE reader `streamChat`; unit-test SSE parse → `onChunk` sequence, mid-stream error chunk, and abort, with a mocked `fetch`/reader
- [x] `src/ui/workspace/chat-model.ts` (+ `.test.ts`) -- `reasoning` on assistant message; `appendAnswer` threads it; pure `accumulateStream`; unit-test answer/reasoning accumulation and final commit
- [x] `src/ui/workspace/ChatTabView.tsx` (+ `.test.tsx`) -- streaming `send()` via `streamChat`, rAF-coalesced partial, incremental answer + distinct reasoning render, `done` commit feeding `ChatQueryRun`, guards + abort-on-unmount; remove `sendChat`. Test the stream-driven send (fed a stub `streamChat`): incremental deltas, reasoning routing, done→committed message with query, and error→banner

**Acceptance Criteria:**
- Given a chat bound to a configured provider and active connection, when the model responds, then the answer appears incrementally over SSE as tokens arrive — not only on completion (FR-16, AR-13).
- Given a response whose provider emits reasoning, when it streams, then the reasoning renders in a channel visually distinct from the final answer, and a provider that emits no reasoning leaves that channel empty rather than erroring (UX-DR3).
- Given a stream that yields a SQL query in its answer, when it completes, then the terminal `done` chunk carries the `extractQuery` result and the existing 5.3 run/confirm affordance renders and executes through the unchanged guarded `execute` path — with no `ai`/`@ai-sdk/*` import or SQL classification added to Ring 2/3.

## Spec Change Log

_No bad_spec loopbacks — intent contract and spec sections held through review._

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 3, low 3)
- defer: 1: (low 1)
- reject: 6
- addressed_findings:
  - `[medium]` `[patch]` Client disconnect tore down the fetch but the Core kept pulling the provider's `fullStream` to completion (billable, wasteful). Threaded an `AbortSignal` through `answerStream` → `GenerateStreamFn` → `streamText({abortSignal})`, passed `req.signal` from the `/chat/stream` handler, added a `ReadableStream` `cancel()` + `finally` that closes the async iterator. + tests.
  - `[medium]` `[patch]` The server pump could throw an unhandled rejection on a closed controller after disconnect (and the catch re-enqueued onto the dead controller). Wrapped every `enqueue`/`close` in try/catch; on enqueue failure it breaks and closes the generator instead of re-enqueuing a fallback.
  - `[medium]` `[patch]` `REASONING_MAX_OUTPUT_TOKENS` (4096) was passed to `streamText` unconditionally, silently capping non-reasoning providers (OpenAI `gpt-4o`) — a regression vs 5.2's uncapped `generateText`. Moved the ceiling into `reasoningProviderOptions` so only thinking-enabled providers (anthropic/google) get it; OpenAI gets no cap. + regression test.
  - `[low]` `[patch]` The client SSE reader never released on the terminal-frame early return, never flushed the `TextDecoder`, and threw on an empty keep-alive `data:` line. Wrapped the read loop in `try/finally { reader.cancel() }`, added a terminal `decoder.decode()` flush + trailing-buffer parse, and made the frame parser skip empty/whitespace payloads. + tests.
  - `[low]` `[patch]` `reasoningProviderOptions` was a non-exhaustive switch that would silently return `undefined` options for a future 4th provider kind. Added a compile-time-exhaustive `never` default (same pattern as `resolveModel`).
  - `[low]` `[patch]` A `done` chunk with an empty answer and no reasoning committed a blank assistant bubble. Now surfaces `{kind:"error","empty response"}`; a response with reasoning but empty answer text still commits normally. + tests.
- deferred (not this story): exact-substring provider-key redaction in the chat error path (inherited from 5.2's `answer()`, reused by `answerStream`) → logged to `deferred-work.md`.
- rejected (noise/by-design): mid-stream error discarding the streamed partial — spec-permitted ("no streaming bubble committed"); SSE heartbeat/keep-alive absence — localhost-bound single-user channel with no intervening proxy; "iterator ends with no terminal signal → false done" — `ai@7` surfaces provider errors as a thrown iteration or an `error` part (both handled) and the empty-answer guard covers the observable symptom; SSE parser only handling the exact same-author framing (`event:`/`id:` ignored, dead multi-`data:` join) — both ends are this codebase; `abortRef`/"stream superseded" comment drift — no supersede path exists; missing route-level schema-only regression test — `ChatStreamChunk` types structurally cannot carry rows or keys, so the invariant is type-guaranteed at the wire.

### 2026-07-11 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 0
- reject: 19
- addressed_findings:
  - `[low]` `[patch]` The Core `answerStream` catch treated a client-disconnect abort as a provider failure: it wrote a spurious `[chat] provider stream failed` line to stderr and yielded a misleading `error` chunk (which the already-dead controller could not deliver anyway) on every tab-close/unmount. Added an `if (signal?.aborted) return;` guard at the top of the catch so a deliberate teardown is silent. (`src/core/chat.ts`)
  - `[low]` `[patch]` The client SSE reader `streamChat` returned on a non-OK response (`!res.ok`) without draining `res.body`, leaving the error-response stream dangling. Now `body?.cancel().catch(() => {})` before emitting the synthetic error chunk. (`src/ui/rpc/rpc-stream.ts`)
  - `[low]` `[patch]` Removed the orphaned `ChatAskParams`/`ChatAskResult` public types left in `src/shared/contract.ts` after the `chat.ask` RPC path was retired — dead exports the original pass claimed to remove but did not.
- rejected (noise/verified-false/by-design): **SDK part-shape assumption (`part.text` vs `textDelta`, `as unknown as` cast, stringly-typed `type`)** — VERIFIED FALSE against the installed `ai@7.0.22`: `streamText().fullStream` yields `TextStreamPart`, whose `text-delta`/`reasoning-delta` parts both carry `.text` and whose `error` part carries `.error` — the reviewer conflated it with `UIMessageChunk` (which uses `.delta`); the narrowed `ChatStreamPart` shape matches the real contract exactly. openai o1/o3 reasoning cap / `google` `includeThoughts` without budget / anthropic-google 4096 ceiling — all by-design per Design Notes ("keep the budget modest", degrade to an empty channel never an error; openai scoped to `gpt-4o`), the ceiling was itself a prior-pass patch. Truncation `finishReason==='length'` not surfaced — out of contract scope for schema-Q&A, would need a contract change not mandated. **Exact-substring key redaction — already logged to `deferred-work.md` in the prior pass** (not re-deferred here). No server-side timeout / no heartbeat / hop-by-hop `connection` header / `\n\n`-only frame split / malformed-frame terminates read / mid-stream error discards partial / empty-answer-with-reasoning commits / rAF stalls in a background tab / missing `aria-live` / no ReadableStream-lifecycle integration test / `iterator.return()` from two contexts / unguarded `cancel()` return / `apiKey.length>0` guard (correct — it prevents `"".split("")` fan-out) / unguarded `onChunk` (this codebase's own well-behaved callback) — localhost single-user channel, spec-permitted, prior-pass-rejected, or defensive-correct.

## Design Notes

- **One pipeline, two exits.** The validate→key→schema→model→payload→system-prompt sequence is identical to `answer()`; extract it so `answerStream` cannot drift from the schema-only invariant. Only the terminal call differs (`streamText` vs `generateText`).
- **Reasoning enablement is a bounded seam.** Anthropic needs `providerOptions.anthropic.thinking = { type: "enabled", budgetTokens: N }` with `maxOutputTokens > N`; Google needs `providerOptions.google.thinkingConfig = { includeThoughts: true }`; OpenAI `gpt-4o` emits none → `{}`. Keep the budget modest. The channel-routing/rendering is the real deliverable; population depends on provider support and must degrade to an empty channel, never a failure.
- **SSE framing.** Each chunk is `data: ${JSON.stringify(chunk)}\n\n`. The reader splits on `\n\n`, strips the `data: ` prefix, `JSON.parse`s the payload. `done`/`error` terminate the read loop. EventSource is unusable (GET-only, cannot set `x-qs-token`) — use `fetch` + `res.body.getReader()`.
- **No jank.** Buffer `answerDelta`/`reasoningDelta` into refs and `requestAnimationFrame`-flush into the partial `useState`; cancel the pending frame on unmount. Keep the pure accumulation (`accumulateStream`) DOM-free so it is unit-tested without jsdom (repo has none).
- **Reasoning styling.** Reuse existing tokens: reasoning block uses `--muted`/`--muted-foreground` (smaller/italic, optionally a `<details>`), answer uses `--foreground` — a clear secondary-vs-primary contrast, honoring `prefers-reduced-motion`.

## Verification

**Commands:**
- `bun test` -- expected: all suites pass, incl. new `rpc-stream`, updated `chat`, `ai-provider`, `chat-model`, `ChatTabView` tests (reasoning/text routing, done/error chunks, accumulation, schema-only assertion)
- `bunx tsc --noEmit` -- expected: no type errors
- `grep -rE 'from "(ai|@ai-sdk/)' src/ui src/shared` -- expected: no matches (SDK confined to Ring 1)
- `grep -rn 'rowSample' src/core/chat.ts` -- expected: streaming payload still `rowSample: null` (zero rows leave the machine)
- `grep -rniE 'EventSource|streamText' src/ui` -- expected: no matches (UI streams via `fetch`+reader; SDK stays in Core)

**Manual checks (if no CLI):**
- Connect a DB, open a Chat tab, pick a provider, ask a question: the answer types in incrementally; with a reasoning-capable provider a distinct muted reasoning block streams above the answer; the outbound provider call carries no key and no row data.
- Ask something yielding a `SELECT`: on completion the run button appears and runs like the query tab; a `DELETE`/`DROP` still surfaces the shared confirm dialog before executing.

## Auto Run Result

Status: done

**Summary.** The AI chat now streams token-by-token with a visible reasoning channel. The Core opens a streaming provider call (`streamText`, still the sole outbound caller, still schema-only — `rowSample: null`, zero rows leave) and pipes `fullStream` parts Core→UI over a new SSE route `POST /chat/stream` (reusing the existing origin + token gates) as a typed `ChatStreamChunk` sequence: `reasoning-delta`/`text-delta` tokens, then a terminal `done` carrying `extractQuery(accumulated answer)` + `context`. The chat UI consumes the stream through a new DOM-free `streamChat` reader (`fetch` + `res.body.getReader()`; EventSource can't set `x-qs-token`), renders the answer incrementally and the reasoning in a distinct muted `ReasoningBlock`, and coalesces token updates per `requestAnimationFrame` so rapid deltas never thrash the main thread. The single-shot `chat.ask`/`answer()`/`sendChat` path is retired; the 5.3 run/confirm affordance consumes the final `query` unchanged.

**Files changed:**
- `src/shared/contract.ts` -- add the Ring-neutral `ChatStreamChunk` discriminated union (`text-delta` | `reasoning-delta` | `done{query,context}` | `error{code,message}`); remove the now-unused `ChatAskResult`/`chat.ask` params types
- `src/core/chat.ts` (+ test) -- extract shared `prepareRequest`; add `answerStream(params, signal?)` over an injected `GenerateStreamFn` (default `streamText`) routing reasoning/text parts, accumulating answer only, emitting terminal `done`/redacted `error`; abort-signal plumbed to `streamText`; `reasoningProviderOptions` spread in (no global `maxOutputTokens`); `answer()` removed
- `src/core/ai-provider.ts` (+ test) -- `reasoningProviderOptions(provider): ReasoningOptions` (anthropic/google thinking `providerOptions` + `maxOutputTokens`; openai `{}`; exhaustive `never` default)
- `src/core/server.ts` -- `POST /chat/stream` SSE route (origin+token gated) pumping `answerStream(params, req.signal)` as `data:` events with a controller-safe pump, a `cancel()` handler, and generator cleanup in `finally`
- `src/core/rpc.ts` (+ `rpc.test.ts`) -- remove the unused `chat.ask` handler + `ctx.chat`
- `src/ui/rpc/rpc-stream.ts` (NEW, + test) -- DOM-free abortable `streamChat`: SSE reader with `try/finally` reader-cancel, terminal decoder flush + trailing-frame parse, empty keep-alive skip, synthetic `error` chunk on failure
- `src/ui/workspace/chat-model.ts` (+ test) -- `reasoning: string|null` on the assistant message; `appendAnswer` threads it; pure `accumulateStream`
- `src/ui/workspace/ChatTabView.tsx` (+ test) -- streaming `send()` via `streamChat`, rAF-coalesced local partial, incremental answer + distinct reasoning render, `done` commit feeding `ChatQueryRun`, empty-answer→error guard, `firing`/`busy`/`mounted` guards + abort-on-unmount; `sendChat` removed

**Review findings.** Two adversarial reviewers (Blind Hunter + Edge Case Hunter). All four trust invariants confirmed intact: provider key stays in Ring 1, outbound payload is schema-only (`rowSample: null`), `ai`/`@ai-sdk/*` confined to `src/core/`, and generated destructive/DDL queries still route through the unchanged 5.3 guarded-executor confirm gate. Triage: 0 intent_gap, 0 bad_spec, **6 patches applied** (3 medium: server-side abort propagation to the provider stream, controller-safe pump, `maxOutputTokens` no longer capping non-reasoning providers; 3 low: SSE reader hardening, exhaustive provider switch, no-blank-bubble guard), **1 deferred** (exact-substring key redaction, inherited from 5.2 → `deferred-work.md`), 6 rejected as noise/by-design.

**Verification.** `bunx tsc --noEmit` clean. `bun test` → **729 pass / 0 fail** across 43 files (incl. new `rpc-stream` tests, abort-propagation, OpenAI-no-cap, keep-alive-skip, decoder-flush, and empty-answer tests). `grep -rE 'from "(ai|@ai-sdk/)' src/ui src/shared` → no matches. `grep -rniE 'EventSource|streamText' src/ui` → no matches. `grep -rn 'rowSample' src/core/chat.ts` → still `rowSample: null`. Redaction confirmed by the test log line `provider stream failed: boom ***`.

**Residual risks.** Effective population of the reasoning channel depends on provider/model support at runtime (Anthropic/Google thinking emit it; OpenAI `gpt-4o` emits none) — by design it degrades to an empty channel, never an error. No real end-to-end integration test of `Bun.serve`'s `/chat/stream` against a live provider (streaming logic is covered via `answerStream` + `streamChat` with stubs); manual end-to-end with a real DB+key remains. Key redaction is best-effort exact-substring (deferred).

**Follow-up review pass (2026-07-11).** A second independent adversarial + edge-case pass ran against the same baseline diff. The four trust invariants remain intact (key confined to Ring 1, `rowSample: null` schema-only payload, `ai`/`@ai-sdk/*` confined to `src/core/`, unchanged 5.3 guarded-executor confirm gate — all re-verified by grep). The pass's flagged highest-risk item (the SDK `fullStream` part field-name assumption) was **verified false** against the installed `ai@7.0.22` type definitions: `TextStreamPart` `text-delta`/`reasoning-delta` both expose `.text` and `error` exposes `.error`, matching the narrowed `ChatStreamPart` exactly. Triage: **0 intent_gap, 0 bad_spec, 3 low patches applied** (abort no longer logged/reported as a provider failure in the Core catch; non-OK SSE response body now drained client-side; orphaned `ChatAskParams`/`ChatAskResult` dead types removed), **0 new defers** (exact-substring redaction was already on the ledger from the first pass), 19 rejected (verified-false / by-design / prior-pass-rejected / defensive-correct). Verification re-run: `bunx tsc --noEmit` clean, `bun test` → **729 pass / 0 fail**, all invariant greps still clean. These three fixes are localized and low-consequence, so no further follow-up review is recommended.
