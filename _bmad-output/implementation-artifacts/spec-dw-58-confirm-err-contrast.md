---
title: 'DW-58: give the filled destructive buttons an AA-contrast --err-fill token'
type: 'bugfix'
created: '2026-07-27'
status: 'done'
baseline_revision: '79e1c0e'
final_revision: 'ce3c975'
review_loop_iteration: 1
followup_review_recommended: false
context:
  - '{project-root}/design-artifacts/confirm-destructive.html'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** `--err` (`#ef6a63`) is dual-purpose. As *text on dark surfaces* it is fine (5.1–6.1:1 on `--muted`/`--card`/`--background`), but as a *solid fill under white text* it is only **3.04:1**, below WCAG AA (4.5:1). Two surfaces are affected: the `ConfirmRun` Confirm button (12.5px semibold, `ConfirmRun.tsx:83`) and the settings remove-confirm `yes` button (`SettingsPanel.tsx:182`). Simply darkening `--err` would fix the fills but drop every `text-err` error message below AA — the token cannot serve both roles.

**Approach:** Split the fill out of the shared token. Add a dark-only `--err-fill: #be342d` (same hue as `--err`, h≈3°) plus a `--color-err-fill` Tailwind alias, and repoint only the two white-on-red *fills* at it. `--err` itself is untouched, so every text/icon/border/soft-tint consumer keeps its current appearance. `#be342d` gives white **5.65:1** at rest, **4.84:1** under the existing `hover:brightness-110`, **5.23:1** under the settings button's `hover:opacity-90`, and **3.29:1** against `--background` (≥3:1, WCAG 1.4.11 non-text). A regression lock in the existing `contrast.test.ts` pins both directions so neither token can drift back.

## Boundaries & Constraints

**Always:**
- Presentation-only. No behavior, control-flow, RPC, or contract change.
- All color resolves through `globals.css` tokens. `--err-fill` is a 6-digit hex so `src/ui/styles/contrast.ts` `parseCssColor` can read it (it throws on `rgb()`/`var()`/alpha/3-digit).
- `--err-fill` is **dark-only**, defined in the `:root` Story 7.3 `--err*` group, matching that story's dark-first precedent. Extend the `@theme inline` block with `--color-err-fill: var(--err-fill);` so the bare `bg-err-fill` / `border-err-fill` utilities resolve (`SettingsPanel` uses bare utilities; `ConfirmRun` uses the arbitrary `bg-[var(--err-fill)]` form).
- Keep the suite green: `bunx tsc --noEmit` and `bun test` pass.

**Block If:**
- The AA lock in `contrast.test.ts` cannot express a foreground-on-token-fill pair without changing its `TOKENS`/`SURFACES` contract in a way that would weaken the existing checks — HALT `blocked` with condition `contrast AA lock cannot express the white-on-fill pair`.

**Never:**
- Do NOT change the value of `--err`, `--err-soft`, `--err-line`, or `--warn*`. Do NOT repoint any `text-err` / `border-l-[var(--err)]` / `bg-[var(--err-soft)]` / status-dot consumer.
- Do NOT add any `--err*` key to the `:root[data-theme="light"]` block — `contrast.test.ts:193` asserts the light block has no `err` key and Story 7.3 deliberately kept these dark-only.
- Do NOT touch the raw-Tailwind white-on-red buttons in `DataGrid.tsx:510` and `Workspace.tsx:212` (ExposureBanner) — same hazard, different token story, out of scope.
- Do NOT edit `design-artifacts/confirm-destructive.html` (the prototype carries the same defect; this is a deliberate, user-approved deviation from it).
- Do NOT edit the deferred-work ledger.
- No new hardcoded Tailwind palette utilities (`red-*`, `amber-*`) — `ConfirmRun.test.tsx:52-53` asserts their absence.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Confirm button at rest | `ConfirmRun` rendered | Fill + border are `var(--err-fill)`; white label ≥4.5:1 (5.65:1) | No error expected |
| Confirm button hovered | `hover:brightness-110` applied | Brightened fill still ≥4.5:1 against white (4.84:1) | No error expected |
| Settings remove-confirm hovered | `hover:opacity-90` composites button over `--background` | Composited fill vs composited label still ≥4.5:1 (5.23:1) | No error expected |
| Error text on dark surface | any `text-err` consumer | Unchanged `#ef6a63`, still ≥4.5:1 on `card`/`muted`/`background` (5.10–6.11:1) | No error expected |
| Someone darkens `--err` later | `--err` edited below AA on a dark surface | `contrast.test.ts` AA lock fails | Test failure names the token + surface |
| Someone lightens `--err-fill` later | `--err-fill` edited above AA-for-white | New white-on-fill assertion fails | Test failure names the pair |

</intent-contract>

## Code Map

- `src/ui/styles/globals.css` -- token source. `:root` Story 7.3 `--err*` group at lines 75–85 (`--err` … `--warn-soft`); `@theme inline` Story 7.3 aliases at lines 224–230; light block at 123–175 (must NOT gain an `err*` key).
- `src/ui/workspace/ConfirmRun.tsx` -- line 83, the filled Confirm button (`border-[var(--err)] bg-[var(--err)] … text-white hover:brightness-110`). **It sits in the footer at line 67, whose surface is `bg-[var(--muted)]`** — not `--background`. The dialog card itself (line 167) is `bg-[var(--card)]`. Lines 118/133/170/198/205 use `--err`/`--err-soft` as text/border/tint — leave untouched. Header docblock at lines 5–11 enumerates where red appears.
- `src/ui/settings/SettingsPanel.tsx` -- line 182, the remove-confirm `yes` button (`border-err-line bg-err … text-white hover:opacity-90`). **Its row (line 169) is `bg-card`** — not `--background`. No test file exists for this component.
- `src/ui/workspace/ConfirmRun.test.tsx` -- line 50 asserts `toContain("bg-[var(--err)]")` for the filled Confirm button; must be repointed. Lines 46/48/49/52/53 stay as-is.
- `src/ui/styles/contrast.ts` -- dependency-free `parseCssColor` / `relativeLuminance` / `contrastRatio`. Accepts 6-digit hex and `hsl(H S% L%)` only; **throws on `rgba()`**, so translucent tokens (`--err-soft`, `--err-line`) cannot be fed to it directly.
- `src/ui/styles/contrast.test.ts` -- reads `globals.css` from disk, splits dark/light blocks, resolves in-block `var()` aliases. Line ~193 asserts `light.has("err") === false`. Lines ~224–315 hold the DW-67 ERD AA lock (`TOKENS` = t-int, t-time, t-num, t-enum, t-text, muted-foreground, foreground; `SURFACES` = card, muted, background). `resolveToken` **throws** on a missing key, so a dark-only token cannot simply be appended to `TOKENS` — the lock iterates both themes.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/styles/globals.css` -- add `--err-fill: #be342d;` **immediately after `--err-line`, inside the contiguous `--err*` run and before `--warn`**, and add `--color-err-fill: var(--err-fill);` to the Story 7.3 group in `@theme inline`. The comment must state (a) why the token exists — `--err` is a text color on dark surfaces and cannot double as a white-text fill — and (b) the measured numbers from Design Notes. It must NOT call the token "dark-only": unlike `--err`, `--err-fill` lives in `:root` with no light override, so it applies in BOTH themes; say "single value, both themes (no light override needed — white on it clears AA against the light surfaces too)". Describe the derivation as "same hue, lower lightness AND lower saturation" — `hsl(3, 81%, 66%)` → `hsl(3, 62%, 46%)`. Leave the light block untouched. -- gives the fills an AA-capable token without regressing `--err` as a text color.
- [x] `src/ui/workspace/ConfirmRun.tsx` -- on the Confirm button (line 83) replace **only the fill**: `bg-[var(--err)]` → `bg-[var(--err-fill)]`. **KEEP `border-[var(--err)]`** — the lighter rim is the button's WCAG 1.4.11 boundary against the `--muted` footer (5.10:1); the fill alone is 2.74:1 there and would fail. Change nothing else on the element. Then amend the header docblock (lines 5–11) so its "red appears ONLY on …" list is *rewritten* rather than footnoted: the Confirm button now carries an `--err` rim over an `--err-fill` body. Leave the reflowed prose clean — no dangling short line. -- the primary DW-58 defect, without deleting the boundary affordance.
- [x] `src/ui/settings/SettingsPanel.tsx` -- on the remove-confirm `yes` button (line 182) replace **only the fill**: `bg-err` → `bg-err-fill`. **Change `border-err-line` → `border-err`** — `--err-line` is `rgba(…, 0.40)` and composites to just 1.93:1 against the `--card` row, so it cannot serve as the boundary; solid `--err` gives 5.72:1. -- the sibling white-on-red surface, with a boundary that actually clears 1.4.11.
- [x] `src/ui/workspace/ConfirmRun.test.tsx` -- repoint the line-50 assertion to `expect(html).toContain("bg-[var(--err-fill)]")` with an accurate trailing comment, and add one negative regression guard next to it: no element may pair a `bg-[var(--err)]` fill with `text-white` (e.g. `expect(html).not.toMatch(/bg-\[var\(--err\)\][^"']*text-white/)`), so the 3.04:1 pairing DW-58 removes cannot silently return. Lines 46/48/49/52/53 stay as-is. -- keeps the component-level contract and pins the regression.
- [x] `src/ui/styles/contrast.test.ts` -- add a **new top-level `describe` for DW-58** (do NOT bolt anything into the DW-67 ERD describe). It must contain:
  1. `--err` pinned as a text color ≥4.5:1 on `card`/`muted`/`background` (measured 5.72 / 5.10 / 6.11), reading the dark block only. Implement it here rather than by appending `"err"` to the ERD lock's `TOKENS`, since `resolveToken` throws on the light block where `--err` is absent — and say so in a comment.
  2. White on `--err-fill` ≥4.5:1 at rest (5.65).
  3. White on `brightness(1.10)` of `--err-fill` ≥4.5:1 (4.84), via a local `brightness()` helper modelling CSS `filter: brightness()` as a per-channel sRGB multiply, rounded and clamped to 0–255. Give `brightness()` its own unit test with a hand-verifiable fixed point (e.g. `brightness("#808080", 1.1) === "#8d8d8d"`, and a clamp case like `brightness("#f0f0f0", 1.5) === "#ffffff"`), matching how `parseCssColor`/`contrastRatio` are tested in this file.
  4. The settings button's `hover:opacity-90` path: composite `--err-fill` and `#ffffff` each at 0.9 over `--card` and assert the label still ≥4.5:1 (5.27). This is a genuinely different composite from `brightness()` — do not let it ride on that test.
  5. **1.4.11 boundary measured against the surfaces the buttons actually sit on**: assert the *border* color `--err` ≥3:1 against `--muted` (ConfirmRun footer) and `--card` (settings row). Do NOT assert `--err-fill` vs `--background` — no button sits there, and it is the only surface the fill passes.
  6. A guard that the `@theme inline` block maps `--color-err-fill` to `var(--err-fill)`, since `SettingsPanel`'s bare `bg-err-fill` utility silently vanishes without it while every color assertion stays green.
  7. A guard that the light block gains no `err-fill` key, mirroring the existing `light.has("err") === false` assertion.
  Read `globals.css` **once per describe**, not once per test. Assert with plain `expect(ratio).toBeGreaterThanOrEqual(…)` plus a comment naming the pair — drop the `expect({pair, …}).toEqual({pair, …})` shape, where `pair` is computed identically on both sides and can never fail. -- locks every state and surface that actually ships.

**Acceptance Criteria:**
- Given the app renders in the default dark theme, when the `ConfirmRun` dialog and the settings remove-confirm row are shown, then both filled destructive buttons paint `--err-fill` behind their white label and keep a solid `--err` rim, and no other surface in the app changes color.
- Given the WCAG 1.4.11 boundary is evaluated, when each button's rim is compared to the surface it actually sits on (`--muted` for the Confirm footer, `--card` for the settings row), then both clear 3:1.
- Given a reviewer greps `src/` for `--err`, when they inspect every non-fill consumer (status dots, error text, soft tints, the statement left-border), then all still resolve to the unchanged `#ef6a63`.
- Given `bun test` runs, when the contrast suite executes, then every DW-58 assertion passes and no pre-existing assertion regresses.
- Given `bunx tsc --noEmit` runs, when it completes, then it reports no errors.

## Spec Change Log

### 2026-07-27 — bad_spec loopback 1

**Triggering finding (high):** the spec's contrast task dictated the WCAG 1.4.11 assertion as "`--err-fill` vs `--background` ≥3:1", but neither destructive button sits on `--background`. `ConfirmRun`'s Confirm is in a `bg-[var(--muted)]` footer (`ConfirmRun.tsx:67`) and the settings `yes` is on a `bg-card` row (`SettingsPanel.tsx:169`). Measured: fill vs `--muted` **2.74:1 (fails)**, vs `--card` 3.08:1, vs `--background` 3.29:1 — the spec named the single most favourable surface, so the implementation shipped a green test over a real boundary failure.

**Triggering finding (medium):** the spec instructed dropping the lighter rim on both buttons (`border-[var(--err)]` → `border-[var(--err-fill)]`; `border-err-line` → `border-err-fill`) on the rationale that "`err-line` over the darker fill would read as a stray lighter hairline". That rationale was unmeasured and wrong: the rim was the buttons' only 1.4.11 boundary signal, and `--err` delivers 5.10:1 on `--muted` / 5.72:1 on `--card`.

**Amended:** Code Map now records the real surfaces each button sits on, that `parseCssColor` throws on `rgba()`, and that `resolveToken` throws on a missing key (so a dark-only token cannot just be appended to the ERD lock's `TOKENS`). Tasks 2 and 3 now change **only the fill** and keep a solid `--err` rim. Task 5 is rewritten as a self-contained top-level DW-58 describe covering: `--err`-as-text pinned, white-on-fill at rest, the `brightness(1.10)` hover, the `opacity-90` hover composite, the 1.4.11 boundary against `--muted`/`--card` (never `--background`), the `--color-err-fill` alias mapping, and a light-block `err-fill` guard — plus a unit test for the `brightness()` helper and the removal of the tautological `expect({pair}).toEqual({pair})` shape. Task 4 gains a negative regression guard against re-pairing `bg-[var(--err)]` with `text-white`. Design Notes gained the measured boundary table, the corrected hue/saturation derivation, and a note that `--err-fill` is *not* dark-only. Verification replaced the broken `bg-err\b` grep (`\b` matches at `-`, so it also hit `bg-err-soft`) and added a token-tamper diff check.

**Known-bad state avoided:** shipping a Confirm button whose fill is 2.74:1 against its own footer while a test asserts 3:1 against a surface it never touches — a green suite certifying the wrong thing.

**KEEP (must survive re-derivation):**
- `--err-fill: #be342d` and its derivation: white 5.65:1 at rest, 4.84:1 under `brightness(1.10)`, 5.27:1 under `opacity-90` over `--card`. `#d23b45` was correctly rejected at 3.99:1 hovered.
- The `--color-err-fill: var(--err-fill);` alias in `@theme inline`, and the two consumption syntaxes as-is (`bg-[var(--err-fill)]` in `ConfirmRun`, bare `bg-err-fill` in `SettingsPanel`).
- Pinning `--err` as a text color in a **separate** list from the ERD lock's `TOKENS`, because `resolveToken` throws on the light block where `--err` is absent. The previous pass's diagnosis here was correct; only its placement (inside the DW-67 ERD describe) was wrong.
- Modelling CSS `filter: brightness()` as a per-channel **sRGB** multiply, rounded and clamped — the shorthand filter functions do not operate in linear light.
- Repointing `ConfirmRun.test.tsx:50` to `bg-[var(--err-fill)]`.
- Leaving `--err`, `--err-soft`, `--err-line`, `--warn*` and every text/tint/dot consumer byte-identical; full suite green with 0 failures.

## Review Triage Log

### 2026-07-27 — Review pass 1
- intent_gap: 0
- bad_spec: 12: (high 1, medium 1, low 10)
- patch: 0
- defer: 3: (high 0, medium 2, low 1)
- reject: 6
- addressed_findings:
  - `[high]` `[bad_spec]` 1.4.11 assertion measured `--err-fill` vs `--background`, the only surface that passes; the real surfaces are `--muted` (2.74:1, fails) and `--card` (3.08:1) — task rewritten to assert the rim against the actual surfaces.
  - `[medium]` `[bad_spec]` Both buttons lost their boundary affordance when the border followed the fill to `--err-fill` — tasks 2/3 now change only the fill and keep a solid `--err` rim.
  - `[low]` `[bad_spec]` Nothing asserted the `--color-err-fill` → `bg-err-fill` alias mapping; dropping it renders the settings button transparent with every test green.
  - `[low]` `[bad_spec]` No light-block guard on `err-fill`, unlike the existing `light.has("err") === false`.
  - `[low]` `[bad_spec]` The token comment called `--err-fill` "dark-only", which is false — it is declared once in `:root` with no light override and applies in both themes.
  - `[low]` `[bad_spec]` No regression guard forbidding a future `bg-[var(--err)]` + `text-white` pairing, the exact 3.04:1 defect being fixed.
  - `[low]` `[bad_spec]` `DARK_ONLY_TOKENS` was bolted into the DW-67 ERD describe, so an `--err` regression would report under an ERD heading.
  - `[low]` `[bad_spec]` The derivation comment claimed "same hue, dropped in lightness" while saturation also fell 81% → 62%.
  - `[low]` `[bad_spec]` `--err-fill` was placed after `--warn-soft`, outside the contiguous `--err*` run it claims membership in.
  - `[low]` `[bad_spec]` The `brightness()` helper shipped untested in a file where every other helper has hand-verifiable fixed-point tests.
  - `[low]` `[bad_spec]` `expect({pair, atLeastAA}).toEqual({pair, atLeastAA: true})` computes `pair` identically on both sides, so it can never contribute to pass/fail.
  - `[low]` `[bad_spec]` `darkProps()` re-read and re-parsed `globals.css` from disk once per test.

### 2026-07-27 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 1, medium 1, low 3)
- defer: 8: (high 0, medium 4, low 4)
- reject: 5
- addressed_findings:
  - `[high]` `[patch]` Nothing asserted that the Confirm button actually consumes the `--err` rim — the contrast tests measure token values, not which element uses them, so the load-bearing 1.4.11 boundary could be dropped with the whole suite green. Added `expect(html).toContain("border-[var(--err)]")`; mutation-verified that removing the rim now fails.
  - `[medium]` `[patch]` The white-on-`--err` regression guard covered only one of the two shipped spellings (`bg-[var(--err)]`, not the bare `bg-err` the `--color-err` alias also emits) and only one class order. Widened to both spellings and both orders, with a negative lookahead so `bg-err-soft` / `bg-err-fill` still don't match; mutation-verified against a reintroduced `bg-err` + `text-white` pairing.
  - `[low]` `[patch]` The 1.4.11 rim assertion computed the identical expression as the ≥4.5 text lock over the same surfaces, so it could never fail independently. It now also measures the hover-brightened rim (`#ef6a63` → `#ff756d`, 5.92 / 6.64), which the text lock does not imply.
  - `[low]` `[patch]` The token comment's light-theme justification was a non-sequitur ("white on it clears AA against the light surfaces" — white sits on the token, not the surface). Replaced with the real numbers: fill vs light `--card` 5.27:1, vs light `--muted` 4.91:1, and an explicit note that the rim is only 2.84:1 in light, a pre-existing `--err*` gap now deferred.
  - `[low]` `[patch]` Several 1.4.11 claims in the new prose read as app-wide while measuring only the dark block, and the light-block tripwire's comment framed a legitimate future light `--err-fill` as an accident. Added dark-theme qualifiers to the `ConfirmRun` docblock and the rim test, tightened the `brightness()` docblock (it models one color, not the whole element), and reworded the tripwire as "update this deliberately" rather than "someone forked it".

## Design Notes

Why a new token rather than darkening `--err` (the decision's first-listed option): `--err` is consumed in two opposite directions. Darkening it to reach 4.5:1 for white-on-fill requires relative luminance ≤0.1833, which drops `text-err` on `--background` from 6.11:1 to ≈4.13:1 — under AA for the 11–12px error messages in `SchemaTree`, `ProvidersPanel`, `ChatTabView`, `QueryTabView`, and `TabContent`. Splitting the fill out is the only variant of "darken the fill" that does not trade one AA failure for several.

Colour derivation — `#ef6a63` is `hsl(3, 81%, 66%)`; `#be342d` is `hsl(3, 62%, 46%)`: same hue, lower lightness **and** lower saturation (the saturation drop is a real second axis, not an approximation), taken down until white clears AA with headroom for the hover state:

```
#ef6a63  white 3.04:1   hover(1.10) 2.62:1   <- today, fails
#be342d  white 5.65:1   hover(1.10) 4.84:1   <- chosen
```

Lighter candidates were rejected on the hover state: `#d23b45` (the prototype's own light-theme `--err`) is 4.72:1 at rest but only 3.99:1 under `hover:brightness-110`, so hovering the button would drop it back below AA.

**Why the lighter `--err` rim stays.** The first implementation pass moved the border to `--err-fill` alongside the fill, which deleted the buttons' only WCAG 1.4.11 boundary signal. Measured against the surfaces the buttons actually sit on — not `--background`, where neither one lives:

```
                                      vs --muted   vs --card    vs --background
  --err-fill #be342d (the fill)          2.74         3.08          3.29   <- fill alone FAILS on muted
  --err      #ef6a63 (the rim)           5.10         5.72          6.11   <- rim clears 3:1 everywhere
  --err-line rgba(239,106,99,.40)        1.88         1.93            —    <- too faint to be a boundary
```

`ConfirmRun`'s Confirm sits in a `bg-[var(--muted)]` footer (`ConfirmRun.tsx:67`); the settings `yes` sits on a `bg-card` row (`SettingsPanel.tsx:169`). So the shipping shape is an `--err` rim over an `--err-fill` body: the label clears 4.5:1 and the boundary clears 3:1, which neither "all `--err`" (label 3.04) nor "all `--err-fill`" (boundary 2.74) achieves alone. As a bonus the rim keeps a visual tie to the rest of the `--err` family.

Note the intent-contract's I/O matrix says "Fill + border are `var(--err-fill)`" while its Approach paragraph says to "repoint only the two white-on-red *fills*". The measurements resolve that internal inconsistency in favour of the Approach line; the matrix row's border clause is superseded and is not re-derivable as intent.

`--err-fill` is **not** dark-only, despite living beside the dark-only `--err*` group: it is declared once in `:root` with no `:root[data-theme="light"]` override, so it renders in both themes. White on it clears AA against the light surfaces too, so a light override would add risk without adding value — but the comment must not misdescribe it.

## Verification

**Commands:**
- `export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit` -- expected: exits 0, no diagnostics.
- `export PATH="$HOME/.bun/bin:$PATH" && bun test src/ui/styles/contrast.test.ts` -- expected: all pass, including the whole new DW-58 describe.
- `export PATH="$HOME/.bun/bin:$PATH" && bun test` -- expected: full suite green, 0 fail (baseline at HEAD 79e1c0e is 1926 pass / 1 skip / 0 fail; the change adds 8 tests -> 1934).
- `git grep -nE 'bg-err([^-a-zA-Z0-9/]|$)' -- src ':!src/core/ui-bundle.generated.ts'` -- expected: only the three text-free status dots (`App.tsx:193`, `App.tsx:233`, `SchemaTree.tsx:189`). Note plain `bg-err\b` is the WRONG pattern — `\b` treats `-` as a boundary, so it also matches `bg-err-soft` / `bg-err-fill`.
- `git grep -n -- 'bg-\[var(--err)\]' -- src ':!src/core/ui-bundle.generated.ts'` -- expected: no hits.
- `git grep -n -- 'border-\[var(--err)\]\|border-err\b' -- src ':!src/core/ui-bundle.generated.ts'` -- expected: the two destructive buttons KEEP an `--err` rim (`ConfirmRun.tsx`, `SettingsPanel.tsx`); no `border-err-fill` anywhere.
- `git diff -U0 -- src/ui/styles/globals.css | grep -E '^[-+]\s+--(err|warn)'` -- expected: exactly one line, `+  --err-fill: #be342d;`. Any `-` line means a protected token was altered.

## Auto Run Result

Status: done

### Implemented change

`--err` (`#ef6a63`) was doing two incompatible jobs: a text/icon colour on dark surfaces (fine, 5.10–6.11:1) and a solid fill under a white label (3.04:1, below WCAG AA). Darkening it would have fixed the fills and dragged every error message under AA. DW-58 splits the fill out into a new `--err-fill: #be342d` — same hue, lower lightness and saturation (`hsl(3,81%,66%)` → `hsl(3,62%,46%)`) — and repoints only the two white-on-red fills at it. `--err`, `--err-soft`, `--err-line` and `--warn*` are byte-identical, so every text, tint, dot and left-border consumer looks exactly as before.

Both buttons keep a solid `--err` rim. That rim is load-bearing: it is the WCAG 1.4.11 boundary against the surface each button sits on (5.10:1 on the `--muted` confirm footer, 5.72:1 on the `--card` settings row), where the darker fill alone would be 2.74:1. The shipping shape — light rim, dark body, white label — is the only one that clears both 1.4.3 (label 5.65:1) and 1.4.11 (boundary ≥3:1); neither "all `--err`" nor "all `--err-fill`" does.

### Files changed

- `src/ui/styles/globals.css` — added `--err-fill: #be342d` inside the contiguous `--err*` run with its full derivation and measurements, plus the `--color-err-fill: var(--err-fill)` alias in `@theme inline` so the bare `bg-err-fill` utility resolves. Light block untouched.
- `src/ui/workspace/ConfirmRun.tsx` — Confirm button fill only: `bg-[var(--err)]` → `bg-[var(--err-fill)]`, rim kept. Header docblock rewritten to describe the rim/body split accurately.
- `src/ui/settings/SettingsPanel.tsx` — remove-confirm `yes` button: `border-err-line bg-err` → `border-err bg-err-fill`. The 40%-alpha `--err-line` composites to 1.93:1 on `--card` and could not serve as the boundary; solid `--err` gives 5.72:1.
- `src/ui/workspace/ConfirmRun.test.tsx` — repointed the fill assertion, added a positive rim assertion, and added a two-spelling / two-order negative guard against ever re-pairing an `--err` fill with a white label.
- `src/ui/styles/contrast.test.ts` — new top-level DW-58 describe (8 tests): a `brightness()` unit test, `--err` pinned as AA text, white-on-fill at rest, white-on-fill under `brightness(1.10)`, the settings `opacity-90` composite, the rim's 1.4.11 boundary at rest and hovered against `--muted`/`--card`, the `--color-err-fill` alias mapping, and a light-block tripwire.

### Review findings

Two full adversarial + edge-case passes.

- **Pass 1** — 12 bad_spec (1 high, 1 medium, 10 low) triggered one loopback: the spec had dictated the 1.4.11 assertion against `--background`, a surface neither button sits on and the only one the fill passes, and had instructed dropping the lighter rim. Code was reverted, the spec amended (Code Map, Tasks, Design Notes, Verification), and the implementation re-derived. 3 deferred, 6 rejected.
- **Pass 2** — 0 intent_gap, 0 bad_spec. 5 patches applied (detailed in the Review Triage Log), 8 deferred, 5 rejected.

Rejected across both passes: disabled-state contrast (`disabled:opacity-40/50` measure 2.69:1 / 3.25:1, but WCAG explicitly exempts inactive controls); presence-filtering the dark-only token list (theme-name keying fails loudly if dark loses `--err`, presence-filtering would fail silently); the prototype's `brightness(1.08)` vs the port's `1.10` (a deliberate Story 7.3 choice, and the test matches the code); `transition-colors` not animating `opacity` on the settings button (pre-existing, untouched); `button.tsx`'s `destructive` variant (soft tint with red text, not white-on-red).

### Deferred findings — for the orchestrator to ledger

The invocation forbade editing the deferred-work ledger, so these are recorded here instead of appended to `deferred-work.md`.

1. `[medium]` `src/ui/data/DataGrid.tsx:510` — the delete-confirm `yes` button is a structural twin of the one fixed here but still on hardcoded `bg-red-600` / `border-red-700`. Its white label is 4.77:1 at rest and 4.53:1 under `hover:opacity-90`, and its rim is **2.89:1** against `--background`, failing 1.4.11 — the exact defect DW-58 fixed on the settings rim.
2. `[medium]` `src/ui/workspace/Workspace.tsx:212` (`ExposureBanner`) — a third white-on-red surface on `bg-red-600` / `border-red-700` (4.77:1). DW-58 created the canonical destructive-fill token and adopted it in two of the four places it belongs; `red-*` literals remain the de-facto destructive fill elsewhere.
3. `[medium]` Light-theme `--err*` palette — `--err` has no `:root[data-theme="light"]` override, so in light it is 2.84:1 as text on `--card` (below AA) and 2.64:1 as a rim on `--muted` (below 1.4.11). This affects error text in `App.tsx`, `QueryTabView.tsx:452`, `ChatTabView.tsx:436,1002` and `ProvidersPanel.tsx`. Not reachable today — nothing in `src/` outside `styles/` sets `data-theme` — but it blocks any future light-theme pass.
4. `[medium]` `text-err` over the `--err-soft` tint — the real error surfaces composite `--err` over `rgba(239,106,99,0.14)`, giving 4.76:1 on `--card` and **4.19:1 on `--muted`**, thinner than the 5.10 bare-surface floor the AA lock advertises. `contrast.ts`'s `parseCssColor` rejects `rgba()`, so the lock cannot express this pair without a compositing helper.
5. `[low]` `src/ui/settings/SettingsPanel.tsx` has no test file at all. Its `bg-err-fill` / `border-err` pair is unguarded at the component level — reverting it leaves the whole DW-58 suite green, since every contrast assertion measures tokens rather than markup.
6. `[low]` No `--err-ink` companion. `globals.css` pairs every other filled accent with an explicit foreground (`--coral`/`--coral-ink`, `--rpt-accent`/`--rpt-accent-ink`), but the destructive fill hardcodes `text-white` in both components, so the on-fill foreground is the one part of the pair that cannot be retuned per theme.
7. `[low]` Tailwind's content scanner reads `_bmad-output/**/*.md`, so utility names quoted in spec prose leak into the shipped stylesheet — `.border-err-fill` is emitted despite nothing in `src/` using it. Pre-existing scanner-scope problem, widened by any spec that quotes class names.
8. `[low]` `design-artifacts/confirm-destructive.html:821` still carries `.dx-btn-danger { background: var(--err); color: #fff }`, the exact 3.04:1 pairing this change removes, while `ConfirmRun.tsx` still cites that file as its source of truth. The next port reintroduces the bug. Editing it was explicitly out of scope.

### Verification performed

- `bunx tsc --noEmit` — exit 0, no diagnostics.
- `bun test` — **1934 pass / 1 skip / 0 fail**, 88 files, 10323 expect() calls. Baseline at `79e1c0e` is 1926 pass / 1 skip / 0 fail (confirmed by stashing), so the change is baseline + 8 new tests with nothing lost.
- `git grep 'bg-\[var(--err)\]'` — no hits. `git grep -E 'bg-err([^-a-zA-Z0-9/]|$)'` — only the three text-free status dots (`App.tsx:193`, `App.tsx:233`, `SchemaTree.tsx:189`).
- Both buttons verified to keep an `--err` rim; no `border-err-fill` anywhere.
- `git diff -U0 -- globals.css | grep -E '^[-+]\s+--(err|warn)'` — exactly one line, `+ --err-fill: #be342d;`, no removals, so no protected token was altered.
- **Mutation-tested the two new guards**: dropping the rim (`border-[var(--err)]` → `border-[var(--err-fill)]`) fails the suite, and reintroducing a bare `bg-err` fill under `text-white` fails the suite. Neither guard is vacuous.
- All contrast figures recomputed independently against the real token values, not taken from the implementation's report.

### Residual risks

- **Presentational verification is static-markup only.** The repo convention is `renderToStaticMarkup` with no jsdom, so nothing renders the actual CSS cascade. The contrast tests prove the token values are correct and the markup tests prove the right classes are emitted, but no test proves the browser composites them as measured. The `hover:` and `disabled:` states in particular are modelled arithmetically, not observed.
- **`disabled:opacity-40` is the default state of the escalated path.** On type-to-confirm, `ConfirmRun` holds the Confirm button disabled (2.69:1 label) for as long as the user is typing the object name. WCAG exempts disabled controls so this is not a violation, and it is unchanged from before DW-58 — but it is the most-seen state of the most dangerous flow, and it is not measured.
- **Deferred item 1 is the sharpest.** `DataGrid.tsx:510` ships a destructive button whose rim fails 1.4.11 today. This change fixed its twin and left it, which is a defensible scope call but leaves the codebase internally inconsistent about what a destructive button looks like.
