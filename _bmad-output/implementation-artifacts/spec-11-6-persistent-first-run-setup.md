---
title: 'First-run setup for Persistent mode — interactive passphrase on a keychain-less host'
type: 'feature'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.6
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-3-passphrase-fallback.md'
---

<intent-contract>

## Intent

**Problem:** On a host with no reachable OS keychain, Persistent mode can only be unlocked with a passphrase, and the **only** ways to supply one are the `QS_PASSPHRASE` environment variable and the `QS_PASSPHRASE_FD` file descriptor (`src/core/passphrase-provider.ts:144-160`). There is no interactive path. A user who runs `quick-studio --persistent` on such a machine — a headless Linux box, a container, a WSL session with no D-Bus — gets a store that reports `passphrase-declined` and a workspace that cannot save anything, with the only remedy buried in a README section about file descriptors. The seam for fixing this was designed in from the start and then never filled: the module header states plainly that "Story 2.4 injects an interactive prompt later through this same seam" (`passphrase-provider.ts:5-8`), and Story 2.4 shipped without it. This is the "setup" half of the epic's flow #3 — `--persistent` on a first run should *set the thing up*, not boot a store it cannot open.

**Approach:** Prompt **before** the Core boots, and inject the answer through the existing seam.
- The `PassphraseProvider` contract is **synchronous** (`(ctx) => PassphraseResponse`, `passphrase-provider.ts:45`), and an interactive terminal prompt is not. Rather than make the seam async — which would ripple through `openCredentialStore`'s total-boundary contract, `openPersistent`, and both store call sites — `bin/` performs a **pre-flight**: classify what the store will need, prompt asynchronously if it needs a passphrase, and hand `startCore` a pre-resolved provider closure that simply returns the captured value. The crypto layer is untouched.
- The pre-flight classification must **mirror** `openPersistent`'s existing branch logic (`credential-store.ts:527-611`): descriptor present → passphrase mode, prompt to unlock; descriptor absent but `.enc` present → keychain mode, no prompt; neither (true first run) → probe the keychain, and prompt only if it is unavailable.
- `startCore` gains an optional `passphraseProvider` in `StartCoreOptions`, defaulting to today's `resolvePassphraseProvider(process.env)` (`server.ts:269`) so nothing changes when no prompt happened.

## Boundaries & Constraints

**Always:**
- Echo is **disabled** while a passphrase is typed, and the terminal's original echo state is restored on every exit path — success, wrong passphrase, `Ctrl-C`, `Ctrl-D`, or an unexpected throw. Leaving a user's terminal with echo off is a serious, visible defect.
- The passphrase is **confirmed** (typed twice, compared) when creating a **new** store, and prompted once with a bounded retry budget when **unlocking an existing** one. `PassphraseContext.isFirstRun` (`passphrase-provider.ts:32`) already exists to carry exactly this distinction — the pre-flight computes it from the descriptor's presence.
- **One** provider instance is shared by both persistent stores, preserving the invariant documented at `credential-store.ts:518-522` and implemented at `server.ts:263-269`: the credential store and the provider-key store must never each consume a single-read source. A pre-resolved closure satisfies this naturally.
- The env and fd transports keep **absolute precedence**: if `QS_PASSPHRASE` or a valid `QS_PASSPHRASE_FD` is set, no prompt appears and behavior is byte-for-byte what it is today. The prompt is strictly a fallback for when neither is present.
- A **non-interactive** stdin never prompts. The process must not hang waiting for input that can never arrive; it falls through to today's typed `declined` outcome plus a pointer to `QS_PASSPHRASE_FD`.
- The keychain probe uses the existing wrapper (`src/core/keychain.ts`), which is already total and returns typed `not-found` / `unavailable` — never a throw and never a plaintext fallback.

**Block If:**
- If the pre-flight classification cannot be kept in lockstep with `openPersistent`'s branch logic, HALT and restructure instead: the two must not be independent re-implementations that can drift, because a drift means prompting when the store will not ask (a pointless prompt) or not prompting when it will (the bug we are fixing). Prefer extracting the classification into one shared, pure function consumed by both.
- If disabling terminal echo cannot be done reliably on **Windows** consoles under Bun with `node:readline`/raw-mode, flag it before implementing — a prompt that echoes a passphrase to the screen is worse than no prompt at all, and the correct fallback is to skip prompting on that platform and keep today's env/fd behavior.

**Never:**
- Never echo, log, or write the passphrase anywhere. Never place it into `process.env` — the whole point of the fd transport (`passphrase-provider.ts:52-59`) is that the environment is a known leak surface, and a prompt that then exports the secret would defeat it.
- Never prompt in **Ephemeral** mode (no store is ever opened) and never prompt when the keychain is available.
- Never prompt on a non-TTY stdin, and never block boot waiting for input.
- Never weaken, bypass, or reorder any existing store-open path: the descriptor is still authoritative, a declined passphrase still writes nothing (no descriptor, no ciphertext, no plaintext), and the advisory writer lock (`store-lock.ts`) is unaffected.
- Never retry unlocking without a bound.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Keychain available, first run | Persistent, no descriptor, no `.enc`, keychain reachable | No prompt; keychain path exactly as today | none |
| Keychain unavailable, first run, TTY | Persistent, no descriptor, no `.enc`, keychain `unavailable`, interactive stdin | Explain why, prompt with echo off, **require confirmation**, then boot with the store created in passphrase mode | Mismatch → re-prompt within the retry budget |
| Keychain unavailable, existing store, TTY | descriptor present, interactive stdin | Single prompt (no confirmation), bounded retries on a wrong passphrase | Exhausted retries → today's typed failure, nothing written |
| Env transport set | `QS_PASSPHRASE` non-empty | **No prompt**; unchanged behavior | none |
| Fd transport set | `QS_PASSPHRASE_FD=3` valid | **No prompt**; unchanged behavior, single-read semantics preserved | none |
| Fd transport malformed | `QS_PASSPHRASE_FD=abc` | **No prompt** — the operator explicitly opted out of the env transport (`passphrase-provider.ts:157-159`), and prompting would be a third silent fallback they did not ask for | Declines exactly as today |
| Non-TTY stdin | piped/CI/service manager, no env, no fd | No prompt, no hang; typed `passphrase-declined` + a stderr pointer to `QS_PASSPHRASE_FD` | Fail fast |
| Ctrl-C during the prompt | user aborts | Terminal echo restored, clean exit, nothing written to disk | Must not leave echo off |
| Ephemeral mode | `quick-studio postgres://x` | No prompt, no store, no disk — unchanged | Hard invariant |
| Both stores | credential store + provider-key store in one boot | Exactly **one** prompt; both stores unlock from the same captured value | Never two prompts |
| Descriptor absent, `.enc` present | Story 2.2 back-compat layout | Keychain mode; **no** prompt, mirroring `credential-store.ts:571-576` | Classification must match |

</intent-contract>

## Acceptance Criteria

- Given a keychain-less host with an interactive terminal, when Persistent mode starts for the first time, then the user is prompted (echo off, with confirmation) and the store is created in passphrase mode.
- Given an existing passphrase-mode store, when it starts, then a single prompt unlocks it with bounded retries and no confirmation step.
- Given `QS_PASSPHRASE` or a valid `QS_PASSPHRASE_FD`, when the app starts, then no prompt appears and behavior is unchanged.
- Given a non-interactive stdin, when a passphrase would be needed, then the app fails fast with the existing typed outcome and a pointer to `QS_PASSPHRASE_FD` — it never hangs.
- Given any exit path from a prompt, when the process ends, then terminal echo is restored.

## Code Map

- `src/core/store-presence.ts` (new, shared with Story 11.7) — a pure-ish probe over the app-data directory: does the descriptor exist, does the `.enc` exist. **No decryption, no key load, no lock acquisition.** Returns a typed classification (`first-run` / `keychain-mode` / `passphrase-mode`) that mirrors `openPersistent`'s branches. This is the anti-drift measure from Block-If #1; ideally `openPersistent` consumes the same classifier.
- `src/core/passphrase-prompt.ts` (new) — the interactive prompt: TTY detection, echo suppression, confirm-on-create, bounded retries, guaranteed echo restoration. Async, dependency-injected (input/output streams, `isTTY`) so it is testable without a real terminal. Returns a `PassphraseResponse`, so `bin/` can wrap it in a pre-resolved closure that satisfies the existing sync `PassphraseProvider` type.
- `src/core/server.ts` — add an optional `passphraseProvider` to `StartCoreOptions` (`:114`), defaulting at `:269` to today's `resolvePassphraseProvider(process.env)`. Both store call sites (`:272`, `:286`) keep sharing the single instance.
- `bin/quick-studio.ts` — the pre-flight, between `parseCliArgs` and `startCore`: if Persistent, and no env/fd transport, and the presence probe plus a keychain probe say a passphrase is needed, and stdin is a TTY → prompt, then pass the pre-resolved provider into `startCore`.
- `src/core/keychain.ts` — consumed as-is for the availability probe; no change expected.
- Tests — `store-presence.test.ts` (classification table, including the descriptor-absent-`.enc`-present back-compat case) and `passphrase-prompt.test.ts` (injected streams: confirmation mismatch, retry exhaustion, non-TTY, abort-restores-echo).

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] Resolve Block-If #2 (Windows echo suppression under Bun) **before** writing the prompt.
- [ ] Write `store-presence.ts` and settle how it stays in lockstep with `openPersistent` (shared classifier preferred over a parallel re-implementation).
- [ ] Write `passphrase-prompt.ts` with injected streams; guarantee echo restoration on every exit path.
- [ ] Add the optional `passphraseProvider` to `StartCoreOptions`; confirm the single-shared-instance invariant still holds for both stores.
- [ ] Wire the `bin/` pre-flight with the correct precedence: env/fd first, then TTY prompt, then decline.
- [ ] Tests for the classification table and every prompt edge case in the matrix.
- [ ] Manually verify on a keychain-less host (a container with no D-Bus is the easy repro) that a first run prompts, confirms, creates the store, and that a second run unlocks with one prompt.
- [ ] Manually verify Ctrl-C mid-prompt leaves the terminal usable.
- [ ] `bun x tsc --noEmit`, `bun test`, `bun run build` green; every existing credential-store and passphrase test unchanged.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

## Review Triage Log

<!-- populated by the review loop -->
