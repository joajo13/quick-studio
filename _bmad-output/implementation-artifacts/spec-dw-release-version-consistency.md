---
title: 'Release version-agreement guards across release.yml and publish.yml (DW-80, DW-90)'
type: 'chore'
created: '2026-07-28'
status: 'done'
baseline_revision: 'e415826'
final_revision: 'ab5214a'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Two independent sources of version truth exist with nothing asserting they agree — `release.yml` bakes `package.json`'s `version` into every binary (`scripts/build-version.ts` → `src/core/version.generated.ts`), while `publish.yml` derives the npm version from the git tag (`VERSION="${TAG#v}"`). Pushing `v1.2.0` with `package.json` still at `0.0.1` publishes `quick-studio@1.2.0` wrapping a binary whose `--version` prints `0.0.1`, and Story 11.5's update check then tells every user on the newest release, on every Persistent boot, that an update is available — permanently.

**Approach:** Add two assertion-only guards without changing who owns the version number. (DW-90) `release.yml`'s `platforms` job fails the run when `${GITHUB_REF_NAME#v}` differs from `package.json`'s `version`, before any matrix leg compiles anything. (DW-80) `publish.yml`, immediately after the download step, runs the downloaded linux-x64 binary with `--version` and fails when its stdout differs from the tag-derived `VERSION`. A new `--asset <key>` lookup on `scripts/platforms.ts` keeps that binary's filename derived from the platform table rather than hardcoded.

## Boundaries & Constraints

**Always:** `package.json` remains the sole owner of the version number — both guards only *assert* agreement and never write a version anywhere. Every new multi-line `run: |` block opens with `set -euo pipefail`, prints an actionable stderr message naming **both** compared values on failure, and exits non-zero. The binary filename used by the publish guard is derived from `scripts/platforms.ts`, never a hardcoded literal. Comparisons are exact string equality, so prerelease tags (`v1.2.0-beta.1`) work unchanged. New steps match the surrounding comment density that justifies each guard.

**Block If:** The work would require moving where the version of record lives (e.g. having the build write the tag into `package.json` / `version.generated.ts`) — that is a release-process decision, deliberately not taken here. Also block if the platform table no longer contains a `linux-x64` row, because `publish.yml`'s `ubuntu-latest` runner would then have no natively runnable binary and the DW-80 assertion would silently become a no-op.

**Never:** No emulation (qemu, wine) to execute the windows-x64 or linux-arm64 binaries on the publish runner. Do not convert `release.yml`'s existing `Smoke the shipped binary` step into a version assertion — DW-80 is scoped to `publish.yml`. Do not add workflow files, alter job graphs / `needs:` / `concurrency:`, or touch the `actions/*` SHA pins or the `bun-version: 1.3.14` pins. Do not edit `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tag agrees (DW-90) | `GITHUB_REF_NAME=v0.0.1`, `package.json` `0.0.1` | `platforms` job continues and emits the matrix | No error expected |
| Tag ahead of package.json | `GITHUB_REF_NAME=v1.2.0`, `package.json` `0.0.1` | `platforms` exits non-zero; `build` never starts (it `needs: platforms`) | stderr names tag version and package.json version |
| Prerelease tag agrees | `v1.2.0-beta.1`, `package.json` `1.2.0-beta.1` | Guard passes | No error expected |
| Unreadable package.json version | `bun -e` read fails or prints empty | Guard exits non-zero rather than comparing against `""` | stderr states the version could not be read |
| Binary agrees (DW-80) | `bin-dl/quick-studio-linux-x64` prints `1.2.0`, tag `v1.2.0` | Publish continues to `Build npm packages` | No error expected |
| Binary disagrees | binary prints `0.0.1`, tag `v1.2.0` | Publish fails before any package is built or published | stderr names binary version and tag version |
| Downloaded binary lacks exec bit | `gh release download` writes `bin-dl/*` as `0644` | Guard `chmod +x` before invoking it | Non-zero exit if it still cannot run |
| `--asset` with unknown key | `bun scripts/platforms.ts --asset darwin-x64` | usage on stderr, exit 1, nothing on stdout | Guard step fails loudly, never with an empty filename |

</intent-contract>

## Code Map

- `.github/workflows/release.yml` -- `platforms` job (L34-64); DW-90 guard belongs between `Set up Bun` and `Generate platform matrix`
- `.github/workflows/publish.yml` -- `Download release binaries` (L68-107) then `Build npm packages` (L109); DW-80 guard belongs between them
- `scripts/platforms.ts` -- authoritative platform table + CLI (`--github-matrix|--assets|--packages`, strict `args.length === 1`); gains `--asset <key>`
- `scripts/platforms.test.ts` -- CLI contract tests, including the arg-count strictness test at L147 whose comment cites the `args.length === 1` guard
- `scripts/build-version.ts` -- reads `package.json`'s `version`, writes `VERSION` into `src/core/version.generated.ts`; the reason binaries carry package.json's number
- `bin/quick-studio.ts:66-69` -- `--version` writes bare `${VERSION}\n` to stdout and exits 0; this is the exact output the DW-80 guard compares
- `src/core/update-check.ts` -- consumer that turns a mismatch into a permanent false "update available"

## Tasks & Acceptance

**Execution:**
- [x] `scripts/platforms.ts` -- add a two-argument `--asset <key>` CLI mode that prints that row's `asset` and exits 0, or writes usage to stderr and exits 1 for an unknown key; extend `USAGE` to document it -- gives `publish.yml` a table-driven filename lookup instead of a hardcoded fourth copy of the asset names
- [x] `scripts/platforms.test.ts` -- add cases for `--asset <key>` (each row's key resolves to its asset, unknown key exits 1 with empty stdout, `--asset` with no key exits 1) and correct the now-stale `args.length === 1` wording in the L147 test comment -- the CLI contract is the only thing standing between a renamed row and a silently empty `ASSET`
- [x] `.github/workflows/release.yml` -- add a `Guard: tag version matches package.json` step to the `platforms` job comparing `${GITHUB_REF_NAME#v}` against `bun -e 'console.log(require("./package.json").version)'` -- fails a mismatched tag before any runner compiles a binary (DW-90)
- [x] `.github/workflows/publish.yml` -- add a `Guard: binary version matches the tag` step after `Download release binaries` that resolves the linux-x64 asset via `bun scripts/platforms.ts --asset linux-x64`, `chmod +x` it, and asserts its `--version` stdout equals `${TAG#v}` -- fails the publish before any package is built (DW-80)

**Acceptance Criteria:**
- Given a fresh checkout, when `bun test scripts/platforms.test.ts` runs, then every test passes, including the new `--asset` cases and the pre-existing arg-count strictness cases
- Given `release.yml`, when the guard step is inspected, then it sits inside the `platforms` job ahead of matrix emission, so a mismatched tag cannot reach any `build` leg
- Given `publish.yml`, when the guard step is inspected, then it sits strictly between `Download release binaries` and `Build npm packages`, so a mismatched binary is caught before `dist-npm` exists and before any `npm publish` runs
- Given both workflow files, when they are parsed as YAML, then they remain valid and their job graphs, `needs:`, `concurrency:`, action SHA pins, and `bun-version: 1.3.14` pins are byte-for-byte unchanged

## Spec Change Log

## Review Triage Log

### 2026-07-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 3: (high 0, medium 1, low 2)
- reject: 8: (high 0, medium 2, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The new `publish.yml` guard interpolated `${{ github.event.release.tag_name }}` into its shell source, adding a fourth instance of the injection pattern DW-120 already tracks — in the job holding the OIDC Trusted-Publishing credentials. Moved the tag to an `env: TAG:` block, matching the sibling guard's `GITHUB_REF_NAME` reasoning. Rehearsed with a hostile tag: the payload stayed inert data and no marker file was created.
  - `[low]` `[patch]` `if [ -z "$ASSET" ]` was unreachable — under `set -e` a failing `--asset` substitution aborts the step first, so the operator saw a bare `usage:` instead of the explanatory message. Restructured to `if ! ASSET="$(...)" || [ -z "$ASSET" ]`. Rehearsed by deleting the `linux-x64` row: the message now prints.
  - `[low]` `[patch]` The publish guard lacked the empty-`VERSION` check its `release.yml` twin documents 25 lines earlier. Added; rehearsed with `TAG=v`.
  - `[low]` `[patch]` The `usage text documents the mode` test asserted `toContain("--asset")`, which the pre-change USAGE already satisfied via the `--assets` substring. Now asserts `--asset <key>`; mutation-tested by stripping the mode from USAGE.
  - `[low]` `[patch]` No test connected `publish.yml`'s literal key to the platform table, and the naive version of that test would have passed on `--asset linux-arm64` — a valid row that dies with `Exec format error` on an x64 runner. Added a tripwire asserting the named key's row `runner` equals the job's `runs-on`, deriving the pairing from the table. Mutation-tested: `linux-arm64`, `darwin-x64`, and USAGE-stripping mutants all killed.
  - `[low]` `[patch]` The publish guard's comment justified 1-of-3 sampling with an intra-run argument while claiming the guard catches a stale asset on a re-pushed tag — a per-asset, cross-run case one sample cannot cover. Comment corrected, and the two facts it omitted added: the unverified `SHA256SUMS` sitting in `bin-dl/`, and that this is the only version guard on a release created from the GitHub UI (`release: published` never runs `release.yml`).


## Design Notes

The DW-90 guard goes in `platforms`, not `build`: `build` fans out to three runners and `needs: platforms`, so failing in `platforms` costs one short ubuntu job instead of three compile legs. The job already has checkout + Bun and needs no `bun install` to read `package.json`.

The DW-80 guard can only execute the **linux-x64** binary — `publish.yml` runs on `ubuntu-latest`, so the `.exe` and the arm64 binary are not runnable there. That is an accepted single-platform sample: DW-90 already guarantees tag == `package.json` for the whole run, and all three legs bake the same `package.json`, so one binary is a sufficient end-to-end witness.

Both workflows carry explicit comments that the asset list is "Derived from `scripts/platforms.ts` … rather than hardcoding a fourth copy". `--asset <key>` honors that; naming the key `linux-x64` in the workflow is consistent with its already-hardcoded `runs-on: ubuntu-latest`.

Shape of the assertion, matching the existing npm-floor guard's style:

```bash
set -euo pipefail
TAG_VERSION="${GITHUB_REF_NAME#v}"
PKG_VERSION="$(bun -e 'console.log(require("./package.json").version)')"
if [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
  echo "tag $GITHUB_REF_NAME implies version $TAG_VERSION but package.json says $PKG_VERSION" >&2
  exit 1
fi
```

## Verification

**Commands:**
- `bun test scripts/platforms.test.ts` -- expected: all tests pass, including the new `--asset` cases
- `bun test` -- expected: no new failures versus the pre-change baseline
- `bun scripts/platforms.ts --asset linux-x64` -- expected: prints `quick-studio-linux-x64`, exit 0
- `bun scripts/platforms.ts --asset darwin-x64` -- expected: empty stdout, usage on stderr, exit 1
- `python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['.github/workflows/release.yml','.github/workflows/publish.yml']]"` -- expected: exit 0 (both files still parse)

**Manual checks (if no CLI):**
- Rehearse both guard bodies locally in bash with a matching and a mismatching value pair, confirming exit 0 and exit 1 plus the stderr text
</content>

## Auto Run Result

Status: done

### Implemented change

Two assertion-only version-agreement guards, closing DW-80 and DW-90. `release.yml`'s `platforms` job now fails when the pushed tag disagrees with `package.json`'s `version`, before any of the three native `build` legs compiles anything. `publish.yml` now executes the downloaded linux-x64 binary and fails when its `--version` output disagrees with the tag-derived `VERSION`, before `dist-npm` exists and before any `npm publish`. `package.json` remains the sole owner of the version number — neither guard writes a version anywhere.

### Files changed

- `.github/workflows/release.yml` -- new `Guard: tag version matches package.json` step in the `platforms` job (DW-90)
- `.github/workflows/publish.yml` -- new `Guard: binary version matches the tag` step between the download and packaging steps (DW-80); its tag is passed via `env:`, not interpolated into the script
- `scripts/platforms.ts` -- new `--asset <key>` CLI mode so the workflow names one binary without hardcoding its filename
- `scripts/platforms.test.ts` -- 7 new tests covering `--asset` and a tripwire tying `publish.yml`'s key to the job's `runs-on` via the platform table

### Review findings breakdown

6 patches applied (1 medium, 5 low) — see the Review Triage Log. 3 items deferred, 8 rejected.

**Deferred (recorded here, not written to the ledger: this run was invoked with an explicit instruction not to edit `deferred-work.md`; the orchestrator owns that file):**

- `[medium]` `.github/workflows/publish.yml` — the DW-80 guard executes a downloaded release asset inside the job that holds the OIDC Trusted-Publishing credentials, without verifying it against the `SHA256SUMS` file that `gh release download` already places in `bin-dl/`. Executing a downloaded artifact there is new behavior introduced by this change (previously assets were only copied). Overlaps the in-flight `dw-publish-asset-integrity-timing` bundle, which owns checksum verification, so wiring it here would conflict.
- `[low]` `.github/workflows/release.yml` — a matching but non-semver pair (tag `v1.2` with `package.json` `1.2`) passes the DW-90 guard and then fails ~30 minutes later inside `scripts/build-version.ts` on three native runners, which is the cost the guard exists to avoid. A real fix needs a shared home for the anchored semver regex currently duplicated verbatim in `scripts/build-version.ts` and `src/core/update-check.ts`; adding a third copy inside a workflow would worsen the drift.
- `[low]` Neither guard's shell logic has automated coverage. ~100 lines of new bash are validated only by the manual rehearsals recorded below; the repo has no harness for executing workflow step bodies.

**Notable rejection:** a reviewer claimed `release.yml`'s `-z "$PKG_VERSION"` branch is dead code under `set -e`. Refuted empirically — `bun -e 'console.log(require("./package.json").version)'` with no `package.json` exits **0** with empty stdout and empty stderr, so that branch is reachable and load-bearing. (The equivalent claim about `publish.yml`'s `-z "$ASSET"` was correct and was patched.)

### Verification performed

- `bun test` -- 1991 pass, 1 skip, 0 fail across 91 files (pre-change baseline: 1984 pass, 0 fail; +7 = the new tests)
- `bun test scripts/platforms.test.ts` -- 20 pass, 0 fail
- `bunx tsc --noEmit` -- exit 0
- `python3 -c "import yaml; ..."` on both workflows -- exit 0
- Mutation-tested the new tripwire: `--asset linux-arm64` (valid row, wrong arch), `--asset darwin-x64` (nonexistent row), and a USAGE stripped of the mode each turn the suite red; restored state green
- Rehearsed the publish guard's body extracted from the parsed YAML: agreeing pair exit 0 (with the file left `0644`, proving the `chmod +x` is load-bearing), disagreeing pair exit 1, prerelease pair exit 0, `TAG=v` exit 1, `linux-x64` row deleted exit 1 with the explanatory message, and a hostile tag (`v1.2.0";touch /tmp/PWNED-marker;:"`) left as inert data with no marker created
- Confirmed the action SHA pins, `bun-version: 1.3.14`, job graphs, `needs:`, and `concurrency:` are unchanged

### Residual risks

- Neither guard can run outside CI, so their first real execution is the first tagged release. The rehearsals above exercise the exact bodies parsed out of the YAML, but not GitHub's expression expansion or runner environment.
- The DW-80 guard samples one of three binaries. A per-asset divergence (an asset re-uploaded by hand onto an existing release) is not covered by either guard; that gap is the first deferred item above.
- `publish.yml` retains three pre-existing tag-interpolation sites (lines 73, 187, 199) tracked as DW-120. This change deliberately did not touch them; only its own new step was made safe.
