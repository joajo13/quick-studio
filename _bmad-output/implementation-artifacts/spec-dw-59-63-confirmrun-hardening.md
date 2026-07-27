---
title: 'ConfirmRun modality + dormant-prop hardening (DW-59..DW-63)'
type: 'bugfix'
created: '2026-07-27'
status: 'done'
baseline_revision: 'ef970d3ea3a8e64f95ee863e3dcb591659d7c542'
final_revision: 'fbb7d67a4b5c647a04fcf4b973f1de3be25e325c'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** `ConfirmRun` declares `role="alertdialog"` + `aria-modal="true"` but enforces no modality (no focus trap, no scrim-click dismiss, background stays tabbable — DW-59), renders its `fixed inset-0` scrim in-tree so a future `transform`/`filter` ancestor would mis-anchor it (DW-60), and carries three boundary bugs on its dormant escalated props: the `affectedRows` badge paints red for `0`/negative/`NaN` (DW-61), the `objectName` type-to-confirm gate mounts for `""` and trims only the typed side (DW-62), and its input stays editable while `busy` (DW-63).

**Approach:** One focused pass on `src/ui/workspace/ConfirmRun.tsx`. Introduce a local hook-owning `ModalOverlay` wrapper that renders the scrim, portals to `document.body` when a DOM exists, traps Tab focus, marks sibling body children `inert`, restores focus on unmount, and dismisses on scrim press. `ConfirmRun` itself stays hook-free and passes the card as `children`, so the existing direct-invocation tree-walk tests keep working. Extract the three dormant-prop rules into pure, DOM-free helpers and unit-test them directly.

## Boundaries & Constraints

**Always:**
- `ConfirmRun` itself stays **hook-free**: the existing tests call `ConfirmRun({...})` directly (no renderer, no hook dispatcher). All hooks live in the nested `ModalOverlay` / `TypeToConfirmSection` components.
- The card (and therefore both footer `<button>`s) must remain reachable from the returned tree via `element.props.children` recursion, so `findButton` in `ConfirmRun.test.tsx` still finds `aria-label="Confirm"` / `"Cancel"`.
- The portal is **guarded**: `typeof document === "undefined"` → render the scrim in-tree. `renderToStaticMarkup` (bun test, no jsdom) must keep emitting the same scrim + card markup it emits today.
- All five behaviors stay **UX-only**. The Core guarded executor remains the sole authorizer; nothing added here may become a gate.
- Preserve verbatim: `autoFocus` on Cancel, card-level Esc-cancels-when-`!busy`, no top color line, `border-[var(--err)]` + `bg-[var(--err-fill)]` on the Confirm button, `--err` spent only on the danger icon / statement left border / affected badge / Confirm rim, `z-[60]` on the scrim.
- Every added effect pairs its setup with a cleanup `return () => ...`, following `src/ui/App.tsx:616` and `src/ui/sandbox/SandboxFrame.tsx:180`.
- All three callers keep passing exactly `{sql, risk, busy, onConfirm, onCancel}` — no new required prop, no caller edits.

**Block If:**
- The portal cannot be made SSR-safe without changing `renderToStaticMarkup` output (would break every existing structural assertion).

**Never:**
- Do not adopt `@radix-ui/react-dialog` / any modal framework (repo decision: "no modal framework").
- Do not touch `--err`, `--err-soft`, `--err-fill`, `--err-line`, `--warn*` token values, `src/ui/styles/contrast.test.ts`, or the three caller files.
- Do not move `autoFocus` to Confirm, do not "fix" `disabled:opacity-40`, do not add a global `document`-level key listener (keep handlers on the overlay/card elements).
- Do not add SQL parsing, locale/number formatting, or animation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No DOM (bun test / SSR) | `typeof document === "undefined"` | Scrim + card render in-tree, identical markup to today; no portal, no effects | No error expected |
| Browser render | `document` present | Scrim + card rendered via `createPortal` into `document.body` | No error expected |
| Scrim press | mousedown whose `target === currentTarget`, `busy === false` | `onCancel()` fires once | No error expected |
| Scrim press while busy | same, `busy === true` | Nothing fires (matches Esc/Cancel being inert mid-round-trip) | No error expected |
| Press inside the card | mousedown on card/pre/button | No dismiss (event target is a descendant) | No error expected |
| Tab at last focusable | Tab, focus on last enabled control | Wraps to the first; `preventDefault` | No error expected |
| Shift+Tab at first focusable | Shift+Tab, focus on first | Wraps to the last; `preventDefault` | No error expected |
| Tab with zero focusables | `busy === true` (all controls disabled) | `preventDefault`, focus stays inside | No error expected |
| `affectedRows` valid | `142` | Red badge, `"142"` + `"rows"` | No error expected |
| `affectedRows` singular | `1` | Red badge, `"1"` + `"row"` | No error expected |
| `affectedRows` zero | `0` | Badge renders **neutral** (`--muted` / `--muted-foreground`), reads `"No rows"` — never a red destruction badge | No error expected |
| `affectedRows` nonsense | `NaN`, `Infinity`, `-5`, `2.5` | No badge at all | Silently dropped (bad upstream data must not paint a destruction claim) |
| `objectName` blank | `""` or `"   "` | Type-to-confirm does NOT mount; plain footer renders | No error expected |
| `objectName` padded | `"  public.orders  "`, user types `"public.orders"` | Match (both sides trimmed); the `<code>` hint shows the trimmed name | No error expected |
| Type-to-confirm while busy | `objectName` supplied, `busy === true` | Input is `disabled`, Confirm and Cancel disabled (3 disabled controls) | No error expected |

</intent-contract>

## Code Map

- `src/ui/workspace/ConfirmRun.tsx` -- the only file changed: scrim root (`fixed inset-0 z-[60]`, line 157), `alertdialog` card + Esc handler (158-169), `affectedRows` badge (199-207), `TypeToConfirmSection` (104-144), footer dispatch (231-233).
- `src/ui/workspace/ConfirmRun.test.tsx` -- existing suite (`renderToStaticMarkup` + direct-invocation `findButton` walk); extended, never weakened.
- `src/ui/workspace/QueryTabView.tsx:441`, `src/ui/workspace/ChatTabView.tsx:432`, `src/ui/report/ReportTabView.tsx:723` -- the three callers; read-only, must not need edits.
- `src/ui/App.tsx:616`, `src/ui/sandbox/SandboxFrame.tsx:180` -- precedent for `useEffect` + cleanup listener pattern.
- `src/ui/styles/contrast.test.ts` -- DW-58 contrast locks; read-only regression guard.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/workspace/ConfirmRun.tsx` -- add exported pure helpers `affectedRowsBadge(value?: number): { count: string; noun: string; destructive: boolean } | null`, `typeToConfirmTarget(objectName?: string): string | null`, `typeToConfirmMatches(typed: string, target: string): boolean`, `nextTrapIndex(count: number, current: number, backwards: boolean): number` -- DOM-free rules so DW-61/62 and the trap math are unit-testable without jsdom.
- [x] `src/ui/workspace/ConfirmRun.tsx` -- add nested `ModalOverlay({ busy, onDismiss, children })`: `useRef` on the scrim div; `useEffect` capturing `document.activeElement` and restoring it on unmount; `useEffect` setting/removing the `inert` **attribute** (via `setAttribute`/`removeAttribute`, not the typed prop) on every `document.body` child except the overlay node, restoring prior state on cleanup; `onKeyDown` Tab/Shift+Tab trap over the scrim's focusable descendants using `nextTrapIndex`; `onMouseDown` dismiss when `e.target === e.currentTarget && !busy`; returns `typeof document === "undefined" ? scrim : createPortal(scrim, document.body)` -- DW-59 + DW-60.
- [x] `src/ui/workspace/ConfirmRun.tsx` -- rewrite `ConfirmRun`'s return as `<ModalOverlay busy={busy} onDismiss={onCancel}>{card}</ModalOverlay>` keeping the card tree byte-equivalent in classes/ids/handlers, so it stays hook-free and `findButton` still recurses into `props.children`.
- [x] `src/ui/workspace/ConfirmRun.tsx` -- render the badge from `affectedRowsBadge(...)`: `null` → nothing; `destructive: false` (the `0` case) → `bg-[var(--muted)] text-[var(--muted-foreground)]`; otherwise the existing `--err-soft`/`--err` badge -- DW-61.
- [x] `src/ui/workspace/ConfirmRun.tsx` -- gate the footer on `typeToConfirmTarget(objectName)`, pass the trimmed target into `TypeToConfirmSection` (used for both the `<code>` hint and the comparison via `typeToConfirmMatches`), and add `disabled={busy}` + `disabled:cursor-not-allowed disabled:opacity-40` to its `<input>` -- DW-62 + DW-63.
- [x] `src/ui/workspace/ConfirmRun.tsx` -- update the module docblock: modality is now enforced, the render path is a guarded portal, and the three dormant props are guarded; note `ModalOverlay` is extractable if a second modal ever ships.
- [x] `src/ui/workspace/ConfirmRun.test.tsx` -- add DOM-free unit tests for all four helpers covering every I/O Matrix row, plus static-markup tests (scrim still emitted under SSR; `0` badge is neutral and carries no `--err`; nonsense values emit no `confirm-run-affected`; blank/whitespace `objectName` emits no `confirm-run-ttc`; `objectName` + `busy` yields 3 `disabled=""`), plus a tree-walk test that the scrim's `onMouseDown` fires `onCancel` only when the event target is the scrim itself and `!busy`.

**Acceptance Criteria:**
- Given the existing `ConfirmRun.test.tsx` and `contrast.test.ts` suites, when `bun test` runs, then every previously passing assertion still passes unmodified.
- Given a keyboard user with the dialog open in a browser, when they Tab past the last control, then focus returns to the first control inside the dialog and never reaches page content behind the scrim.
- Given the dialog unmounts, when the caller clears its confirm state, then focus returns to the element that held it before the dialog opened and every `inert` attribute the overlay set is removed.
- Given any ancestor of a caller later gains `transform`/`filter`/`will-change`/`contain`, when the dialog opens in a browser, then it still covers the viewport because it is portalled to `document.body`.
- Given `bunx tsc --noEmit`, when it runs against the changed files, then it reports no errors under `strict` + `noUncheckedIndexedAccess`.

## Spec Change Log

## Review Triage Log

### 2026-07-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 2, low 8)
- defer: 5: (high 0, medium 1, low 4)
- reject: 14: (high 0, medium 2, low 12)
- addressed_findings:
  - `[medium]` `[patch]` Focus-restore was dead on arrival: React runs a component's effect cleanups in hook-declaration order, so the restore ran while `#root` (the app's ONLY `document.body` child) still carried `inert`, and `focus()` inside an inert subtree is a spec no-op — reordered so the `inert` effect is declared first and its cleanup runs before the restore.
  - `[medium]` `[patch]` `StrictMode` (active in `src/ui/main.tsx`) simulates unmount+remount, firing the restore cleanup while the dialog is still on screen and yanking focus back to the background trigger in dev — the restore now bails when `scrimRef.current` is still connected (React only detaches host refs on a real unmount).
  - `[low]` `[patch]` Two simultaneous overlays would mark each other `inert`, killing both dialogs — the scrim now carries `data-modal-overlay` and the inert sweep skips nodes bearing it.
  - `[low]` `[patch]` `isScrimDismiss` returned `true` for a targetless event (`null === null`), which would cancel a pending destructive confirmation — added a `currentTarget !== null` guard.
  - `[low]` `[patch]` `Number.isInteger` admitted counts past 2^53, where `String(value)` renders `"1e+21 rows"` — switched to `Number.isSafeInteger`.
  - `[low]` `[patch]` The neutral-badge regression guard matched `data-testid` only as the FIRST attribute, so reordering the JSX props would empty the match and every `not.toContain` would pass vacuously — the regex now matches anywhere in the open tag and the match is asserted present.
  - `[low]` `[patch]` The DW-63 test asserted a `disabled=""` COUNT of 3, which stays green if `disabled` migrates off the input onto any other control — it now asserts the `confirm-run-ttc` input tag itself carries `disabled`.
  - `[low]` `[patch]` Docblock over-claimed: `inert` is a mount-time snapshot (not "while open"), the markup is not "byte-identical" in the browser (it is reparented), and callers were not told `onCancel` can now fire from a stray scrim press — all three corrected.
  - `[low]` `[patch]` `react-dom` was imported before `react`, against the repo's framework-first order — reordered.
  - `[low]` `[patch]` The card's JSX children kept their old 8-space depth after the `ModalOverlay` refactor while the opening tag moved to 4 — reindented (no formatter is configured in this repo, so nothing would have fixed it later).

### 2026-07-27 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 2: (high 0, medium 1, low 1)
- reject: 18: (high 0, medium 2, low 16)
- addressed_findings:
  - `[medium]` `[patch]` The previous pass's `StrictMode` focus-restore guard rested on a premise that is FALSE in React 19: `doubleInvokeEffectsOnFiber` runs `disappearLayoutEffects` — which calls `safelyDetachRef` on every host fiber — BEFORE `disconnectPassiveEffect`, so `scrimRef.current` is already `null` on the simulated pass too and the `isConnected` guard never fires (verified in `node_modules/react-dom/cjs/react-dom-client.development.js:18697` and `:15196-15198`). Every dev mount therefore restored focus to the background trigger, which `reconnectPassiveEffects` then re-inerted, leaving focus on `<body>` with Esc and the Tab trap both dead. Replaced the ref-identity guard with a `setTimeout(…, 0)` restore that the re-running effect cancels — React re-runs it synchronously inside the same double-invoke, a real unmount has nothing to cancel it — which also removes the restore's dependence on cleanup ORDER relative to the `inert` sweep.
  - `[low]` `[patch]` `handleMouseDown` inspected no `MouseEvent.button`, so right-clicking the scrim to open the browser context menu (or a middle-click) cancelled a pending destructive confirmation — `isScrimDismiss` now requires the primary button, with the button taken into the pure predicate so it stays unit-testable.
  - `[low]` `[patch]` The focus restore passed no `{ preventScroll: true }`, so dismissing the dialog could jump the viewport to the restored element.
  - `[low]` `[patch]` `typeToConfirmMatches("", "  ")` returned `true` — an exported friction predicate that satisfies itself for a blank target. Unreachable through `ConfirmRun` (the gate only mounts for a non-blank `typeToConfirmTarget`), but wrong for any future direct caller; a blank target now never matches.
  - `[low]` `[patch]` `affectedRowsBadge` kept `!Number.isFinite(value) ||` directly under a comment stating that `isSafeInteger` subsumes it — dead predicate removed, comment made accurate.
  - `[low]` `[patch]` Two more docblock over-claims: the SSR path is not "byte-identical to the pre-DW-59 tree" (the scrim now serializes `data-modal-overlay=""` — corrected to same-shape), and `ModalOverlay` is not "generic over its `children`" in any type sense. Also recorded what the modality contract deliberately does NOT cover (background scrolling), so the docblock stops reading as complete.

## Design Notes

**Why a `children`-taking wrapper and not hooks in `ConfirmRun`.** `ConfirmRun.test.tsx` calls `ConfirmRun({...})` as a plain function to walk the real element tree — any hook in `ConfirmRun` itself throws there (no dispatcher). Wrapping as `<ModalOverlay>{card}</ModalOverlay>` keeps `ConfirmRun` a pure function, and because `findButton` recurses through `element.props.children`, the card (with both buttons inlined) is still reachable. A nested component that *rendered* the card instead would hide the buttons from the walker — the DW-64 failure mode. Direct invocation also never executes `ModalOverlay`'s body, so no hook runs in that path.

**Why the portal needs the `typeof document` guard.** `createPortal` has no meaning under `renderToStaticMarkup`, which is the entire structural-test harness here (no jsdom, by repo convention). The guard makes the DOM-free path render exactly today's tree, so all string assertions survive; the browser path gets the durable `document.body` anchor DW-60 asks for.

**Why `0` renders neutral instead of not rendering.** DW-61's guard is `Number.isFinite && >= 0`, so `0` is a *valid* count — but its reason calls out that a red "0 rows" badge is a misleading destruction claim. Rendering `0` in muted tokens honours both: the count is shown truthfully, the alarm is not. Non-integers are dropped alongside NaN/negatives because a fractional row count is never meaningful.

**Focus trap shape.** `nextTrapIndex` is the pure part (wrap-around index math over a focusable count); the effectful part is a `querySelectorAll` over the scrim ref for `a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])`. When `busy` disables every control the list is empty — Tab is simply `preventDefault`ed, and the `inert` siblings keep the background unreachable regardless. `inert` is set as a raw attribute so no `lib.dom` typing assumption is needed, and unsupported engines degrade to the Tab trap alone.

## Verification

**Commands:**
- `bun test src/ui/workspace/ConfirmRun.test.tsx` -- expected: all tests pass, including every pre-existing assertion unchanged.
- `bun test` -- expected: full suite green, no new failures (baseline: 0 failing).
- `bunx tsc --noEmit` -- expected: no errors.
- `rg -n 'amber-|red-[0-9]' src/ui/workspace/ConfirmRun.tsx` -- expected: no matches.
- `rg -n '<ConfirmRun' src/ --glob '!*.test.tsx'` -- expected: the same three call sites, none changed.

## Auto Run Result

Status: done

### Summary

`ConfirmRun` is now an actually-modal dialog and its three dormant escalated props are guarded. All five ledger entries (DW-59..DW-63) are resolved in one pass on `src/ui/workspace/ConfirmRun.tsx`, with no caller edits and no token changes.

### Implemented change

- **DW-59** — a nested `ModalOverlay` owns the scrim and enforces the declared `aria-modal`: a Tab/Shift+Tab focus trap over the scrim's focusable descendants, `inert` on every other `document.body` child (so the background is untabbable and unreachable to a screen reader), focus restored to the pre-dialog owner on unmount, and scrim-press dismiss gated on `!busy`.
- **DW-60** — the scrim renders via `createPortal(scrim, document.body)`, guarded by `typeof document === "undefined"` so the DOM-free test harness still gets the in-tree tree.
- **DW-61** — `affectedRowsBadge` drops `NaN`/`±Infinity`/negative/fractional/past-2^53 counts entirely and renders `0` as a NEUTRAL "No rows" badge instead of a red destruction claim.
- **DW-62** — `typeToConfirmTarget` refuses to mount the gate for a blank or whitespace-only `objectName`, and `typeToConfirmMatches` trims BOTH sides so a padded name is matchable.
- **DW-63** — the type-to-confirm `<input>` carries `disabled={busy}` with the footer's disabled styling.

`ConfirmRun` stays hook-free (it passes the card to `ModalOverlay` as `children`), so the existing direct-invocation tree-walk tests keep reaching both footer buttons.

### Files changed

- `src/ui/workspace/ConfirmRun.tsx` — `ModalOverlay` (portal + trap + inert + deferred focus restore + primary-button scrim dismiss), five exported DOM-free helpers (`affectedRowsBadge`, `typeToConfirmTarget`, `typeToConfirmMatches`, `nextTrapIndex`, `isScrimDismiss`), badge/footer wiring, `disabled={busy}` on the input, docblock.
- `src/ui/workspace/ConfirmRun.test.tsx` — 24 new tests: every pure helper across every I/O-matrix row, the SSR-guard branch, the neutral-`0` badge, nonsense counts, blank `objectName`, the DW-63 disabled input (asserted by identity), the `ModalOverlay` wiring walk, and (pass 2) the non-primary-button and blank-target predicate cases.

### Review findings breakdown

**Pass 1** (implementation review): patches applied 10 (2 medium, 8 low); deferred 5; rejected 14.

**Pass 2** (independent follow-up review): patches applied 6 (1 medium, 5 low); deferred 2 (ledgered as DW-105, DW-106); rejected 18.

The medium patch in pass 2 corrected a pass-1 patch that was built on a false premise about React 19's `StrictMode` double-invoke — see the triage log. Pass-2 rejects were dominated by findings the frozen intent contract explicitly decides against ("adopt `@radix-ui/react-dialog`" — a `Never`; "blank `objectName` should fail closed" and "don't trim the displayed target" — both the prescribed I/O-matrix behavior for DW-62; "format large counts with `toLocaleString`" — locale formatting is a `Never`; "surface corrupt `affectedRows` instead of dropping it silently" — the matrix says silently dropped), plus four restatements of findings pass 1 had already deferred and several unreachable-by-construction cases (`nextTrapIndex` with a stale index, `document.body` null).

### Deferred findings — pass 2 (appended to the ledger as DW-105, DW-106)

- summary: `ModalOverlay` enforces focus and pointer containment but not SCROLL containment — `inert` does not block the wheel/trackpad, so the app scrolls freely behind the `aria-modal` scrim.
  evidence: DW-59 scoped the gap as focus trap + scrim dismiss + untabbable background, all three now closed; scroll lock was never named. Not patched because `body { overflow: hidden }` reflows the whole app when the scrollbar disappears (a scrollbar-gutter decision, not a `ConfirmRun` detail), and it is the third containment finding that belongs to a shared-modal policy. The docblock now states the omission rather than letting the contract read as complete.
- summary: `dependents` is the one dormant prop left unguarded while `affectedRows` and `objectName` were hardened — blank endpoints paint an empty `→ FK →` row and the list is uncapped inside a 480px card.
  evidence: Genuinely dormant (no Core source), which is why DW-61/62/63 were themselves deferred before being bundled. Unlike those two the fix is not mechanical: it needs a display policy (drop blanks? cap with "+N more"? scroll?) that only makes sense against the shape of the data the supplying story ships.

### Deferred findings — pass 1 (still unledgered; the orchestrator owns these)

- summary: When `busy` disables every control, or when a user clicks a non-focusable region of the dialog (the `<pre>`, the risk text), focus falls to `<body>` and the card-level Esc handler stops firing until focus returns to the dialog.
  evidence: Browsers blur a focused element when it becomes `disabled`; the Esc handler lives on the card and React handlers only fire for events originating in their subtree. Tab still recovers (the background is `inert`, so the only focusable controls are the dialog's), so this is a friction gap, not a dead end. The durable fix is a focus-containment policy (`tabIndex={-1}` on the card plus re-focusing it when the focusable set empties), which is a shared-modal decision rather than a `ConfirmRun` detail.
- summary: The `inert` background sweep is a mount-time snapshot of `document.body.children`, so a portal container appended AFTER the dialog opens (Radix popover/select/dropdown, `cmdk`) is never marked inert.
  evidence: `Array.from(document.body.children)` runs once in a `[]`-dep effect. Practically unreachable today because the background is inert and cannot be driven to mount a new portal, but a background async path could. Fix is a `MutationObserver` on `document.body`, deliberately not added for one dormant scenario.
- summary: Overlapping overlays have no refcount — the first to unmount removes `inert` from the background while another dialog is still open.
  evidence: Each instance snapshots `wasInert` independently; the second instance records `true` and leaves the attribute alone, so the first instance's cleanup wins. The mutual-inert deadlock was patched (`data-modal-overlay` skip); the refcount was not, because a module-level counter in a presentational component is a design decision for a shared-modal extraction.
- summary: The focus-trap selector admits `button`/`a` elements carrying `tabindex="-1"` and misses `[contenteditable]`, `iframe`, `audio[controls]`, `video[controls]`, `details > summary` and `area[href]`; it also does not filter hidden or zero-size controls.
  evidence: `FOCUSABLE_SELECTOR` only appends `:not([tabindex="-1"])` to the bare `[tabindex]` clause. Inert today — the dialog contains exactly two buttons and one optional input — but wrong the moment richer content lands, and a hidden control would become a black hole in the Tab cycle.
- summary: The SSR/browser branch is keyed on `typeof document`, so adding any DOM shim to `bun test` (a preload, `--dom`, or one other test file assigning `globalThis.document`) flips `ConfirmRun` onto the `createPortal` path and detonates the whole structural suite, not just the one env assertion.
  evidence: `renderToStaticMarkup` throws "Portals are not currently supported by the server renderer". `ConfirmRun.test.tsx` now asserts `typeof document === "undefined"` explicitly, so the failure is at least loud and self-explaining — but the guard is a process-global check, not a render-mode check.

### Verification

- `bun test src/ui/workspace/ConfirmRun.test.tsx` — 38 pass, 0 fail (12 before this story, 36 after pass 1, +2 in pass 2; every pre-existing assertion kept, none weakened).
- `bun test` — 1963 pass, 1 skip, 0 fail across 88 files.
- `bunx tsc --noEmit` — clean under `strict` + `noUncheckedIndexedAccess`.
- `rg -n 'amber-|red-[0-9]' src/ui/workspace/ConfirmRun.tsx` — no matches.
- `rg -n '<ConfirmRun' src/ --glob '!*.test.tsx'` — the same three call sites, none changed.
- `git diff --stat` — only `ConfirmRun.tsx` and `ConfirmRun.test.tsx`; the three callers and `src/ui/styles/contrast.test.ts` are untouched.
- Manual: the React 19 `StrictMode` claim behind the pass-2 medium patch was verified against the installed `node_modules/react-dom/cjs/react-dom-client.development.js` (`doubleInvokeEffectsOnFiber` at `:18697`, `disappearLayoutEffects` → `safelyDetachRef` at `:15196-15198`), not taken on the reviewer's word.

### Residual risks

- Everything `ModalOverlay` does at runtime (portal, trap, `inert`, focus restore) is structurally untestable in this repo's no-jsdom harness — the pure halves are unit-tested, the DOM orchestration is verified by reasoning about React's commit/cleanup order, not by a test. Both passes' medium findings lived in exactly that blind spot, and pass 2 showed a pass-1 patch there had been reasoned from a wrong premise. The new restore is scheduled-and-cancelled rather than ref-guarded, which is order-independent and therefore a weaker thing to get wrong, but it is still unverified by any executing test.
- Focus CONTAINMENT (as opposed to the Tab trap) remains open: `busy` disables every control and a click on the `<pre>` drops focus to `<body>`, from where Esc and the trap stop receiving keydown. Deferred in pass 1, restated by both reviewers in pass 2, and left alone deliberately — it needs the same shared-modal decision as DW-105.
- The dormant-prop guards (DW-61/62/63) are still dormant: no Core source supplies `affectedRows`, `dependents` or `objectName` today, so their behavior is proven only at the helper level. `dependents` has no guard at all (DW-106).
- Pre-existing DW-64 stands: `findButton` cannot walk into `TypeToConfirmSection`, so the escalated footer's callbacks have no behavioral test.
