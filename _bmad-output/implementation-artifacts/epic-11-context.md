# Epic 11 Context: One-Command Distribution & First-Run Setup

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make quick-studio installable and runnable by anyone with one command, and make the CLI resolve all three launch flows correctly. The product is code-complete but undistributed today: no git remote, no tag ever pushed, no npm package, and the one channel that exists is a trap — `bin` points at a Bun-shebang script, so a global npm install on a machine without Bun installs cleanly and then dies at launch. This epic makes npm the primary channel via a platform-package pattern (a Node-compatible shim plus one prebuilt-binary package per platform, resolved through `optionalDependencies`), so `npx quick-studio <db-url>` works with zero Bun installed, and npm itself supplies install/update/launch behavior instead of a bespoke bootstrapper. The three flows it must close: (1) `quick-studio <db-url>` → Ephemeral, installing/updating/launching as needed; (2) bare `quick-studio` → boot persistent workspace if config exists, else route to connection onboarding; (3) `quick-studio --persistent` on first run → run first-run setup instead of silently booting a store it may not be able to unlock.

## Stories

- Story 11.1: CLI surface — `--help`, `--version`, explicit `--ephemeral`
- Story 11.2: Release matrix on native runners, with checksums and a keyring gate
- Story 11.3: Node-compatible launcher shim
- Story 11.4: Platform packages and an end-to-end publish workflow
- Story 11.5: Update availability check and the `update` command
- Story 11.6: First-run setup for Persistent mode (passphrase prompt)
- Story 11.7: Bare-command routing — boot or onboard

## Requirements & Constraints

- Realizes FR-1 (one-command install) and FR-2 (one-command run + mode selection) end-to-end via the dual-distribution model already decided at architecture time (standalone per-platform binary + npm/runtime package), now made to actually work rather than trap the npm path.
- **Hard invariants that must not change:** default loopback (`127.0.0.1`) binding, the per-boot session capability token, the Origin/Host anti-rebinding gates, the RPC reply contract, and the Port-Exposure Warning. This epic only touches packaging and pre-boot CLI decisions, never the Core's security surface.
- **Ephemeral-mode disk-write invariant extends to every new mechanism this epic adds**: the update-availability cache, any version-check file, and the first-run setup wizard must never write to disk (or read a cache) when running Ephemeral — the Epic 2 promise outranks all of them.
- **Platform scope:** windows-x64, linux-x64, linux-arm64 are first-class. macOS is deliberately deferred (the `@napi-rs/keyring` spike never validated darwin, only recorded it as "pending CI, expected GO"). Every seam (release matrix, shim's platform map, packaging script) must be table-driven off one shared platform list so adding darwin later is additive, not a restructure.
- Out of scope: macOS binaries, code signing/notarization (accepted SmartScreen friction on the standalone-binary channel; npm is the recommended path specifically because it sidesteps this), Homebrew/Scoop/winget manifests, true in-place binary self-replacement, Windows-on-ARM.
- Package naming is decided, not open: unscoped `quick-studio` (main) and `quick-studio-<platform>-<arch>` per binary package (`win32-x64`, `linux-x64`, `linux-arm64`; darwin names reserved as placeholders against squatting).
- Manual, non-loop-executable prerequisites exist and gate end-to-end verification (not implementation): claiming/publishing the six package names (first publish of any new npm package cannot go through OIDC — must be a manual, 2FA-gated publish), wiring the git remote, registering a trusted publisher (OIDC, no `NPM_TOKEN`/token of any kind) per published package pointing at the exact workflow filename `publish.yml`, and pushing the first `v*` tag only after Story 11.4 has landed (an earlier tag would trigger the old two-platform workflow and burn a version). See `epic-11-manual-prereqs.md` for full detail — every story here is scoped to what is loop-executable (code, workflows, generated manifests, docs).

## Technical Decisions

- **Version reporting**: `--version` reads from a build-time generated module (same pattern as the existing `ui-bundle.generated.ts`), never from `package.json` at runtime — a compiled binary has no `package.json` to read.
- **Release matrix**: each platform binary is compiled on its own native runner, never cross-compiled, because `@napi-rs/keyring` is a native NAPI addon whose binding is resolved at build time. Each leg runs the existing `scripts/keyring-native-check.ts` (from the Story 2.1 spike) against the compiled binary as a release gate — a leg that can't reach the OS keychain fails the release. Every release attaches a `SHA256SUMS` file.
- **npm shim**: a dependency-free CommonJS script with `#!/usr/bin/env node` that detects `process.platform`/`process.arch`, resolves and spawns the matching platform package's prebuilt binary with `stdio: "inherit"`, forwards `SIGINT`/`SIGTERM` to the child, and exits with the child's code. The existing `bin/quick-studio.ts` Bun entry is untouched (stays the dev-mode entry). Missing platform binary → actionable error naming detected platform/arch and the Releases fallback, never a raw `MODULE_NOT_FOUND`.
- **Packaging/publish**: the main package's manifest is generated (not the repo's real `package.json` verbatim) — no runtime `dependencies`, no build scripts, no `prepare` hook — and declares each platform package as an `optionalDependencies` pin at the exact release version; each platform package's generated manifest carries correct `os`/`cpu` fields so npm installs exactly one. Publish order is strict: every platform package before the main package (reverse order leaves it briefly uninstallable); a failed leg must not leave a half-published version tagged `latest`.
- **Update check**: non-blocking, short-timeout check against the npm registry, gated by a 24h TTL cache file under the app-data directory; any failure (offline, DNS, registry 5xx) is a silent no-op, never a warning or non-zero exit. `QS_NO_UPDATE_CHECK` disables it everywhere. `quick-studio update` never self-replaces the running binary — it tells an npm install to run `npm i -g quick-studio@latest`, and a standalone binary to download from its platform's Releases URL/checksum.
- **First-run passphrase flow (11.6)**: only triggers when the keychain is unavailable AND no `QS_PASSPHRASE`/`QS_PASSPHRASE_FD` AND the terminal is interactive; prompts with echo disabled, requires confirmation on create, bounded retries on unlock; non-interactive stdin fails fast to the existing typed "no passphrase provided" outcome rather than hanging; Ctrl-C during any prompt restores terminal echo.
- **Bare-command routing (11.7)** is a presence check only — it must never attempt to decrypt the store, since decryption may itself need the passphrase flow 11.6 gates behind knowing a store exists first. A store that exists but holds zero connections is the UI's empty-state to handle, not the CLI's.

## Cross-Story Dependencies

- 11.4 (packaging/publish workflow) consumes 11.2's release binaries and 11.3's shim — it cannot be built or verified until both exist.
- The manual `v*` tag push must happen only after 11.4 lands; tagging earlier fires the old two-platform release workflow.
- 11.2, 11.3, and 11.4 all read from one shared platform list — changing it in one place must propagate to all three, by design (this is how macOS support becomes additive later).
- 11.6 (first-run passphrase setup) and 11.7 (bare-command routing) both govern the persistent-mode first-run experience; 11.7's config-presence check must not trigger 11.6's decrypt-requiring passphrase flow prematurely.
- 11.7 reuses the existing connection form (Story 2.4) for onboarding in the UI rather than re-implementing a terminal prompt for the database URL.
- 11.5's update cache and 11.6's setup wizard both depend on the Epic 2 Persistent-mode app-data directory convention (AD-15) and must respect the Epic 2 Ephemeral no-disk-write invariant (AD-8).
