---
title: 'CLI surface — --help, --version, and an explicit --ephemeral flag'
type: 'feature'
created: '2026-07-21'
status: 'done'
baseline_revision: 'd0ad78bdf6bfc158965b6def47a6087cc154e255'
final_revision: '401b8017564d393e006731ac9ca9c41e68ee2211'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.1
  - '{project-root}/_bmad-output/implementation-artifacts/epic-11-context.md'
warnings: ['oversized']
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

## Code Map

- `scripts/build-ui.ts` -- the generator precedent to copy: validates, then `Bun.write`s a banner + `export const … as const;` module into `src/core/`, throwing (never `process.exit`) on any failure, and ends with a terse stderr line. `scripts/build-sandbox.ts`, `build-snapshot.ts`, `build-live-report.ts` are the same shape.
- `scripts/build-version.ts` (NEW) -- reads `package.json`'s `version` at build time, writes `src/core/version.generated.ts`.
- `src/core/version.generated.ts` (NEW, generated, gitignored) -- the single run-time source of the version string; ordinary source, so `--compile` embeds it.
- `.gitignore` -- already lists the four `*.generated.ts` siblings; the new module goes beside them.
- `package.json:17-23` -- `build` is the ONLY chained script; `build:binary`, `dev`, `prepare`, `prepublishOnly` all call `bun run build`, so appending one step to `build` covers all five. `version` is `0.0.1`; `files` already ships `src`.
- `src/core/cli-args.ts` -- `parseCliArgs` (`:62`): the `parseArgs` options table (`:68-76`), positional-count guard (`:84-88`), contradiction gate (`:95-99`), mode precedence chain (`:104-123`), `no-open` resolution (`:125-127`). `CliArgs` type at `:33-43`; `CliArgsError` at `:50-55`.
- `src/core/run-mode.ts` -- `RunMode = "persistent" | "ephemeral"`; `resolveRunMode(env)` is pure and total (never throws), defaulting to Persistent.
- `src/core/help-text.ts` (NEW) -- the usage string as a pure exported constant, so `cli-args.ts` keeps no presentation concern and `bin/` stays wire-up only.
- `bin/quick-studio.ts:42-51` -- the `parseCliArgs` call + `CliArgsError` catch, already ABOVE the `startCore` try-block (`:53`). The early exits slot in between. Every write in this file today is `process.stderr.write`; there is no `process.stdout.write` or `console.*` anywhere in `bin/` or `src/core/`.
- `src/core/cli-args.test.ts` -- 13 `bun:test` cases in three `describe` blocks; assertions are field-by-field (`expect(cli.mode).toBe(...)`), never a whole-object `toEqual`, so added `CliArgs` fields cannot break them. Rejection cases use `toThrow(CliArgsError)` plus a `try/catch` + `toMatch(/…/i)` on the message.
- `README.md` -- documents `QS_HOST`, `QS_PORT`, `QS_PASSPHRASE`, `QS_PASSPHRASE_FD`; documents NO flags at all, and omits `QS_MODE` and `QS_NO_OPEN`.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/build-version.ts` -- NEW. Read `package.json` via `Bun.file(new URL("../package.json", import.meta.url))` so cwd never matters; assert `version` is a non-empty string matching `/^\d+\.\d+\.\d+/` and `throw new Error(...)` otherwise; `Bun.write` `src/core/version.generated.ts` containing the AUTO-GENERATED banner (same wording as `scripts/build-ui.ts`, naming this script) plus `export const VERSION = ${JSON.stringify(version)} as const;`; close with a terse stderr line like the sibling generators. -- The compiled binary has no manifest to read, so the version must become source before `--compile` runs.
- [x] `.gitignore` -- add `src/core/version.generated.ts` beside the existing four generated modules. -- It is build output, never committed.
- [x] `package.json` -- append ` && bun scripts/build-version.ts` to the `build` script only. -- `build:binary`, `dev`, `prepare`, `prepublishOnly` all delegate to `build`, so one edit closes the fresh-clone trap for all of them; touching them individually would create drift.
- [x] `src/core/help-text.ts` -- NEW. Export `HELP_TEXT: string` (a plain constant, no imports, no version interpolation so it stays independent of the generated module): a `Usage:` header, the three launch forms (`quick-studio <database-url>` → Ephemeral; bare `quick-studio` → Persistent workspace; `quick-studio --persistent` → Persistent explicitly), an `Options:` block covering `-h, --help`, `-v, --version`, `--persistent`, `--ephemeral`, `--no-open`, and an `Environment:` block covering `QS_HOST`, `QS_PORT`, `QS_MODE`, `QS_NO_OPEN`, `QS_PASSPHRASE`, `QS_PASSPHRASE_FD` with one line each. End with a trailing newline. -- Keeps presentation out of the parser and makes the text unit-testable.
- [x] `src/core/cli-args.ts` -- declare `help: { type: "boolean", short: "h" }`, `version: { type: "boolean", short: "v" }`, `ephemeral: { type: "boolean" }` in the `parseArgs` options table and widen the local `values` type. Add `readonly action: "run" | "help" | "version"` to `CliArgs` (see Design Notes for why a flat field, not a discriminated union). Immediately after `parseArgs` succeeds — BEFORE the positional-count guard and BEFORE the contradiction gate — return early with `action: "help"` (if `values.help`) or `action: "version"`, filling the remaining fields from the pure fallback (`mode: resolveRunMode(env)`, `databaseUrl: null`, `openBrowser` computed as today) since `bin/` exits before reading them. Then add a new contradiction check `ephemeral && persistent` (own message, e.g. `contradictory mode selection: --ephemeral and --persistent select opposite modes`) placed BEFORE the existing URL+`--persistent` check, whose message must stay byte-identical. Finally insert `else if (ephemeral) { mode = "ephemeral"; }` between the URL branch and the `persistent` branch, and return `action: "run"` on the normal path. -- Every ordering here is load-bearing: help must outrank both guards, and the ephemeral branch must sit below the URL branch so `--ephemeral <url>` still carries the URL.
- [x] `bin/quick-studio.ts` -- import `HELP_TEXT` and `VERSION`; directly after the existing `CliArgsError` catch block (`:51`) and before the `startCore` try (`:53`), add `if (cli.action === "help") { process.stdout.write(HELP_TEXT); process.exit(0); }` and `if (cli.action === "version") { process.stdout.write(\`${VERSION}\n\`); process.exit(0); }`. Do not call `resolvePort()` or anything else first. -- These are the only stdout writes in the file; everything else stays stderr, and the Core must never boot on these paths.
- [x] `src/core/cli-args.test.ts` -- ADDITIVE cases only, one per I/O-matrix row: `--help` and `-h` → `action: "help"`; `--version` and `-v` → `action: "version"`; help alongside a URL AND `--persistent` → `action: "help"`, no throw; `--ephemeral` alone → `mode: "ephemeral"`, `databaseUrl: null`; `--ephemeral <url>` → ephemeral WITH the url; `--ephemeral --persistent` → `toThrow(CliArgsError)` + message matches `/contradictory/i`; `QS_MODE=persistent` + `--ephemeral` → ephemeral; plus `action: "run"` on one pre-existing-style normal case. Do not edit or reorder any existing case. -- The existing 13 cases are the regression contract for precedence.
- [x] `src/core/help-text.test.ts` -- NEW. Assert `HELP_TEXT` contains each of the six env-var names and each of the five flag spellings, and ends with `\n`. -- A cheap guard against the help text drifting out of sync with the flags and env vars the code actually honors.
- [x] `README.md` -- add a Flags section listing the five flags, and add the two env vars the code honors but the README omits (`QS_MODE`, `QS_NO_OPEN`). -- The README and `--help` are now the two discoverability surfaces; they must agree.

**Acceptance Criteria:**
- Given a normal build, when `bun run bin/quick-studio.ts --help` runs, then the usage block is on stdout, stderr is empty, the exit code is 0, and no TCP port is bound and no browser opens.
- Given a normal build, when `bun run build:binary` then `./dist/quick-studio --version` runs, then it prints the same string as `bun run bin/quick-studio.ts --version`, and that string equals `package.json`'s `version`.
- Given a clean checkout, when `bun install` runs with no manual build step, then `prepare` regenerates `version.generated.ts` alongside the existing generated bundles and `bun test` + `bun x tsc --noEmit` are green.
- Given the pre-existing `cli-args.test.ts` cases, when `bun test` runs, then all 13 pass unmodified — the diff to that file is additions only.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

## Review Triage Log

### 2026-07-23 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 7
- addressed_findings:
  - `[low]` `[patch]` `README.md` overrides claim was over-broad ("a flag or an explicit database URL always overrides the matching variable") — only `QS_MODE` has a flag override; `QS_HOST`/`QS_PORT`/`QS_NO_OPEN` have none. Rewrote the sentence to scope the override to `QS_MODE`.
  - `[low]` `[patch]` `scripts/build-version.ts` version regex `/^\d+\.\d+\.\d+/` was unanchored — trailing garbage (`1.2.3.4`, `1.2.3 oops`) would bake in verbatim. Anchored to a full semver-ish pattern with optional prerelease/build and `$`; also switched the output path to `new URL(..., import.meta.url)` for CWD-independent consistency with the manifest read.
  - `[low]` `[patch]` `cli-args.test.ts` lacked coverage for the documented "help wins over version when both passed" rule. Added a case asserting `--help --version` and `--version --help` both resolve `action: "help"`.

## Design Notes

**Why a flat `action` field, not a discriminated union.** A union like `{action:"help"} | {action:"run"; mode; …}` is the more honest model, but it would force every pre-existing test to narrow before touching `cli.mode`, breaking `tsc --noEmit` on `cli-args.test.ts` and violating the "existing cases stay unchanged" constraint. A single `action` field on the existing flat object keeps all fields present, makes help/version mutually exclusive by construction (unlike two booleans), and gives `bin/` one thing to branch on. When `action !== "run"` the other fields are filled from the pure fallback and are simply not read — `bin/` exits first.

**`--help` beats `--version` when both are passed** — check `help` first. Both still short-circuit before any usage guard, so `--help --frobnicate` is the one exception: `parseArgs` itself throws on the unknown option before the short-circuit can run, which is the pre-existing behavior and stays.

**Short aliases are safe.** There are no short options today and no code path treats a bare `-` specially; `parseArgs` only reads `-h`/`-v` from tokens beginning with a single dash, and a `postgres://…` positional never does. If a collision does surface, the Block-If says drop the aliases, not reshape positionals.

**Generated-module shape** (mirrors `ui-bundle.generated.ts`):
```ts
/**
 * AUTO-GENERATED by scripts/build-version.ts — DO NOT EDIT BY HAND.
 *
 * The package version, baked in at build time. A `--compile` binary has no
 * package.json to read. Regenerate with `bun run build`. Git-ignored.
 */
export const VERSION = "0.0.1" as const;
```

## Verification

**Commands:**
- `bun run build` -- expected: exits 0 and `src/core/version.generated.ts` now exists with the banner and a `VERSION` matching `package.json`.
- `bun x tsc --noEmit` -- expected: no errors.
- `bun test` -- expected: all green, including the 13 untouched `cli-args.test.ts` cases and the new additive ones.
- `bun run bin/quick-studio.ts --help 1>/tmp/h.out 2>/tmp/h.err; echo $?` -- expected: `0`, `/tmp/h.out` holds the usage block, `/tmp/h.err` is empty, process exits immediately (no listening line).
- `bun run bin/quick-studio.ts --version` -- expected: exit 0, bare version on stdout.
- `bun run build:binary && ./dist/quick-studio --version && ./dist/quick-studio --help` -- expected: identical version string, usage block, exit 0 on both.
- `bun run bin/quick-studio.ts --ephemeral --persistent; echo $?` -- expected: `1`, terse contradictory-mode message on stderr, no URL echoed.

## Auto Run Result

Status: done

### Summary
Widened the CLI surface for Story 11.1: `--help`/`-h` and `--version`/`-v` now print to **stdout** and exit **0** without booting the Core, and a new explicit `--ephemeral` flag selects Ephemeral mode (contradictory with `--persistent`, redundant-but-harmless alongside a URL). The version is baked in at build time via a generated `src/core/version.generated.ts` (from a new `scripts/build-version.ts` folded into the single `build` chain), so all distribution channels report the same string and no `package.json` is ever read at run time. Every pre-existing precedence rule and the URL+`--persistent` refusal message are unchanged.

### Files changed
- `scripts/build-version.ts` (new) — reads `package.json`'s `version` (via `import.meta.url`, CWD-independent), validates it against an anchored semver-ish regex, writes `src/core/version.generated.ts`.
- `src/core/version.generated.ts` (new, generated, gitignored) — `export const VERSION` baked at build time.
- `src/core/help-text.ts` (new) — standalone `HELP_TEXT` constant: three launch forms, five flags, six env vars.
- `src/core/help-text.test.ts` (new) — drift guard asserting every flag/env-var name is present and the text ends with a newline.
- `src/core/cli-args.ts` — declared `help`/`version`/`ephemeral` (short `-h`/`-v`); added `action: "run"|"help"|"version"` to `CliArgs`; help/version short-circuit before all guards; `--ephemeral --persistent` refused before the byte-identical URL+`--persistent` gate; `--ephemeral` branch sits below the URL branch.
- `bin/quick-studio.ts` — imports `HELP_TEXT`/`VERSION`; two stdout early-exit blocks after the `CliArgsError` catch, before any port/Core work.
- `src/core/cli-args.test.ts` — additive cases only (all 13 pre-existing untouched; +9 new incl. `--help --version` precedence).
- `package.json` — appended `&& bun scripts/build-version.ts` to `build` (covers `build:binary`/`dev`/`prepare`/`prepublishOnly`).
- `.gitignore` — added `src/core/version.generated.ts`.
- `README.md` — new Flags section; documented `QS_MODE`/`QS_NO_OPEN`.

### Review findings breakdown
- Patches applied (3, all low): README over-broad override claim scoped to `QS_MODE`; unanchored version regex anchored (+ `new URL` output path); added the `--help --version` precedence test.
- Deferred (1, low): npm publish allowlist / `.gitignore`-vs-`.npmignore` generated-module hazard → DW-75 (owned by Story 11.4).
- Rejected (7): all by-design and spec-documented (fresh-clone missing-import fails loudly by design; `--help --bogus` parser rejection is the acknowledged exception; dead-work in early-return is defensive; bare `--version` output, `-v` short alias, and 3-form Usage synopsis are intent-contract decisions; drift-guard scope meets spec).

### Verification
- `bun run build` — exit 0; `version.generated.ts` regenerated with `VERSION "0.0.1"`.
- `bun x tsc --noEmit` — clean.
- `bun test` — 1581 pass / 0 fail (78 files); the 13 pre-existing `cli-args.test.ts` cases untouched (diff is additions only).
- `bun run bin/quick-studio.ts --help` — usage on stdout, stderr empty, exit 0, no listening line.
- `bun run bin/quick-studio.ts --version` / `-v` — `0.0.1`, exit 0.
- `bun run build:binary && ./dist/quick-studio --version && ./dist/quick-studio --help` — same version string + usage, exit 0 (compiled binary path confirmed).
- `bun run bin/quick-studio.ts --ephemeral --persistent` — terse contradictory-mode message on stderr, exit 1, no URL echoed.
- Regex spot-check: accepts `0.0.1`/`1.2.3-rc.1`/`1.2.3+build`, rejects `1.2.3.4`/`1.2.3 oops`/`1.2.3-`.

### Residual risks
- npm publish packaging (DW-75) is unverified in this environment and deferred to Story 11.4, which owns the generated manifest and publish workflow — the standalone binary and `bun run` channels are fully verified.
- `followup_review_recommended: false` — the three fixes were localized, low-consequence (one doc line, one build-script guard, one added test); no behavior/API/security surface changed.
