---
title: 'Supply-chain hardening: SHA-pin GitHub Actions and pin the Bun toolchain'
type: 'chore'
created: '2026-07-28'
status: ready-for-dev
baseline_revision: '97a4f79'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** Every third-party action across the three workflows is pinned to a *mutable* tag (`@v4`, `@v2`), and `publish.yml` runs those actions in a job holding `id-token: write` — a repointed tag could exfiltrate the OIDC npm publish credential (DW-78). Separately, `release.yml` calls `oven-sh/setup-bun@v2` with no `bun-version`, so every shipped binary is compiled with whatever Bun is "latest" that day: releases are non-reproducible and one bad Bun release breaks all matrix legs at once with no toolchain rollback independent of the git tag (DW-76).

**Approach:** One supply-chain pass over all of `.github/workflows/`: replace every mutable action tag with the immutable commit SHA it resolves to today (same major version — this is a pinning pass, not an upgrade), annotated with a trailing `# vX.Y.Z` comment, and add `bun-version: 1.3.14` to every `setup-bun` step so the build toolchain matches the version the project is actually developed and tested against.

**PIN VALUE DECIDED — 2026-07-27, user: `1.3.14`, option 1 of the escalation.** The first drive of this bundle pinned `1.2.0`, read off the `engines.bun: ">=1.2.0"` floor, and the review proved empirically that the runtime does not survive it: `src/core/server.test.ts` gives 66 pass / 2 fail on 1.2.0 vs 68 pass / 0 fail on 1.3.14 (5 failing tests repo-wide). `bun build --compile` embeds the compiling Bun's runtime, so pinning 1.2.0 would bake that regression into every shipped binary. A floor is a minimum, not a pin value.

**Consequence that is IN SCOPE for this drive:** pinning 1.3.14 makes the advertised `>=1.2.0` floor a false claim, since the code demonstrably fails on it. `package.json` `engines.bun` and the README's floor must be raised to `>=1.3.14` in the same change — the one version the suite is green on. Shipping the pin without raising the floor is the failure mode this note exists to prevent.

## Boundaries & Constraints

**Always:**
- Pin to the SHA the currently-referenced *major* tag resolves to. Do not change major versions.
- Every `uses:` referencing a third-party action ends in a 40-hex commit SHA followed by ` # vX.Y.Z`.
- Apply to **all three** workflows (`release.yml`, `publish.yml`, `keyring-spike.yml`) — a repo-wide convention, per DW-78's evidence that pinning only `publish.yml` would diverge.
- Preserve every existing comment, step name, `with:` input, ordering, and job structure. This change touches `uses:` lines and adds `bun-version:` inputs only.
- `bun-version` value is `1.3.14` everywhere, INCLUDING `keyring-spike.yml` (whose existing `1.2.0` pin is now the stale outlier, not the precedent). `package.json` `engines.bun` and the README floor are raised to `>=1.3.14` to match.

**Block If:**
- A resolved SHA cannot be confirmed against the action repository (never guess or fabricate a SHA).
- Pinning would require a major-version bump to keep a workflow working.

**Never:**
- Do not upgrade any action to a newer major (`checkout` v7, `download-artifact` v8, `action-gh-release` v3 all exist — out of scope).
- Do not change the npm/Node pins in `publish.yml`, the release matrix, job permissions, concurrency, or any shell step body.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- Do not add Dependabot/Renovate config — pin only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Pinned action resolution | Workflow references `actions/checkout@11d5960…` | GitHub resolves the exact commit; a later repoint of `v4` has no effect | No error expected |
| Bun toolchain pin | `release.yml` build leg runs `setup-bun` with `bun-version: 1.3.14` | All legs compile with the same Bun; a bad "latest" Bun cannot reach the release | Step fails loudly if 1.3.14 is unavailable |
| Mutable tag reintroduced | Any `uses:` line ends in `@vN` | Grep verification (below) fails and reports the offending line | Verification is the guard; fix before merge |

</intent-contract>

## Code Map

- `.github/workflows/release.yml` -- builds + publishes release binaries; uses `checkout@v4`, `setup-bun@v2` (×3, all unpinned toolchain), `upload-artifact@v4`, `download-artifact@v4`, `softprops/action-gh-release@v2`. Primary target of DW-76.
- `.github/workflows/publish.yml` -- npm OIDC Trusted Publishing; job-scoped `id-token: write`; uses `checkout@v4`, `setup-bun@v2`, `setup-node@v4`. Primary target of DW-78.
- `.github/workflows/keyring-spike.yml` -- uses `checkout@v4`, `setup-bun@v2` with `bun-version: 1.2.0`. That value is the STALE OUTLIER this change corrects (it was the precedent the first drive copied); needs SHA-pinning AND its pin raised to `1.3.14`.
- `docs/keyring-spike-decision.md` (line 6) -- asserts the release gate "runs on an **unpinned** Bun (`oven-sh/setup-bun@v2` with no `bun-version`; deferred as DW-76)". Goes stale on this change and must be corrected.
- `package.json` (`engines.bun: ">=1.2.0"`), `README.md:277` -- the advertised floor. **EDITABLE in this change, not read-only**: the suite fails on 1.2.0, so both must be raised to `>=1.3.14`.

**Resolved SHAs (verified against the GitHub API on 2026-07-28; the current target of each major tag):**

| Action | SHA | Tag |
|---|---|---|
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0 |
| `oven-sh/setup-bun` | `0c5077e51419868618aeaa5fe8019c62421857d6` | v2.2.0 |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2 |
| `actions/download-artifact` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | v4.3.0 |
| `softprops/action-gh-release` | `3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` | v2.6.2 |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |

## Tasks & Acceptance

**Execution:**
- [ ] `.github/workflows/release.yml` -- SHA-pin all five distinct actions per the table above; add `with: bun-version: 1.3.14` to all three `Set up Bun` steps (adding a `with:` block where none exists, merging into it where one does) -- DW-76 + DW-78 convention.
- [ ] `.github/workflows/publish.yml` -- SHA-pin `checkout`, `setup-bun`, `setup-node`; add `with: bun-version: 1.3.14` to `Set up Bun`. Leave the existing `setup-node` `with:` inputs and the npm pin step untouched -- DW-78 (OIDC credential exposure).
- [ ] `.github/workflows/keyring-spike.yml` -- SHA-pin `checkout` and `setup-bun`, AND raise its existing `bun-version: 1.2.0` to `1.3.14` (updating its adjacent comment if it names the version) -- repo-wide convention consistency; 1.2.0 is the stale outlier, not the precedent.
- [ ] `package.json` -- raise `engines.bun` from `">=1.2.0"` to `">=1.3.14"` -- the suite fails on 1.2.0 (5 tests), so the declared floor is currently a false claim.
- [ ] `README.md:277` -- raise the same advertised floor to `>=1.3.14`, matching `package.json` -- user-facing claim must not outlive the version it was true for.
- [ ] `.github/workflows/release.yml` -- add a short comment above the first `Set up Bun` explaining the pin rationale (reproducible release toolchain, matches the `>=1.3.14` engines floor, bump deliberately) -- mirrors the existing "Pin npm ... Bump this deliberately, never implicitly" comment style in `publish.yml`.
- [ ] `docs/keyring-spike-decision.md` -- rewrite the "runs on an **unpinned** Bun ... deferred as DW-76" clause to state the gate now runs on a pinned Bun `1.3.14`, the same version as every other leg -- the doc's claim is falsified by this change.

**Acceptance Criteria:**
- Given the three workflow files, when every `uses:` line is inspected, then each references a 40-hex commit SHA and carries a trailing `# vX.Y.Z` version comment; no `uses:` line ends in a bare tag.
- Given the pinned SHAs, when each is compared against the action repository, then it is the commit that action's referenced major tag pointed to at the time of this change, and no major version changed.
- Given all three workflows, when every `oven-sh/setup-bun` step is inspected, then each declares `bun-version: 1.3.14`.
- Given the workflows before and after, when diffed, then the only changes are `uses:` values, added `bun-version` inputs (plus the `with:` keys required to hold them), and added explanatory comments — no job, permission, matrix, concurrency, or shell-step change.
- Given `docs/keyring-spike-decision.md`, when searched for "unpinned", then no claim remains that `release.yml` uses an unpinned Bun.

## Spec Change Log

## Review Triage Log

### 2026-07-28 — Review pass

- intent_gap: 1: (high 1, medium 0, low 0)
- bad_spec: 1: (high 0, medium 0, low 1)
- patch: 0
- defer: 0
- reject: 2: (high 0, medium 0, low 2)
- addressed_findings:
  - none

Lower categories are moot: an intent_gap was found, so per the workflow all code changes were
reverted and no patch/defer was actioned. Counts above record the triage performed, not work done.

**intent_gap (high) — the `bun-version: 1.2.0` value mandated by `<intent-contract>` is wrong, and
the correct replacement is not inferable.** Verified independently, not taken from the reviewers:
`src/core/server.test.ts` runs **66 pass / 2 fail** on Bun 1.2.0 and **68 pass / 0 fail** on Bun
1.3.14 (the version `@types/bun ^1.3.14` tracks). One failure is the DW-7 max-request-body guard:
`POST /chat/stream` with an over-limit body returns `413` + a `bad_request` JSON envelope on 1.3.14
but `431` with no envelope on 1.2.0. Because `bun build --compile` embeds the compiling Bun's
runtime, pinning the release matrix to 1.2.0 would bake that regression into **every shipped
binary**, and nothing in `release.yml` would catch it (its only runtime checks are `--version`,
which exits before the Core boots, and the keyring addon gate; no CI runs `bun test`). The spec's
Design Notes justification — "if the code stops working on 1.2.0, the release breaks loudly" — is
therefore falsified, and the added `release.yml` comment's "reproducible" claim overreaches while
the runner images stay floating. Compounding it, `spec-11-2-release-matrix-native.md:182` had
already recorded and rejected exactly this choice: *"pinning to the `>=1.2.0` floor would freeze
release builds on a Bun far older than the one this repo develops against."* This spec reversed
that decision without citing or rebutting it.

**bad_spec (low)** — `## Verification` says "all four occurrences (3 in `release.yml`, 1 each in
`publish.yml`/`keyring-spike.yml`)", which enumerates five; the true count is 5. Moot this pass.

**reject (low ×2)** — (a) DW-76/DW-78 remain `status: open` in `deferred-work.md` and the doc
rewrite drops the "deferred as DW-76" cross-link: by design, the orchestrator records resolution
and this workflow must not edit the ledger. (b) `bun-version` unquoted vs the adjacent quoted
`node-version`: cosmetic, and moot given the value itself is unresolved.

## Design Notes

**Why pin Bun to `1.3.14` (the developed-against version) and not to the floor or to latest.**
SUPERSEDES the original "pin to the floor (1.2.0)" rationale, which the review falsified. That
argument assumed the code still worked on the floor — "if the code stops working on 1.2.0, the
release breaks loudly" — but it already does not: 5 tests fail there, and CI runs `bun test`
nowhere, so nothing would have broken loudly. `bun build --compile` embeds the compiling Bun's
runtime, so the floor pin would have shipped that regression inside every published binary.

`1.3.14` is the version the suite is green on (2118 pass / 0 fail) and the one the project is
developed against, so CI compiles exactly what is tested locally. The `>=1.2.0` floor moves to
`>=1.3.14` in the same change rather than being left as a claim the code cannot honor. Every
`setup-bun` step — including `keyring-spike.yml`'s, which is why the wrong value looked like an
established precedent — carries this one value, so the release gate's addon-load evidence and the
spike's AR-20 attestation stay tied to the same Bun.

**Pin format** — SHA plus a version comment, the convention Dependabot/Renovate read:

```yaml
      - name: Checkout
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0

      - name: Set up Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: 1.3.14
```

## Verification

**Commands:**
- `python3 -c "import yaml,glob;[yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')];print('ok')"` -- expected: `ok` (all three files still parse as valid YAML). If PyYAML is unavailable, skip and rely on the grep checks.
- `grep -rn 'uses:' .github/workflows/` -- expected: every line matches `uses: <owner>/<repo>@<40-hex> # v<semver>`; zero bare-tag references.
- `grep -rnA3 'oven-sh/setup-bun' .github/workflows/` -- expected: all four occurrences (3 in `release.yml`, 1 each in `publish.yml`/`keyring-spike.yml`) followed by `bun-version: 1.3.14`.
- `git diff --stat .github/workflows/` -- expected: only the three workflow files changed, with line counts consistent with `uses:`/`with:` edits and added comments only.
- `grep -n 'unpinned' docs/keyring-spike-decision.md` -- expected: no hit describing `release.yml`'s Bun.

**Manual checks (if no CLI):**
- Each pinned SHA matches the table in the Code Map; no SHA was invented.

