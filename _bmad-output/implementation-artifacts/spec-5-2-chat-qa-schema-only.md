---
title: 'Chat Q&A with the Core as sole Provider caller, schema-only by default'
type: 'feature'
created: '2026-07-11'
status: 'done'
baseline_revision: 'f1fb26e501bc69cfd084da8b33df71634220b0e4'
final_revision: 'db3d6feb747d70f1bc5f90fe63e55305041ea507'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Story 5.1 configured AI providers but nothing can talk to them yet. A developer needs to ask a database question in the workspace and get an answer, with the Core (sole holder of the provider key) making the only outbound call and only schema metadata — never row data — leaving the machine by default (AR-6 / R5).

**Approach:** Add a Core-only `chat.ask` RPC that resolves the requested provider's key in Ring 1, introspects the single active connection's schema, assembles a typed, inspectable payload whose schema and row-sample live in **distinct fields** (row-sample always empty in this story), calls the unified AI layer's non-streaming `generateText`, and returns the answer plus a schema-only context summary. Render it in the already-registered `chat` tab: a provider picker over configured providers, a message input, a message log, and a visible "schema-only" indicator. No streaming, no NL→query execution, no sandbox.

## Boundaries & Constraints

**Always:**
- **Core is the sole provider caller.** The provider key is resolved via `providers.getKey(kind)` inside Ring 1 only; `ai` / `@ai-sdk/*` imports stay confined to `src/core/`. The raw key is never returned to Ring 2/3, never logged, never placed in an error `detail`.
- **Schema-only by default.** The outbound payload is assembled Core-side as a typed, inspectable object with schema (table/column names, `dataType`, primary keys, foreign keys) and the row sample as a **distinct field**. In this story the row-sample field is always empty/null — zero rows leave the machine.
- **Reuse, don't rebuild.** Schema comes from the single live `connectionManager.getSchema()` (the same `DatabaseSchema` the ERD/query tabs use). The answer is one non-streaming `generateText({ model, system, prompt })` call through `ai-provider.resolveModel`. The chat request explicitly carries the `ProviderKind` (no active-provider concept exists); the UI offers only configured providers from `providers.list`.
- **Mirror established patterns:** `RegistryResult`/`RpcReply`, `preformed(toReply(...))`, an own-key `HANDLERS` entry, `asParamsObject` shape-check, a DOM-free exported send function + pure React-free view-model + co-located `*.test.ts`. Chat runtime state (messages, picked provider) is lifted to `App` keyed by tab id and is **never** written to the workspace snapshot (mirror `queryDrafts`).

**Block If:**
- The installed AI SDK (`ai` ^7 / `@ai-sdk/*` ^4) cannot perform a non-streaming `generateText` call with the `LanguageModel` handle `resolveModel` returns (API-shape mismatch preventing a text answer).

**Never:**
- No streaming or reasoning channel (Story 5.4), no NL→query generation or query execution from chat (Story 5.3), no MDX/sandbox rendering (5.5/5.6).
- No actual row data in the payload and no row-sample opt-in population — the distinct row-sample field stays empty. The explicit, visibly-indicated per-query row opt-in that attaches real query-result rows is Story 5.3 (which first introduces the query whose rows could be sampled).
- No new Core multi-connection / connection-id→driver capability and no per-tab connection picker — the chat binds to the single active connection like every other tab. No live API-key validation. No new UI library, no zod, no new `RpcErrorCode` (reuse `bad_request` / `not_found` / `internal_error`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ask (happy path) | `chat.ask {provider:"anthropic", message}`, provider configured, connection live | Core resolves key, builds schema-only payload, calls `generateText`, returns `{ answer, context:{ policy:"schema-only", tables:N, rowsIncluded:0 } }` | No error expected |
| Provider not configured | `chat.ask {provider:"openai"}`, no key stored | Nothing sent, no outbound call | `not_found`, "provider not configured", no secret echoed |
| Unknown provider kind | `chat.ask {provider:"bogus", message}` | Nothing sent | `bad_request`, invalid provider |
| Blank message | `chat.ask {provider, message:"  "}` | Nothing sent, no outbound call | `bad_request`, "message required" |
| No active connection | schema unavailable / connect failed | Nothing sent | `bad_request`, "no active connection" (no key/secret in detail) |
| Provider call fails | valid params, SDK throws (network/auth) | Typed failure; raw cause only to stderr | `internal_error`, key never in `detail` |
| Schema-only guarantee | any successful ask | Payload carries schema (names/`dataType`/PK/FK) only; distinct row-sample field is null; zero rows leave | — |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- add `ChatAskParams {provider: ProviderKind; message: string}`, `ChatContextSummary {policy:"schema-only"; tables:number; rowsIncluded:0}`, `ChatAskResult {answer:string; context: ChatContextSummary}`, and the outbound `ChatProviderPayload {schema: SchemaForModel; rowSample: null}` (distinct fields). Reuse `ProviderKind`, `DatabaseSchema`/`SchemaTableInfo`, `RpcReply`.
- `src/core/chat.ts` (+ `.test.ts`) -- NEW. Pure `buildSchemaContext(schema): string` (flatten tables/columns+types/PK/FK to compact text, no rows) and `assemblePayload(schema): ChatProviderPayload` (schema distinct, `rowSample: null`); `createChatResponder({ getSchema, getKey, resolveModel, generate })` → `answer(params): Promise<RegistryResult<ChatAskResult>>`. `generate` defaults to `generateText` from `ai`, injectable for tests.
- `src/core/ai-provider.ts` -- reuse `resolveModel` (no change unless a helper export is needed).
- `src/core/provider-registry.ts` -- reuse `getKey(kind): RegistryResult<string|null>` (Core-internal).
- `src/core/connection.ts` -- reuse `connectionManager.getSchema(): Promise<DatabaseSchema>` (single live schema source).
- `src/core/rpc.ts` -- add `chat` to `RpcContext`; add `HANDLERS["chat.ask"]` (async, `preformed(await ctx.chat(params))`). Template: the `providers.set` entry.
- `src/core/server.ts` -- construct the chat responder in `startCore` closing over `connectionManager.getSchema`, `providerRegistry.getKey`, `resolveModel`, and `generateText`; add `chat` to `rpcContext` (mirror the `tableRows` closure at ~211-226).
- `src/ui/workspace/chat-model.ts` (+ `.test.ts`) -- NEW. React-free view-model: `ChatState {messages: ReadonlyArray<ChatMessage>; provider: ProviderKind|null}`, `ChatMessage {role:"user"|"assistant"; text:string; context?: ChatContextSummary}`, `emptyChatState()`, `validateSend(state, message)`, reducers `setProvider`, `appendUserMessage`, `appendAnswer`.
- `src/ui/workspace/ChatTabView.tsx` (+ `.test.tsx`) -- NEW. Mirror `QueryTabView`: exported DOM-free `sendChat(provider, message): Promise<SendOutcome>` (calls `rpc<ChatAskResult>("chat.ask", {provider, message})`, maps to a plain union); provider picker from `providers.list` (configured only), message input + send (button + Ctrl/Cmd+Enter, re-entrancy guard), message log, per-answer "schema-only · N tables" badge, error banner via `envelopeText`.
- `src/ui/workspace/TabContent.tsx` -- route `tab.kind === "chat"` → `<ChatTabView key={tab.id} state={...} onStateChange={...} />` (replaces the placeholder at ~413).
- `src/ui/App.tsx` -- hold per-chat-tab `ChatState` keyed by tab id (mirror `queryDrafts` at ~236 + `onClose` cleanup at ~395); thread through props. Never persisted.
- `src/ui/workspace/Workspace.tsx` -- thread the chat-state props App→TabContent (mirror the query-draft threading).

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `ChatAskParams`, `ChatContextSummary`, `ChatAskResult`, and `ChatProviderPayload` (schema + `rowSample` as distinct fields); reuse `ProviderKind`/`DatabaseSchema`/`RpcReply` -- typed, inspectable, schema-only wire contract
- [x] `src/core/chat.ts` (+ `.test.ts`) -- `buildSchemaContext`/`assemblePayload` (schema-only, `rowSample: null`) + `createChatResponder({getSchema,getKey,resolveModel,generate})` returning `RegistryResult<ChatAskResult>`; validate provider+non-blank message, not-configured→`not_found`, unknown-kind→`bad_request`, no-schema→`bad_request`, SDK throw→typed failure; `generate` defaults to `generateText`, injectable -- Core-only sole-caller + schema-only assembly. Unit-test the full I/O matrix with an injected `generate` (assert zero rows in the payload, key never in any error)
- [x] `src/core/rpc.ts` -- add `readonly chat: (params: unknown) => Promise<Preformed>` to `RpcContext`; add `HANDLERS["chat.ask"]` = `async (params, ctx) => preformed(await ctx.chat(params))` -- RPC seam mirroring `providers`/`table.rows`
- [x] `src/core/server.ts` -- construct the responder closing over `connectionManager.getSchema`, `providerRegistry.getKey`, `resolveModel`, `generateText`; add `chat` closure to `rpcContext` wrapping the responder via `toReply(...)` -- Ring-1 wiring (mirror `tableRows`)
- [x] `src/ui/workspace/chat-model.ts` (+ `.test.ts`) -- pure view-model: state, `ChatMessage`, `validateSend`, reducers `setProvider`/`appendUserMessage`/`appendAnswer` -- React-free, unit-tested
- [x] `src/ui/workspace/ChatTabView.tsx` (+ `.test.tsx`) -- mirror `QueryTabView`: exported DOM-free `sendChat` mapping the RPC reply to a `SendOutcome` union; provider picker (configured only, disabled/empty-state when none), input + send (Ctrl/Cmd+Enter, re-entrancy guard, busy/error flags), message log with a "schema-only · N tables" badge per answer -- chat surface; test `sendChat` with mocked `rpc`
- [x] `src/ui/workspace/TabContent.tsx` -- route `tab.kind === "chat"` to `ChatTabView` keyed by `tab.id`, passing lifted state + `onStateChange` -- replaces the chat placeholder
- [x] `src/ui/App.tsx` -- hold per-chat-tab `ChatState` keyed by tab id (mirror `queryDrafts`), clean up on tab close, thread props down; keep chat content out of the workspace snapshot -- session-only chat state
- [x] `src/ui/workspace/Workspace.tsx` -- thread chat-state props App→TabContent (mirror query-draft threading) -- wiring only

**Acceptance Criteria:**
- Given the active connection and a configured provider, when I ask a question in the chat tab, then the Core makes the only outbound provider call (Ring 1 holds the key; no `ai`/`@ai-sdk/*` import exists in Ring 2/3) and the answer appears in the chat.
- Given the default policy, when the payload is assembled, then it carries schema only (table/column names, types, foreign keys) with the row sample as a distinct field that is empty — zero rows leave the machine — and the chat visibly indicates "schema-only".
- Given a provider with no configured key (or no active connection), when I try to ask, then I get a clear typed error, no outbound call is made, and no secret appears in the response.

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 1
- reject: 13
- addressed_findings:
  - `[medium]` `[patch]` a failed `providers.list` (Core/transport error) was rendered as the "no providers configured" empty state — a misleading dead-end for a user who *has* providers. Now surfaces a distinct "could not load providers: <err>" banner, separate from the empty state.
  - `[low]` `[patch]` a `chat.ask` resolving after its Tab was closed/switched re-inserted the reclaimed Tab's state (zombie map entry that never gets cleaned). Added a `mounted` ref so `send` drops the result and skips all setState after unmount.
- deferred:
  - `connectionManager.getSchema()` memoizes at connect and never re-introspects → chat schema context + "N tables" badge go stale after DDL. Pre-existing infra (`connection.ts`), surfaced by 5.2; logged to `deferred-work.md`.
- rejected (noise/by-design): stderr redaction residual for non-verbatim key forms (only `err.message` is logged and current providers send the key verbatim, so it is scrubbed); input cleared on failed send (the user bubble preserves the text in the log); schema-only call on an empty DB (a valid "how do I start" use, not an error); untrimmed prompt (whitespace is inert to the model); no server-side `generateText` timeout (provider SDK carries network timeouts); dead `resolveModel` failure branch (defensive after `isProviderKind`); duplicated `generate` default vs server injection (the injectable seam is the tested design); transient busy/error lost on keyed remount (React-tolerant, lifted answer survives); empty-completion blank bubble (providers rarely return ""); hardcoded error-banner color (cosmetic); no message-length cap and no schema-size cap (provider rejects oversized; speculative for v1); provider removed while Tab open (Core returns a clean `not_found` → error banner).

## Design Notes

- **Payload shape proves AR-6 separation.** `ChatProviderPayload` keeps `schema` and `rowSample` as distinct fields; 5.2 always sets `rowSample: null`. This wires the contract for 5.3's per-query row opt-in without shipping any row-sending path now.
- **Schema serialization** (compact, deterministic, no rows) — one line per table plus columns and FKs, e.g.:
```
table public.orders
  columns: id integer not null, customer_id integer, total numeric
  pk: id
  fk: customer_id -> public.customers(id)
```
  Feed this as the `system`/context string; the user message is the `prompt`.
- **Injected `generate` for testability.** `createChatResponder` takes `generate: (args:{model,system,prompt}) => Promise<{text:string}>` defaulting to a thin `generateText` wrapper, so the responder's validation + schema-only assembly are unit-tested with no network and no real key.
- **Single connection is the binding.** "Bound to one explicitly selected connection" resolves to the one live connection every tab already uses; a picker/multi-connection is out of scope and would need Core plumbing that doesn't exist.

## Verification

**Commands:**
- `bun test` -- expected: all suites pass, including new `chat`, `chat-model`, `ChatTabView` tests covering the I/O matrix (happy path, not-configured, unknown kind, blank message, no connection, SDK-throw, and the zero-rows/schema-only assertion)
- `bunx tsc --noEmit` -- expected: no type errors
- `grep -rE "from \"(ai|@ai-sdk/)" src/ui src/shared` -- expected: no matches (SDK confined to Ring 1)

**Manual checks (if no CLI):**
- Connect to a database, open a new Chat tab, pick a configured provider, ask a question: an answer appears with a "schema-only · N tables" badge; the RPC response body contains no raw API key and no row data.
- Ask with a provider that has no key: a clear error shows and no answer is produced.

## Auto Run Result

Status: done

**Summary.** Added AI Chat Q&A. A developer opens a `chat` Tab, picks a configured provider, and asks a database question; the Core (sole holder of the provider key) resolves the key in Ring 1, introspects the single live connection's schema, assembles a typed, inspectable payload whose `schema` and `rowSample` are **distinct fields** (`rowSample` always null — schema-only by default, zero rows leave the machine), makes the one non-streaming `generateText` outbound call through the unified AI layer, and returns the answer plus a schema-only context summary. The UI shows the answer with a visible "schema-only · N tables" indicator. No streaming, no NL→query execution, no sandbox (5.3–5.6).

**Files changed:**
- `src/shared/contract.ts` -- `ChatAskParams`, `SchemaForModel`, `ChatProviderPayload` (schema + `rowSample` distinct), `ChatContextSummary`, `ChatAskResult`
- `src/core/chat.ts` (+ test) -- `buildSchemaContext`/`assemblePayload` (schema-only, `rowSample:null`) + `createChatResponder` (Ring-1 sole caller, injectable `generate`); provider-error stderr log redacts the key
- `src/core/rpc.ts` -- `chat` on `RpcContext` + `chat.ask` handler
- `src/core/server.ts` -- constructs the responder over `getSchema`/`getKey`/`resolveModel`/`generateText`
- `src/ui/workspace/chat-model.ts` (+ test) -- pure React-free view-model (state, `validateSend`, reducers)
- `src/ui/workspace/ChatTabView.tsx` (+ test) -- chat surface: configured-only provider picker, message log, schema-only badge, mounted-guarded send, distinct providers-load-error banner
- `src/ui/workspace/TabContent.tsx` -- routes `chat` tabs to `ChatTabView`
- `src/ui/App.tsx` -- per-tab `ChatState` keyed by tab id (never persisted) + close cleanup
- `src/ui/workspace/Workspace.tsx` -- threads chat state App→TabContent

**Review findings.** 2 patches applied (1 medium: failed `providers.list` shown as "no providers configured" → distinct error banner; 1 low: chat.ask resolving after Tab close resurrected reclaimed state → `mounted` guard). 1 deferred (memoized `getSchema` goes stale after DDL — pre-existing infra). 13 rejected as noise/by-design. 0 intent gaps, 0 bad_spec loopbacks. During implementation verification, a provider-auth error that could echo the raw key to stderr was hardened (key redacted from the logged cause, with a stderr-capture test). Follow-up review not recommended — the fixes are localized, low-consequence, and both reviewers confirmed all four trust invariants (key stays in Ring 1, never logged/returned; payload schema-only; SDK confined to `src/core/`; Core is sole caller) hold.

**Verification.** `bunx tsc --noEmit` clean. `bun test` → 682 pass / 0 fail across 40 files. `grep -rE 'from "(ai|@ai-sdk/)' src/ui src/shared` → no matches (SDK confined to Ring 1). Key-leak grep on the test output → clean.

**Residual risks.** Chat schema context uses the connect-time memoized schema (stale after DDL — deferred). No message-length or schema-size cap (a very large DB/message could exceed the provider context window → `internal_error`). The stderr key-redaction scrubs the verbatim key; a hypothetical non-verbatim echo (encoded) is not covered but no current provider does this and only `err.message` is logged.
