---
title: 'CLI surface — --help, --version, and an explicit --ephemeral flag'
type: 'feature'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.1
---

<intent-contract>

## Intent

**Problem:** `parseCliArgs` (`src/core/cli-args.ts:62`) calls `node:util` `parseArgs` with `strict: true` and exactly two declared options — `persistent` and `no-open`. Every other flag is an unknown option, so the two things every user types first at a new CLI, `--help` and `--version`, are rejected: `bin/quick-studio.ts:44-51` catches the `CliArgsError`, writes a terse message to stderr, and exits **1**. There is also no way to select Ephemeral mode explicitly — it is reachable only by passing a database-URL positional or setting `QS_MODE=ephemeral` (`src/core/run-mode.ts:35`), which means a user who wants a throwaway session with no connection at all has no flag for it. And the app has no notion of its own version anywhere: nothing imports `package.json`, and nothing could — a `bun build --compile` binary has no `package.json` to read at run time.

**Approach:** Widen the CLI surface without disturbing the existing precedence rules:
1. Declare `help` (short `h`) and `version` (short `v`) as boolean options, plus `ephemeral`. Handle `help`/`version` as **early exits** in `bin/` — printed to **stdout** (they are requested output, not diagnostics), exit code **0**, and the Core is never booted.
2. Bake the version in at build time via a generated module `src/core/version.generated.ts`, written by a new `scripts/build-version.ts` step folded into the existing `build` script chain — the same generated-module pattern already used for `ui-bundle.generated.ts` (`scripts/build-ui.ts`), and for the same reason: a compiled binary has no source tree and no manifest to read.
3. Fold `--ephemeral` into the existing precedence gate as a peer of `--persistent`: it selects Ephemeral, it is contradictory with `--persistent`, and it is redundant-but-harmless alongside a URL positional (which already selects Ephemeral).

## Boundaries & Constraints

**Always:**
- `--help` and `--version` write to **stdout** and exit **0** without booting the Core, resolving a port, touching the app-data directory, or opening a browser. They are the only two paths in this story that produce stdout output — every existing diagnostic stays on stderr.
- The version string comes from the **generated module**, so all three distribution channels (compiled binary, npm platform package, `bun run`) report the identical value. `scripts/build-version.ts` reads `package.json`'s `version` at build time and emits `export const VERSION = "…" as const;`.
- `parseCliArgs` stays **pure** (no I/O, no `process` reads) — the help/version *decision* is returned in `CliArgs`; the *printing and exiting* happen in `bin/`, preserving the existing "bin is a thin wire-up with zero branching logic" split.
- Every existing precedence rule survives byte-for-byte: URL positional → Ephemeral; `--persistent` → Persistent; URL + `--persistent` → refuse; neither → `resolveRunMode(env)` defaulting to Persistent. The existing `cli-args.test.ts` table must stay green with only additive cases.
- The help text lists the three launch forms and every honored environment variable (`QS_HOST`, `QS_PORT`, `QS_MODE`, `QS_NO_OPEN`, `QS_PASSPHRASE`, `QS_PASSPHRASE_FD`) — it is the discoverability surface a distributed CLI needs, and today the README is the only place any of this is written down.

**Block If:**
- If adding the generated version module to the `build` chain would make `bun x tsc --noEmit` or `bun test` fail on a fresh clone before a build runs — the `prepare` hook (`package.json:21`) already regenerates `ui-bundle.generated.ts` on `bun install` and must cover this new module too. If the new script cannot be folded into the same chain safely, HALT rather than shipping a second build-order trap.
- If `parseArgs` short-option aliases (`-h`, `-v`) collide with anything already parsed or make a bare `-` positional ambiguous, drop the short aliases rather than reshaping positional handling — the URL positional is load-bearing.

**Never:**
- Never read `package.json` (or any file) at run time to resolve the version — that is exactly the source-tree dependency Story 1.7 removed to make `--compile` work.
- Never let `--help`/`--version` exit non-zero, and never route them to stderr — piping `quick-studio --version` into a script is a normal thing to do.
- Never change the meaning of an existing flag, the DB-URL positional, or the `QS_MODE` default. Do not echo a database URL in any new error message (the existing no-echo policy at `cli-args.ts:107-114` exists because a connection string can embed a password).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Help | `quick-studio --help` (or `-h`) | Usage block on **stdout**, exit **0**, Core never booted | none |
| Version | `quick-studio --version` (or `-v`) | Bare version string on stdout, exit 0 | none |
| Help wins over everything | `quick-studio --help postgres://x --persistent` | Help printed, exit 0 — help/version short-circuit **before** the contradictory-mode gate, so an unusable combination still gets help instead of an error | Contradiction never evaluated |
| Explicit ephemeral | `quick-studio --ephemeral` | Ephemeral mode, `databaseUrl: null` — a session with no connection configured, which the UI renders as its no-connection state | none |
| Ephemeral + URL | `quick-studio --ephemeral postgres://x` | Ephemeral with the URL — redundant but consistent, NOT an error | none |
| Ephemeral + persistent | `quick-studio --ephemeral --persistent` | Refused: contradictory mode selection, terse stderr, exit 1 — mirrors the existing URL+`--persistent` refusal at `cli-args.ts:95-99` | `CliArgsError`, message-only |
| Ephemeral overrides QS_MODE | `QS_MODE=persistent quick-studio --ephemeral` | Ephemeral — an explicit flag outranks the env default, matching how the URL positional already outranks `QS_MODE` | none |
| Unknown flag still refused | `quick-studio --frobnicate` | Terse stderr + exit 1, unchanged from today | `CliArgsError` |
| Version from a compiled binary | run `dist/quick-studio --version` on a host with no Bun and no source tree | Same version string as `bun run bin/quick-studio.ts --version` | Fails loudly at build time if the module was not generated |
| Fresh clone | `bun install` then `bun test` with no manual build | `prepare` regenerates both `ui-bundle.generated.ts` and `version.generated.ts`; suite green | Missing import fails loudly until build runs |

</intent-contract>

## Acceptance Criteria

- Given any build, when I run `quick-studio --help`, then usage goes to stdout, exit code is 0, and no port is bound and no browser opens.
- Given any build, when I run `quick-studio --version`, then the version prints and matches across the compiled binary, the npm package, and `bun run`.
- Given `--ephemeral`, when it is passed alone, then Ephemeral mode is selected with a null database URL; combined with `--persistent` it is refused as contradictory.
- Given the existing suite, when `bun test` runs, then every pre-existing `cli-args.test.ts` case passes unchanged — the new cases are purely additive.

## Code Map

- `scripts/build-version.ts` (new) — reads `package.json`'s `version`, writes `src/core/version.generated.ts` (`export const VERSION = "…" as const;`) with the AUTO-GENERATED banner used by `scripts/build-ui.ts`. Fails loudly if `version` is missing or not a string.
- `src/core/version.generated.ts` (generated, gitignored) — the single run-time source of the version string, embedded as ordinary source into the compiled binary.
- `package.json` — add `bun scripts/build-version.ts` to the `build` chain (`:18`), so `build`, `build:binary`, `dev`, `prepare`, and `prepublishOnly` all regenerate it. Add the file to `.gitignore` beside `ui-bundle.generated.ts`.
- `src/core/cli-args.ts` — declare `help`/`version`/`ephemeral` options; extend `CliArgs` with `help: boolean` and `version: boolean` (or a single discriminated `action` field — step-02's call); short-circuit those two before the contradiction gate; fold `ephemeral` into the precedence chain as a peer of `persistent`. Stays pure.
- `src/core/help-text.ts` (new, recommended) — the usage string as a pure exported constant/function so it is unit-testable and `bin/` stays wire-up only. Step-02 may instead inline it in `bin/`; keep it out of `cli-args.ts` either way so the parser has no presentation concern.
- `bin/quick-studio.ts` — after `parseCliArgs`, handle the help/version early exits (`process.stdout.write` + `process.exit(0)`) before the `startCore` try-block at `:53`.
- `src/core/cli-args.test.ts` — additive cases for every matrix row above.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] `scripts/build-version.ts` + generated module + `.gitignore` entry + fold into the `build` chain.
- [ ] Verify a fresh `bun install` regenerates it via `prepare` (the Story 1.7 fresh-clone trap must not reopen).
- [ ] Declare `help`/`version`/`ephemeral` in `parseCliArgs`; decide the `CliArgs` shape for the early-exit actions (two booleans vs one `action` discriminant).
- [ ] Short-circuit help/version BEFORE the contradictory-mode gate.
- [ ] Fold `--ephemeral` into the precedence rules; refuse `--ephemeral --persistent`.
- [ ] Write the usage text (three launch forms, all flags, all env vars).
- [ ] Wire the early exits in `bin/quick-studio.ts` (stdout, exit 0, no boot).
- [ ] Additive `cli-args.test.ts` cases; confirm every pre-existing case is untouched.
- [ ] `bun x tsc --noEmit`, `bun test`, `bun run build`, and `bun run build:binary` then `./dist/quick-studio --version` — all green.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

## Review Triage Log

<!-- populated by the review loop -->
