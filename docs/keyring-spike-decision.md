# Keyring Spike — Per-Platform Decision Record (Story 2.1)

**Status:** open (Linux confirmed locally; Windows delegated to CI)
**Library under test:** `@napi-rs/keyring` pinned to exactly `1.3.0`
**Runtime:** Bun `>=1.2.0`
**Risk status — AR-20 (NAPI parity under Bun, "almost, not 100%", unproven per-platform):** **partially retired.** Parity is **proven on Linux** (real round-trip + native load from the `bun build --compile` binary, observed locally). **Windows is pending its CI leg** and **macOS is out of scope** for this spike (matrix is ubuntu + windows by spec — see the summary table). AR-20 is **not fully retired** until the Windows CI leg is green and the throw-path classification is confirmed against the real error shape.
**Smoke test:** `src/core/keychain.test.ts` (run via `bun test`)
**Compiled-binary check:** `scripts/keyring-native-check.ts` (run via `bun build --compile` — the real distribution path)

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
| Windows | Not run here — delegated to CI | Not run here — delegated to CI | **Pending CI** (expected GO) | Keychain (Credential Manager), pending CI confirmation |
| macOS | Not validated by this spike | Not validated by this spike | **Out of scope / deferred** | Undecided — no spike evidence yet |

> **macOS is intentionally out of scope for Story 2.1** — the spike matrix is ubuntu + windows by spec (see Code Map / Tasks). The product does ship darwin binaries (`bun.lock` carries every `@napi-rs/keyring-darwin-*` artifact), so the macOS Keychain path is genuinely unvalidated here and its go/no-go is **deferred** (logged in the deferred-work ledger). Do not read the Linux/Windows rows above as covering macOS.

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
- Compiled-binary check: `bun build --compile scripts/keyring-native-check.ts`
  then running the binary → `setSecret -> stored`, `getSecret -> found
  (matches=true)`, `deleteSecret -> deleted`. **The native `.node` addon embeds
  and loads cleanly from the compiled binary** — the real distribution path
  works on Linux, not only under `bun test`.

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

---

## Key-management decision for Stories 2.2 / 2.3

- **Default path per platform:** keychain, on any platform where the smoke
  round-trips (confirmed: Linux-with-Secret-Service; pending CI: Windows).
- **Fallback path:** when the wrapper reports `unavailable` (headless Linux / no
  D-Bus, a locked keyring, or a future platform failure), the store must NOT
  write plaintext; it hands off to Story 2.3's passphrase-derived key. No single
  global key-management default is hardcoded — the runtime `unavailable` signal
  decides, per launch, per machine.
- **Distribution path:** the `bun build --compile` self-contained binary loads the
  native keyring addon on Linux (observed). The Windows compiled-binary check runs
  in the CI Windows leg; no compiled-binary problem was observed on Linux, so no
  follow-up was logged.

## Caveats & review hardening

- **Provisional error classification (open follow-up).** The wrapper distinguishes
  a missing entry (`not-found`) from an unreachable backend (`unavailable`). On the
  Linux Secret Service path this is driven by `getPassword()` returning `null`. For
  backends that instead *throw* a NoEntry error (e.g. Windows Credential Manager),
  the classification currently falls back to an English substring heuristic
  (`isNotFoundError`), which is locale-fragile. It fails **safe** — any
  unrecognized error is treated as `unavailable` (triggering the passphrase
  fallback) rather than masquerading as an empty entry — but it must be replaced
  with typed error codes once the real Windows/localized error shapes are observed
  in the CI Windows leg. **Story 2.2 must not commit Windows to the keychain path
  until that CI leg is green AND the throw-path classification is confirmed against
  the observed error shape.** Logged to `deferred-work.md`.
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
bun scripts/keyring-native-check.ts      # native load from source
bun build --compile scripts/keyring-native-check.ts --outfile ./knc && ./knc
```
