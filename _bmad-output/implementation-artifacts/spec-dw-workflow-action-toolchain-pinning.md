---
title: 'Supply-chain hardening: SHA-pin GitHub Actions and pin the Bun toolchain'
type: 'chore'
created: '2026-07-28'
status: done
baseline_revision: '03a2aed'
final_revision: '01027ee'
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
- [x] `.github/workflows/release.yml` -- SHA-pin all five distinct actions per the table above; add `with: bun-version: 1.3.14` to all three `Set up Bun` steps (adding a `with:` block where none exists, merging into it where one does) -- DW-76 + DW-78 convention.
- [x] `.github/workflows/publish.yml` -- SHA-pin `checkout`, `setup-bun`, `setup-node`; add `with: bun-version: 1.3.14` to `Set up Bun`. Leave the existing `setup-node` `with:` inputs and the npm pin step untouched -- DW-78 (OIDC credential exposure).
- [x] `.github/workflows/keyring-spike.yml` -- SHA-pin `checkout` and `setup-bun`, AND raise its existing `bun-version: 1.2.0` to `1.3.14` (updating its adjacent comment if it names the version) -- repo-wide convention consistency; 1.2.0 is the stale outlier, not the precedent.
- [x] `package.json` -- raise `engines.bun` from `">=1.2.0"` to `">=1.3.14"` -- the suite fails on 1.2.0 (5 tests), so the declared floor is currently a false claim.
- [x] `README.md:277` -- raise the same advertised floor to `>=1.3.14`, matching `package.json` -- user-facing claim must not outlive the version it was true for.
- [x] `.github/workflows/release.yml` -- add a short comment above the first `Set up Bun` explaining the pin rationale (reproducible release toolchain, matches the `>=1.3.14` engines floor, bump deliberately) -- mirrors the existing "Pin npm ... Bump this deliberately, never implicitly" comment style in `publish.yml`.
- [x] `docs/keyring-spike-decision.md` -- rewrite the "runs on an **unpinned** Bun ... deferred as DW-76" clause to state the gate now runs on a pinned Bun `1.3.14`, the same version as every other leg -- the doc's claim is falsified by this change.

**Acceptance Criteria:**
- Given the three workflow files, when every `uses:` line is inspected, then each references a 40-hex commit SHA and carries a trailing `# vX.Y.Z` version comment; no `uses:` line ends in a bare tag.
- Given the pinned SHAs, when each is compared against the action repository, then it is the commit that action's referenced major tag pointed to at the time of this change, and no major version changed.
- Given all three workflows, when every `oven-sh/setup-bun` step is inspected, then each declares `bun-version: 1.3.14`.
- Given the workflows before and after, when diffed, then the only changes are `uses:` values, added `bun-version` inputs (plus the `with:` keys required to hold them), and added explanatory comments — no job, permission, matrix, concurrency, or shell-step change.
- Given `docs/keyring-spike-decision.md`, when searched for "unpinned", then no claim remains that `release.yml` uses an unpinned Bun.

## Spec Change Log

### 2026-07-28 — Re-drive (second implementation pass)

- `baseline_revision` moved `97a4f79` -> `03a2aed` (the commit that recorded the user's pin decision).
- Cleared the outstanding **bad_spec (low)** from the first review pass: `## Verification` said "all four
  occurrences" while enumerating five; corrected to "all five" and widened the grep to `-A4` so the
  `bun-version` line is actually inside the context window for the steps that carry a `with:` block.
- **All six SHAs in the Code Map table re-verified independently** against the live action repositories
  via `git ls-remote --tags` on 2026-07-28. Every one is still the exact commit its referenced *major*
  tag resolves to today, so no table value changed and no major version moves:
  `actions/checkout@v4 -> 11d5960…` (v4.4.0), `oven-sh/setup-bun@v2 -> 0c5077e…` (v2.2.0),
  `actions/upload-artifact@v4 -> ea165f8…` (v4.6.2), `actions/download-artifact@v4 -> d3f86a1…` (v4.3.0),
  `softprops/action-gh-release@v2 -> 3bb1273…` (v2.6.2), `actions/setup-node@v4 -> 49933ea…` (v4.4.0).
  This discharges the `Block If: a resolved SHA cannot be confirmed against the action repository`.
- **One edit beyond the literal task list, kept deliberately:** `docs/keyring-spike-decision.md` line **5**
  (`**Runtime:** Bun >=1.2.0`) was raised to `>=1.3.14` alongside the line-6 rewrite the task named.
  It is the same advertised floor `package.json` and `README.md:277` raise, so leaving it would have
  left a now-false claim inside the very doc this change corrects — the exact failure mode the Intent's
  "Consequence that is IN SCOPE" note exists to prevent. No other file states the floor (repo-wide grep).

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

### 2026-07-28 — Review pass (second drive)

- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 5: (high 0, medium 3, low 2)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[patch]` The pin-rationale comment was attached to the `platforms` job's `Set up Bun`
    (literal compliance with "above the first `Set up Bun`"), a job that runs only `platforms.ts` and
    compiles nothing. The two steps the rationale actually describes -- `build` (where
    `bun build --compile` runs, `release.yml:107`/`:133`) and `release` -- carried no comment, so a
    maintainer editing the shipping pin saw no warning. Moved the compile rationale to the `build`
    job's step and left a short accurate pointer on `platforms`. Folded in the prior pass's unrebutted
    "reproducible overreaches while the runner images float" finding by scoping the claim explicitly:
    the comment now states it pins the runtime, not the build environment, and names `runs-on` as
    still floating.
  - `[medium]` `[patch]` Design Notes asserted "CI runs `bun test` nowhere" as the load-bearing
    justification for overriding `spec-11-2`'s pin decision. False: `keyring-spike.yml:73` and `:110`
    both run `bun test`. The conclusion survives (both run only `src/core/keychain.test.ts`;
    `src/core/server.test.ts`, which holds the DW-7 failures, is run by no workflow), but the stated
    premise did not. Rewritten to the precise claim so a future auditor of this decision finds a
    premise that holds.
  - `[low]` `[patch]` The `## Verification` grep amended earlier THIS pass (`-A3` -> `-A4`) still did
    not work: `keyring-spike.yml`'s 4-line in-`with:` comment puts its `bun-version` 6 lines below the
    `uses:`, so `-A4` reported 4 of 5 -- indistinguishable from a dropped pin. Now `-A7` piped to
    `grep -c`, expected `5`, with the reason recorded inline. Verified: returns `5` as written.
  - `[low]` `[patch]` `publish.yml` was the only one of five sites written quoted
    (`bun-version: "1.3.14"`), contradicting the spec's own Design Notes format snippet and all five
    task lines, and defeating any literal grep of the pin value. Unquoted for uniformity; YAML parses
    both as the string `1.3.14` (re-checked with `yaml.safe_load`). Supersedes the prior pass's
    opposite `reject` on quoting -- one convention now holds across all five.
  - `[low]` `[patch]` `docs/keyring-spike-decision.md:6` claimed the pin was "the resolution of DW-76"
    while the ledger still records DW-76 `open`. This workflow is forbidden from editing the ledger, so
    it must not assert a ledger state it cannot set. Reworded to "this is what DW-76 asked for" --
    states the fact, leaves the status to the orchestrator.
  - `[low]` `[patch]` `docs/keyring-spike-decision.md:5` read `**Runtime:** Bun >=1.3.14` -- a floor,
    the exact category error the Intent argues against ("a floor is a minimum, not a pin value"), and
    it would read as satisfied by Bun 2.0, which no leg will ever run. Now states the exact pin and
    the floor separately.

**Deferred findings -- recorded HERE, not in the ledger.** The `<intent-contract>` Never list and the
invocation both forbid this workflow from editing `deferred-work.md`; the orchestrator owns it. The
five items below are real and confirmed, and need to be transcribed into the ledger by whoever records
this bundle's resolution. Not doing so loses them.

1. `[medium]` **SHA-pinning hardens the action's code, not its payload -- DW-78's threat model is only
   half-closed.** `oven-sh/setup-bun@v2.2.0`'s `action.yml` exposes no checksum/integrity input; it
   downloads the Bun binary from a GitHub release asset at runtime, and release assets are mutable. A
   compromise of the `bun-v1.3.14` asset still yields arbitrary code execution inside the
   `id-token: write` job, i.e. the OIDC npm publish credential remains reachable. DW-78 is about to be
   marked resolved on the strength of a pin that does not cover this.
2. `[medium]` **Nine hardcoded copies of `1.3.14`, no single source of truth and no enforcement.**
   `release.yml:50,101,168`, `publish.yml:43`, `keyring-spike.yml:44`, `package.json:16`,
   `README.md:277`, `docs/keyring-spike-decision.md:5,6`. The change's central invariant ("one value
   everywhere so the release gate and the spike attest to the same runtime") has zero CI guard -- the
   next bump can miss `publish.yml` with no signal. `engines.bun` is also advisory: nothing hard-fails
   a contributor on 1.2.x, who gets a green `bun install` and 5 red tests with no pointer to the floor.
   **Intel for whoever fixes this:** `bun-version-file: package.json` is NOT a safe single source --
   `setup-bun@v2.2.0` `src/utils.ts:124` falls back to `engines.bun`, a `>=` range that resolves to the
   newest match, silently restoring the "latest" behavior this change exists to remove. A
   `.bun-version` file (`src/utils.ts:129`, content used verbatim) is the mechanism that works.
3. `[medium]` **SHA pins with no automated bump mechanism will rot.** No `.github/dependabot.yml` or
   `renovate.json` exists. Adding one was explicitly out of scope here ("pin only"), but immutable pins
   plus no updater means action security patches never land.
4. `[low]` **`docker/Dockerfile:8` is `FROM oven/bun:1`** -- a floating major. The dev container runs an
   unpinned Bun while the repo-wide convention this change establishes says otherwise.
5. `[low]` **`docs/keyring-spike-decision.md:25` reasons "no `v*` tag has been pushed, so neither
   workflow has run" -- a non-sequitur for the spike.** `keyring-spike.yml:10-19` triggers on `push`
   with `paths:` including `package.json` and `.github/workflows/keyring-spike.yml`, BOTH modified by
   this change. Pre-existing bad reasoning, but see Residual Risks: pushing this commit starts the
   first-ever spike run.

**Rejected (recorded for the audit trail, with rebuttals):** (a) `review_loop_iteration: 0` called
stale -- it is correct: the workflow increments only before a `bad_spec` loopback, and the prior pass
ended in an `intent_gap` HALT, which does not increment. (b) Published npm manifests omit an
`engines.bun` -- correct as-is; `scripts/build-npm-packages.ts` ships a shim that runs under Node, not
Bun, so a Bun floor there would be a false constraint. (c) "Raising `keyring-spike.yml` from 1.2.0
removed the only leg exercising a non-current Bun" -- that leg was never a version matrix (its comment
says it pinned for attestation stability), and the user's 2026-07-27 decision names it explicitly as
the stale outlier to raise. (d) `deferred-work.md:855`'s evidence text still cites the now-deleted
`>=1.2.0` floor -- real, but the ledger is the orchestrator's to edit. (e) README's floor sits under
`## Development` and that README is copied into the published npm package -- the section framing is
correct for a Bun-only dev requirement.

## Design Notes

**Why pin Bun to `1.3.14` (the developed-against version) and not to the floor or to latest.**
SUPERSEDES the original "pin to the floor (1.2.0)" rationale, which the review falsified. That
argument assumed the code still worked on the floor — "if the code stops working on 1.2.0, the
release breaks loudly" — but it already does not: 5 tests fail there, and no CI job runs the
test that would catch it, so nothing would have broken loudly. (Precisely: CI *does* run `bun test`
in two places -- `keyring-spike.yml:73` and `:110` -- but both run only `src/core/keychain.test.ts`.
`src/core/server.test.ts`, which holds the DW-7 body-guard failures, is executed by no workflow. The
conclusion stands; the blanket "CI runs `bun test` nowhere" phrasing this replaces did not.) `bun build --compile` embeds the compiling Bun's
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
- `grep -rnA7 'oven-sh/setup-bun' .github/workflows/ | grep -c 'bun-version'` -- expected: `5` (3 in `release.yml`, 1 each in `publish.yml`/`keyring-spike.yml`), each value `1.3.14`. **`-A7`, not `-A4`:** `keyring-spike.yml` carries a 4-line comment inside its `with:` block, so its `bun-version` sits 6 lines below the `uses:` and any narrower window silently reports 4 of 5 -- indistinguishable from a genuinely dropped pin.
- `git diff --stat .github/workflows/` -- expected: only the three workflow files changed, with line counts consistent with `uses:`/`with:` edits and added comments only.
- `grep -n 'unpinned' docs/keyring-spike-decision.md` -- expected: no hit describing `release.yml`'s Bun.

**Manual checks (if no CLI):**
- Each pinned SHA matches the table in the Code Map; no SHA was invented.


## Auto Run Result

Status: done

### Summary

One supply-chain hardening pass over `.github/workflows/`, resolving **DW-76** (unpinned Bun build
toolchain) and **DW-78** (mutable-tag actions inside an `id-token: write` job). Every third-party
action across all three workflows now resolves to an immutable commit SHA, and all five `setup-bun`
steps pin `bun-version: 1.3.14`. Per the user's 2026-07-27 escalation decision, the pin is the
developed-against version rather than the `>=1.2.0` floor, and the now-false advertised floor was
raised to `>=1.3.14` in the same change.

This was the **second drive**. The first pinned `1.2.0` off the floor, review proved the runtime fails
there, and all code was reverted pending the user's decision.

### Files changed

- `.github/workflows/release.yml` -- 5 distinct actions SHA-pinned (9 `uses:` lines); `bun-version:
  1.3.14` added to all 3 `Set up Bun` steps; pin rationale sited at the `build` job where
  `bun build --compile` actually runs, with a short pointer on `platforms`.
- `.github/workflows/publish.yml` -- `checkout`/`setup-bun`/`setup-node` SHA-pinned; Bun pin added.
  The OIDC job's Node/npm pins and step bodies untouched.
- `.github/workflows/keyring-spike.yml` -- `checkout`/`setup-bun` SHA-pinned; its stale `1.2.0` pin
  raised to `1.3.14`; existing attestation comment preserved and extended.
- `package.json` -- `engines.bun` `>=1.2.0` -> `>=1.3.14`.
- `README.md:277` -- same advertised floor raised. No other file states it.
- `docs/keyring-spike-decision.md` -- the "runs on an **unpinned** Bun" claim this change falsifies,
  rewritten; the header `**Runtime:**` field moved from a floor to the exact pin.

### Review findings

- **intent_gap 0, bad_spec 0** -- no loopback. **6 patches applied** (2 medium, 4 low), **5 deferred**,
  **5 rejected with rebuttals**. Full detail in the Review Triage Log entry above.
- The two medium patches were both accuracy defects rather than code defects: a pin-rationale comment
  filed on the one job that compiles nothing, and a load-bearing Design Notes premise ("CI runs
  `bun test` nowhere") that was factually false.
- **The 5 deferred findings are recorded in the Review Triage Log, NOT in `deferred-work.md`** -- the
  intent contract and the invocation both forbid this workflow from editing the ledger. They must be
  transcribed by whoever records this bundle's resolution, or they are lost.

### Verification performed

All re-run after the patches, in the working tree:

- `python3 yaml.safe_load` over all three workflows -- `ok`.
- All 14 `uses:` lines matched against `@<40-hex> # v<semver>` -- **0 non-conforming**, 0 bare tags.
- All six SHAs independently re-resolved via `git ls-remote --tags` against the live action repos.
  Each is the exact commit its referenced **major** tag points to today; no major moved, no SHA
  fabricated. This discharges the `Block If`.
- `grep -rnA7 'oven-sh/setup-bun' … | grep -c 'bun-version'` -- returns **5**, all `1.3.14`.
- `1.2.0` sweep over workflows + `package.json` + `README.md` + the doc -- **no hits**.
- `grep 'unpinned' docs/keyring-spike-decision.md` -- **0**.
- `package.json` parses; `engines` = `{node: >=18, bun: >=1.3.14}`.
- Full diff read line by line: only `uses:` values, `with:`/`bun-version` additions, comments, and the
  four documented non-workflow edits. No job, permission, matrix, concurrency, or shell-step change.

Not run: the test suite. This change touches no application code.

### Residual risks

1. **DW-78 is only half-closed.** SHA-pinning secures the action's code, not the Bun binary it
   downloads at runtime from a mutable GitHub release asset. The OIDC publish credential is still
   reachable by a compromise of that asset. Deferred item 1 -- read it before marking DW-78 resolved.
2. **Pushing this commit starts the first-ever `keyring-spike.yml` run.** It triggers on `push` with
   `paths:` including `package.json` and its own file, both modified here. A 3-OS run (ubuntu /
   windows / macos) fires on a workflow that has never executed, including
   `KEYRING_REQUIRE_ROUNDTRIP=1` on macOS. Not a defect, but it is a side effect of an `engines`-only
   `package.json` edit and should not be a surprise.
3. **Nothing enforces the one-value invariant** across the nine hardcoded `1.3.14` sites, and
   `engines.bun` is advisory. Deferred item 2 (including the finding that `bun-version-file:
   package.json` would silently restore "latest" behavior).
4. **`release.yml` has still never run** -- no `v*` tag has been pushed, so the pinned matrix is
   enforced but unobserved.
5. **The ledger is self-contradicting until the orchestrator acts:** DW-76/DW-78 read `status: open`,
   and DW-76's evidence still cites the `>=1.2.0` floor that no longer exists in the repo.
