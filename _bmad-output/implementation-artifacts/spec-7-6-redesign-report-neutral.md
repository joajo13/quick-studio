---
title: 'Redesign the Report to neutral — port the ChatGPT-style prototype onto the Report tab, blue chart series, ink export controls'
type: 'refactor'
created: '2026-07-13'
baseline_revision: 'f6d80504d436b2d7fe37b2743b4af44d246c872f'
final_revision: 'df12c8055187bc08ecc1e4c500ce88649fd32a17'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/design-artifacts/report.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** The Report tab still carries the old coral/monospace-accent idiom, and its in-app charts lead their series palette with `var(--coral-line)` — under the neutral pivot that token now resolves to the ink accent, so a chart's primary series draws as a near-white ink line instead of a real, legible data color. The rest of the app has moved to the neutral ChatGPT-style language (near-black surfaces, ink accent, no coral, color only where functional), and `design-artifacts/report.html` is the north-star prototype for what the Report should look like: neutral chrome, ink-styled export controls, type-colored result headers with status pills, and — critically — charts drawn with a **blue** data-series accent (`--rpt-chart`) that replaces coral. This story brings the Report's presentation in line with that prototype.

**Approach:** A presentation-only refactor. PORT the neutral look of `design-artifacts/report.html` onto the existing Report components — restyle `ReportTabView.tsx` to the neutral idiom (ink-styled Export snapshot / Export live controls, neutral surfaces/borders, the functional error color instead of an ad-hoc `text-red-400`, no coral-leaning styling), and re-point the chart palette in `ReportChart.tsx` so the primary/single data series is a neutral **blue** accent sourced from a new `--rpt-chart` token (mirroring the prototype) rather than `var(--coral-line)`. Add `--rpt-chart` (plus the report's functional ink/warn/err tokens, if referenced) once in `globals.css` with dark + light values, exposed the same way the existing tokens are. The pure, DOM-free `report-chart.ts` mapper holds no color and is consumed unchanged. NO behavior changes: `report-state`, the run/retarget/confirm flow, and both `export-snapshot` / `export-live` paths — and their passing tests — are preserved byte-for-byte. Where `report.html` (neutral) and `DESIGN.md`/`EXPERIENCE.md` (coral) disagree on color, the prototype wins.

## Boundaries & Constraints

**Always:**
- Presentation-only: touch className / token / color choices and the chart series palette ONLY. Never modify `report-state` (block model, run/retarget/confirm reducers), the `runRawQuery` flow, RPC calls, or the `export-snapshot` / `export-live` outputs. Exported files stay byte-for-byte identical.
- The chart's primary/single data series is a neutral **blue** accent sourced from a `--rpt-chart` token (mirroring the prototype's `--rpt-chart: #82aaff` dark / `#2f6fd6` light), defined once in `globals.css` with dark + light values and exposed like the existing tokens. Additional (multi-)series keep the existing readable distinct palette; the primary series is never coral and never the ink line.
- Reuse the neutral shell tokens already in `globals.css` (the `--coral*` tokens now resolve to neutral ink, plus `--t-*`, `--border`, `--card`, `--muted`). Functional color is spent only on data-type coding, ok/err deltas, and the blue chart series — everything else stays neutral.
- Keep every ARIA role/label, keyboard handler (`Cmd/Ctrl+Enter` run), `:focus-visible` ring, `role="alert"` error surface, and reduced-motion behavior exactly as-is.
- Style the Export snapshot / Export live controls in the ink idiom of the prototype's segmented control (active = ink fill on ink-contrast text via `--rpt-accent` / `--rpt-accent-ink`); their in-flight guard, disabled state, and label swaps ("exporting…") are unchanged.
- `design-artifacts/report.html` is the visual source of truth and supersedes coral in `DESIGN.md` / `EXPERIENCE.md`; when they disagree on color, the prototype (neutral) wins.

**Block If:**
- Matching a prototype section would require NEW data plumbing rather than restyling — the prototype's KPI tiles, live ±deltas, and bottom status bar are backed by data the current components do not compute. Those are features, not presentation. HALT rather than add data logic under a refactor story; keep aspirational sections out of scope.

**Never:**
- No coral, anywhere: no coral hex literals, and the primary chart series is never `var(--coral-line)`.
- No behavior, RPC-surface, `report-state`-shape, or export-output change; no test may be broken.
- No edits to shared components owned by other stories (e.g. `DataGrid`, owned by Story 3.2) — the Report keeps passing them the same props.
- No shell-token changes in `globals.css` beyond ADDITIVE report tokens; do not repaint the existing `:root` shell palette.
- No new dependencies; charts stay on Recharts (Ring 2) and `report-chart.ts` stays pure / DOM-free.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Report tab renders | report tab active with blocks | Neutral panel: near-black surfaces, ink accents, type-colored surfaces where present, no coral anywhere | n/a |
| Single-series chart | query block, valid chart spec, no `series` column | The one drawn series (line/bar/area/dot) is the blue `--rpt-chart` accent, not the ink line | n/a |
| Multi-series chart | chart spec with a `series` column, N distinct values | Series 1 = blue `--rpt-chart`; series 2..N = the existing distinct palette; all legible in light + dark | n/a |
| Export controls | idle | "export snapshot" / "export live" render in the neutral ink style; disabled state dims; labels unchanged | in-flight → disabled + "exporting…" (unchanged) |
| Light theme | `data-theme="light"` or `prefers-color-scheme: light` | All added report tokens (`--rpt-chart`, ink accent, warn/err) flip to their light values; contrast holds | n/a |
| Error surface | a block query fails | Error text uses the functional neutral err color (`--rpt-err`), not ad-hoc `text-red-400`; `role="alert"` preserved | message text unchanged |
| Reduced motion | `prefers-reduced-motion: reduce` | No new animation introduced; existing behavior intact | n/a |
| Regression guard | `bun test` on report-state / export suites | All pre-existing Report tests still pass (presentation-only, no logic touched) | n/a |

</intent-contract>

## Code Map

- `src/ui/styles/globals.css` (~181 lines) -- ADD the report tokens, additive only. Confirmed ALL MISSING. Add to the dark `:root` block (alongside the Story 7.3 `--err`/`--warn` set at L79–83): `--rpt-chart: #82aaff`, `--rpt-accent: #ececec`, `--rpt-accent-ink: #0d0d0d`, `--rpt-accent-soft: rgba(255,255,255,0.10)`, `--rpt-accent-line: rgba(255,255,255,0.28)`, `--rpt-warn: #e0a458`, `--rpt-warn-soft: rgba(224,164,88,0.14)`, `--rpt-err: #f05a63`, `--rpt-err-soft: rgba(240,90,99,0.13)` — the exact prototype dark values. Add the light overrides to the `:root[data-theme="light"]` block (~L93–133): `--rpt-chart: #2f6fd6`, `--rpt-accent: #0d0d0d`, `--rpt-accent-ink: #ffffff`, `--rpt-accent-soft: rgba(0,0,0,0.06)`, `--rpt-accent-line: rgba(0,0,0,0.22)`, `--rpt-warn: #b3781f`, `--rpt-warn-soft: rgba(179,120,31,0.12)`, `--rpt-err: #d23b45`, `--rpt-err-soft: rgba(210,59,69,0.10)`. **Do NOT add a `prefers-color-scheme: light` fallback** — globals.css deliberately omits OS-preference auto-activation (comment L86–92); light is opt-in via explicit `data-theme="light"`, matching the rest of Epic 7. `@theme inline` aliases are OPTIONAL and only needed if these are consumed as Tailwind utility classes; the existing report code consumes tokens via arbitrary values (`[var(--coral-line)]`) and Tailwind built-ins, so mirror that (`text-[var(--rpt-err)]`, `border-[var(--rpt-accent-line)]`) and no `--color-rpt-*` alias is required. Additive only — do not repaint the shell palette.
- `src/ui/report/ReportChart.tsx` -- `SERIES_COLORS` is at **L34–41**; the FIRST entry is `"var(--coral-line)"` (L35), the other five are raw hex (`#5eb0ef`, `#7bd88f`, `#e6c86e`, `#c78bd8`, `#e08a6b`). Re-point ONLY L35 to `"var(--rpt-chart)"`; keep the remaining five distinct-palette entries as-is. `colorAt` (L43) and the mark switch (`line`/`bar`/`area`/`dot`, L121–179 applying `colorAt(i)` at L128/139/155/170) are UNCHANGED — no color lives in `Frame` (L92–110: axes/grid/tooltip use `--border`/`--muted-foreground`/`--card`). Pure color-array edit, no logic change.
- `src/ui/report/ReportTabView.tsx` (~720 lines) -- Restyle to the neutral idiom, presentation-only:
  - Error surfaces: drop hardcoded `text-red-400` at **L479** (exportError), **L484** (exportLiveError), **L699** (per-block `block.error`) → the functional err token `text-[var(--rpt-err)]`. Keep each `role="alert"` and the message text verbatim.
  - Export controls (toolbar L474–516): the **export snapshot** button (L488–496: `aria-label="export snapshot"`, `disabled={exporting}`, label `{exporting ? "exporting…" : "export snapshot"}`) and **export live report** button (L501–509: `aria-label="export live report"`, `disabled={exportingLive}`, label `{exportingLive ? "exporting…" : "export live report"}`) both use the neutral `ghostBtn` const (L90–91). Give them the prototype's ink treatment (ink accent via `--rpt-accent`/`--rpt-accent-ink`/`--rpt-accent-line`) but KEEP them as two independent action `<button>`s — do NOT convert to a `role="tablist"` mode selector (see Design Notes). Preserve `disabled`, the label swap, and the aria-labels exactly.
  - Coral-leaning classes → report ink tokens (or leave as neutral-resolving `--coral*`, but prefer the report tokens for prototype fidelity): the `btn` primary const (L89: `border-[var(--coral-line)] bg-[var(--coral-soft)]`, used by `+ prose`/`+ query` at L510–515), `select` focus (L152), target-picker select (L465), prose/SQL textarea focus (L611, L665), and the active result-view tab (L683: `border-[var(--coral-line)] bg-[var(--coral-soft)]`) → `--rpt-accent-line`/`--rpt-accent-soft`. Ship ZERO coral hex literals (there are none today — all are token refs).
  - Behavior UNTOUCHED: `handleRetarget` (L434), `runBlock` (L315)/`confirmBlock` (L321)/`fireAgainst` (L303)/`applyOutcome` (L245)/`cancelConfirm` (L329), `handleExport` (L357)/`handleExportLive` (L397), the Cmd/Ctrl+Enter run handler (L655–660), the `run` label `{entry.busy ? "running…" : "run"}` (L670), and the block list all stay as-is.
- `src/ui/report/report-chart.ts` -- Pure, DOM-free `FrozenData` → `ChartData` mapper; exports `ChartValue`/`ChartRecord`/`ChartData`/`frozenToRecords`/`mapChart`; holds NO color. Consumed unchanged — listed for completeness to confirm no edit is needed here.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/styles/globals.css` -- add the nine `--rpt-*` tokens to dark `:root` and their light values to `:root[data-theme="light"]`, mirroring `design-artifacts/report.html` exactly; NO `prefers-color-scheme` fallback; `@theme inline` alias only if consumed as a utility class (not needed for arbitrary-value usage); additive only.
- [x] `src/ui/report/ReportChart.tsx` -- change `SERIES_COLORS[0]` (L35) from `"var(--coral-line)"` to `"var(--rpt-chart)"`; keep the other five; no logic change.
- [x] `src/ui/report/ReportTabView.tsx` -- swap the three `text-red-400` (L479/L484/L699) to `text-[var(--rpt-err)]`; give the export controls the ink look (keep them as action buttons, not a tablist); re-point the coral-token classes to `--rpt-accent*`; preserve all report/run/retarget/export behavior, aria-labels, roles, and labels.
- [x] `src/ui/report/report-chart.ts` -- verify no change required (pure mapper, no color); leave untouched.

**Acceptance Criteria:**
- Given the Report tab, when it renders, then it visually matches `design-artifacts/report.html` in the neutral idiom (ink accent, near-black surfaces, no coral anywhere).
- Given a chart block, when it draws its primary/single data series, then that series uses the blue `--rpt-chart` accent (not coral, not the ink line) in both light and dark themes; multi-series charts remain legible with the distinct palette.
- Given the Export snapshot / Export live controls, when they render, then they appear in the neutral ink style, keep their `aria-label`s ("export snapshot" / "export live report"), and their behavior (in-flight guard, disabled/label swap to "exporting…", snapshot download, live publish) is unchanged.
- Given the report source files, when grepped for coral hex / `text-red-` literals, then none are hardcoded (existing neutral `--coral*` token references that resolve to ink are acceptable; the three `text-red-400` are gone).
- Given the build/test gates, when run, then `bunx tsc --noEmit` is clean and `bun test` passes with no Report (report-state / export-snapshot / export-live / report-chart / ReportTabView / ReportChart) regressions — the load-bearing DOM strings and aria-labels asserted in `ReportTabView.test.tsx` are all preserved.

## Spec Change Log

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 0, low 2)
- defer: 1: (high 0, medium 0, low 1)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[low]` `[patch]` Three added `--rpt-*` tokens were never consumed — `--rpt-warn`, `--rpt-warn-soft`, `--rpt-err-soft` (the restyle references only `--rpt-err`). The contract said add report functional tokens "if referenced"; removed the three unreferenced tokens from both the dark `:root` and `:root[data-theme="light"]` blocks and tightened the block comment (`globals.css`). No consumers remained (`rg` clean); tsc + all suites still green.
  - `[low]` `[patch]` Two source comments still described the export controls as a "Quiet ghost/secondary export control" after they were re-pointed from `ghostBtn` to the solid-ink `exportBtn`, so the comments contradicted the code. Rewrote both to describe the ink treatment (report.html `.seg-btn.on` idiom) and to note they remain independent action buttons, not a selected tab (`ReportTabView.tsx`).

## Design Notes

**Export controls are two action buttons, NOT a mode tablist.** The prototype's `.seg-control role="tablist"` (report.html L727–741, L951–954) is a *mode selector* whose active tab gets the ink fill (`--rpt-accent`/`--rpt-accent-ink`). The app's two controls are independent *action* buttons — each triggers its own export (`handleExport` / `handleExportLive`), with no persistent selected state in `report-state`. Apply the ink *aesthetic* (accent border/fill on the affordance) but do NOT introduce `role="tablist"`/`role="tab"` or a shared active-state — that would be a semantics/behavior change (contract **Never**). Keep the `ghostBtn`→ink restyle at the class level only; `aria-label`, `disabled`, and the `"exporting…"` label swap stay byte-identical.

**Light theme is opt-in (no OS fallback in globals.css).** Unlike report.html — which carries a `prefers-color-scheme: light` block — `globals.css` activates light ONLY via explicit `data-theme="light"` (comment L86–92), consistent with Stories 7.1–7.5. Add the `--rpt-*` light values to `:root[data-theme="light"]` only; do not add an OS-preference fallback. The I/O matrix's "prefers-color-scheme: light" row describes the token's intent; in-app the flip happens via the explicit theme attribute (as everywhere in Epic 7).

**Token reuse over new hues (cf. Stories 7.4/7.5).** The `--rpt-warn`/`--rpt-err` values are near-identical to the existing `--warn`/`--err` (L82/L79), but the prototype defines its own `--rpt-*` set, so mirror it verbatim for fidelity and to keep the report's functional palette self-contained. `--ok`/`--ok-soft` already match the prototype's green and are reused as-is for any ok-delta. Consume the tokens the same way the current report code does — arbitrary values (`text-[var(--rpt-err)]`) — so no `@theme inline` alias is strictly required; add `--color-rpt-*` aliases only if a plain utility class is genuinely used.

**Test-safe restyle.** No Report test asserts on specific coral/red color classes. `ReportTabView.test.tsx` asserts load-bearing DOM strings/roles — `"empty report"`, `"+ prose"`/`"+ query"`, `aria-label="export snapshot"`/text `"export snapshot"`, `aria-label="export live report"`/text `"export live report"`, `aria-label="report target"`, `"Default (launch connection)"`, the summary HTML (`<h2>Summary</h2>`, `<strong>up</strong>`), `"block 2/3"`/`"block 3/3"`, `<table` — all must survive. `export-snapshot.test.ts` (`__qs_snapshot` filename), `export-live-report.test.ts` (`__qs_livereport`, `connect-src 'self'`, and the redaction NOT-contains assertions) are logic/output tests untouched by a restyle. `report-state.test.ts`/`report-chart.test.ts`/`ReportChart.test.tsx` are pure logic/data-shape — no visible-string coupling.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors (presentation-only; no type surface changed).
- `bun test` -- expected: all suites pass, including the existing `report-state` / `export-snapshot` / `export-live-report` / `report-chart` / `ReportTabView` / `ReportChart` tests (no logic touched).
- `rg 'text-red-[0-9]|coral.*#|bg-\[#|#f[0-9a-fA-F]{5}' src/ui/report/ReportTabView.tsx src/ui/report/ReportChart.tsx` -- expected: no `text-red-*` and no coral/hardcoded-hex hits reintroduced (the five distinct multi-series hex in `SERIES_COLORS` are the pre-existing sanctioned palette, not coral).

**Manual checks (if no CLI):**
- Launch the app, open a Report tab with a query block, switch its view to `chart`, and confirm the single series draws blue (`--rpt-chart`), the export controls read in the ink style, an errored block shows the neutral err color, and toggling `data-theme="light"` flips the report tokens correctly — side-by-side with `design-artifacts/report.html`.

## Auto Run Result

Status: done

### Summary
Presentation-only neutral (ChatGPT-style) port of the Report tab onto `design-artifacts/report.html`. The chart's primary/single data series now draws in the functional **blue** `--rpt-chart` accent instead of `var(--coral-line)` (which under the neutral pivot resolved to a near-invisible ink border, `rgba(255,255,255,0.28)` — the swap also fixes a latent primary-series contrast bug). `ReportTabView` moved to the neutral idiom: the three `text-red-400` error surfaces now use the functional `--rpt-err` token (with `role="alert"` and message text preserved), the two Export controls wear the prototype's ink treatment (`--rpt-accent`/`--rpt-accent-ink`/`--rpt-accent-line`) while staying two independent action `<button>`s — NOT a `role="tablist"` — with their in-flight guard / `disabled` / `"exporting…"` label swap / aria-labels byte-for-byte intact, and the remaining coral-token classes (primary `btn`, select/textarea focus rings, active result-view tab) were re-pointed to `--rpt-accent*`. The report's `--rpt-*` tokens (only the ones actually consumed: `--rpt-chart`, `--rpt-accent`, `--rpt-accent-ink`, `--rpt-accent-soft`, `--rpt-accent-line`, `--rpt-err`) were added additively to globals.css for dark `:root` and `:root[data-theme="light"]`, ported verbatim from the prototype; no OS `prefers-color-scheme` fallback (light is opt-in, matching the rest of Epic 7). `report-chart.ts` (pure DOM-free mapper) is untouched. No behavior, RPC, `report-state`, or export-output change; `report-state` / `export-snapshot` / `export-live` / `report-chart` and all other suites stay green.

### Files changed
- `src/ui/styles/globals.css` — added the six consumed `--rpt-*` tokens to dark `:root` and `:root[data-theme="light"]` (verbatim from `design-artifacts/report.html`); additive only, no shell repaint, no `@theme inline` alias (report consumes them via arbitrary values).
- `src/ui/report/ReportChart.tsx` — `SERIES_COLORS[0]`: `var(--coral-line)` → `var(--rpt-chart)`; the five distinct multi-series hex kept; docstring corrected ("blue-led via --rpt-chart"). No logic change.
- `src/ui/report/ReportTabView.tsx` — three `text-red-400` → `text-[var(--rpt-err)]`; new `exportBtn` ink style on both export buttons (kept as action buttons, not a tablist); `btn`, four focus rings, and the active result-view tab re-pointed to `--rpt-accent*`; export comments corrected. Zero handler/behavior change.
- `src/ui/report/report-chart.ts` — verified no change required; untouched.

### Review findings breakdown
- **Patches applied (2, both low):** removed three unreferenced `--rpt-*` tokens (`--rpt-warn`/`--rpt-warn-soft`/`--rpt-err-soft`) the contract only wanted "if referenced"; rewrote two stale "quiet ghost/secondary" export comments that contradicted the new solid-ink `exportBtn`.
- **Deferred (1, low):** the multi-series chart palette is only partly theme-aware and its blue lead (`--rpt-chart`) sits adjacent in hue to `SERIES_COLORS[1]` (`#5eb0ef`); single-series charts (the common case) are unaffected — logged to `deferred-work.md` for a later dataviz/theme pass.
- **Rejected (7, all low/noise):** export-button "toggle-look"/hierarchy objections (the intent-contract explicitly prescribed the `--rpt-accent` ink fill; the buttons are labeled, functional, and not a tablist); `--rpt-accent*` "clones `--coral*`" (contract-mandated self-contained report palette mirroring the prototype); `--rpt-accent-ink #0d0d0d` vs `--coral-ink #0b0d11` (prototype-verbatim value); the coral→blue swap "fixing latent invisibility" (positive, not a defect); no `prefers-color-scheme` fallback (contract-accepted, epic-wide pattern); `--rpt-err` 11px contrast (prototype-sourced standard error reds).

### Verification
- `bunx tsc --noEmit` → clean (exit 0) after patches.
- `bun test` → **1065 pass, 0 fail** (2621 expects, 68 files). Report-specific (`report-state` / `export-snapshot` / `export-live-report` / `report-chart` / `ReportTabView` / `ReportChart`) = 84 pass across 8 files. The `relation "secret" does not exist` line is a deliberate error-path fixture log, not a failure. No test file modified.
- `rg 'rpt-warn|rpt-err-soft' src/` → no consumers of the removed tokens. `rg 'text-red-[0-9]|--coral' src/ui/report/ReportTabView.tsx src/ui/report/ReportChart.tsx` → clean (no `text-red-*`, no coral refs remain in the report source).

### Follow-up review recommendation
`false` — the final pass applied only two localized, low-consequence fixes (dead-token removal + comment corrections) plus a deferred cosmetic note. No behavior, API, RPC, security, persistence, or data-flow change; every exported function and the export/run/retarget seams are untouched. Not significant enough to warrant an independent follow-up review.

### Residual risks
- **Visual fidelity is Tailwind-approximated**, not a pixel clone of the prototype's bespoke CSS; a manual light/dark pass in the running app is the only check a CLI can't perform.
- **Multi-series chart legibility** is the deferred item: series 2..N keep dark-tuned fixed hex (no light-theme flip) and the lead blue is hue-adjacent to series[1]. Single-series charts (the common report shape) are unaffected.
- **Light theme is opt-in** and, as across Epic 7, less battle-tested than dark; the new tokens carry the epic-wide small-text contrast risk (cf. DW-58/67).
