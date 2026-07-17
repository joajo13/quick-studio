---
title: 'Workspace snapshot validation hardening (DW-23, DW-25, DW-28)'
type: 'bugfix'
created: '2026-07-17'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
baseline_revision: '28ddfd8e594982bc5596e0bb5e52a6e7c45e581b'
final_revision: 'ee148b58c1178de67dab99cf066a0f09da635010'
---

<intent-contract>

## Intent

**Problem:** The workspace-state load/validation seam trusts hand-edited/legacy/forward-version `workspace-state.json` too much: (DW-23) a malformed `panelSizes` (wrong length or out-of-range) survives load and flows into `react-resizable-panels` `defaultSize`, breaking the initial split; (DW-25) the registry validator accepts `activeTabId: null` with tabs present while `restoreWorkspace` silently rewrites it to the first tab, so two layers disagree on the same state; (DW-28) a newer-version file (e.g. `version: 2`) degrades to a *successful* null load, so an older build enables saving and overwrites the future build's state.

**Approach:** Sanitize `panelSizes` UI-side to the current panel count with each value clamped to `[0,100]` (keeping the persistence contract length-agnostic for future multi-panel layouts). Align the `activeTabId` contract in one place: the registry validator rejects null-with-tabs, and `restoreWorkspace` remains the single tolerant normalizer. Preserve a strictly-newer-version file by backing it up before the older build can overwrite it.

## Boundaries & Constraints

**Always:**
- `panelSizes` sanitization happens in the UI layer (`workspace-state.ts` / `App.tsx`); the store guard (`isWorkspaceSnapshot`) and registry (`checkPanelSizes`) keep accepting finite-number arrays of any length.
- The store load path stays total (never throws); the newer-version backup is best-effort and its failure must not break load.
- A newer-version file (`version` is a finite number `> WORKSPACE_SNAPSHOT_VERSION`) must still cause `load()` to return `null`, and its original bytes must survive on disk (as a sibling `.bak`).
- The registry validator and `restoreWorkspace` must agree: with tabs present, `activeTabId` must be one of the tab ids; with no tabs, it must be `null`.

**Block If:**
- Resolving DW-25 or DW-23 would require a `WORKSPACE_SNAPSHOT_VERSION` bump — HALT (version stays `1`; a bump is a separate design decision).

**Never:**
- Do not hard-code "exactly 2 panels" into the store or registry validation (that bakes in the current layout).
- Do not change the RPC/`LoadWorkspaceResult` contract or `App.tsx` save-gating types for DW-28 (backup keeps blast radius inside the store).
- Do not alter version-mismatch behavior for *older* (`< current`) or non-numeric versions — they keep degrading to `null` with no backup.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DW-23 valid split | `panelSizes: [25,75]`, 2 defaults | returns `[25,75]` | none |
| DW-23 wrong length | `[42]` or `[10,20,30]` | returns defaults `[20,80]` | none |
| DW-23 out of range | `[-5,105]` | clamped `[0,100]` (sums to 100 → used) | none |
| DW-23 clamp breaks sum | `[10,20]` (sums 30) | returns defaults `[20,80]` | none |
| DW-23 empty | `[]` | returns defaults `[20,80]` | none |
| DW-25 null + tabs | validate `{tabs:[t1,t2], activeTabId:null}` | `bad_request`, detail names `activeTabId` | rejected |
| DW-25 null + no tabs | validate `{tabs:[], activeTabId:null}` | `ok` | none |
| DW-25 restore null+tabs | `restoreWorkspace` given null+tabs (hand-edited) | `activeTabId` = `tabs[0].id` | normalized |
| DW-28 newer version | on-disk `version: 2` file | `load()` → `null` AND `<file>.v2.bak` holds the v2 bytes | backup best-effort |
| DW-28 older/corrupt | `version: 0` / bad shape | `load()` → `null`, no backup | none |

</intent-contract>

## Code Map

- `src/core/workspace-store.ts` -- `buildStore.load` (~187-210) degrades version mismatch to `null`; add best-effort backup of strictly-newer-version files (DW-28). `isWorkspaceSnapshot` stays shape-only/length-agnostic.
- `src/core/workspace-registry.ts` -- `validateSnapshotParams` (~181-223) `activeTabId` check; tighten so null-with-tabs is rejected (DW-25). `checkPanelSizes` unchanged.
- `src/ui/workspace/workspace-state.ts` -- add exported pure `sanitizePanelSizes(loaded, defaults)` (DW-23); `restoreWorkspace` `activeTabId` fallback (~251-253) stays as the single normalizer (DW-25).
- `src/ui/App.tsx` -- load effect `sizes` ternary (~438-441) replaced with `sanitizePanelSizes(snapshot.panelSizes, DEFAULT_PANEL_SIZES)` (DW-23).
- `src/shared/contract.ts` -- `WORKSPACE_SNAPSHOT_VERSION = 1` (read-only reference).
- Tests: `src/core/workspace-store.test.ts`, `src/core/workspace-registry.test.ts`, `src/ui/workspace/workspace-state.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/workspace/workspace-state.ts` -- add exported `sanitizePanelSizes(loaded: readonly number[], defaults: readonly number[]): number[]`: returns `[...defaults]` unless `loaded.length === defaults.length`; clamp each entry to `[0,100]` (non-finite → fall back to defaults); if the clamped values do not sum to ~100 (tolerance 0.5) return `[...defaults]`; else return the clamped values. -- gives a guaranteed-valid split from any load.
- [x] `src/ui/App.tsx` -- in the load effect, replace the `snapshot.panelSizes.length > 0 ? [...] : [...DEFAULT_PANEL_SIZES]` ternary with `snapshot ? sanitizePanelSizes(snapshot.panelSizes, DEFAULT_PANEL_SIZES) : [...DEFAULT_PANEL_SIZES]`; import the helper. -- routes every loaded split through the sanitizer.
- [x] `src/core/workspace-registry.ts` -- in `validateSnapshotParams`, change the `activeTabId` check to: if `tabs.value.length === 0` require `p.activeTabId === null` (else `bad_request`); otherwise require `typeof p.activeTabId === "number" && ids.has(p.activeTabId)` (else `bad_request`). Keep the returned `activeTabId ?? null`. -- validator now agrees with `restoreWorkspace`.
- [x] `src/core/workspace-store.ts` -- in `buildStore.load`, after a successful `JSON.parse` and before returning, if `parsed` is an object whose `version` is a finite number `> WORKSPACE_SNAPSHOT_VERSION`, best-effort write the raw file bytes to `${filePath}.v${version}.bak` with mode `0o600` (wrapped in try/catch that swallows errors), then continue to the existing `isWorkspaceSnapshot` guard (which returns `null`). -- preserves a future build's state.
- [x] `src/ui/workspace/workspace-state.test.ts` -- add `sanitizePanelSizes` cases from the I/O matrix (valid, wrong length, out-of-range clamp-to-100, clamp-breaks-sum, empty).
- [x] `src/core/workspace-registry.test.ts` -- flip the existing "activeTabId: null is always valid, even with tabs present" test to expect `bad_request`; keep the empty-tabs+null valid case; add a null-with-tabs rejection assertion naming `activeTabId`.
- [x] `src/core/workspace-store.test.ts` -- add a case: write a `version: 2` fixture, assert `load()` is `null` AND a `<file>.v2.bak` exists containing the original v2 JSON.

**Acceptance Criteria:**
- Given a hand-edited `panelSizes` of any invalid shape (wrong length, out-of-range that cannot form a 100-sum split, empty), when the workspace loads, then the panels mount with `DEFAULT_PANEL_SIZES` and no layout error.
- Given a snapshot with tabs present and `activeTabId: null`, when it is validated for save, then validation returns `bad_request` naming `activeTabId`; and when such a hand-edited file is restored, then `restoreWorkspace` sets `activeTabId` to the first tab.
- Given an on-disk `workspace-state.json` with `version` greater than `WORKSPACE_SNAPSHOT_VERSION`, when the store loads it, then `load()` returns `null` and the original file's bytes are preserved in a sibling `.bak`, so a subsequent save does not destroy them.

## Spec Change Log

_No bad_spec loopbacks — empty._

## Review Triage Log

### 2026-07-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 0
- reject: 16
- addressed_findings:
  - `[low]` `[patch]` DW-28 doc drift (workspace-store.ts): `load()` JSDoc/module prose described a pure, non-destructive read, but load now best-effort writes a sibling `.bak` for a newer-version file. Disclosed the side-effect in the load docstring.
  - `[low]` `[patch]` DW-25 coverage (workspace-registry.test.ts): added a test for the new empty-tabs + non-null `activeTabId` branch → `bad_request` "activeTabId must be null when there are no tabs".
  - `[low]` `[patch]` DW-28 coverage (workspace-store.test.ts): added negative `.bak` side-effect tests — a valid current-version file and a corrupt-JSON file produce NO sibling `.bak`.

_Rejected (deliberate spec decisions or false premises):_ sanitizer not enforcing per-panel min/max (verified: react-resizable-panels `validatePanelGroupLayout` only throws on wrong panel COUNT — which the length guard prevents — and clamps per-panel min/max gracefully, so no break); backup best-effort/write-and-forget/non-atomic/speculative/numeric-version-only (all deliberate DW-28 scope: "the invariant owed today is only that the newer bytes are not lost"); store shape-guard tolerating null-with-tabs on load (deliberate DW-25: `restoreWorkspace` is the single tolerant normalizer, validator is the strict write boundary); sum-tolerance/renormalization nits (library normalizes anyway); `.bak` recursive-load (false: store opens a fixed `workspace-state.json` path, no dir enumeration); duplicate-id Set (false: `checkTabs` already rejects duplicate ids upstream).

## Design Notes

DW-23 stays UI-side deliberately: the persistence contract must remain length-agnostic so a future multi-panel layout needs no version bump; only the UI knows it renders exactly 2 panels today. Clamping `[-5,105]`→`[0,100]` is fine because `react-resizable-panels` re-clamps `defaultSize` into each Panel's `min/maxSize` at mount; the sum-≈100 guard is what actually prevents the "Invalid layout" break.

DW-28 uses backup (not a new "version-too-new" signal through store→registry→rpc→App) to keep the change inside the store and avoid touching typed contracts in an unattended run — the invariant owed today is only "the newer bytes are not lost."

## Verification

**Commands:**
- `bun test src/core/workspace-store.test.ts src/core/workspace-registry.test.ts src/ui/workspace/workspace-state.test.ts` -- expected: all pass, including the new/flipped cases.
- `bun test` -- expected: full suite green (no regression from the validator tightening).
- `bunx tsc --noEmit` -- expected: no type errors (no `typecheck` script is configured; run manually).

## Auto Run Result

Status: done

**Implemented change:** Hardened the workspace-state load/validation seam against hand-edited / legacy / forward-version `workspace-state.json` files, resolving DW-23, DW-25, DW-28.

- **DW-23** — Added a UI-side `sanitizePanelSizes(loaded, defaults)` (pure/total) and routed the App load effect through it. The store/registry keep accepting finite-number arrays of any length (forward-compatible with future multi-panel layouts); the UI collapses any wrong-length, out-of-range, or non-100-summing split to `DEFAULT_PANEL_SIZES`. Verified against `react-resizable-panels` v3: its `validatePanelGroupLayout` only throws on wrong panel *count* (prevented by the length guard) and clamps per-panel min/max gracefully, so no broken layout can result.
- **DW-25** — Tightened the registry `validateSnapshotParams`: with no tabs, `activeTabId` must be `null`; with tabs present, it must be one of the tab ids (null-with-tabs is now rejected on the write boundary instead of silently rewritten). `restoreWorkspace` remains the single tolerant normalizer for the read path.
- **DW-28** — In the store `load()`, a strictly-newer-version file (`version` a finite number `> WORKSPACE_SNAPSHOT_VERSION`) has its original bytes best-effort backed up to a sibling `<path>.v<version>.bak` before degrading to `null`, so an older build's next save cannot destroy a future build's state. Best-effort by design — a backup failure never breaks the total, never-throwing load.

**Files changed:**
- `src/ui/workspace/workspace-state.ts` — new exported `sanitizePanelSizes` (DW-23).
- `src/ui/App.tsx` — load effect routes `panelSizes` through the sanitizer (DW-23).
- `src/core/workspace-registry.ts` — `validateSnapshotParams` `activeTabId` contract tightened (DW-25).
- `src/core/workspace-store.ts` — best-effort newer-version `.bak` on load + `load()` docstring disclosure (DW-28).
- `src/ui/workspace/workspace-state.test.ts` — `sanitizePanelSizes` matrix coverage.
- `src/core/workspace-registry.test.ts` — flipped null-with-tabs test + new empty-tabs-non-null rejection test.
- `src/core/workspace-store.test.ts` — newer-version-backup test + negative `.bak` side-effect tests.

**Review findings:** intent_gap 0, bad_spec 0, patch 3 (all low: 1 docstring drift, 2 test-coverage gaps — all applied), defer 0, reject 16. The headline reviewer finding (sanitizer not enforcing per-panel min/max) was verified as a non-break against the actual library source and rejected.

**Verification:**
- `bun test` (full suite) → 1235 pass, 0 fail (71 files); no regressions from the validator tightening.
- `bunx tsc --noEmit` → exit 0, no type errors.

**Residual risks (deliberate, documented):**
- DW-28 backup is best-effort: if the sibling `.bak` write fails (disk full / RO dir) the newer file could later be overwritten. Practically bounded — the same condition usually also fails the subsequent save, so the original survives. Recovery from `.bak` is a future build's responsibility; the invariant owed today is only that the newer bytes are not lost.
- DW-25 makes save reject a null-with-tabs snapshot with no UI signal. Safe today because the reducer never produces that state; a future transient violation would silently fail to persist rather than corrupt.
