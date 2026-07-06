---
title: 'Story 2.3: Keychain-unavailable passphrase fallback'
type: 'feature'
created: '2026-07-06'
status: 'done'
baseline_revision: '203e9c4fb1030694a966f086e5ba6ee0646012ed'
final_revision: '9c0735d3fcca40b98df76dc2f871ea64c2501057'
review_loop_iteration: 0
followup_review_recommended: true
context: ['_bmad-output/implementation-artifacts/epic-2-context.md']
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Story 2.2 built an encrypted credential store whose AES key lives in the OS keychain, and it surfaces a typed `unavailable` when no keychain exists — but there is no way to actually use Persistent mode on a keychain-less machine (headless/keychain-less Linux is a first-class v1 target). Today such a developer is simply locked out, and the store cannot tell a *keychain-key-lost-but-file-present* condition from a tampered file.

**Approach:** Add a passphrase-derived-key fallback path in Ring 1 (FR-5, UJ-2 edge case, AD-5). Derive a 32-byte key from a passphrase via scrypt (`node:crypto`, no new deps) with a per-store random salt; persist the salt + KDF params as a **non-secret** key descriptor so the key can be re-derived on reopen. When the keychain is unavailable, consult an injected passphrase provider (default: `QS_PASSPHRASE` env); if the developer declines, write nothing — never plaintext. The on-disk descriptor is authoritative for which key mode an existing store uses.

## Boundaries & Constraints

**Always:**
- All KDF, passphrase handling, the derived key, and decrypted credentials live only in Ring 1 (`src/core/`). Ring 2 (`src/ui/`) and `src/shared/` never hold a passphrase or a key.
- The passphrase-derived key uses **scrypt from `node:crypto`** (no new dependency), outputs exactly 32 bytes, and uses a per-store 16-byte CSPRNG salt. The scrypt params + salt are persisted as a **non-secret key descriptor**; the passphrase and the derived key are never written to disk and never logged (never embedded in any `detail` string).
- The on-disk key descriptor is **authoritative for an existing store**: a store created in passphrase mode is reopened via passphrase even if a keychain later becomes available, and a keychain-mode store stays keychain-mode. Keychain availability decides the key mode **only for a brand-new store** (no descriptor and no store file present).
- Plaintext is never written — not even as a fallback. If the passphrase is declined or empty, return the typed outcome and write nothing (no descriptor, no `.enc`).
- Reuse `crypto.ts` for encrypt/decrypt and `store-key.ts` / `keychain.ts` for the keychain path — do not duplicate crypto or re-implement keychain access.
- A keychain-mode store opened while the keychain is unavailable returns a distinct typed `key-unavailable` (file present, key gone) — never `corrupt`, never a silent overwrite (resolves the deferred key-lifecycle/file-lifecycle desync entry).
- Every new boundary function is total: typed `readonly` discriminated-union results, never throwing for expected conditions. Follow Core conventions: kebab-case modules, explicit `.ts` import extensions, inline `type` imports, co-located `bun:test`, JSDoc header citing FR-5 / AR-7 / AD-5.

**Block If:**
- An existing store file or key descriptor in an unrecognized on-disk format that this story would overwrite is found on the build platform — HALT rather than risk credential loss (greenfield: should not trigger; do not clobber if it does).

**Never:**
- Do not build Connection-management UI or an interactive passphrase-prompt UI/RPC surface (Story 2.4). Expose the passphrase only through the injected provider seam (default: `QS_PASSPHRASE` env var).
- Do not add any new crypto/KDF dependency (argon2, node-argon2, etc.) — use `node:crypto` scrypt only.
- Do not replace or "fix" the deferred `isNotFoundError` keychain classifier (AR-20); consume the wrapper's typed `unavailable` as-is (still fail-safe).
- Do not attempt to cryptographically distinguish a wrong passphrase from a tampered file — AES-GCM cannot; both surface as `corrupt`. Retry UX belongs to Story 2.4.
- Do not persist Workspace/panel state (2.5) or add edit/remove Connection management flows (2.4).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Keychain unavailable, first run, passphrase provided | keychain down, no files, provider returns a non-empty passphrase | store opens in passphrase mode; descriptor (salt + scrypt params) written; key derived via scrypt; `.enc` written on first save | No error |
| Passphrase declined | keychain down, provider returns `declined` | typed `passphrase-declined`; NOTHING written (no descriptor, no `.enc`, no plaintext) | Typed `passphrase-declined` |
| Empty/whitespace passphrase | keychain down, provider returns `""` / whitespace | typed `passphrase-invalid`; nothing written | Typed `passphrase-invalid` |
| Reopen passphrase store, correct passphrase | descriptor + `.enc` present, same passphrase | connections read back decrypted; key re-derived from the persisted salt/params — survives across launches | No error |
| Reopen passphrase store, wrong passphrase | descriptor + `.enc` present, wrong passphrase | typed `corrupt` (GCM auth-tag fail; indistinguishable from tamper by design) | Typed `corrupt` |
| Keychain-mode file, keychain now unavailable | `.enc` present with NO descriptor (keychain mode), keychain down | typed `key-unavailable` — distinct from `corrupt`; NOT routed to passphrase (a passphrase can't decrypt a keychain-keyed file) | Typed `key-unavailable` |
| Passphrase store, keychain available | descriptor says passphrase, keychain up | descriptor is authoritative → passphrase path used, keychain ignored | No error |
| Raw file inspection (passphrase mode) | read `.enc` + descriptor bytes directly | only base64 ciphertext/iv/authTag + non-secret salt/params; no plaintext `name`/`url`, no 32-byte key, no passphrase | n/a |
| Malformed descriptor | descriptor JSON unparseable or wrong shape | content error → typed `corrupt`; I/O read error → typed `unavailable` | Typed `corrupt` / `unavailable` |

</intent-contract>

## Code Map

- `src/core/passphrase-key.ts` (new) -- scrypt KDF: `derivePassphraseKey(passphrase, salt, params)` → `DeriveResult` (`derived`/`passphrase-invalid`/`derive-failed`); `generateSalt()` (16-byte CSPRNG); `DEFAULT_SCRYPT_PARAMS`. Total; never logs passphrase/key.
- `src/core/passphrase-key.test.ts` (new) -- determinism, salt-changes-key, empty/whitespace→`passphrase-invalid`, 32-byte output, `detail` excludes the passphrase, `derive-failed` path.
- `src/core/passphrase-provider.ts` (new) -- `PassphraseProvider` (sync) type + `PassphraseResponse` (`provided`/`declined`); `envPassphraseProvider(env)` reading `QS_PASSPHRASE` (unset/empty → `declined`); `PASSPHRASE_ENV_VAR` const.
- `src/core/passphrase-provider.test.ts` (new) -- env set → `provided`; unset/empty/whitespace → `declined`.
- `src/core/credential-store.ts` (modify) -- persist a non-secret key descriptor (sidecar `credential-store.meta.json`); descriptor-authoritative mode precedence; passphrase branch on keychain-`unavailable`/first-run; new `OpenResult` arms (`passphrase-declined`, `passphrase-invalid`, `key-unavailable`); reopen re-derivation from stored salt; extend `CredentialStoreDeps` with `passphraseProvider?` (default `envPassphraseProvider(process.env)`). Keep no-plaintext/no-key/no-passphrase invariants; atomic descriptor write `0o600`.
- `src/core/credential-store.test.ts` (modify) -- add the matrix rows above; update the prior "keychain-`unavailable` → `unavailable`, no file" test to the new passphrase-provider flow.
- `src/core/crypto.ts` / `store-key.ts` / `keychain.ts` -- reused unchanged (encrypt/decrypt, keychain key path, typed keychain access).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/passphrase-key.ts` -- `derivePassphraseKey` (scrypt via `node:crypto`, `maxmem` raised — see Design Notes), `generateSalt()` (16-byte CSPRNG), `DEFAULT_SCRYPT_PARAMS`; typed `DeriveResult`; reject empty/whitespace passphrase as `passphrase-invalid`; never throw, never log passphrase/key -- the FR-5 key derivation
- [x] `src/core/passphrase-key.test.ts` -- determinism (same passphrase+salt+params → identical key), different salt → different key, empty/whitespace → `passphrase-invalid`, key length 32, assert `detail` never contains the passphrase, `derive-failed` on impossible params
- [x] `src/core/passphrase-provider.ts` -- sync `PassphraseProvider` type, `PassphraseResponse` (`provided`/`declined`), `envPassphraseProvider(env)` (`QS_PASSPHRASE`; unset/empty → `declined`), `PASSPHRASE_ENV_VAR` -- the "offer / decline" seam
- [x] `src/core/passphrase-provider.test.ts` -- env set → `provided` with value; unset/empty/whitespace → `declined`
- [x] `src/core/credential-store.ts` -- sidecar key descriptor (`credential-store.meta.json`: `{schemaVersion, keyMode:"passphrase", kdf:{algo,salt,n,r,p,keylen}}`, atomic `0o600`, keychain mode writes NO descriptor); descriptor-authoritative mode precedence (see Design Notes pseudo); passphrase branch on keychain-`unavailable`/first-run consulting `passphraseProvider`; new `OpenResult` arms `passphrase-declined` / `passphrase-invalid` / `key-unavailable`; re-derive key from persisted salt on reopen; extend `CredentialStoreDeps` with `passphraseProvider?` -- wires the fallback into the store
- [x] `src/core/credential-store.test.ts` -- add the I/O-matrix rows (first-run passphrase create+reopen survival, decline→nothing-written, empty→`passphrase-invalid`, wrong-passphrase→`corrupt`, keychain-mode+keychain-down→`key-unavailable`, descriptor-authoritative-over-available-keychain, raw-file has no plaintext/key/passphrase, malformed descriptor); update the legacy keychain-`unavailable` test; self-cleaning (no residual temp dirs, keychain entries, or `QS_PASSPHRASE` leakage)

**Acceptance Criteria:**
- Given a machine with no usable OS keychain and a passphrase supplied via the provider, when Persistent mode starts and the store is later reopened by a fresh instance with the same passphrase, then saved connections are read back decrypted from the AES-256-GCM file, and the key is re-derived from a persisted **non-secret** salt/params — no key or passphrase is stored anywhere.
- Given a machine with no usable OS keychain, when the developer declines the passphrase fallback, then no credential — and no descriptor or store file — is written anywhere in plaintext.

## Spec Change Log

_No bad_spec loopback occurred; empty._

## Review Triage Log

### 2026-07-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 1, medium 3, low 2)
- defer: 1
- reject: 6: (high 0, medium 1, low 5)
- addressed_findings:
  - `[high]` `[patch]` Keychain reopen over an existing `.enc` mapped only `loadStoreKey` `unavailable` → `key-unavailable`, letting the `created` arm (a lost keychain entry silently regenerated) fall through to a wrong-key decrypt → misreported `corrupt`. This is exactly the spec-2-2 deferred "key-lifecycle vs file-lifecycle desync" the story exists to resolve, and it was NOT resolved. Fixed: in the descriptor-absent + `.enc`-present branch, `created` is now treated as key-lost → `key-unavailable` (file untouched); the true first-run branch still treats `created` as a new keychain store. Test added asserting `.enc` is not overwritten.
  - `[medium]` `[patch]` Passphrase-store creation deferred the `.enc` write to first save, so a wrong passphrase on reopen of a not-yet-saved store was silently accepted and, once a save baked in the wrong key, permanently locked out the correct passphrase. Fixed: creation now eagerly encrypts+writes the empty `.enc` (descriptor then `.enc`, best-effort descriptor rollback on `.enc` failure), so a wrong passphrase always fails GCM → `corrupt` (matches the intent-contract matrix even for empty stores). Keychain mode stays lazy; decline still writes nothing.
  - `[medium]` `[patch]` The key descriptor's `schemaVersion` was accepted without checking `STORE_META_SCHEMA_VERSION`; a future/hostile version would be interpreted under v1 KDF semantics. Fixed: mismatch → typed `schema-unknown` (mirrors the payload schema-version handling).
  - `[medium]` `[patch]` Descriptor KDF fields were validated by `typeof` only, so an empty/`""` salt (→ 0-byte salt, weakened KDF) or hostile work factors passed. Fixed: `readDescriptor` now validates decoded salt length (16 B), `keylen === 32`, and `n` (power of two in [2^14, 2^20]) / `r` [1,32] / `p` [1,16] → `corrupt` on any failure.
  - `[low]` `[patch]` `derivePassphraseKey` had no upper passphrase-length bound, allowing a pathological multi-MB input into synchronous `scryptSync`. Fixed: `MAX_PASSPHRASE_LENGTH = 1024` → `passphrase-invalid`.
  - `[low]` `[patch]` The scrypt memory comment cited `128*N*r`, understating Node's real check `128*r*(N+p+2)`; corrected the comment and added a regression test asserting `DEFAULT_SCRYPT_PARAMS` derives within the 64 MB `maxmem` headroom.
- deferred (new ledger entry): `QS_PASSPHRASE` env transport exposes the passphrase via `/proc/<pid>/environ`, inherited child environments, and core dumps — the env seam is the intent-contract-sanctioned default, so a stdin/fd passphrase path plus a documented warning is future hardening, not this story's bug.
- rejected (representative): wrong-passphrase→`corrupt` on a non-empty store (the intent-contract explicitly mandates it — GCM can't distinguish wrong-key from tamper; retry UX is Story 2.4); descriptor mode-confusion via same-user write to the `0o600` store dir + GCM-AAD binding (out of threat model; AAD-binding already rejected in Story 2.2 for the same reason); zeroize the key/passphrase (already rejected twice in 2.2 — Node can't guarantee it and the key must live while the store is open); first-run passphrase concurrency race (already tracked as the single-writer ledger entry — not re-deferred); descriptor `fsync` durability (consistent with 2.2's accepted temp+rename write path); test secret-absence substring-scan (reasonable assertions, no code defect).

## Design Notes

<!-- Patch-pass clarifications (behavior conforms to the intent-contract matrix/Always rules):
     - Passphrase-store CREATION eagerly writes the encrypted empty `.enc` (not deferred to first save), so reopen with a wrong passphrase fails GCM → `corrupt` even for an empty store; keychain mode stays lazy.
     - Keychain reopen over an EXISTING `.enc`: `loadStoreKey` outcome `created` (key regenerated = lost) is treated as key-lost → `key-unavailable`, not `corrupt`. Only the true first-run branch (no descriptor, no `.enc`) treats `created` as a new keychain store.
     - Descriptor read validates schemaVersion, salt length, keylen, and bounded n/r/p before deriving. -->


- **scrypt params & the `maxmem` gotcha:** `DEFAULT_SCRYPT_PARAMS = { N: 2**15, r: 8, p: 1, keylen: 32 }`. scrypt needs ≈ `128 * N * r` bytes ≈ 32 MB, which meets/exceeds Node's default `maxmem` (32 MB) and *throws* `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`. Pass `maxmem: 64 * 1024 * 1024` and wrap `scryptSync` in try/catch → typed `derive-failed`, preserving totality.
- **Descriptor sidecar (non-secret):** `credential-store.meta.json` = `{ "schemaVersion": 1, "keyMode": "passphrase", "kdf": { "algo": "scrypt", "salt": "<b64 16B>", "n": 32768, "r": 8, "p": 1, "keylen": 32 } }`. Written atomically `0o600`, once at creation. **Keychain mode writes NO descriptor** — this preserves Story 2.2's `.enc`-only layout and gives clean back-compat: an absent descriptor ⇒ keychain mode. Salt/params are non-secret and *must* be persisted so the key can be re-derived on reopen.
- **Mode precedence (authoritative descriptor):**
  ```
  if ephemeral: opened (memory)                         // unchanged
  read descriptor (sidecar)
  if descriptor.passphrase:  key = derive(provider(), descriptor.salt/params)
  elif descriptor absent AND .enc present: keychain path; keychain unavailable -> key-unavailable
  else (true first run):  try keychain -> keychain mode;
                          keychain unavailable -> passphrase mode via provider
  provider declined -> passphrase-declined ; empty -> passphrase-invalid ; write nothing
  ```
- **Provider seam:** sync `PassphraseProvider = (ctx: { reason: "keychain-unavailable"; isFirstRun: boolean }) => { outcome: "provided"; passphrase: string } | { outcome: "declined" }`. Default `envPassphraseProvider(process.env)` reads `QS_PASSPHRASE` (unset/empty ⇒ `declined`), keeping the fallback functional headlessly today; Story 2.4 injects an interactive prompt later. The context carries no secret.
- **Wrong passphrase = `corrupt`:** GCM auth-tag verification fails identically for a wrong key and a tampered file; they are cryptographically indistinguishable, so both are `corrupt`. Do not fake a distinction.

## Verification

**Commands:**
- `bun x tsc --noEmit` -- expected: no type errors
- `bun test` -- expected: full suite green including new passphrase-key / passphrase-provider / credential-store tests; deterministic and self-cleaning (no residual temp dirs, keychain entries, or `QS_PASSPHRASE` leakage between tests)
- `bun test src/core/passphrase-key.test.ts src/core/passphrase-provider.test.ts src/core/credential-store.test.ts` -- expected: all pass

**Manual checks:**
- Force the keychain unavailable and set `QS_PASSPHRASE`, save a connection, then open `credential-store.enc` and `credential-store.meta.json` in a hex/text viewer: confirm no plaintext `name`/`url`, no 32-byte key, and no passphrase — only base64 ciphertext/iv/authTag plus the non-secret salt/scrypt params. Reopen with the same passphrase → the connection returns; with a wrong passphrase → `corrupt`.

## Auto Run Result

Status: **done**

**Implemented change:** The keychain-unavailable passphrase fallback (FR-5, UJ-2 edge case, AD-5) for the Epic-2 credential store. Three new/changed Ring-1 modules: a scrypt KDF (`passphrase-key.ts` — `derivePassphraseKey`/`generateSalt`/`DEFAULT_SCRYPT_PARAMS`, `maxmem` raised to 64 MB, empty/whitespace and over-long passphrases rejected), a passphrase provider seam (`passphrase-provider.ts` — sync `PassphraseProvider` + `envPassphraseProvider` reading `QS_PASSPHRASE`, keeping the fallback functional headlessly), and the mode-aware store (`credential-store.ts`) extended with a non-secret key-descriptor sidecar (`credential-store.meta.json`), descriptor-authoritative mode precedence, and new typed `OpenResult` arms (`passphrase-declined`, `passphrase-invalid`, `key-unavailable`). All boundary functions stay total (typed discriminated results, never throw). No new dependencies (scrypt via `node:crypto`). Plaintext, the passphrase, and the derived key are never written or logged.

**Files changed (under `src/core/`):**
- `passphrase-key.ts` / `passphrase-key.test.ts` — new: scrypt KDF, salt generation, length bounds.
- `passphrase-provider.ts` / `passphrase-provider.test.ts` — new: provider seam + `QS_PASSPHRASE` default.
- `credential-store.ts` / `credential-store.test.ts` — modified: descriptor sidecar (atomic `0o600`, keychain mode writes none), eager `.enc` write at passphrase-store creation, descriptor validation (schemaVersion / salt-length / keylen / bounded n·r·p), keychain `created`-over-existing-file → `key-unavailable`, provider wiring.
- `_bmad-output/implementation-artifacts/deferred-work.md` — marked the spec-2-2 key-lifecycle/file-lifecycle desync entry RESOLVED by this story; added one new defer (env-transport passphrase exposure).

**Review findings breakdown:** 6 patches applied (1 high / 3 medium / 2 low), 1 deferred, 6 rejected. No intent_gap, no bad_spec, no repair loopback. The high-severity patch fixed the very key-lost-vs-corrupt misclassification this story existed to resolve (the initial implementation handled only keychain `unavailable`, not the `created`/regenerated-key case that is the real desync scenario); a medium patch closed an empty-store wrong-passphrase permanent-lockout by eagerly writing the encrypted empty `.enc` at creation.

**Verification performed:**
- `bun x tsc --noEmit` → 0 type errors.
- `bun test` (full suite) → 201 pass / 0 fail across 15 files (baseline 195 → +6 net after patch tests; original story added +24 over Story 2.2's 171).
- Deterministic and self-cleaning: no residual temp dirs, no leftover keychain entries, no `QS_PASSPHRASE` leakage between tests, no `~/.local/share/quick-studio` written by tests.

**Residual risks:**
- The default provider reads the passphrase from `QS_PASSPHRASE`, exposing it via `/proc/<pid>/environ`, child environments, and core dumps (never disk/logs). Deferred: a stdin/fd path + a documented warning before wider release; Story 2.4 adds the interactive UI prompt.
- Wrong passphrase vs. tampered file are cryptographically indistinguishable (both `corrupt`) by explicit intent-contract design; retry UX belongs to Story 2.4.
- Multi-instance/overlapping-launch concurrency (lost updates, first-run salt race) remains the pre-existing single-writer ledger item — latent for the single-instance localhost tool.
- The macOS keychain path and the locale-fragile `isNotFoundError` classifier remain on their existing ledger entries.

**Follow-up review:** recommended — the pass made a high-severity behavior change (key-lost classification) plus an on-disk lifecycle change (eager `.enc` at creation) to a security-critical credential store; an independent follow-up review of the converged diff is warranted.
