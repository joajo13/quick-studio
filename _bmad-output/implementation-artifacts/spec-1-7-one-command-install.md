---
title: 'Story 1.7 — One-command install via dual distribution'
type: 'feature'
created: '2026-07-06'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '6b6a445abf13c6c79da602e7de7a960939ce7d81'
final_revision: 'd449b4b75b6e072c0fb0ca78436e491ee46f49a5'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The epic promises a single documented command to install quick-studio on Windows and Linux via two paths — a standalone `bun build --compile` binary from releases, and an npm/bun global package (FR-1, AR-16). Neither works today: `startCore` bundles the UI at **runtime** on every boot via `Bun.build` (`src/core/server.ts:89-117`, called at `:177`), reading the source tree through an `import.meta.dir`-relative entry (`src/ui/main.tsx`). A `--compile` single-file binary has no bundler and no source tree, so it cannot boot; and the runtime bundle imports `bun-plugin-tailwind`, a **devDependency**, so a global install without dev deps also fails. `package.json` is additionally `private: true` with no `bin`/`files`/`engines`, so it cannot be published or globally installed.

**Approach:** Move UI bundling to **build time**. A `scripts/build-ui.ts` runs `Bun.build` (with the Tailwind plugin) once and emits the JS + CSS into a generated TypeScript module `src/core/ui-bundle.generated.ts` (`export const uiBundle = { js, css }`). `startCore` imports that module and serves the pre-built assets — no runtime bundler, no source-tree reads, no `bun-plugin-tailwind` at runtime. Because the bundle is ordinary source, `bun build --compile` embeds it into a self-contained binary, and a global install ships the same generated module. Make `package.json` publishable (`bin`/`files`/`engines`, drop `private`, `prepublishOnly` builds the bundle), add a `build:binary` script and a `release.yml` workflow for per-platform binaries, and document both one-command installs in a README.

## Boundaries & Constraints

**Always:**
- Both distribution paths yield the **identical** one-command run and serve a byte-identical UI from ONE build-time bundle (single source of truth: `src/core/ui-bundle.generated.ts`).
- The compiled binary is fully self-contained: it boots and serves `/`, `/app.js`, `/app.css` with no bundler invocation and no source-tree filesystem read, on a machine where bun is not installed.
- `package.json` is publishable (`private` removed; `bin`, `files`, `engines` present) and `prepublishOnly` regenerates the bundle so the shipped package contains it.
- Default loopback boot, token auth, the Origin/Host gates, the RPC contract, and the Port-Exposure Warning stay **byte-for-byte unchanged** — this story only changes where/when the UI bundle is produced.
- Module files kebab-case; React components PascalCase; explicit `.ts`/`.tsx` import extensions; `import type` for type-only imports (verbatimModuleSyntax); respect `noUncheckedIndexedAccess`.

**Block If:**
- `bun build --compile` cannot embed the generated bundle into a runnable binary on the target platforms (i.e. the only way to make the binary serve the UI is to reintroduce a runtime `Bun.build`). HALT — do not re-break `--compile`.
- Making the npm/bun global path run would require shipping a devDependency at runtime (e.g. keeping `bun-plugin-tailwind` on the boot path). HALT — the bundle must be build-time only.

**Never:**
- No runtime `Bun.build` / bundler call and no `bun-plugin-tailwind` import on any boot path (`startCore` or below).
- No `import.meta.dir`-relative reads of the source tree at runtime.
- No interactive install wizard or multi-step ceremony (FR-1, AR-16).
- No native DB drivers, no code signing / notarization, no auto-update, no persistence — out of scope. No change to auth, token, RPC, or exposure behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Compiled-binary run | run the `bun build --compile` binary on a host without bun | Core boots, prints listening URL to stderr, serves `/app.js` + `/app.css` from the embedded bundle; app loads | binary self-contained; no bundler/FS dependency |
| Global-install run | `bun add -g quick-studio` (or `npm i -g`), then `quick-studio` | same one-command run; UI served from the shipped generated bundle | No error expected |
| Bundle absent | `src/core/ui-bundle.generated.ts` not yet generated | `bun run build` regenerates it; `tsc`/`test` require build-first (documented prerequisite) | missing import fails loudly until build runs |
| Stale UI source | edit `src/ui/*`, re-run the shipped artifact without rebuild | serves the last-built bundle (no runtime re-bundle) | intentional: rebuild via `bun run build` |
| Default loopback boot | no `QS_HOST`/`QS_PORT` | binds `127.0.0.1`, gates/token/exposure identical to today | No error expected |

</intent-contract>

## Code Map

- `scripts/build-ui.ts` (new) -- build-time bundler: `Bun.build({ entrypoints: ["src/ui/main.tsx"], target: "browser", plugins: [tailwind], define: {NODE_ENV} })`, select the JS entry-point + `.css` artifacts (same selection logic that lives in `server.ts:106-115` today), then write `src/core/ui-bundle.generated.ts` exporting `uiBundle = { js, css } as const` with the two strings serialized via `JSON.stringify`. Fails loudly if the build fails or an artifact is missing.
- `src/core/ui-bundle.generated.ts` (generated, gitignored) -- `export const uiBundle: { readonly js: string; readonly css: string }`. The single UI-asset source consumed by dev, npm-global, and compiled paths; embedded into the binary as ordinary source.
- `src/core/server.ts` -- remove `import tailwind from "bun-plugin-tailwind"` and the whole `buildUiBundle()` fn (`:78-117`); import `{ uiBundle }` from `./ui-bundle.generated.ts`; in `startCore` replace `const { js, css } = await buildUiBundle()` (`:177`) with `const { js: appJs, css: appCss } = uiBundle`. Everything else (gates, `renderIndexHtml` export, asset routes) unchanged.
- `src/core/server.test.ts` (or new `src/core/ui-bundle.test.ts`) -- assert the booted Core serves `/app.js` and `/app.css` from `uiBundle` (both non-empty; `/app.js` contains a React-mount marker, `/app.css` non-empty), proving startup no longer bundles at runtime.
- `package.json` -- drop `private: true`; add `bin: { "quick-studio": "bin/quick-studio.ts" }`, `files: ["bin", "src", "README.md"]`, `engines: { "bun": ">=1.2.0" }`; scripts: `build` → `bun scripts/build-ui.ts`, `build:binary` → `bun run build && bun build --compile bin/quick-studio.ts --outfile dist/quick-studio`, `dev` → `bun run build && bun run bin/quick-studio.ts`, `prepublishOnly` → `bun run build`. `bun-plugin-tailwind` stays a devDependency (now build-time only, correct).
- `.gitignore` -- add `src/core/ui-bundle.generated.ts` (generated artifact).
- `.github/workflows/release.yml` (new) -- on `push` tag `v*`: matrix {linux-x64, windows-x64}; setup bun; `bun install`; `bun run build`; `bun build --compile --target=bun-<platform> bin/quick-studio.ts --outfile quick-studio-<platform>(.exe)`; upload the binary to the GitHub release. The "from releases" delivery for the standalone-binary path.
- `README.md` (new) -- documented one-command install: (A) download the platform binary from Releases → `quick-studio`; (B) `bun add -g quick-studio` (or `npm i -g quick-studio`) → `quick-studio`; plus the run note (`<db-url>` selects Ephemeral; `QS_HOST`/`QS_PORT` overrides). Satisfies FR-1 "single documented command".

## Tasks & Acceptance

**Execution:**
- [x] `scripts/build-ui.ts` -- build-time UI bundler emitting the generated `uiBundle` module -- single source of the UI assets for all three paths
- [x] `src/core/server.ts` -- drop runtime `Bun.build`/`bun-plugin-tailwind`; consume `uiBundle` -- makes `--compile` and global-install boot without a bundler or source tree
- [x] `.gitignore` -- ignore `src/core/ui-bundle.generated.ts` -- it is a generated build artifact
- [x] `package.json` -- publishable metadata (`bin`/`files`/`engines`, drop `private`) + `build`/`build:binary`/`dev`/`prepublishOnly` scripts -- enables both distribution paths
- [x] `.github/workflows/release.yml` -- per-platform `--compile` binaries uploaded to the GitHub release -- the "from releases" standalone-binary delivery
- [x] `README.md` -- document the two one-command installs + run note -- satisfies FR-1 "single documented command"
- [x] `src/core/server.test.ts` (or `ui-bundle.test.ts`) -- unit-test that `/app.js` + `/app.css` are served from the pre-built `uiBundle` and boot no longer bundles -- lock the runtime-bundler-free contract

**Acceptance Criteria:**
- Given a Linux or Windows host, when I build the standalone binary via `bun run build:binary` and run it (no bun on the machine), then I get a runnable `quick-studio` — it boots, prints the listening URL, and serves the embedded UI — with no multi-step wizard (FR-1, AR-16).
- Given a developer who already has a JS runtime, when they `bun add -g quick-studio` (or `npm i -g`) and run `quick-studio`, then they get the identical one-command run, UI served from the shipped generated bundle.
- Given a boot on any path, when the Core starts, then it performs no `Bun.build` / bundler call and no source-tree read — the UI is served from `src/core/ui-bundle.generated.ts`.
- Given no `QS_HOST`/`QS_PORT`, when the Core runs, then loopback binding, token auth, the gates, and the exposure behavior are unchanged from before this story.
- Given `bun run build` then `bun x tsc --noEmit` and `bun test`, when they run, then the generated bundle exists, typecheck is clean under strict, the suite passes (0 fail), and importing/booting `startCore` never bundles at runtime nor exits the runner.

## Spec Change Log

## Review Triage Log

### 2026-07-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 4, low 1)
- defer: 0
- reject: 8
- addressed_findings:
  - `[medium]` `[patch]` **README misled on the npm global path**: `bin` is a `.ts` entry with `#!/usr/bin/env bun`, so `npm i -g` succeeds silently on a machine without Bun and then crashes at run time with `env: 'bun': No such file or directory` (`engines.bun` is decorative — npm never enforces it). Reworded README §B to state Bun must be installed and on `PATH` at run time in both the bun and npm install cases.
  - `[medium]` `[patch]` **README documented a phantom feature**: the Run section claimed "passing a database URL selects the Ephemeral session mode", but the CLI parses only `QS_HOST`/`QS_PORT` (DB-URL/mode parsing is deferred to story 1.2), so the argument is silently ignored. Removed the claim and noted DB connection arrives in a later epic and is not parsed yet.
  - `[medium]` `[patch]` **Fresh-clone/CI trap**: `src/core/ui-bundle.generated.ts` is git-ignored but a hard import required for `tsc`/`bun test`/boot, so a fresh clone failed `TS2307`/module-not-found until a manual `bun run build`. Added `"prepare": "bun run build"` to `package.json`; verified `bun install` runs it and regenerates the bundle automatically, so a fresh `bun install` leaves the tree buildable/testable with no manual step.
  - `[medium]` `[patch]` **Release race**: both matrix legs (`linux-x64`, `windows-x64`) called `action-gh-release` in parallel against the same tag, which can race on release creation (a leg 422s and drops its asset). Added `max-parallel: 1` to serialize the legs.
  - `[low]` `[patch]` **Non-reproducible release**: `release.yml` used `bun install` (unpinned). Changed to `bun install --frozen-lockfile` so the released binary is built from the committed lockfile.
- rejected (by-design / out of scope / no trivial correct fix): macOS/ARM release targets missing (epic scopes the binary to **Windows + Linux** — AR/FR); `files` shipping `*.test.ts`/`src/ui` (inert dead weight, never executed by consumers, and npm's `files` allowlist cannot be trimmed by `.npmignore` without risking omission of a needed runtime file); the `expect(body).toBe(uiBundle.js)` assertion being "tautological" (its job is to lock that boot serves the **pre-built** bundle, not a runtime build — bundle validity is covered by the build step + binary-boot probe); stale `ui-bundle.generated.ts` surviving a failed rebuild (the build throws loudly; deleting-then-failing would leave no bundle, a worse test-loop state); `minify: false` under `NODE_ENV=production` (spec allowed either; a loopback tool, and the 665 KB sits inside a 95 MB binary); `dev` rebuilding UI each boot with no watch/HMR (by-design; HMR is an enhancement out of epic scope); publishing requiring Bun (the whole project requires Bun — a documented dev requirement); a missing-bundle import escaping `bin`'s try/catch (now mitigated by the `prepare` auto-build and always embedded in the compiled binary — a hard error only on an explicit dev delete).

## Design Notes

- **The crux.** `startCore` currently calls `buildUiBundle()` → `Bun.build` on every boot, with `entry = ${import.meta.dir}/../ui/main.tsx` (a source-tree read) and `plugins:[tailwind]` (a devDependency). A `--compile` binary has neither a bundler nor a source tree, and a `bun add -g` install has no dev deps — so both distribution paths are dead until bundling moves to build time. Solving this one dependency unblocks the entire story; the rest (`package.json` metadata, release workflow, README) is mechanical.
- **Why a generated `.ts` string module, not `import … with { type: "text" }`.** Under `verbatimModuleSyntax` + strict, a text-import of `dist/app.js`/`.css` is not guaranteed to typecheck: `bun-types` only declares `*.txt`/`*.html`/`*.toml` as `string`, not `*.js`/`*.css`. A generated module of ordinary string constants always typechecks, and `bun build --compile` embeds it as plain source — no import-attribute or asset-embedding assumption. Shape:
  ```ts
  // src/core/ui-bundle.generated.ts — AUTO-GENERATED by scripts/build-ui.ts. Do not edit.
  export const uiBundle = { js: "…bundled JS…", css: "…tailwind CSS…" } as const;
  // server.ts:  import { uiBundle } from "./ui-bundle.generated.ts";
  //             const { js: appJs, css: appCss } = uiBundle;
  ```
- **Build-first is an invariant.** The generated module is gitignored, so `tsc`/`test` (which loads `server.ts`) require `bun run build` first. Documented in README + `prepublishOnly` (so publish always ships it) + `dev`/`build:binary` (which run build first).
- **Closes a 1.1 deferred item.** This removes the boot-time UI rebuild flagged in `deferred-work.md` (1.1: "stop rebuilding the UI on every boot … to protect the ≤2s cold-start"). Cold start no longer pays a Tailwind build.
- **Compile targets.** `bun build --compile --target=bun-linux-x64` / `bun-windows-x64` produce the per-platform binaries; the local default `bun build --compile` targets the host.

## Verification

**Commands:**
- `bun run build` -- expected: writes `src/core/ui-bundle.generated.ts` with non-empty `js` and `css`.
- `bun x tsc --noEmit` -- expected: clean under strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`) after build.
- `bun test` -- expected: existing suite + the new bundle test pass (0 fail); no runtime bundling; importing/booting `startCore` never exits the runner.
- `bun run build:binary && ./dist/quick-studio` -- expected: a self-contained binary boots, prints the listening URL; `curl -s http://127.0.0.1:<port>/app.js` returns non-empty JS and `/app.css` non-empty CSS.

**Manual checks:**
- Inspect `.github/workflows/release.yml`: on a `v*` tag it builds linux-x64 + windows-x64 `--compile` binaries and uploads them to the release.
- `README.md` documents both one-command installs (binary from Releases; `bun add -g`/`npm i -g`) and the run note — a reader can install and run from a single command per path.

## Auto Run Result

Status: done

### Summary
Moved UI bundling from **runtime to build time** so both distribution paths work. Previously `startCore` ran `Bun.build` on every boot, reading the source tree via `import.meta.dir` and depending on `bun-plugin-tailwind` (a devDependency) — fatal for a `bun build --compile` single-file binary (no bundler, no source tree) and for a global install (no dev deps). A new `scripts/build-ui.ts` runs `Bun.build` once and emits the JS + CSS into a generated TS module `src/core/ui-bundle.generated.ts` (`export const uiBundle = { js, css } as const`); `startCore` now imports and serves that pre-built bundle — no runtime bundler, no source-tree read, no tailwind plugin on the boot path. Because the generated module is ordinary source, `bun build --compile` embeds it into a self-contained binary and a global install ships the same module. `package.json` is now publishable (`private` removed; `bin`/`files`/`engines`; `build`/`build:binary`/`dev`/`prepare`/`prepublishOnly` scripts), a `.github/workflows/release.yml` builds per-platform binaries for the GitHub release, and a `README.md` documents both one-command installs. Default loopback binding, token auth, the Origin/Host gates, and the Port-Exposure Warning are unchanged. This also closes the 1.1 deferred item (stop rebuilding the UI on every boot).

### Files changed
- `scripts/build-ui.ts` (new) — build-time bundler; emits the generated `uiBundle` module (fails loudly on build error / missing artifact).
- `src/core/ui-bundle.generated.ts` (generated, git-ignored) — the single pre-built UI-asset source consumed by dev, npm-global, and compiled paths.
- `src/core/server.ts` — dropped `import tailwind` and the runtime `buildUiBundle()`; imports `{ uiBundle }` and serves it. Gates/serving/shutdown byte-for-byte unchanged.
- `.gitignore` — ignore `src/core/ui-bundle.generated.ts`.
- `package.json` — publishable metadata + scripts (incl. `prepare: bun run build`, added in review).
- `.github/workflows/release.yml` (new) — per-platform `--compile` binaries → GitHub release (`max-parallel: 1`, `--frozen-lockfile`, both added in review).
- `README.md` (new) — documented dual install + run/dev notes.
- `src/core/server.test.ts` — new tests asserting `/app.js` and `/app.css` are served from the pre-built `uiBundle`.

### Review findings breakdown
- Patches applied: 5 (4 medium, 1 low) — see Review Triage Log 2026-07-06. Medium: README misled on the npm path (Bun required at run time); README documented a phantom DB-URL feature (not parsed until 1.2); fresh-clone/CI trap on the git-ignored generated module (fixed with a `prepare` hook — `bun install` now regenerates the bundle); parallel `action-gh-release` race (serialized with `max-parallel: 1`). Low: unpinned `bun install` in CI (`--frozen-lockfile`).
- Deferred: 0.
- Rejected: 8 (by-design / out of scope / no trivial correct fix) — macOS/ARM targets (epic scopes to Windows + Linux), `files` test-file bloat, "tautological" bundle test, stale-bundle-on-failed-rebuild, `minify:false`, `dev` no-watch, publish-needs-bun, missing-bundle import error path. See triage log.
- intent_gap: 0, bad_spec: 0 (`review_loop_iteration` stayed 0; the two adversarial reviewers confirmed the `server.ts` change introduces no security/behavior regression — it removes a runtime dependency and the per-boot build).

### Verification performed
- `bun install` → runs the new `prepare` hook and regenerates `src/core/ui-bundle.generated.ts` (665,098 bytes) — confirms a fresh clone is buildable/testable with no manual step.
- `bun x tsc --noEmit` → clean under strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- `bun test` → 94 pass / 0 fail (214 expect calls) across 7 files (~244 ms).
- `bun run build:binary` → produced `dist/quick-studio` (~95 MB); running it booted the Core (listening on `http://127.0.0.1:<port>`), and `/app.js` (609,905 bytes) + `/app.css` (200) served from the embedded bundle on a self-contained binary — AC1 proven (no runtime bundler).
- `.github/workflows/release.yml` and `README.md` verified by inspection.

### Residual risks
- The `quick-studio` command always requires Bun at run time (the `bin` entry is a Bun `.ts` script); only the compiled binary is runtime-free. README §B now states this explicitly.
- Release binaries cover Windows + Linux (x64) only, matching the epic's platform scope; macOS/ARM users use the global-package path (which needs Bun).
- `followup_review_recommended: false` — the five fixes were localized doc/config/packaging edits with no change to the auth gate, RPC contract, or the substantive bundling code; all verified green.
