---
title: 'Generate reports from the chat — the chat emits a validated report spec that opens as a fully-editable Report tab'
type: 'feature'
created: '2026-07-18'
status: 'done'
baseline_revision: '306a5ca243e9f99faf04b22f5c7671c828cd4cfc'
final_revision: '09efd38489ca5438494b812a9901d45a0944a622'
review_loop_iteration: 0
followup_review_recommended: false
depends_on: ['9-2-report-shadcn-controls']
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-2-chat-qa-schema-only.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-3-nl-to-query-execution.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-6-1-build-report.md'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** The chat can already answer a schema question (Story 5.2), turn one NL question into a single runnable query with a run/confirm affordance (Story 5.3), and even render one inline chart in the Ring 3 sandbox (Story 5.6). But it CANNOT produce a *report* — the marquee "make me a report of revenue by country" workflow. The Report tab (`ReportTabView`, Story 6.1) is a full builder — ordered prose + query blocks, per-block SQL run through the guarded executor, in-app charts, snapshot/live-report export — but the ONLY way to populate one today is by hand. There is no bridge from "ask the chat" to "here is a Report tab you can view, re-run, and edit exactly like one you built yourself." The hard part is doing this without breaking the trust spine: the Core must stay the SOLE Provider caller and the SOLE risk gate (schema-only by default; every SQL runs through the guarded `execute`; no rows leave the machine), and a failure must degrade cleanly — never a half-built Report tab.

**Approach (end-to-end data flow):**

1. **Ask (Ring 2 → Core, unchanged seam).** The user asks the chat to build a report. `ChatTabView.send()` opens the SAME token-gated `POST /chat/stream` SSE stream via `streamChat` (`src/ui/rpc/rpc-stream.ts:60`). No new provider path, no new outbound caller — the chat's single streaming seam carries this.

2. **Generate (Core, sole Provider caller, schema-only).** `createChatResponder.answerStream` (`src/core/chat.ts:311`) runs the UNCHANGED schema-only prep pipeline (`prepareRequest`, `src/core/chat.ts:234` — `rowSample: null`, zero rows leave) and makes the one outbound `streamText` call. The system prompt (`buildChatSystemPrompt`, `src/core/chat.ts:87`) gains one additive stanza: *when the user asks for a report, emit exactly one ` ```report ` fenced JSON block* describing an ordered list of blocks (prose markdown + query SQL, optional chart intent, optional title) — mirroring the existing ` ```sql ` / ` ```chart ` fence instructions. The model never sees rows; it produces prose + SQL text only.

3. **Validate (Core, the spec gate).** At end-of-stream, alongside the existing `extractQuery(full)` (`src/core/chat.ts:107`), the Core runs a NEW pure `extractReport(full)` + `parseReportSpec(raw)` (new `src/shared/report-spec.ts`, Ring-neutral, mirroring `extractChartFence`/`parseChartSpec` in `src/shared/chart-spec.ts:60,83`). This yields a fully-validated `ReportSpec` (title + ordered blocks; each block a whitelisted `{kind:"prose", markdown}` or `{kind:"query", sql, chart?}`) or `null` when the fence is absent/malformed/fails validation. The validated `ReportSpec` (or `null`) is attached to the terminal `done` chunk (`src/core/chat.ts:372`; `ChatStreamChunk` `done` variant extended, `src/shared/contract.ts:550`). **Nothing is opened Core-side; the Core only validates and returns the typed spec.**

4. **Surface (Ring 2 chat).** `streamSend` (`src/ui/workspace/ChatTabView.tsx:93`) maps the `done` chunk's `report` onto its `answer` `SendOutcome` (`ChatTabView.tsx:75`); `appendAnswer` (`src/ui/workspace/chat-model.ts:118`) carries `report: ReportSpec | null` on the assistant `ChatMessage` (`chat-model.ts:32`). An assistant message with a non-null `report` renders an **"open in report tab"** action (beside the existing per-message affordances at `ChatTabView.tsx:855`). If `report` is `null` (no valid spec) the message renders as an ordinary prose answer with NO open action — degrade, open nothing.

5. **Build + open (Ring 2 → App reducer).** Clicking "open in report tab" calls a new `onOpenReport(spec)` threaded App → Workspace → TabContent → ChatTabView. In `App` (`src/ui/App.tsx`): read the id the reducer will mint (`const id = workspace.nextId`), `dispatch({type:"open", kind:"report"})`, then seed `reportStates[id] = reportStateFromSpec(spec)` (a NEW pure builder in `report-state.ts` that folds the spec through the EXISTING reducers `addProseBlock`/`addQueryBlock`/`updateProse`/`updateQuerySql`/`setBlockChart`). The Report tab mounts with prose filled and query blocks holding their SQL but **UNRUN** (`result: null`).

6. **View + edit (Ring 2, identical to hand-built).** Because the opened tab is a real `ReportState` in the real `ReportTabView` (`src/ui/report/ReportTabView.tsx:222`), the user gets EVERY affordance for free: run each query block (through the shared `runRawQuery` guarded seam, `src/ui/workspace/run-raw-query.ts:45`, which returns `confirmation_required` for any non-read statement → `ConfirmRun`), edit prose/SQL, toggle table/chart, reorder/remove, re-target, and export via the existing snapshot (`export-snapshot.ts`) and live-report (`export-live-report.ts`) paths. No new report-editing code — the whole edit surface is Story 6.1 + 9.2's shadcn controls, reused verbatim.

**Trust spine preserved throughout:** the ONLY outbound call is the Core's one `streamText` (schema-only); the report's SQL only ever executes locally through the guarded `execute` when the user runs a block; no result row is ever sent to the Provider.

## Boundaries & Constraints

**Always:**
- **The Core is the SOLE Provider caller.** Report generation is the SAME single `streamText` call inside `answerStream` — no new provider path, no `ai`/`@ai-sdk/*` import in Ring 2/3 (`grep -rE 'from "(ai|@ai-sdk/)" src/ui src/shared` stays empty). The UI opens only `POST /chat/stream` via `streamChat`.
- **Schema-only by default.** The outbound payload is unchanged: `assemblePayload` (`src/core/chat.ts:125`) keeps `schema` + `rowSample: null`; `ChatContextSummary.rowsIncluded` stays `0`. The model produces the report's prose + SQL from SCHEMA only — it never receives a row, and generating a report sends zero rows.
- **All SQL through the guarded executor.** Every query block in a generated report runs the IDENTICAL `{shape:"raw", sql}` request through `runRawQuery` → `execute` (`run-raw-query.ts:45`) that a hand-built report and the query tab use. The Core is the sole risk classifier (AR-3); the UI sends the model's SQL verbatim and never parses/splits/classifies it.
- **The report spec is Core-validated before it can open anything.** `parseReportSpec` (Ring-neutral, pure, total) is the gate: it coerces an untrusted model-authored JSON block to a typed `ReportSpec` or `null`, exactly as `parseChartSpec` does for charts. Only a fully-validated spec reaches the "open" affordance.
- **Reuse the existing seams, don't rebuild.** Build the `ReportState` from the spec through the EXISTING `report-state.ts` reducers (`addProseBlock`/`addQueryBlock`/`updateProse`/`updateQuerySql`/`setBlockChart`); open the tab through the EXISTING `openTab` (`workspace-state.ts:103`) + `reportStates` map (`App.tsx:341`) machinery, keyed by the reducer-minted tab id. The opened tab IS a `ReportTabView` — no parallel "chat report" viewer.
- **Session-only, never persisted.** A chat-generated report's `ReportState` rides the same `reportStates` map that is deliberately NEVER folded into `toWorkspaceSnapshot` (`App.tsx:337-350`); like every report and chat, its content never touches disk.
- **Mirror established patterns:** a pure Ring-neutral parse/validate module with a co-located `*.test.ts` (mirror `chart-spec.ts`); a pure `reportStateFromSpec` builder + `*.test.ts` (mirror `report-state.ts` reducers); the `done`-chunk field is additive and types-only.

**Block If:**
- A generated report's query block cannot be run through the EXISTING `runRawQuery`/`execute` guarded path without new Core plumbing (i.e. the guarded executor cannot be driven from a report block that originated in chat) — HALT `blocked`, condition `chat-generated report cannot reuse the guarded execute seam`. (Expected FALSE: Story 6.1 already runs report blocks through `runRawQuery`; this story only changes where the block's SQL text comes from.)
- Opening a Report tab with a prepared `ReportState` cannot be done without minting the tab id and seeding `reportStates` atomically enough to avoid a flash of an empty report — i.e. the `read-nextId → dispatch open → seed reportStates` seam (or a dedicated action) cannot guarantee the seeded state is present on the report tab's first mount — HALT `blocked`, condition `cannot seed reportStates for the newly-opened report tab deterministically`.

**Never:**
- **Never open a half-built Report tab on failure.** A provider error, an empty/whitespace answer, a missing ` ```report ` fence, or a spec that fails `parseReportSpec` opens NOTHING — the chat shows its normal answer or its normal error banner, and simply renders no "open report" action. The Report tab is opened ONLY from a fully-validated `ReportSpec`, and ONLY on the user's explicit "open" click (or the one deterministic auto-open path in the full slice) — never speculatively, never partially.
- **Never send row data to the Provider.** No result-row opt-in; `rowSample` stays `null`. Running a generated report's queries surfaces rows only into the trusted Ring 2 report surface, exactly as a hand-built report does.
- **Never auto-execute a destructive/DDL statement.** A generated query block runs only when the user clicks run (MVP) — and even then a non-read statement returns `confirmation_required` and stays unrun until an explicit confirm (the `ConfirmRun` gate, reused verbatim). No generation path auto-confirms anything.
- **Never let the UI classify the generated SQL for safety.** The report's SQL is sent verbatim to the Core; the guarded executor remains the only read-vs-mutate classifier (AR-3).
- No new outbound endpoint, no new `RpcErrorCode`, no second executor, no streaming-protocol rewrite (the `done` field is additive). No persistence of chat-generated report content to disk.
- No new provider/model/temperature knob and no multi-connection change — a generated report binds to the single active connection like every other report (its re-target picker from Story 6.2 still works post-open).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | "make a report of revenue by country"; provider configured, connection live | Core streams the answer + a terminal `done{report: <validated ReportSpec>}`; the assistant message shows an **"open in report tab"** action; clicking it opens a new Report tab whose prose is filled and whose query block(s) hold the generated SQL, UNRUN (`result:null`). Running a block executes through the guarded `execute` and renders rows exactly like a hand-built report | none |
| Prose-only answer (no report asked) | model emits no ` ```report ` fence | `done.report === null`; the message renders as an ordinary answer (Markdown), NO open action; nothing opens | none |
| Provider error / mid-stream throw | valid params, SDK throws (network/auth) | The existing redacted `error` chunk path fires; the chat shows its error banner; NO report action, NO tab opened; key never in any chunk | `internal_error`, redacted (existing) |
| Empty / zero-row query result | a generated block's SQL runs and returns 0 rows | The block renders an empty `DataGrid` (a valid empty result, not a failure) — identical to a hand-built block; report stays open and editable | not an error |
| Malformed / invalid report spec from the model | ` ```report ` fence present but JSON is broken, or a block is missing `sql`/`markdown`, or `blocks` is empty/not an array | `parseReportSpec` → `null` → `done.report === null`; NO open action. If the user explicitly asked for a report, a small inline note ("couldn't build a report from that — try rephrasing") MAY show, but NOTHING half-built opens | tolerated, degrade |
| SQL that triggers the confirm/guard | a generated query block's SQL is a `DELETE`/`UPDATE`/`DROP`/DDL | On run, `execute` returns `confirmation_required`; the shared `ConfirmRun` dialog shows `preview.{sql,risk}`; nothing executes until an explicit confirm re-issues the identical request with `confirmed:true` | — |
| Very large result | a generated block returns many rows | The Core row-cap applies (same executor); `runRawQuery` surfaces `truncated`; the block shows the "showing first N rows (truncated)" note — identical to Story 6.1 | truncation surfaced |
| Chart intent in the spec | a query block carries `chart:{mark,x,y}` naming columns not yet known (no result until run) | MVP: chart intent is NOT pre-validated (no columns yet) — the block opens `view:"table"`, `chart:null`; the user composes/validates a chart post-run via the existing `ChartSpecEditor`. Full slice: a deferred chart intent is validated against the result's columns after the first run (see Risk & Scope; step-02 decides the `ReportBlock` shape) | degrade to table |
| Two generated reports in a row | user asks twice, opens each | Each "open" mints a fresh tab id (`workspace.nextId`) and seeds its own `reportStates[id]`; the two reports are independent (mirrors per-tab isolation) | — |
| Tab closed before/while generating | user closes the chat tab mid-stream | The existing `mounted` guard drops the result; no tab opens; no orphaned `reportStates` entry (only seeded on an explicit open of a live chat) | — |

</intent-contract>

## Code Map

<!-- Anchors reconciled to the tree read on 2026-07-18 (step-02 investigation). All "confirm in step-02" open items from the draft are now RESOLVED and folded into Tasks/Design Notes. -->

- `src/shared/report-spec.ts` (**NEW**, + co-located `.test.ts`) — Ring-neutral (imports ONLY `type ChartSpec` + `MARK_KINDS` from `./chart-spec.ts`; no other deps). Define `ReportSpec` (`{ readonly title?: string; readonly blocks: ReadonlyArray<ReportSpecBlock> }`) and `ReportSpecBlock` (`{ readonly kind:"prose"; readonly markdown: string }` | `{ readonly kind:"query"; readonly sql: string; readonly chart?: ChartSpec }`). Export two pure/total functions mirroring `chart-spec.ts`: (1) `extractReport(text): { readonly markdown: string; readonly rawReport: unknown | null }` — copy `CHART_FENCE_RE` (`chart-spec.ts:47`) VERBATIM but retag `report` (`/```report[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/i`); on no match `{ markdown: text, rawReport: null }`; on match splice the fence out of `markdown` and `JSON.parse` the body in try/catch (`rawReport: null` on malformed); never throws. (2) `parseReportSpec(raw): ReportSpec | null` — total whitelist validate: `blocks` a NON-EMPTY array; each element a valid prose (`markdown` a non-empty string) or query (`sql` a non-empty string; optional `chart` a shape-only `ChartSpec` — `mark ∈ MARK_KINDS`, `x`/`y` non-empty strings, optional `series`/`title` non-null strings; NO column check — columns are unknown pre-run and are enforced at render by `mapChart`); optional `title` a non-null string bounded to a max length; bound `markdown` length. Any failure → `null`.
- `src/shared/contract.ts` — extend the `ChatStreamChunk` `done` variant (**line 550**) to `{ readonly type:"done"; readonly query: string | null; readonly report: ReportSpec | null; readonly context: ChatContextSummary }` (additive field; `import type { ReportSpec } from "./report-spec.ts"` — one-way, no cycle since `report-spec.ts` imports only from `chart-spec.ts`). Update the `done`-frame doc block (**~539-541**) to note it now also carries the Core-validated `report`. No other contract change (`WORKSPACE_TAB_KINDS` already has `report`, **line 717**).
- `src/core/chat.ts` — (1) `buildChatSystemPrompt` (**87-96**, sql stanza **91**, chart stanza **92-93**): add one array element instructing the model to emit exactly one ` ```report ` fenced JSON block (with the `{title?, blocks:[prose|query]}` schema) WHEN the user asks for a report — additive, alongside the existing ` ```sql `/` ```chart ` instructions. (2) `answerStream` terminal frame (**line 372**): change `yield { type:"done", query: extractQuery(full), context }` to also compute `report: parseReportSpec(extractReport(full).rawReport)` and include it. Extraction runs once over the fully-accumulated `full`, same as `extractQuery`. Payload assembly UNCHANGED (`assemblePayload`, `rowSample:null`, **125-131**). No key ever in the spec.
- `src/core/server.ts` — NO change. `chatStreamResponse` JSON-serializes whatever `ChatStreamChunk` the generator yields, so the widened `done` frame rides the existing SSE pump unchanged.
- `src/ui/rpc/rpc-stream.ts` — NO change. `parseFrame` `JSON.parse`s each frame into a `ChatStreamChunk`; the widened `done` shape flows through untouched.
- `src/ui/workspace/chat-model.ts` — assistant `ChatMessage` (**32-40**) gains `report: ReportSpec | null` (import `ReportSpec` alongside the existing `contract.ts` imports at **14-19**); `appendAnswer` (**118-129**) gains a `report` param threaded onto the pushed assistant object, mirroring `query`/`reasoning`. `emptyChatState`/other reducers unchanged.
- `src/ui/workspace/ChatTabView.tsx` — (1) `SendOutcome` `answer` variant (**75-83**) gains `report: ReportSpec | null`; `streamSend`'s `done` handling (**109-125**) reads `chunk.report` and carries it; when a report is present it strips the ` ```report ` fence from the displayed answer via `extractReport(partial.text).markdown` (so the bubble shows prose, not raw JSON) — mirror the existing `extractChartFence` strip. (2) `send`'s commit `appendAnswer(...)` (**669-672**) passes `outcome.report` in the new position. (3) Per-message display: extend the bubble-text derivation (the `{bubbleText,...}` helper at **259-275** that computes `extractChartFence(message.text).markdown`) to ALSO strip the report fence so raw JSON is never shown; render an "open in report tab" action for an assistant message with `m.report !== null`, mirroring the `m.query !== null` block at **855-866** and the raw `<button type="button">`+`Icon` pattern of `ChatQueryRun`'s "open in editor" button (**393-401**, aria-label style) — NOT a shadcn `Button` (ChatTabView imports only shadcn `Select`, **65**). Its `onClick` calls a NEW prop `onOpenReport(m.report)`. Add `onOpenReport?: (spec: ReportSpec) => void` to the inline props (**530-544**). A `null` report renders no action.
- `src/ui/report/report-state.ts` — add a pure/total `reportStateFromSpec(spec: ReportSpec): ReportState` that folds the spec into a fresh `emptyReport()` (**74**) via the EXISTING reducers, reading `nextId` before each add to know the minted id: an optional non-empty `spec.title` → a leading prose block (`addProseBlock` **79** + `updateProse` **116** with `\`# ${title}\``, since `ReportState` has no title field, **53**); each prose block → `addProseBlock`+`updateProse`; each query block → `addQueryBlock` (**85**) + `updateQuerySql` (**167**), and when the block carries a `chart` intent → `setBlockChart` (**177**) + `setBlockView(_, id, "chart")` (**172**) so the render-time `mapChart` guard validates it post-run; a chart-less query block stays `view:"table"`, `chart:null`. Co-located test. NO new `ReportBlock` field.
- `src/ui/App.tsx` — thread `onOpenReport` down and implement the atomic open seam. Add a handler near the other tab handlers (**~569-571**, beside `onOpen`/`onOpenSettings`/`onOpenCreateTable`):
  ```
  const onOpenReport = (spec: ReportSpec): void => {
    const id = workspace.nextId;                 // the id openTab mints (workspace-state.ts:116) — report is non-singleton, deterministic
    dispatch({ type: "open", kind: "report" });
    setReportStates((cur) => new Map(cur).set(id, reportStateFromSpec(spec)));  // cur is a ReadonlyMap (App.tsx:345)
  };
  ```
  React 18 batches the `dispatch` + `setReportStates` into ONE commit, so the newly-activated report tab (`openTab` sets `activeTabId=id`, **workspace-state.ts:124**) mounts with its seeded state already present — no empty-report first paint. Pass `onOpenReport` into `<Workspace>` (near **620-621**).
- `src/ui/workspace/Workspace.tsx` — thread `onOpenReport` App → `TabContent` for the active chat tab (mirror the `onOpen`/`onOpenSettings` prop threading at **248-252** and the `reportStates`/`onReportStateChange` threading at **276-278, 373-396**). Wiring only.
- `src/ui/workspace/TabContent.tsx` — thread `onOpenReport` into the `chat` branch (**544-556**) as a `ChatTabView` prop; add it to `TabContent`'s props interface (**~495-498**). No change to the `report` branch (**573-584**) — the generated tab renders the same `ReportTabView`.
- Tests to extend for the widened `done` variant + new `report` param — `src/ui/workspace/ChatTabView.test.tsx` (done stubs at **78,102,131,141**; `appendAnswer` calls at **459,478,493,508,523,540**), `src/ui/workspace/chat-model.test.ts` (done stub **131**; `appendAnswer` calls **75,90**), `src/core/chat.test.ts` (done stubs **193,208**), `src/ui/rpc/rpc-stream.test.ts` (`frame()` stubs **53,61,95,100**). Each `done` chunk must add `report: null` (or a spec) to compile.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/report-spec.ts` (**NEW**) -- define `ReportSpec`/`ReportSpecBlock`; implement pure `extractReport` (fence-split, mirror `CHART_FENCE_RE`) and total `parseReportSpec` (whitelist prose/query, non-empty `blocks`, shape-only optional `chart` via `MARK_KINDS`, bounded `title`/`markdown`) -- the Ring-neutral Core gate that coerces untrusted model JSON to a typed spec or `null`.
- [x] `src/shared/report-spec.test.ts` (**NEW**) -- unit-test the I/O matrix's parse edge cases: valid full spec (prose+query+chart+title) round-trips; no fence → `null`; malformed JSON → `null`; empty/non-array `blocks` → `null`; block missing `sql`/`markdown` → `null`; chart with a bad `mark` → chart dropped/`null` per rule; `extractReport` splices the fence out of `markdown`.
- [x] `src/shared/contract.ts` -- widen the `ChatStreamChunk` `done` variant with `report: ReportSpec | null` and import the type -- additive wire field carrying the Core-validated spec.
- [x] `src/core/chat.ts` -- add the ` ```report ` stanza to `buildChatSystemPrompt`; compute `report: parseReportSpec(extractReport(full).rawReport)` on the terminal `done` yield -- Core is the sole Provider caller AND the sole spec validator; payload stays `rowSample:null`.
- [x] `src/ui/workspace/chat-model.ts` -- add `report: ReportSpec | null` to the assistant `ChatMessage` and a `report` param to `appendAnswer` -- carries the spec onto the message, mirroring `query`.
- [x] `src/ui/workspace/ChatTabView.tsx` -- add `report` to `SendOutcome.answer`; read `chunk.report` in `streamSend` and strip the report fence from the shown answer; pass `outcome.report` to `appendAnswer`; render the "open in report tab" raw-`<button>`+`Icon` action for `m.report !== null` calling a new `onOpenReport` prop -- surfaces the spec and the single explicit open affordance; `null` opens nothing.
- [x] `src/ui/report/report-state.ts` -- add pure `reportStateFromSpec(spec): ReportState` folding title→leading prose, prose/query blocks, and chart intent (`setBlockChart`+`setBlockView("chart")`) through existing reducers -- builds the tab's state with NO new block field and NO new render logic.
- [x] `src/ui/report/report-state.test.ts` -- extend: `reportStateFromSpec` builds the right ordered blocks (prose markdown seeded, query SQL seeded + `result:null`/unrun, chart-carrying block `view:"chart"` with `chart` set, chart-less block `view:"table"`/`chart:null`, `title`→leading `# ` prose); ids monotonic from `emptyReport()`.
- [x] `src/ui/App.tsx` -- add the `onOpenReport` handler (`read nextId → dispatch open → seed reportStates`) and pass it to `<Workspace>` -- the atomic, batched open seam that seeds state before first mount.
- [x] `src/ui/workspace/Workspace.tsx`, `src/ui/workspace/TabContent.tsx` -- thread `onOpenReport` App → active chat tab's `ChatTabView` -- wiring only, mirroring the existing `onOpen`/report-state threading.
- [x] `src/ui/workspace/ChatTabView.test.tsx`, `src/ui/workspace/chat-model.test.ts`, `src/core/chat.test.ts`, `src/ui/rpc/rpc-stream.test.ts` -- add `report` to every `done`-chunk stub and the new `appendAnswer` positional arg; assert `streamSend`→`appendAnswer` carries `chunk.report` and a `null` report renders no open action -- keeps the widened `done` variant green.

**Acceptance Criteria:**
- Given an active connection and a configured provider, when the user asks the chat to build a report, then the Core makes the only outbound call (schema-only, `rowSample:null`), streams back an answer whose terminal `done` chunk carries a Core-validated `ReportSpec`, and the assistant message shows an "open in report tab" action.
- Given an assistant message carrying a valid `ReportSpec`, when the user clicks "open in report tab", then a new Report tab opens as a real `ReportTabView` with the generated prose filled and query block(s) holding their SQL unrun, seeded into the same per-tab `reportStates` entry a hand-built report uses (never persisted), with no empty-report flash on first mount.
- Given a generated Report tab, when the user runs a query block, then it executes through the SAME guarded `runRawQuery`/`execute` seam a hand-built report uses — a read auto-renders rows, a destructive/DDL statement surfaces the shared `ConfirmRun` dialog and stays unrun until confirmed — and no rows are ever sent to the Provider.
- Given a generated Report tab whose query block carried a chart intent, when the user runs the block, then the chart draws only if `mapChart` finds its x/y/series among the real result columns (numeric y), otherwise the block degrades to the table with the "pick valid x/y columns" prompt — never a broken chart; all other edit/reorder/re-target/export affordances behave identically to a hand-built report (Story 6.1 + 9.2 controls).
- Given a provider error, an empty/whitespace answer, a missing ` ```report ` fence, or a spec that fails `parseReportSpec`, when the response settles, then NO Report tab is opened (nothing half-built) and the chat degrades to its normal answer or error banner with no open action.
- Given the suite, when run, then `bunx tsc --noEmit` is clean, `bun test` is green (new `report-spec` + `reportStateFromSpec` tests plus updated `chat`/`chat-model`/`ChatTabView`/`rpc-stream` tests), `bun run build` is OK, and `grep -rE 'from "(ai|@ai-sdk/)" src/ui src/shared` finds no match.

## Spec Change Log

## Review Triage Log

### 2026-07-18 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 0
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[medium]` `[patch]` `report-spec.ts` — an explicit `chart: null` (a plausible "no chart" model output) was routed into `parseChartIntent(null) → null → whole-block reject → whole-spec `null``, so a valid report silently opened nothing. Fixed: `chart` absent OR `null` both yield a plain query block; only a present, non-null, malformed chart rejects. Test added.
  - `[medium]` `[patch]` `report-spec.ts` — `blocks` list was uncapped; a pathological/adversarial model could emit tens of thousands of blocks that fold into a main-thread-freezing `ReportState`. Added `MAX_BLOCKS` (100) magnitude guard mirroring the existing title/markdown bounds. Test added.
  - `[medium]` `[patch]` `workspace-state.test.ts` — the App open-seam's id-prediction (`id = workspace.nextId` → seed `reportStates[id]`) was the single most coupling-sensitive line with no coverage; a future `openTab`/singleton change would break it silently (report tab mounts empty). Added a pure invariant test pinning `openTab(_, "report")` mints exactly `nextId`, activates it, and increments.
  - `[low]` `[patch]` `chat.ts` — a report answer that ALSO carried a standalone ` ```sql ` fence, or a malformed/unterminated ` ```report ` fence, could surface a spurious "run query" affordance (raw JSON or a stray query) beside "open report". Fixed: suppress `done.query` whenever the answer attempted a report fence (`hasReportFence`, new export), so a report is its own answer type. Tests added.
  - `[low]` `[patch]` `report-spec.ts` — `sql` length was unbounded (unlike prose markdown). Added `MAX_SQL_LENGTH` (20000) bound. Test added.
  - `[low]` `[patch]` `report-spec.ts` — `extractReport` handed an unbounded fence body to `JSON.parse` (event-loop risk). Added a `MAX_REPORT_BODY_LENGTH` (200000) guard before parse; the fence is still stripped from the shown markdown. Test added.
  - `[low]` `[patch]` `report-spec.ts` — a whitespace-only title was accepted by the validator but silently discarded by the builder, and a multiline title folded into multiple ` # ` headings. Fixed: the validator now trims + collapses internal whitespace (incl. newlines) and treats a whitespace-only title as absent, making the validated spec the single source of truth. Tests added.
  - `[low]` `[patch]` `ChatTabView.tsx` — the "open in report tab" button rendered even when `onOpenReport` was undefined (a dead control if ever mounted unthreaded). Gated the button on `onOpenReport !== undefined`.
  - `[low]` `[patch]` `ChatTabView.tsx` — the `m.report as ReportSpec` cast defeated the type checker in the click closure. Hoisted `m.report` to a narrowed `const reportSpec`, removing the cast.
- rejected (recorded for transparency, not actioned):
  - `[low]` a model emitting TWO ` ```report ` fences leaves the second as raw JSON in the bubble. REJECTED: the model is instructed to emit exactly one; this mirrors the accepted existing single-fence behavior of ` ```chart ` (Blind Hunter itself noted the consistency), and the query-suppression fix removes any mis-capture risk.
  - `[low]` two `onOpenReport` calls in one React batch could reuse a stale `nextId`. REJECTED: unreachable via real interaction — each user click is a distinct DOM event → distinct React batch that commits `nextId` before the next click reads it; the "two reports in a row" I/O row holds for sequential clicks.
  - `[low]` chart-intent blocks open `view:"chart"` with `result:null` (feared empty-chart placeholder) and no seeded target connection. REJECTED (verified): pre-run neither the table nor chart render gate fires (both require `result !== null`), so only the SQL + run control shows — no empty placeholder; and `emptyReport()`'s `targetConnectionId: null` IS the default/boot connection, so blocks run exactly like a hand-built report.

### 2026-07-18 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 0
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` `chat.ts` — the terminal `done` frame suppressed `done.query` whenever the answer merely ATTEMPTED a ` ```report ` fence (`hasReportFence`), even when that report FAILED validation (`report === null`). A model that abandoned/mangled a report AND emitted a genuinely separate, runnable ` ```sql ` block lost BOTH affordances — the user could neither open a report nor run the valid query. Fixed: gate suppression on a VALID report (`report !== null`) instead — a valid report is still its own answer type (query suppressed), but a failed report attempt no longer swallows a real query. Removed the now-unused `hasReportFence` import from `chat.ts` (still exported/tested in `report-spec.ts`). This also dissolves the reviewers' "` ```report ` inside an example block false-positively suppresses a real query" concern. Test added (`chat.test.ts`).
  - `[low]` `[patch]` `ChatTabView.tsx` — `decideMessageView` — a report-ONLY answer (a bare ` ```report ` fence with no surrounding prose) strips to an empty string, so a blank prose bubble rendered beside the "open in report tab" action. Fixed: suppress the bubble when a message has a non-null `report` and its stripped body is blank (`chartDoc === null && !reportOnlyBlank`); a report answer WITH prose still shows the stripped prose. Tests added (`ChatTabView.test.tsx`).
- rejected (recorded for transparency, not actioned):
  - `[low]` an UNTERMINATED ` ```report ` fence leaves partial raw JSON in the bubble (strip is gated on `report !== null`; `REPORT_FENCE_RE` needs a close). REJECTED: cosmetic and only on a mid-report stream truncation; mirrors the already-accepted ` ```chart `/second-` ```report `-fence single-fence behavior. The query-suppression edge it was bundled with is separately fixed above.
  - `[low]` a second ` ```report ` fence's raw JSON leaks into the bubble. REJECTED: duplicate of the prior pass's already-rejected single-fence finding (model instructed to emit exactly one).
  - `[low]` double-click / same-tick double-open of the report action races on `workspace.nextId` (empty second tab). REJECTED: duplicate of the prior pass's already-rejected batched-double-open finding — discrete click events flush synchronously in React 18, so each click reads a freshly-committed `nextId`.
  - `[low]` the App id-prediction (`id = workspace.nextId`) couples to `openTab` internals; a future singleton-ization of `report` would seed the wrong id. REJECTED: latent-by-design and already pinned by the invariant test `workspace-state.test.ts` added in the prior pass.
  - `[low]` re-targeting a freshly-opened chat report mass-fires every populated SQL block. REJECTED: pre-existing Story 6.2 re-target semantics (fire all populated blocks); destructive statements still stall on `ConfirmRun`; rows stay on the guarded local seam. Not a defect of this story.
  - `[low]` per-field caps (`MAX_BLOCKS`×`MAX_MARKDOWN`) don't bound the aggregate (~2 MB possible). REJECTED: speculative; the per-field magnitude guards already bound each dimension, a maximal spec is an adversarial/broken-model edge, and a one-time fold on an explicit user click is tolerable.
  - `[low]` `parseReportSpec` validates SHAPE not SQL SAFETY. REJECTED: by design — the guarded `execute` + `ConfirmRun` run seam is the sole risk classifier (AR-3); mirrors user-typed SQL.
  - `[low]` title-emptiness logic is duplicated in `parseReportSpec` and `reportStateFromSpec`. REJECTED: not dead — `reportStateFromSpec` is a pure function unit-tested independently with a raw whitespace title, so it must keep its own guard to stay total.
  - `[low]` a chart `title` is length-bounded but not newline-collapsed (unlike the report title). REJECTED: no consequence — a chart title is not markdown-folded into `# ` headings (the report title is, which is why only IT collapses newlines); newlines in a chart title are cosmetic at worst.
  - `[low]` `MAX_TITLE_LENGTH` is checked against the raw pre-normalization string. REJECTED: rejecting a 201-char (mostly-whitespace) title is pathological input; conservative rejection is safe and reordering the check risks its own edges.
  - `[low]` the UI consumes the cross-boundary `report` object without re-validation. REJECTED: intended trust model — the Core is the sole validator/root; `mapChart` still re-guards charts at render.
  - `[low]` `appendAnswer` now takes six positional args (transposition risk). REJECTED: pre-existing positional pattern (not introduced by this story); a maintainability nit, not a defect — an options-object refactor is out of scope.

## Design Notes

- **Chart intent is applied, not deferred — and it is render-guard-safe (resolves the draft's highest-risk open item).** The draft weighed an MVP (table-only) vs a "full slice" that it feared needed a NEW `pendingChart` field + new render logic. Step-02 disproved that fear: `ReportBlock.chart` is already `ChartSpec | null` and the render path's `mapChart` (`ReportTabView.tsx:680`) ALREADY re-validates `chart.x`/`.y`/`.series` against the actual result column set (and requires a numeric y) on every render, returning `null` → the existing "pick valid x/y columns to draw a chart — showing the table meanwhile" degrade (`ReportTabView.tsx:757-766`). So `reportStateFromSpec` can seed a model-suggested chart directly (`setBlockChart` + `view:"chart"`) with **zero new state or render code**: pre-run (`result:null`) neither table nor chart renders (just SQL+run); post-run the guard draws it on a column match and degrades gracefully on a mismatch. This honors the intent-contract's `{kind:"query", sql, chart?}` block shape with no dead/validated-but-unused field, and can never open a half-built chart.
- **The open seam is deterministic and flash-free (resolves the second open item).** `openTab` assigns `id = state.nextId` with no randomness and no reroute for the non-singleton `report` kind (`workspace-state.ts:116`), and sets `activeTabId = id` (**:124**). Reading `const id = workspace.nextId` in the click handler predicts the minted id exactly, because the single `open` dispatch's base state IS the committed `workspace` the closure read from. `dispatch(open)` + `setReportStates(cur => new Map(cur).set(id, built))` run synchronously in one handler → React 18 batches them into one commit where `activeTabId===id` AND `reportStates.get(id)===built`, so `ReportTabView` mounts with `state={built}`, never `emptyReport()`. Guard-rails baked into the task: exactly ONE id-minting dispatch in the handler, and the seed stays synchronous (no `setTimeout`/async) so `workspace.nextId` can't go stale.
- **Fence stripping mirrors charts.** `extractReport` returns `{ markdown, rawReport }` exactly like `extractChartFence`; the Core validates `rawReport`, and ChatTabView's bubble-text derivation strips the ` ```report ` fence (as it already strips ` ```chart `) so the user sees the prose + an "open report" button, not raw JSON.
- **Title has no `ReportState` home, so it becomes content.** `ReportState` is `{blocks, nextId, targetConnectionId}` (**report-state.ts:53**) — no title field. A non-empty `spec.title` is folded into a leading prose block (`# {title}`), consuming it honestly rather than dropping it or inventing a schema field.
- **`reportStateFromSpec` golden shape** (pure/total fold; read `nextId` before each add to know the minted id):
  ```ts
  export function reportStateFromSpec(spec: ReportSpec): ReportState {
    let s = emptyReport();
    if (spec.title !== undefined && spec.title.trim() !== "") {
      const id = s.nextId; s = updateProse(addProseBlock(s), id, `# ${spec.title}`);
    }
    for (const b of spec.blocks) {
      const id = s.nextId;
      if (b.kind === "prose") { s = updateProse(addProseBlock(s), id, b.markdown); }
      else {
        s = updateQuerySql(addQueryBlock(s), id, b.sql);
        if (b.chart !== undefined) s = setBlockView(setBlockChart(s, id, b.chart), id, "chart");
      }
    }
    return s;
  }
  ```
- **No `ReportSpec`/`LiveReportDoc` collision.** `ReportSpec` is a free name (grep-empty in `src/`); the export-time `LiveReportDoc` (Story 6.4) is a distinct type in `src/shared/live-report.ts` and is untouched.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors. The widened `ChatStreamChunk` `done` variant turns every `done`-chunk producer/consumer (`chat.ts`, the four test stub sites, `streamSend`) into a compile error until each supplies/handles `report`; tsc pinpoints each.
- `bun test` -- expected: full suite green, incl. new `src/shared/report-spec.test.ts` (extract + validate matrix) and `report-state.test.ts` additions (`reportStateFromSpec` ordered blocks, unrun queries, chart seeding, title-as-prose); updated `chat`/`chat-model`/`ChatTabView`/`rpc-stream` tests (the `done.report` field maps `streamSend`→`appendAnswer`; a null report renders no open action).
- `bun run build` -- expected: OK; UI bundle rebuilt (regenerates the gitignored `*-bundle.generated.ts`), sandbox bundle unaffected (no Ring 3 change).
- `grep -rE 'from "(ai|@ai-sdk/)" src/ui src/shared` -- expected: no match (SDK confined to Ring 1; the report path adds no provider import to Ring 2/3).

**Live check (against the seeded DB, per the epic's fidelity gate):**
- Launch against the seeded database, open a Chat tab, pick a configured provider, and ask "make a report of revenue by country". Confirm an assistant answer appears (prose, no raw JSON) with an "open in report tab" action; clicking it opens a Report tab with prose + a query block holding the generated SQL. Run the block → rows render like a hand-built report; the outbound stream body carried no rows and no key. Toggle/compose a chart, edit prose, and export a snapshot — all identical to a hand-built report.
- Ask a question that yields NO report (e.g. a plain "how many tables are there?") → the answer shows, with NO open action and no tab opened.

## Auto Run Result

Status: **done**

**Summary of implemented change.** The AI chat can now generate a report end-to-end without breaking the trust spine. The Core system prompt gained one additive ` ```report ` stanza; at end-of-stream the Core validates the model's fenced JSON through a new Ring-neutral `report-spec.ts` (`extractReport` + total `parseReportSpec`) and attaches a `ReportSpec | null` to the streaming `done` chunk — the sole Provider call and payload stay schema-only (`rowSample:null`). The chat surfaces a single explicit "open in report tab" action for a validated spec; clicking it folds the spec into a real `ReportState` via a new pure `reportStateFromSpec` and opens a normal editable `ReportTabView` (seeded atomically into the App's session-only `reportStates` map — never persisted). Every downstream affordance (per-block run through the guarded `runRawQuery`/`execute` seam with the `ConfirmRun` gate, edit, chart-compose, re-target, snapshot/live export) is Story 6.1 + 9.2 reused verbatim. A failure (provider error, no/malformed fence, invalid spec) opens nothing — the chat degrades to its normal answer or error banner.

**Files changed.**
- `src/shared/report-spec.ts` (NEW) — `ReportSpec`/`ReportSpecBlock` types; pure `extractReport` (mirrors `extractChartFence`), total `parseReportSpec` (whitelist prose/query, non-empty + `MAX_BLOCKS`-capped `blocks`, shape-only optional chart, bounded sql/markdown/title/body, normalized title), and `hasReportFence`.
- `src/shared/report-spec.test.ts` (NEW) — extract/validate matrix incl. the review-added guards (chart:null, block/sql/body caps, title normalization, `hasReportFence`).
- `src/shared/contract.ts` — `ChatStreamChunk` `done` variant widened with `report: ReportSpec | null`.
- `src/core/chat.ts` — ` ```report ` prompt stanza; terminal `done` computes the validated `report` and suppresses `query` on any report-fence attempt (`hasReportFence`) so a report answer never doubles as a runnable query.
- `src/core/chat.test.ts` — `report` on `done` stubs; report round-trip / malformed / prose-only / report-with-standalone-sql (query-suppression) cases.
- `src/ui/workspace/chat-model.ts` — assistant `ChatMessage` + `appendAnswer` carry `report`.
- `src/ui/workspace/ChatTabView.tsx` — `SendOutcome`/`streamSend` carry `report` and strip the report fence from the shown bubble; hoisted-const, handler-gated, cast-free "open in report tab" button.
- `src/ui/report/report-state.ts` — pure `reportStateFromSpec` (title→leading prose, prose/query folds, chart intent → `setBlockChart`+`view:"chart"`; no new `ReportBlock` field).
- `src/ui/report/report-state.test.ts` — `reportStateFromSpec` ordered blocks / unrun / chart-seeded / title cases.
- `src/ui/App.tsx` — atomic `onOpenReport` open seam (read `nextId` → dispatch open → seed `reportStates`).
- `src/ui/workspace/Workspace.tsx`, `TabContent.tsx` — thread `onOpenReport` to the active chat tab (wiring).
- `src/ui/workspace/workspace-state.test.ts` — invariant test pinning the App id-prediction (`openTab(_, "report")` mints `nextId`).
- `src/ui/rpc/rpc-stream.test.ts`, `src/ui/workspace/chat-model.test.ts` — `report` on `done`/`appendAnswer` stubs.

**Review findings breakdown.** 2 reviewers (Blind Hunter + Edge Case Hunter), opus. No trust-boundary/ring leak (grep clean; report SQL stays on the guarded seam; zero rows leave). Deduped to 12 findings → **9 patches applied** (3 medium: chart:null-drops-spec, uncapped-block-count, untested-id-coupling; 6 low: query-suppression, sql cap, parse-body cap, title normalization, button handler-gate, cast removal), **0 deferred**, **3 rejected** (all low: second-report-fence cosmetic, unreachable batched double-open, chart-view UX verified-fine). **0 bad_spec / 0 intent_gap** — no spec loopback. Full detail in the Review Triage Log.

**Verification performed (final).**
- `bunx tsc --noEmit` → clean (exit 0).
- `bun test` → **1304 pass, 0 fail**, 3207 expect() calls across 73 files. (The `[rpc] handler 'execute' threw: relation "secret" does not exist` and `[chat] provider stream failed: … ***` lines are expected error-path test logs, not failures.)
- `bun run build` → OK (regenerated the four gitignored `*-bundle.generated.ts`).
- `grep -rE 'from "(ai|@ai-sdk/)" src/ui src/shared` → no match.

**Follow-up review recommendation:** `true` — 9 review-driven patches including two behavior-affecting changes (report-fence query suppression; accepting `chart:null` as "no chart") and three medium-severity fixes across the parse/validate + open-seam surface; the volume and behavior/validation impact warrant one independent follow-up pass despite each fix being tested.

**Residual risks.** Report *quality* is model-dependent (a weak model may emit a malformed or empty ` ```report ` block) — contained by `parseReportSpec → null → open nothing`, so it degrades but a user may not get what they asked for. A model that emits two ` ```report ` fences (or an unterminated one on a truncated stream) leaves raw JSON in the bubble (cosmetic, mirrors the accepted ` ```chart ` single-fence behavior). The App open seam's id-prediction is now pinned by a unit test, but remains a convention (not enforced by the type system) that a future singleton-izing of the `report` kind would break.

---

**Follow-up review pass (2026-07-18).** An independent adversarial + edge-case review pass ran against the full baseline→HEAD diff. Two reviewers (Blind Hunter + Edge Case Hunter, opus). Deduped to ~14 findings → **2 patches applied**, **0 deferred**, **12 rejected** (all low; several duplicates of prior-pass rejections). Trust spine re-verified: Core stays the sole Provider caller, payload schema-only (`rowSample:null`), report SQL only on the guarded seam, grep for `ai`/`@ai-sdk` imports in Ring 2/3 clean.
- `[medium]` `[patch]` `chat.ts` — query-affordance suppression re-gated from `hasReportFence` (any fence attempt) to `report !== null` (a VALID report only), so a failed report attempt no longer swallows a genuinely runnable standalone ` ```sql ` block. Unused `hasReportFence` import dropped from `chat.ts`. Test added.
- `[low]` `[patch]` `ChatTabView.tsx` — `decideMessageView` now suppresses the empty prose bubble for a report-ONLY answer (bare fence, no prose). Tests added.

**Verification (follow-up).** `bunx tsc --noEmit` → clean; `bun test` → **1307 pass, 0 fail** (3214 expect() across 73 files); `bun run build` → OK; `grep -rE 'from "(ai|@ai-sdk/)"' src/ui src/shared` → no match. `followup_review_recommended` set to `false` — the two fixes are localized and test-covered (one behavior change in the Core `done` frame, one cosmetic UI guard), with no trust-spine, payload, executor, or API surface change.
