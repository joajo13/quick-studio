---
title: 'Release matrix on native runners with SHA256SUMS and a compiled-binary keyring gate'
type: 'feature'
created: '2026-07-21'
status: 'done'
baseline_revision: '4de326e5919c745126bd81b1b00f22ecf7969f8e'
final_revision: 'd453c603d3423b88ebfff84d682754b79edbe875'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.2
  - '{project-root}/docs/keyring-spike-decision.md'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** `.github/workflows/release.yml` builds exactly two artifacts — `bun-linux-x64` and `bun-windows-x64` — both on a single `ubuntu-latest` runner, with `max-parallel: 1`. Three things are wrong with that as the substrate for a distribution epic. (1) **Coverage:** no ARM at all, so a Linux ARM box has nothing to run. (2) **Cross-compilation risk:** the windows leg already cross-compiles from ubuntu via `--target=bun-windows-x64`. `@napi-rs/keyring` is a **native NAPI addon** whose platform-specific `.node` binding is selected from optional dependencies; the spike proved the addon embeds and loads from a `--compile` binary **only on Linux, built on Linux** ("observed locally"), and explicitly records Windows and macOS as *pending CI, expected GO*. A cross-compiled binary that silently embeds the host's `.node` — or none — produces a binary that boots but cannot reach the OS keychain, degrading every user to the passphrase path with no signal. That is exactly what the shipped windows binary risks today. (3) **Verifiability:** the release publishes bare binaries with no checksum file, so no installer, script, or human can verify a download.

Separately, `docs/keyring-spike-decision.md` asserts that "the product ships darwin binaries (`bun.lock` carries every `@napi-rs/keyring-darwin-*` artifact)". It does not, and this epic does not start: **macOS is a later phase** (see Boundaries). The doc's claim is false today and this story corrects it rather than perpetuating it.

**Approach:** Rebuild the release matrix around **native runners, one per target**, driven by a single platform list, and gate each leg on the compiled-binary keyring check that already exists from the spike:
- `windows-latest` → windows-x64; `ubuntu-latest` → linux-x64; `ubuntu-24.04-arm` → linux-arm64.
- Each leg compiles with `bun build --compile` **for its own host** (no `--target` cross-compile), then runs `scripts/keyring-native-check.ts` compiled the same way, as a **required gate**.
- A final job collects every artifact, emits `SHA256SUMS`, and uploads binaries + checksums to the release in one place — which also retires the `max-parallel: 1` race workaround, since only one job now touches the release.
- The platform list is **data**, structured so the later macOS phase adds `macos-latest` → darwin-arm64 (and optionally `macos-13` → darwin-x64) as new rows, with no workflow restructuring and no change to the shim or packaging logic that consumes the same list.

## Boundaries & Constraints

**Always:**
- Every published binary is compiled **on a runner whose OS and architecture match its target**. This is the whole point of the story — the native addon is the reason.
- Every leg runs the compiled-binary keyring check as a **gate**: the leg fails and its binary is not published if the native addon cannot load from the compiled binary. On a runner with no usable keychain backend (headless Linux with no Secret Service), the gate's pass condition is the spike's own classification — a typed `unavailable` is a **pass** (the addon loaded; there is simply no backend), while a failure to load the addon at all is a **fail**. Encoding that distinction correctly is the crux of this story.
- `bun install --frozen-lockfile` on every leg (already the case at `release.yml:33`), so a release is reproducible from the committed lockfile.
- `SHA256SUMS` covers every published binary, in the standard `<hash>  <filename>` format that `sha256sum -c` accepts.
- The release upload happens from **one job**, after all build legs succeed — a partial release (some platforms present, others silently missing because a leg failed) must not be publishable.
- `docs/keyring-spike-decision.md` is updated to state the platforms actually shipped and to record each leg's real go/no-go — the spike doc is the AR-20 risk register and it currently overstates coverage.

- **macOS is out of scope for this story and must stay out.** The platform list covers windows-x64, linux-x64, and linux-arm64. Do not add a darwin leg "since it is only one more row" — the point of deferring is that darwin's keychain path has never been validated, and a published darwin binary implies a promise this project cannot yet keep.
- The platform list is defined **once** and consumed by the matrix, by 11.3's shim map, and by 11.4's packaging script. A later macOS phase must be a data change: add the rows, let the keyring gate prove the leg, publish. If implementing this story would hard-code the platform set into three separate places, restructure before shipping.

**Block If:**
- If the keyring gate cannot distinguish "addon failed to load" (a real failure) from "no keychain backend on this runner" (an expected pass on headless CI) without new product code, HALT and flag it — a gate that fails on the benign case will block every release, and a gate that passes on the real case is worse than no gate.
- If `ubuntu-24.04-arm` is not available to this repository's plan, drop linux-arm64 from the matrix and record it explicitly in the README, rather than cross-compiling it from x64.

**Never:**
- Never cross-compile a target whose native addon binding differs from the build host — this is the specific failure mode the story exists to prevent.
- Never publish a binary whose keyring gate did not run or did not pass.
- Never change the product's runtime behavior. This story touches CI workflow files, the checksum artifact, and documentation only — no `src/` change is expected. If one appears necessary (e.g. to make the gate classifiable), it must be flagged in step-02 rather than smuggled in.
- Never leave `docs/keyring-spike-decision.md` claiming coverage the matrix does not produce.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full release | push tag `v0.1.0` | Three binaries (windows-x64, linux-x64, linux-arm64) + `SHA256SUMS` attached to the release for `v0.1.0` | none |
| Native compile per leg | each matrix leg | `bun build --compile` with **no** `--target` flag (host-native); outfile named `quick-studio-<os>-<arch>`, `.exe` on windows | Leg fails loudly on a build error |
| Keyring gate, keychain present | windows leg (Credential Manager) | `keyring-native-check` compiled binary round-trips set/get/delete → leg passes | none |
| Keyring gate, headless linux | ubuntu leg, no Secret Service | Addon **loads**, backend reports `unavailable` → leg **passes** (this is the spike's documented first-class outcome) | Must not be treated as a failure |
| Keyring gate, addon missing | a leg where the `.node` binding did not embed | Leg **fails**, release does not publish that platform | Loud failure naming the platform |
| One leg fails | linux-arm64 build breaks | No release assets are uploaded at all — the collect-and-upload job does not run | Partial release is impossible |
| Checksum verification | `sha256sum -c SHA256SUMS` in the release dir | All lines OK | n/a |
| Re-run of a tag | workflow re-run for an existing tag | Assets replaced/uploaded without the create-release race that `max-parallel: 1` worked around | Single uploading job removes the race by construction |
| Windows artifact naming | windows-latest leg | `quick-studio-windows-x64.exe`, matching today's asset name so the README's existing instructions stay true | none |
| macOS requested | a user on darwin | No asset published; README states macOS is a later phase and points at the npm/binary status | Deliberate gap, documented — never a silently missing platform |

</intent-contract>

## Code Map

- `scripts/platforms.ts` — **NEW.** The single platform table. Dependency-free (no imports), so the matrix-generation job can run it after `checkout` + `setup-bun` with **no** `bun install`. Exports `PlatformRow` and `PLATFORMS`; doubles as a CLI with two modes (see Design Notes).
- `scripts/build-npm-packages.ts:57-73` — delete the local `PlatformRow` interface and `PLATFORMS` const (and the "THE authoritative mapping" header comment, which is currently a lie) and import both from `./platforms.ts`. Everything downstream (`PKG_PREFIX + row.key`, `binaryNameFor(row.os)`, asset lookup by `row.asset`) is unchanged — the row shape gains one field (`runner`) and loses nothing.
- `.github/workflows/release.yml` — full rewrite into three jobs: `platforms` (emits the matrix JSON), `build` (matrix over native runners), `release` (collect → `SHA256SUMS` → single upload). Current file: `max-parallel: 1` + comment at `:15-18`, two-entry `include` at `:19-24`, per-leg `softprops/action-gh-release@v2` at the end.
- `.github/workflows/publish.yml:66-89` — the download-poll step hard-codes the same three asset filenames a fourth time (`:78-80`). Derive them from `scripts/platforms.ts --assets` so a future darwin row propagates here too. The polling structure, sleep, attempt count and failure dump stay exactly as they are.
- `bin/quick-studio.cjs:22-26` (`SUPPORTED`) and `:56` (the human-readable platform list) — **left as-is on purpose**: the shim is dependency-free CommonJS shipped standalone and must not import a TS module. Drift is caught by a test instead.
- `bin/quick-studio-shim.test.ts` — add the drift guard that makes the shim a real consumer of the shared list.
- `scripts/keyring-native-check.ts` — **no change needed.** Investigation confirmed the exit-code contract the Block-If asks about already exists (see Design Notes); the gate reuses it verbatim.
- `docs/keyring-spike-decision.md:21-26` (summary table), `:6` (AR-20 status), `:28` (the false "product ships darwin binaries" claim).
- `README.md:42-63` — the Standalone-binary section lists only two assets and no checksum; `:87-88` already forward-references verifying against `SHA256SUMS`, a file nothing produces yet.

## Tasks & Acceptance

**Execution:**

- [x] `scripts/platforms.ts` — NEW. Export `interface PlatformRow { key; os; cpu; asset; runner }` (keep the existing four field docs verbatim from `build-npm-packages.ts:58-67`, add `runner` = "GitHub Actions `runs-on` label; the binary MUST be compiled on a host matching `os`/`cpu`") and `export const PLATFORMS: readonly PlatformRow[]` with the three current rows plus `runner`: `win32-x64` → `windows-latest`, `linux-x64` → `ubuntu-latest`, `linux-arm64` → `ubuntu-24.04-arm`. No imports at all. Add an `import.meta.main` CLI block supporting exactly two flags: `--github-matrix` prints **one line** of compact JSON (`JSON.stringify` of the rows, no indentation) for `fromJSON`; `--assets` prints `row.asset` one per line in table order. Any other/absent argument → write a usage line to stderr and `process.exit(1)`. — One table, three consumers; the CLI modes exist because a GitHub Actions matrix and a bash loop cannot `import` TypeScript.
- [x] `scripts/platforms.test.ts` — NEW. Assert: every row's `key` is `${os}-${cpu}`; `asset` filenames are unique and exactly the three current names (windows uses the `windows` token and `.exe`, not `win32` — the deliberate mismatch documented in `build-npm-packages.ts`); the **cross-compile guard, as data** — for every row, `runner.startsWith("windows")` iff `os === "win32"`, `runner.startsWith("ubuntu")` iff `os === "linux"`, and `cpu === "arm64"` iff the runner label contains `arm` (so no arm64 row can ever point at an x64 runner, and vice versa); no `darwin`/`macos` row exists (the macOS boundary, enforced not just documented); `--github-matrix` output is single-line, `JSON.parse`s back to `PLATFORMS`; `--assets` output is the assets in table order. — This is the unit-testable core of the I/O matrix; every other row is CI-runtime behavior.
- [x] `scripts/build-npm-packages.ts` — replace the local `PlatformRow`/`PLATFORMS` (`:57-73`) with `import { PLATFORMS, type PlatformRow } from "./platforms.ts";`, keeping the surrounding comment's *intent* (adding macOS = adding rows) but pointing at the new file. Change nothing else. — `scripts/build-npm-packages.test.ts` must pass **unmodified**; it is the regression contract for 11.4.
- [x] `bin/quick-studio-shim.test.ts` — ADD a `describe("platform-list drift")` block importing `PLATFORMS` from `../scripts/platforms.ts`. The shim must be asserted **as text**: it does not export `SUPPORTED` (`bin/quick-studio.cjs:22` is a bare `const`) and `require()`ing it would execute the launcher. So `readFileSync(SHIM, "utf8")`, slice the `const SUPPORTED = { … };` literal, extract pairs with `/"([^"]+)":\s*"([^"]+)"/g`, and assert the resulting map deep-equals `Object.fromEntries(PLATFORMS.map(r => [r.key, "quick-studio-" + r.key]))` — deep-equality catches an **extra** shim entry as well as a missing one. Also assert the human-readable list at `:56` contains every row's display name, derived as `row.asset.replace(/^quick-studio-/, "").replace(/\.exe$/, "")` (→ `windows-x64`, `linux-x64`, `linux-arm64` — note this is the *asset* token, not the `key`). Additionally replace the two remaining hardcoded copies **in this test file** with `PLATFORMS`-derived values: the `SUPPORTED_HERE` literal at `:24` and the `toContain("windows-x64, linux-x64, linux-arm64")` at `:187`. Every existing case's *behavior* stays identical — only those two literals change. — The shim cannot import the table; this test is what makes it a consumer rather than a sixth copy.
- [x] `.github/workflows/release.yml` — rewrite (see Design Notes for the job skeleton). Job `platforms`: checkout + `setup-bun` + `id: gen` step doing `echo "matrix=$(bun scripts/platforms.ts --github-matrix)" >> "$GITHUB_OUTPUT"`, exposed as `outputs.matrix`. Job `build`: `needs: platforms`, `strategy.matrix.include: ${{ fromJSON(needs.platforms.outputs.matrix) }}`, `runs-on: ${{ matrix.runner }}`, `defaults.run.shell: bash` (Windows defaults to pwsh; the spike already forces bash for the same reason), steps = checkout → `setup-bun` → `bun install --frozen-lockfile` → `bun run build` → compile `bun build --compile bin/quick-studio.ts --outfile ${{ matrix.asset }}` (**no `--target`**) → keyring gate → `actions/upload-artifact@v4` with `name: binary-${{ matrix.key }}`, `path: ${{ matrix.asset }}`, `if-no-files-found: error`, `retention-days: 1`. Job `release`: `needs: build`, `runs-on: ubuntu-latest`, `permissions: contents: write`, steps = checkout → `setup-bun` → `actions/download-artifact@v4` (`path: dist`, `pattern: binary-*`, `merge-multiple: true`) → the assert-and-checksum step → `softprops/action-gh-release@v2` with `files: dist/*` and `fail_on_unmatched_files: true`. Set workflow-level `permissions: contents: read` so only the `release` job can write. Delete `max-parallel: 1` and its comment. — Native compilation per leg is the story; the single upload job is what makes a partial release structurally impossible and retires the race workaround.
- [x] `.github/workflows/release.yml` (keyring gate step, in `build`) — name it so a failure names the platform (e.g. `Keyring gate (${{ matrix.key }}) — native addon must load from the compiled binary`), `set -euo pipefail`, then `bun build --compile scripts/keyring-native-check.ts --outfile keyring-native-check` followed by `./keyring-native-check`. Do **not** set `KEYRING_REQUIRE_ROUNDTRIP` and do **not** provision gnome-keyring/dbus (rationale in Design Notes). — Default mode is exactly the pass/fail split the contract demands: addon-load failure → exit 1, `unavailable` → exit 0.
- [x] `.github/workflows/release.yml` (checksum step, in `release`) — `set -euo pipefail`, `cd dist`, `mapfile -t ASSETS < <(bun ../scripts/platforms.ts --assets)`, fail with a named message on any `[ ! -s "$a" ]`, then `sha256sum "${ASSETS[@]}" > SHA256SUMS` and `cat SHA256SUMS` into the log. — Explicit array order makes `SHA256SUMS` deterministic (a glob is locale-ordered) and the emptiness assert turns a mis-merged artifact download into a loud failure instead of a short release.
- [x] `.github/workflows/publish.yml` — in the download-poll step, replace the three hard-coded `[ -s bin-dl/... ]` checks (`:78-80`) with `mapfile -t REQUIRED < <(bun scripts/platforms.ts --assets)` (once, before the loop) and a per-attempt loop that sets an `ok` flag over `[ -s "bin-dl/$a" ]`. Keep the attempt count, the 20s sleep, the `rm -rf bin-dl` + `gh release download ... || true`, and the final `ls -la` failure dump byte-identical. — Fourth copy of the platform list, removed; nothing else about 11.4's publish behavior changes.
- [x] `docs/keyring-spike-decision.md` — in the summary table (`:21-26`) replace "Not run — delegated to CI / Pending CI (expected GO)" for **Windows** with the shipped reality: the release matrix compiles windows-x64 natively and gates every release on the compiled-binary addon-load check. Leave **macOS** as pending and add, in the same row or a note, that **no darwin binary is published**. Rewrite the false clause at `:28`: `bun.lock` *does* carry every `@napi-rs/keyring-darwin-*` artifact (true, `bun.lock:100-104`), but the product **does not ship darwin binaries** — the `macos-latest` spike leg validates the addon on darwin, not a shipped product path. Update the AR-20 paragraph (`:6`) to state that per-release addon-load attestation now exists for the three shipped platforms via `release.yml`, while round-trip attestation remains `keyring-spike.yml`'s job and macOS remains unshipped. — The doc is the AR-20 risk register; overstating coverage is the specific defect.
- [x] `README.md` — in the Standalone-binary section (`:42-63`) list all three assets (`quick-studio-windows-x64.exe`, `quick-studio-linux-x64`, `quick-studio-linux-arm64`) plus `SHA256SUMS`, add a verification snippet (`sha256sum -c SHA256SUMS` on Linux; `certutil -hashfile quick-studio-windows-x64.exe SHA256` compared against the file on Windows), and state plainly that macOS is a later phase — matching the wording already at `:38-40`. — `:87-88` already tells users to verify against `SHA256SUMS`; this story is what makes that instruction true.

**Acceptance Criteria:**
- Given a pushed `v*` tag, when the workflow completes, then windows-x64, linux-x64, and linux-arm64 binaries plus `SHA256SUMS` are attached to the release, and every binary was compiled on a runner matching its own os/arch.
- Given the platform list, when a macOS row is added to `scripts/platforms.ts`, then the matrix, the packaging script, and `publish.yml`'s asset check all pick it up with no other edit, and `bin/quick-studio-shim.test.ts` fails until the shim's `SUPPORTED` map is updated to match.
- Given any failing build leg, when the workflow finishes, then the `release` job never runs and no asset is published — a release is all-or-nothing.
- Given the existing test suites, when `bun test` runs, then every pre-existing case still passes: `scripts/build-npm-packages.test.ts` is byte-unchanged, and `bin/quick-studio-shim.test.ts` changes only by the added drift block plus the two hardcoded platform literals (`:24`, `:187`) becoming `PLATFORMS`-derived — no case's behavior or assertion strength is altered.
- Given `docs/keyring-spike-decision.md`, when the story is done, then no sentence claims a darwin binary is shipped and the platform table matches the matrix that exists.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

**Implementation note (no spec deviation).** `bun test` in this dev environment reports 9 pre-existing failures, all in `bin/quick-studio-shim.test.ts`, all `Executable not found in $PATH: "node"` — this box has no `node` binary at all (only `bun`), which spawn-based shim tests require. This is unrelated to this story's changes: the same 9 cases fail identically on a clean checkout before any Story 11.2 edit, and none of the newly-added/modified assertions (the `platform-list drift` block, the two literal-derivation changes, or `scripts/platforms.test.ts`) are among the failures. All 1757 other tests (including the new `scripts/platforms.test.ts` suite and the drift-guard tests) pass. `scripts/build-npm-packages.test.ts` remains byte-unchanged (verified via `git diff --stat`).

## Review Triage Log

### 2026-07-24 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 18: (high 1, medium 6, low 11)
- defer: 2: (high 0, medium 2, low 0)
- reject: 5: (high 0, medium 1, low 4)
- addressed_findings:
  - `[high]` `[patch]` Three bash sites swallowed failures silently (`release.yml` matrix-gen `$(…)`, `release.yml` ASSETS `mapfile`, `publish.yml` REQUIRED `mapfile`) — `set -euo pipefail` does not propagate out of command/process substitution and `mapfile` exits 0 on empty input. Reviewer reproduced it end-to-end: an empty `ASSETS` skips the presence loop and makes `sha256sum "${ASSETS[@]}"` read STDIN, writing `e3b0c44…  -` and exiting 0 — the release ships binaries with a checksum file verifying nothing. All three sites now capture into a variable, assert non-empty, and fail with a named message.
  - `[medium]` `[patch]` `publish.yml` was only half-derived: the four `publish_one` lines stayed hardcoded, so a future darwin row would be built, checksummed, downloaded and packaged, then silently never published, leaving the main package's `optionalDependencies` naming a nonexistent package. `PKG_PREFIX` moved into `platforms.ts`, a `--packages` CLI mode added, and the publish sequence now loops the table with the main package still LAST.
  - `[medium]` `[patch]` `docs/keyring-spike-decision.md`'s AR-20 paragraph claimed "every published binary fails its leg if `@napi-rs/keyring` does not load from the compiled artifact" — false: the gate compiles and runs a *second* artifact (`keyring-native-check.ts`) and never executes the shipped binary. Rewritten to state it is toolchain evidence, not an artifact probe; that the static import chain is what makes them equivalent today; that it is enforced but not yet observed; and that it runs on an unpinned Bun unlike the spike's pinned leg. macOS row's compiled-binary column also un-staled.
  - `[medium]` `[patch]` `strategy.fail-fast` left at default `true` — a Windows failure cancelled the in-flight arm64 leg, so a tag-triggered workflow revealed one broken platform per run. Set `fail-fast: false`; `needs: build` already makes a partial release impossible.
  - `[medium]` `[patch]` No `timeout-minutes` on any job while both sibling workflows set one with rationale; a Windows Credential Manager dialog is the documented hang mode. Added 5/30/15.
  - `[medium]` `[patch]` No `concurrency` group — `max-parallel: 1` protected only *within* a run, so two runs on a re-pushed tag still race `action-gh-release`. Added `release-${{ github.ref }}`, mirroring `publish.yml`.
  - `[medium]` `[patch]` The shim's second drift test was vacuous: `toContain(displayName)` was already satisfied by the `SUPPORTED` map values the first test checks, so deleting `linux-arm64` from the human-readable sentence passed. Now parses the `Supported platforms: …` sentence and compares the list; verified by mutation (the new assertion fails where the old one passed).
  - `[medium]` `[patch]` README told the reader to verify "before running it" and placed the snippet after the run command, never said to download `SHA256SUMS`, and chmod'd `$BIN` while running the hardcoded x64 name. Both blocks reordered to download → verify → chmod → run, Linux uses a `BIN=` variable, Windows swapped the eyeball `certutil` for a pass/fail `findstr /g:SHA256SUMS`.
  - `[low]` `[patch]` `retention-days: 1` made the I/O matrix's "re-run of a tag" promise false after 24h → 7.
  - `[low]` `[patch]` `files: dist/*` globbed instead of shipping the validated list → the checksum step now emits the exact list as a step output.
  - `[low]` `[patch]` The "cross-compile guard, as data" test accepted `ubuntu-24.04-armadillo` → added a runner-label regex and switched to `endsWith("-arm")`.
  - `[low]` `[patch]` `platforms.ts` and `platforms.test.ts` both claimed growth-friendliness their own assertions forbid → comments now name the darwin guard and exact-asset list as deliberate tripwires. Same stale claim also fixed in `build-npm-packages.ts`.
  - `[low]` `[patch]` Drift test hardcoded `"quick-studio-"` → uses the imported `PKG_PREFIX`.
  - `[low]` `[patch]` README said "covering all three binaries" → "every published binary".
  - `[low]` `[patch]` `--help`/`-h` exited 1 → usage on stdout, exit 0.
  - `[low]` `[patch]` `readonly PlatformRow[]` was shallow (rows mutable) → every field `readonly`; verified by a TS2540 probe.
  - `[low]` `[patch]` No multi-argument CLI test → added `--assets --github-matrix` and `--assets extra`.
  - `[low]` `[patch]` `spawnSync` null handling masked the real cause across all CLI tests → rethrows `result.error`, streams default to `""`.
  - Deferred: DW-88 (no workflow runs `bun test`, so every drift guard is enforced by developer discipline alone), DW-89 (the gate validates a different artifact than the one published; fixing it needs a `src/` self-check flag the intent contract forbids).
  - Rejected: SHA256SUMS verification in `publish.yml` (already tracked as DW-79 and explicitly deferred by this spec); `KEYRING_REQUIRE_ROUNDTRIP=1` on the Windows leg (deliberate, documented — the spike has never run, so gating every release on an unproven round-trip is the exact failure the Block-If warns about); the `SUPPORTED` regex brittleness (fails closed via `toEqual`, not open); asset-uniqueness guard in the CLI (already asserted in the test); README's pre-existing npm platform list.

### 2026-07-24 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 1, medium 2, low 3)
- defer: 3: (high 0, medium 1, low 2)
- reject: 6: (high 0, medium 3, low 3)
- addressed_findings:
  - `[high]` `[patch]` The README's Windows verification command could never succeed. `findstr /g:SHA256SUMS` uses each LINE of the file as a search string, and those lines are `<hash>␠␠<filename>`, while `certutil -hashfile` prints the bare hash on its own line and the filename on a different one — so no line of certutil's output can ever contain a search string, and the pipeline exits 1 for a perfectly good download. The README then instructs the reader that exit 1 means "do not run it", and this README ships verbatim inside the published npm package. Replaced with a real PowerShell comparison (`Select-String` the expected hash out of `SHA256SUMS`, `Get-FileHash` the file, compare case-insensitively) that also runs the binary ONLY in the matching branch — a missing `SHA256SUMS` or a missing line for this file leaves `$expected` empty and still fails closed.
  - `[medium]` `[patch]` The README's Linux block ran the binary even when verification failed: `sha256sum -c`, `chmod +x`, and `./"$BIN"` were three independent statements, so a `FAILED` line just scrolled past and the tampered binary executed on the next line. Now `&&`-chained, with the reason stated so nobody "tidies" it back into three lines.
  - `[medium]` `[patch]` Nothing in the pipeline ever executed the artifact users download — the keyring gate compiles and runs a *second* binary (`keyring-native-check.ts`). Added a `--version` smoke step on the shipped `${{ matrix.asset }}`, between compile and the keyring gate. It costs one step and no `src/` change (the intent contract's constraint), and because `--version` exits 0 only *after* the entry's static import chain to `src/core/keychain.ts` has been evaluated, a shipped binary that failed to embed its native binding now fails on the real artifact, not just on its stand-in. This narrows DW-89 substantially; that entry's status is the orchestrator's to resolve, so it was left untouched.
  - `[low]` `[patch]` `scripts/build-npm-packages.ts` kept `type PlatformRow` in its import after the interface moved out; nothing in the file references it, and per DW-91 no typechecker covers that file to notice. Removed.
  - `[low]` `[patch]` `bin/quick-studio.cjs`'s comment claimed "one shared platform map (three consumers)" and "the later macOS phase adds two entries here and nothing else" — both made false by this story, which turned the shim into a hand-maintained copy policed by a text-scraping test and added deliberate tripwires the macOS phase must clear on purpose. Rewritten so the engineer doing that phase reads the truth in the file they are editing.
  - `[low]` `[patch]` `scripts/platforms.test.ts` asserted asset uniqueness but never key uniqueness. Keys are the artifact name in `release.yml` (`binary-<key>`) and the npm package suffix; today the exact-asset tripwire blocks a duplicate by accident, but that tripwire is *meant* to be edited by the macOS phase, so the invariant needs its own assertion. Added.
  - Deferred: DW-90 (release binaries bake `package.json`'s version while npm publishes the tag's, with no guard that they agree — a mismatch makes 11.5's update check nag forever), DW-91 (`scripts/` is outside the tsconfig `include`, so the authoritative platform table is typechecked only because a test in `bin/` happens to import it), DW-92 (the README hardcodes the platform list in five places with no drift guard, and ships inside the npm package).
  - Rejected: no CI runs `bun test`/`tsc` (already DW-88, filed last pass); `publish.yml` not verifying downloads against `SHA256SUMS` (already DW-79, explicitly deferred by this spec); `setup-bun@v2` unpinned in `release.yml` (already DW-76, and the Design Notes deliberately leave it to the supply-chain pass); `timeout-minutes` not covering `ubuntu-24.04-arm` *queue* time (real GitHub semantics, but only reachable if the repo becomes private — the Design Notes already own that contingency and its remedy); a UI-created release out-racing `publish.yml`'s 120s poll (already DW-83 — and note the Design Notes' "no re-tuning needed" conclusion holds for the tag-push path, which is the one this story changed, not for a release created from the GitHub UI); the drift-test regexes' brittleness (`[^.]+` truncating at a dot, commented-out entries parsed as live) — both fail CLOSED via `toEqual`, and the same point was rejected last pass.

## Design Notes

**The Block-If does not trigger — the gate already distinguishes the two cases, and here is exactly why.** `src/core/keychain.ts:43` imports `@napi-rs/keyring` **statically at module top**, so a missing `.node` binding throws at *module-evaluation* time, before any wrapper function runs. `keychain.ts`'s own `try/catch` blocks (`:161-167`, `:188-195`, `:221-227`) wrap only the `setPassword`/`getPassword`/`deletePassword` calls, so they can never see that throw — they only ever classify genuine backend failures as `unavailable`. `scripts/keyring-native-check.ts:34-39` deliberately uses a **dynamic** `await import("../src/core/keychain.ts")` inside its own `try`, and its outer `catch` (`:90-96`) is therefore the one and only place an addon-load failure lands → `exit(1)` with `native-check: FAILED — native module did not load`. A loaded-addon-with-no-backend run instead produces typed `unavailable` outcomes from the wrapper calls and reaches `exit(0)` (`:88-89`). The two paths are separated by *call site*, not by string matching, so the split is structural. No product code change, no `src/` edit.

**Why `KEYRING_REQUIRE_ROUNDTRIP` stays unset on every release leg.** Setting it makes `unavailable` a hard failure and additionally demands a structural `not-found` probe (`keyring-native-check.ts:55-84`). That is the right setting for `keyring-spike.yml`, which *provisions* a backend per OS (apt + `dbus-run-session` + `gnome-keyring-daemon` on Linux, a dedicated `security` keychain on macOS) and exists to attest round-trip parity. The release matrix has a different job: prove the addon **embedded and loaded** in the artifact being shipped, which is precisely the failure cross-compilation causes. Forcing round-trip here would require replicating the spike's backend provisioning on three runners, and — critically — `keyring-spike.yml` has **never actually run** (there was no git remote until now), so the Windows round-trip is still "expected GO", not observed. Gating every release on an unproven assumption is the exact failure the Block-If warns about: a gate that blocks releases on the benign case. Round-trip attestation stays with the spike workflow; the release gate is addon-load, and it is the strictly-necessary one.

**Job skeleton** (the three-job shape; `matrix` cannot `import`, so a job generates it):
```yaml
jobs:
  platforms:                                    # checkout + setup-bun only — no bun install
    outputs: { matrix: "${{ steps.gen.outputs.matrix }}" }
    # gen: echo "matrix=$(bun scripts/platforms.ts --github-matrix)" >> "$GITHUB_OUTPUT"
  build:
    needs: platforms
    runs-on: ${{ matrix.runner }}
    strategy: { matrix: { include: "${{ fromJSON(needs.platforms.outputs.matrix) }}" } }
    defaults: { run: { shell: bash } }          # windows-latest defaults to pwsh
  release:
    needs: build                                # all legs green, or this never runs
    permissions: { contents: write }            # the only job that can write
```

**The `ubuntu-24.04-arm` Block-If cannot be settled locally — and must not be pre-emptively dropped.** Runner availability is only observable on a real workflow run, and there is no way to probe it from this working tree. Keeping the row is the correct default on three grounds: GitHub's Linux ARM hosted runners are generally available at no cost to **public** repositories, and `origin` is `https://github.com/joajo13/quick-studio` (public); `publish.yml:80` and `scripts/build-npm-packages.ts` **already** require a `quick-studio-linux-arm64` asset, so dropping the row would break Story 11.4 rather than degrade gracefully; and the epic's platform scope names linux-arm64 as first-class. If the first real tag fails with an unresolvable `ubuntu-24.04-arm` label, the Block-If's remedy applies then and is a one-row data change plus a README note — not a restructure. Do not silently substitute `ubuntu-latest` for that row: `scripts/platforms.test.ts` asserts that combination is impossible, precisely so the fallback cannot be a cross-compile.

**Ordering side effect worth knowing.** `publish.yml` triggers on `release: published` and polls up to 6×20s for its assets. Today the release is created by the *first* of two serial legs, so `published` can fire minutes before the last binary lands (tracked as DW-83). After this story one job creates the release and uploads all four files back-to-back, shrinking that window to seconds — the existing poll covers it comfortably, so DW-83 needs no re-tuning. It is not *eliminated* (`action-gh-release` still creates the release before uploading, rather than building a draft and flipping it), which is why the poll stays.

**Deliberately not fixed here.** DW-76 (`setup-bun@v2` unpinned in `release.yml`/`publish.yml`) survives this rewrite untouched — pinning the build toolchain belongs to the supply-chain pass that also SHA-pins actions (DW-78), and pinning to the `>=1.2.0` floor would freeze release builds on a Bun far older than the one this repo develops against. DW-79 (`publish.yml` verifying downloads against `SHA256SUMS`) becomes *possible* for the first time once this story lands the file, but wiring it is 11.4's surface and is left open.

## Verification

**Commands** (prefix with `export PATH="$HOME/.bun/bin:$PATH"`):
- `bun x tsc --noEmit` — expected: no errors; `scripts/platforms.ts` and its importers typecheck.
- `bun test` — expected: all green, including `scripts/build-npm-packages.test.ts` unmodified and the new `scripts/platforms.test.ts` + shim drift case.
- `bun scripts/platforms.ts --github-matrix` — expected: exit 0, exactly one line, `JSON.parse`able into 3 rows each carrying `key`/`os`/`cpu`/`asset`/`runner`.
- `bun scripts/platforms.ts --assets` — expected: exit 0, three lines: `quick-studio-windows-x64.exe`, `quick-studio-linux-x64`, `quick-studio-linux-arm64`.
- `bun scripts/platforms.ts --bogus; echo $?` — expected: `1`, usage line on stderr.
- `python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/release.yml .github/workflows/publish.yml` — expected: exit 0. (`actionlint` is not installed and is not an npm package; YAML well-formedness plus the review below is the available local check.)
- `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/release.yml')); print(sorted(d['jobs'])); print(d['jobs']['build']['strategy']['matrix']); print(d['jobs']['release']['needs'], d['jobs']['release']['permissions'])"` — expected: jobs are `['build','platforms','release']`; the matrix `include` is the `fromJSON(...)` expression string; `release` needs `build` and holds `contents: write`.
- `grep -n 'max-parallel\|--target=' .github/workflows/release.yml; echo $?` — expected: `1` (no matches) — the cross-compile flags and the serialization workaround are gone.
- Checksum dry-run: `mkdir -p /tmp/qs-sums && cd /tmp/qs-sums && printf a > quick-studio-windows-x64.exe && printf b > quick-studio-linux-x64 && printf c > quick-studio-linux-arm64 && mapfile -t A < <(bun /mnt/c/Users/Juan/Desktop/projects/quick-studio/scripts/platforms.ts --assets) && sha256sum "${A[@]}" > SHA256SUMS && sha256sum -c SHA256SUMS` — expected: three `OK` lines, exit 0 — proves the exact command shape the `release` job runs.

**Manual checks (no CLI available):**
- The matrix legs cannot be executed locally (they need `windows-latest` and `ubuntu-24.04-arm`). Confirm by reading the final `release.yml` that: no step passes `--target`; every leg's `runs-on` is `${{ matrix.runner }}`; the keyring gate step sits **between** compile and upload on every leg; and `release` is the only job with `contents: write`.
- Confirm `docs/keyring-spike-decision.md` contains no remaining sentence asserting darwin binaries are shipped (`grep -n 'ships darwin\|darwin binar' docs/keyring-spike-decision.md`).

## Auto Run Result

Status: done

**Implemented change.** `.github/workflows/release.yml` rebuilt from a single cross-compiling `ubuntu-latest` job into three: `platforms` (emits the platform table as matrix JSON), `build` (one leg per native runner — `windows-latest`, `ubuntu-latest`, `ubuntu-24.04-arm` — compiling with no `--target` and gating on the compiled-binary keyring check between compile and upload), and `release` (collects every artifact, validates it, emits `SHA256SUMS`, and performs the single release upload). `max-parallel: 1` and all `--target` flags are gone. The platform list, previously hand-copied across six locations, now lives in `scripts/platforms.ts` and is consumed by the matrix, the packaging script, and `publish.yml`'s asset and publish loops; the shim cannot import it (dependency-free CJS) so a test asserts it as text.

**Files changed.**
- `scripts/platforms.ts` (NEW) — the single platform table plus `PKG_PREFIX`; dependency-free so the matrix job runs it with no `bun install`; three CLI modes (`--github-matrix`, `--assets`, `--packages`) because neither an Actions matrix nor a bash loop can import TypeScript.
- `scripts/platforms.test.ts` (NEW) — table shape, the cross-compile guard as data, the no-darwin boundary, and every CLI mode.
- `scripts/build-npm-packages.ts` — imports the shared table and prefix instead of holding its own copy; behavior unchanged.
- `.github/workflows/release.yml` — the rewrite described above.
- `.github/workflows/publish.yml` — the download poll and the publish sequence both derive from the shared table; ordering (platform packages first, main last) preserved.
- `bin/quick-studio-shim.test.ts` — drift block asserting the shim's `SUPPORTED` map and its human-readable platform sentence against the table.
- `docs/keyring-spike-decision.md` — the false "the product ships darwin binaries" claim corrected, the Windows row and AR-20 paragraph restated to what the gate actually proves.
- `README.md` — three assets plus `SHA256SUMS`, verification before running on both platforms, macOS stated as a later phase. The follow-up pass rewrote both verification snippets so they actually work and so neither can run an unverified binary.
- `bin/quick-studio.cjs` — comment only (follow-up pass): the shim is documented as a hand-maintained copy policed by a drift test, not as a consumer of the shared table, and the macOS phase is documented as a multi-file change rather than "two entries here and nothing else".

**Review findings.** Two passes, no intent gaps and no spec defects in either — the implementation matched the spec throughout; every finding was a failure mode the spec did not anticipate.
- First pass: 18 patches (1 high, 6 medium, 11 low), 2 deferred (DW-88, DW-89), 5 rejected.
- Follow-up pass: 6 patches (1 high, 2 medium, 3 low), 3 deferred (DW-90, DW-91, DW-92), 6 rejected. The high finding was that the README's Windows checksum command could never succeed — `findstr /g:` searches for whole `<hash>  <filename>` lines that `certutil` output never contains — so every Windows user following the documented verification would have concluded a good download was corrupt, in a README that ships inside the npm package. The two mediums: the Linux verification block ran the binary even when `sha256sum -c` failed (now `&&`-chained), and nothing in the pipeline ever executed the artifact being published (a `--version` smoke step on the shipped binary now does).

Full breakdown in the Review Triage Log above.

**Follow-up review: not recommended.** The follow-up pass was small and localized: three of the six patches are documentation or comment text, one deletes an unused import, one adds a single test assertion, and one adds a two-line CI step whose only failure mode is loud. Nothing moved across a module boundary, no control flow changed, and no product code was touched. The findings that remain are all filed in the ledger rather than fixed, and each names why it is a decision rather than a patch.

**Verification performed** (re-run after the follow-up pass).
- `bun x tsc --noEmit` — clean, no output.
- `bun test` — 1761 pass, 1 skip, 9 fail (one more pass than the previous run: the added key-uniqueness assertion). All 9 failures are `bin/quick-studio-shim.test.ts` cases that spawn `node`, which is not installed on this dev host; they are pre-existing and unrelated. `scripts/platforms.test.ts` 12/12 and the drift block 2/2 pass.
- `git diff --stat` — `scripts/build-npm-packages.test.ts` does not appear (Story 11.4's regression contract is byte-unchanged).
- YAML well-formedness on both workflows via `yaml.safe_load` — exit 0. Structural assertion: jobs are `['build','platforms','release']`, the matrix `include` is the `fromJSON(...)` expression, `release` needs `build` and is the only job with `contents: write`.
- `grep 'max-parallel\|--target='` on `release.yml` — no matches.
- Checksum dry-run with three stub files — `sha256sum -c` reports three `OK`, exit 0.
- CLI modes exercised directly: `--github-matrix` (one line, parses to 3 rows), `--assets`, `--packages` (order identical to the four previously hardcoded `publish_one` lines, so the change is behavior-preserving today), `--help` (exit 0), `--bogus` (exit 1).
- Two review fixes proven rather than asserted: the empty-`ASSETS` STDIN bug reproduced and then shown to fail loudly with the guard; the shim drift test mutation-tested by deleting `linux-arm64` from the shim's sentence (new assertion fails, old one passed).

**Residual risks.**
- **Nothing here has run in CI.** There is no git tag and no workflow execution behind any of it — `release.yml`, and therefore the keyring gate, is enforced but never observed. The first `v*` tag is the real test, and it must come after Story 11.4 has landed.
- **`ubuntu-24.04-arm` availability is unverified** and unverifiable from this tree. The row is kept deliberately (the repo is public, and `publish.yml` plus the packaging script already require the arm64 asset). If the label does not resolve on the first tag, the Block-If's remedy is a one-row data change plus a README note — never a cross-compile.
- **The gate proves the toolchain, not the shipped artifact** (DW-89). Narrowed by the follow-up pass: every leg now also runs the published binary with `--version`, which forces the same static import chain to `keychain.ts`, so an addon that failed to embed fails on the real artifact. What is still unproven on the shipped binary is the keychain *round-trip*; the DW-89 entry itself was left untouched for the orchestrator to resolve.
- **`publish.yml`'s poll window was reasoned about for the tag-push path only.** The Design Notes' conclusion that DW-83 needs no re-tuning holds when a `v*` tag push drives `release.yml` (one job creates the release and uploads back-to-back). It does not hold for a release created from the GitHub UI: that creates the tag, which starts `release.yml` from scratch, while `publish.yml` fires immediately on `published` and exhausts its 6×20s budget long before any binary exists. The event does not re-fire, so that version would need a manual workflow re-run. Pre-existing and tracked as DW-83; not made worse by this story, but the "shrinking that window to seconds" claim is about the tag path.
- **No CI runs the test suite** (DW-88), so the drift guards that hold the single-source design together depend on someone running `bun test` before tagging.
- **`setup-bun@v2` stays unpinned** (DW-76), so release binaries are built with whatever Bun is latest that day — now explicitly disclosed in the spike doc rather than left implied.
