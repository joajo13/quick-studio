---
title: 'DW-84 + DW-86: make "descriptor present but .enc missing" an explicit, unopenable state in both crypto stores and the 11.6 unlock pre-flight'
type: 'bugfix'
created: '2026-07-28'
status: 'done'
baseline_revision: 'b753a77'
final_revision: '154128a'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** When a passphrase key descriptor exists but its `.enc` is gone (crash between the descriptor write and the eager `.enc` seed, a failed rollback, or a user deleting the file), the two Epic-2 crypto stores behave in opposite, both-wrong ways. `credential-store.ts` hands the derived key straight to `loadStoreFromFile`, which treats a missing file as an empty store — so **any** passphrase "unlocks" it and the first `saveConnection` silently re-keys the store under a possibly typo'd passphrase (DW-84). `provider-key-store.ts` already guards this and returns `corrupt`, but `first-run-setup.ts` maps `corrupt` → retry, so the 11.6 unlock loop prompts three times against a store no passphrase can ever open, then blames the passphrase (DW-86).

**Approach:** Give the credential store the guard the provider-key store already has (missing `.enc` under a present descriptor → `corrupt`), and teach the presence probe to report descriptor-without-`.enc` as its own fourth `StorePresence` state so the unlock loop can pick a store that is actually openable — or, when none is, short-circuit with one honest, actionable stderr line instead of three futile prompts.

## Boundaries & Constraints

**Always:**
- The credential-store guard is placed in the passphrase-mode arm of `openPersistent` **after** the passphrase provider is consulted and the key derived, exactly mirroring `provider-key-store.ts:410-416` — including its `detail` string `"descriptor present but store file is missing"`. Moving it earlier would break the 11.6 decline-probe, which relies on this arm returning `passphrase-declined` when the provider declines.
- `anyDescriptorPresent` must keep returning `true` for the new state. A descriptor on disk still means "a passphrase is already established for this app dir"; minting a fresh one would derive a different key and orphan the other store.
- The short-circuit path writes nothing, prompts zero times, and returns `{outcome:"skip"}` — never `aborted`, never a throw. `startCore` then reports the store's own typed `corrupt` as it would anyway.
- `first-run-setup.ts` must not re-implement store branch logic: the new decision is made from the plain `existsSync` facts `store-presence.ts` reports, not by inspecting files itself.
- Behavior is unchanged for every layout where the `.enc` is present.

**Block If:**
- The credential-store guard turns out to break an existing green test that legitimately depends on descriptor-without-`.enc` opening successfully (investigation found none; if one appears, it is a contract conflict, not a test to edit away).

**Never:**
- Do not touch `provider-key-store.ts`'s open logic — its guard is already correct; only its regression coverage may be added to.
- Do not change `classifyUnlockAttempt`'s `corrupt` → `retry` mapping. Retrying `corrupt` remains correct everywhere else (a GCM auth-tag failure is indistinguishable from tamper); the fix is to not *enter* the loop against an unopenable store, not to narrow the mapping.
- Do not add recovery, repair, or deletion of orphaned descriptors. Reporting the state is in scope; healing it is not.
- Do not make `PassphraseProvider` async or otherwise touch the 11.6 prompt/transport precedence.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Credential store, descriptor + `.enc` present | any passphrase | Unchanged: correct passphrase → `opened`; wrong → `corrupt` (GCM) | No new error |
| Credential store, descriptor present, `.enc` absent, provider provides | `openCredentialStore({mode:"persistent"})` | `{outcome:"corrupt", detail:"descriptor present but store file is missing"}` — no store returned, nothing written, writer lock released | Typed `corrupt` |
| Credential store, descriptor present, `.enc` absent, provider declines | declining provider | `{outcome:"passphrase-declined"}` (unchanged — provider is consulted first) | Typed |
| Presence probe, descriptor present + `.enc` present | `classifyStorePresence` | `"passphrase-mode"` (unchanged) | n/a |
| Presence probe, descriptor present + `.enc` absent | `classifyStorePresence` | `"orphaned-descriptor"` (new) | n/a |
| Presence probe, `.enc` only / neither | `classifyStorePresence` | `"keychain-mode"` / `"first-run"` (unchanged) | n/a |
| `anyDescriptorPresent` with any `orphaned-descriptor` | either store orphaned | `true` (create path must stay forbidden) | n/a |
| Unlock pre-flight, credential `passphrase-mode` | any providerKeys | Unchanged: loop targets the credential store | n/a |
| Unlock pre-flight, credential `orphaned-descriptor`, providerKeys `passphrase-mode` | interactive TTY | Loop targets the **provider-key** store; exactly one advisory stderr line names the orphaned credential store | Advisory only |
| Unlock pre-flight, only orphaned descriptors (no `passphrase-mode` store) | interactive TTY | **Zero prompts**, one stderr line per orphaned store, `{outcome:"skip"}` | Typed skip |
| `isFirstRunBoot` with an `orphaned-descriptor` store | persistent mode | `false` (a descriptor exists ⇒ not a virgin machine) | Never throws |

</intent-contract>

## Code Map

- `src/core/credential-store.ts` -- `openPersistent`'s passphrase-mode arm (~:551-580); the missing guard goes immediately before `return loadStoreFromFile(mode, derived.key, filePath, release)` at :579. `loadStoreFromFile` at :677-686 is the empty-store-on-missing-file behavior being guarded against. Do not change `loadStoreFromFile` itself — the keychain arm at :600 legitimately relies on it.
- `src/core/provider-key-store.ts` -- the reference implementation of the guard at :410-416. Read-only for the fix; its regression test is missing and gets added.
- `src/core/store-presence.ts` -- `StorePresence` union (:39), `classifyOne` (:58-66), `anyDescriptorPresent` (:102-104), plus the module docstring that describes the state set.
- `src/core/first-run-setup.ts` -- `runUnlockLoop` (:207-260) and its `targetCredential` selection at :211; the call site at :352.
- `src/core/first-run-signal.ts` -- `isFirstRunBoot` (:61-87) consumes `StorePresence`; its `=== "first-run"` comparison already behaves correctly for the new state (verify, do not change).
- `src/core/credential-store.test.ts` -- harness: `makeTempDir()`, `keychainDown`, `providePassphrase(pw)`, `writeDescriptorWith(dir, over)` (:791-808), `STORE_META_FILE_NAME`/`STORE_FILE_NAME` constants. Existing descriptor-only tests (:810, :822, :846) all return before the new guard, so none break.
- `src/core/provider-key-store.test.ts` -- `"descriptor present but .enc removed → corrupt ..."` at :225-244 already covers the existing guard; its open-then-`rmSync`-then-reopen shape is the template for the credential-store regression test.
- `src/core/store-presence.test.ts` -- the presence matrix table at :39-95; five cases assert `"passphrase-mode"` for descriptor-without-`.enc` layouts and must be updated.
- `src/core/first-run-setup.test.ts` -- `spyDeps` (:93-141), `sequence` (:73-80), `fakeCredentialStore`/`fakeProviderKeyStore`; unlock-loop tests at :231-326 all stub `presence` with `"passphrase-mode"` and stay green.
- `src/core/first-run-signal.test.ts` -- the `modes` array at :82 enumerates the union members by hand.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/store-presence.ts` -- add `"orphaned-descriptor"` to the `StorePresence` union; in `classifyOne`, when the descriptor exists, return `"passphrase-mode"` only if the `.enc` also exists, else the new state; include it in `anyDescriptorPresent`; update the module and symbol docstrings to describe four states and say why the new one still counts as "a descriptor is present" -- the probe is the single source both consumers branch on.
- [x] `src/core/credential-store.ts` -- in `openPersistent`'s passphrase-mode arm, immediately before the `loadStoreFromFile` return, add `if (!existsSync(filePath)) return { outcome: "corrupt", detail: "descriptor present but store file is missing" };` with a comment naming the failure it prevents (empty store + any passphrase accepted + first save re-keys) and cross-referencing the identical guard in `provider-key-store.ts` -- closes DW-84.
- [x] `src/core/first-run-setup.ts` -- replace `runUnlockLoop`'s boolean `targetCredential` with a three-way target choice (`credential` when its presence is `passphrase-mode`, else `provider-keys` when *its* presence is `passphrase-mode`, else none); when any store is orphaned emit exactly one stderr line naming that store and what to do; when there is no openable target, return `{outcome:"skip"}` before the first prompt. Update the module docstring's step (6) and `runUnlockLoop`'s docstring -- closes DW-86.
- [x] `src/core/store-presence.test.ts` -- update the five matrix cases whose layout is descriptor-without-`.enc` to expect `"orphaned-descriptor"`, add explicit cases for each store orphaned alone and both orphaned, and extend the `anyDescriptorPresent` mode list to all four states so the discriminator is proven over the full 4×4 grid.
- [x] `src/core/credential-store.test.ts` -- add a regression test for the new guard: create a real passphrase store (`keychainDown` + `providePassphrase`), close it, `rmSync` the `.enc`, reopen with the SAME passphrase → `corrupt`; reopen with a DIFFERENT passphrase → also `corrupt` (never `opened`); and assert no `.enc` was written by the failed open.
- [x] `src/core/provider-key-store.test.ts` -- NO CHANGE NEEDED: the pre-existing guard is already locked in by `"descriptor present but .enc removed → corrupt (no empty-store re-key under an unverified passphrase)"` at :225-244. Confirm it is still green and use its shape as the template for the credential-store regression test above. Do not add a duplicate.
- [x] `src/core/first-run-setup.test.ts` -- add unlock-loop tests for: only-orphaned descriptors → zero prompts + skip + one advisory line; credential orphaned while providerKeys is `passphrase-mode` → targets the provider-key store, one advisory line, still winnable; and `passphrase-mode` credential + orphaned providerKeys → targets the credential store with an advisory. Assert `calls.prompt` exactly.
- [x] `src/core/first-run-signal.test.ts` -- add `"orphaned-descriptor"` to the `modes` array at :82 so `isFirstRunBoot` is proven to report `false` for it.

**Acceptance Criteria:**
- Given a credential store whose descriptor exists and whose `.enc` has been deleted, when `openCredentialStore` is called in persistent mode with any non-empty passphrase, then it returns `corrupt` and no `CredentialStore` is handed out — so no subsequent save can re-key the store under an unverified passphrase.
- Given that same layout, when the pre-flight's decline-probe runs with its always-declining provider, then it still returns `passphrase-declined` (the guard sits after the provider call), so the pre-flight's create-vs-unlock classification is unaffected.
- Given an app dir where every present descriptor is orphaned from its `.enc`, when `runFirstRunSetup` runs in persistent mode on an interactive TTY with no passphrase transport set, then the user is prompted zero times, stderr names each orphaned store, and the result is `{outcome:"skip"}`.
- Given one store in `passphrase-mode` and the other orphaned, when the unlock loop runs, then it targets the `passphrase-mode` store and a correct passphrase still yields `{outcome:"provider"}` — a half-broken app dir stays recoverable.
- Given any layout in which both `.enc` files are present, when the full suite runs, then every pre-existing test is unchanged and green.

## Spec Change Log

## Review Triage Log

### 2026-07-28 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 2, low 8)
- defer: 2: (high 0, medium 2, low 0)
- reject: 9
- addressed_findings:
  - `[medium]` `[patch]` The orphan advisory presented "delete the descriptor" as co-equal to "restore from a backup", but deletion routes to `runCreatePath` which mints a FRESH salt — after which a restored `.enc` is undecryptable by anything, including the correct passphrase. Replaced the single copy-pasted sentence with a per-store `ORPHANED_DESCRIPTOR_NOTICE`, a shared `ORPHANED_DESCRIPTOR_REMEDY` stating restore first and flagging deletion IRREVERSIBLE, and a conditional `ORPHANED_DESCRIPTOR_BLOCKED`.
  - `[medium]` `[patch]` No test pinned `credential: "first-run"`/`"keychain-mode"` × `providerKeys: "orphaned-descriptor"` — the case where a FOREIGN orphan makes `anyDescriptorPresent` true, so `runCreatePath` is unreachable and the app cannot be configured at all. Added both tests plus a comment stating the routing is the data-safe choice and must not be "fixed" into a create; `ORPHANED_DESCRIPTOR_BLOCKED` now explains the silence to the user.
  - `[low]` `[patch]` `isDescriptorPresent` and `unlockTarget` would silently mis-handle a future 5th `StorePresence` member. Both converted to exhaustive `switch` with `never` defaults, each falling back in the safe direction (`isDescriptorPresent` → `true`, so an unknown state can never route to a salt-minting create; `unlockTarget` → target a store, so an unknown state can never become a silent no-prompt skip).
  - `[low]` `[patch]` Retargeting two presence-matrix cases to `orphaned-descriptor` silently dropped all coverage of the `passphrase-mode` × `keychain-mode` mix. Restored both directions.
  - `[low]` `[patch]` `loadStoreFromFile`'s missing-file→`opened` arm is now reachable only by TOCTOU, yet still documents the exact silent-re-key hazard DW-84 exists to prevent. Comment-only: documented that every future caller MUST pre-check (behavior deliberately unchanged per the spec's Never list).
  - `[low]` `[patch]` The new guard's comment overstated what a pre-check guarantees. Reworded to name the residual check-then-check window, and to acknowledge the guard deliberately runs AFTER the scrypt derivation because the decline-probe ordering requires it.
  - `[low]` `[patch]` The provider-key twin's load-bearing ordering (guard AFTER the provider call) was documented and tested nowhere, and the duplicated `detail` literal was asserted on only one side. Added a declining-provider test and pinned the exact string on both stores. Test file only — no source change.
  - `[low]` `[patch]` `first-run-signal.ts`'s "zero connections" comment enumerated only `passphrase-mode`/`keychain-mode` as configured states; `orphaned-descriptor` also classifies as configured. Updated.
  - `[low]` `[patch]` `runUnlockLoop`'s docstring claimed "`startCore` then reports the store's own typed `corrupt` as it would anyway" — false for the `first-run` + foreign-orphan case. Reworded to state only what is guaranteed.
  - `[low]` `[patch]` New tests under-asserted: the wrong-passphrase case checked `outcome` but not `detail`, descriptor survival (the actually unrecoverable outcome) was unchecked, advisory strings were matched by substring, and nothing pinned that the advisory PRECEDES the prompt. All tightened to exact assertions plus a prompt-spy snapshot. Twin cross-reference line numbers made consistent.

### 2026-07-28 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 3, low 4)
- defer: 1: (high 0, medium 1, low 0)
- reject: 14
- addressed_findings:
  - `[medium]` `[patch]` The guard's 8-line placement comment was factually wrong. It claimed the post-`derivePassphraseKey` position is what preserves the decline-probe — but the probe returns from the `declined` check at the top of the arm, before salt parsing, so a hoist to just below it would keep every decline-probe behavior byte-identical. What the post-derivation position ACTUALLY buys — `passphrase-invalid`/`unavailable` keeping precedence over `corrupt` — was stated nowhere and pinned by no test, so that hoist would have silently reclassified an empty passphrase as `corrupt` with the suite green. Rewrote the comment as two separately-named constraints and added `"EMPTY passphrase → passphrase-invalid, not corrupt"` to BOTH stores' tests. `provider-key-store.ts` source left untouched per the Never list; its half is test-only.
  - `[medium]` `[patch]` The remediation was unactionable: "restore the missing file from a backup" never said WHICH file, and the two stores' files sit side by side in one directory. Each notice now names both files from the stores' own exported constants (`STORE_META_FILE_NAME`/`STORE_FILE_NAME` and the provider-key pair) — bare basenames only, no directory, so the codebase's "never leak a path" boundary (`first-run-signal.ts`'s `FIRST_RUN_HINT`) is kept intact.
  - `[medium]` `[patch]` One of the two `trappedCases` — `credential: "keychain-mode"` + `providerKeys: "orphaned-descriptor"` — cannot reach `runUnlockLoop` in production: that layout takes `openPersistent`'s keychain arm, which never calls the passphrase provider, so the decline-probe returns `opened`/`key-unavailable`/`key-invalid` and the pre-flight skips at step (3). The test scripted `passphrase-declined` unconditionally and its comment sold both rows as user-facing traps. Relabelled the row as a synthetic entry point, documented the reachability difference per row, and pointed the real gap at DW-135.
  - `[low]` `[patch]` The same block's stated rationale was false: "a create path overwrites exactly that [the orphaned descriptor]". `runCreatePath` calls `openCredential` only, and the credential store writes only its OWN descriptor — a foreign provider-key descriptor is never touched, so a restored provider `.enc` stays decryptable. Replaced with the real hazard: passphrase DIVERGENCE under the "two descriptors, one passphrase" convention.
  - `[low]` `[patch]` With BOTH stores orphaned the remedy read in the singular, and deleting one descriptor leaves the other orphan blocking the next boot with a byte-identical message — from which the only reading is "the deletion did not work". Added a conditional `ORPHANED_DESCRIPTOR_BOTH` line (both-orphaned only, since with one orphan that deletion genuinely does unblock), plus a test pinning its absence on the single-orphan layout.
  - `[low]` `[patch]` No test asserted the all-clean NEGATIVE case — zero advisory lines when neither store is orphaned. An unconditional notice, or a predicate inverted to `!==`, would have passed every existing advisory test while shouting at every ordinary unlock. Pinned `lines` empty and `calls.stderr === 0` on the clean first-try unlock.
  - `[low]` `[patch]` `first-run-signal.test.ts`'s header still advertised a "3×3 classification matrix" after the union widened to four states. Corrected, and stated why the fourth state reports a configured machine rather than a virgin one.

## Design Notes

**Why a fourth state rather than narrowing `corrupt` → `retry`.** `classifyUnlockAttempt` maps `corrupt` to retry because a wrong passphrase and a tampered `.enc` are cryptographically indistinguishable — that is a correct default and must survive. The unopenable case is distinguishable *before* any key derivation, from `existsSync` alone, which is exactly what the presence probe already reports. So the knowledge lives where it already is, and the loop simply declines to start.

**Why the guard goes after the provider call.** The 11.6 pre-flight's step (3) decline-probe asks the real `openCredentialStore` whether a passphrase is needed, using a provider that always declines. If the missing-`.enc` guard ran before the provider call, that probe would return `corrupt` instead of `passphrase-declined`, the pre-flight would classify it as "a different problem" and `skip` — and the DW-86 short-circuit would never be reached. Placing it after preserves lockstep. `provider-key-store.ts` orders it the same way.

**Target selection, sketched:**

```ts
type UnlockTarget = "credential" | "provider-keys" | "none";
function unlockTarget(p: StorePresenceResult): UnlockTarget {
  if (p.credential === "passphrase-mode") return "credential";
  if (p.providerKeys === "passphrase-mode") return "provider-keys";
  return "none"; // reachable only when every present descriptor is orphaned
}
```

This generalizes the existing credential-first precedence rather than replacing it: with no orphaned stores, `"credential"`/`"provider-keys"` reproduce today's `targetCredential` boolean exactly, and `"none"` is unreachable (`anyDescriptorPresent` gated the call).

## Verification

**Commands:**
- `export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$PATH" && bun test src/core/store-presence.test.ts src/core/first-run-setup.test.ts src/core/first-run-signal.test.ts src/core/credential-store.test.ts src/core/provider-key-store.test.ts` -- expected: all pass, including the new regression tests.
- `export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$PATH" && bun test` -- expected: no new failures versus the pre-change baseline (capture the baseline first; generated `src/core/*.generated.ts` bundles must exist — run `bun run build` if the tree was never built).
- `export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$PATH" && bunx tsc --noEmit` -- expected: clean; in particular the widened `StorePresence` union must not produce an unhandled-case error in `first-run-setup.ts` or `first-run-signal.ts`.

## Auto Run Result

Status: done

### Implemented change

Closed the mirror-image "descriptor present but `.enc` missing" defects in the Epic-2 crypto layer, decided together as the ledger required.

- **DW-84** — `credential-store.ts`'s passphrase-mode arm handed the derived key straight to `loadStoreFromFile`, which treats a missing file as a ready EMPTY store: any passphrase "unlocked" it and the first `saveConnection` silently re-keyed the store under a possibly typo'd passphrase. It now returns `corrupt` for that layout, mirroring the guard `provider-key-store.ts` already had — same placement (after the provider call, so the 11.6 decline-probe still sees `passphrase-declined`) and same `detail` string.
- **DW-86** — `store-presence.ts` gained a fourth state, `orphaned-descriptor`, so the 11.6 unlock loop can tell "wrong passphrase" from "unopenable by any passphrase". `runUnlockLoop` now picks a store that is actually openable, and when none is, declines to prompt at all — zero prompts instead of three futile ones — after explaining what is broken and what to do about it.

### Files changed

- `src/core/credential-store.ts` — the DW-84 guard (+ comment-only hardening around `loadStoreFromFile`'s TOCTOU arm).
- `src/core/store-presence.ts` — fourth `StorePresence` state; `anyDescriptorPresent` counts it via an exhaustive `isDescriptorPresent`.
- `src/core/first-run-setup.ts` — `unlockTarget` replaces the credential-first boolean; orphan notice/remedy/blocked stderr block; short-circuit before the first prompt.
- `src/core/first-run-signal.ts` — doc accuracy only; `isFirstRunBoot` behavior deliberately unchanged (an orphan is configured, not virgin).
- `src/core/store-presence.test.ts` — matrix retargeted to four states, restored `passphrase-mode` × `keychain-mode` mixes, `anyDescriptorPresent` grid widened to 4×4 with an independent oracle.
- `src/core/first-run-setup.test.ts` — six new unlock-loop tests across every orphan combination, with exact stderr assertions and explain-before-ask ordering pinned.
- `src/core/credential-store.test.ts` — DW-84 regression test plus the guard-ordering (declining provider) test.
- `src/core/provider-key-store.test.ts` — test-only: pins the twin's ordering and its shared `detail` literal.

### Review findings breakdown

**Pass 1** — two parallel reviewers. **10 patches applied** (2 medium, 8 low), **2 deferred**, **9 rejected**, 0 intent_gap, 0 bad_spec — no repair loopback was needed.

**Pass 2 (follow-up)** — two parallel reviewers, fresh context. **7 patches applied** (3 medium, 4 low), **1 deferred**, **14 rejected**, 0 intent_gap, 0 bad_spec — again no loopback. The pass converged: no finding reached the intent contract or the spec, and the three medium ones were all accuracy defects in what pass 1 had WRITTEN rather than defects in the fix itself — a comment that misattributed why the guard sits where it does (and a real behavioral invariant left unpinned as a result), a remediation that named no file, and a test whose comment sold an unreachable layout as a user-facing trap.

Deferred this pass as **DW-137**: on `credential: first-run` + `providerKeys: orphaned-descriptor` with no keychain, the foreign orphan makes `runCreatePath` unreachable forever — zero prompts every boot, the app boots dead, and the only escape the product offers is the deletion its own advisory flags IRREVERSIBLE. Pre-existing (the same layout was already unwinnable, just with three futile prompts first) and every fix crosses the spec's "no recovery, repair, or deletion" Never list.

Rejected this pass, beyond pass 1's list: replacing `corrupt` with a new `store-file-missing` outcome arm (a redesign the intent contract explicitly forecloses), matching the guard's `detail` string from inside the pre-flight to catch a mid-typing TOCTOU (already rejected in pass 1), an `lstatSync` probe to tell a dangling symlink from a missing file (would have to change the twin's open logic, which the Never list forbids), sharing the duplicated `detail` literal via an exported constant (the duplication is what makes drift detectable), and three findings that restate the already-deferred DW-135.

Deferred to the ledger as **DW-135** (the orphan remediation is reachable only on the interactive-TTY pre-flight path; a non-interactive boot still gets the misleading `QS_PASSPHRASE_FD` hint, an env-transport boot gets nothing, and a provider-key orphan is invisible when the credential store opens via keychain) and **DW-136** (`connection-registry.ts` collapses all eight non-`opened` store arms into one generic `internal_error`, so no store-health remediation reaches the UI). Both are pre-existing and both fixes would cross standing 11.6 boundaries, so they belong to a focused pass.

Rejected as noise or as contradicting the frozen intent contract: hoisting the guard above the provider call (would break the decline-probe and make the DW-86 path unreachable), emitting `FD_TRANSPORT_HINT` on the no-openable-target path (would recreate the very "blame the passphrase" defect being fixed), restructuring `loadStoreFromFile`, adding an injectable `existsSync` seam to `CredentialStoreDeps`, and matching on a store's `detail` string from inside the pre-flight.

### Verification

- `bunx tsc --noEmit` — clean, exit 0 (baseline was also clean).
- `bun test` — **2071 pass, 1 skip, 0 fail** across 94 files, 10763 assertions. Baseline before the change was 2039 pass / 0 fail, so this adds 32 tests and regresses nothing. (Pass 1 ended at 2068; pass 2 added the two empty-passphrase precedence tests and the single-orphan negative test.)
- Every acceptance criterion was checked against a named test rather than by inspection; the two spec claims that could have been wrong (no existing test depends on descriptor-without-`.enc` opening; the twin guard's ordering) were verified directly in the source.

### Residual risks

- A genuinely narrow check-then-check TOCTOU survives in both stores: an `rm` landing between the guard's `existsSync` and `loadStoreFromFile`'s own stat falls through to the documented "treat as first run" arm. Pre-existing in the twin, deliberately not fixed here (the spec forbids changing `loadStoreFromFile`), and now documented at both sites.
- `existsSync` returns `false` for a file that exists but is unreachable (dangling symlink, unreadable parent directory), so such a store would be reported as orphaned. The remedy text was rewritten to lead with restore and to flag deletion as irreversible precisely so this misclassification cannot talk a user into destroying recoverable data.
- The user-facing consequence of this change is entirely on stderr and only on the interactive pre-flight path — see DW-135/DW-136 for where it does not yet reach, and DW-137 for the layout where the advice, once it does reach the user, has no safe action behind it.
- The advisory now embeds the four store file basenames. They come from the stores' own exported constants in the source and are spelled out literally in the tests, so a rename turns the test red rather than desynchronising the advice from disk — but that only holds for renames of those constants, not for a store that starts resolving its file name some other way.
