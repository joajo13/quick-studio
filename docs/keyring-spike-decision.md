# Keyring Spike — Per-Platform Decision Record (Story 2.1)

**Status:** open (Linux confirmed locally; Windows and macOS delegated to CI)
**Library under test:** `@napi-rs/keyring` pinned to exactly `1.3.0`
**Runtime:** Bun `1.3.14` (pinned exactly in every CI leg; the repo's `engines.bun` floor is `>=1.3.14`)
**Risk status — AR-20 (NAPI parity under Bun, "almost, not 100%", unproven per-platform):** **partially retired.** Parity is **proven on Linux** (real round-trip + native load from the `bun build --compile` binary, observed locally). **Windows is pending its CI leg** and **macOS is now pending its own CI leg** (the matrix is ubuntu + windows + macos — see the summary table; the `macos-latest` leg provisions an unlocked default keychain so a real round-trip is attempted). AR-20 is **not fully retired** until the Windows and macOS CI legs are green and the throw-path classification is confirmed against the real error shape. As of Story 11.2, `.github/workflows/release.yml` runs a **compiled-binary addon-load gate on every build leg** for the three **shipped** platforms (windows-x64, linux-x64, linux-arm64). Read that gate precisely: since DW-89 it executes **the published artifact itself** — `./quick-studio-<os>-<arch>` with `QS_SELFCHECK=keychain` — so it is a **direct probe of the binary users download**, not of a second artifact compiled from a different entry point. (It previously compiled and ran `scripts/keyring-native-check.ts` as a stand-in, which was evidence about the leg's *toolchain* and equivalent to the shipped binary only by accident of the then-static `bin/quick-studio.ts → first-run-setup.ts → store-presence.ts → credential-store.ts → store-key.ts → keychain.ts` chain; a lazy import anywhere on it would have kept the gate green while every shipped binary lost its keychain. That accident is no longer load-bearing: the self-check forces the addon to load from the shipped binary regardless of how the rest of the entry imports it.) The gate is still **enforced but not yet observed** — no `v*` tag has been pushed, so `release.yml` has never run — and, like the spike's deliberately pinned leg, it runs on a **pinned** Bun (`bun-version: 1.3.14` — the same version as every other leg; this is what DW-76 asked for), so it is tied to a known Bun version exactly the way the spike's AR-20 attestation is. It proves addon-load, not round-trip; round-trip attestation remains `keyring-spike.yml`'s job (the release legs deliberately pin `KEYRING_REQUIRE_ROUNDTRIP` empty — see the rationale under [QS_SELFCHECK](#qs_selfcheck--the-hidden-release-gate-probe), which is *not* that no shipped platform has a backend). macOS remains unshipped (see below).
**Smoke test:** `src/core/keychain.test.ts` (run via `bun test`)
**Compiled-binary check:** one implementation (`src/core/keychain-self-check.ts`), two entrypoints — `scripts/keyring-native-check.ts`, compiled via `bun build --compile` for `keyring-spike.yml`'s round-trip attestation, and the shipped `quick-studio-<os>-<arch>` binary run with `QS_SELFCHECK=keychain` for `release.yml`'s per-release addon-load gate (see [QS_SELFCHECK](#qs_selfcheck--the-hidden-release-gate-probe))

This record fixes the key-management path (keychain vs passphrase-first) that
Stories 2.2 / 2.3 build on. The wrapper (`src/core/keychain.ts`) treats a missing
entry as a typed `not-found` and an unreachable backend as a typed `unavailable`
— it never throws an unhandled error and never falls back to plaintext. A
`keychain-unavailable` outcome is a first-class, documented result and is exactly
the signal Story 2.3's passphrase fallback keys off; the smoke stays green on it.

---

## Summary

| Platform | Round-trip | Native module loads from `bun build --compile` | Go / No-go | Key-management path |
|----------|-----------|-----------------------------------------------|-----------|---------------------|
| Linux (with Secret Service) | PASS — observed locally | YES — observed locally | **GO** | Keychain (Secret Service) |
| Linux (no Secret Service / headless) | n/a — reports `unavailable` cleanly | YES (addon loads; no backend) | GO for the wrapper; **passphrase-first** for the store | Passphrase fallback (Story 2.3) |
| Windows | Not run here — round-trip delegated to `keyring-spike.yml`'s CI leg | **Gated per release** — every `windows-x64` binary must pass the addon-load self-check run against *that very binary* (`QS_SELFCHECK=keychain`) in `release.yml` before it can be published | **Pending** — the gate is *enforced*, not yet *observed*: no `v*` tag has been pushed, so neither workflow has run. A published windows-x64 binary is proof of addon-load; the absence of one is not evidence either way | Keychain (Credential Manager); shipped as the windows-x64 binary once a release exists |
| macOS | Not run here — delegated to CI | Not run here — delegated to the `macos-latest` leg of `keyring-spike.yml` (see the note below), which runs the compiled-binary check under `KEYRING_REQUIRE_ROUNDTRIP=1`. No `release.yml` gate exists for macOS: no darwin binary is built or published | **Pending CI** (expected GO) | Keychain (macOS Keychain), pending CI confirmation — **no darwin binary is published** |

> **macOS now has its own spike CI leg (DW-11)** — the spike matrix is ubuntu + windows + macos, and it validates the macOS Keychain path in isolation. `bun.lock` *does* carry every `@napi-rs/keyring-darwin-*` artifact (Bun resolves all platform optional dependencies at install time regardless of what ships), but **the product does not ship darwin binaries** — macOS is out of scope for Story 11.2's release matrix (`windows-latest` → windows-x64, `ubuntu-latest` → linux-x64, `ubuntu-24.04-arm` → linux-arm64 only; see `scripts/platforms.ts`). The `macos-latest` leg in `keyring-spike.yml` proves the addon on darwin as a spike, not as a shipped product path. Because macOS CI is not runnable from this Linux/WSL dev host, its go/no-go is recorded as **pending CI** (expected GO) — never a fabricated pass. Do not read the Linux/Windows rows above as covering macOS, and do not read this row as a shipping commitment — macOS remains a later phase.

---

## Linux — observed locally (GO, keychain path)

**Environment:** WSL2 (Ubuntu, x64-gnu), Bun 1.3.14. A user D-Bus session bus was
present (`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus`) with a working
Secret Service provider, so — contrary to the common "headless WSL has no
keychain" assumption — this box round-trips.

**Observed results (actually executed):**

- `bun test src/core/keychain.test.ts` → **6 pass, 0 fail**, no residual entries,
  no unhandled throw. The adaptive round-trip test took the `stored → found →
  deleted → not-found` branch (i.e. a real keychain round-trip succeeded).
- Manual probe (`Entry` set/get/delete) → `set` OK, `get` returned the stored
  value, `delete` returned `true`, `get` after delete returned `null`
  (`not-found`).
- Compiled-binary check, spike entrypoint: `bun build --compile
  scripts/keyring-native-check.ts` then running the binary → `setSecret ->
  stored`, `getSecret -> found (matches=true)`, `deleteSecret -> deleted`. **The
  native `.node` addon embeds and loads cleanly from the compiled binary** — the
  real distribution path works on Linux, not only under `bun test`.
- Compiled-binary check, product entrypoint (DW-89): `bun build --compile
  bin/quick-studio.ts` then running that binary with `QS_SELFCHECK=keychain` →
  the same `selfcheck:` sequence and exit 0. Same shared round-trip
  (`src/core/keychain-self-check.ts`), run out of the artifact that actually
  ships — this is the exact command shape `release.yml`'s gate uses.

**Decision:** **GO — keychain path.** On a Linux machine with a reachable,
unlocked Secret Service, the store (Story 2.2) holds its AES-256-GCM key in the
OS keychain via `@napi-rs/keyring`.

**Headless-Linux sub-case:** on a Linux box with no Secret Service / no D-Bus, the
wrapper returns a typed `unavailable` result (never a throw, never plaintext).
That is the designed trigger for Story 2.3's passphrase-first path. The smoke test
stays green in this condition because `unavailable` is a first-class outcome. This
sub-case was not reproduced on THIS box (it has a working keychain); the CI ubuntu
leg provisions Secret Service explicitly (`dbus-run-session` + `gnome-keyring`) so
the clean-CI round-trip is also confirmed there.

## Windows — delegated to CI (pending, expected GO)

**Not executable in this environment** (development host is Linux/WSL). This
result is produced by the `windows-latest` leg of
`.github/workflows/keyring-spike.yml`, which runs the same committed smoke
(`bun test src/core/keychain.test.ts`) plus the compiled-binary native-load check
under Bun.

**Expectation (NOT a fabricated pass):** Windows Credential Manager is always
present, so a round-trip is expected and the anticipated decision is **GO —
keychain path (Credential Manager)**. This MUST be confirmed by the CI Windows leg
before Story 2.2 commits Windows to the keychain path. Until that leg is green,
the Windows outcome is recorded here as **pending CI**, not as a pass.

## macOS — delegated to CI (pending, expected GO)

**Not executable in this environment** (development host is Linux/WSL). This
result is produced by the `macos-latest` leg of
`.github/workflows/keyring-spike.yml`, which runs the same committed smoke
(`bun test src/core/keychain.test.ts`) plus the compiled-binary native-load check
under Bun. Because a GitHub macOS runner boots with a locked/default-less login
keychain, the leg first provisions one via the `security` CLI — create a
dedicated keychain with an empty password, disable its auto-lock timeout, unlock
it, make it the default, and make it the sole entry in the user search list (so a
`SecItem` search cannot wander into the runner's locked `login.keychain-db` and
raise an unlock prompt) — so a REAL round-trip can be attempted (mirroring how the
Linux leg provisions Secret Service).

**Expectation (NOT a fabricated pass):** with the keychain provisioned, a
round-trip is expected and the anticipated decision is **GO — keychain path
(macOS Keychain)**. The compiled-binary check runs under
`KEYRING_REQUIRE_ROUNDTRIP=1`, so a locked/unavailable keychain yields a RED leg
(honest no-go), never a false green on `unavailable`. This MUST be confirmed by
the CI macOS leg before Story 2.2 commits macOS to the keychain path. Until that
leg is green, the macOS outcome is recorded here as **pending CI**, not as a pass.

---

## Key-management decision for Stories 2.2 / 2.3

- **Default path per platform:** keychain, on any platform where the smoke
  round-trips (confirmed: Linux-with-Secret-Service; pending CI: Windows and macOS).
- **Fallback path:** when the wrapper reports `unavailable` (headless Linux / no
  D-Bus, a locked keyring, or a future platform failure), the store must NOT
  write plaintext; it hands off to Story 2.3's passphrase-derived key. No single
  global key-management default is hardcoded — the runtime `unavailable` signal
  decides, per launch, per machine.
- **Distribution path:** the `bun build --compile` self-contained binary loads the
  native keyring addon on Linux (observed). The Windows and macOS compiled-binary
  checks run in their respective CI legs; no compiled-binary problem was observed
  on Linux, so no follow-up was logged.

## Caveats & review hardening

- **Provisional error classification (open follow-up).** The wrapper distinguishes
  a missing entry (`not-found`) from an unreachable backend (`unavailable`). On the
  Linux Secret Service path this is driven by `getPassword()` returning `null`. For
  backends that instead *throw* a NoEntry error (e.g. Windows Credential Manager
  and the macOS Keychain), the classification currently falls back to an English
  substring heuristic (`isNotFoundError`), which is locale-fragile. It fails
  **safe** — any unrecognized error is treated as `unavailable` (triggering the
  passphrase fallback) rather than masquerading as an empty entry — but it must be
  replaced with typed error codes once the real Windows/macOS/localized error
  shapes are observed in their CI legs. **Story 2.2 must not commit Windows or
  macOS to the keychain path until that platform's CI leg is green AND the
  throw-path classification is confirmed against the observed error shape.** Logged
  to `_bmad-output/implementation-artifacts/deferred-work.md`.
- **CI proves a real round-trip, not just a green smoke.** `bun test` is adaptive by
  design (green on `unavailable`, so any dev machine can run it). To stop a
  silently-broken keyring provisioning from producing a false GO, the CI legs run
  the compiled-binary check with `KEYRING_REQUIRE_ROUNDTRIP=1`, which fails the
  build unless `store -> found(matches) -> deleted` actually happened. A green CI
  leg is therefore a genuine per-platform proof.

## How to reproduce

```sh
bun install                              # resolves @napi-rs/keyring@1.3.0
bun x tsc --noEmit                       # type-check
bun test src/core/keychain.test.ts       # the smoke (green either way)
bun scripts/keyring-native-check.ts      # native load from source (spike entrypoint)
bun build --compile scripts/keyring-native-check.ts --outfile ./knc && ./knc

# The release gate's own command shape (DW-89): the SHIPPED binary, probed directly.
bun run build                            # the UI bundle the entry embeds
bun build --compile bin/quick-studio.ts --outfile ./qs && QS_SELFCHECK=keychain ./qs

# Same, but demanding a real round-trip — expect exit 1 on a host with no backend.
KEYRING_REQUIRE_ROUNDTRIP=1 QS_SELFCHECK=keychain ./qs
```

## `QS_SELFCHECK` — the hidden release-gate probe

`QS_SELFCHECK=keychain` makes the product binary run the keychain round-trip
(`src/core/keychain-self-check.ts`) and exit with its result, **before** argument
parsing, mode resolution, first-run setup, or the Core boot. It exists so
`.github/workflows/release.yml` can gate each leg on the artifact it is about to
publish rather than on a second binary compiled from `scripts/keyring-native-check.ts`
— the DW-89 defect. Unset or empty, it changes nothing; any other value is a fast,
loud `exit(1)` naming the expected spelling, because a silent fall-through in CI
would boot the Core on a runner and report a `timeout-minutes` hang instead of a
typo.

It is **deliberately absent from `--help` and from the README's environment
table**, and it must stay that way: it mutates the OS keychain (it stores and
deletes one probe entry under the dedicated `quick-studio-native-check` service)
and it is a CI-facing diagnostic, not a user knob. `QS_NO_UPDATE_CHECK` is only a
**partial** precedent — it is hidden from `HELP_TEXT` but **is** documented in
`README.md`'s environment list, because it is a genuine user knob that merely does
not earn help-text space. `QS_SELFCHECK` goes one step further, out of **both**,
and this record is where it is documented instead.

Semantics are exactly those of the spike script, because it is the same function:
a typed `unavailable` is a **pass** (the addon loaded; the platform has no
backend), a failure to load the addon at all is a **fail**, and
`KEYRING_REQUIRE_ROUNDTRIP=1` additionally demands a real
`store -> found(matches) -> deleted` plus the DW-10 structural `not-found` probe.
The release legs pin `KEYRING_REQUIRE_ROUNDTRIP` to the **empty string** (pinned
rather than merely left unset, so no workflow- or job-level definition can turn a
release leg strict by accident). The reason is a division of labour, **not** an
absence of backends — that would be false for the shipped Windows binary:
`windows-latest` carries Credential Manager natively, and `keyring-spike.yml`'s
Windows leg depends on exactly that to run under `KEYRING_REQUIRE_ROUNDTRIP=1`.
Round-trip attestation is the spike workflow's job, per-platform and provisioned
deliberately; the release gate's job is the addon-load proof on the artifact about
to be published. Gating **every** release on a round-trip that has never been
observed on a given platform is exactly the "gate that blocks releases on the
benign case" Story 11.2's Block-If warns about.
