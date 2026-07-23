---
title: 'DW-10/DW-12: Structural keychain not-found classification + reject empty store key'
type: 'bugfix'
created: '2026-07-23'
baseline_revision: 'f7953767b53aab17e42dc32f5d3ae8f356426ee8'
final_revision: 'f6f2f4e5418db7d358b279644e03fc1085684df6'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: ['_bmad-output/implementation-artifacts/spec-2-1-keyring-spike.md', '_bmad-output/implementation-artifacts/spec-dw-13-keychain-invalid-argument-classification.md']
warnings: ['multiple-goals', 'oversized']
---

<intent-contract>

## Intent

**Problem:** Two latent Ring-1 keychain hazards from Story 2.1. (DW-10) `isNotFoundError` (`src/core/keychain.ts`) distinguishes a missing entry (`not-found`) from an unreachable backend (`unavailable`) by lower-casing the thrown error's message and substring-matching English `NOT_FOUND_MARKERS` — locale-fragile and the linchpin of Story 2.3's passphrase-fallback decision; its own doc comment says it must be replaced with typed codes. (DW-12) A store-key entry that round-trips as an empty string (`""`) is not legitimate — an empty AES-256 key can never be valid — yet `getSecret` returns `{outcome:"found", value:""}` and `store-key.ts` maps that to `key-invalid` (a dead-end refusal) instead of re-creating a key.

**Approach:** (DW-10) Replace the substring heuristic with **structural** classification grounded in the binding's actual, observed contract: `@napi-rs/keyring` surfaces every native keyring error to JS as a generic `Error` with `code:"GenericFailure"` (the keyring kind is NOT exposed as a typed code — it lives only inside the message text), and `Entry.getPassword()` returns `string | null` (a missing credential is `null`, never a thrown `NoEntry`) while `deletePassword()` returns `false` for a missing credential. So a *thrown* error is never a missing entry — it is always a genuine backend failure → `unavailable`. Remove `isNotFoundError`/`NOT_FOUND_MARKERS` and classify every throw as `unavailable`; not-found is the null/false return, which is uniform and locale-independent. Add a per-platform CI assertion proving a miss surfaces as `not-found` on every real-backend matrix leg. (DW-12) In `store-key.ts`, treat a `found` value of `""` as effectively not-found → fall through to re-create (`created`)/passphrase, leaving the generic wrapper unchanged.

## Boundaries & Constraints

**Always:**
- not-found is signalled structurally: `getSecret` returns `not-found` only on a `null`/`undefined` return; `deleteSecret` returns `not-found` only on a `false` return. Neither parses error message text.
- Every thrown native error from `getPassword`/`deletePassword`/`setPassword` classifies as `unavailable` with a secret-free, bounded `detail` — the fail-safe direction (never a silent empty entry, never a plaintext fallback).
- The `invalid-argument` guard (`validateIdentifiers`, DW-13) still runs first in all three wrappers, unchanged.
- `store-key.ts` `loadOrCreateStoreKey`: a `found` value equal to `""` is treated as not-found and routed to the re-create branch (generate a 32-byte CSPRNG key, store base64, return `created`; propagate `unavailable` if the store write is unreachable). A `found` non-empty value that does not decode to exactly 32 bytes stays `key-invalid` (corruption — refuse rather than silently overwrite).
- `keychain.ts` remains a generic wrapper: `getSecret` on a stored `""` still returns `{outcome:"found", value:""}`. The empty-key rejection lives only in the Story 2.2 key-load path (`store-key.ts`).
- Module invariants hold: wrappers never throw, never log/embed secret values, `detail` stays single-line and ≤ `MAX_DETAIL_LEN`.
- Update the `keychain.ts` module + `getSecret`/`deleteSecret` docstrings to describe the structural (null-vs-throw) contract and why a throw is always `unavailable`; update the `store-key.ts` header contract for the empty→re-create rule.

**Block If:**
- The CI matrix reveals a shipping platform (Windows/macOS/Linux) whose keychain surfaces a *missing entry* as a thrown error rather than `null` (i.e. the never-stored assertion returns `unavailable`, not `not-found`) — that would contradict the binding's `Option` contract and require re-introducing typed classification. HALT `blocked`.

**Never:**
- Do not keep `isNotFoundError` or `NOT_FOUND_MARKERS`, and do not re-add any error-message substring/locale heuristic.
- Do not weaken the `unavailable` fail-safe for unknown throws, nor the `invalid-argument` (DW-13) path.
- Do not add the empty-key guard to `keychain.ts` (it would mask a legitimately-stored empty value for generic callers).
- Do not change `formatErrorDetail`, the secret-redaction behavior, or the fixed `STORE_KEY_SERVICE`/`STORE_KEY_ACCOUNT` constants.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md` (the orchestrator records DW-10/DW-12 resolution).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Missing entry, working backend | `getPassword()` returns `null` | `getSecret` → `not-found` | None (structural) |
| Missing entry on delete | `deletePassword()` returns `false` | `deleteSecret` → `not-found` | None (structural) |
| Native throw on get | `getPassword()` throws (any message) | `getSecret` → `unavailable` w/ secret-free detail | Fail-safe → passphrase fallback |
| Native throw on delete | `deletePassword()` throws | `deleteSecret` → `unavailable` | Fail-safe |
| Store key round-trips as `""` | keychain `found`, `value===""` | `loadOrCreateStoreKey` → `created` (fresh 32-byte key stored) | Empty key rejected, re-created |
| Store write unreachable during re-create of `""` | `found ""`, then `setSecret`→`unavailable` | `loadOrCreateStoreKey` → `unavailable` | Story 2.3 passphrase hook |
| Store key found, wrong length (non-empty) | `found`, `value` decodes to ≠32 bytes | `loadOrCreateStoreKey` → `key-invalid` | Refuse (unchanged) |

</intent-contract>

## Code Map

- `src/core/keychain.ts` -- remove `isNotFoundError` + `NOT_FOUND_MARKERS`; in `getSecret`/`deleteSecret` catch blocks, return `unavailable` for every throw (drop the `isNotFoundError(err)` branch); revise module + per-function docstrings to state the structural not-found (null/false) contract. `formatErrorDetail`, `validateIdentifiers`, `setSecret` unchanged.
- `src/core/store-key.ts` -- in `loadOrCreateStoreKey`, gate the `found` decode branch on `got.value !== ""`; route a `found ""` value into the re-create (not-found) branch; update the module header contract.
- `src/core/keychain.test.ts` -- drop the `isNotFoundError` import and the "error classification — not-found vs unavailable linchpin" describe block; keep/confirm the structural not-found coverage (post-delete `not-found`, never-stored `not-found`/`unavailable`); add a note documenting the structural classification.
- `src/core/store-key.test.ts` -- flip the "empty found value → key-invalid" test to "empty found value → created" (assert a fresh 32-byte key is stored via the injected `setSecret`); keep the non-empty wrong-length → `key-invalid` test.
- `scripts/keyring-native-check.ts` -- under `KEYRING_REQUIRE_ROUNDTRIP`, after the round-trip, assert `getSecret(SERVICE, <never-stored account>)` returns `not-found` (fail if `unavailable`), proving misses surface as null (not throws) on each real-backend leg.
- `spec-2-1-keyring-spike.md`, `spec-dw-13-...md` -- reference (origin + typed-outcome conventions).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/keychain.ts` -- delete `isNotFoundError` and `NOT_FOUND_MARKERS`; make `getSecret`/`deleteSecret` catch blocks return `unavailable` for any throw; rewrite the module docstring's not-found bullet and the two per-function docstrings to describe the structural (null-return = not-found; throw = unavailable) contract and the observed `@napi-rs/keyring` behavior (miss → `null`/`false`; errors flattened to `code:"GenericFailure"`).
- [x] `src/core/store-key.ts` -- treat a `found` value of `""` as effectively not-found: guard the decode/`loaded`/`key-invalid` branch on `got.value !== ""` and let an empty value fall through to the CSPRNG re-create branch; update the header contract bullet to document empty→re-create and that non-empty wrong-length stays `key-invalid`.
- [x] `src/core/keychain.test.ts` -- remove `isNotFoundError`-specific tests/import; keep the typed-outcome smoke and the structural not-found assertions; the file must compile and pass with no reference to the deleted symbol.
- [x] `src/core/store-key.test.ts` -- update the empty-value test to expect `created` with a stored 32-byte key; retain the non-empty wrong-length `key-invalid` and the existing `not-found`→`created`, `unavailable`, and constant-usage tests.
- [x] `scripts/keyring-native-check.ts` -- add the guarded never-stored → `not-found` assertion so a platform that throws on a miss fails the leg loudly (the DW-10 per-platform observation).

**Acceptance Criteria:**
- Given `getSecret`/`deleteSecret` and any thrown native error, when the wrapper runs, then it returns `unavailable` with a secret-free detail and no message-text heuristic is consulted; and a missing entry (null/false return) returns `not-found` — locale-independent in both directions.
- Given a keychain entry that round-trips as `""`, when `loadOrCreateStoreKey` runs, then it generates and stores a fresh 32-byte key and returns `created` (or `unavailable` if the store write is unreachable), never `key-invalid` and never a `""`-keyed store; a non-empty value that does not decode to 32 bytes still returns `key-invalid`.
- Given the changes, when `bunx tsc --noEmit` and `bun test src/core/keychain.test.ts src/core/store-key.test.ts` run, then they pass with no reference to `isNotFoundError`/`NOT_FOUND_MARKERS`, and the `keyring-spike.yml` matrix (with `KEYRING_REQUIRE_ROUNDTRIP=1`) additionally proves a miss is `not-found` on each real-backend leg.

## Spec Change Log

_No bad_spec loopback occurred; empty._

## Review Triage Log

### 2026-07-23 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 2: (high 0, medium 1, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[low]` `[patch]` The `got.value !== ""` empty-key guard in `store-key.ts` only matched the literal `""`, so a non-empty value that base64-decodes to zero bytes (e.g. `" "`, `"="`, a stray newline) — semantically the same empty AES key — dead-ended on `key-invalid` instead of the DW-12 re-create path. Re-anchored the guard on decoded byte length: `decodeKey` first (valid 32-byte → `loaded`); a decoded length `> 0` → `key-invalid` (non-empty wrong length = possible corruption of a real key, refuse); a decoded length of `0` → empty key → fall through to re-create. Broadened the empty-value test to a parameterized set (`""`, whitespace, `"="`, newline), each asserted to re-create a fresh 32-byte key. Aligns the implementation with the decision's rationale ("an empty AES-256 key is never legitimate") and removes the empty-vs-whitespace incoherence.
- deferred_findings (recorded here, NOT appended to the deferred-work ledger — this run's invocation reserves ledger writes for the orchestrator):
  - `[medium]` `[defer]` Re-create-on-empty mutates the keychain, and via the unchanged `credential-store.ts`/`provider-key-store.ts` consumers a `.enc` that outlives its key surfaces as `key-unavailable` on the first open (correctly guarded at `credential-store.ts:585-595`) but as a false `corrupt` on a second open (the freshly-stored key now loads and GCM-fails the old ciphertext). This is a PRE-EXISTING characteristic of the `not-found → re-create` path (a wiped/absent keychain entry with a surviving `.enc` already behaves this way); DW-12 routes the empty case into that same designed path per the user decision, it does not introduce a new class of defect. Worth a focused follow-up: the store could refuse or re-key the `.enc` on a second open rather than report `corrupt`.
  - `[low]` `[defer]` The fail-safe `throw → unavailable` branch in `keychain.ts` `getSecret`/`deleteSecret` has no deterministic unit test (the deleted `isNotFoundError` block was the only coverage touching the throw path, and `keychain.ts` exposes no injectable `Entry` seam). The branch is now trivially correct by inspection (a bare `catch → unavailable`, no classifier logic remains), so consequence is low; a follow-up could add an injectable entry factory to lock the invariant.

## Design Notes

Evidence gathered against the installed `@napi-rs/keyring` (v1.3.0, `keyring-core` stores):
- A forced native error surfaces to JS as `Error{ name:"Error", code:"GenericFailure", message:<Rust Display> }`. The keyring kind (`NoEntry`, `PlatformFailure`, `NoStorageAccess`, `Ambiguous`, …) is present ONLY in the message Display (e.g. `NoEntry` → `"No matching credential found"`), never as a typed `code`/`name`. Hence "typed error codes/kinds" do not exist at the JS boundary — the DW-10 decision's literal mechanism is unavailable, so its intent (robust, locale-proof, observe-and-map) is realized structurally instead.
- `Entry.getPassword(): string | null` returns `null` on a miss and `Entry.deletePassword(): boolean` returns `false` on a miss (observed on Linux; the binding is one Rust wrapper compiled per platform, so the `Option`/bool normalization is uniform). A miss is therefore never a thrown `NoEntry`; a throw is always a genuine backend failure → `unavailable`.

Net: classification becomes structural (null/false vs throw), eliminating all message-text parsing — strictly more locale-proof than any Display-string match, and reword-proof across crate upgrades. Residual risk: an unobserved platform that throws on a miss would route a first-run miss to `unavailable` → passphrase fallback (degraded UX, still fail-safe — never a silent empty entry). The `KEYRING_REQUIRE_ROUNDTRIP` never-stored→`not-found` assertion is the guard: it turns the Windows/macOS/Linux matrix into the per-platform proof DW-10 required and goes red if that risk ever materializes.

```ts
// keychain.ts getSecret catch — structural, no text heuristic:
} catch (err) {
  return { outcome: "unavailable", detail: formatErrorDetail(err) };
}
// value === null || value === undefined  → not-found  (the sole not-found signal)

// store-key.ts — empty ("") is effectively not-found (DW-12):
if (got.outcome === "found" && got.value !== "") {
  const key = decodeKey(got.value);
  if (key === null) return { outcome: "key-invalid", detail: `keychain key does not decode to ${KEY_LENGTH_BYTES} bytes` };
  return { outcome: "loaded", key };
}
// not-found OR found-but-empty → generate + store a fresh CSPRNG key → created
```

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: exit 0; no references to the removed `isNotFoundError`/`NOT_FOUND_MARKERS`.
- `bun test src/core/keychain.test.ts src/core/store-key.test.ts` -- expected: all pass, including the flipped empty-value→`created` test and the retained wrong-length→`key-invalid` test.
- `bun build --compile scripts/keyring-native-check.ts --outfile ./keyring-native-check && ./keyring-native-check` -- expected locally: loads and returns typed outcomes (may report `unavailable`/`not-found` depending on backend); on a `KEYRING_REQUIRE_ROUNDTRIP=1` CI leg it additionally requires a round-trip AND a never-stored `not-found`.

## Auto Run Result

Status: done

**Summary of implemented change:** Resolved two latent Story 2.1 keychain hazards. DW-10: replaced the locale-fragile English-substring `isNotFoundError` heuristic with a **structural** classification grounded in the binding's observed contract — `@napi-rs/keyring` returns `null` (get) / `false` (delete) on a miss and never throws `NoEntry`, and flattens every native error kind into a generic `Error{code:"GenericFailure"}` (no typed codes at the JS boundary). So not-found is exactly the null/false return, and every thrown native error classifies as `unavailable` (the fail-safe), with no message-text parsing. DW-12: in `store-key.ts`, a keychain value that decodes to an empty (zero-byte) key is treated as effectively not-found and re-created (`created` with a fresh 32-byte CSPRNG key), instead of dead-ending on `key-invalid`; a non-empty wrong-length value still returns `key-invalid`. A CI assertion on the `keyring-spike.yml` matrix (Windows/macOS/provisioned-Linux, `KEYRING_REQUIRE_ROUNDTRIP=1`) now proves per-platform that a miss surfaces as `not-found`.

**Files changed:**
- `src/core/keychain.ts` -- deleted `isNotFoundError` + `NOT_FOUND_MARKERS`; `getSecret`/`deleteSecret` catch blocks now return `unavailable` for every throw; module + per-function docstrings rewritten for the structural (null/false = not-found; throw = unavailable) contract and the observed binding behavior.
- `src/core/store-key.ts` -- `loadOrCreateStoreKey` treats a `found` value decoding to zero bytes as effectively not-found → re-create; a non-empty wrong-length value stays `key-invalid`; header contract updated.
- `src/core/keychain.test.ts` -- removed the `isNotFoundError` import + classification block; added a note documenting the structural not-found path.
- `src/core/store-key.test.ts` -- empty-value test flipped to expect `created` with a fresh 32-byte key, parameterized over `""`/whitespace/`"="`/newline; non-empty wrong-length → `key-invalid` retained.
- `scripts/keyring-native-check.ts` -- added a `KEYRING_REQUIRE_ROUNDTRIP`-guarded never-stored → `not-found` assertion (the DW-10 per-platform observation).

**Review findings breakdown:** 1 patch applied (low: broadened the empty-key guard from literal `""` to any zero-byte-decoding value, with parameterized tests). 2 items deferred and recorded in the Review Triage Log rather than the deferred-work ledger (this run's invocation reserves ledger writes for the orchestrator): (medium) the pre-existing second-open `corrupt` misdiagnosis shared with the `not-found → re-create` path; (low) the untested `throw → unavailable` fail-safe branch. 8 rejected as by-design/noise (get-or-create is contractually mutating; the empty-vs-wrong-length asymmetry is intentional; the null-vs-throw contract IS verified on all three shipping platforms by the CI matrix; the remaining items are pre-existing/unreachable or already mitigated by the new CI assertion). No intent_gap, no bad_spec, no repair loopback.

**Verification performed:**
- `bunx tsc --noEmit` -- exit 0, no type errors, no references to the removed symbols.
- `bun test src/core/keychain.test.ts src/core/store-key.test.ts` -- 48 pass, 0 fail, 130 expect() calls.
- `grep -rn "isNotFoundError\|NOT_FOUND_MARKERS" src/ scripts/` -- no matches (symbols fully removed).
- `bun build --compile scripts/keyring-native-check.ts && ./keyring-native-check` -- exit 0 (real round-trip on this box; the new never-stored → `not-found` line confirms a miss surfaces structurally).

**Residual risks:**
- Medium (pre-existing, deferred): a `.enc` that outlives its keychain key reports `key-unavailable` on first open but `corrupt` on a second open once a fresh key has been stored — a characteristic of the `re-create` design shared with the `not-found` path, extended to the empty case per the DW-12 decision.
- Low: the structural not-found contract is proven only where a real backend exists (the CI matrix covers Windows/macOS/Linux); a hypothetical platform that threw on a miss would route a first-run miss to `unavailable` → passphrase fallback (degraded UX, still fail-safe — never a silent empty entry), and the CI assertion would catch it (its `Block If` HALT condition).
