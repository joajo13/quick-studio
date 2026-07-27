---
title: 'TTL-cached update availability check (ephemeral-safe) and a delegating update command'
type: 'feature'
created: '2026-07-21'
status: 'done'
baseline_revision: 'c25dc91da8354e9ad6c45058179c65da48d60e46'
final_revision: '7f1c88a669c9ec14298e4cfa1a3c7946710b6445'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.5
warnings: [oversized]
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

## Code Map

- `src/core/update-check.ts` (new) -- the whole feature. Pure: `parseSemver(s)` + `isNewer(latest, current)` (numeric major.minor.patch compare, stable-only), `isCacheStale(checkedAt, now, ttlMs)`, `shouldNotify(currentVersion, cached, now)`, `detectInstallChannel(execPath)` → `"npm" | "standalone" | "unknown"`, `updateInstructions(channel)` → string. Impure, injectable seams: `runUpdateCheck(mode, env, deps)` (mode/env guard → read cache → notify → fire refresh) and `printUpdateInstructions(deps)` for the subcommand. `deps` bag defaults to real impls: `{ now, execPath, appDir, fetchImpl, readCache, writeCache, stderr }`.
- `src/core/update-check.test.ts` (new) -- table tests over the pure helpers; injected seams for `runUpdateCheck`, including an assertion that the **Ephemeral** path performs **zero** filesystem/network calls (spy deps never invoked).
- `src/core/version.generated.ts` -- consumed read-only as the current-version source (`VERSION`).
- `src/core/app-dir.ts` -- reuse `resolveAppDir` (pure) for the read path and `ensureAppDir` (impure, Persistent-only) for the write path. Do not modify.
- `src/core/run-mode.ts` -- reuse `RunMode` type; do not modify.
- `src/core/credential-store.ts` -- reference only: reuse its temp-suffix + `renameSync` atomic-write idiom (`writeDescriptor`, ~359-382).
- `src/core/cli-args.ts` -- add `"update"` to the `action` union, add `QS_NO_UPDATE_CHECK?` to `CliArgsEnv`, intercept a sole literal `update` positional as `action: "update"` (after the help/version early return, before the `positionals.length > 1` guard). Stays pure.
- `bin/quick-studio.ts` -- handle `cli.action === "update"` as an early exit after the help/version blocks (~line 66): `printUpdateInstructions(...)` then `process.exit(0)`, no Core boot. Invoke the fire-and-forget `runUpdateCheck(cli.mode, process.env, {...})` **without `await`** right after the listening-URL write (~line 95), mirroring the `openBrowser` no-await self-swallowing pattern.
- `README.md` -- document `QS_NO_UPDATE_CHECK` in the env-var list (~line 96, mirroring the `QS_NO_OPEN` phrasing), the 24h TTL, what is sent (a version lookup, nothing else), and the `quick-studio update` command near the flags block (~line 80).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/update-check.ts` -- Author the pure helpers first: `parseSemver`, `isNewer` (stable major.minor.patch only, prerelease `latest` never notifies), `isCacheStale`, `shouldNotify`, `detectInstallChannel(execPath)`, `updateInstructions(channel)`. Validate a fetched `latest` against the anchored semver shape used by `scripts/build-version.ts` before trusting it.
- [x] `src/core/update-check.ts` -- Cache read: `resolveAppDir` + `join(dir, "update-check.json")`, `existsSync`/`readFileSync`, JSON.parse in try/catch; any corrupt/absent cache → treated as no cache. Cache write: `ensureAppDir()` + atomic temp (`${path}.${randomUUID()}.tmp`, `mode: 0o600`) → `renameSync`, best-effort `rmSync` cleanup on failure — the credential-store idiom. Cache shape `{ latest: string, checkedAt: number }` (epoch ms).
- [x] `src/core/update-check.ts` -- `runUpdateCheck(mode, env, deps)`: **first** guard `if (mode === "ephemeral") return;` and `if (QS_NO_UPDATE_CHECK non-empty) return;` — before any `resolveAppDir`/read. Then read cache, `shouldNotify` → one stderr line. If `isCacheStale`, fire the refresh (a floating promise; the function returns void and never throws). Refresh: GET `https://registry.npmjs.org/quick-studio/latest`, short timeout via `AbortController` (~1500ms), parse `.version`, validate semver, write cache. Every failure caught and swallowed.
- [x] `src/core/update-check.ts` -- `printUpdateInstructions(deps)`: `detectInstallChannel(process.execPath)`; print the matching command (npm → `npm i -g quick-studio@latest`; standalone → the Releases URL `https://github.com/joajo13/quick-studio/releases` + verify against `SHA256SUMS`); `unknown` → print both (Block-If #1). Read-only, no boot.
- [x] `src/core/cli-args.ts` -- Add `"update"` to the `action` union and `QS_NO_UPDATE_CHECK?: string` to `CliArgsEnv`. Intercept `positionals.length === 1 && positionals[0] === "update"` (after help/version early return, before the too-many-args guard and URL validation) → return `{ action: "update", mode: resolveRunMode(env), databaseUrl: null, openBrowser: !noOpen }`.
- [x] `bin/quick-studio.ts` -- Add the `cli.action === "update"` early-exit block after the version block (~line 66): call `printUpdateInstructions(...)`, `process.exit(0)`. After the listening-URL write (~line 95), add the un-awaited `runUpdateCheck(cli.mode, process.env, {...})` call.
- [x] `src/core/update-check.test.ts` -- Table tests for every pure helper; `runUpdateCheck` tests with injected spies: Ephemeral → zero deps invoked; `QS_NO_UPDATE_CHECK` set → zero deps invoked; stale cache → refresh fired; corrupt cache → discarded, no throw; `shouldNotify` matrix rows. `detectInstallChannel` tests over sample `execPath` strings (inside `node_modules/quick-studio-*` → npm; bare path → standalone).
- [x] `README.md` -- Document `QS_NO_UPDATE_CHECK`, the 24h TTL, what is sent, and `quick-studio update`.

**Acceptance Criteria:**
- Given a Persistent boot with a stale cache, when the Core starts, then the listening URL appears with no added latency and the refresh happens in the background.
- Given an Ephemeral boot, when the Core starts, then nothing in the update path touches the filesystem — no `ensureAppDir`, no read, no write (proven by a test asserting zero spy invocations).
- Given no network (or any registry failure), when the check runs, then nothing is printed and the process exit code is unaffected.
- Given `quick-studio update`, when it runs, then it prints the correct instructions for how this copy was installed (or both when undetectable) and exits 0 without booting the Core or modifying anything.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

## Review Triage Log

### 2026-07-23 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 0
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[patch]` `runUpdateCheck` body now self-wrapped in `try/catch` so a throwing `stderr` sink (EPIPE mid-notice) can never propagate into the boot `try/catch` and fake a "failed to start Core" exit 1 — honors the "structurally incapable of failing the boot" contract.
  - `[low]` `[patch]` `refreshCache` now sends explicit fixed headers (`accept` + a fixed `quick-studio` User-Agent) so the default `fetch` UA no longer leaks the Bun/Node runtime version — honors the "no machine info" invariant.
  - `[low]` `[patch]` `isCacheStale` now treats a future `checkedAt` (clock skew) as stale, preventing the cache from freezing as permanently fresh and silently stopping all further update checks.

<!-- rejected (noise / accepted-by-design): prerelease-`current` never notified (VERSION is always stable in this product); `detectInstallChannel` any-`node_modules`→npm (matches the Block-If #1 accepted inference; both reviewers rate it harmless/advisory); version segment > 2^53 (theoretical); redundant `cached !== null` re-check (needed for TS narrowing); case-sensitive `update` subcommand (matches git/npm convention). -->

## Design Notes

**Install-channel detection (Block-If #1 flag).** No runtime channel detection exists today. The chosen signal is a path test on `process.execPath`: when installed via npm/npx the standalone binary is spawned by `bin/quick-studio.cjs` from `node_modules/quick-studio-<platform>-<arch>/`, so its `execPath` contains a `node_modules` segment for that platform package → `"npm"`. A bare downloaded binary sits outside any `node_modules` tree → `"standalone"`. Anything that matches neither confidently → `"unknown"` → print both instruction sets. This is inference; correctness is bounded by the layout the shim produces, hence the "print both on ambiguity" fallback rather than a wrong single command.

**Fire-and-forget write safety (Block-If #2 resolved, no HALT).** The refresh's write uses the atomic temp-file + `renameSync` discipline, so an abrupt exit mid-fetch can at worst orphan a `*.tmp` file — never a truncated `update-check.json` at the final path. Because atomicity is provided by rename (not by awaiting), `runUpdateCheck` stays un-awaited and boot latency is untouched.

**Version comparison.** Compare only stable `major.minor.patch` numerically; a prerelease `latest` never triggers a notice. Validate the fetched `latest` against the same anchored semver regex `scripts/build-version.ts` uses before trusting it, so garbage from a compromised/odd registry response is discarded like any other malformed input.

**Registry request.** Plain `GET https://registry.npmjs.org/quick-studio/latest`, read `.version`. No custom identifiers, no telemetry, default headers only. Short `AbortController` timeout so a hung socket cannot keep a background promise alive indefinitely.

## Verification

**Commands:**
- `bun x tsc --noEmit` -- expected: no type errors.
- `bun test src/core/update-check.test.ts` -- expected: all green, including the Ephemeral zero-FS assertion.
- `bun test` -- expected: full suite green (no regression in `cli-args.test.ts`).
- `bun run build` -- expected: builds clean (regenerates `version.generated.ts`).

**Manual checks:**
- Offline Persistent boot: listening URL appears, nothing about updates printed, exit code 0.
- Ephemeral boot (`quick-studio postgres://x`): no `update-check.json` created and the app-data directory is not created by the update path.
- `quick-studio update`: prints instructions, exits 0, does not print a listening URL (Core never boots).

## Auto Run Result

Status: **done**

### Summary
Added a TTL-cached, mode-aware update-availability check and a read-only `quick-studio update` subcommand. On a Persistent boot the check reads `update-check.json` from the app-data dir, prints at most one terse stderr line when a newer stable release is cached, and — if the cache is older than 24h (or absent, or from a skewed future clock) — fires a non-blocking npm-registry refresh that writes the result for the next boot. Ephemeral mode participates in nothing (guarded before any read/write/`ensureAppDir`). `QS_NO_UPDATE_CHECK` (non-empty) disables it in every mode. The `update` subcommand detects the install channel from `process.execPath` and prints the matching upgrade instructions (npm command, standalone Releases URL + `SHA256SUMS` verification, or both when ambiguous), exiting 0 without booting the Core.

### Files changed
- `src/core/update-check.ts` (new) — pure helpers (`parseSemver`, `isNewer`, `isCacheStale`, `shouldNotify`, `detectInstallChannel`, `updateInstructions`) + injectable-deps impure surface (`runUpdateCheck`, `printUpdateInstructions`); atomic cache write (temp + `renameSync`, `0o600`); silent-on-every-failure refresh.
- `src/core/update-check.test.ts` (new) — 61 tests: table tests over the pure helpers + spy-injected `runUpdateCheck`/`printUpdateInstructions`, including the Ephemeral/disabled zero-seam assertions and a throwing-stderr no-propagation test.
- `src/core/cli-args.ts` — `"update"` added to the `action` union; `QS_NO_UPDATE_CHECK?` added to `CliArgsEnv`; sole literal `update` positional intercepted before URL validation.
- `bin/quick-studio.ts` — `update` early-exit (prints instructions, exits 0, no Core boot); fire-and-forget `runUpdateCheck(cli.mode, process.env)` after the listening-URL write, un-awaited like `openBrowser`.
- `README.md` — documents `quick-studio update`, the update-check behavior + 24h TTL + what is sent, and `QS_NO_UPDATE_CHECK`.

### Review findings breakdown
- **Patches applied (3):** self-wrapped `runUpdateCheck` body (boot cannot false-fail on a throwing stderr sink); explicit fixed fetch headers (no runtime leak); future-`checkedAt` staleness guard (cache cannot freeze).
- **Deferred:** 0.
- **Rejected (5):** prerelease-`current` non-notify, any-`node_modules` channel inference, >2^53 version segments, redundant TS-narrowing null check, case-sensitive `update` — all noise or accepted-by-design (see Review Triage Log).

### Verification
- `bun x tsc --noEmit` → exit 0.
- `bun test src/core/update-check.test.ts` → 61 pass, 0 fail.
- `bun test` (full) → 1657 pass, 9 fail. The 9 failures are all in `bin/quick-studio-shim.test.ts` and are **pre-existing/environmental** (confirmed: stashing this story's changes reproduces 0 pass / 9 fail at baseline `c25dc91`); they spawn the Node shim against platform packages not installed in this WSL dev env and are unrelated to story 11.5 (which does not touch `bin/quick-studio.cjs`).
- `bun run build` → exit 0 (regenerated bundles + `version.generated.ts`, VERSION "0.0.1").

### Residual risks
- Install-channel detection is inference coupled to the 11.3/11.4 shim's `execPath` layout; if that layout ever changes, `quick-studio update` could print the wrong (but harmless, advisory-only) instructions — mitigated by the "print both on ambiguity" fallback.
- End-to-end registry behavior (a real newer version appearing) is only exercised via injected seams; the live `registry.npmjs.org/quick-studio/latest` path is not integration-tested here (no package published yet — a documented Epic 11 manual prerequisite).

### Follow-up review
`followup_review_recommended: false` — the final pass applied 3 localized, well-tested defensive patches (1 medium, 2 low) with no change to the API surface, data model, or security posture; not significant enough to warrant an independent follow-up.
