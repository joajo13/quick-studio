/**
 * quick-studio Core — the ONE keychain round-trip both keyring gates run (AR-20, DW-89).
 *
 * Two entrypoints consume this module, and the whole reason it exists is that they
 * must never drift apart again:
 *  - `scripts/keyring-native-check.ts` — compiled into its own binary by
 *    `.github/workflows/keyring-spike.yml`, which PROVISIONS a backend per OS and
 *    runs under `KEYRING_REQUIRE_ROUNDTRIP=1` to attest a real per-platform
 *    round-trip.
 *  - `bin/quick-studio.ts`'s hidden `QS_SELFCHECK=keychain` branch — run by
 *    `.github/workflows/release.yml` against the SHIPPED
 *    `quick-studio-<os>-<arch>` artifact, so the release gate probes the binary
 *    users actually download rather than a stand-in compiled from a different
 *    entry point. Before this module existed, the two were equivalent only by
 *    accident of a static import chain (`bin/quick-studio.ts` →
 *    `first-run-setup.ts` → … → `keychain.ts`); the first lazy import anywhere on
 *    that chain would have left the release gate green while every shipped binary
 *    silently degraded its users to the passphrase fallback. Now they are the same
 *    code, so "equivalent by accident" is not a state this repo can return to.
 *
 * Pass/fail semantics are the spike script's, unchanged: a typed `unavailable`
 * means the addon LOADED and the platform simply has no backend — a PASS. A
 * failure to load the addon at all is a failure, and it never surfaces as a
 * return value here; it throws while the module graph is being evaluated.
 *
 * Where it is REPORTED is worth stating precisely, because the tidy answer is not
 * yet the true one. `bin/quick-studio.ts` imports this module dynamically inside a
 * `try` so its `catch` can print a clean
 * `selfcheck: FAILED — native module did not load` — but that entry ALSO reaches
 * `./keychain.ts` through a still-static chain (`first-run-setup.ts` → … →
 * `keychain.ts`), so today a broken binding throws during module evaluation and
 * the branch never runs: the operator gets an uncaught stack trace instead. Loud
 * and non-zero, but ugly. The dynamic import and its `catch` are what make the
 * clean report — and the self-check as a whole — correct once that chain goes
 * lazy, which is exactly the future DW-89 exists to guard; that is also why the
 * `QS_SELFCHECK` resolver lives in a separate, dependency-free
 * `./self-check.ts`. (`scripts/keyring-native-check.ts` has no such static chain,
 * so for the spike entrypoint its `catch` really is the reporting site today.)
 *
 * A typed `invalid-argument` is also a FAILURE here, not a pass: per
 * `./keychain.ts`'s contract the blank-identifier guard returns before any
 * identifier reaches the native store, so it means the addon was never called and
 * an `OK` line after it would be a lie. With `KEYRING_REQUIRE_ROUNDTRIP=1` the check
 * additionally demands a real `store -> found(matches) -> deleted` plus the DW-10
 * structural `not-found` probe, so a silently-broken keyring provisioning (e.g.
 * gnome-keyring failing to unlock) cannot leave a CI leg green on `unavailable`
 * without ever exercising the keychain path.
 *
 * Self-cleaning; never writes a real credential; never logs a secret value.
 * RETURNS an exit code and never calls `process.exit`, because one of its two
 * callers is the product's entry point and this module does not own that process.
 * Every dependency (the three wrappers, id generation, both log sinks, the line
 * label) is injectable, so the whole matrix is unit-testable with fakes on a host
 * that has no keychain backend at all.
 */

import {
  deleteSecret as realDeleteSecret,
  getSecret as realGetSecret,
  setSecret as realSetSecret,
  type KeychainDeleteResult,
  type KeychainGetResult,
  type KeychainSetResult,
} from "./keychain.ts";

/**
 * The dedicated service the probe entry is written under — never a service the
 * product's real credential store uses, so a self-check can never collide with,
 * overwrite, or delete a user's key.
 */
export const SELF_CHECK_SERVICE = "quick-studio-native-check";

/** Everything the self-check touches, injectable so the matrix is testable with fakes. */
export interface KeychainSelfCheckDeps {
  readonly setSecret: (service: string, account: string, value: string) => KeychainSetResult;
  readonly getSecret: (service: string, account: string) => KeychainGetResult;
  readonly deleteSecret: (service: string, account: string) => KeychainDeleteResult;
  /** Fresh, collision-free id source; one call per account and per secret. */
  readonly newId: () => string;
  /** Progress sink (stdout by default) — every line is prefixed with {@link KeychainSelfCheckDeps.label}. */
  readonly log: (line: string) => void;
  /** Failure sink (stderr by default). */
  readonly logError: (line: string) => void;
  /**
   * Line prefix. `"native-check"` preserves `scripts/keyring-native-check.ts`'s
   * exact historical output (`keyring-spike.yml` legs read those lines);
   * `"selfcheck"` is what the shipped binary's `QS_SELFCHECK` branch emits.
   */
  readonly label: string;
}

/**
 * The real wiring: the actual keychain wrappers, `crypto.randomUUID`, the console,
 * and the product-entry label. Overridden wholesale in tests.
 */
const DEFAULT_DEPS: KeychainSelfCheckDeps = {
  setSecret: realSetSecret,
  getSecret: realGetSecret,
  deleteSecret: realDeleteSecret,
  newId: () => crypto.randomUUID(),
  log: (line) => console.log(line),
  logError: (line) => console.error(line),
  label: "selfcheck",
};

/**
 * Run the keychain self-check and return the exit code the caller should use
 * (`0` pass, `1` fail). Never throws for a typed outcome — every wrapper result is
 * a value, not an exception — and never calls `process.exit`.
 *
 * `env` is read directly rather than threaded through `CliArgs`: this is a
 * diagnostic probe, not a CLI option, and `update-check.ts` sets the precedent for
 * a `bin/`-adjacent module consulting `process.env` on its own.
 */
export function runKeychainSelfCheck(
  // The index signature is what makes `process.env` assignable here: without it
  // TS's weak-type check rejects a `ProcessEnv` that declares none of the named
  // keys. Same shape as `RunModeEnv` and `runUpdateCheck`'s env parameter.
  env: {
    readonly KEYRING_REQUIRE_ROUNDTRIP?: string | undefined;
    readonly [key: string]: string | undefined;
  },
  overrides?: Partial<KeychainSelfCheckDeps>,
): number {
  const { setSecret, getSecret, deleteSecret, newId, log, logError, label } = {
    ...DEFAULT_DEPS,
    ...overrides,
  };

  const requireRoundTrip = env.KEYRING_REQUIRE_ROUNDTRIP === "1";
  // A fresh account AND a fresh secret per run: two concurrent legs (or a rerun
  // over a leftover entry) can never read each other's probe and conclude
  // `matches=false` on a perfectly working keychain.
  const account = `compiled-${newId()}`;
  const secret = `probe-${newId()}`;

  const set = setSecret(SELF_CHECK_SERVICE, account, secret);
  log(`${label}: setSecret -> ${set.outcome}`);

  const got = getSecret(SELF_CHECK_SERVICE, account);
  const roundTripped = got.outcome === "found" && got.value === secret;
  if (got.outcome === "found") {
    // Report the COMPARISON, never the value: this line lands in a public CI log.
    log(`${label}: getSecret -> found (matches=${got.value === secret})`);
  } else {
    log(`${label}: getSecret -> ${got.outcome}`);
  }

  // Unconditional and BEFORE any failure return below. `setSecret` may well have
  // stored the entry even when the read missed or mismatched, so cleanup must not
  // be reachable only on the success path — that is what keeps the probe
  // self-cleaning on the exact runs where something went wrong.
  const del = deleteSecret(SELF_CHECK_SERVICE, account);
  log(`${label}: deleteSecret -> ${del.outcome}`);

  // A TRIPWIRE, not a live path. `keychain.ts`'s blank-identifier guard returns
  // BEFORE any identifier reaches the native store, so an `invalid-argument`
  // outcome means the addon was never called — and the `OK — @napi-rs/keyring
  // loaded from the compiled binary` line below would then be a flat lie that a
  // release gate would happily believe. With this module's constant service and
  // its UUID-derived account this arm is unreachable; it exists to catch a future
  // edit (or an injected dep) that blanks an identifier, which is precisely the
  // moment the lie would otherwise ship. Because no real run can reach it, it does
  // not change `scripts/keyring-native-check.ts`'s observable exit codes.
  // Checked AFTER the delete above, so the self-cleaning invariant still holds,
  // and BEFORE the round-trip branches below, whose "no real round-trip" message
  // would be true but far less diagnostic.
  const invalid =
    set.outcome === "invalid-argument"
      ? { call: "setSecret", detail: set.detail }
      : got.outcome === "invalid-argument"
        ? { call: "getSecret", detail: got.detail }
        : del.outcome === "invalid-argument"
          ? { call: "deleteSecret", detail: del.detail }
          : null;
  if (invalid) {
    logError(
      `${label}: FAILED — ${invalid.call} returned "invalid-argument" (${invalid.detail}). ` +
        `The identifier guard returns before anything reaches the native store, so the ` +
        `addon was never exercised and this run proves nothing about it.`,
    );
    return 1;
  }

  if (requireRoundTrip && !roundTripped) {
    // This platform was expected to have a working backend, but no real
    // round-trip occurred — treat it as a hard failure so CI cannot green-light a
    // keychain path it never actually exercised.
    logError(
      `${label}: FAILED — KEYRING_REQUIRE_ROUNDTRIP=1 but no real round-trip ` +
        `(set=${set.outcome}, get=${got.outcome}). Backend likely unavailable/unprovisioned.`,
    );
    return 1;
  }

  if (requireRoundTrip) {
    // DW-10 per-platform proof: on a leg with a real backend (round-trip just
    // succeeded), a miss must surface as a structural `not-found` (the binding's
    // null return), NOT a thrown error routed to `unavailable`. A fresh account
    // that was never stored is a guaranteed miss. If this platform's keychain
    // throws on a miss instead, the null-vs-throw contract DW-10 relies on is
    // violated — fail the leg loudly here.
    const neverStored = `absent-${newId()}`;
    const miss = getSecret(SELF_CHECK_SERVICE, neverStored);
    log(`${label}: getSecret(never-stored) -> ${miss.outcome}`);
    if (miss.outcome !== "not-found") {
      logError(
        `${label}: FAILED — a never-stored account returned "${miss.outcome}", ` +
          `expected "not-found". This platform surfaces a miss as a throw, breaking ` +
          `the DW-10 structural not-found contract.`,
      );
      return 1;
    }
  }

  // The native addon loaded and every call returned a typed result. Whether the
  // platform round-tripped or reported unavailable, the distribution path works.
  log(`${label}: OK — @napi-rs/keyring loaded from the compiled binary`);
  return 0;
}
