# Epic 11 — Manual prerequisites (operator, not loop)

Everything in Epic 11's stories is code, workflows, generated manifests, and docs — all
loop-executable. These are the steps that need credentials, an account, or a decision, and
therefore cannot be delegated. Nothing in the epic can be *verified end to end* until they
are done, though every story can be *implemented and unit-tested* without them.

## Before the loop runs

**1. Decide the platform-package naming.** Blocks Story 11.4 (it is that story's first
Block-If). Two options:

- **Unscoped** — `quick-studio-linux-x64`, `quick-studio-darwin-arm64`, … Needs nothing but
  the npm account. This is the spec's default.
- **Scoped** — `@quick-studio/linux-x64`, … Cleaner and squats less of the unscoped
  namespace, but requires an npm **organization** named `quick-studio` to exist first.

If the org is wanted, create it before 11.4 runs and say so — it is a one-constant change in
`scripts/build-npm-packages.ts`, but only if the decision is made up front.

**2. Claim the npm name.** `quick-studio` was unregistered as of 2026-07-21. It is the
product's whole distribution identity and it is free right now; publishing a `0.0.1`
placeholder costs nothing and removes the risk of losing it mid-epic.

## Before the first release can be verified

**3. Wire the git remote.** `git remote -v` is currently empty. `.github/workflows/release.yml`
has therefore never run, and the README's Install section links to `../../releases`, which
resolves to nothing. Add the origin and push the branch.

**4. Add `NPM_TOKEN` to repository secrets.** An npm **automation** token (not a publish token
tied to 2FA prompts, which cannot work unattended in CI). Story 11.4's `publish.yml` reads it.
Consider also enabling `id-token: write` if provenance attestation is wanted.

**5. Push the first `v*` tag.** This is what triggers both `release.yml` (11.2) and
`publish.yml` (11.4). Do it only after 11.4 has landed — a tag pushed earlier runs the old
two-platform release workflow and burns a version number.

## Accepted, deliberately not solved by this epic

- **Code signing / notarization.** An unsigned `.exe` downloaded from GitHub Releases trips
  Windows SmartScreen; an unsigned Mach-O trips macOS Gatekeeper. Both cost money and identity
  verification. The epic's answer is to make **npm the primary channel**, which sidesteps both
  entirely — the standalone binary stays available for people who want it and accept the
  warning. If signing is wanted later it is its own epic (certificates, secrets, notarization
  round-trips in CI).
- **In-place binary self-update.** Story 11.5 deliberately delegates instead of self-replacing.
  Replacing a running executable on Windows requires a rename-then-replace dance and a restart;
  npm and npx already solve updating for the primary channel.
- **Homebrew tap / Scoop bucket / winget manifest.** Straightforward once releases with
  checksums exist (Story 11.2 produces `SHA256SUMS`, which is what all three want), but each is
  an external repository with its own review process. Post-epic work.
- **Windows-on-ARM.** No runner, no demand signal yet.
