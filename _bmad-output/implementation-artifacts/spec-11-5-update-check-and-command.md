---
title: 'TTL-cached update availability check (ephemeral-safe) and a delegating update command'
type: 'feature'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.5
---

<intent-contract>

## Intent

**Problem:** Once quick-studio is installed rather than run from a checkout, a copy can sit at an old version indefinitely with no signal. `npx quick-studio@latest` always fetches the newest build, but a globally installed copy (`npm i -g`) and a downloaded standalone binary both go stale silently, and the product has no notion of its own version at all until Story 11.1 adds one. The naive fix — check for updates on every boot — is wrong twice over: it puts a network round-trip on the startup path of a tool whose cold start is a tracked concern (the Story 1.7 notes call out protecting a ≤2s cold start), and it collides head-on with the Epic 2 invariant that **Ephemeral mode never writes to disk** (`src/core/run-mode.ts:1-13`: "in Ephemeral mode NOTHING is ever written to disk"), because a sane check needs a cache and a cache is a file.

**Approach:** A check that is cheap, quiet, honest about failure, and mode-aware.
1. **Read the cache, then maybe refresh.** On a Persistent boot, read `update-check.json` from the app-data directory (`src/core/app-dir.ts`). If the cached `latest` is newer than `VERSION` (11.1), print one terse stderr line. If the cache is older than the 24h TTL, fire a **non-blocking** request to the npm registry with a short timeout, and write the result back for the *next* boot to use. Boot never waits on the network.
2. **Ephemeral mode does not participate at all** — no read, no write, and `ensureAppDir()` is not even called (it would `mkdir` the directory, which is itself a disk write).
3. **`quick-studio update` delegates, it does not self-replace.** It detects how the running copy was installed and prints the exact command or URL to update it. In-place replacement of a running executable — with its Windows "cannot overwrite a running image" dance — is explicitly out of scope for this epic; delegating is honest, portable, and one tenth the risk.

## Boundaries & Constraints

**Always:**
- The check is **fire-and-forget**, modeled on the existing `openBrowser` call at `bin/quick-studio.ts:109-111`: launched after the Core is listening, never awaited, and structurally incapable of delaying or failing the boot.
- Every network failure — offline, DNS failure, timeout, registry 5xx, malformed JSON — is a **silent no-op**. No warning, no stack, no non-zero exit. A user on a plane sees nothing unusual.
- The notice, when shown, is **one line on stderr**, consistent with every other diagnostic the CLI emits, and it names the new version and the command to get it. It never blocks, never prompts, and never appears more than once per boot.
- `QS_NO_UPDATE_CHECK` (non-empty) disables the check entirely in **every** mode — the same non-empty-string convention `QS_NO_OPEN` already uses (`src/core/cli-args.ts:125-127`).
- The cache file lives beside the existing app-data artifacts (`credential-store.enc`, `workspace-state.json`) under `resolveAppDir`, contains **no** secrets, and is treated as untrusted input on read: a corrupt or unparseable cache is discarded and re-fetched, never a crash.
- `quick-studio update` is a **read-only, advisory** command: it prints what to run and exits. It performs no download, no write, and no process replacement.

**Block If:**
- If detecting the install channel (npm-global vs npx cache vs standalone binary) cannot be done reliably — the intended signal is whether the running executable sits inside a `node_modules` tree, which is inference, not fact — then degrade to printing **all** applicable update instructions rather than guessing wrong and telling the user to run a command that does not apply to them. Flag the chosen detection in step-02.
- If the fire-and-forget write can outlive the process and leave a truncated cache file on an abrupt exit (Ctrl-C during the fetch), use the atomic write-then-rename discipline the credential store already uses; if that cannot be done without awaiting the write, HALT rather than trading boot latency for it.

**Never:**
- Never read or write **anything** on disk in Ephemeral mode — including `ensureAppDir()`. This is the hardest constraint in the story.
- Never auto-update, never download an artifact, never replace the running executable, and never prompt during boot.
- Never let the check produce a non-zero exit code, delay the listening URL, or emit output when there is no update.
- Never send anything to the registry beyond a plain version lookup — no telemetry, no identifiers, no machine info.
- Never write a version cache from a `--help`/`--version` invocation (11.1 exits before the Core boots).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh persistent boot, no cache | Persistent, cache absent | Boot proceeds normally with no notice; check fires in the background; cache written for next time | Write failure is silent |
| Cached, up to date | cache fresh, `latest === VERSION` | No output at all | none |
| Cached, update available | cache fresh, `latest > VERSION` | One stderr line: new version + how to get it | none |
| Cache stale | `checkedAt` older than 24h | Cached notice (if any) still shown immediately; refresh happens in the background | none |
| Offline | no network | Silent no-op; boot identical to normal | Never surfaced |
| Registry 5xx / timeout / garbage JSON | bad response | Silent no-op; cache left as-is | Never surfaced |
| Corrupt cache file | unparseable JSON on disk | Discarded and re-fetched; no crash, no warning | Treated as untrusted input |
| **Ephemeral boot** | `quick-studio postgres://x` | **Zero** filesystem access for the update path — no `ensureAppDir`, no read, no write | Hard invariant |
| Disabled | `QS_NO_UPDATE_CHECK=1` | No check in any mode | none |
| `update`, npm-installed | `quick-studio update` from a global npm install | Prints the `npm i -g quick-studio@latest` command; exits 0 without booting | none |
| `update`, standalone binary | `quick-studio update` from a downloaded binary | Prints the platform's Releases download URL and how to verify it against `SHA256SUMS` (11.2); exits 0 | none |
| `update`, undetectable channel | ambiguous layout | Prints both sets of instructions rather than guessing | Block-If #1 |
| Subcommand vs URL collision | `quick-studio update` | The literal sole positional `update` is intercepted as the subcommand **before** the URL shape check at `cli-args.ts:104-116`; unambiguous because a database URL always has a scheme | Any other positional is still parsed as a URL exactly as today |

</intent-contract>

## Acceptance Criteria

- Given a Persistent boot with a stale cache, when the Core starts, then the listening URL appears with no added latency and the refresh happens in the background.
- Given an Ephemeral boot, when the Core starts, then nothing in the update path touches the filesystem — no directory creation, no read, no write.
- Given no network, when the check runs, then nothing is printed and the exit code is unaffected.
- Given `quick-studio update`, when it runs, then it prints the correct instructions for how this copy was installed and exits 0 without booting the Core or modifying anything.

## Code Map

- `src/core/update-check.ts` (new) — the whole feature, split so the decision logic is pure and testable: a pure `shouldNotify(currentVersion, cached, now)` and a pure `isCacheStale(cached, now, ttl)`, plus a thin impure `runUpdateCheck(mode, env, deps)` that guards on mode/env, reads the cache, and fires the refresh. Injectable `fetch`, clock, and app-dir seams — matching the dependency-injection style of `credential-store.ts` and `app-dir.ts` (`resolveAppDir` pure, `ensureAppDir` impure).
- `src/core/update-check.test.ts` (new) — table tests over the pure helpers; injected seams for the impure path, including an assertion that the **Ephemeral** path performs zero filesystem calls.
- `src/core/version.generated.ts` — consumed from 11.1 as the current-version source.
- `src/core/cli-args.ts` — intercept the sole literal positional `update` as a subcommand before URL validation; surface it in `CliArgs`. Stays pure.
- `bin/quick-studio.ts` — handle the `update` subcommand as an early exit (like 11.1's help/version, no Core boot); invoke the fire-and-forget check after the listening-URL write at `:80`, alongside the existing best-effort `openBrowser`.
- `README.md` — document `QS_NO_UPDATE_CHECK`, the 24h TTL, what is sent (a version lookup, nothing else), and `quick-studio update`.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] Pure helpers first: version comparison, staleness, notify decision.
- [ ] Cache read/write under `resolveAppDir`, atomic write, corrupt-cache tolerance.
- [ ] Mode/env guard — prove by test that Ephemeral makes **zero** filesystem calls.
- [ ] Fire-and-forget refresh with a short timeout; every failure silent.
- [ ] One-line stderr notice, at most once per boot.
- [ ] `update` subcommand: intercept the positional, detect the install channel (or print both), early-exit without booting.
- [ ] README: env var, TTL, what is sent, the update command.
- [ ] `bun x tsc --noEmit`, `bun test`, `bun run build` green; manually confirm an offline boot is silent and an Ephemeral boot creates no app-data directory.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

## Review Triage Log

<!-- populated by the review loop -->
