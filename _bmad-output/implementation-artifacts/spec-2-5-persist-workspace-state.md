---
title: 'Persist and restore Workspace state'
type: 'feature'
created: '2026-07-08'
status: 'done'
baseline_revision: '140aa9088757803bfa57bb0e7ce03522822294ea'
final_revision: 'f8a392e2bd731cc211d6fc0fd1e5df3f0445ab9d'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** Panel sizes and open Tabs live only in React memory and are lost on every relaunch (`src/ui/workspace/Workspace.tsx:6-8` earmarks this as Story 2.5; `workspace-state.ts:9-10` states "never persists anything"). This is the restore half of FR-24 (AR-9): a developer who rearranges their Workspace should return to it exactly as they left it — but only in Persistent mode. Until this lands, the persistence substrate built in Stories 2.2–2.4 is only used for credentials, not for the Workspace itself.

**Approach:** Add a Core-owned, plain-JSON workspace-state store under the existing app directory (`ensureAppDir()`), plus a `workspace.load` / `workspace.save` RPC surface mirroring the Story 2.4 `connections.*` wiring end-to-end. On UI mount the App loads the snapshot (Panel sizes + Tab state) before mounting the `PanelGroup` and seeds the workspace reducer with it; a debounced effect saves on every change. Ephemeral mode is the hard inverse: Core gates persistence exactly like the credential store — `save` no-ops (returns ok, writes nothing) and `load` returns nothing — so no Workspace state is ever written to disk.

## Boundaries & Constraints

**Always:**
- Persistence lives ONLY in Ring 1 (Core, `src/core/`). The UI issues token-gated RPCs and is oblivious to run-mode; it calls `workspace.save`/`workspace.load` in BOTH modes and Core enforces the mode contract.
- Reuse the established substrate: `ensureAppDir()` for location (`src/core/app-dir.ts`), `resolveRunMode(process.env)` default for the mode gate, atomic temp-write-then-rename for writes, `RegistryResult<T>` + `okReply`/`errorReply` for RPC replies. Mirror the `connections.*` four-layer wiring (`contract.ts` → `rpc.ts` HANDLERS → `server.ts` construction → typed UI call via existing `rpc()`).
- Ephemeral mode writes NOTHING: `save` returns `{ saved: false }` without touching disk; `load` returns `{ snapshot: null }`. Verified by asserting the store file never appears in a temp dir under ephemeral mode.
- Restore is robust: a missing file, a version mismatch, or malformed/corrupt JSON degrades to `{ snapshot: null }` (fresh Workspace) — never a throw, never a crash on boot. Mirror the malformed-record degrade path in `connection-registry`.
- The persisted snapshot is credential-free and non-secret: plain JSON, no encryption, no keychain, no passphrase. It contains only Panel sizes and Tab metadata (`kind`/`title`/ids), never row data or connection URLs.
- `WorkspaceTabKind` has a single source of truth in `src/shared/contract.ts`; `workspace-state.ts` imports it so Core validation and UI stay in sync.
- Restored Panel sizes must be present at the FIRST `PanelGroup` mount (`react-resizable-panels` reads `defaultSize` only on initial mount) — gate the Workspace layout render behind the initial `workspace.load`.

**Block If:**
- The app directory cannot be resolved or created for a reason other than absence (e.g. `ensureAppDir()` throws non-absolute / permission): surface as `internal_error` at runtime, but if the intended location scheme is ambiguous during implementation, HALT `blocked`.
- Story scope needs to expand beyond Panel sizes + open Tabs (e.g. persisting Settings-open state, active connection, or per-tab payloads): HALT `blocked` — those belong to later stories.

**Never:**
- Never use `react-resizable-panels` `autoSaveId` / browser `localStorage`: it persists in the browser regardless of run-mode, violating the Ephemeral inverse contract. Persistence must be Core-gated.
- Never persist secrets, connection URLs, credentials, query text, or result rows.
- Never leave a daemon or watcher outliving the process; saves are request-scoped RPCs.
- Never block first paint on the load for longer than the snapshot fetch; no spinner beyond the brief layout gate.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Restore happy path | Persistent mode; valid `workspace-state.json` on disk | `workspace.load` → `{ snapshot }`; UI mounts with restored Panel sizes, Tabs, active tab, nextId | No error expected |
| First launch | Persistent mode; no store file yet | `load` → `{ snapshot: null }`; fresh `emptyWorkspace()` + default Panel sizes (20/80) | No error expected |
| Corrupt / version-mismatch snapshot | Persistent mode; unparseable JSON or `version` ≠ current | `load` → `{ snapshot: null }`; degrade to fresh Workspace | Swallowed; no throw, logged without secrets |
| Save happy path | Persistent mode; valid snapshot params | `workspace.save` → `{ saved: true }`; atomic write to app dir | No error expected |
| Ephemeral save | Ephemeral mode; `workspace.save` called by oblivious UI | `{ saved: false }`; NOTHING written to disk | No error expected |
| Ephemeral load | Ephemeral mode; `workspace.load` called on mount | `{ snapshot: null }`; fresh Workspace, no disk read | No error expected |
| Malformed save params | Any mode; params not a valid snapshot shape (bad panelSizes / unknown tab kind / dangling activeTabId) | `errorReply("bad_request", …)`; nothing written | `bad_request` envelope |

</intent-contract>

## Code Map

- `src/core/app-dir.ts` -- REUSE ONLY: `ensureAppDir()` for location, injectable `dir` dep pattern. Do not modify.
- `src/core/credential-store.ts` -- REFERENCE ONLY: atomic temp-write-then-rename (`:358-393`), ephemeral no-op gate (`:416-421`, flush `:687-690`), injectable `dir`/`mode` deps. Do not modify.
- `src/core/run-mode.ts` -- REUSE: `RunMode`, `resolveRunMode(process.env)` default gate.
- `src/core/connection-registry.ts` -- REFERENCE template: lazy-memoized open, `openStore` seam, `RegistryResult<T>`, malformed-record degrade.
- `src/shared/contract.ts` -- add `WorkspaceTabKind` + `WORKSPACE_TAB_KINDS` (single source), `WorkspaceSnapshot`, `SaveWorkspaceParams`, `SaveWorkspaceResult`, `LoadWorkspaceResult`, method names `workspace.load`/`workspace.save`; reuse `okReply`/`errorReply`/`RpcErrorCode`.
- `src/core/workspace-store.ts` (new) -- plain-JSON store: `openWorkspaceStore(deps)` with `dir`/`mode`; `load()` → snapshot|null (corrupt/absent/version-mismatch → null), `save(snapshot)` → ok (ephemeral no-op). Atomic write mirroring credential-store.
- `src/core/workspace-registry.ts` (new) -- lazy-memoized store open + validate; `load()`/`save(params)` returning `RegistryResult<T>`; `openStore` seam for tests; maps to `bad_request` (invalid params) / `internal_error` (store failure).
- `src/core/rpc.ts` -- extend `RpcContext` with `workspace: WorkspaceRegistry`; add `HANDLERS` entries `workspace.load` (no params) / `workspace.save` (snapshot params via `asParamsObject`); reuse `toReply`.
- `src/core/server.ts` -- construct `workspaceRegistry` gated by `mode` (alongside `connectionRegistry`, `:184`); wire onto `rpcContext` (`:192-201`).
- `src/ui/workspace/workspace-state.ts` -- import `TabKind` from contract; add pure `restoreWorkspace(snapshot)` → `WorkspaceState` (recompute `nextId`/`activeTabId` safely) and `toWorkspaceSnapshot(state, panelSizes)`; update stale "never persists" header note.
- `src/ui/App.tsx` -- add reducer `restore` action; mount effect calls `rpc("workspace.load")` and gates Workspace render until resolved; debounced save effect on `workspace`/panelSizes change calling `rpc("workspace.save")`; hold `panelSizes` state seeded from snapshot.
- `src/ui/workspace/Workspace.tsx` -- accept restored `panelSizes` as `defaultSize` for the two Panels and an `onLayout` callback prop threaded to `PanelGroup`; remove the stale self-referential Ephemeral comment (`:123-124`).
- `src/ui/rpc/client.ts` -- REUSE ONLY: generic `rpc<T>(method, params)`. No change.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `WORKSPACE_TAB_KINDS`/`WorkspaceTabKind`, `WorkspaceSnapshot` (`{ version: 1; panelSizes: number[]; tabs: {id;kind;title}[]; activeTabId: number|null; nextId: number }`), `SaveWorkspaceParams` (= snapshot), `SaveWorkspaceResult` (`{ saved: boolean }`), `LoadWorkspaceResult` (`{ snapshot: WorkspaceSnapshot | null }`), and `"workspace.load"`/`"workspace.save"` method names -- shared wire contract, single source of tab kinds.
- [x] `src/core/workspace-store.ts` (new) -- plain-JSON persistence with atomic temp-write-then-rename, ephemeral no-op, and absent/corrupt/version-mismatch → null on load -- the disk substrate for Workspace state.
- [x] `src/core/workspace-registry.ts` (new) -- lazy-memoized open + snapshot validation returning `RegistryResult<T>`; `openStore` seam -- the sole store-holder mapping outcomes to RPC codes.
- [x] `src/core/rpc.ts` -- wire `workspace.load`/`workspace.save` into `RpcContext` + `HANDLERS` -- expose the capability over RPC.
- [x] `src/core/server.ts` -- construct `workspaceRegistry` gated by `mode` and add to `rpcContext` -- boot wiring mirroring `connectionRegistry`.
- [x] `src/ui/workspace/workspace-state.ts` -- import `TabKind` from contract; add pure `restoreWorkspace`/`toWorkspaceSnapshot`; fix stale header -- serialization bridge between wire snapshot and reducer state.
- [x] `src/ui/App.tsx` -- add `restore` reducer action, mount-load gate, `panelSizes` state, and debounced save effect -- drive load-on-launch and save-on-change.
- [x] `src/ui/workspace/Workspace.tsx` -- thread restored `panelSizes` as `defaultSize` and an `onLayout` prop; remove stale comment -- apply restored Panel sizes at first mount and report layout changes.
- [x] `src/core/workspace-store.test.ts` (new) -- cover persistent roundtrip, ephemeral no-op (file never created), absent → null, corrupt/version-mismatch → null (I/O matrix rows).
- [x] `src/core/workspace-registry.test.ts` (new) -- cover `openStore`-seam validation: valid save→ok, `bad_request` on malformed params, ephemeral no-op, malformed-snapshot degrade.
- [x] `src/ui/workspace/workspace-state.test.ts` -- extend for `restoreWorkspace` (nextId/activeTabId recomputation, dangling activeTabId) and `toWorkspaceSnapshot` roundtrip.
- [x] `src/core/rpc.test.ts` -- extend dispatch tests with a fake `workspace` in `RpcContext` for `workspace.load`/`workspace.save`.

**Acceptance Criteria:**
- Given Persistent mode and a Workspace with rearranged Panel sizes and open Tabs, when the app relaunches, then Panel sizes, open Tabs, active tab, and nextId are restored from `workspace-state.json` in the app directory (FR-24 restore half, AR-9).
- Given Ephemeral mode, when the Workspace is rearranged and the app relaunches, then nothing is restored and no `workspace-state.json` was ever written to disk (AR-8).
- Given a persistent store file that is corrupt or version-mismatched, when the app boots, then it degrades to a fresh Workspace without throwing.
- Given the UI is oblivious to run-mode, when it calls `workspace.save`/`workspace.load`, then Core alone enforces the mode contract (no UI-side mode branching).

## Review Triage Log

### 2026-07-08 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 1, medium 0, low 1)
- defer: 7: (high 0, medium 1, low 6)
- reject: 1: (high 0, medium 0, low 1)
- addressed_findings:
  - `[high]` `[patch]` Load-error/degrade collapse (`App.tsx` load effect) mapped a *failed* `workspace.load` reply to the same `snapshot: null` as a legitimately-empty one, then flipped the save gate on — so a transient load failure/timeout let the debounced auto-save clobber a good on-disk snapshot with the empty fallback (data loss). Fixed: auto-save now enables ONLY after a *successful* load; a load error renders fresh but keeps saving off, never overwriting an unreadable-but-possibly-good file.
  - `[low]` `[patch]` `onLayout` fires a fresh array at `PanelGroup` mount, so the save effect wrote on every launch with no user change (needless writes, and the mechanism that made the high finding reachable). Fixed: the save effect now seeds a `lastPersistedRef` baseline from the loaded snapshot and skips the write when the serialized snapshot is unchanged.

### 2026-07-08 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 0, low 2)
- defer: 0
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[low]` `[patch]` `SaveWorkspaceResult`/`LoadWorkspaceResult` were declared a second time inside `workspace-registry.ts`, structurally coinciding with the same-named wire types in `contract.ts` — a future edit to one would not be caught at the boundary, undercutting the story's single-source-of-truth intent. Fixed: the registry now imports and re-exports those two result types from `contract.ts`.
  - `[low]` `[patch]` `toWorkspaceSnapshot` hard-coded `version: 1` instead of the `WORKSPACE_SNAPSHOT_VERSION` constant it introduced, so a future schema bump would silently drift the UI serializer from the store's version gate. Fixed: the serializer now writes `WORKSPACE_SNAPSHOT_VERSION`.
- notes: The remaining real findings this pass (last-change-lost-on-quit / debounce-not-flushed, silent-save-write-failure incl. the optimistic `lastPersistedRef`-before-await making it non-retryable, `panelSizes` length/range unconstrained, duplicate-tab-id acceptance, out-of-order overlapping saves, `activeTabId` load/save asymmetry) all duplicate entries already on `deferred-work.md` from the initial pass and were left untouched (the orchestrator owns those). Rejected as noise: spurious save-on-launch from `onLayout` normalization (self-correcting one write), unpersisted load-time self-healing (informational), Ephemeral-mode chatty save RPC (deliberate "UI oblivious" design), up-to-10s blank `LayoutGate` on a wedged Core (bounded, already rejected initial pass), and `reply.ok && !reply.result` TypeError (not reachable — `workspace.load` always returns a `result`).

## Design Notes

- **Core-gated, not localStorage.** The Ephemeral inverse contract ("nothing persists") is only enforceable in Core, which knows the run-mode. `react-resizable-panels` `autoSaveId` would persist to the browser in every mode — forbidden. So we drive `onLayout` manually and round-trip through `workspace.save`.
- **Consumer of the substrate.** Mirror `connection-registry` structurally but with a plain-JSON store (layout isn't secret): no `crypto.ts`/`store-key`/passphrase. Keep the credential-store's atomic write and ephemeral no-op shape:
  ```ts
  // workspace-store save(), ephemeral gate (mirror credential-store.ts:416-421,687-690)
  if (this.mode === "ephemeral" || this.filePath === null) return { saved: false };
  const tmp = `${this.filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  renameSync(tmp, this.filePath);        // atomic
  return { saved: true };
  ```
- **Panel-size restore timing.** `defaultSize` is read only at initial `PanelGroup` mount, so the load must complete before the layout mounts. Gate in `App.tsx`:
  ```tsx
  const [restored, setRestored] = useState<WorkspaceSnapshot | null | undefined>(undefined); // undefined = loading
  useEffect(() => { void rpc<LoadWorkspaceResult>("workspace.load").then(r => setRestored(r.ok ? r.result.snapshot : null)); }, []);
  if (restored === undefined) return <LayoutGate />;  // brief, before PanelGroup mounts
  ```
  Then seed `useReducer(..., () => restored ? restoreWorkspace(restored) : emptyWorkspace())` and `panelSizes` from `restored?.panelSizes ?? [20, 80]`.
- **Validation in one place (the registry).** `bad_request` for malformed params (panelSizes not a finite-number array, unknown tab kind, `activeTabId` not among tab ids, `nextId` ≤ max id); `internal_error` for store `write-failed`/unresolvable dir. On load, the same validation runs against disk content — any failure → `null` (degrade), never propagate a corrupt snapshot to the UI.
- **Save cadence.** Debounce saves (~400 ms) on any change to `workspace` or `panelSizes` so a drag doesn't spray writes; a single trailing write captures the settled layout.

## Verification

**Commands:**
- `bun test src/core/workspace-store.test.ts src/core/workspace-registry.test.ts src/ui/workspace/workspace-state.test.ts src/core/rpc.test.ts` -- expected: all new/updated tests pass, covering every I/O matrix row.
- `bun test` -- expected: full suite green (no regression in credential-store / connection-registry / rpc).
- `bun run build` -- expected: UI bundle builds with no TypeScript/import errors (validates the cross-layer contract types).

**Manual checks:**
- Launch persistent (`bun run dev`), open two Tabs and drag the rail/main split, quit, relaunch → Tabs and split are restored; a `workspace-state.json` exists under the app dir.
- Launch ephemeral (`QS_MODE=ephemeral bun run dev`), rearrange, quit, relaunch → fresh Workspace; confirm NO `workspace-state.json` was created under the app dir.

## Auto Run Result

Status: done

### Summary
Implemented the restore half of FR-24 (AR-9): a Core-owned, mode-gated, plain-JSON Workspace-state store (Panel sizes + open Tabs) under the existing app directory, exposed via `workspace.load`/`workspace.save` RPCs that mirror the Story 2.4 `connections.*` four-layer wiring. Persistent mode restores the Workspace on next launch; Ephemeral mode writes nothing (Core-enforced, UI oblivious); load degrades (absent/corrupt/version-mismatch/malformed → fresh) and never throws. All 12 spec tasks completed and every acceptance criterion satisfied.

### Files changed
- `src/shared/contract.ts` -- single-source `WORKSPACE_TAB_KINDS`/`WorkspaceTabKind`, `WorkspaceSnapshot` + save/load param/result types.
- `src/core/workspace-store.ts` (new) -- plain-JSON atomic (temp-write+rename) store; Ephemeral no-op; total `load` degrading any bad content to `null`.
- `src/core/workspace-registry.ts` (new) -- lazy-memoized-on-success store holder; field-named `bad_request` validation; store failures → `internal_error`.
- `src/core/rpc.ts` -- `workspace` capability on `RpcContext` + `workspace.load`/`workspace.save` handlers (all validation delegated to the registry).
- `src/core/server.ts` -- constructs `workspaceRegistry` gated by `mode`, wired onto `rpcContext`.
- `src/ui/workspace/workspace-state.ts` -- `TabKind` aliases the shared kind; pure `restoreWorkspace`/`toWorkspaceSnapshot` serialization bridge.
- `src/ui/App.tsx` -- `restore` reducer action; mount-load gate; debounced save-on-change; **review patch** (load-error guard + unchanged-skip, see below).
- `src/ui/workspace/Workspace.tsx` -- `panelSizes`/`onLayout` props threaded to `PanelGroup`; stale forward-pointing comments removed.
- Tests: `src/core/workspace-store.test.ts` (new), `src/core/workspace-registry.test.ts` (new), `src/core/rpc.test.ts` (workspace dispatch), `src/ui/workspace/workspace-state.test.ts` (restore/snapshot).

### Review findings
- **Patched (2):** `[high]` a failed `workspace.load` reply collapsed to the same `snapshot: null` as a legitimately-empty one and then enabled auto-save, so a transient load failure let the debounced save clobber a good on-disk snapshot (data loss) — fixed by enabling auto-save only after a *successful* load. `[low]` `onLayout` fired a fresh array at mount so a save ran on every launch — fixed with a `lastPersistedRef` unchanged-snapshot guard.
- **Deferred (7):** silent save write-failure not surfaced to user (medium); `panelSizes` length/range not constrained; debounced save not flushed on quit; `activeTabId:null`-with-tabs validator/restore mismatch; duplicate-tab-id acceptance; out-of-order overlapping saves; downgrade overwriting a newer-version file. All appended to `deferred-work.md`.
- **Rejected (1):** up-to-10s blank `LayoutGate` if Core is wedged during initial load — bounded, resolves to a fresh Workspace, informational.

### Verification performed
- `bunx tsc --noEmit -p .` -- clean (exit 0), including after the review patch.
- `bun test` -- 377 pass, 0 fail, 899 expect() calls, 23 files (no regressions).
- `bun run build` -- UI bundle built successfully (exit 0).
- Implementation subagent additionally smoke-tested a real `startCore` boot: Persistent save/load round-trip via `workspace-state.json`; Ephemeral save/load touch no disk; malformed save → `bad_request` with `detail: field=panelSizes`.

### Residual risks
- The `App.tsx` save/load effect logic (including the review patch) has no automated test — the project has no React effect-test harness, so this timing-sensitive code is covered only by the pure-model tests plus manual/smoke checks. Recommended follow-up review focuses here.
- The seven deferred items are all low-consequence (mostly tamper/legacy-file hardening or narrow-window edges) but remain open in `deferred-work.md`.

## Auto Run Result — Follow-up Review Pass (2026-07-08)

Status: done

### Summary
Independent follow-up review (Blind Hunter + Edge Case Hunter, run in parallel at full model capability on the code diff since `140aa90`). The story's core — Core-gated persist/restore, the Ephemeral no-write inverse, total degrade-to-null load, atomic temp-write+rename, safe error-label mapping — was re-confirmed sound and well-tested by both reviewers. Two new low-severity single-source-of-truth drift risks were patched; every other real finding duplicated an already-tracked `deferred-work.md` entry (left untouched) or was rejected as noise.

### Files changed (this pass)
- `src/core/workspace-registry.ts` -- import + re-export `SaveWorkspaceResult`/`LoadWorkspaceResult` from `contract.ts` instead of re-declaring them locally (removes structural-coincidence drift at the wire boundary).
- `src/ui/workspace/workspace-state.ts` -- `toWorkspaceSnapshot` now serializes `WORKSPACE_SNAPSHOT_VERSION` instead of a hard-coded literal `1`.

### Review findings breakdown
- **Patched (2, both low):** duplicate `Save/LoadWorkspaceResult` result-type declarations in the registry; hard-coded snapshot `version: 1` in the UI serializer.
- **Deferred (0 new):** the flush-on-quit data loss, silent save-write-failure (incl. the optimistic `lastPersistedRef`-before-await non-retry mechanic), unconstrained `panelSizes` length/range, duplicate-tab-id acceptance, out-of-order overlapping saves, and `activeTabId` load/save asymmetry all duplicate existing `deferred-work.md` entries from the initial pass; not re-added, not modified (orchestrator owns them).
- **Rejected (6):** spurious save-on-launch from `onLayout` normalization (self-correcting single write); unpersisted load-time self-healing (informational); Ephemeral-mode chatty save RPC (deliberate "UI oblivious" design); up-to-10s blank `LayoutGate` on a wedged Core (bounded; already rejected in the initial pass); `reply.ok && !reply.result` TypeError (not reachable — `workspace.load` always carries a `result`, confirmed by both reviewers reading the RPC client).

### Verification performed
- `bunx tsc --noEmit -p .` -- clean (exit 0) after the two patches.
- `bun test` -- 377 pass, 0 fail, 899 expect() calls, 23 files (no regression).
- `bun run build` -- UI bundle rebuilt successfully (exit 0).

### Follow-up review recommendation
`false` — this pass made only two localized, low-consequence, non-behavioral patches (type de-duplication + constant use); no behavior, API, security, or data-path change. The auto-save/load-gate timing code remains the story's least-tested surface, but that risk is already recorded above and is unchanged by this pass.

### Residual risks
- Unchanged from the initial run: the `App.tsx` effect timing code has no automated harness, and the deferred hardening items remain open in `deferred-work.md`.
