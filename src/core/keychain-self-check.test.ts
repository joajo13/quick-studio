/**
 * Covers `runKeychainSelfCheck` over INJECTED keychain wrappers, so every row of
 * the gate's pass/fail matrix is exercised on a host with no keychain backend at
 * all — the condition most CI runners and this repo's dev boxes are in. Only the
 * "addon did not load" row is absent, and deliberately so: that failure throws at
 * the CALLER's dynamic `import()` of the module under test, so it belongs to
 * `bin/quick-studio.ts`'s branch and to `scripts/keyring-native-check.ts`, not
 * here.
 *
 * All four arms of the wrapper outcome union are exercised, including
 * `invalid-argument` — which is unreachable on any real run (the service is a
 * constant and the account is UUID-derived) but is exactly the arm whose
 * mishandling would let the gate print `OK` about an addon it never called.
 *
 * The rows that carry the most weight are the `KEYRING_REQUIRE_ROUNDTRIP=1` ones:
 * they are what makes a spike leg a real per-platform proof instead of a green
 * light earned by an `unavailable` nobody looked at. The self-cleaning row
 * (`deleteSecret` runs even when the read missed) and the no-secret-in-logs row
 * guard invariants that no CI leg would ever notice being broken.
 */

import { describe, expect, test } from "bun:test";
import {
  runKeychainSelfCheck,
  SELF_CHECK_SERVICE,
  type KeychainSelfCheckDeps,
} from "./keychain-self-check.ts";
import type {
  KeychainDeleteResult,
  KeychainGetResult,
  KeychainSetResult,
} from "./keychain.ts";

/** How the scripted keychain should behave for one run. Every field is optional; the defaults round-trip. */
interface FakeOptions {
  /** What `setSecret` reports. Default: `stored`. */
  readonly set?: KeychainSetResult;
  /** Explicit result for the FIRST read (the probe account). Default: echo back what was stored. */
  readonly get?: KeychainGetResult;
  /** First read returns `found` carrying a value that is NOT the stored secret. */
  readonly mismatch?: boolean;
  /** What `deleteSecret` reports. Default: `deleted`. */
  readonly del?: KeychainDeleteResult;
  /** Result for the SECOND read — the DW-10 never-stored probe. Default: `not-found`. */
  readonly probe?: KeychainGetResult;
}

/**
 * A scripted keychain plus captured sinks. Reads are distinguished by ORDER, not
 * by account name: the function under test always reads the probe account first
 * and the never-stored account second, and asserting that ordering is part of
 * what these tests are for.
 */
function makeFake(opts: FakeOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const setCalls: Array<{ service: string; account: string; value: string }> = [];
  const getCalls: Array<{ service: string; account: string }> = [];
  const deleteCalls: Array<{ service: string; account: string }> = [];
  let ids = 0;
  let stored: string | null = null;

  const deps: Partial<KeychainSelfCheckDeps> = {
    setSecret: (service, account, value) => {
      setCalls.push({ service, account, value });
      const result = opts.set ?? ({ outcome: "stored" } as const);
      if (result.outcome === "stored") stored = value;
      return result;
    },
    getSecret: (service, account) => {
      getCalls.push({ service, account });
      if (getCalls.length > 1) return opts.probe ?? { outcome: "not-found" };
      if (opts.get) return opts.get;
      if (opts.mismatch) return { outcome: "found", value: "a-different-value" };
      return stored === null ? { outcome: "not-found" } : { outcome: "found", value: stored };
    },
    deleteSecret: (service, account) => {
      deleteCalls.push({ service, account });
      return opts.del ?? { outcome: "deleted" };
    },
    // Deterministic ids so a test can name the exact account/secret the function
    // generated (`compiled-id-1`, `probe-id-2`, `absent-id-3`) instead of
    // pattern-matching a UUID.
    newId: () => `id-${++ids}`,
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
  };

  return { deps, out, err, setCalls, getCalls, deleteCalls };
}

const LENIENT = {};
const STRICT = { KEYRING_REQUIRE_ROUNDTRIP: "1" };

describe("runKeychainSelfCheck — default (lenient) mode", () => {
  test("a real round-trip passes and reports every step", () => {
    const fake = makeFake();
    expect(runKeychainSelfCheck(LENIENT, fake.deps)).toBe(0);
    expect(fake.out).toEqual([
      "selfcheck: setSecret -> stored",
      "selfcheck: getSecret -> found (matches=true)",
      "selfcheck: deleteSecret -> deleted",
      "selfcheck: OK — @napi-rs/keyring loaded from the compiled binary",
    ]);
    expect(fake.err).toEqual([]);
  });

  test("an all-`unavailable` host still passes — the addon loaded, there is just no backend", () => {
    // This is the headless-runner row, and it is the one that must NOT be a
    // failure: treating it as one would block every release on a benign case.
    const fake = makeFake({
      set: { outcome: "unavailable", detail: "no Secret Service" },
      get: { outcome: "unavailable", detail: "no Secret Service" },
      del: { outcome: "unavailable", detail: "no Secret Service" },
    });
    expect(runKeychainSelfCheck(LENIENT, fake.deps)).toBe(0);
    expect(fake.out).toEqual([
      "selfcheck: setSecret -> unavailable",
      "selfcheck: getSecret -> unavailable",
      "selfcheck: deleteSecret -> unavailable",
      "selfcheck: OK — @napi-rs/keyring loaded from the compiled binary",
    ]);
    expect(fake.err).toEqual([]);
  });

  test("a value mismatch reports matches=false and still passes without the strict flag", () => {
    const fake = makeFake({ mismatch: true });
    expect(runKeychainSelfCheck(LENIENT, fake.deps)).toBe(0);
    expect(fake.out).toContain("selfcheck: getSecret -> found (matches=false)");
  });

  test("the never-stored DW-10 probe is not run at all without the strict flag", () => {
    const fake = makeFake();
    runKeychainSelfCheck(LENIENT, fake.deps);
    expect(fake.getCalls).toHaveLength(1);
    expect(fake.out.some((line) => line.includes("never-stored"))).toBe(false);
  });
});

describe("runKeychainSelfCheck — `invalid-argument` is a failure, never an OK", () => {
  // The fourth arm of the wrapper outcome union, and the only one that means the
  // NATIVE STORE WAS NEVER TOUCHED: `keychain.ts`'s identifier guard returns
  // before `new Entry(...)` is ever constructed. Reporting `OK — @napi-rs/keyring
  // loaded from the compiled binary` after that would tell a release gate the
  // addon works on evidence that does not exist.

  test("a blanked service/account fails all three calls and the run reports it", () => {
    // The realistic shape of a future regression: the same bad identifiers reach
    // every wrapper, so all three come back `invalid-argument`.
    const bad = { outcome: "invalid-argument", detail: "service must be a non-empty, non-blank string" } as const;
    const fake = makeFake({ set: bad, get: bad, del: bad });
    expect(runKeychainSelfCheck(LENIENT, fake.deps)).toBe(1);
    expect(fake.err).toHaveLength(1);
    expect(fake.err[0]).toContain('setSecret returned "invalid-argument"');
    expect(fake.err[0]).toContain("service must be a non-empty, non-blank string");
    expect(fake.out.some((line) => line.includes("OK —"))).toBe(false);
  });

  test("a read-only `invalid-argument` is attributed to getSecret", () => {
    const fake = makeFake({
      get: { outcome: "invalid-argument", detail: "account must be a non-empty, non-blank string" },
    });
    expect(runKeychainSelfCheck(LENIENT, fake.deps)).toBe(1);
    expect(fake.err[0]).toContain('getSecret returned "invalid-argument"');
    expect(fake.err[0]).toContain("account must be a non-empty, non-blank string");
  });

  test("a cleanup-only `invalid-argument` is attributed to deleteSecret and still fails", () => {
    // set + get both worked, so the addon demonstrably loaded — but a wrapper
    // that rejected its identifiers is a bug worth a red gate, not a rounding
    // error, and the OK line must not paper over it.
    const fake = makeFake({
      del: { outcome: "invalid-argument", detail: "service must be a non-empty, non-blank string" },
    });
    expect(runKeychainSelfCheck(LENIENT, fake.deps)).toBe(1);
    expect(fake.err[0]).toContain('deleteSecret returned "invalid-argument"');
    expect(fake.out.some((line) => line.includes("OK —"))).toBe(false);
  });

  test("cleanup still runs before the failure return", () => {
    const bad = { outcome: "invalid-argument", detail: "account must be a non-empty, non-blank string" } as const;
    const fake = makeFake({ set: bad, get: bad, del: bad });
    runKeychainSelfCheck(LENIENT, fake.deps);
    expect(fake.deleteCalls).toHaveLength(1);
    expect(fake.out).toContain("selfcheck: deleteSecret -> invalid-argument");
  });

  test("under KEYRING_REQUIRE_ROUNDTRIP=1 it wins over the round-trip message", () => {
    // Both conditions hold (no round-trip AND a rejected identifier); the
    // identifier failure is reported because it names the actual cause instead of
    // the symptom, and the never-stored probe is never reached.
    const bad = { outcome: "invalid-argument", detail: "service must be a non-empty, non-blank string" } as const;
    const fake = makeFake({ set: bad, get: bad, del: bad });
    expect(runKeychainSelfCheck(STRICT, fake.deps)).toBe(1);
    expect(fake.err).toHaveLength(1);
    expect(fake.err[0]).toContain('"invalid-argument"');
    expect(fake.err[0]).not.toContain("no real round-trip");
    expect(fake.getCalls).toHaveLength(1);
  });
});

describe("runKeychainSelfCheck — KEYRING_REQUIRE_ROUNDTRIP=1", () => {
  test("`unavailable` becomes a hard failure naming both outcomes", () => {
    const fake = makeFake({
      set: { outcome: "unavailable", detail: "no Secret Service" },
      get: { outcome: "unavailable", detail: "no Secret Service" },
      del: { outcome: "unavailable", detail: "no Secret Service" },
    });
    expect(runKeychainSelfCheck(STRICT, fake.deps)).toBe(1);
    expect(fake.err).toHaveLength(1);
    expect(fake.err[0]).toContain("FAILED — KEYRING_REQUIRE_ROUNDTRIP=1 but no real round-trip");
    expect(fake.err[0]).toContain("(set=unavailable, get=unavailable)");
    // The pass line must never be emitted on a failing run.
    expect(fake.out.some((line) => line.includes("OK —"))).toBe(false);
  });

  test("a mismatched value is a hard failure even though the read `found` something", () => {
    const fake = makeFake({ mismatch: true });
    expect(runKeychainSelfCheck(STRICT, fake.deps)).toBe(1);
    expect(fake.err[0]).toContain("no real round-trip");
    expect(fake.err[0]).toContain("(set=stored, get=found)");
  });

  test("a good round-trip plus a `not-found` probe passes", () => {
    const fake = makeFake();
    expect(runKeychainSelfCheck(STRICT, fake.deps)).toBe(0);
    expect(fake.out).toEqual([
      "selfcheck: setSecret -> stored",
      "selfcheck: getSecret -> found (matches=true)",
      "selfcheck: deleteSecret -> deleted",
      "selfcheck: getSecret(never-stored) -> not-found",
      "selfcheck: OK — @napi-rs/keyring loaded from the compiled binary",
    ]);
    expect(fake.err).toEqual([]);
  });

  test("a probe that returns anything but `not-found` breaks the DW-10 contract and fails", () => {
    // A backend that routes a miss through a THROW lands on `unavailable`, which
    // is exactly the null-vs-throw shape DW-10's structural classification
    // depends on not existing.
    const fake = makeFake({ probe: { outcome: "unavailable", detail: "threw on miss" } });
    expect(runKeychainSelfCheck(STRICT, fake.deps)).toBe(1);
    expect(fake.err).toHaveLength(1);
    expect(fake.err[0]).toContain('a never-stored account returned "unavailable"');
    expect(fake.err[0]).toContain("DW-10 structural not-found contract");
    expect(fake.out.some((line) => line.includes("OK —"))).toBe(false);
  });

  test("the probe reads a FRESH account, never the one just written and deleted", () => {
    const fake = makeFake();
    runKeychainSelfCheck(STRICT, fake.deps);
    expect(fake.getCalls).toHaveLength(2);
    expect(fake.getCalls[0]?.account).toBe("compiled-id-1");
    expect(fake.getCalls[1]?.account).toBe("absent-id-3");
  });
});

describe("runKeychainSelfCheck — invariants", () => {
  test("deleteSecret runs even when the read missed entirely (self-cleaning)", () => {
    // `setSecret` may have succeeded while the read failed for an unrelated
    // reason; cleanup reachable only on the happy path would leave the probe
    // entry behind on exactly the runs that went wrong.
    const fake = makeFake({ get: { outcome: "not-found" } });
    runKeychainSelfCheck(LENIENT, fake.deps);
    expect(fake.deleteCalls).toEqual([
      { service: SELF_CHECK_SERVICE, account: "compiled-id-1" },
    ]);
  });

  test("deleteSecret runs before the strict-mode failure return", () => {
    const fake = makeFake({
      set: { outcome: "unavailable", detail: "no backend" },
      get: { outcome: "unavailable", detail: "no backend" },
      del: { outcome: "unavailable", detail: "no backend" },
    });
    expect(runKeychainSelfCheck(STRICT, fake.deps)).toBe(1);
    expect(fake.deleteCalls).toHaveLength(1);
  });

  test("every call is scoped to the dedicated self-check service", () => {
    // The probe must never share a service with the product's real credential
    // store, or a self-check could collide with a user's key.
    const fake = makeFake();
    runKeychainSelfCheck(STRICT, fake.deps);
    expect(SELF_CHECK_SERVICE).toBe("quick-studio-native-check");
    for (const call of [...fake.setCalls, ...fake.getCalls, ...fake.deleteCalls]) {
      expect(call.service).toBe(SELF_CHECK_SERVICE);
    }
  });

  test("the injected label prefixes every line, on both sinks", () => {
    // This is what lets scripts/keyring-native-check.ts keep emitting the exact
    // `native-check:` lines keyring-spike.yml has always read.
    const fake = makeFake({ probe: { outcome: "found", value: "surprise" } });
    expect(runKeychainSelfCheck(STRICT, { ...fake.deps, label: "native-check" })).toBe(1);
    expect(fake.out.length).toBeGreaterThan(0);
    expect(fake.err.length).toBeGreaterThan(0);
    for (const line of [...fake.out, ...fake.err]) {
      expect(line.startsWith("native-check: ")).toBe(true);
    }
  });

  test("the secret value never appears in any logged line", () => {
    // Every one of these lines lands in a public CI log.
    const fake = makeFake();
    runKeychainSelfCheck(STRICT, fake.deps);
    const secret = fake.setCalls[0]?.value;
    expect(secret).toBe("probe-id-2");
    for (const line of [...fake.out, ...fake.err]) {
      expect(line.includes(secret ?? "probe-id-2")).toBe(false);
    }
  });

  test("a fresh account and a fresh secret are generated per run", () => {
    const first = makeFake();
    runKeychainSelfCheck(LENIENT, first.deps);
    expect(first.setCalls[0]?.account).toBe("compiled-id-1");
    expect(first.setCalls[0]?.value).toBe("probe-id-2");
    expect(first.setCalls[0]?.account).not.toBe(first.setCalls[0]?.value);
  });

  test("only KEYRING_REQUIRE_ROUNDTRIP=1 is strict — any other value is lenient", () => {
    // Same `=== "1"` contract scripts/keyring-native-check.ts has always had; a
    // truthiness check would make `KEYRING_REQUIRE_ROUNDTRIP=0` silently strict.
    for (const value of ["0", "true", "yes", ""]) {
      const fake = makeFake({
        set: { outcome: "unavailable", detail: "no backend" },
        get: { outcome: "unavailable", detail: "no backend" },
        del: { outcome: "unavailable", detail: "no backend" },
      });
      expect(runKeychainSelfCheck({ KEYRING_REQUIRE_ROUNDTRIP: value }, fake.deps)).toBe(0);
    }
  });
});
