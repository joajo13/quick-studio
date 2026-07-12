---
title: 'Export a Report as a Live Report'
type: 'feature'
created: '2026-07-12'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'a646163ba917a308f8e5d0a2c60c99b97057d22f'
final_revision: '9dac7e2b3fc9120cabb66f8ce7919dc3a306a087'
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** A Report can be assembled (6.1), re-targeted (6.2), and frozen into a static Snapshot (6.3) — but there is no export that stays *current*. FR-19/UJ-4 ("develop safely, then run the finished report against real data, and keep it live") is unmet: the only shareable form (Snapshot) freezes data at build time.

**Approach:** Add an **Export live report** action that produces a Report which re-queries its target *on view* through a running quick-studio. The exported artifact holds only the report layout + each query block's SQL + view/chart spec — **no data, no credential, no database driver, no session token** (AR-12/AD-9). To view it live, the Report is published to the **local Core** (layout+SQL only) and served at a loopback URL on the **Core origin**, where the running Core injects its session token (same mechanism as the app shell) and the inlined runtime lets the viewer pick a connection and re-queries per block via the existing `execute` RPC. The Core authorizes it as an **explicit second caller** (token + Origin/Host on `/rpc`, AR-5/AD-12) — never implicitly. Opened without a running quick-studio to authorize it, it reaches no database.

## Boundaries & Constraints

**Always:**
- The shareable/exported artifact embeds ONLY: the report layout, each query block's `sql`, `view`, and `chart` spec. It holds **no `FrozenData`, no connection URL/credential, no DB driver, and no session token** (AR-12/AD-9).
- Re-query runs ONLY against the **same-origin running Core** via `POST /rpc` `{method:"execute", params:{shape:"raw", sql, connectionId}}` with the `x-qs-token` header — sending only the connection **id** (never a URL/credential; AR-12). All SQL runs in the Core (AR-2).
- The viewer supplies the connection: the runtime fetches `connections.list` and offers a picker (default = boot connection = `connectionId:null`, plus each `ConnectionSummary`).
- The session token is obtained at **serve time** from the running Core (injected into the Core-served `/live/<id>` page exactly like the app shell's `window.__QS_TOKEN__`), never baked into the portable artifact.
- CSP of the live page: `default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'` — `connect-src 'self'` is the sole egress and ties re-query to the origin that served the page; zero external references.
- Reuse the Epic-5/6.3 render helpers (`renderMarkdownToHtml`, `buildPlotOptions` from `src/sandbox/render.ts`) and the shared frozen-table renderer — do not fork a third renderer.
- Sanitize prose (the sanitizing markdown renderer) and HTML-escape every returned table cell value AND column name (returned rows are untrusted DB strings). Two independent `</script`-escapes: the JSON payload AND the inlined runtime bundle (mirror 6.3).
- Never auto-confirm a destructive statement: an `execute` reply of `confirmation_required` renders an inert "not run — requires confirmation" note; it is never re-issued with `confirmed:true`.
- Runtime resilience: isolate each block render/fetch in its own try/catch (one failing block never aborts the others); an unauthorized/no-token/no-Core context renders a visible "needs a running quick-studio" state (never a blank page, never a silent unhandled rejection); a corrupt/failed-guard payload renders a visible "cannot open live report" fallback.
- Keep DOM- and network-touching code behind injectable/`typeof document` seams with pure, colocated-tested cores.

**Block If:**
- Making the live re-query work would require adding CORS headers, relaxing the Core's Origin/Host validation, cross-origin token passing, or otherwise weakening the second-caller auth contract — that is a security-contract evolution, not an unattended decision. HALT `blocked`.
- Representing a live report would require changing or version-bumping a shared schema (frozen-data or connection contract). HALT `blocked`.

**Never:**
- Bake any credential, connection URL, DB driver, frozen result data, or session token into the exported/portable artifact.
- Send report data or SQL to any **external** service — the only network egress is the same-origin loopback Core (`connect-src 'self'`); publishing layout+SQL to the *local* Core is not external.
- Open a database connection directly from the report or embed a DB runtime (AR-12) — all SQL routes through the Core.
- Auto-execute destructive DML/DDL against the viewer's database.
- Add CORS, relax Origin/Host validation, or introduce any new implicit authorization of a loopback caller.
- Bundle Recharts or the Ring-2 `rpc/client` into the runtime (keep Ring discipline: `shared/` + `sandbox/render` + libs + a tiny inline same-origin fetch).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Live view, prose+table+chart | opened at Core origin, token present, viewer picks a target | connections picker rendered; each query block re-queried via `execute {sql, connectionId}`; prose (sanitized), table (escaped cells+columns), chart (Observable Plot) render from returned `FrozenData`; Refresh re-queries all | No error expected |
| No running quick-studio / no token | `window.__QS_TOKEN__` undefined (bare file / stopped Core) | visible "This Live Report needs a running quick-studio" state; **no `/rpc` fetch is attempted**; reaches no database | Not an error (inert) |
| Destructive SQL block | `execute` → `confirmation_required` | block renders inert "not run — requires confirmation" note; never re-issued with `confirmed:true` | Safety, not an error |
| Block RPC/network error | `execute` fetch throws or reply `ok:false` | that block shows an inline error note; sibling blocks still fetch/render | Per-block isolation |
| `connections.list` fails | RPC error before any block | top-level "cannot reach quick-studio" state | Error surfaced, no partial render claimed |
| Truncated result | `execute` → `rows{truncated:true}` | table/chart renders + a visible truncation affordance | Not an error |
| Chart view, stale/invalid spec | `parseChartSpec(chart, columns)` → null | table fallback of the same data | Not an error |
| Hostile returned value | a returned cell/column/prose contains `</script>`/HTML | renders inert as text — no markup breakout, no script execution | Escaped/sanitized |
| Empty report | no blocks | valid live page with an "empty report" affordance | Not an error |
| Unrun/blank-SQL query block | `sql` blank | `empty` "no query" note; no fetch for that block | Not an error |
| Portable artifact inspected | the downloaded token-free `.html` | contains no `FrozenData`, no credential, no `__QS_TOKEN__`; opened offline it is inert | Not an error |

</intent-contract>

## Code Map

- `src/core/auth.ts` -- `mintSessionToken`, `validateToken`, `validateOrigin` (token + Origin/Host gate). Consume unchanged; the live page is an explicit second caller through these.
- `src/core/server.ts` -- `renderIndexHtml` injects `window.__QS_TOKEN__` (script-json escaped, `no-store`); serves `/app.js`, `/snapshot-runtime.js` (open, data-free); `/rpc` + `/chat/stream` gated by `validateOrigin` then `validateToken`. Mirror the token injection for `/live/<id>` and the open serving for `/live-report-runtime.js`.
- `src/core/rpc.ts` -- `HANDLERS` table + `RpcReply` envelope; `execute`, `connections.list` already present. Add `livereport.publish`.
- `src/core/executor.ts` + `src/core/connection-targets.ts` -- `execute` resolves `connectionId`→live manager in Ring 1; only the id crosses the wire (AR-12). Reuse unchanged.
- `src/shared/contract.ts` -- `FrozenData`/`FrozenCell` (`FROZEN_SCHEMA_VERSION`), `ExecuteRequest`/`ExecuteResult` (`rows{data,truncated}` | `ok` | `confirmation_required`), `ConnectionSummary` (`{id,name,host,engine}`), `decode`. Consume, do not redefine.
- `src/shared/chart-spec.ts` -- `ChartSpec`, `parseChartSpec(raw, columnNames)` (total, null on invalid → table fallback). Reuse for chart re-validation.
- `src/sandbox/render.ts` -- pure `renderMarkdownToHtml`, `buildPlotOptions`, `frozenToRecords`. Reuse for parity.
- `src/snapshot/runtime.ts` -- 6.3 offline runtime; source of the table helpers to EXTRACT (`escapeHtml`/`formatCell`/`renderTableToHtml`/`truncationNote`) and the per-block-isolation + fallback pattern to mirror.
- `src/shared/snapshot-html.ts` -- `embedJson` (payload `<`/`>`/`&`/U+2028-9 escape) + the `</script`-escape + assembly shape. Import `embedJson`; mirror the assembler.
- `src/ui/report/report-state.ts` -- `ReportBlock` (`prose{markdown}` | `query{sql,result,view,chart,error?,info?,truncated?}`), `ReportState{blocks,nextId,targetConnectionId}`. Source blocks to serialize (SQL+view+chart only).
- `src/ui/report/export-snapshot.ts` -- 6.3 Ring-2 orchestration; source of `triggerHtmlDownload` (import) + `runExport`/filename patterns to mirror.
- `src/ui/report/ReportTabView.tsx` -- toolbar with the 6.3 "Export snapshot" ghost button + `useRef` in-flight guard + error surface; add a sibling "Export live report" button. Also already fetches `connections.list` on mount (picker precedent).
- `scripts/build-snapshot.ts` + `package.json`(`build`) + `.gitignore` -- mirror for the live-report bundle.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/frozen-table.ts` -- NEW: extract the pure table renderer from 6.3 — `escapeHtml`, `formatCell(FrozenCell)` (date→ISO, null→neutral placeholder, number/boolean/string as text), `renderTableToHtml(FrozenData)` (HTML-escapes every column name AND cell), `truncationNote()`. No side effects; imports only `shared/contract`. Rationale: one table renderer shared by snapshot + live report — no third fork.
- [x] `src/shared/frozen-table.test.ts` -- NEW: hostile cell value AND hostile column name render inert; per-kind cell formatting; truncation note text. Rationale: guard the shared renderer directly.
- [x] `src/snapshot/runtime.ts` -- MOD: import `escapeHtml`/`formatCell`/`renderTableToHtml`/`truncationNote` from `../shared/frozen-table` and re-export the existing names; delete the local copies. Behavior-identical; existing `src/snapshot/runtime.test.ts` stays green with no test changes. Rationale: DRY the extraction without destabilizing 6.3.
- [x] `src/shared/live-report.ts` -- NEW: `LIVE_REPORT_SCHEMA_VERSION = 1 as const`; `LiveReportBlock = {kind:"prose",markdown} | {kind:"query",sql,view:"table"|"chart",chart:ChartSpec|null} | {kind:"empty",note}`; `LiveReportDoc = {schemaVersion, blocks}`. **No `FrozenData` at rest** — the doc carries SQL, not data. `isLiveReportDoc(x): x is LiveReportDoc` deep-validates: doc `schemaVersion` match; `blocks` is an array; prose has string `markdown`; query has string `sql`, `view ∈ {"table","chart"}`, and `chart` is `null` or an object (final chart validation is `parseChartSpec` at render, against live columns); empty has string `note`. `ChartSpec` type from `./chart-spec`. Must NOT import `ui/`/`core/`/`sandbox/`. Rationale: the token/credential/data-free portable payload contract.
- [x] `src/shared/live-report.test.ts` -- NEW: guard accepts each kind; rejects wrong doc `schemaVersion`, missing `blocks`, unknown `kind`, non-string `sql`, invalid `view`; asserts a well-formed doc carries no data field. Rationale: guards the payload the serve/runtime path trusts.
- [x] `src/shared/live-report-html.ts` -- NEW: `LIVE_REPORT_CSP = "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"`. Pure `assembleLiveReportHtml(doc: LiveReportDoc, runtimeJs: string, token: string | null): string` — `<!doctype html>` + `<meta charset>` + CSP `<meta http-equiv>`; inline `<style>` (mirror snapshot classes + a `.qs-picker`/`.qs-refresh`/`.qs-status` set); `<div id="__qs_report">`; **when `token` is non-null** an inline `<script>window.__QS_TOKEN__ = <scriptJson(token)>` (reuse the app-shell script-json escaping) — **omitted when `token` is null** so the portable copy carries no secret; `<script type="application/json" id="__qs_livereport">${embedJson(doc)}</script>`; and `<script>${runtimeJs.replace(/<\/script/gi,"<\\/script")}</script>`. Import `embedJson` from `./snapshot-html`. Rationale: the self-contained live page; `connect-src 'self'` is the sole egress; token injected only at serve time; injection-safe on data AND runtime.
- [x] `src/shared/live-report-html.test.ts` -- NEW: parse the embedded JSON back out → deep-equals the doc; `connect-src 'self'` present AND `connect-src 'none'` absent; zero `http://`/`https://` external references; with `token=null` there is NO `__QS_TOKEN__` and no secret; with a token it is script-json-escaped; a `</script>` inside a SQL string stays inert; a hostile `runtimeJs` containing `</script>` is neutralized (exactly the real script tags survive); assert no `FrozenData`/`rows`/credential/driver embedded. Rationale: proves no-secret + injection safety for data AND runtime.
- [x] `src/live-report/runtime.ts` -- NEW: browser runtime rendered inside the live page. Reuse `renderMarkdownToHtml`/`buildPlotOptions` (`../sandbox/render`), `parseChartSpec` (`../shared/chart-spec`), table helpers (`../shared/frozen-table`). Pure cores: `renderResultBlock(block, data: FrozenData)` (chart when `view:"chart"` AND `parseChartSpec(chart, data.columns…)` non-null, else table; truncation affordance when `truncated`); `buildExecuteParams(block, connectionId): {shape:"raw", sql, connectionId}` (id only; `null` = default); `classifyReply(reply): {kind:"rows",data,truncated} | {kind:"confirm"} | {kind:"ok"} | {kind:"error",message}`. Seam: `type LiveDeps = { getToken(): string|null; rpc(method, params): Promise<RpcReply<unknown>> }`; `makeRpc(fetchImpl, getToken)` POSTs **same-origin** `/rpc` with `x-qs-token`. Async: `loadConnections(deps)`, `runBlock(deps, block, connectionId)`, `renderInto(host, ...)`. `bootstrap(doc)`: read `#__qs_livereport`→`isLiveReportDoc` gate → visible "cannot open live report" fallback on failure; `getToken()` from `window.__QS_TOKEN__`; **if null → render the inert "needs a running quick-studio" state and DO NOT call `rpc`** (AC: opened without a running quick-studio reaches no DB); else fetch `connections.list`→build the viewer picker (default `null` + each summary)→run all blocks against the pick, **each block isolated** (network/RPC error→inline note; `confirm`→"not run — requires confirmation" note, never `confirmed:true`; `ok`→neutral note; `rows`→render), and wire a **Refresh** control that re-queries all blocks against the current pick; empty report→affordance. DOM guarded by `typeof document !== "undefined" && typeof window !== "undefined"`. Ring: imports only `shared/` + `sandbox/render` + libs + the tiny inline fetch — NO Ring-2 `rpc/client`, NO Recharts. Rationale: the live re-query renderer, resilient and authorization-gated.
- [x] `src/live-report/runtime.test.ts` -- NEW (DOM-free, injected `LiveDeps` + fake mount host): `renderResultBlock` table/chart/invalid-spec→table/truncation; `buildExecuteParams` id-only + null default; `classifyReply` rows/confirm/ok/error; orchestration — **no token → zero `rpc` calls + inert fallback**; `rows`→rendered; `confirm`→"not run" note AND never a `confirmed:true` re-issue; a block's `rpc` error→inline note while siblings still run; `connections.list` failure→top-level error; a hostile returned cell/column renders inert. Rationale: render, escaping, safety, resilience, and the authorization gate — all without a DOM.
- [x] `scripts/build-live-report.ts` -- NEW: `Bun.build({entrypoints:["src/live-report/runtime.ts"], target:"browser", minify:true, define:{"process.env.NODE_ENV":'"production"'}})` → write `src/core/live-report-bundle.generated.ts` = `export const liveReportBundle = { js } as const`. Mirror `scripts/build-snapshot.ts` (fail the build on a `Bun.build` error). Rationale: produces the inlined live runtime.
- [x] `package.json` + `.gitignore` -- MOD: add `bun scripts/build-live-report.ts` to the `build` script (after the snapshot build); ignore `src/core/live-report-bundle.generated.ts`. Rationale: wire the build; keep the generated bundle out of git like the others.
- [x] `src/core/live-report-registry.ts` -- NEW: in-memory, session-only registry. `createLiveReportRegistry()` → `{ publish(doc: LiveReportDoc): string, get(id): LiveReportDoc | null }`. `publish` validates via `isLiveReportDoc` (invalid → typed error), stores under an **opaque unguessable id** (crypto random hex, mirror `mintSessionToken`), returns the id; `get` returns the doc or `null`. Nothing written to disk (AR-8-safe, Persistent/Ephemeral-agnostic); optional bounded size (evict oldest). Rationale: holds published layout+SQL docs to serve same-origin; transient serving state, not a persisted report.
- [x] `src/core/live-report-registry.test.ts` -- NEW: `publish` returns distinct non-sequential ids; `get` round-trips the doc; `get(unknown)`→null; `publish(invalid)` throws; a bounded registry evicts as specified. Rationale: guards the serve lookup.
- [x] `src/core/rpc.ts` -- MOD: add handler `livereport.publish` (params: `LiveReportDoc`) → `registry.publish(doc)` → reply `{ path: "/live/" + id }`; an invalid doc → a typed `invalid_params` error (never throws through the envelope). Rationale: the UI ships layout+SQL (no data) to the LOCAL Core to be served — only the loopback Core sees it.
- [x] `src/core/server.ts` -- MOD: (a) construct the `liveReportRegistry` at boot and thread it to the rpc dispatch; (b) `GET /live/<id>` → registry `get`; missing → `404`; else respond `assembleLiveReportHtml(doc, liveReportBundle.js, core.token)` with `content-type: text/html; charset=utf-8`, `cache-control: no-store`, `x-content-type-options: nosniff` — same-origin, token injected (mirror `renderIndexHtml`); (c) `GET /live-report-runtime.js` → `liveReportBundle.js` (open, data-free, mirror `/snapshot-runtime.js`) for the Ring-2 portable-copy path. **No CORS, no Origin/Host relaxation** — `/rpc` keeps its existing `validateOrigin`+`validateToken` gates so the live page is an EXPLICIT second caller. Rationale: serve the live page same-origin so it can re-query, while the auth contract stays untouched.
- [x] `src/core/server.test.ts` -- MOD: `GET /live/<id>` returns the assembled HTML carrying the injected token AND `connect-src 'self'`; unknown id → 404; `/live-report-runtime.js` served open with the JS content-type; `/rpc` still rejects a bad/absent token and a foreign Origin (unchanged). Rationale: proves same-origin serving + unchanged second-caller gate.
- [x] `src/ui/report/export-live-report.ts` -- NEW: Ring-2 orchestration. Pure `toLiveReportBlock(block: ReportBlock): LiveReportBlock` (prose→prose; query with non-blank `sql`→`{kind:"query",sql,view,chart}` — **no `encode`, no data**; query with blank `sql`→`empty` "no query"); `toLiveReportDoc(blocks)`; pure `buildLiveReportHtml(blocks, runtimeJs) = assembleLiveReportHtml(toLiveReportDoc(blocks), runtimeJs, null)` (token-free portable copy); `liveReportFilename(clock?)` (deterministic under an injected clock). Injectable `publishAndOpen({blocks, rpc, open})` → `rpc("livereport.publish", toLiveReportDoc(blocks))` → `open(reply.path)` (open the loopback live view). Injectable `runExport({blocks, fetchRuntime, download, rpc, open})` = `publishAndOpen(...)` for the live view **and** `download(buildLiveReportHtml(blocks, await fetchRuntime()), liveReportFilename())` for the portable secret-free copy — `fetchRuntime` throws a typed error on a non-OK/empty response BEFORE any download. Import `triggerHtmlDownload` from `./export-snapshot`. Rationale: local export = publish+serve live view + hand a portable, secret-free file; all paths unit-testable without a DOM.
- [x] `src/ui/report/export-live-report.test.ts` -- NEW: `toLiveReportDoc` — prose→prose; query→query with `sql`+`view`+`chart` and NO data/`encode`; blank-sql→empty; chart carried; `schemaVersion` stamped. `buildLiveReportHtml` embeds the SQL, and asserts NO `FrozenData`/`rows`/`__QS_TOKEN__`/credential in the output. `publishAndOpen` calls `rpc("livereport.publish", …)` then `open(path)`. `runExport` — a `livereport.publish` error surfaces (no false success); a non-OK runtime fetch throws before `download`; a success both opens the live view and downloads. `liveReportFilename` deterministic under an injected clock. Rationale: the mapping matrix rows + Ring-2 wiring + error paths.
- [x] `src/ui/report/ReportTabView.tsx` -- MOD: add a sibling quiet ghost **"Export live report"** button next to "Export snapshot" (secondary emphasis, `ghostBtn`, never primary). Own in-flight `useRef` guard + `exporting`/`exportError` surface (mirror the snapshot button). On click drive `runExport` with a `fetchRuntime` that fetches `/live-report-runtime.js` and checks `res.ok`, an `rpc` for `livereport.publish`, and `open = (path) => window.open(path)`. Wrap the whole export in try/catch — a failed publish/fetch surfaces a user-visible error, never a silent unhandled rejection, never welds an error body into the file. Concurrency guard: a double-click cannot launch overlapping exports. Must not reorder, mutate, or clear any block; works with an empty report. Rationale: the export entry point.
- [x] `src/ui/report/ReportTabView.test.tsx` -- MOD: an "Export live report" ghost button renders alongside "Export snapshot"; a static render never mutates block state. (Click-driven fetch/publish/error coverage lives in `export-live-report.test.ts` via `runExport`, since this repo has no jsdom.) Rationale: render + non-mutation guard.

**Acceptance Criteria:**
- Given a Report of prose + query blocks, when the author clicks Export live report, then a live report is produced whose exported/portable artifact contains **no credential, no DB driver, no frozen data, and no session token** (AR-12/AD-9), verified by inspecting the artifact.
- Given a live report being viewed through a running quick-studio, when it re-queries, then it does so ONLY by `POST /rpc` `execute` against the same-origin Core on `127.0.0.1`, which authorizes it explicitly as a second caller (`x-qs-token` + Origin/Host on the unchanged `/rpc` gate, AR-5/AD-12) and runs each block's SQL against the viewer-picked connection (id only leaves Ring 2; AR-12/AR-2).
- Given a live report opened without a running quick-studio to authorize it (bare file, or stopped Core → no injected token / cross-origin blocked), when it loads, then it renders a visible "needs a running quick-studio" state, attempts no `/rpc` fetch, and reaches no database.
- Given the viewer picks a different connection, when they Refresh, then every query block re-queries against that `connectionId` and re-renders — the layout is not rebuilt (UJ-4).
- Given a live-report query block whose SQL is destructive, when re-queried, then the Core returns `confirmation_required` and the block renders an inert "not run — requires confirmation" note — it is never auto-executed against the viewer's database.
- Given returned rows containing hostile string values (`</script>`, HTML) or a hostile column name, when rendered, then they render inert as text — no script executes and no markup breaks out.
- Given a query block whose returned result was row-capped (`truncated`), when rendered, then a visible truncation affordance is shown — a shared report never presents partial data as complete.
- Given the export action, when shown in the toolbar, then it is a quiet ghost/secondary control that does not reorder, mutate, or clear any block, and a double-click cannot launch overlapping exports.

## Spec Change Log

_No `bad_spec` loopback occurred. The single review pass produced only `patch`-level fixes (applied in-diff) and `reject`-level by-design findings; the intent contract and the derived structure held. See the Review Triage Log._

## Review Triage Log

### 2026-07-12 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 3, low 2)
- defer: 0
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[medium]` `[patch]` The live-view tab was opened via `window.open(path)` AFTER `await rpc("livereport.publish")`, so the call fell outside the click gesture and popup blockers ate it — the export's headline "open live view" action failed silently. Fixed: a two-phase window seam (`reserveWindow()` synchronously in the click gesture, `navigate()`/`closeWindow()` after publish); a blocked/null window surfaces a visible "allow popups" error and still performs the portable download; a runtime-fetch failure after the view opened is non-fatal (does not tear down the live view).
  - `[medium]` `[patch]` `runLiveReport`/`runAll` had no concurrency guard, so a picker change or a Refresh double-click raced two overlapping re-queries and the last-resolving reply won per block (rendering data for a connection the picker no longer showed, or double-appending). Fixed with a run-generation counter (`latestRun`/`myRun`) whose `isCurrent()` gate drops every append from a superseded run.
  - `[medium]` `[patch]` A `connections.list` failure early-returned the whole-document "cannot reach quick-studio" fallback, hiding prose/no-DB blocks behind a wall. Fixed: prose/`empty` blocks now render unconditionally; on a connections failure the run falls through with `connections = []`, a top-level note, and a per-query-block inline "cannot reach" note (no `execute` call). The token-absent inert path is unchanged (still zero `/rpc`).
  - `[low]` `[patch]` An unknown/evicted `/live/<id>` returned a bare 404. Fixed: a human-readable 404 body ("This live report link is unknown or has expired — re-export it from quick-studio.").
  - `[low]` `[patch]` `LIVE_REPORT_CSP` lacked `frame-ancestors` on a now-token-bearing served page (clickjacking margin). Fixed: added `frame-ancestors 'none'`.
  - Rejected (dropped, by-design / no contract break): (1) untrusted, egress-capable content rendered in the token-bearing page under `script-src 'unsafe-inline'; connect-src 'self'` widens blast radius vs the Ring-3 sandbox — no reachable bypass found (returned cells/columns HTML-escaped, chart labels via Plot `textContent`, prose sanitized); this is the conscious, documented residual risk of a self-contained page that re-queries, mirroring 6.3's accepted `unsafe-inline`. (2) Prose markdown images silently blocked (no `img-src` → `default-src 'none'`) — correct by design: loading images would be external egress, which is forbidden (only the loopback Core via `connect-src 'self'`). (3) A browser Save-As of the served `/live/<id>` page captures the per-boot session token — identical containment to the app shell (loopback-only, per-boot, useless off-machine), inherent to the same-origin token-injection model; export (`token=null`) remains the secret-free share path.

### 2026-07-12 — Follow-up review pass

- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 1
- reject: 2
- addressed_findings:
  - `[medium]` `[patch]` The served `/live/<id>` page (the ONLY page carrying the injected per-boot token AND able to `POST /rpc`) delivered its `frame-ancestors 'none'` clickjacking guard solely via the `<meta http-equiv="Content-Security-Policy">` element, where browsers silently drop `frame-ancestors` (it is effective only as an HTTP response header) — so the anti-framing invariant the CSP asserts (and its test) was inert; the token-bearing page was framable. Fixed: the `/live/<id>` success response now sends a REAL HTTP anti-framing guard (`X-Frame-Options: DENY` + a header-level `content-security-policy: frame-ancestors 'none'`) via a dedicated `liveHtmlHeaders`; the `<meta>` CSP is retained (harmless, documents intent). Added a `server.test.ts` assertion on the actual response headers (the prior test only checked the substring in the HTML — false confidence).
  - `[low]` `[patch]` The runtime's stated per-block isolation contract ("one failing block never drops its siblings") was honored only for query blocks (inside `runBlock`'s try/catch); prose/empty rendering in both `runLiveReport` loops (token-present and no-token) ran outside any try/catch, so a throw from `renderMarkdownToHtml`/`appendHtml` on one prose block would abort the whole loop — dropping every sibling and escaping as an unhandled rejection with no visible fallback. Fixed: both loops now wrap each block's render in a per-block try/catch that surfaces the failure as that block's inline error note, mirroring `runBlock`. Added two `runtime.test.ts` isolation tests (token-present + no-token, the latter also re-asserting zero `/rpc`).
  - Deferred (1, new ledger entry): a `connections.list` failure at initial load leaves the top-level "cannot reach" banner + Default-only picker permanently stale — a later Refresh re-queries live data but never re-lists connections nor clears the banner (low/cosmetic; narrow trigger; full-reload recovers; correct fix is a re-entrant reload + replaceable-picker refactor that must preserve the concurrency guard, disproportionate to patch in an unattended pass).
  - Rejected (2, by-design / no consequence): (1) the `/live/<id>` 404 fallback ships without a CSP — a static, fully-constant page with no reflected/user-controlled content and no token, so no injection path. (2) No per-doc size bound on `livereport.publish` — the registry bounds count (64) and every caller is token-gated + session-transient + local-only, so the residual is a self-inflicted local memory ceiling.

## Design Notes

- **A browser page is same-origin with the Core only if the Core served it.** A downloaded `.html` opened via `file://` is cross-origin forever — no CORS header + `validateOrigin` reject it, and it can never read `window.__QS_TOKEN__`. Therefore the live re-query path REQUIRES the Core to serve the page: publish the layout+SQL doc to the local Core (`livereport.publish`) and open `http://127.0.0.1:<port>/live/<id>`, where the page is same-origin, the Core injects its live token (identical to the app shell), and `connect-src 'self'` permits `/rpc`. This is the only design that satisfies "no baked secret" + "explicit second-caller auth" + "inert without a running quick-studio" without touching the auth contract.
- **The artifact holds no secret; the running Core supplies the capability.** The published/portable doc carries only layout + SQL (AR-12). The transient served `/live/<id>` HTML embeds the per-boot session token exactly as `renderIndexHtml` does for the shell (`no-store`), and `connect-src 'self'` confines that token to the loopback Core it authorizes — it can reach nothing else. A stopped Core kills the URL; a copied token is useless without that Core.
- **`connect-src 'self'` is the load-bearing egress boundary.** It ties every re-query to the origin that served the page and blocks all other network access. This is THE delta from the 6.3 Snapshot (`connect-src 'none'`): a Snapshot never talks to anything; a Live Report talks only to the Core that served it.
- **Explicit second caller — no implicit loopback trust.** The live page hits the same `/rpc` gate as the app shell: `validateOrigin` (Host==`127.0.0.1:<port>`, Origin==`http://127.0.0.1:<port>`) then `validateToken`. It is authorized because it presents the token same-origin, never merely because it reached the loopback port (AR-5/AD-12). No CORS, no Origin relaxation — if the implementation finds it needs those, that is a contract change → HALT.
- **Read-only by policy.** A live report re-queries on view; it must never silently mutate the viewer's DB. The Core already classifies risk server-side and returns `confirmation_required` for destructive statements — the runtime renders that as an inert note and never re-issues with `confirmed:true`.
- **One renderer, reused.** Prose via `renderMarkdownToHtml`, charts via `buildPlotOptions` (Observable Plot, AR-14), tables via the extracted shared `renderTableToHtml` — the same stack as the Snapshot, so a Live Report renders identically to a frozen one, differing only in that the data arrives live. Injection safety rests on the per-cell/column HTML-escape + markdown sanitization (SOLE guard under `script-src 'unsafe-inline'`), plus the two `</script`-escapes.
- **Resilience on the view path.** The page may be opened with no Core, with a corrupt payload, or against a target that errors on one block. It degrades visibly at every level: no token → "needs a running quick-studio" (no fetch); bad payload → "cannot open live report"; one failing block → an inline note without dropping siblings. Never a blank page, never a silent rejection.
- **Orthogonal to the Snapshot (6.3) and reuses targeting (6.2).** Snapshot and Live Report are the two export forms of the same assembled Report; the viewer's connection picker reuses the `connections.list` + `execute {connectionId}` machinery from 6.2/2.4 verbatim.

## Verification

**Commands:**
- `bun test src/shared/frozen-table.test.ts src/shared/live-report.test.ts src/shared/live-report-html.test.ts src/live-report/runtime.test.ts src/core/live-report-registry.test.ts src/ui/report/export-live-report.test.ts src/ui/report/ReportTabView.test.tsx src/snapshot/runtime.test.ts src/core/server.test.ts` -- expected: all live-report + extracted-renderer + snapshot + server tests pass
- `bunx tsc --noEmit` -- expected: no type errors (strict, `noUncheckedIndexedAccess`)
- `bun run build` -- expected: ui + sandbox + snapshot + **live-report** bundles build cleanly (new `build-live-report` step wired in)

**Manual checks (if no CLI):**
- Build a Report with a prose block + a table-view query block + a chart-view query block. Click **Export live report**: a browser tab opens at `http://127.0.0.1:<port>/live/<id>`. Pick a connection; the blocks re-query and render prose/table/chart from live data; Refresh re-runs them. Then stop quick-studio and reload the tab (or open the downloaded token-free `.html` offline): it shows the "needs a running quick-studio" state and the Network panel shows no successful `/rpc` egress. Inspect the downloaded `.html`: no `__QS_TOKEN__`, no connection URL, no `FrozenData`.

## Auto Run Result

Status: done

**Summary of implemented change**
Adds **Export live report** to the Report tab: the current Report (prose + query blocks) is published to the local Core as a layout+SQL doc — **no data, no credential, no DB driver, no session token** — and served same-origin at a loopback URL (`/live/<id>`) where the running Core injects its per-boot session token exactly as the app shell does. The inlined runtime lets the viewer pick a connection (`connections.list`) and re-queries each block on view/refresh via the unchanged, token+Origin-gated `/rpc` `execute` (id-only target; all SQL runs in the Core, AR-2/AR-12). The exported/portable `.html` copy carries no secret and is inert without a running quick-studio; the served page's CSP is `default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'` — `connect-src 'self'` is the sole egress and ties re-query to the serving Core. No CORS and no Origin/Host relaxation were introduced: the live page is an explicit second caller (AR-5/AD-12). Destructive statements come back as `confirmation_required` and are rendered inert, never auto-executed.

**Files changed**
- `src/shared/frozen-table.ts` (NEW) — pure shared table renderer (`escapeHtml`/`formatCell`/`renderTableToHtml`/`truncationNote`, `NULL_PLACEHOLDER`) extracted from the 6.3 snapshot runtime; one renderer, no fork. (+`frozen-table.test.ts`)
- `src/snapshot/runtime.ts` (MOD) — imports + re-exports those helpers from `shared/frozen-table`; local copies deleted; 6.3 tests unchanged and green.
- `src/shared/live-report.ts` (NEW) — `LiveReportDoc`/`LiveReportBlock` (SQL, no `FrozenData`) + `isLiveReportDoc` deep guard. (+`live-report.test.ts`)
- `src/shared/live-report-html.ts` (NEW) — `assembleLiveReportHtml(doc, runtimeJs, token)`; `connect-src 'self'` + `frame-ancestors 'none'` CSP; token injected only when non-null; `embedJson` payload escape + `</script`-escaped runtime. (+`live-report-html.test.ts`)
- `src/live-report/runtime.ts` (NEW) — offline-served runtime: pure `renderResultBlock`/`buildExecuteParams`/`classifyReply`, injectable `LiveDeps`/`makeRpc` (same-origin `/rpc` fetch), viewer connection picker, Refresh, per-block isolation, run-generation concurrency guard, token-absent inert state, corrupt-payload fallback. (+`runtime.test.ts`)
- `scripts/build-live-report.ts` (NEW) — Bun bundler → `src/core/live-report-bundle.generated.ts` (git-ignored).
- `src/core/live-report-registry.ts` (NEW) — in-memory, session-only registry (`publish`/`get`, opaque 128-bit ids, bounded eviction). (+`live-report-registry.test.ts`)
- `src/core/rpc.ts` (MOD) — `livereport.publish` handler (validate → `registry.publish` → `{path:"/live/<id>"}`); `RpcContext.liveReports`. (+`rpc.test.ts` updated)
- `src/core/server.ts` (MOD) — builds the registry at boot; `GET /live/<id>` serves the token-injected page (`no-store`; human-readable 404 on miss); `GET /live-report-runtime.js` open + data-free; `/rpc` gates untouched. (+`server.test.ts`)
- `src/shared/contract.ts` (MOD) — `LiveReportPublishResult` type.
- `src/ui/report/export-live-report.ts` (NEW) — Ring-2: `toLiveReportDoc` (SQL-only mapping), `buildLiveReportHtml` (token=null portable copy), two-phase `publishAndOpen`/`runExport`, `liveReportFilename`; reuses `triggerHtmlDownload`. (+`export-live-report.test.ts`)
- `src/ui/report/ReportTabView.tsx` (MOD) — sibling ghost "export live report" button with its own in-flight ref + error surface; gesture-safe window reservation. (+`ReportTabView.test.tsx`)
- `package.json` + `.gitignore` (MOD) — `build-live-report` wired into `build`; generated bundle ignored.

**Review findings breakdown**
- One review pass (Blind Hunter + Edge Case Hunter, opus). Triage: 0 intent_gap, 0 bad_spec, **5 patch** (medium 3, low 2), 0 defer, **3 reject** (all by-design). Patches applied in-diff: gesture-safe live-view open (popup-blocker fix), runtime re-query concurrency guard, prose/empty rendering when `connections.list` fails, human-readable `/live/<id>` 404, CSP `frame-ancestors 'none'`. Rejected as by-design: in-page token-bearing render blast-radius (no reachable bypass; documented residual risk mirroring 6.3), prose images blocked (correct — no external egress), served-page Save-As token capture (same containment as the app shell).

**Verification performed**
- Targeted `bun test` (live-report + extracted-renderer + snapshot + server + rpc suites): all pass (128 pass post-patch).
- `bunx tsc --noEmit`: clean (strict, `noUncheckedIndexedAccess`).
- `bun run build`: clean — ui + sandbox + snapshot + live-report bundles emitted (`build-live-report` wired in).
- Full `bun test`: 1028 pass / 0 fail across 67 files.

**Residual risks**
- Defense-in-depth: the served live page runs its own inlined runtime (`script-src 'unsafe-inline'`) with the session token injected and `connect-src 'self'` egress — so the per-cell/column HTML-escape + markdown sanitization are the sole guard against injection into the token origin (all closed and tested; no reachable bypass found). `connect-src 'self'` + `frame-ancestors 'none'` bound the blast radius to the loopback Core. The real same-origin live render (`/rpc` round-trips under live CSP) is exercised by the manual check, matching the repo's no-jsdom pattern.
- A viewer's browser Save-As of the served page captures the per-boot token (loopback-only, useless off-machine); sharing is via the secret-free export (`token=null`), not Save-As.
- The in-memory registry is bounded — after many publishes an evicted `/live/<id>` reload 404s with a clear "expired — re-export" message (in-page Refresh is unaffected; the doc is inlined in the served page).

## Follow-up Review Result — 2026-07-12

An independent follow-up review pass (Blind Hunter + Edge Case Hunter, opus, no prior context) ran against the full 6.4 diff from `baseline_revision`. Triage: 0 intent_gap, 0 bad_spec, **2 patch** (medium 1, low 1), **1 defer**, **2 reject**. No `bad_spec` loopback; the intent contract and derived structure held. Patches applied in-diff:

- **`[medium]` Real HTTP anti-framing header on `/live/<id>`.** `frame-ancestors` delivered only via `<meta>` is ignored by browsers, leaving the token-bearing served page framable despite the CSP asserting `frame-ancestors 'none'`. Added a dedicated `liveHtmlHeaders` (`X-Frame-Options: DENY` + header-level `content-security-policy: frame-ancestors 'none'`) on the `/live/<id>` success response; kept the `<meta>` directive (harmless, documents intent). New `server.test.ts` assertion on the actual response headers.
- **`[low]` Per-block isolation for prose/empty rendering.** The isolation contract was honored only for query blocks; a throw from `renderMarkdownToHtml`/`appendHtml` on a prose/empty block would abort the whole report. Wrapped both `runLiveReport` render loops (token-present + no-token) in per-block try/catch surfacing the failure as an inline error note. Two new `runtime.test.ts` isolation tests.

Deferred (new ledger entry): stale "cannot reach" banner + Default-only picker after a `connections.list` failure recovers on Refresh (low/cosmetic, narrow trigger, full-reload recovers). Rejected: `/live/<id>` 404 page without CSP (static, no injection path, no token); no per-doc size bound (token-gated, count-bounded, local-only).

**Files changed in this pass**
- `src/core/server.ts` (MOD) — `liveHtmlHeaders` (real anti-framing) for the `/live/<id>` success response.
- `src/core/server.test.ts` (MOD) — asserts the `/live/<id>` response carries `X-Frame-Options: DENY` + header CSP `frame-ancestors 'none'`.
- `src/live-report/runtime.ts` (MOD) — per-block try/catch around prose/empty rendering in both `runLiveReport` loops.
- `src/live-report/runtime.test.ts` (MOD) — token-present + no-token prose-throw isolation tests.

**Verification (follow-up pass)**
- `bun run build`: clean — ui + sandbox + snapshot + live-report bundles emitted.
- Targeted suite (`frozen-table` + `live-report` + `live-report-html` + `runtime` + `live-report-registry` + `export-live-report` + `ReportTabView` + `snapshot/runtime` + `server`): 107 pass / 0 fail.
- `bunx tsc --noEmit`: clean (strict, `noUncheckedIndexedAccess`).
- Full `bun test`: 1031 pass / 0 fail across 67 files.

**Follow-up review recommendation:** false — two localized, well-tested fixes (a defensive HTTP header addition + a per-block try/catch); no happy-path behavior change, no API/schema/data-shape change.
