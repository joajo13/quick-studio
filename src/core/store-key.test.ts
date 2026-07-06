/**
 * Proves the keychain-backed master-key manager (AR-7). The happy path exercises
 * the REAL Linux keychain and self-cleans (unconditional delete in afterAll); the
 * `key-invalid` and `unavailable` arms use injected keychain deps so they are
 * deterministic without a live backend. `unavailable` is a green, expected outcome
 * (headless CI leg) — it is the Story 2.3 hook.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { KEY_LENGTH_BYTES } from "./crypto.ts";
import {
  DEFAULT_STORE_KEY_DEPS,
  loadOrCreateStoreKey,
  STORE_KEY_ACCOUNT,
  STORE_KEY_SERVICE,
  type StoreKeyDeps,
} from "./store-key.ts";
import {
  deleteSecret,
  type KeychainGetResult,
  type KeychainSetResult,
} from "./keychain.ts";

// Run-unique account so this test never collides with a real store key or a
// concurrent run, and always self-cleans.
const TEST_ACCOUNT = `store-key-test-${crypto.randomUUID()}`;
const realDeps: StoreKeyDeps = {
  getSecret: (service) => DEFAULT_STORE_KEY_DEPS.getSecret(service, TEST_ACCOUNT),
  setSecret: (service, _account, value) =>
    DEFAULT_STORE_KEY_DEPS.setSecret(service, TEST_ACCOUNT, value),
  deleteSecret: (service) => DEFAULT_STORE_KEY_DEPS.deleteSecret(service, TEST_ACCOUNT),
};

afterAll(() => {
  deleteSecret(STORE_KEY_SERVICE, TEST_ACCOUNT);
});

describe("loadOrCreateStoreKey — real keychain get-or-create (self-cleaning)", () => {
  test("creates then loads the same 32-byte key, or is unavailable (both green)", () => {
    const first = loadOrCreateStoreKey(realDeps);

    if (first.outcome === "unavailable") {
      // Keychain-less box (headless Linux / WSL). Expected, first-class outcome.
      expect(first.detail.length).toBeGreaterThan(0);
      return;
    }

    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;
    expect(first.key.length).toBe(KEY_LENGTH_BYTES);

    // Second call finds the stored key and loads it unchanged.
    const second = loadOrCreateStoreKey(realDeps);
    expect(second.outcome).toBe("loaded");
    if (second.outcome === "loaded") {
      expect(second.key.equals(first.key)).toBe(true);
    }
  });
});

describe("loadOrCreateStoreKey — typed failure arms via injected deps", () => {
  test("a found value not decoding to 32 bytes → key-invalid", () => {
    const deps: StoreKeyDeps = {
      getSecret: (): KeychainGetResult => ({ outcome: "found", value: "dG9vLXNob3J0" }), // "too-short"
      setSecret: (): KeychainSetResult => ({ outcome: "stored" }),
      deleteSecret: () => ({ outcome: "not-found" }),
    };
    const r = loadOrCreateStoreKey(deps);
    expect(r.outcome).toBe("key-invalid");
  });

  test("an empty found value → key-invalid", () => {
    const deps: StoreKeyDeps = {
      getSecret: (): KeychainGetResult => ({ outcome: "found", value: "" }),
      setSecret: (): KeychainSetResult => ({ outcome: "stored" }),
      deleteSecret: () => ({ outcome: "not-found" }),
    };
    expect(loadOrCreateStoreKey(deps).outcome).toBe("key-invalid");
  });

  test("keychain unavailable on get → unavailable (Story 2.3 hook)", () => {
    const deps: StoreKeyDeps = {
      getSecret: (): KeychainGetResult => ({ outcome: "unavailable", detail: "no D-Bus" }),
      setSecret: (): KeychainSetResult => ({ outcome: "stored" }),
      deleteSecret: () => ({ outcome: "not-found" }),
    };
    const r = loadOrCreateStoreKey(deps);
    expect(r.outcome).toBe("unavailable");
    if (r.outcome === "unavailable") expect(r.detail).toBe("no D-Bus");
  });

  test("keychain unavailable on set (after not-found) → unavailable", () => {
    const deps: StoreKeyDeps = {
      getSecret: (): KeychainGetResult => ({ outcome: "not-found" }),
      setSecret: (): KeychainSetResult => ({ outcome: "unavailable", detail: "backend down" }),
      deleteSecret: () => ({ outcome: "not-found" }),
    };
    expect(loadOrCreateStoreKey(deps).outcome).toBe("unavailable");
  });

  test("not-found → generates and stores a fresh 32-byte key", () => {
    let stored: string | undefined;
    const deps: StoreKeyDeps = {
      getSecret: (): KeychainGetResult => ({ outcome: "not-found" }),
      setSecret: (_s, _a, value): KeychainSetResult => {
        stored = value;
        return { outcome: "stored" };
      },
      deleteSecret: () => ({ outcome: "not-found" }),
    };
    const r = loadOrCreateStoreKey(deps);
    expect(r.outcome).toBe("created");
    if (r.outcome === "created") expect(r.key.length).toBe(KEY_LENGTH_BYTES);
    // The persisted value is base64 of a 32-byte key — never the raw key in a log.
    expect(stored).toBeDefined();
    expect(Buffer.from(stored!, "base64").length).toBe(KEY_LENGTH_BYTES);
  });

  test("uses the fixed durable service/account constants", () => {
    let seenService: string | undefined;
    let seenAccount: string | undefined;
    const deps: StoreKeyDeps = {
      getSecret: (s, a): KeychainGetResult => {
        seenService = s;
        seenAccount = a;
        return { outcome: "unavailable", detail: "probe" };
      },
      setSecret: (): KeychainSetResult => ({ outcome: "stored" }),
      deleteSecret: () => ({ outcome: "not-found" }),
    };
    loadOrCreateStoreKey(deps);
    expect(seenService).toBe(STORE_KEY_SERVICE);
    expect(seenAccount).toBe(STORE_KEY_ACCOUNT);
  });
});
