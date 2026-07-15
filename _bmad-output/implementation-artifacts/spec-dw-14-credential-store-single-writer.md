---
title: 'DW-14: Single-writer guarantee for the credential store'
type: 'feature'
created: '2026-07-15'
status: 'done'
baseline_revision: '1c77c9899cd130828ee830ce75a5320bfe0a25cd'
final_revision: 'e53e9bae7e182610fcd83805661bc35aa5bd9660'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** `credential-store.ts` loads all records into an in-memory `Map` and, on each mutation, re-encrypts and atomically renames the whole file — with no lock or read-modify-write reconciliation. Two persistent Core instances over the same app dir → last flush wins, silently dropping the other's saved/deleted connections (lost update). Symmetrically, `store-key.ts` `loadOrCreateStoreKey` has a generate-on-`not-found` window where two processes each mint a different 32-byte key; the loser's already-encrypted file becomes permanently undecryptable. The atomic rename prevents torn files, not lost updates or the key race.

**Approach:** Add a cross-process advisory writer lock (`credential-store.lock`) acquired ONCE at the start of the persistent-mode `openCredentialStore` path — before the descriptor read, key load, and mint-on-first-run — and held for the store handle's lifetime. A second live process is refused with a typed `locked` result instead of opening a writable store; holding the lock across `loadOrCreateStoreKey` closes the key race too. The lock is a `0o600` file created via `O_EXCL`, reclaimed when its recorded holder is provably dead (same-host PID liveness), and released on `store.close()` (wired into clean shutdown).

## Boundaries & Constraints

**Always:**
- Lock ONLY in the persistent branch, acquired after `ensureAppDir()` and before `readDescriptor`/`loadStoreKey`/mint. Ephemeral mode stays a hard no-write: it returns before any dir/lock work (preserves the `spec-1-2` boot-writes-nothing invariant).
- The lock file lives at `<appDir>/credential-store.lock`, mode `0o600`, created atomically via `openSync(path, "wx")` (`O_EXCL`). It records only the holder's PID, hostname, and an ISO timestamp — never a key, passphrase, or connection data.
- Every failure arm is a typed `OpenResult`; `openCredentialStore` never throws for expected conditions. Contention returns the new `locked` arm; a lock I/O error returns the existing non-destructive `unavailable`.
- On ANY early return after the lock is acquired (corrupt/schema-unknown/passphrase-declined/etc.), release the lock first — a failed open must never leak the lock. On success the store owns the release; `store.close()` releases it, idempotently.
- Stale reclaim is safe: a lock whose recorded holder is on THIS host and is dead (`ESRCH`), or whose file is malformed, is reclaimed via atomic rename-away (only one racer wins). A lock held by a live PID on this host, or by a DIFFERENT host (unverifiable liveness), returns `locked` — never silently clobbered.
- Same-process reentrancy: a lock whose recorded PID equals our own live PID is reclaimable (it is us). This keeps the single-*process*-writer guarantee while letting an in-process reopen succeed.
- Every new/changed behavior is unit-tested with the `bun:test` + injected-deps + discriminated-union-outcome house idiom. Existing credential-store tests stay green.

**Block If:**
- The keychain (`store-key.ts`) master-key semantics, the crypto envelope, or the on-disk store/descriptor formats would need to change to land this. (They must not — the lock is additive and orthogonal.)

**Never:**
- Do NOT introduce a read-modify-write/merge reconciliation of the record set, a new file format, or a schema-version bump.
- Do NOT add a global single-instance guard on the server port or a process-wide `process.on("exit")` handler.
- Do NOT add a third-party lock dependency (`proper-lockfile`, etc.) — use `node:fs` sync primitives only.
- Do NOT extend the lock to the provider-key store or workspace store — DW-14 is scoped to the credential store and its master key only.
- Do NOT block on a busy lock or spin/poll/retry-with-sleep — refusal is immediate and typed.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First writer | Persistent, no lock file | Creates `credential-store.lock` (0o600), proceeds to open; store owns release | No error expected |
| Ephemeral | `mode: "ephemeral"` | Returns in-memory store; NO dir, NO lock file touched; `close()` is a no-op | No error expected |
| Second live writer (same host) | Lock held by a different, live PID on this host | `openCredentialStore` → `{ outcome: "locked" }`; no store opened, no descriptor/key/file written | Refuse, non-destructive |
| Stale lock (dead holder) | Lock recorded PID on this host is dead (`ESRCH`) | Reclaims lock atomically, then opens normally | No error expected |
| Malformed lock file | Lock file unparseable / empty / wrong shape | Treated as stale → reclaimed → opens | No error expected |
| Foreign-host lock | Lock recorded host ≠ our hostname | `{ outcome: "locked" }` (liveness unverifiable; refuse rather than clobber); detail names the stale-lock path | Refuse, non-destructive |
| Lock I/O error | `O_EXCL` create fails with a non-`EEXIST` error (EACCES/EIO) | `{ outcome: "unavailable" }` | Non-destructive |
| Reentrant reopen (same process) | Lock recorded PID == our own live PID | Reclaimed (it is us) → opens | No error expected |
| Failed open releases lock | Lock acquired, then descriptor/key/passphrase arm fails | Lock released before the typed failure returns; no leaked lock file | Release-then-return |
| Clean shutdown | `store.close()` (via `connectionRegistry.close()` in `Core.stop`) | Lock file removed; next launch needs no reclaim | Best-effort, swallow errors |
| Key race closed | Two processes on first run | Only the lock holder reaches `loadOrCreateStoreKey`; the loser gets `locked` before minting | No competing key mint |

</intent-contract>

## Code Map

- `src/core/store-lock.ts` -- NEW. The advisory writer-lock module: `acquireStoreLock(lockPath, deps?)` → discriminated union (`acquired` w/ `release`, `held`, `unavailable`); `O_EXCL` create, same-host PID-liveness stale reclaim, rename-away reclaim race safety, injectable fs/pid/host/isProcessAlive seams.
- `src/core/store-lock.test.ts` -- NEW. Unit tests over the injected seams: acquire, held-by-live-PID, stale reclaim (dead PID), malformed reclaim, foreign-host refuse, reentrant same-PID, I/O `unavailable`, release idempotency, reclaim race.
- `src/core/credential-store.ts` -- EDIT. Add `STORE_LOCK_FILE_NAME`; add `locked` to `OpenResult`; add `acquireLock?` seam and `close(): void` to the store; acquire the lock in the persistent branch and release on every failure arm; thread `release` into `buildStore`.
- `src/core/store-key.ts` -- UNCHANGED (race is closed by holding the lock across `loadOrCreateStoreKey`; no code change needed). Referenced in Code Map for reviewer context only.
- `src/core/connection-registry.ts` -- EDIT. Add `close(): void` that releases the memoized store's lock and clears the cache. (`obtain()`'s existing catch-all already maps the new `locked` arm to `internal_error`.)
- `src/core/server.ts` -- EDIT. Call `connectionRegistry.close()` inside `Core.stop` so a clean shutdown releases the lock.
- `src/core/credential-store.test.ts`, `src/core/connection-registry.test.ts` -- EDIT. Add `close` to fake stores; add `locked`/reentrancy/release coverage.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/store-lock.ts` -- Implement `acquireStoreLock` and its `StoreLockResult`/`StoreLockDeps` types with injectable `fs` (exclusive create, read, rename-reclaim, remove), `pid`, `host`, `now`, and `isProcessAlive` seams; default to `node:fs` sync + `process.pid` + `os.hostname()` + `process.kill(pid, 0)`. Reclaim only same-host-dead/malformed/own-PID; refuse (`held`) on live-same-host or foreign-host; map non-`EEXIST` create errors to `unavailable`; provide an idempotent, PID-guarded `release`.
- [x] `src/core/credential-store.ts` -- Add `export const STORE_LOCK_FILE_NAME = "credential-store.lock"`; add `{ outcome: "locked"; detail }` to `OpenResult`; add `acquireLock?: (lockPath: string) => StoreLockResult` to `CredentialStoreDeps` (default `acquireStoreLock`); add `close: () => void` to `CredentialStore`. In the persistent branch, acquire the lock right after computing `filePath`/`metaPath`; return `locked`/`unavailable` on contention/error; on `acquired`, run the existing open logic and release on any non-`opened` result; pass `release` into `buildStore` so `close()` releases it once. Ephemeral passes a `null` release (no-op `close`).
- [x] `src/core/connection-registry.ts` -- Add `close(): void` to the `ConnectionRegistry` type and implement it (`cached?.close(); cached = null;`), swallowing any error.
- [x] `src/core/server.ts` -- Invoke `connectionRegistry.close()` within `Core.stop` (best-effort; it swallows its own errors) so the lock is released on clean shutdown.
- [x] `src/core/store-lock.test.ts` -- Cover every I/O Matrix row for the lock module via injected seams, plus `release` idempotency and the reclaim race (two acquirers, one wins).
- [x] `src/core/credential-store.test.ts` -- Add tests: a second open with an injected `acquireLock` returning `held` → `locked` (nothing written); an injected `unavailable` → `unavailable`; `close()` releases (release seam observed); an in-process reopen still succeeds under the real lock; a post-acquire failure arm (e.g. corrupt descriptor) leaves no lock file. Keep the 51 existing opens green.
- [x] `src/core/connection-registry.test.ts` -- Add `close` to the fake store; test that `registry.close()` calls `store.close()` and that a subsequent call re-opens.

**Acceptance Criteria:**
- Given a persistent store already opened by a live process on this host, when a second process calls `openCredentialStore`, then it returns `{ outcome: "locked" }` and writes no descriptor, `.enc`, or key.
- Given a lock file whose recorded holder is a dead PID on this host, when `openCredentialStore` runs, then it reclaims the lock and opens normally.
- Given two processes racing a true first run, when both attempt to open, then exactly one acquires the lock and mints the master key; the other gets `locked` before reaching `loadOrCreateStoreKey`, so no competing key is minted.
- Given `mode: "ephemeral"`, when `openCredentialStore` runs, then no lock file is created and `store.close()` is a no-op.
- Given a successful open followed by `connectionRegistry.close()` in `Core.stop`, when the process exits cleanly, then the lock file is removed and a relaunch needs no reclaim.
- Given the existing credential-store and connection-registry suites, when `bun test` runs, then they remain green (in-process reopen still succeeds via same-PID reentrancy).

## Spec Change Log

_No bad_spec loopbacks — the implementation followed the intent contract; review findings were resolved as in-diff patches (see Review Triage Log)._

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 1, medium 1, low 3)
- defer: 2: (high 0, medium 2, low 0)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[high]` `[patch]` F1 — `createExclusive` used `openSync("wx")` then a separate `writeFileSync`, exposing an empty-lock window in which a concurrent acquirer read the empty file, treated it as reclaimable-stale, and reclaimed a live in-progress lock → BOTH processes acquired (double-mint / lost-update, the exact concurrent-first-run threat). Fixed: write the full body to a private temp, then `linkSync` it atomically into place (target is never observed empty); `EEXIST` = single-winner; fallback to `O_EXCL` open only on link-hostile filesystems. Also subsumes F4 (failed body write can no longer leak an empty visible lock).
  - `[medium]` `[patch]` E2/F9 — `release` was keyed on pid+host only, so after an in-process reentrant reclaim, the first handle's `close()` could delete the second handle's LIVE lock. Fixed: per-acquire random token in the lock body; `release` removes only when pid+host+token all match ours.
  - `[low]` `[patch]` E4 — `readLockInfo` used `parseInt`, coercing `"1000-garbage"` to a valid pid → false `held`. Fixed with a strict `/^\d+$/` guard (malformed → reclaimable).
  - `[low]` `[patch]` F10/E3 — `connectionRegistry.close()` cleared the cache but left the registry re-openable, so an in-flight op during shutdown could re-acquire and leak the lock. Fixed: `close()` is now terminal (a `closed` latch makes `obtain()` refuse with `internal_error` after shutdown).
  - `[low]` `[patch]` E5 — wrapped the failure-path `lock.release()` and `store.close()` release in try/catch to honor the never-throw boundary against a throwing release seam.

### 2026-07-15 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 2: (high 0, medium 2, low 0)
- reject: 8: (high 0, medium 3, low 5)
- addressed_findings:
  - `[low]` `[patch]` EC-2/F11 — `openCredentialStore` checked `openPersistent`'s RETURNED result for a non-`opened` arm and released the lock there, but the call itself was not guarded against an UNEXPECTED throw (a contract-violating key/fs seam, an allocation failure): such a throw escapes after the writer lock is acquired and leaks it, violating the intent-contract boundary "a failed open must never leak the lock." Fixed: wrapped the `openPersistent` call in try/catch that releases the lock best-effort (idempotent) before re-throwing the exceptional error; added a unit test (throwing key seam on a fresh dir → the acquired lock's `release` fires exactly once and the throw propagates). The two `high` identity-model findings (host+pid collision across containers, PID reuse) and the link-hostile fallback window were rejected/deferred, not patched — see below.
- deferred (new ledger entries, orchestrator owns status):
  - `[medium]` link-hostile-FS empty-lock-body window → double-acquire (fallback `openSync("wx")`+`writeFileSync`) and `null`-body release deleting a live lock (Blind H1, Edge EC-1/EC-5). Documented as accepted residual risk in this spec; deferred for a focused link-hostile-create hardening / scope decision.
  - `[medium]` the `locked` outcome is flattened to a generic `internal_error` at `connectionRegistry.obtain()`, so "another instance is already running" is never surfaced (Blind H5). Recovery/surface UX is consciously out of the single-writer core scope; deferred.
- rejected (accepted design / consistent with prior pass): `[medium]` host+pid identity collides across same-hostname containers on a shared dir (H2/EC-4) and `[medium]` PID reuse yields a permanent false `locked` (H3/EC-3) — both are the documented `(host,pid)` identity limitation (foreign-host conservative refuse; non-destructive availability-only); `[medium]` same-PID reentrant reclaim allows two in-process handles (H4) is mandated by the intent-contract reentrancy boundary and bounded by the registry's single-store memoization; `[low]` orphan `.stale`/`.acquire` temps (L1/EC-7), `[low]` retry-budget exhaustion reported as `held` (L2/EC-6), `[low]` "created via O_EXCL" doc vs. primary `linkSync` (L3), `[low]` temp write uses `'w'` not `'wx'` with a random-UUID name (L4), `[low]` lock released before the rest of `Core.stop` teardown — benign under single-threaded shutdown (L5).

## Design Notes

Advisory-lock acquire (default path), pseudo-code:

```
for attempt in 0..3:
  try openSync(lockPath, "wx", 0o600); write `${pid}\n${host}\n${iso}`; close → return { acquired, release }
  catch EEXIST:
    info = parse(read(lockPath))            // {pid,host} | null
    if info == null            → reclaim; continue          // malformed → stale
    if info.host !== ourHost   → return held (foreign host)  // liveness unverifiable → refuse
    if info.pid === ourPid     → reclaim; continue          // reentrant: it's us
    if !isProcessAlive(info.pid) → reclaim; continue        // dead holder → stale
    else                       → return held                // live holder → refuse
  catch (other) → return unavailable
return held                                                  // contention exhausted
```

`reclaim`: `renameSync(lockPath, lockPath + ".stale." + uuid)` then `rmSync` — atomic, so under a reclaim race only one process renames the stale file away; the loser gets `ENOENT`/`EEXIST` and re-evaluates (seeing the winner's fresh live lock → `held`). The `.stale.<uuid>` temp is NOT `.tmp`, so it never trips the existing `.tmp`-residue assertion. `release`: guarded by a `released` flag and a best-effort PID-match check before `rmSync(force)`.

`isProcessAlive(pid)`: `process.kill(pid, 0)` → true; `ESRCH` → false; `EPERM` → true (exists, not signalable). Known limitation (documented in-file): PID liveness is only meaningful on the recording host — hence the foreign-host conservative refuse; a stale foreign-host lock is cleared by deleting `credential-store.lock` manually.

## Verification

**Commands:**
- `bun test src/core/store-lock.test.ts` -- expected: all new lock-module tests pass.
- `bun test src/core/credential-store.test.ts src/core/connection-registry.test.ts` -- expected: existing + new tests green.
- `bun test` -- expected: full suite green (no regression in server/rpc suites from the `Core.stop` / registry `close()` additions).

## Auto Run Result

Status: done

**Implemented change:** Established a cross-process single-writer guarantee for the credential store (DW-14). A new advisory writer lock (`credential-store.lock`) is acquired ONCE at the start of the persistent-mode `openCredentialStore` path — before the descriptor read, master-key load, and first-run mint — and held for the store handle's lifetime. A second live writer on the same host is refused with a typed `locked` result instead of opening a writable store; because the lock is held across `loadOrCreateStoreKey`, the generate-on-`not-found` master-key race is closed too. Ephemeral mode is untouched (returns before any dir/lock work — still 100% disk-free). The lock releases on `store.close()`, wired into `Core.stop` via `connectionRegistry.close()`.

**Files changed:**
- `src/core/store-lock.ts` (NEW) -- advisory writer-lock module: `acquireStoreLock` → `acquired`/`held`/`unavailable`; atomic temp-then-`linkSync` create (no empty-lock window), per-acquire token, same-host PID-liveness stale reclaim (rename-away, race-safe), foreign-host conservative refuse, idempotent token-guarded release.
- `src/core/store-lock.test.ts` (NEW) -- 14 tests over injected in-memory-fs seams + a real-disk atomicity test.
- `src/core/credential-store.ts` -- `STORE_LOCK_FILE_NAME`; `locked` arm on `OpenResult`; `acquireLock?` seam; `close()` on the store; lock acquired in the persistent branch and released on every non-`opened` arm; `release` threaded through `buildStore` (ephemeral passes `null` → no-op `close`).
- `src/core/connection-registry.ts` -- terminal `close()` that releases the memoized store's lock and refuses re-open afterward.
- `src/core/server.ts` -- `connectionRegistry.close()` in `Core.stop` for clean-shutdown release.
- `src/core/credential-store.test.ts`, `src/core/connection-registry.test.ts`, `src/core/rpc.test.ts` -- new/updated coverage (`locked`/`unavailable`/reentrancy/close-release/terminal-close) and fake-store `close` additions.

**Review findings breakdown:** 5 patches applied (1 high F1 empty-lock-window double-acquire; 1 medium E2/F9 token-guarded release; 3 low: strict PID parse, terminal registry close, defensive release). 4 rejected as noise/accepted-design (F5 PID-reuse/shared-UTS, F6 retry-exhaustion false-refuse, F7 `.stale` orphan housekeeping, F8 diagnostic timestamp / no-TTL-by-design). 2 deferred for focused follow-up (NOT recorded in the ledger by this run — surfaced here for the orchestrator):
- **F2 (medium):** the writer lock is acquired unconditionally at the top of the persistent path, so on a read-only app dir (`EROFS`/`EACCES`) a previously-working read-only `list` now returns `unavailable`. Fixing it well needs a design decision (degraded read-only open when the lock cannot be created).
- **F3 (medium):** on a synced/network home shared across machines, a crashed/foreign-host holder leaves the store `locked` with an opaque `internal_error` and no in-product hint to delete `credential-store.lock`. Recovery UX is out of the single-writer core scope.

**Follow-up review recommended:** `true` — the final pass fixed a high-consequence correctness defect in the core concurrency guarantee (F1, data-loss-preventing) plus a medium concurrency-semantics change (token-guarded release); an independent pass on the revised lock/release logic is warranted.

**Verification performed:**
- `bun test src/core/store-lock.test.ts` → 14 pass / 0 fail.
- `bun test src/core/credential-store.test.ts src/core/connection-registry.test.ts` → 70 pass / 0 fail.
- `bun test` (full) → 1095 pass / 0 fail across 69 files. (`[rpc] handler … threw` / `provider stream failed` in stderr are pre-existing expected diagnostics from unrelated suites.)
- `npx tsc --noEmit` → exit 0.

**Residual risks:** PID-liveness is only meaningful on the recording host (documented in-file; foreign-host locks are conservatively refused). The real cross-process race is modeled sequentially over a shared fs (single-winner via `linkSync`/rename atomicity), not by spawning real concurrent processes. On link-hostile filesystems the atomic create falls back to `O_EXCL` open+write, reopening the tiny empty-lock window (the app dir is normally local disk). F2/F3 remain as deferred behavior/UX gaps.

---

### Follow-up review pass — 2026-07-15

An independent adversarial + edge-case pass over the final lock/release logic (recommended by the prior run) converged.

**Patched (1, low):** `openCredentialStore` released the writer lock only on `openPersistent`'s RETURNED non-`opened` arms, not on an UNEXPECTED throw escaping the total-return contract — a contract-violating seam / allocation failure after acquire would leak the lock. Wrapped the call in try/catch that releases best-effort (idempotent) before re-throwing; added a unit test (throwing key seam → lock released once, throw propagates). `src/core/credential-store.ts`, `src/core/credential-store.test.ts`.

**Deferred (2, new ledger entries):** (1) the link-hostile-filesystem fallback reopens the empty-lock-body window (double-acquire / `null`-body release deleting a live lock) — accepted residual risk in this spec, deferred for a focused hardening/scope decision; (2) the `locked` outcome is flattened to a generic `internal_error` at the registry, so "another instance is already running" is never surfaced — recovery UX consciously out of the single-writer core scope.

**Rejected (8):** the `(host,pid)` identity limitations (same-hostname container collision, PID reuse) are documented accepted design (non-destructive, foreign-host conservative refuse); same-PID reentrant reclaim is intent-contract-mandated and bounded by the registry's single-store memoization; the rest are cosmetic/benign (orphan temps, retry-exhaustion detail, O_EXCL doc wording, `'w'` temp mode, shutdown release ordering).

**Verification:** `npx tsc --noEmit` → exit 0; `bun test src/core/credential-store.test.ts src/core/connection-registry.test.ts src/core/store-lock.test.ts` → 85 pass / 0 fail; `bun test` (full) → 1096 pass / 0 fail across 69 files (the `[rpc] handler … threw` / `provider stream failed: boom` stderr lines are pre-existing expected diagnostics from unrelated suites).

**Follow-up review recommended:** `false` — this pass made a single localized low-consequence defensive fix; the significant findings were resolved in the prior pass or consciously deferred.
