---
title: 'Redesign the Query editor + destructive confirm to the neutral ChatGPT-style look'
type: 'refactor'
created: '2026-07-13'
status: 'backlog'
context:
  - '{project-root}/design-artifacts/workspace.html'
  - '{project-root}/design-artifacts/confirm-destructive.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
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

- `src/ui/workspace/QueryTabView.tsx` -- restyle the editor pane + Run control to workspace.html: ink-filled `.run`-style control (up-arrow glyph + "Run" label + `⌘↵` kbd chip) on a neutral editor bar over the mono editor textarea; retone the truncated / affected / error banners off hardcoded `amber-*`/`red-*` onto `globals.css` tokens (neutral / `--warn` / `--err`). Control flow, `run()`, the `⌘/Ctrl+Enter` handler, the enable gate, the `firing` guard, and the pager are untouched.
- `src/ui/workspace/ConfirmRun.tsx` -- replace the inline amber panel with the confirm-destructive.html modal: a scrim + neutral `role="alertdialog"` card (no top color line), red danger icon, concise one-line `risk` description, verbatim `sql` in a red-left-border `<pre>`, a neutral footer with a quiet autofocus/Esc Cancel and a filled-red Confirm (icon + label). Add OPTIONAL `affectedRows?` / `dependents?` / `objectName?` props that render the red affected-rows badge, the dependent-FK line, and the type-to-confirm gate (client-side friction) only when provided. `onConfirm` / `onCancel` / `busy` intents preserved.
- `src/ui/workspace/run-raw-query.ts` -- NO CHANGE (guardrail bullet). The guarded `execute` RAW round-trip, `RunOutcome`, the `confirmed:true` re-issue, and the Core-is-the-sole-gate model must be preserved exactly; the redesign must not touch this seam.
- `src/ui/styles/globals.css` -- add destructive semantic tokens `--err` / `--err-soft` / `--err-line` (dark-first) for the confirm dialog's functional red, and (if consumed as Tailwind utilities) expose them via `@theme inline`; add `--warn` / `--warn-soft` if the truncated banner needs a restrained warning tone. `--coral` stays ink; no coral hex reintroduced.

## Tasks & Acceptance

**Execution:**
- [ ] `src/ui/styles/globals.css` -- add `--err`/`--err-soft`/`--err-line` (and `--warn`/`--warn-soft` if needed) neutral-pivot semantic tokens; expose via `@theme inline` if used as utilities -- the destructive/warn palette the redesigned surfaces consume.
- [ ] `src/ui/workspace/QueryTabView.tsx` -- port the editor bar + ink Run control (arrow glyph + "Run" + `⌘↵` chip) and retone all result/truncated/affected/error banners onto tokens; leave `run()`, the key handler, the enable gate, the `firing` guard, and the pager byte-identical.
- [ ] `src/ui/workspace/ConfirmRun.tsx` -- port the confirm-destructive modal (scrim + neutral `alertdialog`, red only on icon/left-border/badge/Confirm, one-line description, verbatim `sql`) and add optional `affectedRows?`/`dependents?`/`objectName?` props (badge / FK-deps / type-to-confirm rendered only when supplied); preserve `onConfirm`/`onCancel`/`busy` and the "UX-only, never the gate" model.
- [ ] `src/ui/workspace/ConfirmRun` presentational test -- extend the existing react-dom/server test: base modal renders (no top line, red on functional bits only), and each optional element renders only when its prop is supplied.

**Acceptance Criteria:**
- Given a query tab, when the editor renders, then it matches `workspace.html`: an ink-filled Run control (up-arrow glyph + "Run" label + `⌘↵` chip) on a neutral editor bar over a mono editor surface — no coral, no hardcoded palette colors — and `⌘/Ctrl+Enter` still runs the draft.
- Given a runnable or blocked draft, when Run's enable state changes, then the control enables/dims exactly as before (`isRunnable(draft) && !busy && confirm === null`) and the double-fire `firing` guard still holds.
- Given a `confirmation_required` outcome, when the confirm surfaces, then it matches `confirm-destructive.html`: a neutral scrim + card with NO top color line, red only on the danger icon / statement left-border / Confirm button, a concise one-line description, and the verbatim SQL — Cancel takes focus, Esc cancels, and confirming re-issues the IDENTICAL `confirmed:true` request (the Core remains the gate).
- Given the optional preview data is passed, when supplied, then the red affected-rows badge, the dependent-FK line, and the type-to-confirm input appear as in the prototype; when absent, the base modal renders and existing callers behave unchanged.
- Given the neutral pivot, when any of these surfaces render, then no coral hex and no hardcoded Tailwind color utilities remain — all color resolves through `globals.css` tokens, and red appears only on functional destructive/error bits.
- Given the suite, when `bunx tsc --noEmit` and `bun test` run, then both pass, including the react-dom/server `ConfirmRun` presentational test.

## Design Notes

- **Why optional props, not a contract change:** presentation-only + no RPC change means the badge / FK-deps / type-to-confirm cannot invent Core data. Prop-gating keeps the component prototype-shaped and ready to light up the moment a later story extends the `confirmation_required` preview, without this refactor touching the execution contract.
- **`ConfirmRun` is shared:** `ChatTabView` also renders it, so the modal redesign propagates to the chat's confirm for free — no `ChatTabView` edit is required or in scope.
- **Syntax highlighting stays out:** coloring live SQL means classifying it, which AR-3 forbids in the UI. The editable textarea and the confirm `<pre>` stay plain verbatim mono; the prototype's `--sql-*` colored spans are a static mock and are not introduced here.
- **Dark-first:** `globals.css` has no light theme; the prototypes' `data-theme="light"` blocks are intentionally not ported.
- **Retone, don't recolor:** the truncated / affected / error banners drop hardcoded `amber-*`/`red-*` Tailwind onto neutral / `--warn` / `--err` tokens so the neutral pivot is total and every color has a functional reason.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors (new optional `ConfirmRun` props typed).
- `bun test` -- expected: all suites pass, including the react-dom/server `ConfirmRun` presentational test covering the base modal + each optional element.

**Manual checks (if a DB + browser are available):**
- Launch the app, open a query tab, confirm the ink Run control paints and `⌘/Ctrl+Enter` runs the draft.
- Run a `DROP TABLE` to raise the confirm: verify the neutral modal (no top color line), red only on the danger icon / statement left-border / Confirm button, that Cancel is focused and Esc cancels, and that confirming executes via the identical `confirmed:true` request.
- Scan the rendered surfaces for any remaining coral hex or hardcoded Tailwind palette classes — there should be none.
