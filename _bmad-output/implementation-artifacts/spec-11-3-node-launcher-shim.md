---
title: 'Node-compatible launcher shim so npx/npm-global runs without Bun'
type: 'feature'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.3
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-7-one-command-install.md'
---

<intent-contract>

## Intent

**Problem:** `package.json:6-8` points `bin.quick-studio` at `bin/quick-studio.ts`, whose shebang is `#!/usr/bin/env bun` and whose body imports Bun-only APIs (`Bun.spawn` at `bin/quick-studio.ts:110`, `Bun.serve` inside `startCore`). npm and npx both install this happily on a machine that has never seen Bun, create the `quick-studio` symlink, and then the command dies on first run with `env: 'bun': No such file or directory`. Story 1.7's review found this and resolved it by **rewording the README** ("Requires Bun installed and on your PATH") — the trap is still fully armed, and `engines.bun` (`package.json:14-16`) is decorative because npm never enforces it. The consequence is that the npm channel, which is the one channel that could give us install-if-missing / update / launch for free via `npx`, is the channel that does not work.

**Approach:** Stop shipping the TypeScript entry as the published `bin`. Add `bin/quick-studio.cjs`: a dependency-free CommonJS launcher with a `#!/usr/bin/env node` shebang that (1) maps `process.platform` + `process.arch` to a platform package name, (2) `require.resolve`s the prebuilt binary inside it, (3) `child_process.spawn`s that binary with `process.argv.slice(2)` verbatim and `stdio: "inherit"`, and (4) mirrors the child's exit — forwarding signals so the Core's existing clean-shutdown path (`src/core/lifecycle.ts`, wired at `bin/quick-studio.ts:76-77`) runs exactly as it does today. `bin/quick-studio.ts` stays untouched as the development entry (`bun run dev` keeps using it). This story writes and tests the shim against a locally built binary; Story 11.4 builds the platform packages it resolves and publishes them.

## Boundaries & Constraints

**Always:**
- The shim is **plain CommonJS with zero dependencies**, using only `node:child_process`, `node:path`, and `require.resolve`. It must run on Node 18 with no transpilation, no `type: module` assumptions, and no reliance on anything in the repo's dependency tree — it is the one file that executes before any of the product does.
- Arguments pass through **verbatim**: `spawn(binary, process.argv.slice(2), { stdio: "inherit" })`. The shim must not parse, reorder, quote, or interpret a single argument — a database URL is a positional that may contain characters the shim has no business touching, and all CLI semantics live in `parseCliArgs`.
- `stdio: "inherit"` is required, not optional: the Core writes its listening URL and the Port-Exposure Warning to stderr, and Story 11.6's passphrase prompt needs a real TTY on stdin. A piped/captured stdio would break both.
- Signals (`SIGINT`, `SIGTERM`) are forwarded to the child, and the shim exits only **after** the child does, propagating the child's exit code (and, where the platform reports one, a signal death as the conventional `128 + signum`). Ctrl-C through the shim must end the session as cleanly as Ctrl-C does today.
- A resolution failure produces an actionable message on stderr naming the detected `platform-arch`, the supported list, and the Releases fallback — never a raw `MODULE_NOT_FOUND` stack.
- The supported-platform set is **windows-x64, linux-x64, linux-arm64** for this epic, and must match Story 11.2's release matrix and Story 11.4's packaging list exactly — one shared platform list, three consumers. macOS is a later phase and the shim must say so by name rather than failing generically.

**Block If:**
- If `require.resolve` of the platform package cannot work under npm's install layouts that matter here (a global install, an `npx` cache, a hoisted vs nested `node_modules`, a pnpm-style symlinked store), STOP and flag it — the resolution strategy is the load-bearing assumption of both this story and 11.4, and guessing wrong produces a package that works on the author's machine only.
- If forwarding signals correctly on **Windows** (where `SIGINT` delivery to a spawned child is not POSIX-equivalent) turns out to require detaching, a job object, or a process-group dance, flag it for an explicit decision rather than improvising — clean shutdown is a shipped guarantee (Story 1.5) and this shim must not silently weaken it.

**Never:**
- Never modify `bin/quick-studio.ts` in this story. It remains the Bun development entry; `dev` (`package.json:20`) keeps invoking it directly.
- Never have the shim import, require, or bundle any product code — it cannot reach `src/`, and after 11.4 the published main package will not even contain `src/`.
- Never make the shim fall back to running the TypeScript entry through Bun if the binary is missing. That reintroduces the exact hidden-Bun-dependency this story exists to remove; a clear failure is the correct outcome.
- Never let the shim swallow the child's exit code or exit before the child.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Normal run, no Bun | Node 18+, platform package present, `quick-studio postgres://x` | Binary spawns with `["postgres://x"]`; stderr shows the listening URL; UI opens | none |
| Exit-code passthrough | binary exits 1 (e.g. invalid `QS_PORT`, `bin/quick-studio.ts:34-35`) | Shim exits 1 | Code mirrored exactly |
| Ctrl-C | `SIGINT` to the shim | Forwarded to the child; the Core's `ShutdownController` runs; shim exits after the child | Never orphans the child |
| Unsupported platform | e.g. **darwin** (a later phase), or Windows-on-ARM | stderr: detected `darwin-arm64`, the supported list, and the Releases link; exit non-zero | No stack trace. macOS must read as "not yet supported", never as a broken install |
| Optional dependency skipped | install ran with `--no-optional` or the optional install failed | Same actionable message as above — this is the most likely real-world failure and must read as a fixable install problem | No stack trace |
| Argument fidelity | `quick-studio --ephemeral "postgres://u:p@h/db?x=1&y=2"` | Child receives both argv entries byte-identical | Never re-quoted or re-parsed |
| No arguments | `quick-studio` | Child receives an empty argv — bare-command behavior is entirely the binary's business (Story 11.7) | none |
| Help/version through the shim | `quick-studio --version` | The binary's stdout reaches the terminal unmodified (inherit), exit 0 | none |
| Binary not executable | POSIX file mode lost in packaging | Actionable message; 11.4 must set the executable bit when building the platform package | Flag: packaging-side fix, not a shim workaround |

</intent-contract>

## Acceptance Criteria

- Given Node 18+ and no Bun installed, when the shim runs, then the prebuilt binary launches, arguments pass verbatim, stdio is inherited, and the exit code is the child's.
- Given Ctrl-C, when the shim receives `SIGINT`, then the child receives it, shuts down cleanly, and the shim exits after it.
- Given a platform or install with no resolvable binary, when the shim runs, then it prints an actionable message naming the platform and the fallback, with no `MODULE_NOT_FOUND` stack.
- Given the repo, when a developer runs `bun run dev`, then behavior is unchanged — the shim is not on the development path.

## Code Map

- `bin/quick-studio.cjs` (new) — the launcher. Platform map (`win32-x64`, `linux-x64`, `linux-arm64`) → scoped package name (`@quick-studio/<platform>-<arch>`) → `require.resolve` → `spawn` → signal forwarding → exit mirroring. The map is a plain object literal so the later macOS phase adds two entries and nothing else.
- `package.json` — repoint `bin.quick-studio` to `bin/quick-studio.cjs`. Note the published manifest is **generated** in 11.4, so this edit governs the repo's own metadata; keep the two consistent. `engines` gains a `node` floor; `engines.bun` becomes a development statement only.
- `bin/quick-studio.ts` — unchanged. Called out explicitly so a reviewer does not "helpfully" unify the two entries.
- `src/core/…` — untouched. This story adds no product code.
- Tests — the shim is CommonJS invoked as a subprocess, so it is exercised by spawning it (against a locally built `dist/quick-studio`) and asserting argv passthrough, exit-code mirroring, and the failure message, rather than by importing it. Step-02 decides whether that lives in `bun test` as a spawn-based test or as a scripted check; a spawn-based `bun test` file is preferred so it runs in the existing suite.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] Settle the `require.resolve` strategy against global-install, `npx`-cache, hoisted, and pnpm layouts before writing the resolution code (Block-If #1).
- [ ] Write `bin/quick-studio.cjs`: platform map, resolution, spawn with inherited stdio, verbatim argv.
- [ ] Signal forwarding + exit-code mirroring, including the Windows caveat (Block-If #2).
- [ ] Actionable resolution-failure message (platform, supported list, Releases fallback).
- [ ] Repoint `bin` in `package.json`; add the `node` engine floor.
- [ ] Spawn-based tests: argv fidelity, exit-code passthrough, failure message, `--version` passthrough.
- [ ] Manually verify on a machine (or container) with Node and **no** Bun on `PATH` — this is the only check that actually proves the story.
- [ ] `bun x tsc --noEmit`, `bun test`, `bun run build` green; `bun run dev` unchanged.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

## Review Triage Log

<!-- populated by the review loop -->
