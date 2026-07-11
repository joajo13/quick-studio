---
title: 'Build a Report from query results'
type: 'feature'
created: '2026-07-11'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'a4afb130f126d5ba48d1157bd194749319c44c12'
final_revision: 'f9a550a0681112cdf342b8a0963708d6cfd42434'
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** quick-studio has no way to assemble query results into a shareable Report; the `report` tab kind is wired end-to-end but renders only a placeholder. This is Epic 6's foundation story — the marquee "send me a report on the database" workflow starts here.

**Approach:** build an in-app (Ring 2) Report builder tab that composes an ordered list of content Blocks — narrative prose, tabular data, and charts — where table and chart blocks are driven by their own SQL query run through the Core, so one Report can combine results from more than one query. Charts render in-app with Recharts (Ring 2); the whole build-and-preview flow is local, sending no data to any external service.

## Boundaries & Constraints

**Always:**
- Every block that shows data runs its SQL through the existing `runRawQuery` seam (loopback Core, AR-2) and holds the returned `FrozenData`; the Report never touches a database driver or network directly.
- A Report supports two or more independent query blocks, each with its own SQL and result (FR-18).
- In-app charts are drawn with **Recharts** in Ring 2 (AR-14), fed from `FrozenData` + the existing `ChartSpec` (mark ∈ line/bar/dot/area). Observable Plot / the Ring 3 sandbox are NOT used for in-app report rendering.
- Narrative prose renders as Markdown with raw HTML disabled (same trust model as the sandbox guest's markdown pass) — no script, no arbitrary embeds.
- The report content/state model is pure and DOM-free (mirrors `workspace-state.ts` / chat state) and unit-tested; per-tab report state is held in `App.tsx` keyed by tab id (mirrors `chatStates`).
- Follow the monospace-first, dark-first, coral-accent design idiom used across the workspace tabs.

**Block If:**
- Implementing a task appears to require embedding executable or third-party JavaScript into Ring 2 (this would breach the sandbox trust boundary reserved for Ring 3). Executable-JS blocks are out of scope for 6.1 — HALT rather than introduce an in-app code-execution path.

**Never:**
- No export of any kind — no Snapshot, no Live Report, no HTML emission (Stories 6.3 / 6.4).
- No test-to-production re-targeting (Story 6.2).
- No persistence of Report content to disk and no report-store / RPC method (report content is in-memory per tab in 6.1, consistent with query drafts and chat results which are not persisted).
- No Ring 3 sandbox usage, no Observable Plot, no MDX-runtime / executable-JS blocks.
- No shared cross-tab "query results registry" — each Report runs and owns its own queries.
- No data sent to any external service (R5); the only outbound call is the loopback Core query.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Add prose block | user adds a narrative block, types Markdown | block renders as sanitized HTML in preview | raw HTML/script stripped, never executed |
| Add query block → table | block SQL returns rows | `FrozenData` held on the block; rendered read-only via `DataGrid` | on query error, block shows the error, no result |
| Query block → chart | block has rows + a valid `ChartSpec` | Recharts chart drawn from `FrozenData` (Ring 2) | invalid/absent chart spec → fall back to table view, no crash |
| Two query blocks | two blocks with different SQL | both results held independently; Report combines them (FR-18) | one block failing does not affect the other |
| Empty Report | no blocks | empty-state prompt to add a block | n/a |
| Reorder / remove block | user moves or deletes a block | ordered block list updates purely; preview reflects order | removing a running/last block is total, no throw |
| Confirmation-required SQL | a query block's SQL is a guarded/destructive op | surfaced as the Core's `confirmation_required` outcome, not auto-run | block stays unrun until confirmed |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- `FrozenData`, `WorkspaceTabKind` (`report` already registered); consume, do not modify
- `src/shared/chart-spec.ts` -- `ChartSpec`, `parseChartSpec`, `MARK_KINDS`; reuse for chart blocks
- `src/ui/workspace/run-raw-query.ts` -- `runRawQuery(sql, confirmed?)` → `RunOutcome`; the query seam for data blocks
- `src/ui/data/DataGrid.tsx` -- read-only tabular block (empty `primaryKeys`, no mutation callbacks)
- `src/ui/workspace/ChatTabView.tsx` -- reference composer that pairs `runRawQuery` with a chart spec
- `src/ui/workspace/TabContent.tsx` -- add the `report` branch (currently placeholder)
- `src/ui/App.tsx` -- add per-tab `reportStates` map + `onReportStateChange` (mirror `chatStates`)
- `src/ui/styles/globals.css` -- design tokens (mono font, coral accent, `--card`/`--border`/`--radius`)
- `package.json` -- add `recharts` (Ring 2 charting dep, AR-14)

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- add the `recharts` dependency -- AR-14 mandates Recharts for in-app (Ring 2) report charts; not yet installed
- [x] `src/ui/report/report-state.ts` -- pure, DOM-free Report model + reducer: `ReportBlock` union (`prose{markdown}` | `query{sql, result: FrozenData|null, view: "table"|"chart", chart: ChartSpec|null, error?}`), `emptyReport`, `addProseBlock`, `addQueryBlock`, `updateProse`, `setBlockResult`, `setBlockError`, `setBlockView`, `setBlockChart`, `removeBlock`, `moveBlock` -- foundational testable state, mirrors `workspace-state.ts`
- [x] `src/ui/report/report-state.test.ts` -- unit-test every reducer + the I/O matrix state transitions (add/remove/reorder, multi-query independence, view/chart toggles) -- totality and multi-query support (FR-18)
- [x] `src/ui/report/report-chart.ts` -- pure mapper from `FrozenData` + `ChartSpec` to Recharts-ready `{records, xKey, series, mark}`; convert `FrozenCell`s to primitives (date → ISO string) -- decouples Recharts wiring from data shape
- [x] `src/ui/report/report-chart.test.ts` -- unit-test the mapper across mark kinds and cell types, including null/date cells and absent columns -- chart correctness without a DOM
- [x] `src/ui/report/report-markdown.ts` -- render prose Markdown to sanitized HTML via `micromark` with `allowDangerousHtml:false` + URL-scheme sanitize (same config as the sandbox guest's pass) -- narrative blocks, no external embeds
- [x] `src/ui/report/report-markdown.test.ts` -- assert script/raw-HTML is not emitted and dangerous URL schemes are neutralized -- R5 / no-code-execution
- [x] `src/ui/report/ReportChart.tsx` -- Recharts component consuming `report-chart.ts` output (line/bar/area/scatter for the four `MARK_KINDS`) -- Ring 2 chart rendering (AR-14)
- [x] `src/ui/report/ReportTabView.tsx` -- the builder+preview view: add prose/query blocks, edit SQL, run via `runRawQuery`, toggle table/chart, reorder/remove; renders prose (sanitized HTML), tables (`DataGrid`), and charts (`ReportChart`); mono/coral/dark idiom -- the Report tab UI
- [x] `src/ui/report/ReportTabView.test.tsx` -- `react-dom/server` smoke test: renders empty state and a populated multi-block report without throwing -- render integrity
- [x] `src/ui/workspace/TabContent.tsx` -- replace the `report` placeholder with `ReportTabView`, keyed by `tab.id`, wired to per-tab report state -- surfaces the tab
- [x] `src/ui/App.tsx` -- hold `reportStates: ReadonlyMap<number, ReportState>` with an `onReportStateChange(tabId, next)` handler; pass into `TabContent` (mirror `chatStates`) -- per-tab isolation

**Acceptance Criteria:**
- Given a Report with two query blocks whose SQL differs, when both run, then each holds its own `FrozenData` and both render in the preview (FR-18).
- Given a Report, when the author adds prose, a table block, and a chart block, then all three render together in reading order, with the chart drawn by Recharts in-app (AR-14).
- Given a query block, when its SQL runs, then it executes through `runRawQuery`/the Core loopback and no request leaves the machine to any external service (R5).
- Given a chart block whose data has no valid `ChartSpec`, when it renders, then it degrades to the table view without throwing.
- Given the `report` tab is opened, closed, and reopened, when it mounts, then it is isolated per tab id and does not leak state across tabs.

## Spec Change Log

_No bad_spec loopbacks — the intent contract held through implementation and review._

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 0
- reject: 6: (high 0, medium 1, low 5)
- addressed_findings:
  - `[medium]` `[patch]` FR-18 concurrent-completion clobber: `ReportTabView` folded run results off last-rendered `stateRef`, so two blocks resolving in one React batch could overwrite each other — reworked state writes to functional updaters composed against the latest state (signature threaded through `App`/`Workspace`/`TabContent`); both concurrent results now survive.
  - `[medium]` `[patch]` truncated result surfaced: `runRawQuery`'s `truncated` flag was discarded, letting a shared report present partial data as complete — now carried on block state and shown as a neutral "showing first N rows (truncated)" note.
  - `[medium]` `[patch]` non-numeric chart column: `mapChart` validated only column presence, so a string/date `y` rendered a blank chart — now returns `null` (degrading to the table view per the AC) when the `y` column type is not `number`.
  - `[low]` `[patch]` successful `ok` (DML/DDL) outcome was painted as a red `role="alert"` error — routed to a neutral info state ("N rows affected").
  - `[low]` `[patch]` multi-series pivot collision: a series value equal to the `xKey` column name overwrote the x value — series columns now namespaced under a reserved `s:` prefix.
  - `[low]` `[patch]` null/empty series value produced a phantom `dataKey=""` series — such rows are now skipped.
  - `[low]` `[patch]` URL sanitizer bypass: `isSafeUrl` rejected only literal `//` protocol-relative links, letting `/\host` / `\\host` (micromark-encoded `%5c`) through — now decodes+folds backslashes and rejects all protocol-relative forms.
  - `[low]` `[patch]` prose Markdown re-rendered on every keystroke across all blocks — memoized per block markdown.
  - `[low]` `[patch]` orphaned transient run state: a completion for a block removed mid-flight re-created its run state — `applyOutcome` now no-ops when the block id is absent from the latest state.
  - Rejected (dropped): `dot`→Scatter rendering (unconfirmed without a DOM; left as residual risk), URL-attr regex rewriting literal `href="…"` text (risky fix, low value), duplicate-column-name collapse in `frozenToRecords` (narrow trigger), x/y/series distinctness in the chart editor (UX nicety), pivot without aggregation on duplicate (x,series) pairs (acceptable limitation).

### 2026-07-11 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 1, medium 3, low 0)
- defer: 0
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[high]` `[patch]` Chart authoring was completely broken: `ChartSpecEditor` was fully controlled off `block.chart`, and `parseChartSpec` requires BOTH `x` and `y` to name real columns — so every partial pick (x set, y still empty) parsed to `null`, wiped the spec, and reverted the dropdown. No interaction order could accumulate x AND y, making the story's headline in-app chart uncomposable. The editor now holds a LOCAL draft (rendered from its own state, seeded from the stored spec), so partial picks persist while `onChange` still parses the draft to a `ChartSpec | null` for the preview.
  - `[medium]` `[patch]` FR-18 clobber reintroduced on user-action writes: the prior pass moved async run completions to functional updaters, but every user-triggered write (add/remove/reorder/edit-sql/view/chart) still passed a value computed from the render-time `state` snapshot, and `App.onReportStateChange` ignores `prev` for the value form — so a user edit landing in the same React batch as a concurrent query result could discard that result. All user-action writes now use the functional-updater form too, closing the isolation guarantee the code asserts.
  - `[medium]` `[patch]` Remote image egress (R5): `report-markdown` allowed `http(s)` on image `src` identically to link `href`; a Markdown `![](https://host/x)` emits a live `<img>` that auto-fetches on render. Unlike the Ring 3 sandbox (whose CSP `connect-src 'none'` backstops egress), the report renders in Ring 2 with no CSP, so this sent a request off the machine on preview. Image `src` with any explicit scheme is now neutralized to `#`; scheme-less relative srcs still render. Locked with a test.
  - `[medium]` `[patch]` Recharts silent series drop: pivot keys and axis keys were passed to Recharts as STRING `dataKey`s, which Recharts resolves as lodash paths — so a column name or series value containing `.`/`[`/`]` (e.g. `web.prod`, `2024.01`, a dotted SQL alias) was mis-read as a nested lookup and the series/axis rendered blank. All `dataKey`s (axis + every mark) now use a function accessor that reads `record[key]` directly, bypassing path parsing.
  - Rejected (dropped): `mapChart` non-`number` y-type guard (Core infers column type from actual values, so numeric aggregates like `COUNT(*)` are typed `number` — premise doesn't hold); `dot`→Scatter categorical-axis (DOM-unconfirmable residual, already noted); pivot `String()` collision of mixed-type x (number `1` vs string `"1"`, narrow); all-null series column → blank chart (recoverable via table/clear-series); duplicate `(x,series)` pair last-wins (acceptable limitation); duplicate column-name collapse (narrow trigger); `setRuns` stale-closure on transient run state (self-heals); `firing.current` entry not reclaimed on removal (harmless, monotonic ids); stale chart-spec column option after SQL re-run (cosmetic); `isSafeUrl` non-ASCII whitespace (browser rejects invalid scheme — defense-in-depth only); `mapChart` x===y degenerate chart (no crash); stale result shown after SQL edit before re-run (run button adjacent); `href`/`src` rewrite touching escaped code samples (risky fix, low value); selected grid row index past end after shorter re-run (`applyOutcome` resets to null); first-series CSS-var vs hardcoded-hex palette (cosmetic).

## Design Notes

- **Interpreting "MDX Blocks":** 6.1 ships a pragmatic, typed block model (prose / query-table / query-chart), not a full MDX runtime. Executable-JS authoring (CAP-10, aspirational) needs the Ring 3 sandbox and belongs to the export stories — deliberately excluded here.
- **Why Ring 2, not the sandbox:** the builder/preview renders the author's own trusted content over local `FrozenData`; AR-14 assigns exactly this surface to Recharts in Ring 2. The Ring 3 sandbox (Observable Plot) is reserved for exported/untrusted content in 6.3/6.4.
- **Markdown duplication:** `micromark` config is repeated in `report-markdown.ts` rather than lifted to `src/shared/` — `shared/` is dependency-free by contract, and micromark is a Ring dependency. A few lines of duplicated config is the correct trade to keep ring boundaries clean.
- Block model sketch:
  ```ts
  type ReportBlock =
    | { id: number; kind: "prose"; markdown: string }
    | { id: number; kind: "query"; sql: string; result: FrozenData | null;
        view: "table" | "chart"; chart: ChartSpec | null; error?: string };
  ```

## Verification

**Commands:**
- `bun test src/ui/report` -- expected: all report unit + smoke tests pass
- `bunx tsc --noEmit` -- expected: no type errors (strict, `noUncheckedIndexedAccess`)
- `bun run build` -- expected: UI + sandbox bundles build cleanly with the new tab

**Manual checks (if no CLI):**
- Open a `report` tab, add prose + two query blocks against a test DB, toggle one to a chart: prose renders, both tables show, the chart draws in-app; closing/reopening the tab shows no cross-tab state bleed.

## Auto Run Result

Status: **done**

### Implemented change
Delivered the Epic 6 foundation: an in-app (Ring 2) Report builder tab. The already-registered `report` tab kind now renders a real `ReportTabView` where a developer composes an ordered list of Blocks — narrative prose (sanitized Markdown), tabular data, and charts — each data block running its own SQL through the loopback Core (`runRawQuery`, AR-2), so one Report combines results from more than one query (FR-18). Charts render in-app with Recharts (Ring 2, AR-14); the Ring 3 sandbox / Observable Plot are untouched (sandbox bundle byte-identical). The whole build-and-preview flow is local — no data leaves the machine (R5). Report state is a pure, DOM-free model held per tab id in `App.tsx` (mirrors `chatStates`), session-only and never persisted. Export, re-targeting, and disk persistence are intentionally out of scope (Stories 6.2/6.3/6.4).

### Files changed
- `src/ui/report/report-state.ts` (+test) -- pure, DOM-free Report block model + reducers (add/update/run-result/error/ok/view/chart/remove/move), total on bad ids
- `src/ui/report/report-chart.ts` (+test) -- pure `FrozenData`+`ChartSpec` → Recharts-ready mapper; returns `null` (table fallback) on absent or non-numeric `y` column
- `src/ui/report/report-markdown.ts` (+test) -- Ring-2 micromark renderer, raw HTML disabled + URL-scheme/backslash sanitize
- `src/ui/report/ReportChart.tsx` (+test) -- Recharts component (line/bar/area/dot), namespaced multi-series pivot
- `src/ui/report/ReportTabView.tsx` (+test) -- builder+preview UI: add/edit/run/reorder/remove blocks, table/chart toggle, chart-spec editor, confirm-run for guarded SQL
- `src/ui/workspace/TabContent.tsx` -- `report` branch renders `ReportTabView`, keyed by `tab.id`
- `src/ui/workspace/Workspace.tsx` -- threads `reportStates` / `onReportStateChange`
- `src/ui/App.tsx` -- per-tab `reportStates` map + functional-updater handler + close-time reclamation
- `package.json` / `bun.lock` -- added `recharts` (Ring-2 charting, AR-14)

### Review findings
- 2 adversarial reviewers (Blind Hunter + Edge Case Hunter). Triage: 0 intent_gap, 0 bad_spec, **9 patches applied** (3 medium, 6 low), 0 deferred, 6 rejected.
- Highest-value patches: FR-18 concurrent-completion clobber (functional-updater serialization), silent `truncated` now surfaced, non-numeric chart column degrades to table. See Review Triage Log for the full list.
- No hard constraint (ring boundary, Core-only data path, no-external-egress, out-of-scope exclusions) was violated by the implementation.

### Verification
- `bunx tsc --noEmit` -- pass (exit 0).
- `bun test` (full suite) -- 885 pass / 0 fail (55 files).
- `bun run build` -- pass; UI bundle rebuilt, sandbox bundle byte-identical (342345) confirming Recharts stayed out of Ring 3.

### Follow-up review
`followup_review_recommended: true` — the review pass applied 9 patches including three medium-severity behavioral changes (concurrency serialization, truncation surfacing, chart validation) spanning state wiring across four files; an independent follow-up review is worthwhile.

### Residual risks
- The `dot`→Scatter mark could not be visually confirmed (Recharts needs a DOM the `bun test`/`react-dom/server` setup does not provide); the other three marks are idiomatic. Worth a manual/QA check when a real DB is attached.
- Prose text that literally contains `href="…"`/`src="…"` as prose can be cosmetically rewritten by the URL sanitizer (trusted-author, low impact — left as-is).

## Follow-up Review Result (2026-07-11)

An independent follow-up review pass (Blind Hunter + Edge Case Hunter, same model capability) surfaced a functionally-blocking defect the first pass missed.

### Findings breakdown
- 0 intent_gap · 0 bad_spec · **4 patches applied** (1 high, 3 medium) · 0 deferred · 15 rejected.
- **Headline:** in-app chart authoring was completely non-functional (the story's marquee capability) — every partial column pick wiped the spec, so no chart could ever be composed through the UI. Fixed by giving the chart-spec editor a local draft.
- Also fixed: an FR-18 concurrency clobber still open on user-action writes; a Ring-2 remote-image egress gap (R5); and a Recharts silent-series-drop for keys containing `.`. See the Review Triage Log entry for the full list and the rejection rationale.

### Files changed (this pass)
- `src/ui/report/ReportTabView.tsx` — `ChartSpecEditor` now holds a local draft (partial picks persist); all user-action state writes converted to functional updaters (FR-18)
- `src/ui/report/report-markdown.ts` — image `src` with an explicit scheme is neutralized to `#` (remote-image egress, R5)
- `src/ui/report/ReportChart.tsx` — axis + every mark use function `dataKey` accessors (bypass Recharts path parsing for dotted keys)
- `src/ui/report/report-markdown.test.ts` — new tests locking the remote-image-src neutralization

### Verification (this pass)
- `bunx tsc --noEmit` — pass (exit 0).
- `bun test` (full suite) — 887 pass / 0 fail (55 files; +2 new markdown tests).
- `bun run build` — pass; sandbox bundle byte-identical (342345), confirming the chart fix added no Ring-3 footprint.

### Follow-up review recommendation
`followup_review_recommended: true` — this pass applied a HIGH-severity fix restoring a broken core capability plus three medium fixes spanning state-write semantics, chart rendering, and the URL sanitizer; an independent confirmation pass on the chart-authoring flow (ideally against a real DB, where Recharts renders) remains worthwhile.
