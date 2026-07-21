---
title: 'Bare-command routing — boot the persistent workspace or route to connection onboarding'
type: 'feature'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 11 / Story 11.7
---

<intent-contract>

## Intent

**Problem:** A bare `quick-studio` resolves to Persistent mode (`run-mode.ts:35-38`, default `persistent`) and boots a workspace regardless of whether any connection has ever been saved. For a returning user that is exactly right. For someone who just installed the tool — the entire audience this epic is built for — it opens a browser onto an empty schema tree with no indication that the next step is to add a connection, or that passing a database URL would have started an Ephemeral session immediately. Nothing on the CLI side distinguishes "I have a configured workspace" from "I have nothing at all", and the stderr output on a first run is identical to the output on the thousandth: one listening-URL line. The epic's flow #2 asks for that distinction to be made and acted on.

**Approach:** Add a cheap, read-only presence check and use it for **routing and messaging only**, not for changing what boots.
- Reuse the `store-presence.ts` probe introduced in Story 11.6 — a filesystem presence check over the app-data directory that never decrypts anything.
- When config is present: behavior is byte-for-byte what it is today.
- When it is absent: still boot Persistent (so the user lands somewhere useful), but print a terse stderr hint naming both ways forward, and have the UI open on connection onboarding rather than an empty tree.
- The database URL is asked for **in the UI**, which already owns the connection form from Story 2.4 (`src/ui/settings/SettingsPanel.tsx`, `connections-model.ts`). A terminal prompt for a URL was considered and rejected: it would duplicate a form that already exists, in a worse medium, for a value that frequently contains a password.

## Boundaries & Constraints

**Always:**
- The presence check is a **presence check only** — `existsSync`-class stats on the store descriptor and `.enc`. It must **never** attempt to decrypt, load a key, acquire the store lock, or open the store. Decryption may require the very passphrase prompt that Story 11.6 gates on knowing whether a store exists; making that circular would deadlock the design.
- A store that exists but holds **zero** connections is the **UI's** empty state, not the CLI's business. The CLI's signal is coarse by design: "has this machine ever been set up?"
- When config is present, the boot path is **unchanged** — no new prompt, no new stderr line, no measurable delay.
- The first-run hint is one terse stderr block naming both paths: add a connection in the UI (with the URL already printed above it), or re-run with a database URL for a throwaway Ephemeral session. It is a hint, never an error, and the exit code is unaffected.
- Ephemeral mode (URL positional, `--ephemeral`, or `QS_MODE=ephemeral`) is entirely unaffected — it never consults the probe and never touches the app-data directory.

**Block If:**
- If Story 11.6 has not landed `store-presence.ts`, implement it here to the same contract (no decryption) and update 11.6's Code Map — but do **not** create a second, divergent presence check. One classifier, one source of truth.
- If routing the UI to onboarding requires a new RPC or a change to the token/gate surface, STOP and reconsider: the intended mechanism is an existing boot-state signal the UI already receives, or an additive, credential-free field on one. The RPC contract and auth gates are epic-level invariants.

**Never:**
- Never prompt for a database URL in the terminal. The UI owns that form.
- Never refuse to boot because config is absent — booting into onboarding is strictly better than exiting with an error.
- Never decrypt or open the store to answer "is there config?".
- Never change the mode-selection precedence rules from `cli-args.ts`; this story consumes the resolved mode, it does not influence it.
- Never leak a URL, credential, or file path into the hint text.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Returning user | bare `quick-studio`, store present | Identical to today: listening URL, workspace restored | none |
| True first run | bare `quick-studio`, no app-data dir at all | Boots Persistent, listening URL, plus the first-run hint; UI opens on connection onboarding | Hint only, exit code unaffected |
| Store present, zero connections | store exists but empty | Treated as **configured** — no CLI hint; the UI's existing empty state handles it | Deliberately coarse |
| Explicit persistent, first run | `quick-studio --persistent`, nothing configured | Same as the bare first-run path (plus Story 11.6's setup if the keychain is unavailable) | none |
| Ephemeral | `quick-studio postgres://x` | Probe never runs; no app-data access; no hint | Hard invariant |
| App-data dir unreadable | permissions error on the probe | Treated as "not configured" — degrade to the hint and boot; never crash the CLI over a stat failure | Total, never throws |
| Descriptor absent, `.enc` present | Story 2.2 back-compat layout | Configured — must not misread a legacy keychain-mode store as a first run | Classification must match 11.6's |
| Help/version | `quick-studio --help` | Exits before any probe (Story 11.1) | none |

</intent-contract>

## Acceptance Criteria

- Given existing persistent config, when I run bare `quick-studio`, then the boot is byte-for-byte what it is today — no extra output, prompt, or delay.
- Given no persistent config, when I run bare `quick-studio`, then it still boots Persistent, prints a hint naming both ways forward, and the UI opens on connection onboarding.
- Given the presence check, when it runs, then it performs no decryption, no key load, and no lock acquisition.
- Given Ephemeral mode, when it boots, then the probe never runs and no app-data directory is created.

## Code Map

- `src/core/store-presence.ts` — introduced in Story 11.6; consumed here. If 11.7 runs first, it is created here to the identical contract (Block-If #1).
- `bin/quick-studio.ts` — after mode resolution, when Persistent: run the probe and, when nothing is configured, write the hint to stderr after the listening-URL line at `:80` (so the URL the user needs is printed first — the same ordering rationale as the Port-Exposure Warning at `:87-104`).
- `src/core/server.ts` — thread a credential-free first-run boot signal to the UI. `StartCoreOptions` already carries `mode` and `databaseUrl` (`:114`), so this is an additive peer; the UI already receives boot state, and this must ride that existing channel rather than a new RPC.
- `src/ui/App.tsx` / `src/ui/settings/SettingsPanel.tsx` — on the first-run signal, open onto connection onboarding (the Settings/Connections surface Story 8.6 already made a singleton tab) instead of the default empty tree.
- Tests — presence-classification table (shared with 11.6), a `bin`-level test that the hint appears only when unconfigured, and a UI-level test that the first-run signal selects the onboarding surface.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] Confirm whether `store-presence.ts` already exists from 11.6; consume it or create it to the same contract — never a second implementation.
- [ ] Wire the probe into `bin/` for Persistent mode only; verify Ephemeral never touches the app-data directory.
- [ ] Write the first-run hint (both paths, no paths/credentials leaked), printed after the listening URL.
- [ ] Thread the credential-free first-run signal through the existing boot-state channel — no new RPC, no gate changes.
- [ ] UI: route to connection onboarding on the first-run signal.
- [ ] Tests: classification table, hint-only-when-unconfigured, UI routing.
- [ ] `bun x tsc --noEmit`, `bun test`, `bun run build` green; manually confirm a configured boot is byte-identical to today's.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

## Review Triage Log

<!-- populated by the review loop -->
