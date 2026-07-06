---
title: 'Story 2.2: Encrypted credential store at rest, key in OS keychain'
type: 'feature'
created: '2026-07-06'
status: 'done'
baseline_revision: '1d8822b4de10dba839d81a8eeb68bea7b9f41418'
final_revision: '0c26ffef99627a35bbb341ed3bc6440e32ee9982'
review_loop_iteration: 0
followup_review_recommended: false
context: ['_bmad-output/implementation-artifacts/epic-2-context.md']
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Epic 1 is URL-only and ephemeral: a developer must re-enter a connection every launch, and there is no safe place to keep credentials. Epic 2 needs a persistence substrate where a saved Connection is encrypted at rest with the key held by the OS keychain (UJ-2, FR-4/5/6, AR-7, AR-9), so credentials are never exposed on disk. None of the pieces exist yet — no app-directory resolver, no crypto, no store, no Persistent/Ephemeral gate.

**Approach:** Build the Ring-1 substrate: an OS-convention app-directory resolver, an AES-256-GCM crypto module (via `node:crypto`), a keychain-backed 32-byte master-key manager (reusing the Story 2.1 `keychain.ts` wrapper), and a mode-aware encrypted credential store. The store file holds only ciphertext (never the key, never plaintext); in Ephemeral mode nothing touches disk. When the keychain is unavailable the store surfaces a typed `unavailable` result — the designed hook for Story 2.3's passphrase fallback — and never writes a plaintext fallback.

## Boundaries & Constraints

**Always:**
- All crypto, the master key, and decrypted credentials live only in Ring 1 (`src/core/`). Ring 2 (`src/ui/`) and `src/shared/` never hold a key or a plaintext credential.
- The store file is AES-256-GCM ciphertext: it never contains the encryption key and reveals no readable credential material when opened directly.
- The 32-byte master key is generated with a CSPRNG (`crypto.randomBytes(32)`) and held only in the OS keychain. Key bytes are never logged and never written to any file.
- Plaintext credentials are never written to disk — not even as a fallback. If the key is `unavailable`, surface the typed result and stop; do not write.
- In Ephemeral mode nothing is written to disk (no store file is created).
- Reuse `src/core/keychain.ts` for all keychain access; do not call `@napi-rs/keyring` directly from the store.
- Reject a keychain-held key value that does not decode to exactly 32 bytes as a typed `key-invalid` (an empty or wrong-length AES key is never valid).
- An unrecognized on-disk `schemaVersion` is a typed error, never a silent overwrite of the user's credentials.
- Follow Core conventions: kebab-case modules, explicit `.ts` import extensions, inline `type` imports, co-located `bun:test`, `readonly` discriminated-union results, no-throw at Ring boundaries, JSDoc header citing the AR/FR refs.

**Block If:**
- An existing store file or keychain key from a prior/foreign format is found on the build platform that this story would overwrite — HALT rather than risk credential loss (greenfield: this should not trigger, but do not clobber if it does).

**Never:**
- Do not implement the passphrase fallback or any passphrase-derived key (Story 2.3).
- Do not build Connection-management UI, the connections panel, or add/edit/remove RPC handlers (Story 2.4).
- Do not persist Workspace/panel/Tab state (Story 2.5).
- Do not replace the spike's locale-fragile `isNotFoundError` heuristic in this story; the store consumes the wrapper's typed outcomes, and the classifier fix stays deferred until real Windows error shapes are observed via CI (keep fail-safe toward `unavailable`).
- Do not hardcode a per-platform key-management default that overrides Story 2.1's go/no-go (Windows keychain remains pending its CI leg).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Save + relaunch (persistent) | `saveConnection(rec)`, then open a fresh store instance over the same dir/key | reopened store returns the same decrypted record — survives across launches | No error |
| Raw file inspection | read `credential-store.enc` bytes directly | contains no plaintext `name`/`url` and no 32-byte key material — only base64 ciphertext + iv + authTag + schemaVersion | n/a |
| Keychain unavailable | open store when keychain backend is down | typed `unavailable` (the Story 2.3 hook); no file written | Typed `unavailable` |
| Invalid keychain key | keychain returns a value not decoding to 32 bytes | typed `key-invalid`; refuse to open; no plaintext write | Typed `key-invalid` |
| Ephemeral save | `saveConnection` while mode is ephemeral | record kept in memory only; NO file created on disk | No error |
| Tampered / corrupt store | store file bytes altered or wrong key | AES-GCM auth-tag verification fails → typed `corrupt`, not a silent partial read | Typed `corrupt` |
| First run (no file) | open when no store file exists | empty store, ready to save; no error | No error |
| Delete connection | `deleteConnection(id)` then reopen | record and its credential are gone from the store | No error |

</intent-contract>

## Code Map

- `src/core/app-dir.ts` (new) -- OS-convention app-data dir resolver (AR-9): pure `resolveAppDir(env, platform)` + `ensureAppDir()` that creates it; win `%APPDATA%\quick-studio`, linux `$XDG_DATA_HOME/quick-studio` else `~/.local/share/quick-studio`, darwin `~/Library/Application Support/quick-studio`
- `src/core/app-dir.test.ts` (new) -- table-driven per-platform + env-override + fallback
- `src/core/crypto.ts` (new) -- AES-256-GCM `encryptJson(key, value)` / `decryptJson(key, envelope)` over `node:crypto`; random 12-byte IV per encrypt; base64 envelope `{schemaVersion, iv, authTag, ciphertext}`; key never in envelope; typed `corrupt` on auth failure
- `src/core/crypto.test.ts` (new) -- round-trip, tamper→corrupt, wrong-key→corrupt, envelope-excludes-key/plaintext
- `src/core/store-key.ts` (new) -- `loadOrCreateStoreKey(deps?)`: reuse `keychain.ts`; durable service/account constants; generate+store 32-byte CSPRNG key on `not-found`; validate found value → 32 bytes else `key-invalid`; propagate `unavailable`; never log the key
- `src/core/store-key.test.ts` (new) -- get-or-create round-trip (self-cleaning), invalid-length→`key-invalid`, `unavailable` propagation via injected wrapper
- `src/core/run-mode.ts` (new) -- `resolveRunMode(env)` → `"persistent" | "ephemeral"` (`QS_MODE`, default persistent)
- `src/core/run-mode.test.ts` (new) -- env parsing + default
- `src/core/credential-store.ts` (new) -- mode-aware store: `openCredentialStore(deps)` → typed `OpenResult`; `saveConnection` / `getConnection` / `listConnections` / `deleteConnection`; persistent → encrypt+write under app-dir on mutation, ephemeral → memory only; loads+decrypts existing file; unknown `schemaVersion` → typed error; surfaces store-key `unavailable`/`key-invalid`
- `src/core/credential-store.test.ts` (new) -- relaunch survival, raw-file has no plaintext/key, ephemeral writes nothing, delete, keychain-unavailable, corrupt-file
- `src/core/keychain.ts` -- reused as-is (typed keychain access); not modified

## Tasks & Acceptance

**Execution:**
- [x] `src/core/app-dir.ts` -- implement pure `resolveAppDir(env, platform)` (AR-9 conventions incl. darwin) and `ensureAppDir()` (recursive mkdir) -- gives every persistent artifact one OS-convention home
- [x] `src/core/app-dir.test.ts` -- table-driven: each platform, `XDG_DATA_HOME` set vs unset fallback, `%APPDATA%` on win -- proves the resolver
- [x] `src/core/crypto.ts` -- AES-256-GCM `encryptJson`/`decryptJson` typed results; random IV; auth tag; base64 envelope excluding the key; `decryptJson` returns `corrupt` on auth/verify failure -- the at-rest cipher, key never on disk
- [x] `src/core/crypto.test.ts` -- unit-test the matrix crypto rows: round-trip, tamper→`corrupt`, wrong-key→`corrupt`, and assert envelope JSON has no key/plaintext substring
- [x] `src/core/store-key.ts` -- `loadOrCreateStoreKey` over the keychain wrapper with fixed service/account constants; generate 32-byte key on `not-found` and store base64; `key-invalid` on non-32-byte; propagate `unavailable`; never log key -- holds the AR-7 key outside the file
- [x] `src/core/store-key.test.ts` -- real-keychain get-or-create (self-cleaning), injected `key-invalid`, injected `unavailable`
- [x] `src/core/run-mode.ts` -- `resolveRunMode(env)` (`QS_MODE=ephemeral|persistent`, default persistent) -- the Persistent/Ephemeral gate the store consults
- [x] `src/core/run-mode.test.ts` -- parsing + default
- [x] `src/core/credential-store.ts` -- `openCredentialStore(deps)` wiring app-dir + store-key + crypto + mode; save/get/list/delete Connection records; persistent writes ciphertext, ephemeral memory-only; unknown schemaVersion → typed error -- the substrate for 2.4 and Epic 5
- [x] `src/core/credential-store.test.ts` -- unit-test the remaining matrix rows: relaunch survival, raw-file no-plaintext/no-key, ephemeral-writes-nothing, delete, keychain-`unavailable`, corrupt-file; self-cleaning (no residual keychain entry or temp file)

**Acceptance Criteria:**
- Given Persistent mode, when a Connection is saved and the store is reopened by a fresh instance over the same directory, then the connection is read back decrypted from an AES-256-GCM file under the OS-convention app directory (AR-9) — surviving across launches.
- Given the written store file, when it is opened directly, then it reveals no readable credential material and does not contain its own encryption key.
- Given the store is unlocked, when the master key is obtained, then the 32-byte key comes from the OS keychain (AR-7) and no credential is ever written in plaintext; if the keychain is unavailable the store returns a typed `unavailable` and writes nothing.
- Given Ephemeral mode, when a Connection is saved, then nothing is written to disk (no store file is created).

## Spec Change Log

_No bad_spec loopback occurred; empty._

## Review Triage Log

### 2026-07-06 — Follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 2, low 1)
- defer: 1
- reject: 10: (high 0, medium 2, low 8)
- addressed_findings:
  - `[medium]` `[patch]` `flush()` ran a `chmodSync(filePath, 0o600)` AFTER the durable `renameSync` — redundant (the atomic rename already moves the 0o600 temp inode over the target) and unsafe: a chmod failure after the committed rename returned `write-failed` while disk already held the new data, diverging memory from disk. Removed the post-rename chmod (dropped the now-unused `chmodSync` import); added a POSIX test asserting the committed (and overwritten) file lands `0o600`.
  - `[medium]` `[patch]` `openCredentialStore` funneled EVERY `readFileSync`/`JSON.parse` failure into `corrupt`, so a transient/permission I/O error (EACCES/EIO/EISDIR) on an intact ciphertext read as "corrupt" and could prompt destructive recovery, and a TOCTOU delete between `existsSync` and read read as corrupt instead of first-run. Now branch on the error's POSIX `code`: `ENOENT` → first-run empty store, any other filesystem `code` → non-destructive `unavailable`, no code (JSON `SyntaxError`) → `corrupt`. Added an EISDIR (store-path-is-a-directory) test asserting `unavailable`.
  - `[low]` `[patch]` `deleteConnection` on an absent id still re-encrypted (fresh IV) and rewrote the identical set — a no-op that churned the file and could spuriously fail `write-failed`. Guarded with an early `ok` when the id is not present; added a test that deleting a never-existed id creates no file.
- deferred (new ledger entry): key-lifecycle vs file-lifecycle desync — a keychain key lost while the store file survives mints a fresh key and surfaces the intact file as `corrupt` (indistinguishable from tampering); distinct outcome + recovery hook belongs to Story 2.3's passphrase fallback. Distinct from the existing single-writer entry.
- rejected (representative): `QS_MODE` typo silently coerced to persistent (spec-conformant: default is persistent by design; no Ring-1 logging surface to warn); concurrency lost-updates (already tracked as the single-writer ledger entry — not re-deferred); GCM-AAD-bind the envelope `schemaVersion` and zeroize the key Buffer (both already rejected in the prior pass, same reasoning); duplicate-id collapse on load (unreachable — the store writes via an id-keyed Map and a tampered file fails GCM auth before parse); app-dir perms not tightened when pre-existing (store file is `0o600` and contents are ciphertext); `randomBytes` throwing (catastrophic CSPRNG failure, not an expected boundary condition).

### 2026-07-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 1, medium 5, low 4)
- defer: 1
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[high]` `[patch]` Store flush used `writeFileSync` (truncate-then-write), so an interrupted write could leave `credential-store.enc` truncated and lose ALL saved connections — replaced with write-to-temp (`0o600`) + atomic `renameSync`, best-effort temp cleanup on failure.
  - `[medium]` `[patch]` A store file containing the JSON literal `null` passed the `typeof === "object"` check and threw `TypeError` on `null.schemaVersion` (breaking the never-throw boundary); `{}`/`[]` were mislabeled `schema-unknown`. Added `isCryptoEnvelope` well-formedness guard (non-null object + numeric `schemaVersion` + string `iv`/`authTag`/`ciphertext`) → non-envelopes now return `corrupt`; only a well-formed envelope with a different numeric version returns `schema-unknown`.
  - `[medium]` `[patch]` `ensureAppDir()`'s `mkdirSync` could throw (EACCES/EROFS/read-only home) out of the total `openCredentialStore` boundary — dir resolution now wrapped in try/catch, surfaced as typed `unavailable`.
  - `[medium]` `[patch]` `encryptJson` could throw (circular/BigInt) or `Buffer.from(undefined)` on a non-serializable value, breaking its "total for a valid key" contract — `JSON.stringify` guarded; added typed `serialize-failed` outcome (flush already maps non-`encrypted` → `write-failed`).
  - `[medium]` `[patch]` `saveConnection`/`deleteConnection` mutated the in-memory `Map` before `flush`, so a `write-failed` left memory diverged from disk (and a later save silently persisted the "failed" record) — now mutate a prospective snapshot and commit to the live map only after a successful flush.
  - `[medium]` `[patch]` Store dir/file were created world-readable — app dir now `0o700`, store file (and temp) `0o600` (+ `chmodSync` post-rename); ignored-but-harmless on Windows.
  - `[low]` `[patch]` `isStorePayload` only checked `Array.isArray(connections)`, so malformed elements (`[{}, null, 42]`) loaded with `rec.id === undefined` — added per-element `isStoredConnection` validation (string `id`/`name`/`url`) → `corrupt` on any malformed element (checked after the version gate).
  - `[low]` `[patch]` `resolveAppDir` could return a CWD-relative path when the home base was empty — `ensureAppDir` now rejects a non-absolute result, surfaced as typed `unavailable` via the P3 catch (keeps the pure resolver throw-free).
  - `[low]` `[patch]` `getConnection` returned the live internal record (mutable despite `readonly` types) — now returns a shallow copy; `listConnections` copies elements too.
  - `[low]` `[patch]` "No plaintext at rest" tests asserted only hand-picked substrings — strengthened to save `randomUUID()`-distinctive `id`/`name`/`url` and assert none of the actual field values appear in the on-disk bytes (raw-key `includes` check retained).
- deferred (new ledger entry): single-writer guarantee (file lock / single-instance) for the store — two concurrent Core instances can lost-update the record file or race master-key generation into a permanently-undecryptable file; latent for a single-instance localhost tool.
- rejected (representative): GCM-AAD-bind the envelope `schemaVersion` (an attacker with file-write can already DoS by truncation, and it leaks no plaintext — no net gain); base64 key-decode leniency (a garbage value coincidentally 32 bytes fails safe → file opens `corrupt`, no leak); zeroize key Buffer (Node cannot guarantee zeroization and the key must persist while the store is open).

## Design Notes

- **Key path & Story 2.3 hook:** `store-key.ts` consumes the wrapper's typed outcomes only. `not-found` → generate + store a new key; `found` → validate to 32 bytes; `unavailable` → bubble up unchanged as the store's `unavailable` open result, which Story 2.3's passphrase fallback keys off. The store never invents a key or writes plaintext. Windows keychain commitment stays gated on Story 2.1's CI Windows leg — no per-platform hardcoded default.
- **Invalid/empty key (resolves ledger entry):** an AES-256 key must be exactly 32 bytes; a keychain value that decodes shorter/empty is `key-invalid`, not a usable key. `store-key`'s service/account are fixed non-empty constants (not caller-supplied), so the wrapper's invalid-argument-vs-unavailable ambiguity does not arise here.
- **Envelope shape (key excluded by construction):**
  ```
  { "schemaVersion": 1, "iv": "<b64 12B>", "authTag": "<b64 16B>", "ciphertext": "<b64>" }
  ```
  `ciphertext` = AES-256-GCM over the JSON of `{ schemaVersion, connections: StoredConnection[] }`. `StoredConnection = { readonly id, readonly name, readonly url }` (the `url` carries the secret). Decrypt verifies the auth tag before parsing → tamper/wrong-key surfaces as `corrupt`.
- **Testability:** `openCredentialStore` / `loadOrCreateStoreKey` take injectable deps (key provider, dir, keychain fns) defaulting to the real ones, so `unavailable`/`key-invalid`/`corrupt` are unit-testable without a live keychain, while the happy path exercises the real Linux keychain and self-cleans (mirrors Story 2.1's approach).

## Verification

**Commands:**
- `bun x tsc --noEmit` -- expected: no type errors
- `bun test` -- expected: full suite green (was 114 pass / 0 fail; new tests added), no residual keychain entries or leftover temp store files
- `bun test src/core/credential-store.test.ts src/core/crypto.test.ts src/core/store-key.test.ts src/core/app-dir.test.ts src/core/run-mode.test.ts` -- expected: all pass; deterministic and self-cleaning

**Manual checks:**
- Save a connection in persistent mode, then open the resulting `credential-store.enc` in a hex/text viewer: confirm no plaintext `name`/`url` and no 32-byte key are present — only base64 ciphertext/iv/authTag and the schemaVersion.

## Auto Run Result

### Follow-up review pass (2026-07-06)

An independent follow-up review of the same baseline diff produced 3 auto-fixed patches (2 medium / 1 low), 1 new deferral, and 10 rejections; no intent_gap, no bad_spec, no repair loopback.

**Patches applied (all in `src/core/credential-store.ts`):**
- Removed a redundant, invariant-breaking post-`rename` `chmodSync` (atomic rename already commits the `0o600` temp inode; a chmod failure after the durable rename could report `write-failed` while disk held the new data). Added a POSIX test asserting the committed/overwritten file is `0o600`.
- Read-path error classification now distinguishes I/O failure from malformed content: `ENOENT` (TOCTOU) → first-run empty store, other POSIX `code` → non-destructive `unavailable`, JSON `SyntaxError` → `corrupt`. Added an EISDIR test asserting `unavailable`.
- `deleteConnection` on an absent id is now a no-op (was re-encrypting + rewriting the identical set, which could spuriously `write-failed`). Added a test that deleting a never-existed id writes no file.

**Deferred (new ledger entry):** key-lifecycle vs file-lifecycle desync — a keychain key lost while the store file survives surfaces the intact file as `corrupt`; a distinct outcome + recovery hook belongs to Story 2.3's passphrase fallback. Distinct from the pre-existing single-writer entry.

**Verification:** `bun x tsc --noEmit` → 0 errors; `bun test` → 171 pass / 0 fail across 13 files (168 → +3 new tests); deterministic and self-cleaning.

**Follow-up review:** not recommended — fixes are localized to one module, fully covered by new tests, with no API or on-disk-format change; the pass converged.

---

### Original implementation + first review pass

Status: **done**

**Implemented change:** The Ring-1 persistence substrate for Epic 2. Five new `src/core/` modules: an OS-convention app-directory resolver (AR-9), an AES-256-GCM crypto module over `node:crypto` (fresh 12-byte IV per encrypt, auth tag verified before parse, key never in the envelope), a keychain-backed 32-byte master-key manager reusing the Story 2.1 `keychain.ts` wrapper (AR-7; `unavailable` bubbled up as the Story 2.3 passphrase-fallback hook; non-32-byte keys rejected as `key-invalid`), a Persistent/Ephemeral run-mode gate, and a mode-aware encrypted credential store (persistent → atomic-write ciphertext under the app dir; ephemeral → memory-only, nothing on disk). All boundary functions are total (typed discriminated results, never throw for expected conditions). No new dependencies; no direct `@napi-rs/keyring` calls from the store.

**Files changed (all new, under `src/core/`):**
- `app-dir.ts` / `app-dir.test.ts` — OS-convention data-dir resolver (win/linux-XDG/darwin), `0o700` mkdir, absolute-path guard
- `crypto.ts` / `crypto.test.ts` — AES-256-GCM `encryptJson`/`decryptJson`, key-excluding base64 envelope, typed `corrupt`/`serialize-failed`
- `store-key.ts` / `store-key.test.ts` — `loadOrCreateStoreKey` over the keychain wrapper, fixed service/account, 32-byte validation, `unavailable` propagation
- `run-mode.ts` / `run-mode.test.ts` — `resolveRunMode(env)` (`QS_MODE`, default persistent)
- `credential-store.ts` / `credential-store.test.ts` — mode-aware store; atomic temp+rename `0o600` write; save/get/list/delete; well-formed-envelope + per-element validation; snapshot-commit-after-flush
- `_bmad-output/implementation-artifacts/deferred-work.md` — one new defer entry (single-writer guarantee)

**Review findings breakdown:** 10 patches applied (1 high / 5 medium / 4 low), 1 deferred, 3 rejected. No intent_gap, no bad_spec, no repair loopback.

**Verification performed:**
- `bun x tsc --noEmit` → 0 type errors
- `bun test` (full suite) → 168 pass / 0 fail across 13 files (baseline 114 → +54 new)
- Targeted new-module suites pass; deterministic and self-cleaning (isolated UUID temp dirs, run-unique keychain accounts deleted in `afterAll`); no residual `~/.local/share/quick-studio` written by tests

**Residual risks:**
- The real-keychain happy path degrades to a green `unavailable` on a keychain-less box (WSL/headless), so the AR-7 keychain round-trip for the store is proven locally only where Secret Service is live; per-platform keychain go/no-go (esp. Windows) remains gated on Story 2.1's CI matrix — no per-platform default is hardcoded.
- Multi-instance/multi-process concurrent access can lost-update the store or race master-key generation (deferred): safe for the single-instance localhost tool, latent otherwise.
- macOS keychain path and the locale-fragile `isNotFoundError` classifier remain deferred to their existing ledger entries (typed error codes need Windows-observed shapes).
