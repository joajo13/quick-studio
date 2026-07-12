---
title: 'Export a Report as a static Snapshot'
type: 'feature'
created: '2026-07-12'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
baseline_revision: '1afcbbfafd25898f85f7eb97dcaa26a39b32a371'
final_revision: '4ceb498ae5594275f8d56b10ce358dda19966c54'
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** A Report (Stories 6.1/6.2) is a live, session-only Ring-2 artifact — its prose, tables, and charts exist only inside a running quick-studio and vanish when the app closes. FR-20 / UJ-4 ("hand someone a self-contained report that needs no database") is unmet: there is no way to freeze a Report's current data into a file you can send someone.

**Approach:** Add an **Export snapshot** action that serializes the Report's currently-displayed blocks into a single, fully self-contained `.html` file — prose, tabular data, and charts, with the data frozen at build time using the canonical `FrozenData` shape from `shared/` (AR-11) — that renders identically when reopened later with no quick-studio, no database, and no network. Assembly happens locally in Ring 2 + `shared/` (the frozen data never leaves the browser); the offline renderer mirrors the Epic 5 sandbox stack (Observable Plot + micromark, `connect-src 'none'`); delivery is a browser Blob download.

## Boundaries & Constraints

**Always:**
- Embed only the canonical AR-11 `FrozenData` shape via `encode()`, schema-version-stamped — the same shape the sandbox consumes.
- Produce a single, fully self-contained HTML document: all JS, CSS, and data inline; zero external references (no CDN, font, or remote asset).
- The exported file must render fully offline — no network, no database, no running quick-studio — enforced at the document level by CSP `connect-src 'none'`.
- Reuse the Epic 5 sandbox render helpers (`renderMarkdownToHtml`, `buildPlotOptions` from `src/sandbox/render.ts`) so a Snapshot renders identically to the in-sandbox path; do not fork a third renderer.
- Sanitize prose (reuse the sanitizing markdown renderer) and HTML-escape every table cell value and the embedded JSON payload — frozen values are untrusted database strings.
- Export reads the block results already in Ring-2 state only: it runs no query, opens no connection, and touches no credential.
- Keep DOM-touching code (download trigger, bootstrap) behind `typeof document` seams with pure, colocated-tested cores.

**Block If:**
- Representing a block would require changing or version-bumping the shared frozen-data schema, or introducing a new persisted-report format — schema/contract evolution is not an unattended decision. HALT `blocked`.
- A self-contained offline render provably cannot be achieved for an existing block kind without an external dependency. HALT `blocked`.

**Never:**
- Send report data to any external service — nor to the Core for assembly. Assembly is local Ring-2 + `shared/`; the Core's only role is serving the static, data-free renderer bundle.
- Write the Snapshot into the app directory or touch Persistent-vs-Ephemeral persistence — it is a browser download, mode-independent (does not violate AR-8/AR-9).
- Embed executable user-supplied JS or open any new sandbox-escape surface — 6.3 renders only prose/table/chart of frozen data (no executable-JS MDX blocks).
- Bundle Recharts into the Snapshot or chase pixel-identical charts — the Snapshot uses Observable Plot per AR-14 (identical **data**, not identical pixels).
- Add any live re-query, viewer-supplied connection, or embedded credential — that is Story 6.4 (Live Report).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full report exported | prose + query(table view) + query(chart view), all run | one self-contained `.html`; prose (sanitized markdown), table (escaped cells), chart (Observable Plot) all render offline from embedded `FrozenData` | No error expected |
| Unrun query block | `result: null` | rendered as a neutral "no data" placeholder; block order/layout preserved (not dropped) | Not an error |
| Errored query block | block has `error` set, `result` null | placeholder "no data" — a Snapshot freezes data, not error states | Not an error |
| Chart view, no spec | `view:"chart"`, `chart: null` | falls back to a table view of the same data | Not an error |
| Date cell | `FrozenCell {kind:"date", iso}` | embedded and rendered as its ISO-8601 UTC string (AR-11) | No error expected |
| Hostile value | a cell or prose contains `</script>` / HTML markup | renders inert as text on reopen — no markup breakout, no script execution | Escaped at JSON embed + table cell; prose sanitized |
| Empty report | no blocks | valid HTML with an empty / "empty report" container | Not an error |
| Ephemeral mode | run mode = ephemeral | export works identically (browser download; no app-dir write) | Not an error |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- `FrozenData`, `FrozenCell`, `FROZEN_SCHEMA_VERSION`, `encode`/`decode`; the canonical AR-11 shape (comment at 47-50 already names it "the only shape embedded in a Snapshot"). Consume, do not redefine.
- `src/ui/report/report-state.ts` -- `ReportBlock` union (`prose{markdown}` | `query{sql,result:FrozenData|null,view,chart:ChartSpec|null,error?}`), `ReportState{blocks,nextId,targetConnectionId}`. Source of the blocks to freeze.
- `src/ui/report/ReportTabView.tsx` -- builder/preview; toolbar `ml-auto` flex (~379-386) with `+ prose`/`+ query`; `btn`/`ghostBtn` classes (~86-89). Home of the new export ghost button. Must not mutate block state.
- `src/sandbox/render.ts` -- pure `renderMarkdownToHtml(md)` (micromark, `allowDangerousHtml:false`, URL-neutralized), `buildPlotOptions(chart,data)` (Observable Plot), `frozenToRecords(data)`. Reuse for parity.
- `src/core/sandbox-server.ts` -- serves `/guest.js` from the generated bundle + `renderGuestHtml()`; mirror it to serve the snapshot runtime.
- `scripts/build-sandbox.ts` -- `Bun.build` → `src/core/sandbox-bundle.generated.ts` (`export const sandboxBundle = {js} as const`); mirror for the snapshot runtime.
- `src/ui/rpc/client.ts` -- token-gated fetch pattern (reference for fetching the static runtime asset over loopback).
- `package.json` (`build` script) + `.gitignore` (generated bundles) -- wire the new build step and ignore its output.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/snapshot.ts` -- NEW: pure snapshot doc **types** only (no UI dependency — `shared/` must not import from `ui/`). `SNAPSHOT_SCHEMA_VERSION = 1 as const`; `SnapshotBlock = {kind:"prose",markdown} | {kind:"table",data:FrozenData,truncated:boolean} | {kind:"chart",chart:ChartSpec,data:FrozenData,truncated:boolean} | {kind:"empty",note:string}` — table/chart carry a **`truncated`** flag so a Snapshot never presents partial (row-capped) data as complete; `SnapshotDoc = {schemaVersion, blocks}`. The `isSnapshotDoc(x): x is SnapshotDoc` guard (used by the runtime when reading the embedded payload) MUST **deep-validate** each block: for table/chart, assert `data` is a well-formed `FrozenData` (i.e. `decode(data)` succeeds — `columns`/`rows` are arrays, cells match column kinds) AND `data.schemaVersion === FROZEN_SCHEMA_VERSION`; a wrong inner frozen-schema version is rejected, not silently rendered. `ChartSpec`/`FrozenData`/`decode`/`FROZEN_SCHEMA_VERSION` come from `shared/contract`. The `ReportBlock → SnapshotDoc` mapping lives in Ring 2 (see `export-snapshot.ts`), because `ReportBlock` is a UI type -- the embedded payload contract, reusing AR-11 exactly.
- [x] `src/shared/snapshot.test.ts` -- NEW: unit-test `isSnapshotDoc` (accepts a well-formed doc incl. each block kind and the `truncated` flag; rejects a wrong doc `schemaVersion`, a missing `blocks`, an unknown block `kind`, a table/chart block whose `data` is a bare object but NOT a valid `FrozenData` — ragged rows / non-array columns — and a block whose inner `data.schemaVersion` differs from `FROZEN_SCHEMA_VERSION`) -- guards the payload the offline runtime trusts against corruption/tamper/version drift.
- [x] `src/shared/snapshot-html.ts` -- NEW: pure `assembleSnapshotHtml(doc: SnapshotDoc, runtimeJs: string): string`. Emits `<!doctype html>` + `<meta charset>` + a CSP `<meta http-equiv>` with `default-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'` (offline-hardened; **`connect-src 'none'` is mandatory**; do NOT include `img-src data:` — no code path emits images, so grant no unused surface). Then inline `<style>`, `<div id="__qs_report">`, `<script type="application/json" id="__qs_snapshot">` holding the doc, and an inline `<script>` with `runtimeJs`. **Two independent escapes, both required:** (1) the JSON payload escapes `<`, `>`, `&`, and the JS line separators U+2028/U+2029 (neutralizing `</script`); (2) the inlined **`runtimeJs` itself** is escaped for `</script` (e.g. `runtimeJs.replace(/<\/script/gi, '<\\/script')`) — the minified Observable Plot/micromark bundle may contain that literal, and an un-escaped occurrence closes the `<script>` early and breaks the whole file -- the self-contained-document builder; injection-safe on BOTH the data and the runtime.
- [x] `src/shared/snapshot-html.test.ts` -- NEW: parse the embedded JSON back out and assert it decodes to the input doc; assert no `http://`/`https://` external reference anywhere; assert `connect-src 'none'` present; assert a `</script>` inside a cell/prose **value** stays inert; **assert that a `runtimeJs` string containing a literal `</script>` is neutralized** (feed a hostile runtime like `"console.log('</script><img src=x>')"` and assert the assembled HTML has exactly two real `</script>` tags and the injected one did not break out) -- proves offline + injection safety for data AND runtime.
- [x] `src/snapshot/runtime.ts` -- NEW: browser runtime rendered inside the exported file. Pure core `renderBlockNode(block)` / `renderTableToHtml(data: FrozenData): string` (HTML-escapes every cell AND column name; formats `FrozenCell` per kind — date→its ISO string, null→a neutral placeholder, number/boolean/string as text); prose via `renderMarkdownToHtml`; chart via Observable Plot from `buildPlotOptions` (reuse `src/sandbox/render.ts`); a **`truncated`** table/chart also renders a visible truncation affordance (e.g. a "results truncated" note) so partial data is never shown as complete; `empty`→the placeholder note. `bootstrap()` reads `#__qs_snapshot` JSON and mounts blocks into `#__qs_report`, DOM work guarded by `typeof document !== "undefined"`. **Robustness (required):** (a) run the payload through `isSnapshotDoc` before rendering and, if it is missing / unparseable / fails the guard, render a visible **"cannot open snapshot"** fallback into the host — never a silent blank page; (b) **isolate each block render in its own try/catch** so one throwing block renders an inline error note and the remaining blocks still render (a single bad block must not abort the whole document) -- the offline renderer, mirroring the sandbox, resilient to corrupt input.
- [x] `src/snapshot/runtime.test.ts` -- NEW: unit-test `renderTableToHtml` HTML-escaping (a `</td><script>` cell value AND a hostile column name render inert) and per-kind cell formatting (date→iso, null→placeholder, number/bool/string); the pure block dispatch for prose/table/chart/empty; the `truncated` affordance appears for a truncated table/chart; a block whose render throws yields an inline error note without aborting sibling blocks; an invalid/failed-guard payload yields the "cannot open snapshot" fallback — all without a DOM -- render correctness, escaping, truncation, and resilience.
- [x] `scripts/build-snapshot.ts` -- NEW: `Bun.build({entrypoints:["src/snapshot/runtime.ts"], target:"browser", minify:true, define:{"process.env.NODE_ENV": '"production"'}})` → write `src/core/snapshot-bundle.generated.ts` = `export const snapshotBundle = { js } as const`. Mirror `scripts/build-sandbox.ts` (fail the build on a Bun.build error) -- produces the inlined offline renderer bundle.
- [x] `package.json` + `.gitignore` -- add `bun scripts/build-snapshot.ts` to the `build` script (after the sandbox build); add `src/core/snapshot-bundle.generated.ts` to `.gitignore` -- wire the build; keep the generated bundle out of git like the others.
- [x] `src/core/server.ts` -- serve `snapshotBundle.js` at `/snapshot-runtime.js` with `content-type: text/javascript`, mirroring how the **Core origin** serves `/app.js` (open, no token — it is data-free renderer code). It must be on the Core/UI origin, NOT the separate sandbox origin: the Report tab reads it with a relative same-origin `fetch`, and the sandbox origin sets no CORS headers so a cross-origin read would be blocked -- delivers the runtime to Ring 2 at export time.
- [x] `src/ui/report/export-snapshot.ts` -- NEW: Ring-2 orchestration. Pure `toSnapshotDoc(blocks: readonly ReportBlock[]): SnapshotDoc` — maps prose→prose; a query block with a non-null `result` → `table` (or `chart` when `view:"chart"` AND `chart` non-null AND the spec still validates against the result's columns via `parseChartSpec`; `view:"chart"` with a null OR now-invalid spec → `table` fallback), embedding `encode(result)` and **carrying `block.truncated ?? false`** onto the table/chart block; a query block with a successful non-SELECT outcome (`result` null but `info` set — e.g. "3 rows affected") → `empty` with **`note` = the `info` text** (never a misleading "no data"); any other null-result **or** errored query block → `empty` with a "no data" note. **`encode()` is guarded per block:** if `encode(result)` throws (non-finite/ragged/non-canonical cell), that block degrades to an `empty` "could not freeze this block" note — one malformed block MUST NOT abort the whole export. Pure `buildSnapshotHtml(blocks, runtimeJs) = assembleSnapshotHtml(toSnapshotDoc(blocks), runtimeJs)` and `snapshotFilename(clock?: () => Date): string` (deterministic given an injected clock). Pure/injectable orchestrator `runExport({blocks, fetchRuntime, download})` that: awaits `fetchRuntime()` (returns the runtime JS), **throwing a typed error when the response is not OK / body empty**, then `download(buildSnapshotHtml(...), snapshotFilename())` — so the fetch/error paths are unit-testable without a DOM. DOM-seam `triggerHtmlDownload(html, filename)` (Blob `text/html` + object-URL anchor click + **`URL.revokeObjectURL` in a `finally`** so a throwing click never leaks the blob URL), guarded by `typeof document` -- the local export action + UI→shared mapping, error-safe and testable.
- [x] `src/ui/report/export-snapshot.test.ts` -- NEW: `toSnapshotDoc` — prose→prose; query+table→table with `encode`d data AND `truncated` carried through; query+chart(valid spec)→chart; query+chart(spec invalid vs current columns)→table fallback; null-result→empty("no data"); info/rows-affected block→empty with the info note; errored→empty; a block whose `encode` would throw→empty("could not freeze"), and the OTHER blocks still serialize; `schemaVersion` stamped; `decode(block.data)` deep-equals the original (round-trip). `buildSnapshotHtml` embeds the report's frozen data (decode round-trip out of the HTML). `runExport` — a non-OK / empty runtime fetch throws and does NOT call `download`; a successful fetch calls `download` with the assembled HTML. `snapshotFilename` deterministic under an injected clock. `triggerHtmlDownload` no-ops (no throw) when `document` is undefined -- the mapping matrix rows + Ring-2 export wiring + error paths.
- [x] `src/ui/report/ReportTabView.tsx` -- add a quiet **ghost "Export snapshot"** button to the toolbar (secondary emphasis, `ghostBtn`, never primary). On click drive `runExport` (fetch `/snapshot-runtime.js` once via a `fetchRuntime` that checks `res.ok`, then `triggerHtmlDownload`). **Error handling (required):** wrap the whole export in try/catch — a failed fetch / non-OK response / assembly error surfaces a user-visible export error (e.g. a transient error message on the tab) and is never a silent unhandled promise rejection, and never welds an error body into the file. **Concurrency guard (required):** track an in-flight flag; disable the button (or ignore the click) while an export is running so a double-click cannot launch overlapping exports/downloads. Must not reorder, mutate, or clear any block; works with an empty report -- the export entry point.
- [x] `src/ui/report/ReportTabView.test.tsx` -- extend the smoke test: an "Export snapshot" ghost button renders; a static render never mutates block state. (Click-driven fetch/error/download coverage lives in `export-snapshot.test.ts` via `runExport`, since this repo has no jsdom.) -- render + non-mutation guard.

**Acceptance Criteria:**
- Given a Report of prose + query blocks (table and chart views) run against a database, when the author exports a Snapshot, then a single self-contained `.html` is produced that — opened later with no quick-studio, no database, and no network — renders the same prose, tables, and charts with identical data (FR-20, UJ-4).
- Given the Snapshot's embedded data, when written, then it is exactly the canonical schema-version-stamped `FrozenData`/`SnapshotDoc` shape from `shared/` — the same shape the sandbox consumes (AR-11) — verified by a decode round-trip.
- Given export runs, when it assembles and downloads, then no request is made to any external service, the frozen report data never leaves Ring 2, and the produced file's CSP forbids network access (`connect-src 'none'`) (R5).
- Given a Report re-targeted (Story 6.2) at some connection, when exported, then the Snapshot freezes exactly the currently-displayed block results — export executes no query and needs no connection.
- Given the export action, when shown in the toolbar, then it is a quiet ghost/secondary control and does not reorder, mutate, or clear any block.
- Given frozen data containing hostile string values (e.g. `</script>`, HTML), when exported and reopened, then those values render inert as text — no script executes and no markup breaks out.
- Given a query block whose result was row-capped by the Core (`truncated`), when exported, then the Snapshot carries the `truncated` flag and renders a visible truncation affordance — a shared Snapshot never presents partial data as complete.
- Given export fails (the runtime fetch is unreachable / returns a non-OK response, or assembly throws), when the author clicks Export, then a user-visible error is surfaced and NO file (and never a broken/error-body file) is downloaded — the failure is never a silent unhandled rejection.
- Given the author double-clicks Export, when an export is already in flight, then the second click is ignored (the control is disabled) — no overlapping exports or duplicate downloads.
- Given a Snapshot file that is corrupted, hand-edited, or from a mismatched schema version, when it is reopened, then the runtime shows a visible "cannot open snapshot" message (not a blank page), and a single malformed block renders an inline error without dropping the other blocks.

## Spec Change Log

### 2026-07-12 — bad_spec loopback (iteration 1)

- **Triggering findings:** the adversarial + edge-case review found the spec under-specified (1) data integrity — the `truncated` flag (born in 6.1 precisely so "a shared report never presents partial data as complete") was silently dropped, so a Snapshot of a row-capped result looks complete [HIGH]; (2) injection — `assembleSnapshotHtml` escaped the JSON payload but inlined the minified `runtimeJs` raw, so a `</script>` literal inside Observable Plot/micromark breaks the whole file, and the test used a benign fake runtime so proved nothing [MEDIUM]; (3) export error handling — `handleExport` had no try/catch, no `res.ok` check, no `encode()` guard, and no double-click guard, so a failed fetch welds an error body into the file or becomes a silent unhandled rejection, and the one piece with real I/O was untested [MEDIUM]; (4) runtime resilience — `bootstrap` isolated only the chart branch, so one throwing block aborts all later blocks, and an invalid payload yields a blank page [MEDIUM]; (5) the runtime never validated the payload it trusts (`isSnapshotDoc` only checked `data` is an object; the inner `FrozenData.schemaVersion` was never cross-checked) [LOW]; plus minor content/robustness gaps: a successful non-SELECT (`info`/rows-affected) block exported as "no data", a stale chart spec embedded without re-validation, an object-URL leak on a throwing click, and a dead `img-src data:` CSP grant [LOW].
- **Amended (all OUTSIDE `<intent-contract>`):** added a `truncated` flag to the `SnapshotBlock` table/chart types + mapping + a runtime truncation affordance; required a second `</script`-escape on the inlined `runtimeJs` and a hostile-runtime test; deepened `isSnapshotDoc` to deep-validate `FrozenData` and the inner schema version; added a testable `runExport` orchestrator with `res.ok`/fetch/encode error paths, per-block `encode` guarding, an `info`→note mapping, `parseChartSpec` re-validation with table fallback, object-URL revoke in `finally`, a UI error surface, and a double-click in-flight guard; required runtime per-block render isolation + a visible "cannot open snapshot" fallback; dropped the unused `img-src data:`; corrected the server task to `src/core/server.ts` (Core origin, same-origin fetch); added five ACs.
- **Known-bad state avoided:** a Snapshot presenting truncated data as complete; a whole export broken/aborted by one `</script>` literal or one malformed cell; a silent failed export or an error page welded into the "snapshot"; a reopened corrupt file showing a blank page; a mutation block mislabeled "no data".
- **KEEP (must survive re-derivation):** the core architecture is correct — re-derive as-is: assembly stays PURE in Ring 2 + `shared/` with the frozen data never leaving the browser (no `report.export*` RPC); the `embedJson` escaping of the JSON payload (`<`,`>`,`&`,U+2028/9) and the 5-char HTML-escape of every table cell + column name; the offline guarantee (CSP `connect-src 'none'`, zero `http(s)://` refs); Observable Plot via `buildPlotOptions` + `renderMarkdownToHtml` reuse from `src/sandbox/render.ts` (no third renderer); the block-mapping matrix (prose/table/chart/chart-null-spec→table/null-result→empty/errored→empty); the shared-types + Ring-2-mapping ring split; serving `/snapshot-runtime.js` from the **Core origin** (`server.ts`, mirroring `/app.js`) so the same-origin `fetch` works; the `typeof document` DOM seams with pure cores. The fixes ADD data-integrity, injection, and resilience hardening on top of this structure — do not discard it.

## Review Triage Log

### 2026-07-12 — Review pass

- intent_gap: 0
- bad_spec: 10: (high 1, medium 4, low 5)
- patch: 0
- defer: 0
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[high]` `[bad_spec]` `truncated` flag dropped — a row-capped result exported as complete (data integrity, contradicts 6.1's shared-report guarantee); spec now carries `truncated` through the type/mapping and renders a truncation affordance.
  - `[medium]` `[bad_spec]` Inlined `runtimeJs` not escaped for `</script>` (minified Plot/micromark could break the file); test used a benign fake runtime; spec now requires a second `</script`-escape on the runtime and a hostile-runtime test.
  - `[medium]` `[bad_spec]` `handleExport` had no try/catch, no `res.ok` check, no `encode` guard → silent failure or an error body welded into the file; spec now adds a testable `runExport` orchestrator with typed fetch/encode error paths and a UI error surface.
  - `[medium]` `[bad_spec]` `bootstrap` isolated only the chart branch → one throwing block aborts all later blocks; spec now requires per-block render isolation.
  - `[medium]` `[bad_spec]` The export action (real I/O + error paths) was untested; spec now routes it through `runExport` and mandates fetch/error/encode-degradation tests.
  - `[low]` `[bad_spec]` Runtime never validated the payload it trusts (`isSnapshotDoc` shallow; inner `FrozenData.schemaVersion` unchecked); spec now deep-validates `FrozenData` + the inner version and renders a "cannot open snapshot" fallback on failure.
  - `[low]` `[bad_spec]` Successful non-SELECT (`info`/rows-affected) block exported as misleading "no data"; spec now maps it to an `empty` block whose note is the info text.
  - `[low]` `[bad_spec]` Stale/mismatched chart spec embedded without re-validation; spec now re-checks with `parseChartSpec` and falls back to a table.
  - `[low]` `[bad_spec]` Object-URL leaked if the download anchor click throws; spec now requires `revokeObjectURL` in a `finally`.
  - `[low]` `[bad_spec]` Dead `img-src data:` CSP grant (no code path emits images); spec now drops it — no unused attack surface.
  - Rejected (dropped): CSP `script-src 'unsafe-inline'` "removes the sandbox backstop" (inherent and unavoidable for a self-contained file that runs its own inlined runtime — escaping is by-design the sole guard); the open `/snapshot-runtime.js` sitting before the origin/token gates (by-design, data-free, mirrors the already-open `/app.js`; security rests on the bundle being secret-free, which `build-snapshot.ts` enforces); very-large-result OOM on export (inherent to embedding data and bounded by the Core row cap / truncation).

### 2026-07-12 — Review pass (post-loopback re-derivation)

- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 0
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[low]` `[patch]` `URL.revokeObjectURL` was called synchronously right after the download `anchor.click()` — some browsers (Safari) cancel the download when the blob URL is revoked in the same tick. Fixed: the revoke is deferred via `setTimeout(…, 0)` in the `finally`, so a large snapshot still downloads.
  - `[low]` `[patch]` The export double-click guard read stale React `exporting` state, so two same-tick clicks both passed (`disabled` was the only real guard, effective only after re-render). Fixed with a `useRef` in-flight flag checked/set at the top of `handleExport` and reset in `finally`.
  - `[low]` `[patch]` An exported empty report (zero blocks) rendered a blank body instead of the I/O-matrix-required "empty report" affordance. Fixed: `renderDocInto` emits an escaped "This report has no blocks." affordance when `blocks.length === 0`; covered by a new pure test.
  - Rejected (dropped, all low / by-design / no contract break): CSP `script-src 'unsafe-inline'` degrading defense-in-depth (inherent to a self-contained file running its own inlined scripts — the per-cell/column HTML-escape + micromark raw-HTML-off are the by-design guard, and `connect-src 'none'` still blocks all egress; prior pass); no jsdom integration test exercising `bootstrap`/`Plot.plot` under live CSP (matches the established sandbox pattern — Plot runs only in the DOM seam there too — and the spec's manual-check verification opens the file offline to confirm render/zero-network); the runtime `</script`-escape not covering a `</script`/`<!--` occurrence OUTSIDE a string literal in the trusted Bun-minified bundle (the only real breakout — a string-embedded `</script>` — is handled; a bare token in valid minified JS is not emitted); chart truncation note ordering vs a subsequent chart-render failure (cosmetic, no integrity loss); export error message persisting until the next export attempt (minor UX; clears on retry); a hand-edited cell whose `value` mismatches its `kind` throwing at render (corrupted-input only; the per-block try/catch degrades it to an inline error note); a hand-edited file missing the `#__qs_report` host (the assembler always emits it); a block carrying both a non-null `result` and an `error` (unreachable — the report reducers clear `result`/`error`/`info` mutually); a prose Markdown `http(s)` image showing broken (CSP `default-src 'none'` blocks the request, so the offline/no-egress guarantee holds — only the image is blank).

## Design Notes

- **A Snapshot is "Epic 5's sandbox rendering, frozen."** Reuse the same primitives (`renderMarkdownToHtml` + Observable Plot `buildPlotOptions`), inline the runtime bundle and the `SnapshotDoc`, and the file renders each block on load. Offline is guaranteed by CSP `connect-src 'none'` plus zero external references — not by trust.
- **Assembly stays in Ring 2 + `shared/` (pure); the data never leaves the browser.** This is the strongest reading of "no data to any external service" — the frozen data isn't even sent to the loopback Core. The Core's only role is serving the static, data-free `/snapshot-runtime.js` bundle (mirrors `/guest.js`). Do not add a `report.export*` RPC that ships block data to the Core.
- **Two renderers by ring is intentional (AR-14).** In-app preview uses Recharts; the Snapshot uses Observable Plot. Same `ChartSpec` + `FrozenData` → identical **data**, possibly different pixels. Do not unify or bundle Recharts into the Snapshot.
- **Export is mode-independent.** It is a user-initiated browser download, not app-state persistence, so it never touches the Persistent/Ephemeral app-directory rule (AR-8/AR-9) and works in both modes.
- **Injection safety is the core risk.** Frozen values are untrusted database strings. Escape at three points: the embedded JSON payload (`</script`, U+2028/9), every table cell (HTML-escape), and prose (reuse the sanitizing `renderMarkdownToHtml`). All three are tested.
- **Orthogonal to targeting (6.2).** The Snapshot freezes whatever `block.result` currently holds (the last target's data). Export runs no query and needs no connection — it is independent of which target produced the data.
- **Truncation must propagate.** 6.1 introduced `truncated` so a shared report never presents partial (row-capped) data as complete. The Snapshot IS the shared report, so the flag rides through to the embedded block and the runtime renders a visible affordance. Dropping it is a data-integrity defect, not a cosmetic one.
- **Two escapes, both load-bearing.** A self-contained file inlines TWO scripts: the JSON data payload AND the runtime bundle. Both can contain a `</script>` (data from untrusted DB strings; the runtime from a minified third-party bundle). Escape both — the JSON via `\u`-escaping `<`/`>`/`&`/U+2028/9, the runtime via `</script`→`<\/script`. Test the runtime escape with a genuinely hostile runtime string, not a benign placeholder.
- **CSP is not a second layer here (residual risk).** Unlike the Ring-3 sandbox (`script-src 'self'` blocks inline handlers as a backstop), a self-contained Snapshot MUST allow `script-src 'unsafe-inline'` to run its own inlined runtime. So `renderMarkdownToHtml` sanitization + the per-cell/column HTML-escape are the SOLE guard against prose/table injection — they must be correct, and `connect-src 'none'` is what still guarantees no egress even if rendering misbehaves.
- **Resilience on the reopen path.** A Snapshot outlives the app that made it and may be corrupted, hand-edited, or from a future schema. The runtime therefore validates the payload (`isSnapshotDoc` deep-checks `FrozenData` + the inner `FROZEN_SCHEMA_VERSION`) and degrades visibly: an invalid doc → "cannot open snapshot"; a single throwing block → an inline error note without dropping siblings. Never a blank page.
- **Export error handling is a contract, not an afterthought.** The fetch of `/snapshot-runtime.js` can 404/500/reject; `encode` can throw on a pathological cell; the user can double-click. The `runExport` orchestrator (injectable `fetchRuntime`/`download`) makes all of these unit-testable without a DOM: a non-OK/empty runtime response throws before any download, a throwing block degrades to an `empty` note rather than aborting the export, and the UI guards concurrency + surfaces failures. Never weld an error body into the file; never fail silently.

## Verification

**Commands:**
- `bun test src/shared/snapshot.test.ts src/shared/snapshot-html.test.ts src/snapshot/runtime.test.ts src/ui/report/export-snapshot.test.ts src/ui/report/ReportTabView.test.tsx` -- expected: all snapshot + export + report tests pass
- `bunx tsc --noEmit` -- expected: no type errors (strict, `noUncheckedIndexedAccess`)
- `bun run build` -- expected: UI + sandbox + **snapshot** bundles build cleanly (new `build-snapshot` step wired in)

**Manual checks (if no CLI):**
- Build a Report with a prose block, a table-view query block, and a chart-view query block; run them; click **Export snapshot**. Open the downloaded `.html` in a browser with quick-studio stopped and the network set offline (devtools "Offline"): prose, table, and chart render with identical data and the Network panel shows zero requests.

## Auto Run Result

Status: done

**Summary of implemented change**
Adds **Export snapshot** to the Report tab: a Report's currently-displayed blocks (prose, tabular data, charts) are serialized into a single, fully self-contained `.html` file with the data frozen at build time via the canonical AR-11 `FrozenData` shape (`encode()`, schema-version-stamped), that renders identically when reopened with no quick-studio, no database, and no network. Assembly is pure Ring-2 + `shared/` (the frozen data never leaves the browser); the offline renderer reuses the Epic 5 sandbox stack (Observable Plot + micromark) and is inlined into the file; the Core only serves the static, data-free renderer bundle; delivery is a browser Blob download. Offline is enforced at the document level by CSP `connect-src 'none'` with zero external references.

**Files changed**
- `src/shared/snapshot.ts` (NEW) — snapshot doc types (`SnapshotBlock`/`SnapshotDoc`, `truncated` on table/chart) + `isSnapshotDoc` deep-validating `FrozenData` (via `decode`) and the inner `FROZEN_SCHEMA_VERSION`.
- `src/shared/snapshot.test.ts` (NEW) — guard tests: each kind, wrong doc/inner version, ragged/invalid `FrozenData`, invalid chart spec.
- `src/shared/snapshot-html.ts` (NEW) — pure `assembleSnapshotHtml`: CSP (`connect-src 'none'`, no `img-src`), `embedJson` payload escaping, independent `</script`-escape of the inlined runtime.
- `src/shared/snapshot-html.test.ts` (NEW) — decode round-trip out of the HTML, no external refs, CSP present, hostile-cell + hostile-runtime `</script>` neutralization.
- `src/snapshot/runtime.ts` (NEW) — offline renderer: pure `renderBlock`/`renderTableToHtml` (HTML-escapes cells + column names), truncation affordance, empty-report affordance, prose via `renderMarkdownToHtml`, chart via `buildPlotOptions` (Observable Plot); `bootstrap`/`mountSnapshot` DOM seam with a "cannot open snapshot" fallback and per-block render isolation.
- `src/snapshot/runtime.test.ts` (NEW) — escaping, per-kind formatting, dispatch, truncation, empty-report, per-block isolation, invalid-payload fallback — all DOM-free.
- `scripts/build-snapshot.ts` (NEW) — Bun bundler → `src/core/snapshot-bundle.generated.ts` (git-ignored).
- `src/ui/report/export-snapshot.ts` (NEW) — Ring-2 `toSnapshotDoc` mapping (truncation carried; info→note; chart-spec revalidation→table fallback; per-block `encode` guard), `buildSnapshotHtml`, deterministic `snapshotFilename`, injectable `runExport` (checks `res.ok`), `triggerHtmlDownload` (deferred object-URL revoke).
- `src/ui/report/export-snapshot.test.ts` (NEW) — full mapping matrix, round-trip, `runExport` error paths.
- `src/ui/report/ReportTabView.tsx` (MOD) — ghost "Export snapshot" button, `useRef` in-flight guard, `role="alert"` error surface; no block mutation.
- `src/ui/report/ReportTabView.test.tsx` (MOD) — button renders; static render never mutates state.
- `src/core/server.ts` (MOD) — serves `GET /snapshot-runtime.js` from the Core origin (open, data-free), mirroring `/app.js`.
- `package.json` (MOD) — `build` runs `bun scripts/build-snapshot.ts`. `.gitignore` (MOD) — ignores the generated snapshot bundle.

**Review findings breakdown**
- Pass 1 (bad_spec loopback, iteration 1): 10 bad_spec findings (high 1, medium 4, low 5) drove a spec amendment + full re-derivation — chiefly the dropped `truncated` flag (data integrity), the un-escaped inlined runtime `</script>`, missing export error handling, runtime per-block isolation + payload deep-validation, and mapping refinements. 3 rejected (by-design).
- Pass 2 (post-loopback): 0 intent_gap, 0 bad_spec — central contract (offline, no-egress, injection-safe, AR-11, truncation) confirmed resolved by both reviewers. 3 low patches applied (deferred object-URL revoke, ref-based double-click guard, empty-report affordance); 10 low findings rejected as by-design / corrupted-input-only / unreachable.

**Verification performed**
- `bun test` (5 target files): 52 pass / 0 fail.
- `bunx tsc --noEmit`: clean (strict, `noUncheckedIndexedAccess`).
- `bun run build`: clean — ui + sandbox + snapshot bundles emitted.
- Full `bun test`: 962 pass / 0 fail across 61 files.

**Residual risks**
- Defense-in-depth: a self-contained Snapshot must run its own inlined scripts, so its CSP uses `script-src 'unsafe-inline'` — the HTML-escape (cells/columns) + micromark raw-HTML-off are therefore the sole guard against prose/table injection (all closed and tested); `connect-src 'none'` still guarantees no egress regardless. The real offline render (`Plot.plot` under live CSP) is exercised only by the manual check, matching the repo's no-jsdom sandbox pattern.
