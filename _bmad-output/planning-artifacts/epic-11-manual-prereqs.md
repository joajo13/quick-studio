# Epic 11 — Manual prerequisites (operator, not loop)

Everything in Epic 11's stories is code, workflows, generated manifests, and docs — all
loop-executable. These are the steps that need credentials, an account, or a browser, and
therefore cannot be delegated. Every story can be *implemented and unit-tested* without them;
nothing can be *verified end to end* until they are done.

## Decided (no longer open)

**Package naming.** Main package **unscoped `quick-studio`**; per-platform binary packages
**scoped `@quick-studio/<platform>-<arch>`**. The esbuild layout. The unscoped name is what
keeps `npx quick-studio <db-url>` a single command; the scope is what reserves the binary
namespace wholesale.

**Platform scope.** Windows and Linux are first-class this epic (`win32-x64`, `linux-x64`,
`linux-arm64`). **macOS is a later phase** — the keyring spike never validated darwin, and a
published darwin binary would promise a keychain path nobody has proven. Stories 11.2, 11.3
and 11.4 all consume one shared platform list precisely so that phase is additive.

## Claim the names (do this first — it is the only time-sensitive item)

Both were unregistered as of 2026-07-21. Neither is expensive; both are gone the moment
someone else takes them.

**1. Log in to npm.** Interactive/browser auth, so it has to be you:

```
! npm login
```

**2. Create the `quick-studio` organization** at <https://www.npmjs.com/org/create>. Free for
public packages. There is no CLI for org *creation* (`npm org` only manages members of an org
that already exists), which is why this step cannot be automated. Creating the org is what
reserves the **entire** `@quick-studio/*` namespace — you do not need to publish placeholder
packages for each platform.

**3. Publish the unscoped placeholder** to hold `quick-studio` itself. A ready-to-publish
package is prepared (see the session notes / scratchpad `npm-placeholder/`); it is a minimal
`0.0.1` that states the project is in development and points at the repo. Publishing it is a
public, effectively irreversible act — npm only allows unpublishing within 72 hours, and the
name stays blocked afterwards either way — so read the manifest before you push it.

## Before the first real release

**4. Wire the git remote.** `git remote -v` is currently empty, so `.github/workflows/release.yml`
has never run and the README's `../../releases` links resolve to nothing.

**5. Add `NPM_TOKEN` to GitHub repository secrets.** Use an npm **automation** token — a
classic publish token tied to interactive 2FA cannot work unattended in CI. Story 11.4's
`publish.yml` reads it. If provenance attestation is wanted, also grant `id-token: write`.

**6. Push the first `v*` tag — but only after Story 11.4 has landed.** A tag pushed earlier
triggers the old two-platform `release.yml` and burns a version number for a release you do
not want.

## Accepted, deliberately not solved by this epic

- **macOS.** A later phase, by design. Adding it means adding rows to the shared platform
  list and letting the keyring gate prove the leg — not restructuring anything.
- **Code signing / notarization.** An unsigned `.exe` from GitHub Releases trips Windows
  SmartScreen. The epic's answer is that **npm is the primary channel**, which sidesteps it
  entirely; the standalone binary stays available for people who accept the warning. Signing
  is its own epic (certificates, secrets, CI round-trips).
- **In-place binary self-update.** Story 11.5 delegates instead of self-replacing. Replacing a
  running executable on Windows needs a rename-then-replace dance and a restart, and npm/npx
  already solve updating for the primary channel.
- **Homebrew tap / Scoop bucket / winget manifest.** Straightforward once releases carry
  checksums (11.2 emits `SHA256SUMS`, which is what all three consume), but each is an external
  repository with its own review process. Post-epic.
- **Windows-on-ARM.** No runner, no demand signal yet.
