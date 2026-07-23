# Epic 11 — Manual prerequisites (operator, not loop)

Everything in Epic 11's stories is code, workflows, generated manifests, and docs — all
loop-executable. These are the steps that need credentials, an account, or a browser, and
therefore cannot be delegated. Every story can be *implemented and unit-tested* without them;
nothing can be *verified end to end* until they are done.

## Decided (no longer open)

**Package naming.** Everything **unscoped**: `quick-studio` for the main package, and
`quick-studio-<platform>-<arch>` for each prebuilt binary. The `quick-studio` npm organization
name was not available, and unscoped needs no org — which removes a whole setup step and the
`--access public` footgun that scoped publishing carries.

The tradeoff accepted: an unscoped prefix reserves nothing, so somebody could publish
`quick-studio-darwin-arm64` before the macOS phase gets there. Mitigated by publishing
placeholders for the darwin names up front (step 3).

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

**2. No organization needed.** The `quick-studio` org name was taken, and the unscoped layout
makes it moot. Nothing to do here.

**3. Publish the unscoped placeholder** to hold `quick-studio` itself. A ready-to-publish
package is prepared (scratchpad `npm-placeholder/`); it is a minimal `0.0.1` that states the
project is in development. Publishing it is a public, effectively irreversible act — npm only
allows unpublishing within 72 hours, and the name stays blocked afterwards either way.

**These bootstrap publishes require 2FA on the npm account.** A first attempt on 2026-07-21
as `joajo13` returned `E403: Two-factor authentication or granular access token with bypass
2fa enabled is required to publish packages`. The bypass-token escape hatch is being retired
(see step 5), so enabling 2FA is the path — and it is a one-time cost, not an ongoing one:
after the four bootstrap publishes, CI goes through OIDC and never sees a 2FA prompt again.
Account 2FA is also what stops a compromised npm login from pushing malware to everyone who
installs this package.

**There is no way around this initial publish.** npm cannot publish the *first* version of a
package via OIDC: a trusted publisher is registered in the package's own Settings page on
npmjs.com, which does not exist until the package does. (PyPI allows pre-configuring an
unpublished name; npm does not — `npm/cli` issue #8544 tracks the gap.) So every one of the
four packages needs one manual bootstrap publish before CI can ever take over.

**Publish all six placeholders in one sitting** — prepared in the scratchpad under
`npm-placeholders/`: `quick-studio` plus `quick-studio-{win32-x64,linux-x64,linux-arm64}` (the
three this epic ships) and `quick-studio-{darwin-arm64,darwin-x64}` (reserving the macOS phase
against squatters). Unscoped packages are public by default, so no `--access` flag is needed
anywhere.

## Before the first real release

**4. Wire the git remote.** `git remote -v` is currently empty, so `.github/workflows/release.yml`
has never run and the README's `../../releases` links resolve to nothing.

**5. Configure a trusted publisher for each package** at npmjs.com → package → Settings →
Trusted Publisher. There is **no `NPM_TOKEN` and no token of any kind** — Story 11.4's
`publish.yml` authenticates via OIDC, which GitHub Actions mints per run.

Register the four packages this epic actually publishes (`quick-studio`,
`quick-studio-win32-x64`, `quick-studio-linux-x64`, `quick-studio-linux-arm64`), each pointing
at this repo and the workflow filename `publish.yml`. The darwin placeholders need this only
when the macOS phase starts. Only one trusted publisher is allowed per package and the
filename must match exactly, so `publish.yml` must not be renamed afterwards without
reconfiguring every one of them.

Why not a token: npm is retiring the 2FA-bypass granular access tokens that unattended
publishing depended on — they lose sensitive account operations in **August 2026** and lose
direct publishing around **January 2027**, degrading to staged publishes that need human 2FA
approval anyway. Trusted publishing is npm's own recommended replacement and needs neither a
stored secret nor 2FA. Requirements it imposes on the workflow: npm CLI >= 11.5.1,
Node >= 22.14.0, GitHub-hosted runners only.

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
