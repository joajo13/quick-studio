---
title: 'Per-platform npm binary packages and an end-to-end publish workflow'
type: 'feature'
created: '2026-07-21'
status: 'done'
baseline_revision: 'a9103c01fcd1ee7693237a9dc0b20b04b9ddf82a'
final_revision: 'eafb1700ca9944617527b61ec6ed1c8cbca1f42a'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.4
  - '{project-root}/_bmad-output/implementation-artifacts/spec-11-3-node-launcher-shim.md'  # shim resolution contract (DW-77)
  - '{project-root}/_bmad-output/planning-artifacts/epic-11-manual-prereqs.md'  # operator prerequisites (names, OIDC, tag)
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** With 11.3's shim in place, something has to actually contain the prebuilt binaries and get them onto the registry — and the repo's `package.json` is the wrong thing to publish. Its `files` allowlist (`package.json:9-13`) ships `bin`, `src`, and the README, meaning a consumer downloads the entire TypeScript source tree including every `*.test.ts` (Story 1.7's review acknowledged this as "inert dead weight" and rejected fixing it). Its `dependencies` block (`package.json:25-58`) lists 33 runtime dependencies — react, react-dom, tailwindcss, mysql2, postgres, three AI SDKs, CodeMirror, Radix — every one of which is **already compiled into the binary** and none of which a consumer needs; installing them globally would download hundreds of megabytes to run a self-contained executable. And its `prepare` hook (`package.json:21`) runs `bun run build`, which assumes a Bun toolchain the consumer may not have. Publishing this manifest verbatim would produce a package that is enormous, slow, and fragile.

**Approach:** Generate the published artifacts instead of publishing the repo. A `scripts/build-npm-packages.ts` takes the release binaries and emits, into a build directory: one package per platform, each containing only that platform's binary plus a **generated manifest** declaring `os` and `cpu` (so npm resolves exactly one of them onto any given machine); and a **generated manifest for the main package** containing only the 11.3 shim and the README, with **no `dependencies`**, no build scripts, and `optionalDependencies` naming every platform package at the exact same version.

**Naming is decided, not open:** everything is **unscoped**. The main package is `quick-studio` — which is what keeps the one-command promise literal, `npx quick-studio <db-url>` — and each platform package is `quick-studio-<platform>-<arch>`: `quick-studio-win32-x64`, `quick-studio-linux-x64`, `quick-studio-linux-arm64`. The `quick-studio` npm organization name was unavailable, and unscoped publishing needs no org and no `--access` handling. The tradeoff — an unscoped prefix reserves no namespace — is handled operationally by publishing placeholders for the future darwin names ahead of the macOS phase, not by anything this script does. A `publish.yml` workflow, triggered on the same `v*` tag as the release, publishes every platform package first and the main package last.

## Boundaries & Constraints

**Always:**
- Publish order is **platform packages first, main package last**. The main package's `optionalDependencies` must already be resolvable at the moment it becomes installable; the reverse order leaves a window in which `npm i -g quick-studio` succeeds and then cannot find a binary.
- Every package in a release carries the **identical version**, taken from the tag — the main package's `optionalDependencies` pin exact versions (`"1.2.3"`, not `"^1.2.3"`), so a shim can never resolve a binary from a different build than the shim it shipped with.
- Each platform manifest sets `os` and `cpu` correctly, so npm installs exactly one and silently skips the rest — that skipping behavior is what makes `optionalDependencies` the right mechanism and is why a failure to install one must not fail the whole install.
- The platform set is **windows-x64, linux-x64, linux-arm64**, taken from the SAME shared list Story 11.2's matrix and Story 11.3's shim map consume. macOS is a later phase; when it lands, this script must need no edit beyond the list itself.
- Unscoped packages are **public by default**, so no `--access` flag is required anywhere. (A concrete advantage of the unscoped layout: scoped packages default to *restricted*, and a silently-private platform package fails installs with a 404 that reads like a missing binary.)
- The main manifest is **generated**, and carries: `bin` → the shim, `files` → the shim + README, `engines.node`, `optionalDependencies`, and **no** `dependencies`, `devDependencies`, `scripts.prepare`, or `scripts.prepublishOnly`.
- The binary inside each platform package keeps its **executable permission bit** on POSIX targets — npm preserves modes in the tarball, but the packaging script must set them, and 11.3's matrix flags a lost mode bit as a packaging-side bug.
- Publishing uses **npm Trusted Publishing (OIDC)** — no long-lived token exists anywhere. The workflow declares `permissions: { id-token: write, contents: read }` and the npm CLI mints a short-lived signed token per run. This is npm's own recommended path and it is not optional-by-preference: 2FA-bypass granular access tokens lose sensitive account operations in **August 2026** and lose direct-publish entirely around **January 2027**, so an `NPM_TOKEN`-based workflow would be built on a deprecated mechanism.
- Trusted publishing has hard environmental requirements the workflow must satisfy: **npm CLI >= 11.5.1**, **Node >= 22.14.0**, and a **GitHub-hosted runner** (self-hosted is unsupported). Pin these explicitly in the workflow rather than inheriting whatever the runner ships.

**Block If:**
- **The package-name prefix lives in ONE constant** (`quick-studio-`), never spread across the script, so naming can be revisited later without a rewrite.
- **Every package needs one manual bootstrap publish before OIDC can ever be configured for it.** npm cannot publish a package's *first* version via trusted publishing — the trusted-publisher setting lives on the package's Settings page, which does not exist until the package does (`npm/cli` issue #8544). This is an operator prerequisite for all four names and is why placeholder `0.0.1` packages exist. CI must therefore never be expected to create a brand-new package name.
- **A trusted publisher must be configured on npmjs.com for EACH of the four packages** (`quick-studio` plus the three `quick-studio-<platform>-<arch>`), naming this repo and the exact workflow filename. Only one trusted publisher per package is allowed, and the filename must match exactly — so the workflow file must be named once and not renamed afterwards without reconfiguring all four. Another operator prerequisite.
- If npm's `os`/`cpu` filtering plus `optionalDependencies` cannot be made to install exactly one platform package under the package managers worth supporting (npm, and at minimum a documented statement about pnpm/yarn), HALT — the whole distribution design rests on this behavior.
- If the total unpacked size of a platform package (the Story 1.7 binary measured ~95 MB) exceeds npm's per-package limits, flag it for a decision (compression, or falling back to a postinstall download from Releases) rather than silently shipping something that cannot publish.

**Never:**
- Never publish the repo's `package.json` as-is, and never let the published main package carry runtime `dependencies` or a `prepare` script.
- Never publish the main package before its platform packages.
- Never use a range specifier for the `optionalDependencies` versions.
- Never make the platform packages contain product source — only the binary and its manifest.
- Never change the repo's own `package.json` in a way that breaks `bun run dev` / `bun test` / `bun run build:binary` for developers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Packaging | three release binaries + a version | Three `quick-studio-<platform>-<arch>` package dirs + one `quick-studio` dir, each with a generated manifest | Fails loudly on a missing binary or a missing version |
| Install on linux-x64 | `npm i -g quick-studio` | Only `quick-studio-linux-x64` installs; the other two are skipped by `os`/`cpu` | Skips are silent and expected |
| npx one-liner | `npx -y quick-studio postgres://x` | Downloads main + one platform package, shim launches the binary, Ephemeral session boots | Documented that `-y` skips npx's install prompt |
| Update via npx | `npx quick-studio@latest` | npm resolves the newest version; npx's cache is bypassed by the explicit tag | Documented in the README |
| Publish order | tag `v0.1.0` | Three `quick-studio-<platform>-<arch>` packages publish, then `quick-studio` | A failed platform leg aborts before the main package publishes |
| OIDC unavailable | workflow missing `id-token: write`, or run on a self-hosted runner | Publish fails clearly before any package is pushed | No partial publish; never fall back to a token |
| Trusted publisher not configured | a package with no trusted publisher registered on npmjs.com | That package's publish is rejected; the workflow stops | Operator prerequisite, surfaced as a clear failure |
| macOS install attempt | `npm i -g quick-studio` on darwin | Main package installs; no platform package matches; the shim's message (11.3) names macOS as a later phase | Deliberate, documented gap |
| Re-publish of an existing version | tag re-pushed for an already-published version | npm rejects the duplicate version; the workflow surfaces it as a clear failure | Never force/unpublish |
| Executable bit | POSIX platform package | Installed binary is executable without a chmod by the user | Packaging sets the mode |
| Mixed-version resolution | main `1.2.3` with only `1.2.2` platform packages on the registry | Cannot occur — exact pins plus publish order — and if it somehow does, the shim's resolution failure message (11.3) is the safety net | Exact pins make this unreachable |

</intent-contract>

## Acceptance Criteria

- Given a directory of the three release binaries and a version string, when `scripts/build-npm-packages.ts` runs, then it emits one `quick-studio-<platform>-<arch>` package per platform (correct `os`/`cpu`, binary at the package root with the POSIX exec bit set, no restrictive `exports`) plus a `quick-studio` package whose manifest has `bin`→the shim, `files`→[shim, README], `engines.node`, `optionalDependencies` pinning all three at the exact version, and **no** `dependencies`/`devDependencies`/`scripts.prepare`/`scripts.prepublishOnly`.
- Given a missing binary or an absent/blank version, when the packaging script runs, then it exits non-zero with a message naming what is missing, and emits no partial package tree.
- Given a published GitHub Release for a `v*` tag, when `publish.yml` runs, then it downloads that release's binaries (never rebuilding them), packages them, and publishes every platform package before the main package, all at the tag's version, authenticated by OIDC trusted publishing with **no `NPM_TOKEN` read anywhere**.
- Given a machine with Node and no Bun, when a user runs `npx -y quick-studio <db-url>`, then quick-studio boots into an Ephemeral session — the epic's flow #1, end to end (verified manually per the operator prerequisites; not loop-runnable).
- Given the repo, when a developer runs `bun run dev`, `bun test`, and `bun run build:binary`, then all behave exactly as before.

## Code Map

- `scripts/build-npm-packages.ts` (NEW) — exports `buildNpmPackages({ binariesDir, version, outDir, repoRoot })` (pure, unit-testable) and a `if (import.meta.main)` CLI wrapper reading `--binaries`, `--version`, `--out`. Holds the **one prefix constant** `PKG_PREFIX = "quick-studio-"` and the **shared platform table** (one row per platform: `{ key, os, cpu, asset }`, `pkg` derived as `PKG_PREFIX + key`). For each row: resolves the release asset from `binariesDir` (see the asset→package name mapping in Design Notes), copies it to `<outDir>/<pkg>/<binaryName>` (`quick-studio.exe` on win32, else `quick-studio`), `chmod 0o755` on POSIX rows, and writes `<outDir>/<pkg>/package.json` = generated platform manifest (`name`, `version`, `os:[os]`, `cpu:[cpu]`, `files:[binaryName]`, `description`; **no** `exports`, `bin`, `dependencies`, or `scripts`). Then writes `<outDir>/quick-studio/package.json` (generated main manifest) and copies `bin/quick-studio.cjs` + `README.md` from `repoRoot` into `<outDir>/quick-studio/`. Fails loudly (throws / non-zero exit) on any missing asset or missing/blank version. Reuses the same anchored-semver validation shape as `scripts/build-version.ts`.
- `scripts/build-npm-packages.test.ts` (NEW) — `bun:test`. Materializes a temp `binariesDir` with three fake binaries named per the release-asset convention, runs `buildNpmPackages`, and asserts the I/O-matrix "Packaging" + "Executable bit" rows: three platform dirs + main dir exist; each platform manifest has the right `name`/`version`/`os`/`cpu`, lists the binary in `files`, carries **no** `exports`/`bin`/`dependencies`; the binary sits at `<pkg>/quick-studio[.exe]` and (POSIX) has mode bits with owner-execute set; the main manifest has `bin.quick-studio` = the shim filename, `files` = [shim, README], `engines.node`, `optionalDependencies` = exact pins for all three at the version, and **absent** `dependencies`/`devDependencies`/`scripts.prepare`/`scripts.prepublishOnly`; and the loud-failure paths (missing binary, blank version) throw.
- `.github/workflows/publish.yml` (NEW) — `name: Publish`; trigger `on: release: { types: [published] }` (chains after `release.yml`, which creates the release for the `v*` tag — this is the binary-acquisition decision: no rebuild, no race with `release.yml` which is the sole builder). `permissions: { id-token: write, contents: read }`. Single job on `runs-on: ubuntu-latest` (GitHub-hosted): checkout; `actions/setup-node@v4` with `node-version: '22.14.0'` and `registry-url: 'https://registry.npmjs.org'`; `npm install -g npm@latest` then assert `npm --version` >= 11.5.1; derive `VERSION` from `${{ github.event.release.tag_name }}` stripped of a leading `v`; `gh release download "$TAG"` (using the built-in `GITHUB_TOKEN`) into a binaries dir; `bun scripts/build-npm-packages.ts --binaries <dir> --version "$VERSION" --out dist-npm`; then publish sequentially with `set -e` — each `quick-studio-<platform>-<arch>` (`npm publish dist-npm/<pkg>`) first, `quick-studio` last. No `--access` flag (unscoped = public). No `NPM_TOKEN`. Provenance attestation comes free once `id-token: write` is present. **The filename `publish.yml` is load-bearing** — it is registered with npm per package; renaming it silently breaks every publish.
- `package.json` — unchanged as the development manifest (the generated main manifest is the published artifact; add a one-line README/comment note so this is not re-discovered the hard way). Do NOT remove `prepare`/`prepublishOnly`/`dependencies` here — they serve dev; the published package simply isn't this file.
- `README.md` — restructure Install around npm as the primary channel (`npx -y quick-studio <db-url>` for a throwaway run, `npm i -g quick-studio` for a permanent one), standalone binary as secondary. **Delete** the "Requires Bun at run time" caveat (`README.md:38-41`) and the inline `# or (still requires Bun at run time)` comment (`README.md:45`) — false for the published package after this story, true only for a git checkout.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/build-npm-packages.ts` — NEW. Encode `PKG_PREFIX = "quick-studio-"` (the single prefix constant) and the shared platform table (rows `win32-x64`/`linux-x64`/`linux-arm64` with `os`/`cpu`/`asset`, matching Story 11.3's `SUPPORTED` keys exactly). Implement `buildNpmPackages(...)`: per-platform copy+`chmod`+generated manifest, generated main manifest, copy shim + README, loud failure on missing binary or blank version. Add the `import.meta.main` CLI wrapper. — The packaging engine; one prefix + one table so darwin is additive.
- [x] `scripts/build-npm-packages.ts` (manifest correctness) — Confirm in code that the generated main manifest has **no** `dependencies`, `devDependencies`, `scripts.prepare`, `scripts.prepublishOnly`, and that each platform manifest has **no** restrictive `exports` (DW-77) and places the binary at `<pkgroot>/quick-studio[.exe]` with the exec bit. — Satisfies the DW-77 cross-story contract the 11.3 shim resolution depends on.
- [x] `scripts/build-npm-packages.test.ts` — NEW `bun:test` exercising the packaging function end to end against fake binaries in a temp dir; assert every clause of AC #1 and AC #2 (structure, `os`/`cpu`, exec bit, `optionalDependencies` exact pins, absent dev fields, no `exports`, loud failures). — Locks the packaging contract in the suite (the only part loop-verifiable without npm credentials). _(10 tests, 60 expect() calls, all green.)_
- [x] `.github/workflows/publish.yml` — NEW. `on: release: [published]`, `permissions: { id-token: write, contents: read }`, pinned Node `22.14.0` + `npm@latest` (assert >= 11.5.1), GitHub-hosted runner, `gh release download` for binaries, run the packaging script, then strict publish order (platform packages, then main) via OIDC — no token, no `--access`. — The end-to-end publish path; filename is load-bearing.
- [x] `README.md` — Rewrite Install: npm-first (`npx -y quick-studio <db-url>` / `npm i -g quick-studio`), standalone binary secondary; delete the Bun-at-runtime caveat and inline comment. — After this story the published package needs no Bun; the old caveat is now false and actively misleading.
- [x] `package.json` / dev-note — Add a short note (README "Development" section or a top-level comment) that the published manifests are generated by `scripts/build-npm-packages.ts` and the repo `package.json` is the dev manifest, not the published artifact. — Prevents someone "fixing" the repo manifest or `npm publish`ing it directly (the DW-75 trap). _(README "Publishing note" in Development.)_
- [x] Verification pass — `bun x tsc --noEmit`, `bun test`, `bun run build`, `bun run build:binary`, `bun run dev` all behave as before; additionally `npm pack --dry-run` inspection of one generated platform package + the main package (tarball contents + size sanity vs the ~95 MB binary) as a documented manual check. _(tsc clean; suite 1600 pass/1 skip/0 fail; build + build:binary exit 0, dist/quick-studio ~108 MB; npm pack dry-run: platform pkg 2 files/298 B, main pkg 3 files/5.6 kB.)_

**Acceptance Criteria:**
- Given the packaging script and a version, when it runs against three fake binaries, then the generated tree and manifests match AC #1 exactly and the exec bit is set on POSIX binaries.
- Given a missing input binary or a blank version, when the packaging script runs, then it fails loudly with a non-zero exit and writes no partial tree (AC #2).
- Given `publish.yml`, when inspected, then it authenticates solely via OIDC (`id-token: write`, no `NPM_TOKEN`), pins npm >= 11.5.1 / Node >= 22.14.0 on a GitHub-hosted runner, obtains binaries by download (never rebuild), and publishes platform packages strictly before the main package.
- Given the repo after this story, when a developer runs `bun run dev` / `bun test` / `bun run build:binary`, then behavior is unchanged.

## Spec Change Log

## Review Triage Log

### 2026-07-23 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 4, low 3)
- defer: 4: (high 0, medium 1, low 3)
- reject: 9
- addressed_findings:
  - `[medium]` `[patch]` `.github/workflows/publish.yml` — a GitHub **prerelease** would publish to the `latest` dist-tag, serving a beta to every `npm i quick-studio`. Now maps `github.event.release.prerelease == true` → `npm publish --tag next`, stable → `latest`.
  - `[medium]` `[patch]` `.github/workflows/publish.yml` — the publish sequence was non-resumable: a transient failure after some platform packages published wedged the release (npm refuses a duplicate version; we never unpublish). Made it **idempotent** — each package is skipped if its exact version is already on the registry (`npm view <pkg>@<version>`), so a re-run completes the release. Preserves "never unpublish" and the strict platform-first/main-last order.
  - `[medium]` `[patch]` `.github/workflows/publish.yml` — `release: published` can fire before `release.yml` finishes attaching every asset, and `gh release download` exits 0 on a partial set. Added a bounded poll (6×20s) that requires all three expected binaries present before packaging, failing loudly if they never materialize.
  - `[medium]` `[patch]` `.github/workflows/publish.yml` — `npm install -g npm@latest` pulled a non-deterministic npm into a job holding publish creds and only floor-checked it. Pinned to `npm@11.5.1` (explicit, matching the contract's "pin these explicitly"), keeping the floor assert as a guard.
  - `[low]` `[patch]` `.github/workflows/publish.yml` — no `concurrency` guard: two release events could race the ordering. Added `concurrency: { group: publish-npm, cancel-in-progress: false }` to serialize publishes.
  - `[low]` `[patch]` `scripts/build-npm-packages.ts` — asset validation was `existsSync` only, so a zero-byte file (a failed download / saved error page) or a directory passed and shipped a broken binary or threw mid-emit. Now requires a **regular, non-empty file** in the pre-write validation (still no partial tree on failure); added zero-byte + directory tests.
  - `[low]` `[patch]` `scripts/build-npm-packages.ts` — a reused `outDir` could publish stale files from a prior run. Each managed package dir (and the main dir) is now cleared before writing; added a stale-file test. Suite 1600 → 1603 pass.

**Deferred (4):** DW-78 (SHA-pin third-party actions — extends the existing action-pinning concern to the new `publish.yml`, which is more sensitive as it holds `id-token: write`), DW-79 (verify downloaded binaries against Story 11.2's `SHA256SUMS` before publishing — the size>0 check is only partial cover), DW-80 (assert the downloaded binary's embedded `--version` equals the tag/package version), DW-81 (the published public package declares no `license` — the repo itself is unlicensed, so choosing one is an owner decision).

**Rejected (9):** `os`/`cpu` on the main manifest (contradicts the intent-contract's explicit "Main package installs on darwin" I/O row); README pnpm/yarn caveat (premise wrong — `os`/`cpu`-filtered `optionalDependencies` are honored by npm/pnpm/yarn alike, which is the design's basis); README db-url required/optional (the bare command is deliberately valid, Story 11.7); redundant `set -e` (Actions' default shell is already `-eo pipefail`); tarball-mode test (npm not reliably present in the Bun test env; on-disk mode is the testable surface); `--flag=value` equals form and unknown-arg rejection / CLI-entrypoint tests (internal script with a single fixed caller — disproportionate); `+build`-metadata version guard (implausible for a git tag; already semver-validated); `set -e` on the npm-install step (Actions already fails the step on a non-zero `npm install`).

### 2026-07-23 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 0, low 2)
- defer: 2: (high 0, medium 1, low 1)
- reject: 7
- addressed_findings:
  - `[low]` `[patch]` `.github/workflows/publish.yml` — the publish job had no `timeout-minutes`, and the `concurrency: publish-npm` guard never cancels in-progress runs. A hung `npm publish` / OIDC token exchange would sit on the serialized group until GitHub's 6h default and block every subsequent release behind it. Added `timeout-minutes: 20` to cap the job.
  - `[low]` `[patch]` `scripts/build-npm-packages.ts` — the copied source files (`bin/quick-studio.cjs`, `README.md`) were validated with `existsSync` only, while the binaries used a strict `statSync().isFile()` check. A directory at either source path would slip past `existsSync` and only fail mid-copy at `copyFileSync` — *after* the platform dirs were written — breaking the function's own "validate everything before writing anything / no partial tree" guarantee. Tightened the source validation to require a regular file in the pre-write block; dropped the now-unused `existsSync` import; added two tests (missing-shim, directory-as-README) asserting the loud pre-write failure. Suite 1603 → 1605 pass (packaging file 13 → 15).

**Deferred (2):** DW-82 (a GitHub prerelease later promoted to a full release never reaches the `latest` dist-tag — the workflow triggers only on `published`, not `released`, and the idempotency skip ignores dist-tags), DW-83 (the fixed 6×20s ≈ 2 min download-poll window may be too short for `release.yml`'s serial matrix, which can fire `release: published` while later legs still compile — a slow-but-not-missing release would fail and need a manual re-run; the correct fix depends on 11.2's final `release.yml` shape).

**Rejected (7):** the "arm64 never built" finding (real for today's pre-11.2 `release.yml`, but a **documented cross-story sequence** — the Design Notes and Cross-story notes already record that a full release only lands once 11.2 upgrades `release.yml`, the packaging script correctly fails loudly on the missing asset, and the epic sequences the first real `v*` tag after both stories land) and the paired README-lists-arm64 note; the `npm view` idempotency "wrongly skips a fresh version" claim (**verified empirically false** — `npm view <existing-pkg>@<absent-version>` exits **1**, so the guard correctly proceeds to publish); the `npm view` transient-network-blip concern (self-healing — a blip fails one step, a re-run skips correctly); the `+build`-metadata regex allowance (already rejected in the prior pass, and it deliberately mirrors `scripts/build-version.ts`); leading-zero semver acceptance (same mirror rationale; a git tag with a leading-zero identifier is implausible and npm rejects it at publish, fail-loud); repeated-CLI-flag silent overwrite (internal single-caller script — same disproportionate-hardening class the prior pass rejected).

## Design Notes

**Binary-acquisition decision (resolves the draft's open "artifact download vs workflow chaining" question).** `publish.yml` triggers on `release: [published]`, not on the `v*` tag directly. `release.yml` (the existing release workflow — today the *old* two-platform one; Story 11.2 upgrades it to the native three-platform matrix with `SHA256SUMS`) is the **sole builder** and owns the tag; it creates the GitHub Release and uploads the binaries. `publish.yml` then runs once, after the release exists, and pulls the assets with `gh release download "$TAG"`. This satisfies the intent-contract's "the two workflows must not race to build the same binaries twice" (only `release.yml` builds) and "consumes 11.2's release binaries" (downloads them). It does mean the end-to-end publish only produces a complete release once Story 11.2 has taught `release.yml` to emit all three assets (notably `linux-arm64`, absent from today's workflow) — a documented cross-story sequencing (the epic already mandates the first real `v*` tag be pushed only after both 11.2 and 11.4 land), not a decision this story can resolve. The packaging script correctly **fails loudly** if the arm64 asset is missing, which is the right behavior: an incomplete release must not publish.

**Release-asset → package name mapping (the token mismatch).** Two OS tokens differ by design: the npm *package* uses `win32` (from `process.platform`, so the shim's `require.resolve` matches), while the release *asset* Story 11.2/the existing `release.yml` produces is `quick-studio-windows-x64.exe`. The shared table therefore maps `key → asset` explicitly, it is not a string transform:
```
win32-x64   → asset "quick-studio-windows-x64.exe" → package "quick-studio-win32-x64",   binary "quick-studio.exe", os "win32", cpu "x64"
linux-x64   → asset "quick-studio-linux-x64"        → package "quick-studio-linux-x64",   binary "quick-studio",     os "linux", cpu "x64"
linux-arm64 → asset "quick-studio-linux-arm64"      → package "quick-studio-linux-arm64", binary "quick-studio",     os "linux", cpu "arm64"
```
The `binary` filename (`quick-studio`/`quick-studio.exe`) and its position at the package root are the **DW-77 contract** the 11.3 shim resolves against — not free variables.

**os/cpu + optionalDependencies is established, not speculative (resolves Block-If #4 without HALT).** This is the exact mechanism esbuild, `@swc/core`, Turborepo, and Rollup use to ship platform binaries: an `optionalDependencies` entry per platform, each with `os`/`cpu` fields; npm/pnpm/yarn all evaluate `os`/`cpu` and **silently skip** the non-matching optionals, materializing exactly one under `node_modules` reachable by the main package's `require.resolve`. npm and pnpm honor it directly; yarn (Berry) honors `os`/`cpu` on optionals as well. A live registry round-trip is an operator/manual step (needs published packages), so this is documented here and asserted structurally by the packaging test, not by a network test in the loop.

**Package size is within limits (resolves Block-If #5 without HALT).** The ~95 MB compiled binary is well under npm's registry limits (individual packages publish into the hundreds of MB; the practical ceiling is ~512 MB unpacked). No compression or postinstall-download fallback is needed. Noted so a future size regression re-triggers the decision rather than silently failing a publish.

**Publish authentication (OIDC only).** `setup-node` with `registry-url` writes an `.npmrc` that, combined with `id-token: write` and npm >= 11.5.1, lets `npm publish` mint a short-lived signed token per run — no secret is read. Unscoped packages are public by default so `--access public` is neither needed nor passed. The draft's AC that referenced `NPM_TOKEN` was a leftover contradiction with the OIDC design and has been corrected here.

## Verification

**Commands:**
- `bun x tsc --noEmit` — expected: no errors (the new `scripts/build-npm-packages.ts` + its `.test.ts` typecheck clean).
- `bun test` — expected: all green including `scripts/build-npm-packages.test.ts`; pre-existing suite unchanged.
- `bun run build` — expected: exit 0 (generators unaffected).
- `bun run build:binary` — expected: `dist/quick-studio` produced (the local binary that stages the packaging dry-run).
- `bun run dev` — expected: unchanged; still runs `bin/quick-studio.ts` via Bun.
- `bun scripts/build-npm-packages.ts --binaries <dir-with-fakes> --version 0.0.1 --out /tmp/qs-npm` then `npm pack --dry-run` inside one platform dir and the main dir — expected: platform tarball contains only the binary + manifest with the exec bit; main tarball contains only the shim + README + manifest with `optionalDependencies` exact pins and no runtime `dependencies`.

**Manual checks (operator, not loop — per epic-11-manual-prereqs.md):**
- On a Node-only (no Bun) machine, install from the locally packed tarballs and confirm `quick-studio <db-url>` launches; then, once the four packages are bootstrapped + trusted-publishers configured + a `v*` tag pushed, confirm `npx -y quick-studio <db-url>` boots an Ephemeral session end to end.

## Auto Run Result

Status: done

### Summary
Generated, rather than published-verbatim, the npm distribution artifacts. `scripts/build-npm-packages.ts` takes a directory of the three release binaries + a version and emits one `quick-studio-<platform>-<arch>` package per platform (each: only that platform's binary at the package root with the POSIX exec bit, plus a generated manifest declaring `os`/`cpu`, no restrictive `exports` per the DW-77 shim contract) and a dependency-free main `quick-studio` package (generated manifest: `bin`→the 11.3 shim, `files`→shim+README, `engines.node`, `optionalDependencies` pinning all three at the EXACT version, no runtime `dependencies` and no build scripts). `.github/workflows/publish.yml` chains after `release.yml` (`on: release: published`), downloads the release binaries (never rebuilds), packages them, and publishes every platform package before the main package via **OIDC Trusted Publishing** — no `NPM_TOKEN` anywhere. The README Install section was rewritten npm-first and the false "requires Bun at run time" caveat removed. The repo's own `package.json` is untouched as the development manifest.

### Files changed
- `scripts/build-npm-packages.ts` (new) — the packaging engine: one `PKG_PREFIX` constant + one shared platform table (`key`/`os`/`cpu`/`asset`, mapping the `windows`→`win32` token mismatch explicitly), `buildNpmPackages(...)` pure function + `import.meta.main` CLI. Validates all inputs (semver + every asset is a regular non-empty file) before writing, clears managed dirs to avoid stale publishes, sets POSIX exec bits, and fails loudly with no partial tree.
- `scripts/build-npm-packages.test.ts` (new) — hermetic `bun:test` (13 tests, 68 expect()): structure, `os`/`cpu`, exec bit, exact `optionalDependencies` pins, absent dev fields, no `exports`, and loud-failure paths (blank/non-semver version, missing/zero-byte/directory asset, stale-dir cleanup).
- `.github/workflows/publish.yml` (new) — `on: release: published`, `permissions: { id-token: write, contents: read }`, `concurrency` guard, pinned Node 22.14.0 + npm 11.5.1, asset-presence-polling `gh release download`, packaging, then idempotent strict-order publish (prerelease→`--tag next`). OIDC only; filename is load-bearing.
- `README.md` — Install rewritten npm-first (`npx -y quick-studio <db-url>` / `npm i -g quick-studio`), standalone binary secondary; Bun-at-runtime caveat deleted; a "Publishing note" in Development records that the published manifests are generated and the repo manifest is dev-only.
- `_bmad-output/implementation-artifacts/deferred-work.md` — appended DW-78..81.

### Review findings breakdown
- Patches applied (7 — medium 4, low 3): prerelease→`next` dist-tag; idempotent (skip-if-published) publish for re-runnable recovery; asset-presence polling to tolerate the `published`-before-upload race; npm pinned (no `@latest`); `concurrency` guard; asset validation requires a regular non-empty file; managed dirs cleared to prevent stale publishes.
- Deferred (4): DW-78 (SHA-pin actions in the `id-token` job), DW-79 (verify binaries against 11.2's `SHA256SUMS`), DW-80 (assert tag == binary's embedded version), DW-81 (public package has no `license` — owner decision).
- Rejected (9): `os`/`cpu` on main (contradicts the "installs on darwin" contract row), README pnpm/yarn caveat (premise wrong), db-url required (bare cmd valid per 11.7), redundant `set -e` ×2, tarball-mode test (npm unavailable in-env), CLI `=`/unknown-arg hardening (internal single-caller), `+build`-metadata guard (implausible tag).

### Verification
- `bun x tsc --noEmit` — clean (exit 0).
- `bun test` — **1603 pass, 1 skip, 0 fail** (80 files); the packaging file: 13 pass. The 11.3 shim tests spawn `node` (absent in this WSL env) and were run under a temporary `node → bun` alias, as 11.3 documented.
- `bun run build` — exit 0; `bun run build:binary` — exit 0, `dist/quick-studio` (~108 MB) produced; `bun run dev` unchanged.
- `publish.yml` parses as valid YAML; a smoke run of the packaging script produced the correct three-platform + main tree with exec bits and exact pins; `npm pack --dry-run` (from earlier): platform pkg ~2 files, main pkg ~3 files.
- `git diff` scope: `README.md`, three new files (`scripts/build-npm-packages.ts` + test, `.github/workflows/publish.yml`), the spec, and the ledger append. `package.json`, `bin/**`, `src/**` untouched.

### Cross-story notes
- **DW-77 is satisfied by this implementation**: platform manifests carry no restrictive `exports`, the binary sits at `<pkgroot>/quick-studio[.exe]`, and the POSIX exec bit is set — all asserted by the packaging test. (Ledger entry left as-is per the append-only rule; sweep can close it.)
- The complete end-to-end publish only produces a full release once Story 11.2 upgrades `release.yml` to emit the `linux-arm64` asset (today's workflow ships only x64 for both platforms); the packaging script correctly fails loudly on a missing arm64 binary. The epic already sequences the first real `v*` tag after both 11.2 and 11.4 land.

### Residual risks
- `publish.yml` cannot be exercised end to end in the loop (no npm credentials, no trusted publishers, `release.yml` pre-11.2). Its patched shell semantics (idempotent skip, prerelease routing, asset polling) are reviewed and declaratively sound but unrun — hence `followup_review_recommended: true`.
- Operator prerequisites gate real verification (npm login + 2FA, four bootstrap publishes, per-package trusted publishers on `publish.yml`, git remote, first `v*` tag) — documented in `epic-11-manual-prereqs.md`, out of loop scope.
- Deferred hardening (DW-78 action SHA-pinning in the OIDC job, DW-79 checksum verification) leaves the supply-chain surface thinner than ideal until those land.

### Follow-up review pass — 2026-07-23

An independent follow-up review (Blind Hunter + Edge Case Hunter, both at session capability) re-examined the story. It converged with two low-severity patches and no spec-level or intent issues.

**Patches applied (2, both low):**
- `.github/workflows/publish.yml` — added `timeout-minutes: 20` to the publish job so a hung `npm publish` / OIDC exchange can't hold the serialized `publish-npm` concurrency group until GitHub's 6h default and block subsequent releases.
- `scripts/build-npm-packages.ts` — tightened the copied-source validation (`bin/quick-studio.cjs`, `README.md`) from `existsSync` to a strict `statSync().isFile()` check in the pre-write block, so a directory at either path fails loudly *before* any package dir is written (upholding the "no partial tree" invariant, previously enforced for binaries only). Dropped the now-unused `existsSync` import; added two tests (missing-shim, directory-as-README). Packaging tests 13 → 15; full suite 1603 → 1605 pass.

**Deferred (2):** DW-82 (prerelease→full-release promotion never reaches the `latest` dist-tag — the workflow listens only to `published`, not `released`, and the idempotency skip ignores dist-tags; the fix touches trigger semantics + an unverified-in-loop OIDC dist-tag capability, and the whole prerelease path is speculative pre-v0.1.0), DW-83 (the fixed ~2 min download-poll window may be too short for 11.2's serial `release.yml` matrix; correct tuning depends on 11.2's final shape).

**Rejected (7):** the "arm64 never built" finding + its README pair (a documented cross-story sequence already recorded in Design/Cross-story notes — the packaging script correctly fails loudly, and the epic sequences the first `v*` tag after both 11.2 and 11.4 land); the `npm view` idempotency "wrongly skips a fresh version" claim (**verified empirically false**: `npm view <existing-pkg>@<absent-version>` exits 1, so the guard proceeds to publish correctly); the transient-network-blip variant (self-healing on re-run); the `+build`-metadata regex (already rejected, deliberately mirrors `build-version.ts`); leading-zero semver (same mirror rationale, npm rejects at publish); repeated-CLI-flag overwrite (internal single-caller — disproportionate hardening).

**Verification (follow-up):** `bun x tsc --noEmit` clean; `bun test` 1605 pass / 1 skip / 0 fail (the 9 shim tests that spawn `node` pass under the documented `node → bun` alias — they fail only when `node` is absent from the shell `PATH`, an environment artifact, not a regression); packaging file 15/15; `publish.yml` parses as valid YAML with `timeout-minutes: 20` in place. `bun run build` / `build:binary` not re-run — untouched (`src/`, `package.json`, build config unchanged). No follow-up review recommended: two localized low-consequence fixes in a not-yet-runnable CI workflow / a well-tested script.
