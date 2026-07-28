---
title: 'Make app-dir platform-parametric in its separator (DW-93)'
type: 'bugfix'
created: '2026-07-28'
status: 'done'
baseline_revision: 'f425f6c'
final_revision: '3765af4'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** `resolveAppDir(env, platform, home?)` documents itself as resolving the app-data directory "for `platform`", and branches its *convention* on that argument — but builds the path with the HOST's `join` from `node:path`. Called with `"win32"` from a POSIX host it returns `C:\Users\x\AppData\Roaming/quick-studio`, which the host's `isAbsolute` in `first-run-signal.ts` then reports as relative, short-circuiting `isFirstRunBoot` to a spurious `true`.

**Approach:** Select the `node:path` flavour (`win32` vs `posix`) off the `platform` argument instead of inheriting the host's, and expose that selection as one small exported helper so the consumer (`first-run-signal.ts`) applies the *same* rule to its `isAbsolute` check. Both halves ship together: the resolver alone still leaves the consumer misjudging, and the consumer alone (as DW-93 records) would imply a guarantee the resolver does not provide.

## Boundaries & Constraints

**Always:**
- `resolveAppDir` stays PURE and TOTAL — no filesystem, no `process` reads, never throws.
- Production behaviour is BYTE-IDENTICAL. Every production caller passes `process.platform`, so host flavour == selected flavour by construction; nothing on any real host may change.
- The `win32` flavour is selected for `platform === "win32"` only; every other `NodeJS.Platform` (darwin, linux, and anything else) gets `posix`, mirroring the existing convention branching exactly.
- One exported helper is the single source of the platform→flavour rule; `first-run-signal.ts` imports it rather than re-deriving `platform === "win32"`.
- `first-run-signal.ts` keeps its total contract: never throws, still degrades to `true` on any dep error, still short-circuits Ephemeral before touching a dep.
- Tests must be HOST-INDEPENDENT: expected paths built with explicit `win32.join` / `posix.join`, never bare `join`, so they assert the same thing on a Windows runner as on Linux CI.

**Block If:**
- Making the resolver platform-parametric would change a resolved path on the LIVE host for any existing production caller (it must not — if a case is found where it does, stop and report it).

**Never:**
- Do not change any call site's `platform` argument, do not add a new parameter, and do not change the exported signature of `resolveAppDir`, `ensureAppDir`, or `isFirstRunBoot`.
- Do not make `resolveAppDir` touch the filesystem or consult `process.platform` internally.
- Do not extend the fix to filesystem *probing* (`classifyStorePresence`, `existsSync`) — a cross-platform call gets a correct PATH, not a meaningful disk answer. Say so in the docstring; do not try to deliver it.
- Do not narrow the docstring to "HOST only" — that alternative in DW-93 is explicitly not the route taken here.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| win32 from POSIX host, APPDATA set | `resolveAppDir({APPDATA:"C:\\Users\\dev\\AppData\\Roaming"}, "win32", "/home/dev")` | `C:\Users\dev\AppData\Roaming\quick-studio` — all backslashes, no mixed separator | No error expected |
| win32 from POSIX host, APPDATA unset | `resolveAppDir({}, "win32", "/home/dev")` | `win32.join` of home + `AppData\Roaming\quick-studio`; result is `win32.isAbsolute` | No error expected |
| linux from any host, XDG set | `resolveAppDir({XDG_DATA_HOME:"/custom/xdg"}, "linux", "/home/dev")` | `/custom/xdg/quick-studio` — forward slashes even on a Windows host | No error expected |
| darwin from any host | `resolveAppDir({}, "darwin", "/home/dev")` | `/home/dev/Library/Application Support/quick-studio` | No error expected |
| Cross-platform first-run probe | `isFirstRunBoot("persistent", {APPDATA:"C:\\Users\\dev\\AppData\\Roaming"}, "win32", {classify})` on a POSIX host | The absoluteness guard does NOT fire: `classify` IS invoked with the win32 path | Guard result comes from `win32.isAbsolute`, not the host's |
| Genuinely relative dir | `resolveDir` returns `"quick-studio"` (no HOME, empty homedir) | `isFirstRunBoot` returns `true` without calling `classify` — unchanged | Pre-existing guard preserved |
| Ephemeral mode | `isFirstRunBoot("ephemeral", …)` | `false`, no dep invoked | Unchanged short-circuit |

</intent-contract>

## Code Map

- `src/core/app-dir.ts` -- the resolver. Imports `{ isAbsolute, join }` from `node:path` (host flavour) at `:22`; `join` used in all three convention branches (`:54`, `:55`, `:59`, `:66`, `:67`); `isAbsolute` used by `ensureAppDir` at `:82`.
- `src/core/first-run-signal.ts` -- the consumer. Host `isAbsolute` imported at `:25`, applied at `:86` to a dir resolved from the function's own `platform` parameter (`:78`). This is where the mixed-separator path is misjudged.
- `src/core/app-dir.test.ts` -- table-driven; every `expected` is built with bare `join` (`:24-54`, `:66`), which is why the `"win32"` row currently passes on POSIX CI while encoding the bug.
- `src/core/first-run-signal.test.ts` -- spy/table style. Line ~60 passes `platform: "win32"` but only against a SPY `resolveDir`, so no real join ever happens. **`:184-198` is the trap**: the real-seam case builds a temp dir with host `join` (`mkdtempSync(join(tmpdir(), "qs-11-7-"))`) and then hardcodes `platform: "linux"`, expecting `false`. That combination is host-dependent the moment the resolver stops inheriting the host flavour. `PLATFORM` (`:28`) is likewise a hardcoded `"linux"` used by several cases.
- `src/core/store-presence.ts` -- `classifyStorePresence` builds its probe paths with the HOST's `join`. NOT in scope here (read-only for this change) — noted so nobody "fixes" it mid-story; it is being deferred separately.
- Production callers (all pass `process.platform`, all must stay unaffected): `src/core/app-dir.ts:81`, `credential-store.ts:463`, `provider-key-store.ts:353`, `workspace-store.ts:261`, `update-check.ts:201,237`, `first-run-setup.ts:534`, `bin/quick-studio.ts:201`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/app-dir.ts` -- replace the `{ isAbsolute, join }` import with `{ posix, win32 }` from `node:path`; add exported `pathForPlatform(platform: NodeJS.Platform): typeof win32` returning `win32` for `"win32"` and `posix` otherwise (use `typeof win32` as the return type — it resolves to `PlatformPath`, and expressing the contract in terms of the values the helper actually returns keeps it to one import; `import type { PlatformPath }` would be perfectly fine under `verbatimModuleSyntax`, which is exactly what that flag is designed to accept). Use `pathForPlatform(platform).join` in all three branches of `resolveAppDir`, and `pathForPlatform(process.platform).isAbsolute` in `ensureAppDir` -- the platform argument must select the separator, not just the convention. Name the local binding `platformPath`, NOT `path`: inside this function `path.join(...)` reads exactly like the host `node:path` a skimmer assumes, which is the confusion DW-93 *is*.
- [x] `src/core/app-dir.ts` -- update the module and `resolveAppDir` docstrings to state that `platform` selects BOTH the convention and the separator flavour, that the result is therefore a valid target-platform path from any host, and that this is a pure-path guarantee only. Three things the docstrings MUST NOT overclaim: (a) state explicitly that the mixed-separator misjudgement is UNREACHABLE IN PRODUCTION (every caller passes `process.platform`) — describe it as the latent contract violation it is, not a live user-facing bug; (b) state that the guarantee covers the JOIN only, so a `home`/`env` value written in a foreign convention (a `C:\…` home asked for as `"linux"`) still yields a mixed-separator string — supplying `home`/`env` in the TARGET platform's convention is the caller's job; (c) do not claim the `{ posix, win32 }`-only import makes host flavours ungrabbable — `typeof win32` is the whole `PlatformPath` type, so `.win32`/`.posix`/`.resolve()` remain one property access away. Say the import narrows the default reach, not that it forbids anything. Follow the existing `quick-studio Core — …` docstring style and cite DW-93.
- [x] `src/core/first-run-signal.ts` -- drop the `node:path` `isAbsolute` import; import `pathForPlatform` from `./app-dir.ts` and use `pathForPlatform(platform).isAbsolute(dir)` at the guard. Extend the existing comment above the guard to record WHY the check must use the argument's flavour: a win32-convention dir is not `posix.isAbsolute`, and misjudging it forces a spurious first-run. Keep the same production-unreachability qualifier required above.
- [x] `src/core/first-run-signal.test.ts` -- **AUDIT FIRST, then add.** Before writing anything new, find every existing case in this file that pairs a HARDCODED platform literal with a fixture built from the host (`mkdtempSync`/`join`/`tmpdir`). `:184-198` is one: it creates a real temp dir with host `join` and passes `platform: "linux"`, so on a Windows runner the post-change resolver returns `posix.join("C:\\…\\qs-11-7-XXXX", "quick-studio")`, `posix.isAbsolute` calls that RELATIVE, the guard fires, and a test that expected `false` gets `true`. Any case that touches the REAL filesystem must ask for the HOST's platform and set the env key that host's convention actually reads (`APPDATA` for win32; `HOME` + `Library/Application Support` for darwin; `XDG_DATA_HOME` for linux) — a small per-host fixture helper is the expected shape. Cases that only use spies may keep a hardcoded platform.
- [x] `src/core/first-run-signal.test.ts` -- add a real-`resolveDir` (no `resolveDir` spy) case with `platform: "win32"` and `APPDATA` set, asserting the injected `classify` spy IS called with the all-backslash path (the guard did not fire) — the regression test for DW-93. The reached-with-that-path assertion is the load-bearing one; do not also assert the function's boolean result, which only measures the fabricated stub and couples this test to the presence matrix's AND-logic. Also add the guard's win32 arm in its FAILING direction (a spied `resolveDir` returning a win32-relative dir such as `"C:quick-studio"` under `platform: "win32"` → `true`, `classify` never called); today only the posix arm's failing direction is covered. Keep the existing posix relative-dir case.
- [x] `src/core/app-dir.test.ts` -- make the table host-independent: import `{ posix, win32 }`, build each `expected` with the flavour matching that row's `platform`, and add a `"win32"` row asserting the result contains no forward slash plus `"linux"` and `"darwin"` rows asserting no backslash. Apply the `not.toContain` separator invariant to EVERY row in that block, including the win32-APPDATA-unset row — an exception with no stated reason reads as an oversight. Use a realistic Windows home (`C:\Users\dev`) for the win32 fallback row, not the POSIX `HOME` constant: `win32.join("/home/dev", …)` normalizes to the drive-less `\home\dev\…`, which `win32.isAbsolute` accepts but which resolves against whatever the current drive happens to be — do not enshrine that as the expected value. Cover every I/O-matrix resolver row.
- [x] `src/core/app-dir.test.ts` -- the `pathForPlatform` block must enumerate ALL non-win32 `NodeJS.Platform` members; the union has eleven and `cygwin`, `haiku`, `netbsd` are easy to miss. Verify the list against the installed type before asserting.

**Acceptance Criteria:**
- Given a POSIX host, when `resolveAppDir` is called with `platform: "win32"`, then the returned string contains no forward slash separator and is `win32.isAbsolute`.
- Given a Windows host, when `resolveAppDir` is called with `platform: "linux"` or `"darwin"`, then the returned string contains no backslash separator and is `posix.isAbsolute`.
- Given any host, when `resolveAppDir` is called with that host's own `process.platform`, then the result is identical to the pre-change implementation for every existing test case — production behaviour is unchanged.
- Given `mode: "persistent"` and a foreign `platform` whose env yields an absolute target-platform path, when `isFirstRunBoot` runs, then it delegates to `classify` instead of returning `true` from the absoluteness guard.
- Given the whole suite, when `bun test` runs, then no test outside `app-dir.test.ts` / `first-run-signal.test.ts` needed edits — the change is behaviour-preserving on the host.
- Given a WINDOWS runner, when the suite is reasoned through case by case, then every test that touches the real filesystem still passes — no case pairs a host-built fixture with a hardcoded foreign platform. State the reasoning explicitly for `first-run-signal.test.ts`'s real-seam cases; CI is `ubuntu-latest` only and cannot demonstrate this.
- Given the guard in `isFirstRunBoot`, when it is exercised under `platform: "win32"`, then BOTH directions are covered: an absolute win32 dir passes through to `classify`, and a relative win32 dir returns `true` without calling `classify`.

## Spec Change Log

### 2026-07-28 — Review pass 1 (bad_spec loopback)

- **Triggering finding:** the change made `first-run-signal.test.ts:184-198` host-dependent. That case builds a temp dir with the host `join` and hardcodes `platform: "linux"`; once the resolver stops inheriting the host flavour, a Windows runner gets `posix.join("C:\\…\\qs-11-7-XXXX", "quick-studio")`, `posix.isAbsolute` calls it relative, the guard short-circuits, and a case asserting `false` gets `true`. The full suite was green only because CI and the dev box are POSIX.
- **What was amended:** Code Map now names that case (and the hardcoded `PLATFORM` constant) as the trap, plus `store-presence.ts` as explicitly out of scope. The `first-run-signal.test.ts` task was split into an AUDIT-FIRST task (find every hardcoded-platform-with-host-fixture pairing and make real-filesystem cases ask for the HOST's platform with that host's env key) and an add-tests task. Added an AC requiring the Windows-runner reasoning to be stated. Also folded in the low-severity review findings: name the local binding `platformPath` not `path`; docstrings must state production-unreachability, the caller's obligation to supply `home`/`env` in the target convention, and must not overclaim the import as an enforced invariant; win32 fixtures must use a realistic `C:\Users\dev` home instead of the drive-less `\home\dev\…`; the separator invariant must apply to every row in the DW-93 block; the `pathForPlatform` platform list must be complete; the regression test must drop the stub-measuring boolean assertion; and the guard's win32 failing direction must be covered.
- **Known-bad state avoided:** a change whose entire subject is "stop letting the host decide the separator" shipping with a NEW host-dependent test — the same "two different claims wearing one name" failure the new test-file header comment complains about, moved from one file into another.
- **KEEP (must survive re-derivation):**
  - The `pathForPlatform` helper exactly as specified — exported from `app-dir.ts`, `win32` for `"win32"` and `posix` otherwise, `typeof win32` return type. It typechecked clean and is the right shape. Do not relocate it to a new module and do not replace it with a `Record<Exclude<…>>`/`satisfies` construction.
  - `ensureAppDir` routing its `isAbsolute` through the helper.
  - The `app-dir.test.ts` production-parity test (host `join` + `process.platform`, with its comment explaining that this is the ONE place bare `join` belongs). It is a tautology on separator grounds by design; its job is pinning production behaviour.
  - The un-spied-`resolveDir` shape of the DW-93 regression test — a spy that hands back a ready-made path cannot see this bug, and the previous pass got that right.
  - The docstring depth and voice in both source files (the `quick-studio Core — …` block style, the WHY-first prose, the comment above the guard). Only the overclaims listed above need correcting; do not thin the prose out.

## Review Triage Log

### 2026-07-28 — Review pass
- intent_gap: 0
- bad_spec: 9: (high 0, medium 1, low 8)
- patch: 0
- defer: 3: (high 0, medium 0, low 3)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[bad_spec]` The change makes `first-run-signal.test.ts:184-198` fail on a Windows host (host-built temp dir + hardcoded `platform: "linux"` → `posix.isAbsolute` rejects a drive-letter path). Spec amended with an AUDIT-FIRST task and a Windows-runner AC; code reverted for re-derivation.
  - `[low]` `[bad_spec]` Source docstrings state the mixed-separator misjudgement as a live consequence, omitting that it is unreachable in production. Spec now requires the qualifier.
  - `[low]` `[bad_spec]` `const path = pathForPlatform(platform)` shadows the conventional `node:path` name inside the very function whose bug was host/target path confusion. Spec now mandates `platformPath`.
  - `[low]` `[bad_spec]` win32 fixtures reuse the POSIX `HOME = "/home/dev"`, enshrining the drive-less `\home\dev\…` as expected. Spec now requires a realistic `C:\Users\dev`.
  - `[low]` `[bad_spec]` The `not.toContain` separator invariant was applied to three of four rows in the DW-93 block with no stated exception. Spec now requires it on every row.
  - `[low]` `[bad_spec]` The `pathForPlatform` "every other platform" list omits `cygwin`, `haiku`, `netbsd`. Spec now requires the full union.
  - `[low]` `[bad_spec]` The guard's win32 arm is never tested in its failing direction. Spec now requires it.
  - `[low]` `[bad_spec]` The regression test's `expect(result).toBe(false)` measures the fabricated `classify` stub and couples the separator claim to the presence matrix's AND-logic. Spec now requires dropping it.
  - `[low]` `[bad_spec]` Docstring claims the `{ posix, win32 }`-only import is a grep-able invariant, but `typeof win32` exposes `.win32`/`.posix`/`.resolve()` and the repo has no lint to enforce anything. Spec now requires the weaker, true claim; also requires documenting that a foreign-convention `home`/`env` still yields a mixed string.

### 2026-07-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 0, medium 2, low 11)
- defer: 3: (high 0, medium 2, low 1)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The rewritten "directory that does not exist" case used a FIXED name in the shared, world-writable system temp dir; planting `$TMPDIR/qs-11-7-probe-does-not-exist/quick-studio/*.meta.json` inverted it. Replaced with `mkdtempSync` + immediate `rmSync` (unique AND absent); the flake was reproduced against the old logic and confirmed fixed.
  - `[medium]` `[patch]` The new prose asserted "on POSIX CI" / "CI is ubuntu-latest only". Verified false: `.github/workflows/` has only `keyring-spike.yml` (which runs `bun test src/core/keychain.test.ts` alone), `publish.yml`, `release.yml` — NO job runs this suite. Both occurrences reworded to the true, stronger premise: nothing but a developer's own host ever runs these tests, so there is no second host to notice a host-dependent assertion.
  - `[low]` `[patch]` The host-paired fixture rewrite silently dropped real-seam coverage of the linux `HOME` → `~/.local/share` XDG-default branch. Added a host-gated case driving `{ HOME: root }` with `XDG_DATA_HOME` unset against a real directory.
  - `[low]` `[patch]` The `pathForPlatform` exhaustiveness test proved nothing — `toHaveLength(10)` against a `readonly NodeJS.Platform[]` accepts a duplicated member with another dropped. Replaced with a `Record<Exclude<NodeJS.Platform, "win32">, true>` so a `@types/node` union change is a `tsc` error; enforcement verified by mutation (TS2741/TS1117/TS2353). The pass-1 rejection of that shape was scoped to the helper implementation and still stands.
  - `[low]` `[patch]` The same block's "(eleven members, win32 excluded here)" parenthetical contradicted the `toHaveLength(10)` two lines below it. Corrected.
  - `[low]` `[patch]` File header said "Two cases deliberately leave `resolveDir` UN-spied"; there are three. Corrected and each named.
  - `[low]` `[patch]` The DW-93 regression test is meaningful only on POSIX — on a Windows runner it passes against a completely unfixed implementation — and said so nowhere. Documented in the case's comment.
  - `[low]` `[patch]` The docstring made supplying `home`/`env` in the target convention "the caller's job" while the signature's own `home = homedir()` default silently supplies the HOST's. The default is now named as the primary way to violate that obligation, and the module's "no `process` reads" purity claim qualified (the body is pure; the default argument is the impure edge).
  - `[low]` `[patch]` The headline docstring example ("a Windows host asked for `linux` yields `/custom/xdg/quick-studio`") held only because it set `XDG_DATA_HOME`. Replaced with an example honest on its face.
  - `[low]` `[patch]` The module header and the `resolveAppDir` jsdoc carried two independently-worded copies of the JOIN-only and not-probeable caveats, same example verbatim. De-duplicated to one statement each with a `{@link}` cross-reference.
  - `[low]` `[patch]` `PLATFORM` was labelled "For SPIED cases only" while both new spied cases use bare `"win32"` literals. Comment reworded to what is actually true.
  - `[low]` `[patch]` The regression test recomputed its expectation with `win32.join` — the same call the implementation makes. Replaced with the literal already used in `app-dir.test.ts`.
  - `[low]` `[patch]` The guard is pinned only in the win32 direction, with no stated reason. Reason recorded (a `platform: "linux"` mirror could not fail on either host); no unfailable test was added.
  - Deferred this pass (3) — **recorded here only; NOT written to `deferred-work.md`, because this run was invoked with an explicit instruction not to edit the ledger.** They need transcription by the orchestrator or they are lost at archive. Ledger-ready form is in `## Auto Run Result`:
    1. `[medium]` `ensureAppDir`'s absoluteness guard has zero test coverage — deleting it or inverting it leaves the full suite green (verified by mutation).
    2. `[medium]` No CI workflow runs this test suite on any platform; `release.yml` ships Windows binaries that no test ever exercised.
    3. `[low]` `store-presence.ts` and `update-check.ts` build paths from a resolved app dir with the HOST's `join` — the same class DW-93 fixed in `app-dir.ts`, at two sites the fix does not reach.

## Design Notes

The helper, in full — it is the entire mechanism:

```ts
import { posix, win32 } from "node:path";

/** The `node:path` flavour whose separator convention matches `platform`. */
export function pathForPlatform(platform: NodeJS.Platform): typeof win32 {
  return platform === "win32" ? win32 : posix;
}
```

Why export it rather than inline `platform === "win32" ? win32 : posix` in both files: the resolver and the consumer must agree by construction. If `first-run-signal.ts` re-derives the branch, a future third convention (or a change to which platforms count as win32-like) silently desynchronises the two, which is the exact class of bug DW-93 is.

Why `ensureAppDir` also switches: it passes `process.platform`, so host `isAbsolute` already agrees and nothing changes today — but leaving a bare `node:path` import in the file keeps the host-flavoured functions in default reach for the next edit. Routing through the helper narrows that reach; it does NOT enforce anything (there is no lint in this repo, and `typeof win32` still exposes `.win32`/`.posix`), so the docstring must claim the weaker, true thing.

**The host/target split is the whole hazard.** Two rules, and every test must pick one on purpose:
- A test asserting a PATH STRING is pure — hardcode the platform and build `expected` with that platform's flavour.
- A test touching the REAL filesystem must use the HOST's platform, because the disk it writes to is the host's. Pairing a host-built fixture with a hardcoded foreign platform is the trap that broke pass 1.

**Rejected (with rebuttals) — do not re-open in a later pass:**
- *"Throw when a win32 result has no drive/UNC root"* — `resolveAppDir` is documented PURE and TOTAL; adding a throw breaks the invariant the module is built on, and `ensureAppDir` already owns the absoluteness rejection.
- *"Normalize backslashes out when the platform is non-win32"* — a `C:\Users\dev` home has no meaningful POSIX image; `C:/Users/dev/…` is still not `posix.isAbsolute`. Unmappable garbage-in; document the caller's obligation instead.
- *"Short-circuit `isFirstRunBoot` when `platform !== process.platform`"* — that neuters the fix and reintroduces the spurious first-run this story removes.
- *"Move `pathForPlatform` to its own module"* — one helper with two in-repo consumers; a new module is ceremony, and the coupling to `resolveAppDir`'s branching is the point.
- *"Close DW-93 in `deferred-work.md`"* — the orchestrator owns ledger resolution, not this run.

## Verification

**Commands:**
- `bun test src/core/app-dir.test.ts src/core/first-run-signal.test.ts` -- expected: all pass, including the new cross-platform rows, both directions of the win32 guard, and the DW-93 regression case.
- `bun test` -- expected: full suite green; no failures outside the two touched test files.
- `bunx tsc --noEmit` -- expected: clean; in particular `typeof win32` satisfies the helper's return type under `strict` + `verbatimModuleSyntax`.
- `grep -n 'from "node:path"' src/core/app-dir.ts src/core/first-run-signal.ts` -- expected: `app-dir.ts` imports only `{ posix, win32 }`; `first-run-signal.ts` no longer imports from `node:path` at all.
- `grep -rn 'mkdtempSync\|tmpdir()' src/core/first-run-signal.test.ts` -- expected: every hit sits in a case that passes `process.platform`, never a hardcoded literal. Report the platform argument of each hit.

**Manual checks (if no CLI):**
- Windows-runner reasoning: CI is `ubuntu-latest` only, so walk each real-filesystem case in `first-run-signal.test.ts` and state what it resolves to when `process.platform === "win32"` and why it still passes. This is the check that would have caught pass 1's regression.

## Auto Run Result

Status: done
Bundle: `dw-appdir-platform-parametric` — resolves DW-93.

### Implemented change

`resolveAppDir(env, platform, home?)` now selects its `node:path` flavour from the `platform` ARGUMENT instead of inheriting the host's, via a new exported `pathForPlatform(platform)` helper, and `isFirstRunBoot`'s absoluteness guard applies that same helper so the rule a path is BUILT with and the rule it is JUDGED by cannot drift apart. Asking a POSIX host for `"win32"` now yields the all-backslash `C:\Users\dev\AppData\Roaming\quick-studio` instead of the mixed-separator string the host's `isAbsolute` then misjudged as relative.

Production behaviour is unchanged and this was never a live user-facing bug: every caller passes `process.platform`, so host flavour and selected flavour are the same object. What is fixed is the gap between what the signature promised and what the body delivered.

### Files changed

- `src/core/app-dir.ts` — `{ isAbsolute, join }` → `{ posix, win32 }`; new exported `pathForPlatform`; all five joins and `ensureAppDir`'s guard routed through it; docstrings rewritten (de-duplicated, with the production-unreachability, JOIN-only, not-probeable and `home = homedir()` caveats stated once each).
- `src/core/first-run-signal.ts` — no longer imports `node:path`; the guard is `pathForPlatform(platform).isAbsolute(dir)`.
- `src/core/app-dir.test.ts` — every `expected` built with the row's own flavour; a DW-93 block pinning the separator on all four resolver rows; `pathForPlatform` exhaustiveness made a compile error via `Record<Exclude<NodeJS.Platform, "win32">, true>`.
- `src/core/first-run-signal.test.ts` — real-filesystem cases now ask for `process.platform` with that host's env key (`hostAppDirFixture`); DW-93 regression with an un-spied `resolveDir`; the guard's win32 failing direction; restored real-seam coverage of the XDG-default branch.

### Review findings

Two passes. Pass 1: 9 `bad_spec` (1 medium, 8 low) → code reverted, spec amended with a KEEP list and a rebuttal block, implementation re-derived; 3 defer; 5 reject. Pass 2: 13 `patch` applied (2 medium, 11 low); 0 `bad_spec`; 3 defer; 6 reject.

The pass-1 medium was the load-bearing one: the change made `first-run-signal.test.ts`'s real-seam case fail on a Windows host, because it paired a host-built temp dir with a hardcoded `platform: "linux"`. A change whose entire subject is "stop letting the host decide the separator" had moved a host dependency from one file into another.

### DEFERRED — needs transcription into `deferred-work.md`

Not written to the ledger: this run was invoked with an explicit instruction not to edit it. Recorded here in ledger format so the orchestrator can transcribe them. **Without transcription these are lost at archive.**

```
### DW-NNN: `ensureAppDir`'s absoluteness guard has zero test coverage — deleting or inverting it leaves the whole suite green
origin: adversarial review of spec-dw-appdir-platform-parametric.md, 2026-07-28 (second review pass)
source_spec: `spec-dw-appdir-platform-parametric.md`
location: `src/core/app-dir.ts` (`ensureAppDir`, the `if (!pathForPlatform(process.platform).isAbsolute(dir)) throw` block)
severity: medium
found_by: Blind Hunter, second review pass on dw-appdir-platform-parametric
summary: The guard that stops the app from writing its credential store to a CWD-relative directory is asserted nowhere. In a scratchpad copy, deleting the entire block left the full suite at 0 fail; inverting it to `if (isAbsolute(dir))` also left it at 0 fail. The `pathForPlatform(process.platform)` argument is equally unpinned — hardcoding it to `pathForPlatform("win32")` stays green on any POSIX host, because `win32.isAbsolute("/home/…")` is `true`.
evidence: Verified by mutation against the real suite. NOT caused by DW-93 — the guard predates it and was equally uncovered before; DW-93 only routed it through the new helper. Deferred because `ensureAppDir` has no injection seam: it reads `process.env`/`process.platform` and calls `mkdirSync` directly, so forcing the relative case needs a `homedir()` module mock or a new seam, which is a design decision this bundle's Never list puts out of scope.
status: open

### DW-NNN: No CI workflow runs the test suite on any platform, and the Windows binaries ship untested
origin: adversarial review of spec-dw-appdir-platform-parametric.md, 2026-07-28 (both review passes)
source_spec: `spec-dw-appdir-platform-parametric.md`
location: `.github/workflows/` — `keyring-spike.yml`, `publish.yml`, `release.yml`
severity: medium
found_by: Blind Hunter and Edge Case Hunter, dw-appdir-platform-parametric
summary: `keyring-spike.yml` runs `bun test src/core/keychain.test.ts` and nothing else; `publish.yml` and `release.yml` build and smoke binaries but never invoke `bun test`. So 2081 tests are executed only on whichever machine a developer happens to be sitting at. `release.yml` builds `windows-latest` binaries that no test has ever exercised, and the win32 and darwin arms of DW-93's own cross-platform behaviour can never run.
evidence: Confirmed by grepping every workflow for `bun test` and `runs-on`. Pre-existing and unrelated to DW-93, but DW-93 is the change that made it consequential: the whole class of bug it fixes is one that only a second host can observe. The fix is a `strategy.matrix.os: [ubuntu-latest, windows-latest, macos-latest]` test job, which is an infrastructure/cost decision rather than a code correction.
status: open

### DW-NNN: `store-presence.ts` and `update-check.ts` join onto a resolved app dir with the HOST's `join`, so DW-93's rule stops at the `app-dir.ts` boundary
origin: adversarial review of spec-dw-appdir-platform-parametric.md, 2026-07-28 (both review passes)
source_spec: `spec-dw-appdir-platform-parametric.md`
location: `src/core/store-presence.ts` (`classifyStorePresence`'s probe paths); `src/core/update-check.ts:201` and `:237` (`join(resolveAppDir(process.env, process.platform), CACHE_FILE_NAME)`)
severity: low
found_by: Blind Hunter and Edge Case Hunter, dw-appdir-platform-parametric
summary: DW-93 made the resolver and the first-run guard agree on the platform→separator rule, but two further consumers append to the resolved directory with the host's `join`. With a foreign `platform`, `classifyStorePresence` produces `C:\Users\dev\AppData\Roaming\quick-studio/store.meta.json` — the very mixed-separator shape DW-93 removed one layer up. The end-to-end answer is unchanged (both before and after, a cross-platform `isFirstRunBoot` reports first-run), so nothing regressed; the rule simply is not enforced beyond the two modules the bundle touched.
evidence: Read directly from both files. Explicitly out of scope for this bundle — its Never list forbids extending the fix to filesystem probing, on the grounds that a foreign-platform path is not meaningfully probeable on the local disk whatever separator it uses. `update-check.ts` is the more interesting of the two, since it is pure path construction rather than probing. Worth deciding as one question: whether "cross-platform resolution" is a guarantee the product wants at all, or whether the honest move is to narrow the signatures so no caller can ask for it.
status: open
```

### Verification performed

- `bun test src/core/app-dir.test.ts src/core/first-run-signal.test.ts` — 45 pass, 0 fail, 111 expect() calls.
- `bun test` — 2081 pass, 1 skip (pre-existing, elsewhere), 0 fail, across 94 files. Re-run independently after patching.
- `bunx tsc --noEmit` — clean, exit 0.
- `grep -n 'from "node:path"' src/core/app-dir.ts src/core/first-run-signal.ts` — one hit: `app-dir.ts` importing `{ posix, win32 }`. `first-run-signal.ts` has none.
- Mutation controls (scratchpad copy, run by the review): reverting `resolveAppDir` to a host `join` fails 5 tests; `pathForPlatform` forced always-posix fails 6, always-win32 fails 10; reverting the `isFirstRunBoot` guard to host `isAbsolute` fails 1. The resolver/consumer half of the change is genuinely covered.
- The tmpdir-collision flake was reproduced against the pre-patch logic and confirmed fixed.
- `Record<Exclude<…>>` enforcement verified by mutation (TS2741, TS1117, TS2353).

### Residual risks

- **The win32 and darwin arms of `hostAppDirFixture` have never executed.** No host but Linux has run this suite. The Windows-runner reasoning in this spec is analysis, not observation — see the CI deferral above.
- **`ensureAppDir`'s guard remains unverified** (deferral above). This bundle touched that line without being able to pin it.
- The restored XDG-default real-seam case is `skipIf`-gated on win32/darwin hosts, so on those hosts that branch keeps only its pure-table coverage.
