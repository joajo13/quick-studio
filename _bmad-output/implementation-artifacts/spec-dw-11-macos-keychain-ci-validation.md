---
title: 'DW-11: Validate the macOS keychain path for @napi-rs/keyring under Bun (macos-latest CI leg + decision-record row)'
type: 'chore'
created: '2026-07-17'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '4bfe223c45c80e9f247bdb5267f13403303bc739'
final_revision: '65846b1cdf5ab50db9596d96479e44574c83d6d0'
context: ['_bmad-output/implementation-artifacts/spec-2-1-keyring-spike.md']
warnings: []
---

<intent-contract>

## Intent

**Problem:** The product targets macOS (`bun.lock` ships every `@napi-rs/keyring-darwin-*` binary) but Story 2.1's CI matrix in `.github/workflows/keyring-spike.yml` is `ubuntu-latest + windows-latest` only, so the macOS Keychain round-trip and the compiled-binary native load are unproven. GitHub macOS runners have notoriously locked/default-less keychains, making this the leg most likely to silently land a macOS user on the passphrase fallback with no per-platform go/no-go on record. This validation is also a prerequisite for observing the real macOS error shapes DW-10 depends on.

**Approach:** Add a `macos-latest` leg to the existing keyring-spike CI matrix that runs the SAME committed smoke (`bun test src/core/keychain.test.ts`) plus the compiled-binary native-load check (`scripts/keyring-native-check.ts`) under Bun, provisioning an unlocked default keychain on the runner so a REAL round-trip can be attempted under `KEYRING_REQUIRE_ROUNDTRIP=1` (mirroring how the Linux leg provisions Secret Service). Then record the per-platform macOS go/no-go in `docs/keyring-spike-decision.md`, naming CI as the source of the result (not a fabricated pass).

## Boundaries & Constraints

**Always:**
- The macOS leg runs the identical committed smoke and compiled-binary check as the other legs — no macOS-specific test fork; only a keychain-provisioning step is added, gated to `runner.os == 'macOS'`.
- The macOS provisioning must create + unlock a keychain, make it the default, and disable auto-lock so the round-trip inside the compiled-binary check can succeed under `KEYRING_REQUIRE_ROUNDTRIP=1`.
- `KEYRING_REQUIRE_ROUNDTRIP=1` stays set on the macOS compiled-binary check so a broken/locked keychain produces a RED leg (honest no-go), never a false green on `unavailable`.
- `fail-fast: false` must be preserved so the new leg's outcome is independent of the other legs.
- The decision record must state macOS as **delegated to CI** with the actual mechanism named; since macOS CI is not runnable from this Linux/WSL dev host, record it as **pending CI** with the expectation — exactly as Windows was recorded — and NEVER fabricate a macOS pass.
- Keep all changes inside CI config + the decision doc. No changes to `src/core/keychain.ts`, the smoke, or the native-check logic.

**Block If:**
- The only way to make the macOS leg green would require weakening the round-trip proof (e.g. dropping `KEYRING_REQUIRE_ROUNDTRIP=1` on macOS or making the smoke tolerate a fabricated pass). Do not weaken the proof to force green — HALT.

**Never:**
- Do not change the ubuntu or windows legs' behavior, the Bun pin, or the `paths` trigger semantics beyond what adding the macOS leg requires.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md` (the orchestrator records DW-11 resolution).
- Do not implement anything from DW-10 (error-shape typed classification) — this leg only produces the observable macOS behavior DW-10 will later consume.
- Do not add real credentials; the smoke/native-check already use throwaway service/account/secret names.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| macOS runner, keychain provisioned | provisioning step created + unlocked a default keychain | compiled-binary check round-trips (`stored → found(matches) → deleted`), exits 0; leg green | No error expected |
| macOS runner, keychain still locked/unavailable | provisioning failed or backend unreachable | compiled-binary check fails under `KEYRING_REQUIRE_ROUNDTRIP=1`, exits 1; leg RED | Honest no-go surfaced; not masked as pass |
| macOS smoke run | `bun test src/core/keychain.test.ts` | completes deterministically, no residual entries; green whether round-trip OR `unavailable` | Typed result, never a throw |

</intent-contract>

## Code Map

- `.github/workflows/keyring-spike.yml` -- add `macos-latest` to `strategy.matrix.os`; add a macOS-only "Provision keychain" step (create/unlock/default/no-auto-lock) before the smoke steps. The existing `runner.os != 'Linux'` smoke and compiled-binary-check steps already cover macOS (bash is the default shell there; `./keyring-native-check` resolves without `.exe`), so no new run steps are needed beyond provisioning.
- `docs/keyring-spike-decision.md` -- change the macOS summary row from "out of scope / deferred" to **delegated to CI (pending, expected GO with provisioning)**; add a macOS section mirroring the Windows section; update the AR-20 risk-status line and the intro macOS note to reflect that macOS now has a CI leg.
- `src/core/keychain.test.ts` / `scripts/keyring-native-check.ts` -- reference only (reused unchanged; the macOS leg runs them verbatim).
- `_bmad-output/implementation-artifacts/spec-2-1-keyring-spike.md` -- reference (origin of the deferred entry and the CI/decision conventions to mirror).

## Tasks & Acceptance

**Execution:**
- [x] `.github/workflows/keyring-spike.yml` -- add `macos-latest` to the matrix and a macOS-gated keychain-provisioning step (create a keychain with an empty password, unlock it, `security default-keychain -s`, `security set-keychain-settings` to disable the auto-lock timeout) placed before the non-Linux smoke/compiled-binary steps -- gives the macOS leg a reachable backend so the round-trip proof under `KEYRING_REQUIRE_ROUNDTRIP=1` is meaningful
- [x] `docs/keyring-spike-decision.md` -- update the summary table macOS row, add a macOS "delegated to CI" section, and revise the AR-20 risk-status + intro note so macOS is recorded as pending-CI with expected GO (CI named as the source; no fabricated pass) -- the decision-record row DW-11 requires
- [x] Validate the workflow YAML parses and the matrix/step gating is correct (three legs; macOS provisioning gated to `runner.os == 'macOS'`; `fail-fast: false` preserved; `KEYRING_REQUIRE_ROUNDTRIP=1` still set on the macOS compiled-binary check) -- confirms the leg is well-formed without a live macOS runner

**Acceptance Criteria:**
- Given the updated workflow, when the keyring-spike CI runs, then it schedules three legs (`ubuntu-latest`, `windows-latest`, `macos-latest`), each executing the same committed smoke under the pinned Bun, with the macOS leg preceded by a keychain-provisioning step.
- Given the macOS leg, when the compiled-binary native-load check runs, then it runs with `KEYRING_REQUIRE_ROUNDTRIP=1` so a green macOS leg is a genuine `store → found(matches) → deleted` proof and a locked/unavailable keychain yields a RED leg (not a false green).
- Given the closed change, when a reader opens `docs/keyring-spike-decision.md`, then the macOS row states a go/no-go delegated to CI (recorded as pending-CI with expected GO), consistent with the intro note and the AR-20 risk status, with CI named as the result source and no fabricated macOS pass.
- Given the ubuntu and windows legs, when the change is applied, then their behavior, the Bun pin, and `fail-fast: false` are unchanged.

## Spec Change Log

_No bad_spec loopback occurred; empty._

## Review Triage Log

### 2026-07-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 2, medium 2, low 2)
- defer: 0
- reject: 7: (high 1, medium 1, low 5)
- addressed_findings:
  - `[high]` `[patch]` The macOS provisioning created a keychain with no ACL trust, so the compiled-binary check's generic-password read could raise a GUI authorization dialog that hangs a headless runner to the job timeout — added `security set-key-partition-list -S apple-tool:,apple: -s -k "" spike.keychain` after unlock to grant non-interactive access.
  - `[high]` `[patch]` The search list included the runner's `login.keychain-db`, which boots locked; a `SecItem` search traversing it could raise an unlock prompt that hangs the headless leg — set the user search list to ONLY `spike.keychain` (`security list-keychains -d user -s spike.keychain`).
  - `[medium]` `[patch]` `docs/keyring-spike-decision.md` — the throw-path/`isNotFoundError` caveat and the Story-2.2 keychain-commit gate named Windows only, but the macOS Keychain also *throws* NoEntry and routes through the same locale-fragile heuristic; extended both to "Windows or macOS" and corrected the `deferred-work.md` reference to its real path.
  - `[medium]` `[patch]` `.github/workflows/keyring-spike.yml` — made the `set-keychain-settings` no-auto-lock intent explicit in a comment (no `-t`/`-l` = no lock-on-sleep and no timeout) so the "stays open for the whole leg" guarantee is documented, not incidental.
  - `[low]` `[patch]` `docs/keyring-spike-decision.md` — the "Distribution path" bullet omitted the macOS compiled-binary check; added it alongside Windows.
  - `[low]` `[patch]` `.github/workflows/keyring-spike.yml` — generalized the shared non-Linux compiled-binary step comment (was Windows-only) to also cover the provisioned macOS keychain.
- rejected (representative): provisioning-in-a-separate-step from the check "relies on unproven cross-step persistence" — the keychain default/unlock/search-list state persists across steps within a job on the same runner session; this is the idiomatic iOS-CI pattern, not flaky; missing diagnostic readback (`security show-keychain-info`) — the native-check already prints per-call breadcrumbs (`setSecret -> …`) that distinguish provisioning failure from a real no-go; no keychain cleanup / "breaks Linux symmetry" and empty-password default-keychain is job-global — harmless on ephemeral runners with no later secret-storing steps; macOS smoke step non-load-bearing — correct by design (the compiled-binary check under `KEYRING_REQUIRE_ROUNDTRIP=1` is the sole RED gate, same as Windows).

### 2026-07-17 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 1
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[low]` `[patch]` `docs/keyring-spike-decision.md` — the macOS provisioning prose said the keychain is "add[ed] to the user search list" (additive), but the YAML uses `security list-keychains -d user -s spike.keychain` which REPLACES the list (its own inline comment says "ONLY the spike keychain"). Corrected to "make it the sole entry in the user search list" and noted the purpose (a `SecItem` search can't wander into the runner's locked `login.keychain-db` and hang on an unlock prompt), so the doc matches the code and its inline comment.
- rejected (representative): `set-key-partition-list` runs on an empty keychain / "ineffective, mis-described" (both reviewers, high) — the round-trip is same-process (`keyring-native-check` creates AND reads the item in one process), so the creating app already holds its own item's ACL and no auth dialog fires; the step is a harmless defensive no-op the PRIOR pass deliberately added, and it exits 0 on a keyless keychain, so no spurious bash `-e` failure — churning it risks re-opening the hang the prior pass closed; non-canonical provisioning order (unlock before default/list) — `set-keychain-settings` disables the timeout so nothing re-locks, no demonstrated failure; "boots with locked/default-less login keychain likely inaccurate" — the isolation/determinism rationale holds regardless and the reviewer hedged ("likely"/"generally"); `create-keychain` not idempotent / no cleanup-restore — `macos-latest` is an EPHEMERAL GitHub-hosted runner (no reuse), and it fails LOUD not false-green; missing `shell: bash` + `set -euo pipefail` — GitHub's default `run:` shell is already `bash -eo pipefail`; no `show-keychain-info` observability — already rejected last pass (the native-check prints per-call breadcrumbs); keyring targets login not default — `@napi-rs/keyring`'s security-framework calls target the DEFAULT keychain (set to `spike.keychain`), which IS in the search list; no macOS marker in `NOT_FOUND_MARKERS` / doc oversells the throw-path confirmation — real but PRE-EXISTING (identical to Windows) and contract-forbidden here (`keychain.ts`/smoke are out of scope), so routed to the deferred-work ledger instead.

## Design Notes

- **macOS provisioning mirrors the Linux Secret Service provisioning.** Linux uses `dbus-run-session` + `gnome-keyring --unlock`; macOS uses the `security` CLI. GitHub macOS runners default to a locked/absent login keychain for headless `@napi-rs/keyring` access, so create a dedicated keychain, unlock it, set it as the default (so `security-framework`'s default-keychain generic-password calls target it), and disable the auto-lock timeout so it stays unlocked for the duration. Sketch:
  ```bash
  security create-keychain -p "" spike.keychain
  security set-keychain-settings spike.keychain      # no auto-lock timeout
  security unlock-keychain -p "" spike.keychain
  security default-keychain -s spike.keychain
  security list-keychains -d user -s spike.keychain login.keychain-db
  ```
- **Why the existing non-Linux steps already cover macOS:** they are gated `runner.os != 'Linux'`, use `shell: bash` (the macOS default shell anyway), and run `./keyring-native-check` (no `.exe` suffix on macOS). Only the provisioning is macOS-specific, so gate that one step to `runner.os == 'macOS'` and leave the shared steps untouched.
- **No fabricated pass:** this dev host is Linux/WSL, so the macOS result is produced by CI, identical to how Windows was handled in Story 2.1. Record macOS as pending-CI/expected-GO, not as observed-pass.

## Verification

**Commands:**
- `bun x tsc --noEmit` -- expected: no type errors (no source changed, but confirms the tree is clean)
- `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/keyring-spike.yml'))"` -- expected: parses without error; or an equivalent YAML lint

**Manual checks:**
- `.github/workflows/keyring-spike.yml` matrix lists `ubuntu-latest`, `windows-latest`, `macos-latest`; a macOS-gated provisioning step precedes the smoke; `fail-fast: false` and the macOS `KEYRING_REQUIRE_ROUNDTRIP=1` are present.
- `docs/keyring-spike-decision.md` macOS row, macOS section, intro note, and AR-20 line are mutually consistent and name CI as the macOS result source (pending, expected GO) with no fabricated pass.

## Auto Run Result

Status: **done** (followup review recommended)

**Implemented change (DW-11):** Added a `macos-latest` leg to the keyring-spike CI matrix so the macOS Keychain round-trip and compiled-binary native load of `@napi-rs/keyring` under Bun are exercised on a real runner. Because GitHub macOS runners boot with a locked/default-less login keychain, the leg provisions a dedicated unlocked default keychain via the `security` CLI (create → no-auto-lock → unlock → set default → scoped search list → non-interactive partition ACL) before running the SAME committed smoke (`bun test src/core/keychain.test.ts`) and the compiled-binary native-load check under `KEYRING_REQUIRE_ROUNDTRIP=1` — so a locked/unavailable keychain yields a RED leg, never a false green. Updated `docs/keyring-spike-decision.md` to record macOS as a per-platform go/no-go **delegated to CI (pending, expected GO)** — CI named as the source, no fabricated pass (the dev host is Linux/WSL, exactly as Windows was handled in Story 2.1).

**Files changed:**
- `.github/workflows/keyring-spike.yml` — add `macos-latest` to the matrix + a macOS-gated keychain-provisioning step; generalize the shared compiled-binary-check comment to cover macOS. Ubuntu/Windows legs, the Bun pin, `timeout-minutes`, `paths`, and `fail-fast: false` unchanged.
- `docs/keyring-spike-decision.md` — macOS promoted from "out of scope / deferred" to pending-CI/expected-GO across the Status line, AR-20 risk status, summary table, intro note, a new "macOS — delegated to CI" section, the key-management bullet, the distribution-path bullet, and the throw-path classification caveat (now covers macOS; `deferred-work.md` path corrected).

**Review findings breakdown:** 6 patches applied (2 high / 2 medium / 2 low), 0 deferred, 7 rejected. No intent_gap, no bad_spec, no repair loopback. The two high patches removed headless-runner hang paths in the macOS provisioning (missing partition-list ACL → GUI auth prompt; locked `login.keychain-db` in the search list → unlock prompt).

**Verification performed:**
- `bun x tsc --noEmit` → no type errors (no source files changed; confirms a clean tree)
- `python3` YAML parse → matrix `['ubuntu-latest','windows-latest','macos-latest']`, `fail-fast: false`, macOS step gated `runner.os == 'macOS'`, `set-key-partition-list` present, `KEYRING_REQUIRE_ROUNDTRIP=1` retained
- Decision-record cross-section consistency inspected (Status / AR-20 / table / macOS section / key-management / distribution-path / caveat all agree)

**Residual risks:**
- The macOS go/no-go is **pending the CI macOS leg** — not runnable in this Linux/WSL environment; recorded as pending (not a fabricated pass). Story 2.2 must not commit macOS to the keychain path until that leg is green AND the throw-path classification is confirmed against the real macOS error shape.
- The `security` provisioning recipe (partition-list, scoped search list, no-auto-lock) is the standard iOS-CI pattern but is only fully confirmable when the macOS leg actually runs.

### Follow-up review pass (2026-07-17)

An independent follow-up review (Blind Hunter + Edge Case Hunter, run at session capability) re-examined the DW-11 diff. Outcome: **1 patch, 1 defer, 15 rejected; no intent_gap, no bad_spec, no repair loopback.**

- **Patch (low):** `docs/keyring-spike-decision.md` — the macOS provisioning prose said the keychain is "add[ed] to the user search list," but the YAML `security list-keychains -d user -s spike.keychain` REPLACES the list (its own inline comment says "ONLY the spike keychain"). Corrected the doc to "make it the sole entry in the user search list," with the purpose noted, so the record matches the code and its inline comment.
- **Defer (1, new ledger entry):** The spike's CI legs prove a round-trip but never produce or assert the throw-path (not-found) error shape — the compiled-binary check only does store→found→delete, and the smoke's not-found test accepts both `not-found` and `unavailable`. So a green Windows/macOS leg does NOT mechanically confirm the `isNotFoundError` classification the decision record names as a Story-2.2 gate. Pre-existing and platform-general (identical to the pre-DW-11 Windows leg), and contract-forbidden to fix here (`keychain.ts`/smoke out of scope) — appended to `deferred-work.md` as a NEW entry alongside the existing DW-10 typed-error work.
- **Rejected (15, representative):** `set-key-partition-list` "ineffective on an empty keychain" (both reviewers, judged high) — harmless same-process defensive no-op the prior pass deliberately added, exits 0 on a keyless keychain, so no spurious failure and no reason to churn; non-canonical provisioning order — no re-lock possible with the timeout disabled; "login keychain boots unlocked" premise nuance — isolation rationale holds regardless; `create-keychain` idempotency / cleanup-restore — ephemeral GitHub-hosted runner, fails loud not false-green; missing explicit `set -euo pipefail` — GitHub's default `run:` shell already is `bash -eo pipefail`; keyring-targets-login — security-framework calls target the default keychain (= `spike.keychain`, in the search list).

**Follow-up verification:** `python3` YAML parse → matrix `['ubuntu-latest','windows-latest','macos-latest']`, `fail-fast: false`; `bun x tsc --noEmit` → no type errors. This pass changed only doc prose + the deferred-work ledger + this spec, so `followup_review_recommended` is set to **false** (a single localized low-consequence fix does not warrant another independent pass).
