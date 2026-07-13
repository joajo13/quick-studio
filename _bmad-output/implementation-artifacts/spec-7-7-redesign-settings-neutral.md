---
title: 'Redesign Settings/Connections to neutral — port the connect.html ink aesthetic onto the settings surface'
type: 'refactor'
created: '2026-07-13'
status: 'backlog'
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
- [ ] `src/ui/settings/SettingsPanel.tsx` — port the neutral chrome; move every ink-background action to `bg-coral text-coral-ink`; ink focus (`focus:border-coral`); keep RPC/gates/error-envelope behavior and `data-testid` intact.
- [ ] `src/ui/settings/ProvidersPanel.tsx` — same neutral treatment for the provider rows and save/replace action; ink focus; behavior untouched.
- [ ] Legibility sweep — grep the settings surface for any ink/accent background paired with a white or near-white foreground and fix it to `text-coral-ink`; confirm no `bg-primary`/`border-primary`/`text-primary-foreground` or hardcoded coral/accent hex remains in these components.
- [ ] Theme sweep — visually confirm both light and dark themes render every ink-background element with a legible foreground (no white-on-white, no dark-on-dark).

**Acceptance Criteria:**
- Given the Settings surface, when it renders, then Connections and AI-providers sections match the neutral, ink-accented look of `design-artifacts/connect.html` (step-card chrome, mono uppercase labels, ink primary actions).
- Given any element that uses the ink accent as a background (primary/add/save/replace button, selected engine-card check, unlock button), then its label/glyph uses `text-coral-ink` and is legible in both light and dark themes — never white-on-ink or white-on-white.
- Given the components, when inspected, then no coral and no hardcoded accent hex appear, and blue `bg-primary`/`focus:border-primary` accents are gone — the only interactive accent is the neutral ink token from `globals.css`.
- Given color usage, then it is strictly functional: `ok` (green) only for a successful test / unlocked vault, `err` (red) only for a failed test / unreachable / error envelope / destructive confirm.
- Given the connection and provider flows (add / edit / remove / set / replace, error envelopes, mutation gates), when exercised, then behavior is identical to before the refactor and the existing test suite still passes with no test changes required to pass.
- Given `connections-model.ts` and `globals.css`, then they are unchanged by this story.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors (presentation-only; no type surface changed).
- `bun test` — expected: all existing suites pass unchanged (connections/providers behavior preserved; pure models untouched).
- `bun run build` — expected: OK (Tailwind utilities resolve the existing neutral tokens).

**Manual checks:**
- Launch the app, open Settings → Connections and Settings → AI providers, and confirm against `design-artifacts/connect.html`: ink primary actions read with a dark legible label, input focus is ink (not blue), the error banner and destructive confirm are red (functional), and — toggling the theme — no element renders white-on-white or dark-on-dark.
