---
title: 'Redesign the Query editor + destructive confirm to the neutral ChatGPT-style look'
type: 'refactor'
created: '2026-07-13'
status: 'done'
baseline_revision: 'b3536634ccc651d1884821d520a69a42be8824ea'
final_revision: '5396c3d368f9b6c21b1807aeac6a22121810ab98'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/design-artifacts/workspace.html'
  - '{project-root}/design-artifacts/confirm-destructive.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The ad-hoc SQL surfaces still wear the old coral/monospace look. `QueryTabView`'s Run control is a small text button on a `--coral-soft`/`--coral-line` chip, and `ConfirmRun` is an inline amber panel with hardcoded `amber-*` / `red-*` Tailwind palette classes. The project has pivoted to a NEUTRAL ChatGPT-style language — near-black surfaces, an ink accent, color ONLY where functional — and two prototypes (`design-artifacts/workspace.html`, `design-artifacts/confirm-destructive.html`) are now the visual source of truth, superseding any coral still described in DESIGN.md / EXPERIENCE.md. `globals.css` is already neutral (`--coral` is ink `#ececec`), but these two components have not been ported.

**Approach:** A presentation-only port of the prototype look onto the existing components. `QueryTabView`'s editor pane adopts the workspace.html editor chrome: an ink-filled Run control (up-arrow glyph + "Run" label + `⌘↵` kbd chip) on a neutral editor bar over a mono editor surface, with the result / truncated / affected / error banners retoned off hardcoded Tailwind palette classes onto `globals.css` tokens. `ConfirmRun` is replaced by the confirm-destructive.html modal: a neutral scrim + card `alertdialog` with NO top color line, where red (`--err`) appears ONLY on the functional destructive bits — the danger icon, the affected-rows badge, the statement's left-border, and the filled Confirm button — plus a concise one-line description, an optional dependent-FK line, and an optional type-to-confirm gate for DROP/TRUNCATE. This changes markup, classes, and tokens ONLY. The `⌘/Ctrl+Enter` run behavior, the guarded `execute` RAW round-trip (`run-raw-query.ts`), the `confirmed:true` re-issue, the re-entrancy `firing` guard, and the Core-executor-is-the-real-gate model are all preserved byte-for-byte. The confirm dialog stays UX-only friction; it was never the gate and still isn't.

## Boundaries & Constraints

**Always:**
- Presentation-only. Change markup, CSS classes, and design tokens for `QueryTabView`'s editor + Run control + result banners and for `ConfirmRun`'s dialog. Do NOT change run/confirm control flow, the `execute` RPC, `RunOutcome`, the client-side pager, or the re-entrancy guards.
- The prototypes (`workspace.html`, `confirm-destructive.html`) are the visual source of truth and SUPERSEDE any coral in DESIGN.md / EXPERIENCE.md: neutral near-black surfaces + ink accent, color only where functional.
- All color resolves through `globals.css` tokens (`--coral` = ink, `--coral-soft`/`--coral-line`, `--t-*`, and the new `--err*`). No hardcoded coral hex and no hardcoded Tailwind palette utilities (`amber-*`, `red-*`, etc.) remain on these surfaces.
- Red (`--err`) appears ONLY on functional bits: the confirm dialog's danger icon, affected-rows badge, statement left-border, and Confirm button — plus the inline error banner's failure text (a functional failure signal). Every other surface stays neutral (ink / muted).
- The confirm dialog is UX-only friction; the Core guarded executor remains the sole real gate. Confirming re-issues the IDENTICAL request with `confirmed:true`; Esc / Cancel executes nothing.
- Preserve exactly: the `⌘/Ctrl+Enter` handler, the Run-enable gate (`isRunnable(draft) && !busy && confirm === null`), and the synchronous `firing` double-fire guard.
- New `ConfirmRun` props are OPTIONAL with safe defaults so existing callers (`QueryTabView`, and the shared `ChatTabView`) render the base modal with unchanged behavior.
- Keep the suite green: `bunx tsc --noEmit` and `bun test` (react-dom/server presentational tests) pass.

**Block If:**
- Faithfully rendering a prototype element would require a Core / contract / RPC change — the affected-rows badge, the dependent-FK line, and the type-to-confirm target all need data the `confirmation_required` preview does not carry today. Render each ONLY when supplied via an optional prop; if an element cannot be shown without extending the execution contract, HALT `blocked` for that element with condition `prototype element needs a Core contract change out of scope for a presentation-only refactor` — do NOT extend the RPC or contract in this story.

**Never:**
- No SQL parsing / splitting / classifying / tokenizing in the UI (AR-3). The editor textarea and the confirm `<pre>` render SQL verbatim. Type-colored syntax highlighting that would require classifying SQL is out of scope — the prototype's colored spans are a static mock.
- No change to `run-raw-query.ts`, the `execute` path, `RunOutcome`, shared contract types, or the Core gate. No new RPC calls.
- No coral hex, no hardcoded Tailwind color-palette utilities, and no top color line on the modal.
- Do not persist anything new, do not add a light theme (`globals.css` is dark-first; the prototype's light block is not ported), and do not alter DataGrid / pagination logic or the Story 3.2 read-path behavior.
- Do not make the dialog the gate: the `disabled` and type-to-confirm states are UX friction only; the Core still authorizes execution.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Notes |
|----------|--------------|---------------------------|-------|
| Editor idle, runnable | `draft` has non-whitespace | Ink-filled Run control (up-arrow glyph + "Run" + `⌘↵` chip) enabled on a neutral editor bar over a mono surface; `⌘/Ctrl+Enter` fires `run()` | Behavior identical to today |
| Run blocked | empty `draft`, OR `busy`, OR `confirm !== null` | Run control disabled/dimmed; `⌘↵` no-op | Same gate as today |
| Rows result | `outcome.kind === "rows"` | `DataGrid` + neutral pager ("rows X–Y of N", prev/next) on neutral surfaces; no coral | Pager logic unchanged |
| Truncated result | `truncated === true` | Neutral / restrained-warn banner via tokens (no hardcoded `amber-*`) | Informational, not destructive |
| Mutation ok | `outcome.kind === "ok"` | Neutral "N rows affected" banner via tokens (no hardcoded palette) | |
| Error envelope | `outcome.kind === "error"` | Error banner using `--err` token, `role="alert"` (red = functional failure) | No hardcoded `red-700`/`red-400` |
| Confirm (base) | `confirm !== null`, no optional data | Neutral scrim + card modal, NO top color line: red danger icon, one-line `risk` description, verbatim `sql` in a red-left-border `<pre>`, filled-red Confirm + quiet Cancel; Cancel autofocuses, Esc cancels; confirming re-issues identical `confirmed:true` request | Gate + flow unchanged |
| Confirm w/ affected count | `affectedRows` prop supplied | Red affected-rows badge beside the "Statement" label | Rendered only when data present |
| Confirm w/ FK deps | `dependents` prop supplied | Dependent "`x.col → FK → y.col`" line(s) under the statement | Only when present |
| Confirm DROP/TRUNCATE | `objectName` prop supplied | Type-to-confirm input; Confirm stays disabled until typed value === `objectName` | Client-side friction ONLY; Core still the real gate |
| Round-trip in flight | `busy === true` | Both modal buttons disabled (no double-fire); `firing` ref still guards | Unchanged |
| Theme | dark-first | Tokens resolve on dark; no light theme added | `globals.css` is dark-only |

</intent-contract>

## Code Map

- `src/ui/styles/globals.css` (~135 lines) -- ADD destructive/warn semantic tokens to the dark-first `:root`: `--err: #ef6a63; --err-soft: rgba(239,106,99,0.14); --err-line: rgba(239,106,99,0.40);` and `--warn: #e0a458; --warn-soft: rgba(224,164,88,0.13);` (values ported from `confirm-destructive.html` / `workspace.html`, dark only). Expose matching Tailwind utilities via the existing `@theme inline` block — add `--color-err/-err-soft/-err-line/-warn/-warn-soft` aliases (mirroring the existing `--color-ok`/`--color-ok-soft` pattern) so `text-err`/`bg-err-soft`/`border-err-line`/`text-warn`/`bg-warn-soft` resolve. `--coral*` (ink) and `--ok*` already exist — do NOT touch them. Do NOT add a `[data-theme="light"]` override for these (dark-first pivot).
- `src/ui/workspace/QueryTabView.tsx` (283 lines) -- restyle the editor pane + Run control to `workspace.html`: replace the `bg-[var(--coral-soft)]`/`border-[var(--coral-line)]` text chip (line ~197) with the ink-FILLED `.run` control — `bg-[var(--coral)] text-[var(--coral-ink)]`, an up-arrow SVG (`M12 19V5M6 11l6-6 6 6`), a "Run" label, and a `⌘↵` `.kbd` chip (replacing the `ctrl/cmd+enter` hint span). Retone the truncated banner (lines ~230-236) off `amber-700`/`amber-950/40`/`amber-400` onto `--warn`/`--warn-soft` tokens, and the error banner (lines ~248-254) off `red-700`/`red-950/40`/`red-400` onto `--err`/`--err-soft` tokens (keep `role="alert"`). The affected banner (~256-262) is already token-based — leave neutral. Pager (~202-226) swaps any coral idiom to tokens. UNCHANGED byte-for-byte: `run()` (~125-141), `confirmRun()` (~143-155), the `onKeyDown` ⌘/Ctrl+Enter handler (~179-184), the enable gate `disabled={!isRunnable(draft) || busy || confirm !== null}` (:195), the `firing` ref guard (:82, checked :128/:144), and the `rowRangeSummary`/`canPrev`/`canNext` pager wiring.
- `src/ui/workspace/ConfirmRun.tsx` (56 lines) -- replace the inline amber panel with the `confirm-destructive.html` modal: a fixed `.dx-scrim` overlay + a neutral `role="alertdialog" aria-modal="true"` card (NO top color line — only the `box-shadow` hairline), a red triangle danger icon (`--err` on `--err-soft`), a title + the one-line `risk` as the sub-description, the verbatim `sql` in a `<pre>` with `border-left: 2px solid var(--err)`, a quiet autofocus/Esc Cancel and a filled-red Confirm (`bg-[var(--err)] text-white`) with a trash icon + label. ADD OPTIONAL props `affectedRows?: number` (red affected-rows badge beside the "Statement" label), `dependents?: readonly {from:string; to:string}[]` (the `x → FK → y` line(s)), and `objectName?: string` (type-to-confirm input; Confirm disabled until typed === `objectName`) — each rendered ONLY when supplied. Preserve the `sql`/`risk`/`busy`/`onConfirm`/`onCancel` props and the "UX-only, never the gate" model.
- `src/ui/workspace/ConfirmRun.test.tsx` (93 lines) -- UPDATE in lockstep: the redesigned Confirm/Cancel buttons now contain icon + label (array children) rather than a single string child, so the existing `findButton` helper (`props.children === text`) and the `>confirm</`/`>cancel</` `toContain` assertions must be reworked (match by a stable label span / `aria-label`, or by an `id`/`data-testid`). Add cases: base modal has NO top color line and red only on functional bits; each optional element (`affectedRows`/`dependents`/`objectName`) renders ONLY when its prop is supplied; the callback wiring (confirm→`onConfirm`, cancel→`onCancel`) and the `busy` double-disable still hold.
- `src/ui/workspace/run-raw-query.ts` (72 lines) -- NO CHANGE. `RunOutcome` (`kind: "rows" | "ok" | "confirm" | "error"`), the `confirmed:true` re-issue, the `confirmation_required`→`{kind:"confirm", sql, risk}` mapping, and the Core-is-the-sole-gate model must be preserved exactly. The `confirm` outcome carries ONLY `sql` + `risk` today — the new optional props have no Core source and must stay prop-gated.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/styles/globals.css` -- add `--err`/`--err-soft`/`--err-line` and `--warn`/`--warn-soft` to dark-first `:root` (values above) and expose `--color-err*`/`--color-warn*` in `@theme inline`; do not touch `--coral*`/`--ok*` or add a light override.
- [x] `src/ui/workspace/QueryTabView.tsx` -- port the ink-filled Run control (arrow SVG + "Run" + `⌘↵` chip) and retone the truncated banner onto `--warn*` and the error banner onto `--err*`; leave `run()`, `confirmRun()`, the key handler, the enable gate, the `firing` guard, and the pager byte-identical.
- [x] `src/ui/workspace/ConfirmRun.tsx` -- port the confirm-destructive modal (scrim + neutral `alertdialog`, red only on danger icon / statement left-border / affected badge / Confirm button, generic title + one-line `risk`, verbatim `sql`) and add optional `affectedRows?`/`dependents?`/`objectName?` props (badge / FK-deps / type-to-confirm rendered only when supplied); preserve `onConfirm`/`onCancel`/`busy`.
- [x] `src/ui/workspace/ConfirmRun.test.tsx` -- update the button-finding helper + label assertions for the new icon+label buttons, and add cases: base modal (no top line, red on functional bits only), each optional element renders only when its prop is supplied, callback wiring intact, `busy` disables both buttons.

**Acceptance Criteria:**
- Given a query tab, when the editor renders, then it matches `workspace.html`: an ink-filled Run control (up-arrow glyph + "Run" label + `⌘↵` chip) on a neutral editor bar over a mono editor surface — no coral, no hardcoded palette colors — and `⌘/Ctrl+Enter` still runs the draft.
- Given a runnable or blocked draft, when Run's enable state changes, then the control enables/dims exactly as before (`!isRunnable(draft) || busy || confirm !== null`) and the double-fire `firing` guard still holds.
- Given a `confirm` outcome, when the confirm surfaces, then it matches `confirm-destructive.html`: a neutral scrim + card with NO top color line, red only on the danger icon / statement left-border / Confirm button, a concise one-line description, and the verbatim SQL — Cancel takes focus, Esc cancels, and confirming re-issues the IDENTICAL `confirmed:true` request (the Core remains the gate).
- Given the optional preview data is passed, when supplied, then the red affected-rows badge, the dependent-FK line, and the type-to-confirm input appear as in the prototype; when absent, the base modal renders and all three existing callers (`QueryTabView`, `ChatTabView`, `ReportTabView`) behave unchanged.
- Given the neutral pivot, when any of these surfaces render, then no coral hex and no hardcoded Tailwind color utilities remain — all color resolves through `globals.css` tokens, and red appears only on functional destructive/error bits.
- Given the suite, when `bunx tsc --noEmit` and `bun test` run, then both pass, including the updated react-dom/server `ConfirmRun` test.

## Spec Change Log

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 2, low 2)
- defer: 7: (high 0, medium 3, low 4)
- reject: 4
- addressed_findings:
  - `[medium]` `[patch]` The Run control's `⌘↵` kbd chip advertised a Mac-only glyph on a Windows/WSL/Linux target; made it platform-aware (`⌘↵` on mac, `Ctrl ↵` otherwise) — the `metaKey||ctrlKey` handler was already correct, only the label was wrong.
  - `[medium]` `[patch]` `ConfirmRun`'s Confirm/Cancel `aria-label` were lowercase ("confirm"/"cancel") while the visible labels read "Confirm"/"Cancel" (WCAG 2.5.3 Label-in-Name); aligned the aria-labels to the visible text and updated `ConfirmRun.test.tsx` `findButton` + the weakened `toContain("Cancel")` boundary assertion in lockstep.
  - `[low]` `[patch]` Esc-to-cancel was wired only on the Cancel button, so Esc did nothing once focus left it (e.g. the type-to-confirm input); moved the `Escape → onCancel` handler to the `alertdialog` card level, gated on `!busy` to preserve the "no cancel mid-round-trip" behavior.
  - `[low]` `[patch]` The optional `dependents` FK-line React `key` (`${from}→${to}`) could collide on duplicate FK pairs; appended the map index.

## Design Notes

- **Tokens are net-new:** `--err*` and `--warn*` do NOT exist in `globals.css` today (only `--coral*` ink, `--ok*`, and `--t-*` do). They must be added before the components can reference them. Dark values only — the file is dark-first (`:root` is dark; light lives under an explicit `:root[data-theme="light"]` and is out of scope here).
- **Confirm label stays generic:** the prototype's Confirm reads "Drop table" — a verb derived from classifying the SQL, which AR-3 forbids in the UI. Use a stable generic label ("Confirm") and a generic title; `risk` (from the Core preview) is the one-line human description. Deriving a verb or object name from `sql` is out of scope.
- **Why optional props, not a contract change:** the `confirm` outcome carries ONLY `sql` + `risk` (`run-raw-query.ts` maps `result.preview.{sql,risk}`). The badge / FK-deps / type-to-confirm have no Core source today, so they are OPTIONAL props that render only when a future story feeds them — this refactor must not extend the RPC/contract (Block-If).
- **`ConfirmRun` is shared by THREE callers:** `QueryTabView`, `ChatTabView`, AND `ReportTabView` all render it with the identical `{sql, risk, busy, onConfirm, onCancel}` shape. New props MUST be optional with safe defaults so all three keep rendering the base modal unchanged — the redesign propagates to chat + report for free, with no edit required in either.
- **Test is coupled to button internals:** `ConfirmRun.test.tsx` currently finds buttons via `props.children === "confirm"`/`"cancel"` and counts `disabled=""`. The new icon+label buttons make `children` an array, so the helper + `toContain(">confirm<")` assertions break and must be reworked (match a label span / `aria-label` / `data-testid`) — update the test in the SAME task, not after.
- **Retone, don't recolor:** the truncated banner drops `amber-*` onto `--warn*`, the error banner drops `red-*` onto `--err*`; the affected banner is already token-based and stays neutral. Every remaining color has a functional reason.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors (new optional `ConfirmRun` props typed; three callers still compile).
- `bun test` -- expected: all suites pass, including the updated react-dom/server `ConfirmRun` test covering the base modal + each optional element.
- `rg -n 'amber-|red-[0-9]|coral.*#|#f9|#fee' src/ui/workspace/QueryTabView.tsx src/ui/workspace/ConfirmRun.tsx` -- expected: no hardcoded Tailwind palette utilities or coral hex remain on these surfaces.

**Manual checks (if a DB + browser are available):**
- Launch the app, open a query tab, confirm the ink Run control paints and `⌘/Ctrl+Enter` runs the draft.
- Run a `DROP TABLE` to raise the confirm: verify the neutral modal (no top color line), red only on the danger icon / statement left-border / Confirm button, that Cancel is focused and Esc cancels, and that confirming executes via the identical `confirmed:true` request.
- Scan the rendered surfaces for any remaining coral hex or hardcoded Tailwind palette classes — there should be none.

## Auto Run Result

Status: done

### Summary
Presentation-only neutral (ChatGPT-style) redesign of the ad-hoc SQL surfaces. `QueryTabView`'s Run control became an ink-filled button (up-arrow glyph + "Run" + platform-aware `⌘↵`/`Ctrl ↵` chip) on a neutral editor bar, and its truncated / error banners were retoned off hardcoded `amber-*`/`red-*` onto new `--warn*`/`--err*` tokens. `ConfirmRun` was replaced by the `confirm-destructive.html` modal — a neutral scrim + `alertdialog` card with NO top color line, red confined to the danger icon / affected-rows badge / statement left-border / Confirm button — plus optional, prop-gated `affectedRows` / `dependents` / `objectName` (type-to-confirm) elements that render only when a future story supplies the data. All run/confirm control flow, the `⌘/Ctrl+Enter` handler, the enable gate, the `firing` guard, the pager, `run-raw-query.ts`, `RunOutcome`, and the Core-is-the-sole-gate model were preserved byte-for-byte. `ChatTabView` and `ReportTabView` (the two other `ConfirmRun` callers) inherit the redesign for free with no edit.

### Files changed
- `src/ui/styles/globals.css` — added dark-first `--err`/`--err-soft`/`--err-line` + `--warn`/`--warn-soft` tokens and their `@theme inline` `--color-*` aliases (mirrors the existing `--ok` pattern); `--coral*`/`--ok*` untouched, no light override.
- `src/ui/workspace/QueryTabView.tsx` — ink-filled Run control (arrow SVG + "Run" + platform-aware kbd chip); truncated banner → `--warn*`, error banner → `--err*` (kept `role="alert"`); logic/pager preserved.
- `src/ui/workspace/ConfirmRun.tsx` — ported the confirm-destructive modal; added optional `affectedRows`/`dependents`/`objectName` props; card-level Esc→onCancel (gated `!busy`); `aria-label` aligned to visible text; FK-line key includes index.
- `src/ui/workspace/ConfirmRun.test.tsx` — reworked button matching (aria-label `Confirm`/`Cancel`), added base-modal + per-optional-element + callback + busy cases; boundary-anchored Cancel assertion.
- `src/ui/workspace/QueryTabView.test.tsx` — updated the Run-button label assertion (`>Run<`).

### Review findings breakdown
- **Patches applied (4):** platform-aware kbd chip (`⌘↵` was Mac-only on a Windows/WSL target); `aria-label` Label-in-Name fix (lowercase vs visible text) + test hardening; Esc-to-cancel raised to the dialog card (gated `!busy`); `dependents` React-key collision on duplicate FK pairs.
- **Deferred (7):** DW-58 Confirm white-on-`--err` contrast <AA (epic-wide token decision); DW-59 `aria-modal` not enforced (no focus trap / scrim-dismiss — shared-modal a11y pass); DW-60 `fixed` overlay ancestor-transform fragility (portal candidate); DW-61 `affectedRows` 0/neg/NaN badge; DW-62 `objectName` empty/whitespace gate edges; DW-63 TTC input editable while `busy`; DW-64 TTC callback path unreachable by the tree-walk test. DW-61..64 are on dormant, prop-gated paths with no caller today.
- **Rejected (4):** autoFocus-on-Cancel (intentional destructive safe-default), static dialog IDs (single-instance in practice), warn/err border-weight (cosmetic), light-theme un-tuned reds (spec-mandated dark-first).

### Verification
- `bunx tsc --noEmit` → clean (exit 0).
- `bun test` → 1047 pass, 0 fail (2579 expect calls, 68 files) after patches. (`ConfirmRun.test.tsx` + `QueryTabView.test.tsx`: 16 pass.)
- `rg -n 'amber-|red-[0-9]|coral.*#' src/ui/workspace/QueryTabView.tsx src/ui/workspace/ConfirmRun.tsx` → no matches (no hardcoded palette or coral hex remain).

### Residual risks
The four `--err`/`--warn`-consuming surfaces are dark-only by design (no light-theme values), so a future light theme inherits dark-tuned reds/ambers — tracked under DW-58 and the Epic 7 light-theme work. The optional `affectedRows`/`dependents`/`objectName` paths are dormant (no Core source) and carry the low-severity boundary gaps DW-61..64, to be hardened by whichever story extends the `confirmation_required` preview to feed them.

