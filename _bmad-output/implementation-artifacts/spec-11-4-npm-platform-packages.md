---
title: 'Per-platform npm binary packages and an end-to-end publish workflow'
type: 'feature'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.4
---

<intent-contract>

## Intent

**Problem:** With 11.3's shim in place, something has to actually contain the prebuilt binaries and get them onto the registry — and the repo's `package.json` is the wrong thing to publish. Its `files` allowlist (`package.json:9-13`) ships `bin`, `src`, and the README, meaning a consumer downloads the entire TypeScript source tree including every `*.test.ts` (Story 1.7's review acknowledged this as "inert dead weight" and rejected fixing it). Its `dependencies` block (`package.json:25-58`) lists 33 runtime dependencies — react, react-dom, tailwindcss, mysql2, postgres, three AI SDKs, CodeMirror, Radix — every one of which is **already compiled into the binary** and none of which a consumer needs; installing them globally would download hundreds of megabytes to run a self-contained executable. And its `prepare` hook (`package.json:21`) runs `bun run build`, which assumes a Bun toolchain the consumer may not have. Publishing this manifest verbatim would produce a package that is enormous, slow, and fragile.

**Approach:** Generate the published artifacts instead of publishing the repo. A `scripts/build-npm-packages.ts` takes the release binaries and emits, into a build directory: one package per platform, each containing only that platform's binary plus a **generated manifest** declaring `os` and `cpu` (so npm resolves exactly one of them onto any given machine); and a **generated manifest for the main package** containing only the 11.3 shim and the README, with **no `dependencies`**, no build scripts, and `optionalDependencies` naming every platform package at the exact same version.

**Naming is decided, not open:** the main package is **unscoped `quick-studio`** and the platform packages are **scoped `@quick-studio/<platform>-<arch>`** — `@quick-studio/win32-x64`, `@quick-studio/linux-x64`, `@quick-studio/linux-arm64`. This is the esbuild layout, and it is what keeps the product's one-command promise literal: `npx quick-studio <db-url>`. The `@quick-studio` **organization** owns the scope, so the entire `@quick-studio/*` namespace is reserved by the org rather than package by package. A `publish.yml` workflow, triggered on the same `v*` tag as the release, publishes every platform package first and the main package last.

## Boundaries & Constraints

**Always:**
- Publish order is **platform packages first, main package last**. The main package's `optionalDependencies` must already be resolvable at the moment it becomes installable; the reverse order leaves a window in which `npm i -g quick-studio` succeeds and then cannot find a binary.
- Every package in a release carries the **identical version**, taken from the tag — the main package's `optionalDependencies` pin exact versions (`"1.2.3"`, not `"^1.2.3"`), so a shim can never resolve a binary from a different build than the shim it shipped with.
- Each platform manifest sets `os` and `cpu` correctly, so npm installs exactly one and silently skips the rest — that skipping behavior is what makes `optionalDependencies` the right mechanism and is why a failure to install one must not fail the whole install.
- The platform set is **windows-x64, linux-x64, linux-arm64**, taken from the SAME shared list Story 11.2's matrix and Story 11.3's shim map consume. macOS is a later phase; when it lands, this script must need no edit beyond the list itself.
- Every scoped publish passes `--access public`. Scoped packages default to **restricted**, and a silently-private platform package breaks every install with a 404 that looks like a missing binary.
- The main manifest is **generated**, and carries: `bin` → the shim, `files` → the shim + README, `engines.node`, `optionalDependencies`, and **no** `dependencies`, `devDependencies`, `scripts.prepare`, or `scripts.prepublishOnly`.
- The binary inside each platform package keeps its **executable permission bit** on POSIX targets — npm preserves modes in the tarball, but the packaging script must set them, and 11.3's matrix flags a lost mode bit as a packaging-side bug.
- Publishing uses **npm Trusted Publishing (OIDC)** — no long-lived token exists anywhere. The workflow declares `permissions: { id-token: write, contents: read }` and the npm CLI mints a short-lived signed token per run. This is npm's own recommended path and it is not optional-by-preference: 2FA-bypass granular access tokens lose sensitive account operations in **August 2026** and lose direct-publish entirely around **January 2027**, so an `NPM_TOKEN`-based workflow would be built on a deprecated mechanism.
- Trusted publishing has hard environmental requirements the workflow must satisfy: **npm CLI >= 11.5.1**, **Node >= 22.14.0**, and a **GitHub-hosted runner** (self-hosted is unsupported). Pin these explicitly in the workflow rather than inheriting whatever the runner ships.

**Block If:**
- **The `@quick-studio` npm organization must exist before this story's publish step can run at all.** Scoped packages cannot be published into a scope with no owning org (or same-named user). This is an operator prerequisite, not something the loop can create — see `epic-11-manual-prereqs.md`. Implement and unit-test the packaging script regardless; only the live publish is gated on it. The scope string lives in **one constant**, never spread across the script.
- **A trusted publisher must be configured on npmjs.com for EACH of the four packages** (`quick-studio` plus the three `@quick-studio/*`), naming this repo and the exact workflow filename. Only one trusted publisher per package is allowed, and the filename must match exactly — so the workflow file must be named once and not renamed afterwards without reconfiguring all four. Another operator prerequisite.
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
| Packaging | three release binaries + a version | Three `@quick-studio/*` package dirs + one unscoped `quick-studio` dir, each with a generated manifest | Fails loudly on a missing binary or a missing version |
| Install on linux-x64 | `npm i -g quick-studio` | Only `@quick-studio/linux-x64` installs; the other two are skipped by `os`/`cpu` | Skips are silent and expected |
| npx one-liner | `npx -y quick-studio postgres://x` | Downloads main + one platform package, shim launches the binary, Ephemeral session boots | Documented that `-y` skips npx's install prompt |
| Update via npx | `npx quick-studio@latest` | npm resolves the newest version; npx's cache is bypassed by the explicit tag | Documented in the README |
| Publish order | tag `v0.1.0` with `NPM_TOKEN` | Three `@quick-studio/*` packages publish, then unscoped `quick-studio` | A failed platform leg aborts before the main package publishes |
| OIDC unavailable | workflow missing `id-token: write`, or run on a self-hosted runner | Publish fails clearly before any package is pushed | No partial publish; never fall back to a token |
| Trusted publisher not configured | a package with no trusted publisher registered on npmjs.com | That package's publish is rejected; the workflow stops | Operator prerequisite, surfaced as a clear failure |
| Scoped default visibility | first publish of `@quick-studio/linux-x64` | Published **public** via an explicit `--access public` | Without it the publish either fails or succeeds privately and breaks every install |
| macOS install attempt | `npm i -g quick-studio` on darwin | Main package installs; no platform package matches; the shim's message (11.3) names macOS as a later phase | Deliberate, documented gap |
| Re-publish of an existing version | tag re-pushed for an already-published version | npm rejects the duplicate version; the workflow surfaces it as a clear failure | Never force/unpublish |
| Executable bit | POSIX platform package | Installed binary is executable without a chmod by the user | Packaging sets the mode |
| Mixed-version resolution | main `1.2.3` with only `1.2.2` platform packages on the registry | Cannot occur — exact pins plus publish order — and if it somehow does, the shim's resolution failure message (11.3) is the safety net | Exact pins make this unreachable |

</intent-contract>

## Acceptance Criteria

- Given the release binaries, when the packaging script runs, then it emits one correctly-filtered `@quick-studio/*` package per platform plus a dependency-free unscoped `quick-studio` package whose `optionalDependencies` pin exact versions.
- Given a pushed `v*` tag with `NPM_TOKEN`, when the publish workflow runs, then every platform package publishes before the main package and all carry the tag's version.
- Given a machine with Node and no Bun, when a user runs `npx -y quick-studio <db-url>`, then quick-studio boots into an Ephemeral session — the epic's flow #1, end to end.
- Given the repo, when a developer runs `bun run dev`, `bun test`, and `bun run build:binary`, then all behave exactly as before.

## Code Map

- `scripts/build-npm-packages.ts` (new) — inputs: a directory of built binaries + a version string. Outputs a build tree of package directories with generated manifests. Holds the scope constant (`@quick-studio`) and the shared platform list, and sets POSIX executable bits. Fails loudly on any missing input.
- `.github/workflows/publish.yml` (new) — on `v*` tags: obtain the binaries (download the 11.2 release artifacts, or `needs:` the release workflow — step-02's call, and the two workflows must not race to build the same binaries twice), run the packaging script, then `npm publish --access public` on each platform package followed by the main package, authenticated by **OIDC trusted publishing** (`id-token: write`, npm CLI >= 11.5.1, Node >= 22.14.0). No `NPM_TOKEN` secret is read. Provenance attestation comes essentially free once `id-token: write` is present. **The filename `publish.yml` is load-bearing** — it is registered with npm per package; renaming it silently breaks every publish.
- `package.json` — unchanged as the development manifest, except for what 11.3 already changed. It is explicitly **not** the published artifact any more; add a short comment or README note so this is not re-discovered the hard way.
- `README.md` — restructure Install around npm as the primary channel (`npx -y quick-studio <db-url>` for a throwaway run, `npm i -g quick-studio` for a permanent one), with the standalone binary as the secondary channel. Delete the "requires Bun at run time" caveat that 1.7's review added — after this story it is false for the published package and true only for a git checkout.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] Encode the decided naming (unscoped `quick-studio` main + `@quick-studio/*` platform packages) as one scope constant + one shared platform list.
- [ ] Verify npm's `os`/`cpu` + `optionalDependencies` resolution behavior for the package managers in scope before building on it.
- [ ] Write `scripts/build-npm-packages.ts` (platform manifests, main manifest, executable bits, loud failures).
- [ ] Confirm the generated main manifest has no `dependencies` and no build scripts.
- [ ] Write `.github/workflows/publish.yml` with the strict publish order, `--access public` on every scoped publish, and OIDC trusted publishing (`id-token: write`, pinned npm/Node versions) — no token secret.
- [ ] Decide how publish obtains binaries without rebuilding them (artifact download vs workflow chaining).
- [ ] Dry-run the packaging locally (`npm pack` on each generated package; inspect tarball contents and sizes).
- [ ] Install-test from a local tarball on a Node-only machine, then verify `npx -y quick-studio <db-url>` end to end once published.
- [ ] Rewrite the README Install section around the npm-first channel.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

## Review Triage Log

<!-- populated by the review loop -->
