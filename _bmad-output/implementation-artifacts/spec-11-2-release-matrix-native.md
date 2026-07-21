---
title: 'Release matrix on native runners with SHA256SUMS and a compiled-binary keyring gate'
type: 'feature'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.2
  - '{project-root}/docs/keyring-spike-decision.md'
---

<intent-contract>

## Intent

**Problem:** `.github/workflows/release.yml` builds exactly two artifacts — `bun-linux-x64` and `bun-windows-x64` — both on a single `ubuntu-latest` runner, with `max-parallel: 1`. Three things are wrong with that as the substrate for a distribution epic. (1) **Coverage:** no macOS and no ARM, while `docs/keyring-spike-decision.md` states "the product ships darwin binaries (`bun.lock` carries every `@napi-rs/keyring-darwin-*` artifact)" — which is simply false today, and Apple Silicon is the single most common developer machine the product does not serve. (2) **Cross-compilation risk:** the windows leg already cross-compiles from ubuntu via `--target=bun-windows-x64`. `@napi-rs/keyring` is a **native NAPI addon** whose platform-specific `.node` binding is selected from optional dependencies; the spike proved the addon embeds and loads from a `--compile` binary **only on Linux, built on Linux** ("observed locally"), and explicitly records Windows and macOS as *pending CI, expected GO*. A cross-compiled binary that silently embeds the host's `.node` — or none — produces a binary that boots but cannot reach the OS keychain, degrading every user to the passphrase path with no signal. (3) **Verifiability:** the release publishes bare binaries with no checksum file, so no installer, script, or human can verify a download.

**Approach:** Rebuild the release matrix around **native runners, one per target**, and gate each leg on the compiled-binary keyring check that already exists from the spike:
- `ubuntu-latest` → linux-x64; `ubuntu-24.04-arm` → linux-arm64; `macos-13` → darwin-x64; `macos-latest` → darwin-arm64; `windows-latest` → windows-x64.
- Each leg compiles with `bun build --compile` **for its own host** (no `--target` cross-compile), then runs `scripts/keyring-native-check.ts` compiled the same way, as a **required gate**.
- A final job collects every artifact, emits `SHA256SUMS`, and uploads binaries + checksums to the release in one place — which also retires the `max-parallel: 1` race workaround, since only one job now touches the release.

## Boundaries & Constraints

**Always:**
- Every published binary is compiled **on a runner whose OS and architecture match its target**. This is the whole point of the story — the native addon is the reason.
- Every leg runs the compiled-binary keyring check as a **gate**: the leg fails and its binary is not published if the native addon cannot load from the compiled binary. On a runner with no usable keychain backend (headless Linux with no Secret Service), the gate's pass condition is the spike's own classification — a typed `unavailable` is a **pass** (the addon loaded; there is simply no backend), while a failure to load the addon at all is a **fail**. Encoding that distinction correctly is the crux of this story.
- `bun install --frozen-lockfile` on every leg (already the case at `release.yml:33`), so a release is reproducible from the committed lockfile.
- `SHA256SUMS` covers every published binary, in the standard `<hash>  <filename>` format that `sha256sum -c` accepts.
- The release upload happens from **one job**, after all build legs succeed — a partial release (some platforms present, others silently missing because a leg failed) must not be publishable.
- `docs/keyring-spike-decision.md` is updated to state the platforms actually shipped and to record each leg's real go/no-go — the spike doc is the AR-20 risk register and it currently overstates coverage.

**Block If:**
- If `macos-13` (darwin-x64) is unavailable or deprecated on GitHub-hosted runners at implementation time, ship darwin-arm64 only and record the gap explicitly in the README and the spike doc. Do NOT cross-compile darwin-x64 from arm64 to fill the hole.
- If the keyring gate cannot distinguish "addon failed to load" (a real failure) from "no keychain backend on this runner" (an expected pass on headless CI) without new product code, HALT and flag it — a gate that fails on the benign case will block every release, and a gate that passes on the real case is worse than no gate.
- If `ubuntu-24.04-arm` is not available to this repository's plan, drop linux-arm64 from the matrix and record it, rather than cross-compiling it.

**Never:**
- Never cross-compile a target whose native addon binding differs from the build host — this is the specific failure mode the story exists to prevent.
- Never publish a binary whose keyring gate did not run or did not pass.
- Never change the product's runtime behavior. This story touches CI workflow files, the checksum artifact, and documentation only — no `src/` change is expected. If one appears necessary (e.g. to make the gate classifiable), it must be flagged in step-02 rather than smuggled in.
- Never leave `docs/keyring-spike-decision.md` claiming coverage the matrix does not produce.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full release | push tag `v0.1.0` | Five binaries + `SHA256SUMS` attached to the release for `v0.1.0` | none |
| Native compile per leg | each matrix leg | `bun build --compile` with **no** `--target` flag (host-native); outfile named `quick-studio-<os>-<arch>`, `.exe` on windows | Leg fails loudly on a build error |
| Keyring gate, keychain present | macos/windows leg | `keyring-native-check` compiled binary round-trips set/get/delete → leg passes | none |
| Keyring gate, headless linux | ubuntu leg, no Secret Service | Addon **loads**, backend reports `unavailable` → leg **passes** (this is the spike's documented first-class outcome) | Must not be treated as a failure |
| Keyring gate, addon missing | a leg where the `.node` binding did not embed | Leg **fails**, release does not publish that platform | Loud failure naming the platform |
| One leg fails | darwin-arm64 build breaks | No release assets are uploaded at all — the collect-and-upload job does not run | Partial release is impossible |
| Checksum verification | `sha256sum -c SHA256SUMS` in the release dir | All lines OK | n/a |
| Re-run of a tag | workflow re-run for an existing tag | Assets replaced/uploaded without the create-release race that `max-parallel: 1` worked around | Single uploading job removes the race by construction |
| Windows artifact naming | windows-latest leg | `quick-studio-windows-x64.exe`, matching today's asset name so the README's existing instructions stay true | none |

</intent-contract>

## Acceptance Criteria

- Given a pushed `v*` tag, when the workflow completes, then linux-x64, linux-arm64, darwin-x64, darwin-arm64, and windows-x64 binaries plus `SHA256SUMS` are attached to the release.
- Given each matrix leg, when it builds, then it compiles natively for its own host and runs the compiled-binary keyring check as a pass/fail gate.
- Given any failing leg, when the workflow finishes, then no assets are published — a release is all-or-nothing.
- Given `docs/keyring-spike-decision.md`, when the story is done, then its platform table reflects the matrix that actually exists.

## Code Map

- `.github/workflows/release.yml` — replace the two-entry `include` matrix with five native-runner entries (`runs-on` per leg); drop the `--target` flags; drop `max-parallel: 1`; each leg uploads its binary as a **workflow artifact** rather than straight to the release.
- `.github/workflows/release.yml` (new final job) — `needs:` all build legs; downloads every artifact, generates `SHA256SUMS`, and calls `softprops/action-gh-release@v2` **once** with binaries + checksums.
- `scripts/keyring-native-check.ts` — already exists from Story 2.1 and is the gate's payload. Confirm its exit code distinguishes "addon failed to load" from "no backend available"; if it only prints and always exits 0, it needs an exit-code contract before it can gate (flag in step-02 — this is the Block-If above).
- `docs/keyring-spike-decision.md` — update the summary table's Go/No-go and the AR-20 status paragraph to match the shipped matrix and the real CI results.
- `README.md` — the Install section's binary list currently names only Linux and Windows x64; extend it to the five published assets and document `sha256sum -c SHA256SUMS` verification.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] Confirm `scripts/keyring-native-check.ts` has (or gains) an exit-code contract that separates addon-load failure from backend-unavailable.
- [ ] Rewrite the matrix with five native-runner legs; remove all `--target` cross-compile flags.
- [ ] Add the compiled-binary keyring gate step to every leg.
- [ ] Switch legs to upload workflow artifacts; add the collect job that emits `SHA256SUMS` and performs the single release upload.
- [ ] Remove `max-parallel: 1` and its now-obsolete comment.
- [ ] Update `docs/keyring-spike-decision.md` (platform table + AR-20 status) and the README Install section.
- [ ] Workflow-syntax check (`actionlint` or equivalent) — this story has no `bun test` surface, so a lint/dry-run is the only local verification available before a real tag.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

## Review Triage Log

<!-- populated by the review loop -->
