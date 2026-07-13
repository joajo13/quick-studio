---
title: 'Redesign the Report to neutral — port the ChatGPT-style prototype onto the Report tab, blue chart series, ink export controls'
type: 'refactor'
created: '2026-07-13'
status: 'backlog'
context:
  - '{project-root}/design-artifacts/report.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
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

- `src/ui/styles/globals.css` -- ADD the report chart-series token `--rpt-chart` (blue: `#82aaff` dark / `#2f6fd6` light) and, if referenced by the restyle, the report ink/functional tokens `--rpt-accent`/`--rpt-accent-ink`/`--rpt-accent-soft`/`--rpt-accent-line` and `--rpt-warn`/`--rpt-warn-soft`/`--rpt-err`/`--rpt-err-soft`, mirroring the prototype's `:root` block; wire dark + light-theme variants (both `:root[data-theme="light"]` and the `prefers-color-scheme: light` fallback) and expose via `@theme inline` the same way the existing `--color-*` utilities are, if consumed as Tailwind classes. Additive only — do not repaint the shell palette.
- `src/ui/report/ReportChart.tsx` -- Re-point `SERIES_COLORS` so the FIRST (primary/single) entry is the blue chart accent `var(--rpt-chart)` instead of `var(--coral-line)`; keep the remaining distinct palette for multi-series. Purely the color array — no change to `pivot`, the closed mark switch (`line`/`bar`/`area`/`dot`), `Frame` axes/grid/tooltip, or `keyOf`/`seriesLabel`.
- `src/ui/report/ReportTabView.tsx` -- Restyle to the neutral idiom: Export snapshot / Export live controls in the prototype's ink style, neutral surfaces/borders, error text from the functional err token (drop hardcoded `text-red-400`), and no coral-leaning classes (the `--coral*` tokens already resolve neutral — keep them or swap to the report tokens, but ship zero coral literals). Behavior untouched: `report-state`, `handleRetarget`, `runBlock`/`confirmBlock`, `handleExport` / `handleExportLive`, and the block list all stay as-is.
- `src/ui/report/report-chart.ts` -- Pure, DOM-free `FrozenData` → `ChartData` mapper; holds NO color. Consumed unchanged (the `ChartData` shape and `mapChart` totality are preserved) — listed for completeness to confirm no edit is needed here.

## Tasks & Acceptance

**Execution:**
- [ ] `src/ui/styles/globals.css` -- add `--rpt-chart` (+ report ink/warn/err tokens if referenced) with dark + light values and `@theme inline` mapping as needed, mirroring `design-artifacts/report.html`; additive only.
- [ ] `src/ui/report/ReportChart.tsx` -- lead `SERIES_COLORS` with `var(--rpt-chart)`; keep the multi-series palette; no logic change.
- [ ] `src/ui/report/ReportTabView.tsx` -- port the neutral look (ink export controls, neutral surfaces, functional error color, zero coral literals); preserve all report/run/retarget/export behavior.
- [ ] `src/ui/report/report-chart.ts` -- verify no change required (pure mapper, no color); leave untouched.

**Acceptance Criteria:**
- Given the Report tab, when it renders, then it visually matches `design-artifacts/report.html` in the neutral idiom (ink accent, near-black surfaces, no coral anywhere).
- Given a chart block, when it draws its primary/single data series, then that series uses the blue `--rpt-chart` accent (not coral, not the ink line) in both light and dark themes; multi-series charts remain legible with the distinct palette.
- Given the Export snapshot / Export live controls, when they render, then they appear in the neutral ink style, and their behavior (in-flight guard, disabled/label swap, snapshot download, live publish) is unchanged.
- Given the report source files, when grepped for coral hex/`coral-`-leaning literals, then none are hardcoded (existing neutral `--coral*` token references that resolve to ink are acceptable).
- Given the build/test gates, when run, then `bunx tsc --noEmit` is clean and `bun test` passes with no Report (report-state / export-snapshot / export-live) regressions.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors (presentation-only; no type surface changed).
- `bun test` -- expected: all suites pass, including the existing `report-state` / `export-snapshot` / `export-live` / `report-chart` tests (no logic touched).

**Manual checks (if no CLI):**
- Launch the app, open a Report tab with a query block, switch its view to `chart`, and confirm the single series draws blue (`--rpt-chart`), the export controls read in the ink style, an errored block shows the neutral err color, and toggling the theme flips the report tokens correctly — side-by-side with `design-artifacts/report.html`.
