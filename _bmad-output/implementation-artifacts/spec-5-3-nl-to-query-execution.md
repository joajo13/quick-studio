---
title: 'Natural-language to query + execution from chat'
type: 'feature'
created: '2026-07-11'
status: 'done'
baseline_revision: '560bc70d9f587c25982379e554bd0c5762b80c2d'
final_revision: 'ea1f482adbca8879b49ecb7a1d80089e7568ee50'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Story 5.2 gave the chat a schema-only Q&A answer, but a developer still can't get a runnable query and execute it in place — they must copy SQL into a separate query tab, defeating UJ-3. The chat must turn a natural-language question into a query bound to the active connection's schema, run it from the chat through the exact same guarded path as a query tab, and never auto-run a destructive statement (FR-15, AR-3, R4).

**Approach:** Extend the Core `chat.ask` responder to prompt the model (schema-only, still the sole outbound caller) to emit one SQL statement in a fenced block; a pure Core function extracts it into a distinct `query` field. In the chat UI, an assistant message that carries a query renders the SQL read-only with a "run" action that sends the SQL **verbatim** through the existing `execute` RPC (Story 3.1 guarded executor) via the shared `runRawQuery` seam — reads auto-run and render rows like the query tab; every non-read statement comes back `confirmation_required` and surfaces a **shared** confirm dialog (extracted from the query tab) that only re-issues with `confirmed: true` after an explicit click.

## Boundaries & Constraints

**Always:**
- **Core stays the sole provider caller, schema-only.** Generation is one more `generate({model, system, prompt})` call in `createChatResponder`; the outbound payload is unchanged — schema stanzas only, `rowSample` stays `null`, zero rows leave the machine. The system prompt is built Core-side from the live schema and engine dialect; `ai`/`@ai-sdk/*` stay confined to `src/core/`.
- **Query extraction is a pure, deterministic Core function** returning a distinct `query: string | null` field on `ChatAskResult`; the `answer` text is returned whole. The UI never parses or classifies SQL for safety (AR-3) — it sends whatever string the Core extracted, verbatim.
- **Execution reuses the guarded path exactly.** Running a chat query issues the same `{ shape: "raw", sql }` `execute` request the query tab issues; results are identical because it is the same Story 3.1 executor over the same live connection. Reuse the existing `runRawQuery` fn (extracted to a shared module) — do not add a new RPC method or a second executor.
- **Destructive/DDL never auto-execute.** A non-read statement returns `status: "confirmation_required"` with `preview.{sql,risk}`; the chat shows the **same** confirm dialog as the query tab (extracted into one shared component) and only re-sends the **identical** request with `confirmed: true` after an explicit user confirm. Freeze the exact SQL sent (mirror the query tab's `pendingSql`), never the trimmed preview.
- **Mirror established patterns:** pure React-free view-model reducers + co-located tests, DOM-free exported send/run functions, session-only per-tab chat state (never written to the workspace snapshot).

**Block If:**
- Running a generated query through the existing `execute` RPC does not reproduce the query tab's result for the same SQL because the executor is coupled to query-tab-only context (i.e. the guarded path cannot be driven from the chat surface). If reuse is impossible without new Core plumbing, HALT.

**Never:**
- No streaming or reasoning channel (5.4); no MDX/sandbox rendering (5.5/5.6).
- **No sending query-result rows back to the provider** (the per-query row opt-in) — outbound stays schema-only, `rowSample: null`. That opt-in is a later story; this story only produces and runs queries.
- No new executor, no new SQL classifier, no UI-side SQL parsing/classification for safety, no new `execute`-equivalent RPC method, no new `RpcErrorCode`. No auto-confirming any generated statement. No multi-connection / per-tab connection picker, no model/temperature-selection knob. No editable chat SQL (run the generated statement as-is). No persisting chat messages or run results to the workspace snapshot.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ask yields a query | `chat.ask`, provider+connection live, model emits a ```sql block | `{ answer, query:"<sql>", context: schema-only }`; message shows SQL + "run" action | none |
| Ask yields prose only | model emits no fenced SQL | `query: null`; no run action rendered | none |
| Run a read query | click run on a `SELECT`/`SHOW` message | `execute {shape:"raw", sql}` → `status:"rows"`; rows render in chat via the same DataGrid as the query tab (row-capped identically) | executor error → banner via `envelopeText` |
| Run a destructive/DDL query | click run on `DELETE`/`UPDATE`/`DROP`/`ALTER`/… | `status:"confirmation_required"`; shared confirm dialog shows `preview.{sql,risk}`; nothing executes | — |
| Confirm destructive | click confirm | identical request re-sent with `confirmed:true` → `status:"ok"` (rows affected) | error → banner |
| Cancel destructive | click cancel / Esc | dialog closes, nothing runs | — |
| Multi-statement generated | model emits `SELECT …; DELETE …;` | `execute` → `bad_request` "multiple statements are not allowed"; surfaced as a banner, no retry | error banner |
| Re-entrancy | run clicked twice rapidly | guarded — a single in-flight run; no double execute | — |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- extend `ChatAskResult` to `{ answer: string; query: string | null; context: ChatContextSummary }`. Reuse `ExecuteRequest`/`ExecuteResult` (already present) for the run path; no other contract change.
- `src/core/chat.ts` (+ `.test.ts`) -- add pure `buildChatSystemPrompt(payload): string` (instruction: answer using only this `{engine}` schema; when a query is appropriate emit exactly one statement in a ```sql fenced block) composed with the existing schema stanzas; add pure `extractQuery(text): string | null` (first ```sql (or bare ```) fenced block, trimmed, else null). In `answer()`, use the composed system prompt and set `query: extractQuery(text)`. Payload assembly unchanged (`rowSample: null`).
- `src/ui/workspace/run-raw-query.ts` (NEW, + `.test.ts`) -- move `runRawQuery(sql, confirmed?): Promise<RunOutcome>` and the `RunOutcome` union out of `QueryTabView` into a shared, DOM-free module (calls `rpc<ExecuteResult>("execute", …)`, maps status → outcome). Single execution seam for both surfaces.
- `src/ui/workspace/ConfirmRun.tsx` (NEW, + `.test.tsx`) -- shared presentational confirm dialog `{ sql: string; risk: string; busy: boolean; onConfirm(): void; onCancel(): void }` extracted verbatim from the query tab's inline confirm panel.
- `src/ui/workspace/QueryTabView.tsx` -- import `runRawQuery`/`RunOutcome` from the shared module and render `<ConfirmRun>` instead of the inline panel. Behavior unchanged (refactor only).
- `src/ui/workspace/chat-model.ts` (+ `.test.ts`) -- assistant `ChatMessage` variant gains `query: string | null`; `appendAnswer(state, text, context, query)` carries it. Reducers otherwise unchanged.
- `src/ui/workspace/ChatTabView.tsx` (+ `.test.tsx`) -- `sendChat` maps `ChatAskResult` → a `SendOutcome` answer variant carrying `query`. For an assistant message with a non-null `query`: render the SQL read-only + a "run" button; local run state (which message, outcome, confirm, frozen `pendingSql`, busy, re-entrancy ref) drives execution via `runRawQuery`; `rows` → same `<DataGrid data primaryKeys={[]} …>`, `ok` → "N rows affected", `confirm` → `<ConfirmRun>` (confirm → re-run with `confirmed:true`), `error` → banner. Run outcome is transient/local, not lifted into the session `ChatState`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `query: string | null` to `ChatAskResult` -- distinct generated-query field on the wire
- [x] `src/core/chat.ts` (+ `.test.ts`) -- add pure `buildChatSystemPrompt` (SQL-emitting instruction + engine dialect + schema stanzas) and `extractQuery`; wire both into `answer()` (`query: extractQuery(text)`); keep payload schema-only (`rowSample: null`) -- Core-side NL→query, still sole caller & schema-only. Unit-test `extractQuery` (```sql block, bare ``` block, prose-only→null, multi-block→first) and that a successful ask returns the extracted query with zero rows in the payload
- [x] `src/ui/workspace/run-raw-query.ts` (NEW, + `.test.ts`) -- extract `runRawQuery`/`RunOutcome` into a shared module; unit-test the status→outcome mapping (rows/ok/confirm/error) with a mocked `rpc`
- [x] `src/ui/workspace/ConfirmRun.tsx` (NEW, + `.test.tsx`) -- shared confirm dialog `{sql,risk,busy,onConfirm,onCancel}`; test confirm/cancel callbacks and busy-disabled state
- [x] `src/ui/workspace/QueryTabView.tsx` -- consume the shared `runRawQuery`/`RunOutcome` and `<ConfirmRun>`; no behavior change -- de-duplicate the execution + confirm seams
- [x] `src/ui/workspace/chat-model.ts` (+ `.test.ts`) -- assistant message carries `query: string | null`; `appendAnswer` threads it -- view-model support, unit-tested
- [x] `src/ui/workspace/ChatTabView.tsx` (+ `.test.tsx`) -- render generated SQL + "run" action; local run state driving `runRawQuery` through `execute`; rows via `<DataGrid>`, ok banner, shared `<ConfirmRun>` for destructive (re-run identical request with `confirmed:true`), error banner; re-entrancy guard -- run-from-chat surface. Test `sendChat` query mapping and the run/confirm/cancel/error paths with a mocked `runRawQuery`

**Acceptance Criteria:**
- Given a chat bound to the active connection and a configured provider, when I ask a question in natural language, then I receive an assistant answer that includes a query targeting that connection's schema (extracted into `ChatAskResult.query`) and a run action for it (FR-15).
- Given a generated read query, when I run it from the chat, then it executes through the Story 3.1 guarded `execute` RPC (same `{shape:"raw",sql}` request the query tab sends) and renders the same result a query tab would — with no `ai`/`@ai-sdk/*` import or SQL classification added to Ring 2/3.
- Given a generated destructive/DDL statement, when I try to run it from chat, then it is never auto-executed: the same shared confirm dialog appears and the statement runs only after an explicit confirm re-issues the identical request with `confirmed: true` (AR-3, R4).

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 0
- reject: 10
- addressed_findings:
  - `[low]` `[patch]` `extractQuery`'s bare-fence fallback captured a non-`sql` language tag (```postgresql / ```mysql) into the query body, producing a run button that always errored. Added a language-tag-consuming fence branch (`langFence`) between the `sql` and bare fences + a unit test.
  - `[low]` `[patch]` `confirmChatQuery` only guarded on `busy`, so the exported pure fn could re-issue `pendingSql` with `confirmed:true` even when no confirmation was Core-gated (safe today only because the UI renders confirm inside the `confirm` branch). Added an `outcome.kind === "confirm"` precondition (defense-in-depth for invariant d) + a unit test.
  - `[low]` `[patch]` a stale `ChatProviderPayload` doc comment attributed the per-query row opt-in to Story 5.3; 5.3 keeps `rowSample: null` and sends no rows. Reworded to "a FUTURE per-query row opt-in" so the doc no longer implies a data-egress path this story does not ship (invariant b hygiene).
- rejected (noise/by-design): any fenced SQL (incl. a model's cautionary example) becoming a run button — inherent to the spec's intent-blind extraction; the confirm gate is the safety and the UI is forbidden to classify intent (AR-3); displayed `preview.sql` (Core-trimmed) vs executed frozen `pendingSql` — spec-mandated and identical to the query tab; run/confirm handlers lack a `mounted` guard — harmless no-op since run state is component-local `useState`, never lifted/persisted; reads auto-run with no cost ceiling beyond the Core row cap — by-design ("reads auto-run"); multi-statement SQL surfaces Core's `bad_request` banner under an offered run button — correct (UI never splits/classifies), invariant upheld; `cancelChatQuery` lacks a busy guard — DOM-gated (`disabled={busy}`); per-message run state keyed by array index — correct today (the log is append-only) and latent only under a hypothetical future edit/delete feature; `extractQuery` first-block-wins — spec-mandated; unclosed/streamed fence → `null` — graceful degradation, truncation is a 5.4 streaming concern; a ``` sequence inside the SQL body truncating the lazy match — speculative (SQL virtually never contains triple-backticks).

## Design Notes

- **Extraction is Core-side and dumb.** `extractQuery` finds the first fenced block (prefer ` ```sql `), trims it, returns `null` when absent. It does not validate or classify — the guarded executor remains the only thing that decides read-vs-mutating. This keeps Ring 2 free of any SQL-safety logic (AR-3).
- **One execution seam, one dialog.** Both the query tab and the chat run SQL through the same exported `runRawQuery` and show the same `ConfirmRun` component. The confirm re-run must resend the exact string originally sent (the executor's `preview.sql` is trimmed/normalized — freeze the sent SQL like `QueryTabView`'s `pendingSql`), so the confirmed execution is byte-identical to what was previewed as risky.
- **Schema-only is preserved.** No result rows are ever attached to an outbound provider call in this story; `ChatProviderPayload.rowSample` stays `null`. Running a query surfaces rows only into the trusted Ring 2 chat surface, exactly as the query tab does.
- **System prompt shape** (compose, don't replace the schema stanzas), e.g.:
```
you are a sql assistant for a {engine} database. use only the schema below.
when a query answers the question, output exactly one statement in a ```sql fenced block.
do not invent tables or columns.

<existing buildSchemaContext stanzas>
```

## Verification

**Commands:**
- `bun test` -- expected: all suites pass, incl. new `run-raw-query`, `ConfirmRun`, updated `chat`, `chat-model`, `ChatTabView` tests (extraction cases, run/confirm/cancel/error paths, zero-rows/schema-only assertion)
- `bunx tsc --noEmit` -- expected: no type errors
- `grep -rE "from \"(ai|@ai-sdk/)" src/ui src/shared` -- expected: no matches (SDK confined to Ring 1)
- `grep -rn "shape:\s*\"raw\"" src/ui/workspace/ChatTabView.tsx` -- expected: no direct `execute` shaping in chat (it goes through the shared `runRawQuery`)

**Manual checks (if no CLI):**
- Connect to a DB, open a Chat tab, pick a provider, ask "how many rows in <table>?": an answer with a SQL block and a run button appears; running it shows rows like the query tab, and the RPC body carries no raw key and no row data on the outbound provider call.
- Ask something that yields a `DELETE`/`DROP`: clicking run shows the shared confirm dialog and nothing executes until confirm.

## Auto Run Result

Status: done

**Summary.** The AI chat now turns a natural-language question into a runnable query and executes it in place. The Core `chat.ask` responder prompts the model (schema-only, still the sole outbound caller) to emit one SQL statement in a fenced block; a pure Core `extractQuery` lifts it into a distinct `query` field on `ChatAskResult`. In the chat UI, an assistant message that carries a query renders the SQL read-only with a "run" action that sends the SQL **verbatim** through the existing guarded `execute` RPC (Story 3.1 executor) via a shared `runRawQuery` seam — reads auto-run and render rows via the same `DataGrid` the query tab uses; every non-read statement returns `confirmation_required` and surfaces a **shared** `ConfirmRun` dialog that only re-issues the identical request with `confirmed:true` after an explicit click. Outbound payload stays schema-only (`rowSample: null` — zero rows leave the machine). No streaming/reasoning (5.4), no sandbox/MDX (5.5/5.6), no row opt-in.

**Files changed:**
- `src/shared/contract.ts` -- `ChatAskResult` gains `query: string | null`; refreshed the `ChatProviderPayload` doc so it no longer attributes a row opt-in to this story
- `src/core/chat.ts` (+ test) -- pure `buildChatSystemPrompt` (SQL-emitting instruction + engine dialect + schema stanzas) and pure `extractQuery` (```sql, ```<lang>, or bare ``` fenced block; first-wins; `null` when absent); wired into `answer()`; payload stays schema-only
- `src/ui/workspace/run-raw-query.ts` (NEW, + test) -- `runRawQuery`/`RunOutcome` extracted into one shared, DOM-free execution seam
- `src/ui/workspace/ConfirmRun.tsx` (NEW, + test) -- shared presentational confirm dialog `{sql,risk,busy,onConfirm,onCancel}` extracted from the query tab's inline panel
- `src/ui/workspace/QueryTabView.tsx` (+ test) -- consumes the shared `runRawQuery`/`ConfirmRun` (pure refactor, no behavior change)
- `src/ui/workspace/chat-model.ts` (+ test) -- assistant `ChatMessage` + `appendAnswer` carry `query`
- `src/ui/workspace/ChatTabView.tsx` (+ test) -- `sendChat`/`SendOutcome` carry `query`; DOM-free `runChatQuery`/`confirmChatQuery`/`cancelChatQuery` drive transient per-message run state through the shared seam; a `ChatQueryRun` sub-component renders the SQL + run action, rows via `DataGrid`, an "N rows affected" line, the shared `ConfirmRun`, or an error banner; re-entrancy guarded
- `src/core/rpc.test.ts` -- stub `chat()` updated for the now-required `query` field

**Review findings.** 3 low patches applied (fence language-tag leak in `extractQuery`; `confirmChatQuery` now requires a pending confirm before a `confirmed:true` re-run — defense-in-depth on the destructive-confirm invariant; stale contract doc reworded off this story's row opt-in). 0 intent gaps, 0 bad_spec loopbacks, 0 deferred, 10 rejected as noise/by-design (chiefly: intent-blind extraction + confirm-gate is the spec's chosen safety model and the UI is forbidden to classify SQL, AR-3). Both reviewers confirmed the four trust invariants hold: provider key stays in Ring 1 (untouched by this diff), the outbound payload carries schema only (`rowSample: null`), `ai`/`@ai-sdk/*` stay confined to `src/core/`, and destructive/DDL statements route through the same guarded executor and never auto-execute.

**Verification.** `bunx tsc --noEmit` clean. `bun test` → 707 pass / 0 fail across 42 files. `grep -rE 'from "(ai|@ai-sdk/)' src/ui src/shared` → no matches (SDK confined to Ring 1). `grep -rn 'shape:\s*"raw"' src/ui/workspace/ChatTabView.tsx` → no matches (chat routes execution through the shared `runRawQuery`, never shaping `execute` directly).

**Residual risks.** The generated query targets the connect-time memoized schema (stale after DDL — the pre-existing `getSchema` memoization deferred by Story 5.2). Query extraction is intent-blind by design: a model's cautionary/example SQL in a fenced block still becomes a run affordance, but the confirm gate blocks any destructive execution and reads are Core-row-capped. An inline single-line fence that carries a bare language token (```postgres SELECT ...``` with no newline) is not stripped, but no current provider emits SQL that way. No follow-up review recommended — the three fixes are localized, low-consequence, and both reviewers confirmed all trust invariants hold.
