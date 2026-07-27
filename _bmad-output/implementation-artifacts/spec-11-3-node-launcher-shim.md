---
title: 'Node-compatible launcher shim so npx/npm-global runs without Bun'
type: 'feature'
created: '2026-07-21'
status: 'done'
baseline_revision: 'ed77f8ef1f95fc4e7b7f0edcc6e549a0ecfe5bbb'
final_revision: '41fc85d267413bc022c05bbb4e42189c8f5d36de'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.3
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-7-one-command-install.md'
warnings: [oversized]
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

## Code Map

- `bin/quick-studio.cjs` (NEW) — the launcher. A `#!/usr/bin/env node` CommonJS file requiring only `node:child_process`, `node:path`, `node:os`. Sections: (1) `SUPPORTED` — a plain object literal keyed `"<platform>-<arch>"` → package name; (2) `RELEASES_URL` constant; (3) resolve → (4) `spawn` with `stdio: "inherit"` → (5) SIGINT/SIGTERM forwarding → (6) exit mirroring. Keeps the map a literal so the later macOS phase adds two entries and nothing else.
- `package.json` — repoint `bin.quick-studio` from `bin/quick-studio.ts` to `bin/quick-studio.cjs` (lines 6-8); add `engines.node` floor (`>=18`) alongside the existing `engines.bun` (now a development statement, the enforced floor for the npm consumer is `node`). The published main manifest is **generated** in 11.4 — this edit governs the repo's own metadata; keep the two consistent.
- `bin/quick-studio.ts` — UNCHANGED. Called out explicitly so a reviewer does not "helpfully" unify the two entries. `dev` keeps invoking it via Bun.
- `src/core/lifecycle.ts` — UNCHANGED, read-only reference. `createShutdownController` runs `stop()`→`exit()` at most once, driven solely by the process SIGINT/SIGTERM handlers (`bin/quick-studio.ts:91-92`) or the UI `shutdown` RPC. Forwarding SIGINT/SIGTERM to the child is therefore sufficient to fire the existing clean-shutdown path — no product change needed.
- `bin/quick-studio-shim.test.ts` (NEW) — spawn-based `bun:test`. A helper materializes a temp fake platform package (`quick-studio-<platform>-<arch>/package.json` + a node-shebang fake binary) reachable via `NODE_PATH`, exercising the **real** resolution + spawn path. No existing test spawns a subprocess, so this establishes the pattern (existing tests inject a fake `spawn`, e.g. `src/core/browser-open.test.ts`; that pattern does not apply here because the shim runs as its own process).

## Tasks & Acceptance

**Execution:**
- [x] `bin/quick-studio.cjs` — NEW. `#!/usr/bin/env node`; `const { spawn } = require("node:child_process"); const path = require("node:path"); const os = require("node:os");`. Define `SUPPORTED = { "win32-x64": "quick-studio-win32-x64", "linux-x64": "quick-studio-linux-x64", "linux-arm64": "quick-studio-linux-arm64" }` and `RELEASES_URL = "https://github.com/joajo13/quick-studio/releases"`. Compute `key = \`${process.platform}-${process.arch}\``. If `!SUPPORTED[key]` → `fail(key)` (see below). Else resolve per **Design Notes / Resolution**: `require.resolve(\`${SUPPORTED[key]}/package.json\`)` in a `try`, on throw → `fail(key, /*notInstalled*/ true)`; `binary = path.join(path.dirname(resolved), process.platform === "win32" ? "quick-studio.exe" : "quick-studio")`. — The launcher must decide platform, resolve, and spawn with zero product code.
- [x] `bin/quick-studio.cjs` (spawn + exit mirroring) — `const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });`. `child.on("error", (e) => { if (e.code === "ENOENT" || e.code === "EACCES") fail(key, true, /*execProblem*/ true); else { process.stderr.write(\`quick-studio: failed to launch: ${e.message}\n\`); process.exit(1); } });`. `child.on("close", (code, signal) => { if (signal) process.exit(128 + (os.constants.signals[signal] || 0)); else process.exit(code == null ? 1 : code); });`. — Verbatim argv, inherited stdio, exact exit propagation; the shim never exits before the child.
- [x] `bin/quick-studio.cjs` (signal forwarding, Block-If #2) — for `sig` of `["SIGINT", "SIGTERM"]`: `process.on(sig, () => { if (process.platform !== "win32") { try { child.kill(sig); } catch {} } });`. On POSIX this delivers the signal so the Core's controller runs; on Windows the handler intentionally does NOT `child.kill` (Node maps these to `TerminateProcess` = hard kill, defeating graceful shutdown) — the shared console delivers CTRL_C to the child directly (see Design Notes). Registering the handlers keeps Node from auto-terminating the shim, so it waits for the child's `close`. — Preserves the Story 1.5 clean-shutdown guarantee on all three platforms without a job-object/detach/process-group dance.
- [x] `bin/quick-studio.cjs` (`fail` helper) — `function fail(key, notInstalled, execProblem) { ... process.exit(1); }` writing an actionable multi-line stderr message: line 1 names the detected `key`; if `key` starts with `darwin` say **"macOS is not yet supported (a later release will add it)"**; if `notInstalled` say the platform package was not installed (likely `--no-optional` or a failed optional install) and to reinstall, and if `execProblem` add that the binary may have lost its executable bit (a packaging issue); always list the supported set (`windows-x64, linux-x64, linux-arm64`) and `Download a standalone binary: ${RELEASES_URL}`. Never print a `MODULE_NOT_FOUND` stack. — The failure UX is the whole point of the resolution branch.
- [x] `package.json` — repoint `bin.quick-studio` to `bin/quick-studio.cjs`; set `engines` to `{ "node": ">=18", "bun": ">=1.2.0" }`. — npm enforces `engines.node`; `engines.bun` was decorative for the npm consumer and stays only as a dev signal.
- [x] `bin/quick-studio-shim.test.ts` — NEW spawn-based `bun:test`, one block per I/O-matrix row that is testable in dev: (a) **argv fidelity** — fake binary echoes `JSON.stringify(process.argv.slice(2))`; assert `["--ephemeral","postgres://u:p@h/db?x=1&y=2"]` round-trips byte-identical; (b) **no arguments** → empty argv echoed; (c) **exit-code passthrough** — fake exits with a code taken from an arg; assert the shim exits the same; (d) **`--version` stdout inherit** — fake writes to stdout and exits 0; assert stdout reaches the parent; (e) **resolution failure** — no fake package on `NODE_PATH` → assert non-zero exit, stderr contains the detected `key`, the supported list, `RELEASES_URL`, and NO `MODULE_NOT_FOUND`; (f) **darwin wording** — if the helper can force `key` to a darwin value, assert "macOS" wording (else cover via the failure message's branch under the current platform and note the darwin branch is asserted by string presence). Signal-forwarding + graceful-exit mirroring is asserted on POSIX only (fake traps SIGINT, exits with a marker code; shim sends SIGINT; assert mirrored exit), guarded by a `process.platform === "win32"` skip. — Exercises the real resolve+spawn path; the fake package is built under a temp dir and reached via `NODE_PATH` set on the spawned shim.
- [ ] Manually verify on a machine (or container) with Node and **no** Bun on `PATH`, against a locally built `dist/quick-studio` staged as the fake platform package — this is the only check that actually proves the story end-to-end. _(Left unchecked: manual / out-of-environment check. This dev environment has Bun but no standalone Node — Node compatibility was exercised in-suite via a `bun`-as-`node` symlink; a true no-Bun machine still needs a human pass.)_
- [x] `bun x tsc --noEmit`, `bun test`, `bun run build`, `bun run build:binary` green; `bun run dev` unchanged.

**Acceptance Criteria:**
- Given Node 18+ and no Bun installed, when the shim runs with a resolvable platform package, then the prebuilt binary launches, `process.argv.slice(2)` passes verbatim, stdio is inherited, and the shim's exit code equals the child's.
- Given `SIGINT` to the shim on POSIX, when the child is running, then the child receives `SIGINT`, the Core's `ShutdownController` runs, and the shim exits only after the child (mirroring its code, or `128 + signum` on signal death).
- Given a platform not in `SUPPORTED` or a platform whose package is not installed, when the shim runs, then stderr carries the detected `platform-arch`, the supported list, and `RELEASES_URL`, with no `MODULE_NOT_FOUND` stack, and the exit code is non-zero.
- Given the repo, when a developer runs `bun run dev`, then behavior is unchanged — `bin/quick-studio.ts` is untouched and still the development entry.

## Spec Change Log

## Review Triage Log

### 2026-07-23 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 11
- addressed_findings:
  - `[low]` `[patch]` `bin/quick-studio.cjs` — `fail()` used `process.stderr.write` then `process.exit(1)`; on a piped stderr (`2> log`) the async write can truncate the one diagnostic the branch exists to deliver. Switched to synchronous `fs.writeSync(2, …)` (and the generic launch-error path too) so the message always flushes before exit.
  - `[low]` `[patch]` `bin/quick-studio.cjs` — the `child.on("error")` handler lumped `ENOENT` and `EACCES` into a single `fail(key, true, true)`, so a missing binary was told "lost its executable bit" and a non-executable binary was told "not installed". Split them: `ENOENT` → not-installed/missing-binary wording, `EACCES` → executable-bit wording.
  - `[low]` `[patch]` `bin/quick-studio.cjs` — a signal delivered to the shim PID alone (`kill -HUP`/process manager) for `SIGHUP`/`SIGQUIT` terminated the shim on default disposition and orphaned the child (port left bound). Extended the forwarded set to `SIGINT, SIGTERM, SIGHUP, SIGQUIT` so the child is never orphaned; the Core's idempotent controller makes any duplicate signal a safe no-op.
  - `[low]` `[patch]` `bin/quick-studio-shim.test.ts` — two documented behaviors shipped untested: signal-death exit mirroring (`128 + signum`) and the spawn-error/exec-problem failure UX. Added a POSIX signal-death test (child self-`SIGKILL` → shim exits 137) and two spawn-error tests (binary missing → ENOENT "not installed"; binary present-but-0644 → EACCES "executable bit"). Suite: 1587 → 1590 pass.
  - `[low]` `[defer]` Story 11.4 platform-package contract — the shim's `require.resolve(\`${pkg}/package.json\`)` + fixed `<pkgroot>/quick-studio[.exe]` binary path assumes 11.4's generated manifests carry no restrictive `exports` (or explicitly export `./package.json`) and set the binary's exec bit; a restrictive `exports` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` and misreports "not installed". Corrected the Design Notes over-claim of "immune to `exports`" and filed the contract as deferred work.
- Rejected (11): POSIX Ctrl-C double-signal / repeated-signal fan-out (×3, harmless — `createShutdownController` runs stop→exit at most once, `src/core/lifecycle.ts:26-45`); SIGTERM-ignoring-child hang with no SIGKILL watchdog (matches pre-shim behavior; adding a watchdog is out of scope); `win32-x64` vs `windows-x64` vocabulary mismatch (the spec I/O matrix deliberately shows raw `process.platform` tokens like `darwin-arm64`); exit codes >255 wrap mod 256 (inherent 8-bit POSIX exit; the compiled binary cannot return >255 either); darwin-wording test skipped off-darwin (adding a test seam to a load-time script is disproportionate for a one-line string); pnpm/Yarn-PnP resolution (pnpm resolves via realpath; PnP is niche and the manual no-Bun verification covers real layouts); SIGTERM-forwarding untested (identical loop to the covered SIGINT path); non-MODULE_NOT_FOUND error swallowed in `catch` (dominant real cause is not-installed; the `exports` case is covered by the 11.4 defer).

## Design Notes

**Resolution strategy (resolves Block-If #1).** The shim resolves `require.resolve(\`${pkg}/package.json\`)`, then joins the binary filename onto its `dirname`. Resolving `package.json` (rather than the binary subpath directly) is deliberate: it avoids depending on a subpath being listed in an `exports` map. It is **not** unconditionally immune to `exports` — a platform manifest that declares a restrictive `exports` field which omits `"./package.json"` would make Node throw `ERR_PACKAGE_PATH_NOT_EXPORTED` even when the package is installed. This is a shared-contract requirement on Story 11.4: each generated platform manifest must **not** carry a restrictive `exports` field (or must explicitly export `"./package.json"`), and must place the binary at `<pkgroot>/quick-studio[.exe]` with the executable bit set. 11.4 generates minimal manifests (no `dependencies`, no scripts), so this is a note to preserve, not a new constraint — but it is load-bearing and is filed as deferred work against 11.4. It works across every layout that matters because an `optionalDependencies` entry is always materialized in a `node_modules` reachable from the main package: **global install** (`lib/node_modules/quick-studio/node_modules/…` or hoisted sibling), **npx cache** (same tree in the cache dir), **hoisted vs nested** (`require.resolve` performs the standard `node_modules` walk upward), and **pnpm** (`require.resolve` uses realpath, so the symlinked store resolves to the real package). This is the same pattern esbuild/swc use for their platform packages.

**Shared in-package contract (three consumers, one string).** The three consumers agree on the package *name* (`quick-studio-<platform>-<arch>`); this story additionally pins the **in-package binary path** that 11.4 must honor: each platform package places its binary at the package root as `quick-studio` (POSIX) or `quick-studio.exe` (win32), with the executable bit set. Note the two OS tokens differ by design — the npm *package* uses `win32` (from `process.platform`), while Story 11.2's release *asset* is `quick-studio-windows-x64.exe`; 11.4's packaging renames the release asset to the canonical in-package filename when assembling each package.

**Windows signals (resolves Block-If #2 — no escalation).** No detach, job object, or process-group dance is required. On POSIX the shim forwards `SIGINT`/`SIGTERM` via `child.kill(sig)`, delivering the signal that fires the Core's controller. On Windows, `child.kill("SIGINT")` maps to `TerminateProcess` (a hard kill) which would *defeat* graceful shutdown, so the shim deliberately does **not** forward there; instead it relies on the standard Windows behavior that a console CTRL_C is delivered to the whole console process group — with inherited stdio the child shares the console and receives it directly — and the shim simply waits for the child's `close`. The shipped clean-shutdown guarantee (Story 1.5) is preserved on all three platforms.

**Testability seam.** The platform package does not exist in the dev repo (11.4 builds it), so the test materializes a fake one under a temp dir and points the spawned shim at it via `NODE_PATH` (which `require.resolve` honors). This exercises the real resolve+spawn+exit path rather than a mock, and the failure-path test simply omits the fake package. Windows-specific signal semantics are covered by the manual no-Bun verification and 11.4's release CI, not by this unit test (guarded with a win32 skip), because a cross-platform fake executable is not worth the harness complexity.

## Verification

**Commands:**
- `bun x tsc --noEmit` — expected: no errors (the `.cjs` shim is not typechecked, but the new `.test.ts` is).
- `bun test` — expected: all green, including the new `bin/quick-studio-shim.test.ts` cases and every pre-existing test.
- `bun run build` — expected: exit 0 (generators unaffected).
- `bun run build:binary` — expected: `dist/quick-studio` produced (the local binary the manual check stages as the fake platform package).
- `node bin/quick-studio.cjs` on a machine/container with **no** Bun, with `dist/quick-studio` staged as `quick-studio-<platform>-<arch>/quick-studio` on `NODE_PATH` — expected: the binary launches, the listening URL prints on stderr, Ctrl-C shuts down cleanly, exit code mirrors the child.
- `node bin/quick-studio.cjs` with **no** platform package resolvable — expected: actionable stderr (detected `platform-arch`, supported list, `RELEASES_URL`), no `MODULE_NOT_FOUND` stack, non-zero exit.
- `bun run dev` — expected: unchanged; still runs `bin/quick-studio.ts` via Bun.

## Auto Run Result

Status: done

### Summary
Added `bin/quick-studio.cjs`, a dependency-free `#!/usr/bin/env node` CommonJS launcher that makes the npm/npx channel work without Bun: it maps `process.platform`+`process.arch` to a `quick-studio-<platform>-<arch>` package, `require.resolve`s the prebuilt binary inside it, `spawn`s it with `process.argv.slice(2)` verbatim and `stdio: "inherit"`, forwards terminating signals so the Core's existing clean-shutdown path runs, and mirrors the child's exit. `bin/quick-studio.ts` stays the untouched Bun development entry; `package.json` repoints `bin` to the shim and adds a `node>=18` engine floor. Story 11.4 builds and publishes the platform packages this shim resolves.

### Files changed
- `bin/quick-studio.cjs` (new) — the launcher: `SUPPORTED` platform map, `RELEASES_URL`, `require.resolve(<pkg>/package.json)` → binary path, `spawn` with inherited stdio, verbatim argv, signal forwarding (`SIGINT/SIGTERM/SIGHUP/SIGQUIT`, POSIX-only `child.kill`), exit mirroring (`code`, or `128+signum` on signal death), and a synchronous actionable `fail()` diagnostic (never a `MODULE_NOT_FOUND` stack).
- `bin/quick-studio-shim.test.ts` (new) — spawn-based `bun:test`: materializes a fake platform package via `NODE_PATH` and exercises the real resolve+spawn path — argv fidelity (incl. a DB-URL positional), no-args, `--version` stdout, exit-code passthrough, resolution-failure UX, POSIX SIGINT graceful mirror, signal-death mirror (137), and missing-binary/non-exec spawn-error UX.
- `package.json` — `bin.quick-studio` → `bin/quick-studio.cjs`; `engines` gains `node: ">=18"` (the enforced floor for the npm consumer; `bun` stays as a dev signal).
- `bin/quick-studio.ts`, `src/core/**` — untouched (confirmed by `git diff`).

### Review findings breakdown
- Patches applied (4, all low): (1) `fail()` switched to synchronous `fs.writeSync` so a piped stderr can't truncate the diagnostic; (2) split `ENOENT` vs `EACCES` in the spawn-error handler so the message matches the real cause; (3) extended the forwarded signal set to `SIGHUP`/`SIGQUIT` so a signal to the shim PID alone can't orphan the child; (4) added tests for signal-death mirroring and the spawn-error/exec-problem UX.
- Deferred (1, low): DW-77 — the 11.4 platform-package contract (no restrictive `exports`; binary at `<pkgroot>/quick-studio[.exe]` with exec bit). The Design Notes over-claim of "immune to `exports`" was corrected.
- Rejected (11): idempotent-controller double/repeat-signal (×3), SIGTERM-hang watchdog (out of scope, matches pre-shim behavior), `win32`-vs-`windows` vocabulary (spec shows raw platform tokens by design), >255 exit-code wrap (inherent 8-bit), darwin-skip / pnpm-PnP / SIGTERM-test / swallowed-non-MODULE_NOT_FOUND (disproportionate or speculative; the real `exports` risk is covered by DW-77).

### Verification
- `bun x tsc --noEmit` — clean (exit 0).
- `bun test` — **1590 pass, 1 skip, 0 fail** (79 files); the shim file: 9 pass, 1 skip (darwin-wording, expected off-darwin). Up from 1587 pre-patch (+3 new tests).
- `bun run build` — exit 0 (generators + `version.generated.ts` regenerated).
- `bun run build:binary` — exit 0, `dist/quick-studio` produced (verified during implementation).
- `git diff` scope: only `package.json`, `bin/quick-studio.cjs`, `bin/quick-studio-shim.test.ts` (plus this spec + the DW-77 ledger append); `bin/quick-studio.ts` and `src/core/**` untouched.

### Environment note
This WSL environment has Bun but no real Node. The shim and its tests spawn `node`; verification ran under a temporary `node → bun` node-compat alias (created and removed within the run, no residue). Bun's node-compat covers the shim's `require`/`child_process`/`os.constants.signals` surface, but the **"manually verify on a machine with Node and no Bun" task is intentionally left unchecked** — it is the only check that proves the story on a genuine Node runtime and must run in Story 11.4's CI or on a real Node box.

### Residual risks
- The end-to-end npm path (real Node, resolving a real published platform package) is unverified here — it depends on Story 11.4's packages existing; DW-77 pins the manifest/layout contract that path relies on.
- `followup_review_recommended: false` — the four fixes were localized and low-consequence (message accuracy, orphan-prevention in a niche signal path, added tests); no product behavior, API, security, or data surface changed.
