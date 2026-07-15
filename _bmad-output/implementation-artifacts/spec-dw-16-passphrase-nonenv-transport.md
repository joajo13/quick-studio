---
title: 'DW-16: Non-env passphrase transport (fd/stdin) for the keychain-less fallback'
type: 'feature'
created: '2026-07-15'
status: 'done'
baseline_revision: '2cc71352002538f3f1e65fae787e93b847e48cbe'
final_revision: '8006628d044ccec2687c51f048937f5ad7572f78'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** The keychain-unavailable passphrase fallback (Story 2.3) reads the secret only from the `QS_PASSPHRASE` environment variable (`envPassphraseProvider`, the intent-contract-sanctioned default). On exactly the headless hosts this fallback targets, an env secret is readable via `/proc/<pid>/environ` by same-user tooling, is inherited by every spawned child process, and can be captured in core dumps — never disk/logs, but a well-known env-secret leak surface.

**Approach:** The synchronous provider seam already exists. Add an **alternate** provider that reads the passphrase from a file descriptor (stdin or an inherited fd) instead of the environment, selected opt-in via a new `QS_PASSPHRASE_FD` env var (which carries an fd number, not the secret). A resolver picks the fd provider when `QS_PASSPHRASE_FD` names a valid fd, otherwise keeps today's env provider verbatim; both credential stores default through the resolver. Document the `QS_PASSPHRASE` exposure and the hardened fd alternative in code and the README.

## Boundaries & Constraints

**Always:**
- The new provider lives in `src/core/passphrase-provider.ts` (Ring 1) and conforms to the existing **synchronous** `PassphraseProvider` / `PassphraseResponse` contract — total, typed discriminated result, **never throws** for any input or I/O condition.
- The fd provider reads from the given file descriptor synchronously (`node:fs` `readFileSync`, no new dependency), strips exactly **one** trailing line ending (`\r?\n`) — the transport delimiter — then applies the same empty/whitespace-only → `declined` rule as the env provider. Interior and leading characters (including spaces) are preserved verbatim, mirroring `envPassphraseProvider`'s "keep surrounding characters" behavior.
- Any read failure (invalid/closed fd, `readFileSync` throw, EOF-only/empty content) resolves to `declined` — the fail-safe outcome that writes nothing. The passphrase and fd contents are never logged (never embedded in any `detail`).
- `resolvePassphraseProvider(env)` selects the transport: `QS_PASSPHRASE_FD` set to a valid non-negative integer fd → fd provider; absent/blank → `envPassphraseProvider(env)` (today's behavior, byte-for-byte). `QS_PASSPHRASE_FD` present but malformed (non-integer, negative) → a **declining** provider — it must NOT silently fall back to reading `QS_PASSPHRASE`, since the operator explicitly opted out of the env transport.
- Both `credential-store.ts` and `provider-key-store.ts` default their `passphraseProvider` to `resolvePassphraseProvider(process.env)` instead of `envPassphraseProvider(process.env)`. With `QS_PASSPHRASE_FD` unset this is behaviorally identical to today, so all existing store tests stay green.
- Follow Core conventions: kebab-case module, explicit `.ts` import extensions, inline `type` imports, co-located `bun:test`, keep the FR-5/AD-5 JSDoc citations. Injectable read function so tests never touch a real fd.

**Block If:**
- The synchronous `PassphraseProvider` signature can no longer express a working fd read (e.g. it must become async to read stdin) — that would ripple into both stores and is a design change beyond this hardening. HALT rather than change the seam's sync contract.

**Never:**
- Do not build an interactive TTY passphrase prompt or any UI/RPC surface — that is Story 2.4. Expose the passphrase only through the provider seam.
- Do not change the on-disk formats, KDF, descriptor, or any store crypto/lifecycle behavior. This adds a transport, nothing else.
- Do not remove or deprecate `envPassphraseProvider` / `QS_PASSPHRASE` — it stays the default when no fd is configured. Do not add a new crypto/KDF dependency.
- Do not pass the secret itself through `QS_PASSPHRASE_FD` — it carries only an fd number.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| fd holds a passphrase | fd read returns `"hunter2\n"` | `provided`, passphrase `"hunter2"` (one trailing newline stripped) | No error |
| fd value with interior/leading spaces | fd read returns `" pw \n"` | `provided`, passphrase `" pw "` (only the terminal newline stripped) | No error |
| fd holds only a newline | fd read returns `"\n"` | `declined` (empty after strip) | `declined` |
| fd empty / EOF | fd read returns `""` | `declined` | `declined` |
| fd whitespace-only | fd read returns `"   "` | `declined` | `declined` |
| fd read throws | `readFileSync` throws (EBADF, closed fd) | `declined` — never throws | `declined` |
| resolver, fd configured | `QS_PASSPHRASE_FD="3"`, fd 3 readable | fd provider used; env `QS_PASSPHRASE` ignored | per fd rows |
| resolver, no fd configured | `QS_PASSPHRASE_FD` unset/blank | `envPassphraseProvider(env)` — unchanged | per env rows |
| resolver, malformed fd | `QS_PASSPHRASE_FD="abc"` / `"-1"` / `"3.5"` | declining provider; `QS_PASSPHRASE` NOT read | `declined` |

</intent-contract>

## Code Map

- `src/core/passphrase-provider.ts` (modify) -- add `fdPassphraseProvider(fd, readFd?)`, `resolvePassphraseProvider(env, readFd?)`, `PASSPHRASE_FD_ENV_VAR = "QS_PASSPHRASE_FD"`, and a `FdReader` type with a `node:fs` default. **CRITICAL — an fd is a single-read stream:** `fdPassphraseProvider` MUST read the fd **at most once** and memoize the resulting `PassphraseResponse` in the returned closure, so every subsequent invocation (a retry within one store, or a second store sharing the instance) returns the captured passphrase instead of re-reading a now-EOF fd. One-newline strip, empty/whitespace → `declined`, never throws. Add the `envPassphraseProvider` JSDoc security warning (`/proc/<pid>/environ`, child-env inheritance, core dumps) pointing at the fd transport.
- `src/core/server.ts` (modify) -- **construct ONE shared passphrase provider** `resolvePassphraseProvider(process.env)` and inject it into BOTH persistent-store registries via `storeDeps.passphraseProvider`: `createConnectionRegistry` (~line 262) and `createProviderRegistry` (~line 274). Both stores open in this one process; each building its own fd provider would drain the fd on the first open and starve the second. A single memoized instance serves both.
- `src/core/server.test.ts` (modify, if such coverage exists) -- assert the same passphrase-provider instance is shared across the connection and provider registries (a fd-backed provider invoked by both stores yields the passphrase to both).
- `src/core/passphrase-provider.test.ts` (modify) -- cover the I/O-matrix rows for `fdPassphraseProvider` and `resolvePassphraseProvider` using an injected reader. **The reader stub MUST model real single-read fd semantics** — return the content on the FIRST call and `""` on every subsequent call — and a test MUST assert the memoized provider still returns the passphrase on the 2nd/3rd invocation (the two-store / retry scenario). A stub that returns the same value every call would mask the single-read defect.
- `src/core/credential-store.ts` (modify) -- import `resolvePassphraseProvider`; change the default `deps.passphraseProvider ?? envPassphraseProvider(process.env)` to `?? resolvePassphraseProvider(process.env)`. (The default is the single-store fallback; the app shares one instance via `server.ts`.)
- `src/core/provider-key-store.ts` (modify) -- same default-wiring change as `credential-store.ts`.
- `README.md` (modify) -- add a short "Persistent mode & the keychain-less fallback" security note documenting the `QS_PASSPHRASE` env exposure and the hardened `QS_PASSPHRASE_FD` fd/stdin alternative. **Do NOT claim a blank `QS_PASSPHRASE_FD` declines** — a blank/unset value uses the env default (matches the resolver and the intent-contract I/O matrix); only a *present, non-empty, non-integer* value declines. Note that the fd content's single trailing newline is stripped, so feed the exact passphrase bytes.
- `src/core/crypto.ts` / `passphrase-key.ts` / `keychain.ts` / store descriptors -- reused unchanged.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/passphrase-provider.ts` -- add `fdPassphraseProvider` (read fd **at most once**, memoize the `PassphraseResponse` in the closure; strip one trailing `\r?\n`; empty/whitespace → `declined`; total/never-throw), `resolvePassphraseProvider`, `PASSPHRASE_FD_ENV_VAR`, `FdReader` (default `readFileSync(fd, "utf8")`); add the `envPassphraseProvider` JSDoc security warning -- the non-env transport, single-read-safe + documented exposure
- [x] `src/core/server.ts` -- build one shared `resolvePassphraseProvider(process.env)` and inject it into both the connection and provider registries via `storeDeps.passphraseProvider` -- so a single memoized fd read serves both stores
- [x] `src/core/passphrase-provider.test.ts` -- cover the I/O-matrix rows via an injected reader that models single-read fd semantics (content on first call, `""` after); include a test asserting the memoized provider returns the passphrase on repeat invocations (two-store/retry); resolver fd-configured/unset/blank/malformed; assert results never leak fd internals
- [x] `src/core/server.test.ts` -- if server wiring has test coverage, assert the connection and provider registries share one passphrase-provider instance (fd-backed provider serves both stores)
- [x] `src/core/credential-store.ts` -- default `passphraseProvider` through `resolvePassphraseProvider(process.env)` (env behavior unchanged when `QS_PASSPHRASE_FD` unset)
- [x] `src/core/provider-key-store.ts` -- same default-wiring change through `resolvePassphraseProvider(process.env)`
- [x] `README.md` -- document the `QS_PASSPHRASE` exposure and the `QS_PASSPHRASE_FD` fd/stdin alternative; blank/unset uses the env default (do NOT claim blank declines); note the single trailing newline is stripped

**Acceptance Criteria:**
- Given a keychain-less host where BOTH the credential store and the provider-key store open in one process, when the operator provides the passphrase over a single file descriptor named by `QS_PASSPHRASE_FD` (e.g. `printf %s "$SECRET" | QS_PASSPHRASE_FD=0 qs`) and does not set `QS_PASSPHRASE`, then BOTH stores unlock using the fd-supplied passphrase (the single-read fd is consumed once and shared), and the secret never enters the process environment.
- Given `QS_PASSPHRASE_FD` is unset, when a store opens, then behavior is byte-for-byte identical to today's `envPassphraseProvider` path and the full existing test suite stays green.

## Spec Change Log

### 2026-07-15 — bad_spec loopback (review iteration 1)
- **Triggering finding:** `[high]` Both `credential-store.ts` and `provider-key-store.ts` defaulted to independent `resolvePassphraseProvider(process.env)` instances, each calling `readFileSync(fd)`. A file descriptor is a single-read stream: in one process (`server.ts` opens both stores) the first open drains the fd and the second reads EOF → `""` → `passphrase-declined`, permanently starving the second store. The same single-read breaks retry-after-wrong-passphrase within one store.
- **Amended:** Code Map + Tasks now require (a) `fdPassphraseProvider` to read the fd **at most once** and memoize the `PassphraseResponse` in its closure, and (b) `server.ts` to construct ONE shared provider and inject it into both persistent-store registries. Test guidance now mandates a reader stub that models real single-read fd semantics (value once, then `""`) plus a memoization/two-store assertion. README task corrected to not claim a blank `QS_PASSPHRASE_FD` declines (blank/unset → env default per the intent-contract I/O matrix).
- **Known-bad state avoided:** shipping an fd transport that only unlocks whichever store opens first (order-dependent, silently half-broken on exactly the headless hosts the feature targets), with a green suite because the idempotent test double hid it.
- **KEEP (must survive re-derivation):** the untouched `envPassphraseProvider`/`QS_PASSPHRASE` default; the `envPassphraseProvider` JSDoc security warning; the resolver's malformed-fd → **decline** fail-safe (never fall back to reading `QS_PASSPHRASE`); the strict `/^\d+$/` fd validation; strip exactly ONE trailing `\r?\n`; no new dependencies (`node:fs`/`node:crypto` only); the README security note structure and examples.

## Review Triage Log

### 2026-07-15 — Review pass (iteration 1)
- intent_gap: 0
- bad_spec: 1: (high 1, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 8: (high 0, medium 2, low 6)
- addressed_findings:
  - `[high]` `[bad_spec]` Single-read fd drained by the first of two stores (and by retries) → second store permanently `declined`; test double masked it. Amended spec to require read-once memoization + one shared provider injected by `server.ts`, and single-read-modeling tests. (Absorbs the "test double masks the bug" and "retry drains fd" findings — same root cause.)
  - `[medium]` `[reject→folded]` README claimed a blank `QS_PASSPHRASE_FD` declines while code treats blank as unset→env. Resolved as a doc correction folded into the bad_spec amendment (blank/unset → env, per intent-contract), not a code-behavior change.
  - Rejected (by-design / out-of-scope, representative): strip asymmetry between env (verbatim) and fd (strips one `\r?\n`) — inherent to two transports feeding one KDF; documented, and env-verbatim is pre-existing; bare-`\r`-only not stripped — spec mandates `\r?\n`, and preserving it matches env-verbatim; multiple trailing newlines keep all-but-one — spec mandates single-strip (a test pins `pw\n\n`→`pw\n`); non-UTF8 fd bytes → U+FFFD — passphrases are text, consistent with env string handling; `readFileSync(0)` on a bare TTY blocks — inherent to the sanctioned synchronous `PassphraseProvider` contract (explicitly out of scope), mitigated by the piped-usage docs; malformed-fd / empty-fd diagnostics say "no passphrase provided" — the sync seam returns only `provided`/`declined` and cannot log, store-level diagnostics are out of scope; `/^\d+$/` accepts >`MAX_SAFE_INTEGER` — final outcome is a safe `declined` via EBADF.

### 2026-07-15 — Review pass (iteration 2)
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 2, low 2)
- defer: 0
- reject: 6: (high 0, medium 2, low 4)
- addressed_findings:
  - `[medium]` `[patch]` No test guarded the *laziness* of the valid-fd branch (an eager read would drain stdin at `startCore` even in Ephemeral mode). Added a test asserting construction reads nothing and the fd read defers to first invocation.
  - `[medium]` `[patch]` The store-level `?? resolvePassphraseProvider(process.env)` defaults are individually unsafe if two stores both fall back (single-read fd) — the whole fix rests on `server.ts` injecting one shared instance, with nothing warning the next author. Added explicit warning comments at both default sites (`credential-store.ts`, `provider-key-store.ts`).
  - `[low]` `[patch]` A misconfigured/uninherited fd declines with a generic "no passphrase provided" and no fd-specific signal. Added a README troubleshooting note (verify the fd is inherited / the number matches) — kept the never-leak-detail posture; guidance goes in docs, not `detail`.
  - `[low]` `[patch]` The memoization enlarges the passphrase in-memory retention surface vs. the env path. Added a JSDoc trade-off acknowledgement on `fdPassphraseProvider` (necessary; same lifetime as the derived keys; never written/logged).
  - Rejected (representative): independent verification confirmed the iteration-1 fix is correct and complete (memoization caches even `declined`, synchronous reads are race-free, `server.ts` injects one shared instance into both registries, tests genuinely exercise single-read semantics) — no correctness defect. Non-UTF-8 fd bytes → U+FFFD (passphrases are text; consistent with env string handling); `readFileSync(fd)` leaves the fd open (harmless for the single-shot CLI; closing an inherited stdin could break other readers); Edge Case Hunter's "per-store default builds its own instance" and "eager selection" both already resolved by the shared-instance injection and the launch-time nature of fd config (env-value laziness is preserved).

### 2026-07-15 — Review pass (follow-up, iteration 3)
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 0
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - none
- notes: Independent follow-up review over the final converged diff (Blind Hunter + Edge Case Hunter). Every finding is by-design, mandated by the `<intent-contract>`, or already adjudicated in iterations 1–2 — none actionable. Representative rejections: synchronous `readFileSync` blocking on a no-EOF pipe/TTY (the intent-contract deliberately sanctions the sync `PassphraseProvider` seam and makes going async a Block-If HALT, not an in-story fix; mitigated by piped-usage docs); memoized `declined` is permanent (required by the single-read fix — re-reading a drained fd is the exact bug repaired in iter-1; caching `declined` is unit-tested and iter-2-verified); non-UTF-8 fd bytes → U+FFFD (passphrases are text, consistent with env string handling; rejected twice already); shared-provider invariant guarded by comment (intent-contract mandates the per-store `resolvePassphraseProvider` default; injection resolves it, warning comments added in iter-2); malformed `QS_PASSPHRASE_FD` does not fall back to `QS_PASSPHRASE` (this IS the intent-contract's mandated fail-safe, not a regression); `^\d+$` accepts fds 1/2 and huge ints (invalid fds → EBADF → safe `declined`, rejected iter-1); strip `\r?\n` vs env-verbatim inequivalence (inherent to two transports, documented, rejected iter-1); undiagnosable `declined` (sync seam cannot log; README troubleshooting note added iter-2); no real-fd integration test (intent-contract mandates an injectable reader so tests never touch a real fd); in-memory secret retention (acknowledged in iter-2 JSDoc trade-off; inherent to immutable JS strings). Verification re-run on the unchanged diff: `bun x tsc --noEmit` clean; targeted suite 115 pass / 0 fail.

## Design Notes

- **An fd is a single-read stream — memoize, don't re-read.** `readFileSync(fd)` reads from the current offset to EOF and does not rewind; a second read (a retry, or a second store) yields `""`. `fdPassphraseProvider` therefore reads at most once and caches the resulting `PassphraseResponse` inside the returned closure. Golden shape:
  ```ts
  export function fdPassphraseProvider(fd: number, readFd: FdReader = defaultReadFd): PassphraseProvider {
    let cached: PassphraseResponse | undefined;
    return (_ctx) => (cached ??= readOnce(fd, readFd));
  }
  ```
  where `readOnce` does the try/catch read, one-newline strip, and empty/whitespace → `declined`.
- **One shared provider per process.** Because `server.ts` opens both the credential and provider-key stores, it builds a single `resolvePassphraseProvider(process.env)` and injects it into both registries' `storeDeps.passphraseProvider`. The per-store default (`?? resolvePassphraseProvider(process.env)`) remains as the single-store/test fallback. Security tradeoff (acceptable, must be noted): the memoized passphrase lives in that one closure for the process lifetime — the same lifetime as the derived keys already resident in the open stores; it is never written to disk or logged.
- **Transport selection & fail-safe.** `resolvePassphraseProvider`: absent/blank `QS_PASSPHRASE_FD` → `envPassphraseProvider(env)` (today's behavior); present + `/^\d+$/` → `fdPassphraseProvider`; present + malformed → a declining provider that does NOT read `QS_PASSPHRASE` (the operator explicitly opted out of the env transport).

## Verification

**Commands:**
- `bun x tsc --noEmit` -- expected: no type errors
- `bun test src/core/passphrase-provider.test.ts src/core/credential-store.test.ts src/core/provider-key-store.test.ts src/core/server.test.ts` -- expected: all pass, including the new fd/resolver rows, the single-read memoization test, and (if present) the shared-instance server assertion
- `bun test` -- expected: full suite green; deterministic and self-cleaning (no residual temp dirs, no `QS_PASSPHRASE`/`QS_PASSPHRASE_FD` leakage between tests)

**Manual checks:**
- On a keychain-less box: `printf %s "$SECRET" | QS_PASSPHRASE_FD=0 qs` (or `QS_PASSPHRASE_FD=3 qs 3< secretfile`) with `QS_PASSPHRASE` unset → BOTH the connection store and the AI-provider-key store unlock from the one fd read (not just whichever opens first); `cat /proc/<pid>/environ | tr '\0' '\n' | grep QS_PASSPHRASE` shows no secret (only the fd number). Reopen with the same fd input → connections/keys return; with a wrong passphrase → `corrupt`.

## Auto Run Result

Status: **done**

**Implemented change (DW-16):** A non-environment passphrase transport for the keychain-unavailable fallback, alongside the existing `envPassphraseProvider`/`QS_PASSPHRASE` default. `src/core/passphrase-provider.ts` gains `fdPassphraseProvider(fd, readFd?)` — reads the passphrase from a file descriptor (stdin or an inherited fd) synchronously, strips exactly one trailing `\r?\n`, empty/whitespace → `declined`, total/never-throws — and `resolvePassphraseProvider(env, readFd?)`, an opt-in transport selector keyed by a new `QS_PASSPHRASE_FD` env var (which carries an fd number, not the secret): absent/blank → env provider (byte-for-byte unchanged), valid non-negative integer → fd provider, present-but-malformed → fail-safe decline that never reads `QS_PASSPHRASE`. The `QS_PASSPHRASE` exposure (`/proc/<pid>/environ`, child-env inheritance, core dumps; never disk/logs) is documented in the `envPassphraseProvider` JSDoc and a new README section.

**Critical design point (fixed via an iteration-1 bad_spec loopback):** a file descriptor is a single-read stream, and `server.ts` opens two persistent stores (credential + provider-key) in one process. `fdPassphraseProvider` therefore reads the fd **at most once** and memoizes the `PassphraseResponse` in its closure, and `server.ts` constructs **one shared provider** injected into both registries — so a single fd read serves both stores and any retry, instead of the first store draining the fd and starving the second.

**Files changed:**
- `src/core/passphrase-provider.ts` — `fdPassphraseProvider` (read-once + memoize), `resolvePassphraseProvider`, `PASSPHRASE_FD_ENV_VAR`, `FdReader`/`defaultReadFd`, `envPassphraseProvider` security JSDoc.
- `src/core/server.ts` — one shared `resolvePassphraseProvider(process.env)` injected into the connection and provider registries via `storeDeps.passphraseProvider`.
- `src/core/credential-store.ts` / `src/core/provider-key-store.ts` — default `passphraseProvider` through `resolvePassphraseProvider(process.env)`; warning comments at the default sites about the shared-instance requirement.
- `src/core/passphrase-provider.test.ts` — full I/O-matrix coverage via a single-read reader stub; memoization (two-store/retry), declined-caching, and laziness tests; no-leak assertion.
- `README.md` — "Persistent mode & the keychain-less fallback" security + troubleshooting section.

**Review findings breakdown:** iteration 1 — 1 bad_spec (high; single-read fd starves the second store, test double hid it) → spec amended (read-once memoization + shared instance + single-read-modeling tests) and code re-derived; 8 rejected. Iteration 2 — independent re-review confirmed the fix correct and complete; 4 patches applied (2 medium: laziness test + default-site warning comments; 2 low: README troubleshooting note + JSDoc retention trade-off), 6 rejected. No intent_gap.

**Verification performed:**
- `bun x tsc --noEmit` → 0 type errors.
- `bun test` (full suite) → 1116 pass / 0 fail across 69 files; deterministic and self-cleaning (no residual temp dirs, no `QS_PASSPHRASE`/`QS_PASSPHRASE_FD` leakage).

**Residual risks:**
- No automated test asserts the `server.ts` shared-instance wiring itself (the server does not expose its registries/provider, and the spec forbids contorting that API); a future refactor inlining `resolvePassphraseProvider(process.env)` into each registry could reintroduce the fd-starvation bug with a green suite. Mitigated by warning comments at both default sites; the memoization guarantee is unit-tested.
- The memoized passphrase is resident for the provider's (process) lifetime — necessary for single-read correctness, never written/logged, same lifetime as the already-resident derived keys.
- Reading fd 0 on a bare TTY (no pipe/redirect) blocks synchronously until EOF — inherent to the sanctioned synchronous `PassphraseProvider` contract; the intended usage is piped/redirected, per the README.
- Non-UTF-8 fd bytes are lossy-decoded (passphrases are text); an inherited fd is not explicitly closed (harmless for the single-shot CLI).

**Follow-up review:** completed (iteration 3, 2026-07-15). An independent adversarial + edge-case pass over the final converged diff surfaced 11 findings, all rejected — every one is by-design, mandated by the `<intent-contract>`, or already adjudicated in iterations 1–2 (see Review Triage Log iteration 3). No code changed; `bun x tsc --noEmit` clean and the targeted suite stayed 115 pass / 0 fail. No further follow-up recommended — the converged implementation is confirmed and no review-driven changes were made.
