---
title: 'DW-13: Distinguish keychain invalid-argument from backend-unavailable in the Ring-1 wrapper'
type: 'bugfix'
created: '2026-07-17'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '8de65778c6ecb953614c6c571e67d6d7d6bdec6e'
final_revision: 'd40b4384543220d20c5c9f8889933ddb691ebe46'
context: ['_bmad-output/implementation-artifacts/spec-2-1-keyring-spike.md']
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** `setSecret`/`getSecret`/`deleteSecret` (`src/core/keychain.ts`) route every thrown error that isn't recognized as not-found straight to `unavailable`. An empty/blank `service` or `account` makes `new Entry()` throw, so a caller programming error would masquerade as a missing keychain backend and silently trigger Story 2.3's passphrase fallback instead of surfacing the bug. Harmless in Story 2.1 (identifiers are hardcoded non-empty constants), but Story 2.2 accepts caller-supplied identifiers where an argument bug becomes indistinguishable from a real keychain outage.

**Approach:** Add a distinct first-class typed outcome `invalid-argument` to all three wrapper result unions and guard each entry point with a pure, deterministic validation of `service`/`account` that runs BEFORE any `new Entry(...)` call — so an empty or whitespace-only identifier returns `invalid-argument` (a surfaced programming error) rather than being caught and mislabeled `unavailable`. Genuine backend failures keep failing safe to `unavailable`.

## Boundaries & Constraints

**Always:**
- The identifier validation is pure, deterministic, and runs before the identifiers reach `new Entry(...)` (i.e. before the native store) in `setSecret`, `getSecret`, and `deleteSecret`.
- `invalid-argument` triggers on an `service` or `account` that is empty (`""`) or blank (whitespace-only after trim). Its `detail` names WHICH identifier is bad and is single-line and bounded — it MUST NOT contain the secret `value` passed to `setSecret`.
- `invalid-argument` is added as a new member to `KeychainSetResult`, `KeychainGetResult`, `KeychainDeleteResult`, and the `KeychainOutcome` discriminant union, each shaped `{ readonly outcome: "invalid-argument"; readonly detail: string }`.
- A genuine backend failure (D-Bus down, locked keychain, unknown native throw) still fails safe to `unavailable`; the not-found classification path is unchanged.
- The module's existing invariants hold: never throws, never writes/logs plaintext, secret VALUES never appear in any `detail`.
- Update the module docstring contract to name `invalid-argument` as a first-class outcome distinct from `unavailable`.

**Block If:**
- Resolving the classification would require changing a downstream consumer's control flow in a way that alters credential-store or passphrase-fallback behavior beyond accommodating the new (unreachable-for-them) outcome.

**Never:**
- Do not remove or weaken the `unavailable` fail-safe for unknown native throws, nor the `isNotFoundError` not-found path.
- Do not change `src/core/store-key.ts` behavior: it uses fixed non-empty constants, so `invalid-argument` is unreachable there (invariant already documented at its module header). Leave it unchanged.
- Do not echo the secret `value` or any caller-supplied secret into an `invalid-argument` detail.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md` (the orchestrator records DW-13 resolution).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty service, any op | `service=""`, valid account | `{ outcome: "invalid-argument", detail }` naming `service`; `new Entry` never called | Surfaced, not masked as unavailable |
| Blank account, any op | `account="   "` (whitespace), valid service | `{ outcome: "invalid-argument", detail }` naming `account` | Surfaced, not masked as unavailable |
| Valid identifiers, backend present | non-blank service+account | round-trips as before (`stored`/`found`/`deleted`/`not-found`) | Unchanged |
| Valid identifiers, backend down | non-blank ids, D-Bus/keychain unreachable | `unavailable` with secret-free detail | Fail-safe unchanged |
| `setSecret` invalid arg + secret value | empty service, non-empty `value` | `invalid-argument`; `detail` never contains `value` | No secret leak |

</intent-contract>

## Code Map

- `src/core/keychain.ts` -- add `invalid-argument` to the three result unions + `KeychainOutcome`; add a pure `validateIdentifiers(service, account)` guard (exported for unit test) returning a secret-free reason string or `null`; call it first in `setSecret`/`getSecret`/`deleteSecret`; update the module docstring contract.
- `src/core/keychain.test.ts` -- add coverage for the new guard and outcome across all three functions and both empty/blank forms, plus a no-secret-leak assertion for `setSecret`.
- `src/core/store-key.ts` -- reference only; consumer of the unions, provably unaffected (fixed non-empty constants). Read to confirm it still compiles; do not modify.
- `_bmad-output/implementation-artifacts/spec-2-1-keyring-spike.md` -- reference (origin of DW-13 and the module's typed-outcome conventions).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/keychain.ts` -- add the `invalid-argument` union member to `KeychainSetResult`/`KeychainGetResult`/`KeychainDeleteResult` and `KeychainOutcome`; add exported pure `validateIdentifiers(service, account): string | null` (empty or trim-blank → reason naming the offending identifier, else `null`); invoke it at the top of each of the three functions and return `{ outcome: "invalid-argument", detail }` when non-null, before `openEntry`/`new Entry`; revise the module docstring contract to list `invalid-argument` as first-class and distinct from `unavailable` -- surfaces caller programming errors instead of masquerading them as a missing backend.
- [x] `src/core/keychain.test.ts` -- add tests: for each of `setSecret`/`getSecret`/`deleteSecret`, an empty (`""`) and a blank (whitespace-only) `service` and `account` yield `invalid-argument`; a valid pair does NOT; `validateIdentifiers` returns `null` for valid and a non-empty reason for invalid; `setSecret` with an empty identifier and a non-empty secret value produces a detail that does not contain the value -- locks the classification and the no-leak contract.

**Acceptance Criteria:**
- Given a caller passes an empty or whitespace-only `service` or `account`, when any of the three wrapper functions runs, then it returns `invalid-argument` with a secret-free, identifier-naming detail and no native `Entry` is constructed — the error is surfaced, not routed to `unavailable`.
- Given valid non-blank identifiers, when the backend is present, then the wrapper round-trips exactly as before; and when the backend is unreachable, then it still returns `unavailable` — the fail-safe and not-found paths are unchanged.
- Given the widened result unions, when the project type-checks and `bun test` runs, then `src/core/store-key.ts` and all other consumers compile and their existing tests pass unchanged (no consumer relies on an exhaustive switch over the old outcome set).

## Spec Change Log

_No bad_spec loopback occurred; empty._

## Review Triage Log

### 2026-07-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 0
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[patch]` `validateIdentifiers` called `.trim()` before any `typeof` check, so a `null`/`undefined`/non-string identifier from an untyped/IPC/JSON caller threw an uncaught `TypeError` — a regression of the module's never-throws contract (pre-change such input was caught as `unavailable`). Added a `typeof … !== "string"` check first in each branch so non-string identifiers classify as `invalid-argument` without throwing; added unit + per-wrapper tests for the `null`/`undefined`/non-string path.
  - `[low]` `[patch]` The three per-function JSDoc blocks (`setSecret`/`getSecret`/`deleteSecret`) still listed only the old outcomes; updated each to name `invalid-argument` so callers reading the function contract see it as reachable.
  - `[low]` `[patch]` Removed a duplicate assertion (`validateIdentifiers(SERVICE, ACCOUNT)` returns null) that appeared in both the `validateIdentifiers` and `invalid-argument` describe blocks.
  - `[low]` `[patch]` Refreshed the test-file header docstring to mention the added `validateIdentifiers`/`invalid-argument` coverage.
- rejected (noise / by-design, not fixed): storing the un-trimmed identifier as the native key (deliberate — reject blank without silently mutating caller identifiers); the `setSecret` no-secret-leak assertion being structurally guaranteed (spec-mandated, harmless); valid-pair wrapper tests touching the live keychain under the shared `afterAll` cleanup (matches the existing round-trip test's pattern; the `!== invalid-argument` assertion is intentionally weak to stay green on a keychain-less CI leg); the `invalid-argument` detail bypassing `MAX_DETAIL_LEN` (short constant strings, already bounded); zero-width code points passing the guard (consistent with the spec's explicit `.trim().length === 0` definition of blank).

## Design Notes

Validation is deterministic and locale-independent — the opposite of the fragile English-substring `isNotFoundError` heuristic. Prefer an explicit up-front guard over classifying `new Entry`'s throw: the guard is the only way to keep the secret-free/no-throw contract while distinguishing the two conditions reliably.

```ts
/** Pure. Returns a secret-free reason if service/account is empty/blank, else null. */
export function validateIdentifiers(service: string, account: string): string | null {
  if (service.trim().length === 0) return "service must be a non-empty, non-blank string";
  if (account.trim().length === 0) return "account must be a non-empty, non-blank string";
  return null;
}
// first line of each fn: const bad = validateIdentifiers(service, account);
//   if (bad) return { outcome: "invalid-argument", detail: bad };
```

## Verification

**Commands:**
- `bun test src/core/keychain.test.ts` -- expected: all keychain tests pass, including the new invalid-argument cases.
- `bun test src/core/store-key.test.ts` -- expected: consumer tests pass unchanged (no behavior drift).
- `bunx tsc --noEmit` -- expected: no type errors from the widened unions (all consumers still compile).

## Auto Run Result

Status: done

**Summary of implemented change:** Hardened the Ring-1 keychain wrapper (`setSecret`/`getSecret`/`deleteSecret`) to distinguish a caller programming error (missing/empty/blank `service` or `account`) from a genuine backend-unavailable condition. Added a first-class `invalid-argument` typed outcome to all three result unions (and thus `KeychainOutcome`), plus a pure `validateIdentifiers` guard that runs before any identifier reaches `new Entry(...)`. Previously every non-not-found throw was classified `unavailable`, so an argument bug would masquerade as a missing keychain backend and silently trigger Story 2.3's passphrase fallback (DW-13). The genuine-unavailable fail-safe and the `not-found` path are unchanged.

**Files changed:**
- `src/core/keychain.ts` -- added `invalid-argument` union member to `KeychainSetResult`/`KeychainGetResult`/`KeychainDeleteResult`; added exported pure `validateIdentifiers(service, account)` (non-string/empty/blank → secret-free reason naming the offending identifier, else `null`); invoked it first in each wrapper; updated the module + per-function docstrings.
- `src/core/keychain.test.ts` -- added `validateIdentifiers` unit tests and an `invalid-argument` matrix across all three wrappers (empty/blank/null/undefined/non-string), plus a no-secret-leak assertion.
- `src/core/store-key.ts` -- unchanged (sole consumer; uses fixed non-empty constants and if/else, so `invalid-argument` is unreachable there and the union widening is type-safe).

**Review findings breakdown:** 4 patches applied (1 medium: null/undefined/non-string guard hardening to preserve the never-throws contract; 3 low: per-function JSDoc, a duplicate test assertion, and the test-file header docstring). 0 deferred. 5 rejected as noise/by-design (un-trimmed key storage, structurally-guaranteed no-leak test, live-keychain valid-pair tests, uncapped `invalid-argument` detail, zero-width code points). No intent_gap or bad_spec; no repair loopback.

**Verification performed:**
- `bun test src/core/keychain.test.ts src/core/store-key.test.ts` -- 53 pass, 0 fail, 119 expect() calls.
- `bunx tsc --noEmit` -- exit 0, no type errors.

**Residual risks:** Low. `invalid-argument` is unreachable from current consumers (fixed non-empty constants); its value arrives once Story 2.2 passes caller-supplied identifiers. "Blank" is defined as `.trim().length === 0`, so non-trimmed invisible code points (e.g. zero-width space) are treated as valid identifier content by design.
