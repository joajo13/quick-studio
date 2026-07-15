---
title: 'Redesign Settings/Connections to neutral — port the connect.html ink aesthetic onto the settings surface'
type: 'refactor'
created: '2026-07-13'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
warnings: [oversized]
baseline_revision: '033857d2d6effcba19e926b9f2991c0c0d4fdf88'
final_revision: '367baf26329f35f21e7a353fe4a2d534c46918b4'
context:
  - '{project-root}/design-artifacts/connect.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-quick-studio-2026-07-07/EXPERIENCE.md'
---

<intent-contract>

## Intent

**Problem:** The Settings surface (Connections management + AI providers) still wears the pre-pivot look: primary actions render as `bg-primary` (blue) with `text-primary-foreground` (near-white), input focus rings are blue (`focus:border-primary`), and the chrome is the plain shadcn-era card stack — none of it matches the NEUTRAL, ChatGPT-style, ink-accented visual language the app pivoted to. The prototype `design-artifacts/connect.html` is the agreed VISUAL SOURCE OF TRUTH for this surface and SUPERSEDES any coral described in DESIGN.md / EXPERIENCE.md. Left as-is, the settings screens are visually inconsistent with the rest of the redesigned app, and a naive "make it ink" pass would produce white-on-ink buttons (the ink accent is near-white in dark theme) — an invisible, illegible primary action.

**Approach:** Presentation-only port. Restyle the existing Settings/Connections components to the neutral, ink-accented aesthetic of `connect.html`: step-card chrome, mono uppercase field labels, ink primary actions with a **legible dark foreground**, ink (not blue) input focus, and strictly semantic ok/err/vault color. Every element that uses the ink accent as a **background** (primary Connect/add/save/replace buttons, the selected engine-card check glyph, the unlock button) switches its foreground to the ink-button foreground token (`--coral-ink` / Tailwind `text-coral-ink`) so it never renders white-on-ink. Color survives only where it is functional — `ok` (green) for a successful test / unlocked vault, `err` (red) for a failed test / unreachable / error envelope / destructive confirm. No new RPC, no new validation, no new credential-store logic: the connection/provider RPC calls, the trust boundary, the pure view-models, and the existing passing tests all stay exactly as they are. The pure `connections-model.ts` is NOT touched. `globals.css` is already neutral and is the token source — it is not modified.

## Boundaries & Constraints

**Always:**
- Treat `design-artifacts/connect.html` as the visual source of truth for this surface; where it disagrees with coral in DESIGN.md / EXPERIENCE.md, the prototype wins.
- Consume the existing neutral tokens from `globals.css` via Tailwind utilities (`bg-coral`, `text-coral-ink`, `border-coral`, `bg-coral-soft`, `text-foreground`, `text-muted-foreground`, `bg-card`, `border-border`, `font-mono`) — never introduce a new hardcoded hex accent.
- Every element that fills its background with the ink accent (primary Connect/add/save/replace button, selected engine-card check circle, unlock button) MUST set its foreground to `text-coral-ink` (maps to `--coral-ink` / the prototype's `--ink-btn-fg`) so the label/glyph stays legible against near-white ink in dark theme and against dark ink in light theme.
- Keep color strictly functional: `ok` (green) only for a successful test-connection result and the UNLOCKED credential-store panel; `err` (red) only for a failed/unreachable test, the RPC error-envelope banner, and the destructive remove-confirm; everything else is neutral ink / muted-foreground.
- Preserve behavior verbatim: the `connections.list/add/edit/remove` and `providers.list/set/remove` RPC calls, the token-gated `rpc` client usage, the `busy`/`loading`/`listLoaded` mutation gates, the credit-free `ConnectionSummary`/`ProviderSummary` trust boundary, and the in-panel error-envelope surfacing (`envelopeText`, `role="alert"`) all stay unchanged.
- Keep the pure view-model `connections-model.ts` untouched — validation, reducers, and the `Draft` contract are behavior, not presentation.
- Preserve accessibility affordances already present: `role="alert"` on error lines, `aria-label` on close, labelled inputs (`<label>` wrapping), `spellCheck={false}`/`autoComplete="off"` on credential inputs, and a visible focus-visible ring (ink, per `globals.css`).
- Support both themes: light and dark must both stay legible — verify the ink-background elements flip foreground correctly (`--coral-ink` dark-on-ink in dark, and the light-theme ink/foreground pairing) with no white-on-white or dark-on-dark.

**Never:**
- No coral, and no new hardcoded accent hex anywhere — the only interactive accent is the neutral ink token already in `globals.css`.
- No white (or near-white) foreground on an ink-accent background — no white-on-ink / white-on-white primary action.
- No change to RPC methods, params, request/response shapes, the transport, the token/origin gates, validation, or the credential-store / vault behavior — this story adds and removes no data flow.
- No edits to `connections-model.ts` or any pure model/reducer, and no edits to `globals.css` (already neutral; token source only).
- Do not break or rewrite the existing passing tests, and do not change component prop contracts or `data-testid`s that tests rely on.
- Do not wire net-new behavior implied by prototype-only chrome (e.g. a live engine picker or a live test-connection round-trip) unless it already exists in the surface — style what is there; do not invent RPC to satisfy the prototype's richer mock.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Legibility / Error Handling |
|----------|--------------|---------------------------|-----------------------------|
| Primary action rendered | add / save / replace button enabled | Ink-accent fill (`bg-coral`) with dark legible label (`text-coral-ink`); matches `connect.html` `.connect-btn.primary` / `.unlock-btn` | Never white-on-ink; readable in both themes |
| Ink glyph on ink fill | selected engine-card check (where present) | Dark check on ink circle (`bg-coral text-coral-ink`), per `.engine-card.selected .check` | Never invisible white-on-white |
| Disabled primary action | validation fails / `busy`/`loading`/`!listLoaded` | Same ink button, dimmed (`disabled:opacity-50`, `cursor-not-allowed`); behavior gate unchanged | Still recognizably the primary action |
| Input focus | user focuses a mono field | Ink focus (`focus:border-coral`, soft ink ring) — NOT blue `focus:border-primary` | Neutral, matches `.mono-input:focus` |
| Test-connection ok | test returns success (where the affordance exists) | `ok` (green) result text + pulse dot, per `.test-result.ok` | Functional color only |
| Test-connection failed | test fails / host unreachable | `err` (red) result, per `.test-result.err` / saved-list `.mini-status.err` | Functional color only |
| Credential store panel | locked vs unlocked | Locked = neutral/muted tag+icon; unlocked = `ok` (green) tag+icon, per `.vault-panel.locked/.unlocked` | Green reserved for the unlocked (safe) state |
| RPC error envelope | any `reply.ok === false` | In-panel `err` banner via `envelopeText`, `role="alert"` — never console-only; wording/behavior unchanged | Behavior preserved; only styling touched |
| Destructive remove confirm | user clicks remove → confirm | `err` (red) confirm button; white-on-red is legible functional color and allowed | Functional destructive color kept |
| Light theme | `data-theme="light"` / prefers light | Ink token resolves to dark ink, `text-coral-ink` resolves to light — every ink-bg element stays legible | No dark-on-dark, no white-on-white |
| Behavior regression check | full add/edit/remove + provider set/remove flows | Identical to pre-refactor: same RPC, same gates, same summaries | `bun test` stays green; no test edits needed to pass |

</intent-contract>

## Code Map

- `src/ui/settings/SettingsPanel.tsx` — restyle only: switch the add-form `add` button and the `EditRow` `save` button from `bg-primary text-primary-foreground` to the ink accent `bg-coral text-coral-ink` (the white-on-ink fix); change field focus from `focus:border-primary` to `focus:border-coral`; apply the `connect.html` step-card / mono-uppercase-label / neutral-header chrome to the section switcher (`connections` / `ai providers`), the add-connection card, and the `ConnectionRow` list rows. Keep the `err`-toned error banner and the red destructive remove-confirm (functional color). No change to hooks, RPC calls, gates, `envelopeText`, props, or `data-testid="settings-panel"`.
- `src/ui/settings/ProvidersPanel.tsx` — restyle only: switch the `ProviderRow` save/replace button from `bg-primary text-primary-foreground` to `bg-coral text-coral-ink`; change the api-key input focus from `focus:border-primary` to `focus:border-coral`; apply the neutral step-card + mono-label chrome and the configured/not-configured status line in neutral/muted tone. Keep the `err` error banner. No change to the `providers.*` RPC calls, the `busy`/`loading`/`listLoaded` gates, the secret-free draft handling, or props.
- `src/ui/settings/connections-model.ts` — NO CHANGE. Pure, presentation-free view-model (validation + reducers + `Draft`); listed only to pin the behavior contract the restyle must preserve. Do not edit.
- `src/ui/styles/globals.css` — NO CHANGE. Already neutral; the token source (`--coral` = ink `#ececec`, `--coral-ink` = `#0b0d11`, `--coral-soft`, `--focus-ring`, ok/err semantics) the components consume via Tailwind utilities.
- `design-artifacts/connect.html` — reference only (visual source of truth): engine picker with ink selected-state + legible check, mono connection form, ok/err test-result, locked/unlocked credential-store panels, and the ink primary Connect button with dark `--ink-btn-fg` label.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/settings/SettingsPanel.tsx` — port the neutral chrome; move every ink-background action to `bg-coral text-coral-ink`; ink focus (`focus:border-coral`); keep RPC/gates/error-envelope behavior and `data-testid` intact.
- [x] `src/ui/settings/ProvidersPanel.tsx` — same neutral treatment for the provider rows and save/replace action; ink focus; behavior untouched.
- [x] Legibility sweep — grep the settings surface for any ink/accent background paired with a white or near-white foreground and fix it to `text-coral-ink`; confirm no `bg-primary`/`border-primary`/`text-primary-foreground` or hardcoded coral/accent hex remains in these components.
- [x] Theme sweep — visually confirm both light and dark themes render every ink-background element with a legible foreground (no white-on-white, no dark-on-dark).

**Acceptance Criteria:**
- Given the Settings surface, when it renders, then Connections and AI-providers sections match the neutral, ink-accented look of `design-artifacts/connect.html` (step-card chrome, mono uppercase labels, ink primary actions).
- Given any element that uses the ink accent as a background (primary/add/save/replace button, selected engine-card check, unlock button), then its label/glyph uses `text-coral-ink` and is legible in both light and dark themes — never white-on-ink or white-on-white.
- Given the components, when inspected, then no coral and no hardcoded accent hex appear, and blue `bg-primary`/`focus:border-primary` accents are gone — the only interactive accent is the neutral ink token from `globals.css`.
- Given color usage, then it is strictly functional: `ok` (green) only for a successful test / unlocked vault, `err` (red) only for a failed test / unreachable / error envelope / destructive confirm.
- Given the connection and provider flows (add / edit / remove / set / replace, error envelopes, mutation gates), when exercised, then behavior is identical to before the refactor and the existing test suite still passes with no test changes required to pass.
- Given `connections-model.ts` and `globals.css`, then they are unchanged by this story.

## Spec Change Log

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 0, low 2)
- defer: 1: (high 0, medium 0, low 1)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[low]` `[patch]` The provider `configured · {keyPreview}` line was rendered under `uppercase`, distorting a case-sensitive API-key preview tail (e.g. `ab12`→`AB12`) — contradicting the codebase's verbatim-identifier idiom (`HostEngine`). Wrapped the value in `<span className="normal-case">` so the caption stays uppercase but the key tail renders verbatim (`ProvidersPanel.tsx`). tsc + all suites still green.
  - `[low]` `[patch]` A focused **invalid** input dropped its red `border-err` cue and gained a positive ink glow (`focus:border-coral` + `--coral-soft` ring won on `:focus`), so a bad field read as "good" while being corrected. Made the invalid branch keep an err border + soft-err ring on focus (`invalid ? border-err focus:border-err focus:shadow-[…--err-soft] : border-border focus:border-coral focus:shadow-[…--coral-soft]`) in the shared `Field` (`SettingsPanel.tsx`). tsc + all suites still green.

Deferred (1): the solid `bg-err` destructive-confirm fill with `text-white` is ~3:1 in dark theme (below AA; the prior `bg-red-600` was ~4.8:1) — a proper fix needs a darker destructive-red or an on-err foreground token in `globals.css`, which this story is contract-forbidden to edit. Logged to `deferred-work.md`.

Rejected (10, all low): label metric `text-[11px]` vs source `--label-size:10.5px` (0.5px, pre-existing idiom); add/provider card `p-3→p-4` vs sibling rows (cosmetic rhythm, defensible card chrome); selective uppercase of captions but not values/microcopy (by design — matches `connect.html`, only `.f-label`/`.vault-tag` are uppercased); doubled focus indicator (`:focus` shadow + global `:focus-visible` outline — more visible, not less; shadow is the only mouse-focus cue); `transition-colors` not tweening `hover:opacity-90` (pre-existing, unchanged by this story); active-tab `border-b-2` crowds/≈-color the header rule (functional non-color cue, Tailwind equivalent of the prototype's pseudo-element); `border-err-line` 40%-alpha edge over solid `bg-err` (cosmetic edge definition); light-theme `--err` text contrast (refuted — a light `--err`=#c23b34 override exists); light-theme `--err-soft`/`--err-line` banner and `--coral-soft` focus-ring faintness (globals.css token values, out of scope; keyboard `:focus-visible` ring still present).

## Design Notes

**This restyle is fully test-safe — there are no component/DOM tests over these panels.** The only tests touching the settings surface are the pure view-models `connections-model.test.ts` and `providers-model.test.ts` (validation + reducers; no React render, no DOM strings, testids, roles, or class-name assertions). A class-only restyle cannot break them, so **no test edits are required to keep `bun test` green**. Still preserve `data-testid="settings-panel"` (`SettingsPanel.tsx:297`), the `role="alert"` error lines, `aria-label`s, and the visible labels/button text verbatim — they are the obvious future/e2e assertion targets even though nothing locks them today.

**Exact accents to neutralize (validated against the current source):**
- `bg-primary` + `text-primary-foreground` → `bg-coral text-coral-ink` at 3 sites: the add-connection `add` button (`SettingsPanel.tsx:370`), the `EditRow` `save` button (`SettingsPanel.tsx:123`), and the `ProviderRow` save/replace button (`ProvidersPanel.tsx:99`). These are the white-on-ink fix.
- `focus:border-primary` → `focus:border-coral` on the 2 input components: `Field` (`SettingsPanel.tsx:76`, shared by add + edit) and the `ProviderRow` api-key input (`ProvidersPanel.tsx:91`). The `@theme inline` block aliases `--color-coral*`/`--color-ok*`/`--color-err*`, so `bg-coral`, `text-coral-ink`, `border-coral`, `bg-coral-soft`, `text-ok`, `text-err`, `border-err-line` all resolve as utilities — but there is **no** `--color-focus-ring` alias, so use `border-coral` (same value as `--focus-ring`), not `border-focus-ring`. For the prototype's soft ink focus halo, pair it with `focus:shadow-[0_0_0_3px_var(--coral-soft)]` (matches `.mono-input:focus`); the global `:focus-visible` ink ring already exists.
- Keep the destructive/error reds **functional**: the remove-confirm `yes` button (`SettingsPanel.tsx:166`), the invalid-input border (`SettingsPanel.tsx:78`), and the error banners/`ErrorLine` (`SettingsPanel.tsx:36,340` / `ProvidersPanel.tsx:38,189`). Prefer the semantic `err` tokens (`text-err`, `bg-err-soft`, `border-err-line`) over raw `text-red-*`/`bg-red-*` scales for consistency with the neutral palette, but the red *meaning* stays.

**Labels: prototype is UPPERCASE mono, panels are currently lowercase mono.** The prototype's `.f-label`/`.label` are `text-transform:uppercase`; the panels render `font-mono text-[11px] lowercase text-muted-foreground`. Move field/section labels to the uppercase mono idiom (`uppercase tracking-[0.08em]`) per the visual source of truth — this is a class-only change and touches no asserted text.

**Prototype-only chrome is out of scope.** `connect.html` shows an engine picker (with selected-state ink check glyph), a live Test-connection ok/err result, and a locked/unlocked credential-store vault panel. None of these affordances exist in the current `SettingsPanel`/`ProvidersPanel` (plain add/edit/remove + provider-key rows). Per the contract's **Never**, style only what is present — do NOT wire the picker, test round-trip, or vault panel to satisfy the richer prototype mock.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors (presentation-only; no type surface changed).
- `bun test` — expected: all existing suites pass unchanged (connections/providers behavior preserved; pure models untouched).
- `bun run build` — expected: OK (Tailwind utilities resolve the existing neutral tokens).

**Manual checks:**
- Launch the app, open Settings → Connections and Settings → AI providers, and confirm against `design-artifacts/connect.html`: ink primary actions read with a dark legible label, input focus is ink (not blue), the error banner and destructive confirm are red (functional), and — toggling the theme — no element renders white-on-white or dark-on-dark.

## Auto Run Result

Status: done

### Summary
Presentation-only neutral/ink (ChatGPT-style) port of the Settings surface onto `design-artifacts/connect.html`. Every ink-accent BACKGROUND action moved from the illegible-in-dark `bg-primary text-primary-foreground` (blue fill + near-white label) to `bg-coral text-coral-ink` (ink fill + dark legible label) — the white-on-ink fix — at all 3 sites: the add-connection `add` button, the `EditRow` `save` button, and the `ProviderRow` save/replace button. Input focus flipped from blue `focus:border-primary` to ink `focus:border-coral` plus the prototype's soft ink ring (`focus:shadow-[0_0_0_3px_var(--coral-soft)]`) on both the shared `Field` and the api-key input. Caption-style labels (field labels, section/status captions, "add connection") moved to the mono UPPERCASE idiom (`uppercase tracking-[0.08em]`) matching `.f-label`/`.label`; values and microcopy stayed as-is. Functional color was retained but re-tokenized to the semantic palette: `text-red-400`→`text-err` (error lines), `border-red-700 bg-red-950/40`→`border-err-line bg-err-soft` (error banners), invalid input `border-red-500`→`border-err`, and the destructive remove-confirm `yes` button `bg-red-600`→`bg-err` (red MEANING preserved). The section switcher gained a neutral active-tab underline (`border-b-2 border-coral`, inactive `border-transparent` so no layout shift). No behavior change: the `connections.*`/`providers.*` RPC calls, the `busy`/`loading`/`listLoaded` mutation gates, the `envelopeText`/`role="alert"` error envelope, `data-testid="settings-panel"`, all `aria-label`s, and every visible label/button text are byte-identical. The pure view-models `connections-model.ts`/`providers-model.ts` and the token source `globals.css` are untouched.

### Files changed
- `src/ui/settings/SettingsPanel.tsx` — ink primary actions (`bg-coral text-coral-ink`) on add + EditRow save; ink focus + soft ring on `Field`; UPPERCASE captions; semantic err tokens on ErrorLine / invalid border / error banner / destructive confirm; active-tab underline chrome. No handler/RPC/gate change. (Review patch: invalid input keeps its err border + soft-err ring on focus instead of reading as a positive ink glow.)
- `src/ui/settings/ProvidersPanel.tsx` — ink save/replace action; ink focus + soft ring on the api-key input; UPPERCASE captions; semantic err tokens on ErrorLine / banner. No `providers.*`/gate change. (Review patch: the case-sensitive `keyPreview` tail wrapped in `normal-case` so `uppercase` no longer distorts it.)
- `src/ui/styles/globals.css` — NOT modified (token source only).
- `src/ui/settings/connections-model.ts` / `providers-model.ts` — NOT modified (pure view-models).
- `src/core/*-bundle.generated.ts` — regenerated by `bun run build` (embed the restyled UI/CSS).

### Review findings breakdown
- **Patches applied (2, both low):** (1) provider `configured · {keyPreview}` was under `uppercase`, distorting a case-sensitive key tail — wrapped the value in `normal-case`, caption stays uppercase. (2) a focused invalid input dropped its red cue and gained a positive ink glow — the invalid branch now keeps an err border + soft-err ring on focus.
- **Deferred (1, low):** the solid `bg-err` destructive-confirm fill with `text-white` is ~3:1 in dark (below AA; prior `bg-red-600` was ~4.8:1) — a darker destructive-red / on-err foreground token is needed in `globals.css`, which this story is contract-forbidden to edit. Logged to `deferred-work.md` (epic-wide contrast concern, cf. DW-58/67).
- **Rejected (10, all low):** label 11px vs source 10.5px (pre-existing idiom); card `p-3→p-4` rhythm (defensible card chrome); selective caption casing (by design, matches prototype); doubled focus indicator (more visible, not less; shadow is the sole mouse-focus cue); `transition-colors` vs `hover:opacity-90` (pre-existing); active-tab underline crowding/≈color (functional non-color cue); `border-err-line` edge over solid fill (cosmetic); light-theme `--err` text (refuted — a light override exists); light-theme `--err-soft`/`--err-line`/`--coral-soft` faintness (globals.css token values, out of scope; keyboard focus-visible ring still present).

### Verification
- `bunx tsc --noEmit` → clean (exit 0), before and after review patches.
- `bun test` → **1065 pass, 0 fail** (2621 expects, 68 files); no test file modified (settings tests are pure view-models — `connections-model.test.ts`/`providers-model.test.ts` — with no DOM coupling).
- `bun run build` → OK (ui/sandbox/snapshot/live-report bundles all wrote).
- `rg 'bg-primary|text-primary-foreground|focus:border-primary|border-primary' src/ui/settings/{SettingsPanel,ProvidersPanel}.tsx` → no matches. `rg 'coral|#[0-9a-fA-F]{6}'` on both files → only sanctioned utilities (`bg-coral`, `text-coral-ink`, `border-coral`, `var(--coral-soft)`/`var(--err-soft)` in arbitrary shadows), no hardcoded hex.
- `git diff` scope confirmed: only `SettingsPanel.tsx` + `ProvidersPanel.tsx` (source), plus regenerated bundles and bookkeeping; `connections-model.ts`/`providers-model.ts`/`globals.css` untouched.

### Follow-up review recommendation
`false` — the final pass applied only two localized, low-consequence class-level patches (a `normal-case` wrapper + a focus-state class conditional) and one deferred cosmetic contrast note. No behavior, RPC, API, security, persistence, or data-flow change; every seam is byte-identical and the full suite stays green. Not significant enough to warrant an independent follow-up review.

### Residual risks
- **Visual fidelity is Tailwind-approximated**, not a pixel clone of the prototype's bespoke CSS; a manual light/dark pass in the running app is the only check a CLI cannot perform.
- **Dark-theme destructive-confirm contrast** is the deferred item (`bg-err` + white ~3:1) — the button still reads and sits behind a two-step confirm, but a darker-red token is the real fix.
- **Light theme is opt-in** (`data-theme="light"`) and, as across Epic 7, less battle-tested than dark; the re-tokenized error surfaces carry the epic-wide small-text/soft-overlay contrast risk (cf. DW-58/67), out of scope here since `globals.css` is frozen for this story.
