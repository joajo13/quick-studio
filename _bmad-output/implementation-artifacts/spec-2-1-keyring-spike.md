---
title: 'Story 2.1: Spike — validate @napi-rs/keyring under Bun on Windows and Linux'
type: 'chore'
created: '2026-07-06'
status: 'done'
baseline_revision: 'b633d99293289980a5bf1b12b64b7cb2bda2be71'
final_revision: '400e6a32fbba6d2887bdb4e136d646cf4b360409'
review_loop_iteration: 0
followup_review_recommended: false
context: ['_bmad-output/implementation-artifacts/epic-2-context.md']
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Epic 2's entire encrypted-credential-store design assumes `@napi-rs/keyring` works under Bun to hold the AES key in the OS keychain, but NAPI parity under Bun is "almost, not 100%" (AR-20) and is unproven per-platform. Building the crypto path on a library that silently fails on one platform would be expensive to unwind later.

**Approach:** Add the pinned library, wrap its store/retrieve/delete behind a small Ring-1 module that surfaces a keychain-unavailable condition instead of crashing, prove it with a repeatable smoke test runnable via `bun test` on each target OS (automated in CI for Windows + Linux), and record a per-platform go/no-go decision that fixes the key-management path (keychain vs passphrase-first) for Stories 2.2/2.3.

## Boundaries & Constraints

**Always:**
- Pin `@napi-rs/keyring` to exactly `1.3.0` (no caret) and commit the updated lockfile.
- All keychain access lives in Ring 1 (`src/core/`); no keychain call or secret touches Ring 2 (`src/ui/`) or `src/shared/`.
- The smoke test must be repeatable and self-cleaning (store → retrieve → delete, leaving no residual entry) and use a dedicated test service/account name — never a real credential.
- When the OS keychain backend is unavailable, the wrapper must return a typed keychain-unavailable result — never throw an unhandled error, and never fall back to writing the secret in plaintext.
- The smoke test must exit green whether the platform round-trips OR reports keychain-unavailable; "unavailable" is a first-class, expected outcome, not a test failure.
- The decision record must state the ACTUAL observed outcome per platform. If a platform cannot be executed in this environment, say so explicitly and name the mechanism (CI) that produces its result. Never fabricate a pass.
- Never log secret values.

**Block If:**
- `@napi-rs/keyring@1.3.0` cannot be installed or its native module cannot even be imported under Bun on the build platform — the spike cannot produce a committed smoke test at all.

**Never:**
- Do not implement the actual encrypted credential store, AES-256-GCM crypto, the app-directory resolver, or the passphrase fallback — those are Stories 2.2 / 2.3 / 2.5.
- Do not choose or hardcode a single global key-management default that overrides the per-platform decision.
- Do not write any real user credential or plaintext secret to disk.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Round-trip (working keychain) | `setSecret(service, account, value)` then `getSecret` | `getSecret` returns the same value; `deleteSecret` removes it | No error expected |
| Retrieve missing entry | `getSecret` after delete or never stored | Returns a typed not-found (null), not a thrown error | Typed not-found result |
| No keychain backend (e.g. headless Linux without Secret Service/D-Bus) | `setSecret`/`getSecret` attempted | Wrapper returns a typed keychain-unavailable result | Recorded as no-go for that platform; smoke stays green |

</intent-contract>

## Code Map

- `package.json` -- add `@napi-rs/keyring` pinned `1.3.0` to `dependencies`
- `bun.lock` -- regenerated lockfile including the new dependency
- `src/core/keychain.ts` (new) -- Ring-1 wrapper over `@napi-rs/keyring`: `setSecret` / `getSecret` / `deleteSecret` returning typed results; detects and reports keychain-unavailable; isolates the native side-effect
- `src/core/keychain.test.ts` (new) -- repeatable `bun test` smoke: round-trip + not-found + unavailable-detection; self-cleaning
- `.github/workflows/keyring-spike.yml` (new) -- CI matrix (ubuntu + windows) running the smoke under Bun, provisioning Secret Service on Linux (`dbus-run-session` / gnome-keyring), for repeatable per-platform results
- `docs/keyring-spike-decision.md` (new) -- per-platform go/no-go decision record + chosen key-management path

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- add `@napi-rs/keyring@1.3.0` (exact, no caret) to dependencies and regenerate `bun.lock` -- brings the library under test
- [x] `src/core/keychain.ts` -- implement typed `setSecret`/`getSecret`/`deleteSecret` wrapper that surfaces keychain-unavailable instead of throwing -- isolates the native side-effect for the store to build on later
- [x] `src/core/keychain.test.ts` -- repeatable, self-cleaning smoke covering round-trip, not-found, and unavailable-detection; green on either round-trip-pass or keychain-unavailable -- the committed repeatable smoke test
- [x] `.github/workflows/keyring-spike.yml` -- CI matrix (ubuntu + windows) runs the same smoke under Bun; Linux leg provisions Secret Service -- gives repeatable Windows AND Linux go/no-go
- [x] `docs/keyring-spike-decision.md` -- record the actual per-platform outcome and the chosen key-management path (keychain vs passphrase-first); note whether the keyring native module also loads from a `bun build --compile` binary -- the required decision record
- [x] Run `bun test src/core/keychain.test.ts` locally and record the observed Linux result into the decision record -- executes the spike on the available platform

**Acceptance Criteria:**
- Given the repo after this story, when `bun install` runs, then `@napi-rs/keyring` resolves at exactly `1.3.0` and the lockfile is committed.
- Given `bun test`, when the keychain smoke runs, then it completes deterministically without leaving residual keychain entries, exiting green whether the platform round-trips or reports keychain-unavailable.
- Given the closed spike, when a reader opens `docs/keyring-spike-decision.md`, then it states a go/no-go and the chosen key-management path (keychain vs passphrase-first) for Windows and for Linux, reflecting actually observed results (CI named as the source for any platform not runnable locally).
- Given the CI workflow, when it runs on the ubuntu and windows matrix legs, then each leg executes the same committed smoke test under Bun.

## Spec Change Log

_No bad_spec loopback occurred; empty._

## Review Triage Log

### 2026-07-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 4, low 2)
- defer: 1
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` Secret could leak into an `unavailable` result's `detail` if a native error echoed the input value — `formatErrorDetail` now redacts the verbatim secret (passed from `setSecret`) and bounds detail length to 200 chars.
  - `[medium]` `[patch]` The not-found-vs-unavailable classifier (`isNotFoundError`) and `formatErrorDetail` were untested — added table-driven unit tests covering NoEntry-style → `not-found`, backend-down/empty → `unavailable` (fail-safe), whitespace-collapse, secret-redaction, length-bound, and non-Error inputs (test count 6 → 18).
  - `[medium]` `[patch]` CI could report a false GO because `bun test` is green on `unavailable` — added `KEYRING_REQUIRE_ROUNDTRIP=1` mode to `keyring-native-check.ts` (fails unless a real `store→found→deleted` round-trip occurred) and set it on both CI legs, turning a green leg into a genuine per-platform proof.
  - `[medium]` `[patch]` Documented the provisional throw-path classification as a caveat in the decision record, gating Story 2.2's Windows keychain commitment on the CI Windows leg + confirmed error shape.
  - `[low]` `[patch]` Pinned CI `bun-version: 1.2.0` so the AR-20 parity attestation is tied to a known Bun version.
  - `[low]` `[patch]` Added `scripts/keyring-native-check.ts` to the workflow `paths` filter so edits to the compiled-binary check re-trigger the spike.

### 2026-07-06 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 2, low 1)
- defer: 2
- reject: 10: (high 0, medium 2, low 8)
- addressed_findings:
  - `[medium]` `[patch]` `formatErrorDetail` redacted the secret only AFTER collapsing whitespace, so a secret containing a newline/tab/double-space (e.g. a Story 2.3 passphrase echoed by a native error) would no longer match verbatim and could survive into `detail` — breaking the module's no-secret-in-detail invariant. Now redacts the verbatim secret BEFORE normalization and re-redacts the whitespace-collapsed form after; added a regression test (18 → 19, full suite 112 → 113).
  - `[medium]` `[patch]` The non-Linux CI leg invoked `./keyring-native-check`, but on `windows-latest` the default shell is PowerShell where `bun build --compile` emits `keyring-native-check.exe` and `./name` would not resolve it — the exact leg the Windows go/no-go is delegated to. Pinned `shell: bash` on that step so Git Bash resolves the `.exe` deterministically.
  - `[low]` `[patch]` Added `timeout-minutes: 15` to the spike job so a hung keyring daemon or self-compiled binary fails fast instead of running to the 6h default.
  - `[low]` `[patch]` Bundled into the redaction fix: `formatErrorDetail` truncation now slices by code point (`[...raw]`) instead of UTF-16 unit, so a multi-byte native error message can't leave a split surrogate at the 200-char cut.
- deferred (new ledger entries): macOS keychain path unvalidated (product ships darwin binaries; spike matrix is ubuntu+windows by spec); `getSecret` returns `found` for an empty-string value — Story 2.2 key-load should decide whether `""` is a valid key.
- rejected (representative): `isNotFoundError` substring false-positives (`path/host not found`, `no entry point`) — already covered by the existing typed-error-codes defer entry; throw→not-found branch not integration-tested locally — the CI Windows leg exercises it against a real backend; `gnome-keyring` handle discarded — fail-safe under `KEYRING_REQUIRE_ROUNDTRIP=1`; Bun-version attestation split (1.2.0 CI vs 1.3.14 local); no `pull_request` trigger; local `keyring-native-check` orphan-on-SIGKILL (wrappers never throw, so signal-cleanup is over-engineering for a manual probe).

### 2026-07-06 — Review pass (follow-up #2)
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 1
- reject: 9: (high 0, medium 1, low 8)
- addressed_findings:
  - `[medium]` `[patch]` The decision record header simultaneously said `Status: open` and `Risk retired: AR-20`, so a reader scanning "is AR-20 closed?" got a false yes while Windows was still pending CI and macOS unvalidated. Reworded to `Risk status — AR-20: partially retired` (Linux proven; Windows pending CI; macOS out of scope), consistent with `Status: open`.
  - `[low]` `[patch]` `scripts/keyring-native-check.ts` imported `keychain.ts` at the top level, so a compiled-binary native-load failure (the exact failure the check exists to surface) threw during module evaluation — before the `try` — making the catch's diagnostic dead for it. Moved the load to a guarded `await import()` inside the `try`; verified locally that `bun build --compile` still embeds the addon (bundle 7 modules) and round-trips (exit 0 in both default and `REQUIRE_ROUNDTRIP=1` modes).
  - `[low]` `[patch]` The decision-record summary table listed only Linux and Windows, silently omitting macOS even though the product ships darwin binaries — implying the shipped platforms were covered. Added an explicit `macOS — out of scope / deferred` row + a disclosure note (validation itself remains deferred in the ledger).
  - `[low]` `[patch]` `formatErrorDetail`'s truncation is code-point-based, but the only bound test used ASCII and asserted on `.length` (UTF-16 units), so a regression to UTF-16 slicing (split surrogate) would pass. Added an astral-character (`😀`) truncation test asserting on `[...detail].length` and surrogate integrity (keychain.test.ts 19 → 20, full suite 113 → 114).
- deferred (new ledger entry): invalid-argument errors (empty/blank `service`/`account` making `new Entry()` throw) are classified as `unavailable` by the wrapper's catch-all — Story 2.2's caller-supplied-identifier API should distinguish an argument bug from a real backend outage rather than silently triggering the passphrase fallback.
- rejected (representative): `isNotFoundError` substring misclassifies an unavailable-backend error containing "not found" (already tracked — typed-error-codes defer entry; the robust fix needs Windows-observed error shapes); throw-path never exercised on tested platforms (documented residual — Windows pending CI); empty-string `""` surfaces as `found` and macOS unvalidated (both already in the ledger — not re-opened); Bun version skew (1.2.0 CI / 1.3.14 local — the `>=1.2.0` floor attestation is a defensible choice, not a defect); redaction contract wording is best-effort not absolute (verbatim + collapsed forms covered; encoded-echo leak is theoretical for @napi-rs/keyring); test blocks share `SERVICE`/`ACCOUNT` (deterministic under Bun's sequential in-file execution); gnome-keyring env not exported and Windows plain `bun test` lacks `REQUIRE_ROUNDTRIP` (the compiled-binary check with `REQUIRE_ROUNDTRIP=1` is the enforcing per-leg proof and backstops both); native-check cleanup not in `finally` (random-UUID throwaway probe, wrappers never throw, `process.exit` would skip `finally` anyway).

## Design Notes

- **WSL2 / headless-Linux gotcha:** Secret Service needs D-Bus plus an unlocked keyring; without it the library throws. The wrapper must translate that into a typed keychain-unavailable result — this is exactly the signal Story 2.3's passphrase fallback keys off. Treat "unavailable" as a documented outcome, not something to paper over.
- **Compiled-binary NAPI check:** the product ships via `bun build --compile`. A native `.node` addon may not embed cleanly. The decision record should note whether the keyring native module loads from the compiled binary (not only under `bun test`), since that is the real distribution path. Keep this a documented finding; remediation, if needed, is a follow-up (log to `deferred-work.md`).
- **Keep the wrapper minimal:** service/account naming and result shapes only need to prove the path; the durable store API is designed in Story 2.2. Follow the existing Core conventions — kebab-case module, leading docstring, explicit `.ts` import extensions, `import type` for type-only imports, co-located `*.test.ts` using `bun:test`.

## Verification

**Commands:**
- `bun install` -- expected: `@napi-rs/keyring@1.3.0` resolved, `bun.lock` updated
- `bun x tsc --noEmit` -- expected: no type errors
- `bun test src/core/keychain.test.ts` -- expected: smoke completes deterministically; either round-trip passes or keychain-unavailable is cleanly reported (no unhandled throw, no residual entries)

**Manual checks:**
- `docs/keyring-spike-decision.md` states per-platform go/no-go plus the chosen key-management path, matching the observed local result and CI results.

## Auto Run Result

Status: **done** (followup review recommended)

**Implemented change:** Spike validating `@napi-rs/keyring@1.3.0` under Bun. Added a minimal Ring-1 keychain wrapper with typed, never-throwing results (`stored`/`found`/`not-found`/`deleted`/`unavailable`), a repeatable self-cleaning `bun test` smoke that stays green whether the platform round-trips or reports keychain-unavailable, a compiled-binary native-load check mirroring the `bun build --compile` distribution path, a CI matrix (ubuntu + windows) that proves a real round-trip per platform, and a per-platform go/no-go decision record. Locally (WSL2 with a live Secret Service) the real round-trip passed and the native addon loaded cleanly from the compiled binary.

**Files changed:**
- `package.json` / `bun.lock` — pin `@napi-rs/keyring` at exactly `1.3.0`
- `src/core/keychain.ts` (new) — typed keychain wrapper; `unavailable` is the fail-safe signal for Story 2.3's passphrase fallback; exported pure helpers `isNotFoundError` / `formatErrorDetail` (secret-redacting, length-bounded)
- `src/core/keychain.test.ts` (new) — repeatable smoke + unit tests for the classification/format helpers (18 tests)
- `scripts/keyring-native-check.ts` (new) — compiled-binary native-load check; `KEYRING_REQUIRE_ROUNDTRIP=1` mode fails unless a real round-trip occurred
- `.github/workflows/keyring-spike.yml` (new) — matrix (ubuntu+windows), pinned Bun, provisions Secret Service on Linux, require-roundtrip on both legs
- `docs/keyring-spike-decision.md` (new) — per-platform decision record + provisional-classification caveat
- `_bmad-output/implementation-artifacts/deferred-work.md` — one forward-looking defer entry

**Review findings breakdown:** 6 patches applied (0 high / 4 medium / 2 low), 1 deferred, 7 rejected. No intent_gap, no bad_spec, no repair loopback.

**Verification performed:**
- `bun x tsc --noEmit` → no type errors
- `bun test` (full suite) → 112 pass / 0 fail
- `bun test src/core/keychain.test.ts` → 18 pass / 0 fail, no residual entries
- `bun scripts/keyring-native-check.ts` (default and `KEYRING_REQUIRE_ROUNDTRIP=1`) → real round-trip observed, exit 0

**Residual risks:**
- Windows go/no-go is **pending the CI Windows leg** — not runnable in this Linux/WSL environment; recorded as pending (not a fabricated pass). Story 2.2 must not commit Windows to the keychain path until that leg is green.
- The throw-path not-found/unavailable classification uses an English substring heuristic (fail-safe toward `unavailable`); replacing it with typed error codes once real Windows/localized error shapes are observed is logged in `deferred-work.md`.

---

## Auto Run Result — follow-up review pass (2026-07-06)

A fresh adversarial + edge-case review pass on the closed spike surfaced 3 patch-worthy findings; all were fixed. No intent_gap, no bad_spec, no repair loopback.

**Patches applied (3):**
- `[medium]` `src/core/keychain.ts` — `formatErrorDetail` now redacts the secret BEFORE whitespace normalization (and re-redacts the collapsed form after), closing a hole where a whitespace-bearing secret echoed by a native error could survive into `detail`. Truncation is now code-point-safe. Regression test added.
- `[medium]` `.github/workflows/keyring-spike.yml` — pinned `shell: bash` on the non-Linux compiled-binary step so the Windows leg resolves the `.exe` emitted by `bun build --compile` (PowerShell default would not).
- `[low]` `.github/workflows/keyring-spike.yml` — added `timeout-minutes: 15` to the spike job.

**Deferred (2 new ledger entries):** macOS keychain path unvalidated by the spike (product ships darwin binaries; matrix is ubuntu+windows by spec); empty-string keychain value surfaces as `found` — Story 2.2 key-load must decide if `""` is a valid key.

**Verification performed:**
- `bun x tsc --noEmit` → no type errors
- `bun test` (full suite) → 113 pass / 0 fail (was 112; +1 regression test)
- `bun test src/core/keychain.test.ts` → 19 pass / 0 fail, no residual entries
- `bun scripts/keyring-native-check.ts` → real round-trip observed (`stored → found(matches) → deleted`), exit 0

**Residual risks (unchanged):** Windows go/no-go still pending the CI Windows leg; the `shell: bash` fix for that leg is only truly confirmable when the Windows leg runs. The substring classifier remains provisional (deferred).

---

## Auto Run Result — follow-up review pass #2 (2026-07-06)

A third adversarial + edge-case review pass on the closed spike surfaced 4 patch-worthy findings; all were fixed. No intent_gap, no bad_spec, no repair loopback. Most of the reviewers' remaining findings were already tracked in the deferred-work ledger (the `isNotFoundError` heuristic, macOS validation, empty-string key) and were not re-opened, per the orchestrator owning ledger status.

**Patches applied (4):**
- `[medium]` `docs/keyring-spike-decision.md` — resolved a header contradiction (`Status: open` vs `Risk retired: AR-20`); AR-20 is now stated as **partially retired** (Linux proven; Windows pending CI; macOS out of scope), matching the open status.
- `[low]` `scripts/keyring-native-check.ts` — moved the `keychain.ts` load into a guarded `await import()` inside the `try` so a compiled-binary native-load failure is actually caught and reported (a top-level static import threw before the `try`, leaving the catch's diagnostic dead). Verified `bun build --compile` still embeds the addon and round-trips.
- `[low]` `docs/keyring-spike-decision.md` — added an explicit `macOS — out of scope / deferred` row + disclosure to the summary table so the artifact no longer implies the shipped platforms were all covered.
- `[low]` `src/core/keychain.test.ts` — added an astral-character truncation test asserting on code points (locks the code-point truncation behavior against a UTF-16-slicing / split-surrogate regression).

**Deferred (1 new ledger entry):** the wrapper classifies invalid-argument throws (empty/blank `service`/`account`) as `unavailable`; Story 2.2's caller-supplied-identifier API should separate an argument bug from a real backend outage.

**Verification performed:**
- `bun x tsc --noEmit` → no type errors
- `bun test` (full suite) → 114 pass / 0 fail (was 113; +1 astral truncation test)
- `bun test src/core/keychain.test.ts` → 20 pass / 0 fail, no residual entries
- `bun build --compile scripts/keyring-native-check.ts` then run → real round-trip (`stored → found(matches) → deleted`), exit 0 in both default and `KEYRING_REQUIRE_ROUNDTRIP=1` modes — confirms the dynamic import does not change what `--compile` embeds

**Residual risks (unchanged):** Windows go/no-go still pending the CI Windows leg (the native-check dynamic-import + `shell: bash` behavior on Windows is only fully confirmable when that leg runs). The substring classifier and macOS/empty-string decisions remain deferred to Story 2.2.
