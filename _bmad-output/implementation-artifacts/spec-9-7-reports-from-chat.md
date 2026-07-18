---
title: 'Generate reports from the chat — the chat emits a validated report spec that opens as a fully-editable Report tab'
type: 'feature'
created: '2026-07-18'
status: 'draft'
depends_on: ['9-2-report-shadcn-controls']
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-2-chat-qa-schema-only.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-3-nl-to-query-execution.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-6-1-build-report.md'
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

## Acceptance Criteria

- **Given** an active connection and a configured provider, **when** the user asks the chat to build a report, **then** the Core makes the only outbound call (schema-only, `rowSample:null`), streams back an answer whose terminal `done` chunk carries a Core-validated `ReportSpec`, and the assistant message shows an "open in report tab" action.
- **Given** an assistant message carrying a valid `ReportSpec`, **when** the user clicks "open in report tab", **then** a new Report tab opens as a real `ReportTabView` with the generated prose filled and query block(s) holding their SQL unrun, and it is the same per-tab-isolated `reportStates` entry a hand-built report uses (never persisted).
- **Given** a generated Report tab, **when** the user runs a query block, **then** it executes through the SAME guarded `runRawQuery`/`execute` seam a hand-built report uses — a read auto-renders rows, a destructive/DDL statement surfaces the shared `ConfirmRun` dialog and stays unrun until confirmed — and no rows are ever sent to the Provider.
- **Given** a generated Report tab, **when** the user edits prose/SQL, toggles table/chart, reorders/removes blocks, re-targets, or exports (snapshot / live report), **then** every affordance behaves identically to a hand-built report (Story 6.1 + 9.2 controls, reused verbatim).
- **Given** a provider error, an empty/whitespace answer, a missing ` ```report ` fence, or a spec that fails `parseReportSpec`, **when** the response settles, **then** NO Report tab is opened (nothing half-built) and the chat degrades to its normal answer or error banner.
- **Given** the suite, **when** run, **then** `bunx tsc --noEmit` is clean, `bun test` is green (new `report-spec` + `reportStateFromSpec` tests plus updated `chat`/`chat-model`/`ChatTabView` tests), `bun run build` is OK, and `grep -rE 'from "(ai|@ai-sdk/)" src/ui src/shared` finds no match.

## Code Map

<!-- step-02 owns the exact new-type field names and the App open-seam shape; anchors below are current-tree locations. Where the design is genuinely open it says "confirm in step-02". -->

- `src/shared/report-spec.ts` (**NEW**, + `.test.ts`) — Ring-neutral, dependency-free (mirror `chart-spec.ts`). Define `ReportSpec` (`{ title?: string; blocks: ReadonlyArray<ReportSpecBlock> }`) and `ReportSpecBlock` (`{kind:"prose"; markdown:string}` | `{kind:"query"; sql:string; chart?: {mark,x,y,series?,title?}}`). Export pure `extractReport(text): unknown | null` (first line-anchored ` ```report ` fenced JSON block → `JSON.parse` or `null`; copy `chart-spec.ts:47` `CHART_FENCE_RE` verbatim, retag `report`) and `parseReportSpec(raw): ReportSpec | null` (total whitelist validate: `blocks` a non-empty array; each block a valid prose or query shape; SQL/markdown non-empty strings; the optional `chart` kept as a RAW intent — NOT `parseChartSpec`-validated here, since result columns are unknown pre-run; bound title/markdown length). **Placement rationale:** shared so Core validates and Ring 2 consumes the SAME types; carries no rows, no code, no key by construction.
- `src/shared/contract.ts` — extend the `ChatStreamChunk` `done` variant (**line 550**) to `{ type:"done"; query: string | null; report: ReportSpec | null; context: ChatContextSummary }` (additive field; import `ReportSpec` from `report-spec.ts`). Update the `ChatStreamChunk` doc block (**531-546**) to note the `done` frame now also carries the Core-validated `report`. No other contract change (`WORKSPACE_TAB_KINDS` already has `report`, **717**).
- `src/core/chat.ts` — (1) `buildChatSystemPrompt` (**87-97**): add one stanza instructing the model to emit exactly one ` ```report ` fenced JSON block (with the block schema) WHEN the user asks for a report — additive, alongside the existing ` ```sql `/` ```chart ` instructions. (2) `answerStream` terminal frame (**372**): compute `const report = parseReportSpec(extractReport(full))` and include it on the `done` chunk. Extraction runs once over the fully-accumulated answer, same as `extractQuery`. Payload assembly UNCHANGED (`rowSample:null`). No key ever in the spec.
- `src/core/server.ts` — NO change. `chatStreamResponse` (**374**) JSON-serializes whatever `ChatStreamChunk` the generator yields, so the widened `done` frame rides the existing SSE pump unchanged.
- `src/ui/rpc/rpc-stream.ts` — NO change. `parseFrame` (**42**) `JSON.parse`s each frame into a `ChatStreamChunk`; the widened `done` shape flows through untouched.
- `src/ui/workspace/chat-model.ts` — assistant `ChatMessage` (**32-40**) gains `report: ReportSpec | null`; `appendAnswer` (**118-129**) threads it (new param, mirror `query`/`reasoning`). `emptyChatState`/reducers otherwise unchanged.
- `src/ui/workspace/ChatTabView.tsx` — (1) `SendOutcome` `answer` variant (**75-83**) gains `report: ReportSpec | null`; `streamSend` (**93-134**) reads `chunk.report` on `done` and carries it. (2) `send`'s commit (**671**) passes `outcome.report` to `appendAnswer`. (3) Render: for an assistant message with `m.report !== null`, show an "open in report tab" action (near the per-message affordance row **855-887** / action group **890**) whose `onClick` calls a NEW prop `onOpenReport(m.report)`. Add `onOpenReport?: (spec: ReportSpec) => void` to `ChatTabView`'s props (**530-544**). A `null` report renders no action. (Confirm in step-02: exact placement/label of the button within the neutral action chrome — this is where 9.2's shadcn `Button` is reused.)
- `src/ui/report/report-state.ts` — add a pure `reportStateFromSpec(spec: ReportSpec): ReportState` that folds the spec into a fresh `emptyReport()` (**74**) via the EXISTING reducers: for each block, `addProseBlock`+`updateProse` (**79,116**) or `addQueryBlock`+`updateQuerySql` (**85,167**); MVP leaves `view:"table"`, `chart:null` (chart intent deferred — see Risk & Scope). Pure/total, co-located test. (Confirm in step-02: whether a query block also seeds `view:"chart"`+a validated `chart` — needs the deferred-intent decision below.)
- `src/ui/App.tsx` — thread `onOpenReport` down and implement the open seam. Add a handler (near the other tab handlers, **565-602**):
  ```
  const onOpenReport = (spec: ReportSpec): void => {
    const id = workspace.nextId;               // the id openTab will mint (workspace-state.ts:108)
    dispatch({ type: "open", kind: "report" });
    setReportStates((cur) => new Map(cur).set(id, reportStateFromSpec(spec)));
  };
  ```
  Pass `onOpenReport` into `<Workspace>` (**563-629**). **Confirm in step-02:** the `read-workspace.nextId` approach relies on `openTab` assigning `id = state.nextId` deterministically (it does, `workspace-state.ts:108`); the alternative is a dedicated `WorkspaceAction`/reducer variant that returns the new id — but the reducer cannot touch the React-held `reportStates` map, so the App-level seam is preferred. Whichever is chosen, the seeded `reportStates[id]` MUST be present on the report tab's first mount (no empty-report flash).
- `src/ui/workspace/Workspace.tsx` — thread `onOpenReport` App → `TabContent` (mirror the `onOpen`/`onOpenSettings` prop threading, **95-104, 205-263, 309-317**; and the `reportStates`/`onReportStateChange` threading at **219-263, 390-392**). Wiring only.
- `src/ui/workspace/TabContent.tsx` — thread `onOpenReport` into the `chat` branch (**534-546**) as a `ChatTabView` prop; add it to `TabContent`'s props interface (**456-499**). No change to the `report` branch (**563-574**) — the generated tab renders the same `ReportTabView`.
- `src/ui/workspace/ChatTabView.test.tsx`, `src/core/chat.test.ts`, `src/ui/workspace/chat-model.test.ts` — extend for the new `report` field (stub `done` frames with/without a spec; `streamSend`/`appendAnswer` carry it). `src/core/rpc.test.ts` / any `done`-chunk stub — add the now-required `report` field.

## Risk & Scope

**This is the largest story in the epic.** It threads a new artifact (`ReportSpec`) across Ring 1 (validate) → wire (`done` chunk) → Ring 2 (build state) → the App reducer/`reportStates` open seam, and it must not perturb the chat's streaming trust spine. Honest risk register:

- **Highest risk — the chart intent.** `parseChartSpec` validates `x`/`y`/`series` against the RESULT's column names, but a generated report's query has NO result until the user runs it, so the model's chart intent can't be validated at build time. Two honest options: **(a) MVP** — generated reports carry prose + query blocks in `view:"table"`, `chart:null`; the user composes charts post-run with the existing `ChartSpecEditor` (zero schema change, fully honest). **(b) Full** — add a deferred `pendingChart` intent field to the `ReportBlock` query variant (`report-state.ts:36-50`) that `ReportTabView` validates against the result's columns on the first run and promotes to a real `chart`. Option (b) is NEW state + new render logic and could force `deferred` on the chart sub-scope. **step-02 decides**; the MVP does NOT block the story.
- **The open seam.** Seeding `reportStates[id]` for a reducer-minted tab id relies on `workspace.nextId` being the id `openTab` assigns. It is (deterministic, `workspace-state.ts:108`), but a concurrent dispatch between read and open would desync. Low risk (single click, synchronous), but a `deferred`/`blocked` trigger if step-02 finds React batching makes the seed land after an empty-report first paint.
- **Prompt reliability.** The model may emit a malformed or empty ` ```report ` block, or ignore the instruction. This is *contained* by `parseReportSpec` → `null` → open nothing; it degrades, never breaks. Not a blocker, but the "did the user get what they asked for" quality is model-dependent.
- **Auto-run vs. open-unrun.** MVP opens query blocks UNRUN (user clicks run — gets guarded/confirm gating for free, and "opens nothing half-built" is literally true). Auto-running read blocks on open is a nicety deferred to a second slice; if added it MUST still go through `runRawQuery` so destructive SQL hits the confirm gate.

**Minimal viable slice (land SOMETHING even if full scope is too big):**
1. **Slice 1 (target):** chat emits a ` ```report ` spec → Core validates → `done.report` → "open in report tab" builds a `ReportState` (prose + query blocks, table view, unrun) and opens a real editable Report tab. Full view/edit/run/export come free from Story 6.1 + 9.2. **This alone satisfies the story's core.**
2. **Slice 2 (if scope allows):** deferred chart intent validated post-run (Option (b)), and/or auto-run of read blocks on open.

If Slice 1's open seam or spec plumbing proves intractable, HALT `blocked` per the Block-If conditions rather than shipping a half-wired path.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors. The widened `ChatStreamChunk` `done` variant makes every `done`-chunk producer/consumer (`chat.ts`, `chat.test.ts`, `rpc.test.ts` stubs, `streamSend`) a compile error until each supplies/handles `report`; tsc pinpoints each.
- `bun test` — expected: full suite green, incl. new `src/shared/report-spec.test.ts` (extract + validate: valid spec, no fence → null, malformed JSON → null, empty/`non-array` blocks → null, missing `sql`/`markdown` → null) and `report-state.test.ts` additions (`reportStateFromSpec` builds the right ordered blocks with SQL/prose seeded, unrun); updated `chat`/`chat-model`/`ChatTabView` tests (the `done.report` field maps through `streamSend`→`appendAnswer`; a null report renders no open action).
- `bun run build` — expected: OK; UI bundle rebuilt, sandbox bundle unaffected (no Ring 3 change).
- `grep -rE 'from "(ai|@ai-sdk/)" src/ui src/shared` — expected: no match (SDK confined to Ring 1; the report path adds no provider import to Ring 2/3).

**Live check (against the seeded DB, per the epic's fidelity gate):**
- Launch against the seeded database, open a Chat tab, pick a configured provider, and ask "make a report of revenue by country". Confirm an assistant answer appears with an "open in report tab" action; clicking it opens a Report tab with prose + a query block holding the generated SQL. Run the block → rows render like a hand-built report; the outbound stream body carried no rows and no key. Edit the prose, toggle the block to a chart, and export a snapshot — all identical to a hand-built report.
- Ask a question that yields NO report (e.g. a plain "how many tables are there?") → the answer shows, with NO open action and no tab opened.
