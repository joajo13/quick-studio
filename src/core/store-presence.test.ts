/**
 * Covers `classifyStorePresence`'s 3×3 presence matrix — (descriptor, `.enc`)
 * presence for the credential store crossed with the provider-key store — over an
 * INJECTED `existsSync`, so no real disk is touched. Also covers `anyDescriptorPresent`
 * across every combination of the two stores' classifications, since it is the
 * create-vs-unlock discriminator `first-run-setup.ts` depends on and it must not
 * drift from `openPersistent`'s descriptor-then-`.enc` precedence.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { STORE_FILE_NAME, STORE_META_FILE_NAME } from "./credential-store.ts";
import {
  PROVIDER_STORE_FILE_NAME,
  PROVIDER_STORE_META_FILE_NAME,
} from "./provider-key-store.ts";
import {
  anyDescriptorPresent,
  classifyStorePresence,
  type StorePresence,
  type StorePresenceResult,
} from "./store-presence.ts";

const DIR = "/fake/app-dir";

/** Build an injected `existsSync` over an explicit set of present paths. */
function existsAmong(paths: readonly string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path) => set.has(path);
}

describe("classifyStorePresence — per-store 3-way classification", () => {
  const credMeta = join(DIR, STORE_META_FILE_NAME);
  const credEnc = join(DIR, STORE_FILE_NAME);
  const provMeta = join(DIR, PROVIDER_STORE_META_FILE_NAME);
  const provEnc = join(DIR, PROVIDER_STORE_FILE_NAME);

  // [description, present paths, expected credential, expected providerKeys]
  const cases: Array<[string, readonly string[], StorePresence, StorePresence]> = [
    ["neither store has anything → both first-run", [], "first-run", "first-run"],
    [
      "credential descriptor present → passphrase-mode, providerKeys untouched → first-run",
      [credMeta],
      "passphrase-mode",
      "first-run",
    ],
    [
      "credential .enc present, no descriptor (Story 2.2 back-compat) → keychain-mode",
      [credEnc],
      "keychain-mode",
      "first-run",
    ],
    [
      "credential descriptor AND .enc present → descriptor wins, passphrase-mode",
      [credMeta, credEnc],
      "passphrase-mode",
      "first-run",
    ],
    [
      "providerKeys descriptor present → passphrase-mode, credential untouched → first-run",
      [provMeta],
      "first-run",
      "passphrase-mode",
    ],
    [
      "providerKeys .enc present, no descriptor → keychain-mode",
      [provEnc],
      "first-run",
      "keychain-mode",
    ],
    [
      "both stores fully first-run-descriptored (both descriptors present)",
      [credMeta, provMeta],
      "passphrase-mode",
      "passphrase-mode",
    ],
    [
      "credential passphrase-mode, providerKeys keychain-mode (mixed modes)",
      [credMeta, provEnc],
      "passphrase-mode",
      "keychain-mode",
    ],
    [
      "credential keychain-mode, providerKeys passphrase-mode (mixed modes, reversed)",
      [credEnc, provMeta],
      "keychain-mode",
      "passphrase-mode",
    ],
    [
      "both stores keychain-mode",
      [credEnc, provEnc],
      "keychain-mode",
      "keychain-mode",
    ],
  ];

  for (const [description, present, expectedCred, expectedProv] of cases) {
    test(description, () => {
      const result = classifyStorePresence(DIR, { existsSync: existsAmong(present) });
      expect(result).toEqual({ credential: expectedCred, providerKeys: expectedProv });
    });
  }

  test("uses the real STORE_META_FILE_NAME/STORE_FILE_NAME/PROVIDER_STORE_* constants, not ad-hoc paths", () => {
    // Sanity: an existsSync stub keyed on an UNRELATED path never flips a store out
    // of first-run — proves the module joins against the real exported constants.
    const result = classifyStorePresence(DIR, {
      existsSync: existsAmong([join(DIR, "some-unrelated-file.txt")]),
    });
    expect(result).toEqual({ credential: "first-run", providerKeys: "first-run" });
  });

  test("defaults to the real node:fs existsSync when no deps are injected", () => {
    // A directory that (almost certainly) does not exist on this machine → both
    // stores classify first-run via the REAL filesystem, proving the default wires
    // to node:fs without throwing (no ensureAppDir, no mkdir).
    const result = classifyStorePresence("/definitely/does/not/exist/qs-11-6-probe");
    expect(result).toEqual({ credential: "first-run", providerKeys: "first-run" });
  });
});

describe("anyDescriptorPresent — the create-vs-unlock discriminator", () => {
  const modes: readonly StorePresence[] = ["passphrase-mode", "keychain-mode", "first-run"];
  const cases: Array<[StorePresenceResult, boolean]> = [];
  for (const credential of modes) {
    for (const providerKeys of modes) {
      const expected = credential === "passphrase-mode" || providerKeys === "passphrase-mode";
      cases.push([{ credential, providerKeys }, expected]);
    }
  }

  for (const [presence, expected] of cases) {
    test(`credential=${presence.credential}, providerKeys=${presence.providerKeys} → ${expected}`, () => {
      expect(anyDescriptorPresent(presence)).toBe(expected);
    });
  }
});
