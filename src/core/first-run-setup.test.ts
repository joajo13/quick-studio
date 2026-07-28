/**
 * Covers `runFirstRunSetup`'s full I/O-edge-case matrix (spec-11-6) over INJECTED
 * deps — no real disk, no real keychain, no real terminal:
 *  - Ephemeral mode → every seam is invoked ZERO times (the hardest invariant: no
 *    probe, no prompt, no ensureAppDir);
 *  - env/fd transport already chosen (`QS_PASSPHRASE` set / `QS_PASSPHRASE_FD`
 *    valid / malformed) → zero probes, zero prompts, `skip` — absolute precedence;
 *  - the decline-probe `opened` (keychain available) → the probe store is closed
 *    exactly once, zero prompts, `skip`;
 *  - the decline-probe returns anything OTHER than `passphrase-declined`
 *    (`locked`/`corrupt`/`unavailable`/`key-invalid`/`schema-unknown`/
 *    `key-unavailable`) → zero prompts, `skip` (a different problem);
 *  - a passphrase genuinely needed but stdin is non-interactive → zero prompts,
 *    exactly one stderr line naming `QS_PASSPHRASE_FD`, `skip`;
 *  - unlock: wrong-then-right passphrase → exactly 2 prompts, `provider`; 3 wrong in
 *    a row → budget exhausted, `skip`, zero store writes;
 *  - create: no descriptor anywhere → `promptNew` used (never `prompt`), an eager
 *    open under the captured passphrase, `provider`;
 *  - provider-key descriptor present while the credential descriptor is absent →
 *    the UNLOCK path targets the provider-key store (no confirmation);
 *  - a descriptor whose `.enc` is missing (`orphaned-descriptor`, DW-86) → the loop
 *    targets the OTHER store if that one is openable, and when neither is it prompts
 *    ZERO times and returns `skip`; one notice line names each orphaned store, the
 *    remedy block is emitted once, and the "nothing is created here either" line only
 *    when nothing is openable — never three futile prompts blamed on the passphrase.
 *    A FOREIGN orphan also blocks the create path for a store that is itself
 *    `first-run`/`keychain-mode`, which is the data-safe routing (see that block);
 *  - every prompt-declined reason maps correctly: `aborted` → `{outcome:"aborted"}`
 *    (and this module never calls `process.exit`); every other reason → one
 *    `QS_PASSPHRASE_FD` stderr pointer, then `skip`.
 */

import { describe, expect, test } from "bun:test";
import type {
  CredentialStore,
  CredentialStoreDeps,
  OpenResult as CredentialOpenResult,
} from "./credential-store.ts";
import {
  MAX_UNLOCK_ATTEMPTS,
  runFirstRunSetup,
  type FirstRunSetupDeps,
} from "./first-run-setup.ts";
import type { PromptDeclineReason, PromptResult } from "./passphrase-prompt.ts";
import type {
  OpenResult as ProviderOpenResult,
  ProviderKeyStore,
  ProviderKeyStoreDeps,
} from "./provider-key-store.ts";
import type { StorePresenceResult } from "./store-presence.ts";

/** A fake `CredentialStore` whose `close()` call count is observable. */
function fakeCredentialStore(): { readonly store: CredentialStore; readonly calls: { close: number } } {
  const calls = { close: 0 };
  const store: CredentialStore = {
    mode: "persistent",
    saveConnection: () => ({ outcome: "ok" }),
    getConnection: () => undefined,
    listConnections: () => [],
    deleteConnection: () => ({ outcome: "ok" }),
    close: () => {
      calls.close++;
    },
  };
  return { store, calls };
}

/** A fake `ProviderKeyStore` — this store has no `close()` (no writer lock). */
function fakeProviderKeyStore(): ProviderKeyStore {
  return {
    mode: "persistent",
    saveKey: () => ({ outcome: "ok" }),
    getKey: () => undefined,
    listKeys: () => [],
    deleteKey: () => ({ outcome: "ok" }),
  };
}

/** Returns each element of `results` in turn, repeating the last once exhausted. */
function sequence<R>(results: readonly R[]): () => R {
  let i = 0;
  return () => {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r as R;
  };
}

/** Every seam `runFirstRunSetup` can invoke, script-able per test, always counted. */
type Scripts = {
  openCredential?: (deps: CredentialStoreDeps) => CredentialOpenResult;
  openProviderKeys?: (deps: ProviderKeyStoreDeps) => ProviderOpenResult;
  presence?: (dir: string) => StorePresenceResult;
  prompt?: (label: string) => Promise<PromptResult>;
  promptNew?: () => Promise<PromptResult>;
  isInteractive?: () => boolean;
};

/** A deps bag whose every seam is a counting spy over an optional script. */
function spyDeps(scripts: Scripts = {}) {
  const calls = {
    openCredential: 0,
    openProviderKeys: 0,
    presence: 0,
    prompt: 0,
    promptNew: 0,
    isInteractive: 0,
    stderr: 0,
  };
  const lines: string[] = [];

  const deps: FirstRunSetupDeps = {
    openCredential: (d) => {
      calls.openCredential++;
      if (!scripts.openCredential) throw new Error("openCredential not scripted for this test");
      return scripts.openCredential(d);
    },
    openProviderKeys: (d) => {
      calls.openProviderKeys++;
      if (!scripts.openProviderKeys) throw new Error("openProviderKeys not scripted for this test");
      return scripts.openProviderKeys(d);
    },
    presence: (dir) => {
      calls.presence++;
      if (!scripts.presence) throw new Error("presence not scripted for this test");
      return scripts.presence(dir);
    },
    prompt: (label) => {
      calls.prompt++;
      if (!scripts.prompt) throw new Error("prompt not scripted for this test");
      return scripts.prompt(label);
    },
    promptNew: () => {
      calls.promptNew++;
      if (!scripts.promptNew) throw new Error("promptNew not scripted for this test");
      return scripts.promptNew();
    },
    isInteractive: () => {
      calls.isInteractive++;
      return scripts.isInteractive ? scripts.isInteractive() : true;
    },
    stderr: (line) => {
      calls.stderr++;
      lines.push(line);
    },
  };
  return { deps, calls, lines };
}

describe("runFirstRunSetup — Ephemeral mode (hardest invariant)", () => {
  test("Ephemeral → skip, EVERY seam invoked zero times — no probe, no prompt, no ensureAppDir", async () => {
    const { deps, calls } = spyDeps();
    const result = await runFirstRunSetup("ephemeral", {}, deps);
    expect(result).toEqual({ outcome: "skip" });
    expect(calls).toEqual({
      openCredential: 0,
      openProviderKeys: 0,
      presence: 0,
      prompt: 0,
      promptNew: 0,
      isInteractive: 0,
      stderr: 0,
    });
  });
});

describe("runFirstRunSetup — transport already chosen (absolute precedence)", () => {
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ["QS_PASSPHRASE set", { QS_PASSPHRASE: "hunter2" }],
    ["QS_PASSPHRASE_FD valid", { QS_PASSPHRASE_FD: "3" }],
    ["QS_PASSPHRASE_FD malformed (operator opted out of env, no third fallback)", { QS_PASSPHRASE_FD: "abc" }],
  ];
  for (const [description, env] of cases) {
    test(`${description} → skip, zero probes, zero prompts`, async () => {
      const { deps, calls } = spyDeps();
      const result = await runFirstRunSetup("persistent", env, deps);
      expect(result).toEqual({ outcome: "skip" });
      expect(calls.openCredential).toBe(0);
      expect(calls.presence).toBe(0);
      expect(calls.prompt).toBe(0);
      expect(calls.promptNew).toBe(0);
      expect(calls.isInteractive).toBe(0);
    });
  }
});

describe("runFirstRunSetup — decline-probe classification", () => {
  test("probe opened (keychain available) → probe store closed once, skip, zero prompts", async () => {
    const cred = fakeCredentialStore();
    const { deps, calls } = spyDeps({
      openCredential: () => ({ outcome: "opened", store: cred.store }),
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result).toEqual({ outcome: "skip" });
    expect(calls.openCredential).toBe(1);
    expect(cred.calls.close).toBe(1);
    expect(calls.isInteractive).toBe(0);
    expect(calls.prompt).toBe(0);
    expect(calls.promptNew).toBe(0);
  });

  const otherOutcomes: readonly CredentialOpenResult[] = [
    { outcome: "locked", detail: "x" },
    { outcome: "corrupt", detail: "x" },
    { outcome: "key-unavailable", detail: "x" },
    { outcome: "unavailable", detail: "x" },
    { outcome: "key-invalid", detail: "x" },
    { outcome: "schema-unknown", detail: "x" },
  ];
  for (const probeResult of otherOutcomes) {
    test(`probe ${probeResult.outcome} → skip, zero prompts (a different problem)`, async () => {
      const { deps, calls } = spyDeps({ openCredential: () => probeResult });
      const result = await runFirstRunSetup("persistent", {}, deps);
      expect(result).toEqual({ outcome: "skip" });
      expect(calls.isInteractive).toBe(0);
      expect(calls.prompt).toBe(0);
      expect(calls.promptNew).toBe(0);
    });
  }
});

describe("runFirstRunSetup — non-interactive stdin", () => {
  test("passphrase-declined + non-TTY → zero prompts, one QS_PASSPHRASE_FD stderr line, skip", async () => {
    const { deps, calls, lines } = spyDeps({
      openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }),
      isInteractive: () => false,
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result).toEqual({ outcome: "skip" });
    expect(calls.prompt).toBe(0);
    expect(calls.promptNew).toBe(0);
    expect(calls.presence).toBe(0);
    expect(calls.stderr).toBe(1);
    expect(lines[0]).toContain("QS_PASSPHRASE_FD");
  });
});

describe("runFirstRunSetup — unlock (existing passphrase-mode credential store)", () => {
  test("wrong-then-right passphrase → exactly 2 prompts, provider, verify-open store closed once", async () => {
    const cred = fakeCredentialStore();
    const credentialResults = sequence<CredentialOpenResult>([
      { outcome: "passphrase-declined", detail: "x" }, // decline-probe
      { outcome: "corrupt", detail: "wrong key" }, // attempt 1: wrong passphrase
      { outcome: "opened", store: cred.store }, // attempt 2: correct
    ]);
    const promptResults = sequence<PromptResult>([
      { outcome: "provided", passphrase: "wrong-pass" },
      { outcome: "provided", passphrase: "right-pass" },
    ]);
    const { deps, calls } = spyDeps({
      openCredential: credentialResults,
      presence: () => ({ credential: "passphrase-mode", providerKeys: "first-run" }),
      prompt: async () => promptResults(),
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result.outcome).toBe("provider");
    expect(calls.prompt).toBe(2);
    expect(calls.openCredential).toBe(3);
    expect(cred.calls.close).toBe(1);
    // Review fix: the returned provider must carry the LAST typed passphrase
    // ("right-pass"), not the first wrong attempt — a bug swapping the two would
    // still pass every assertion above.
    if (result.outcome !== "provider") throw new Error("unreachable");
    expect(result.provider({ reason: "keychain-unavailable", isFirstRun: false })).toEqual({
      outcome: "provided",
      passphrase: "right-pass",
    });
  });

  test(`${MAX_UNLOCK_ATTEMPTS} wrong passphrases in a row → budget exhausted, skip, nothing else opened`, async () => {
    const credentialResults = sequence<CredentialOpenResult>([
      { outcome: "passphrase-declined", detail: "x" },
      { outcome: "corrupt", detail: "wrong" },
      { outcome: "corrupt", detail: "wrong" },
      { outcome: "corrupt", detail: "wrong" },
    ]);
    let promptCount = 0;
    const { deps, calls } = spyDeps({
      openCredential: credentialResults,
      presence: () => ({ credential: "passphrase-mode", providerKeys: "first-run" }),
      prompt: async () => {
        promptCount++;
        return { outcome: "provided", passphrase: `attempt-${promptCount}` };
      },
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result).toEqual({ outcome: "skip" });
    expect(calls.prompt).toBe(MAX_UNLOCK_ATTEMPTS);
    expect(calls.openCredential).toBe(1 + MAX_UNLOCK_ATTEMPTS);
  });

  test("verify returns an unrelated failure (locked) → skip immediately, no further retries", async () => {
    const credentialResults = sequence<CredentialOpenResult>([
      { outcome: "passphrase-declined", detail: "x" },
      { outcome: "locked", detail: "another writer holds the lock" },
    ]);
    const { deps, calls } = spyDeps({
      openCredential: credentialResults,
      presence: () => ({ credential: "passphrase-mode", providerKeys: "first-run" }),
      prompt: async () => ({ outcome: "provided", passphrase: "whatever" }),
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result).toEqual({ outcome: "skip" });
    expect(calls.prompt).toBe(1);
    expect(calls.openCredential).toBe(2);
  });

  test("provider-key descriptor present, credential descriptor absent → unlock targets the provider-key store (no confirmation)", async () => {
    const providerStore = fakeProviderKeyStore();
    const { deps, calls, lines } = spyDeps({
      openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }), // decline-probe: credential is true-first-run, keychain down
      openProviderKeys: () => ({ outcome: "opened", store: providerStore }),
      presence: () => ({ credential: "first-run", providerKeys: "passphrase-mode" }),
      prompt: async () => ({ outcome: "provided", passphrase: "shared-pass" }),
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result.outcome).toBe("provider");
    // The all-clean NEGATIVE case, asserted nowhere else: with neither store
    // orphaned and the passphrase right on the first try, this boot must be
    // COMPLETELY silent. Every other advisory test asserts what IS printed, so an
    // unconditional notice — or a predicate inverted from `=== "orphaned-descriptor"`
    // to `!==` — would satisfy all of them while shouting at every ordinary unlock on
    // every boot. This is also the invariant the whole module is built around: a
    // returning user's boot stays byte-for-byte silent.
    expect(lines).toEqual([]);
    expect(calls.stderr).toBe(0);
    // Unlock (prompt), never create (promptNew) — no confirmation for an unlock.
    expect(calls.prompt).toBe(1);
    expect(calls.promptNew).toBe(0);
    expect(calls.openProviderKeys).toBe(1);
    // Credential store is never re-verified — the provider-key store is the one
    // holding the descriptor, so it alone is the reopen target.
    expect(calls.openCredential).toBe(1);
    // Review fix: assert the returned provider actually carries the typed
    // passphrase, not just that the outcome tag is "provider".
    if (result.outcome !== "provider") throw new Error("unreachable");
    expect(result.provider({ reason: "keychain-unavailable", isFirstRun: false })).toEqual({
      outcome: "provided",
      passphrase: "shared-pass",
    });
  });
});

describe("runFirstRunSetup — orphaned descriptors (descriptor present, .enc missing — DW-86)", () => {
  // The advisory strings are duplicated here VERBATIM on purpose (the same pinning
  // both stores' `"descriptor present but store file is missing"` detail gets): this
  // text is the entire user-facing value of DW-86, and its exact wording is
  // load-bearing. In particular the remedy must keep RESTORE first and must keep
  // flagging descriptor deletion as IRREVERSIBLE — an earlier revision offered the
  // two as co-equal options on one line, which is how a user with a restorable
  // backup destroys it (deleting the descriptor mints a new salt, after which the
  // restored `.enc` can never be decrypted).
  // The file names are spelled out here rather than interpolated from the stores'
  // constants for the same reason: interpolating both sides would let a rename slip
  // through silently, and naming the file is the difference between "something is
  // broken" and an instruction the user can act on.
  const NOTICE_CREDENTIAL =
    "quick-studio: the credential store has a passphrase descriptor (credential-store.meta.json) but its encrypted file (credential-store.enc) is missing — no passphrase can unlock it.\n";
  const NOTICE_PROVIDER_KEYS =
    "quick-studio: the provider-key store has a passphrase descriptor (provider-keys.meta.json) but its encrypted file (provider-keys.enc) is missing — no passphrase can unlock it.\n";
  const REMEDY =
    "quick-studio: restore each missing file named above from a backup if you have one, next to its descriptor — that descriptor is what decrypts it.\n" +
    "quick-studio: deleting a descriptor starts that store over, but is IRREVERSIBLE: a new store mints a new salt, so an .enc restored afterwards can never be decrypted.\n";
  const BOTH =
    "quick-studio: both stores are affected — removing only one descriptor changes nothing here, the next boot is blocked by the other.\n";
  const BLOCKED =
    "quick-studio: until then nothing is created here either — a fresh passphrase would orphan whatever the existing descriptor still protects.\n";

  test("credential orphaned, nothing else → ZERO prompts, the EXACT notice + remedy + blocked lines, skip (never three futile prompts)", async () => {
    const { deps, calls, lines } = spyDeps({
      openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }), // decline-probe
      presence: () => ({ credential: "orphaned-descriptor", providerKeys: "first-run" }),
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result).toEqual({ outcome: "skip" });
    // The whole point: no answer can ever open this store, so do not ask for one.
    expect(calls.prompt).toBe(0);
    expect(calls.promptNew).toBe(0);
    // Only the decline-probe touched a store — no verify-open was attempted.
    expect(calls.openCredential).toBe(1);
    expect(calls.openProviderKeys).toBe(0);
    // Full exact strings, not substrings: the remediation clause is the part a
    // `toContain("encrypted file is missing")` would happily let anyone rewrite.
    expect(lines).toEqual([NOTICE_CREDENTIAL, REMEDY, BLOCKED]);
  });

  test("BOTH stores orphaned → zero prompts, one notice per store then the remedy ONCE, the both-stores warning, then blocked, skip", async () => {
    const { deps, calls, lines } = spyDeps({
      openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }),
      presence: () => ({ credential: "orphaned-descriptor", providerKeys: "orphaned-descriptor" }),
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result).toEqual({ outcome: "skip" });
    expect(calls.prompt).toBe(0);
    expect(calls.promptNew).toBe(0);
    expect(calls.openProviderKeys).toBe(0);
    // Two notices, but the ~200-character remedy is stated ONCE, not per store —
    // followed by the warning that only exists on this layout: deleting ONE
    // descriptor leaves the other orphan blocking the next boot, and a user who is
    // not told that reads the unchanged output as "the deletion did not work".
    expect(lines).toEqual([NOTICE_CREDENTIAL, NOTICE_PROVIDER_KEYS, REMEDY, BOTH, BLOCKED]);
  });

  // The complement of the test above: with exactly ONE store orphaned the
  // both-stores warning must NOT appear, because deleting that single descriptor
  // really does unblock the next boot. Pinning its absence is what stops the line
  // from being made unconditional (which would be false on every other layout).
  test("only ONE store orphaned → the both-stores warning is never emitted", async () => {
    const { deps, lines } = spyDeps({
      openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }),
      presence: () => ({ credential: "first-run", providerKeys: "orphaned-descriptor" }),
    });
    await runFirstRunSetup("persistent", {}, deps);
    expect(lines).not.toContain(BOTH);
    expect(lines).toEqual([NOTICE_PROVIDER_KEYS, REMEDY, BLOCKED]);
  });

  test("credential orphaned + providerKeys passphrase-mode → targets the provider-key store, notice+remedy BEFORE the prompt, no BLOCKED line, still winnable", async () => {
    const providerStore = fakeProviderKeyStore();
    // Snapshot how much had been said by the time the prompt was raised: the whole
    // user-facing value of DW-86 is "explain before you ask", and without this the
    // ordering is only incidental — emitting the advisory AFTER the prompt would
    // otherwise satisfy every other assertion in this test.
    let linesAtPrompt: readonly string[] = [];
    const { deps, calls, lines } = spyDeps({
      openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }), // decline-probe only
      openProviderKeys: () => ({ outcome: "opened", store: providerStore }),
      presence: () => ({ credential: "orphaned-descriptor", providerKeys: "passphrase-mode" }),
      prompt: async () => {
        linesAtPrompt = [...lines];
        return { outcome: "provided", passphrase: "shared-pass" };
      },
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result.outcome).toBe("provider");
    // Exactly one prompt, against the store that CAN open — a half-broken app dir
    // stays recoverable instead of being written off.
    expect(calls.prompt).toBe(1);
    expect(calls.promptNew).toBe(0);
    expect(calls.openProviderKeys).toBe(1);
    expect(calls.openCredential).toBe(1);
    // No BLOCKED line here: that store DOES unlock, so "nothing is created here
    // either" would flatly contradict the prompt that follows.
    expect(lines).toEqual([NOTICE_CREDENTIAL, REMEDY]);
    // …and both were already on stderr when the prompt was raised.
    expect(linesAtPrompt).toEqual([NOTICE_CREDENTIAL, REMEDY]);
    if (result.outcome !== "provider") throw new Error("unreachable");
    expect(result.provider({ reason: "keychain-unavailable", isFirstRun: false })).toEqual({
      outcome: "provided",
      passphrase: "shared-pass",
    });
  });

  test("credential passphrase-mode + providerKeys orphaned → targets the credential store, notice+remedy BEFORE the prompt, no BLOCKED line", async () => {
    const cred = fakeCredentialStore();
    const credentialResults = sequence<CredentialOpenResult>([
      { outcome: "passphrase-declined", detail: "x" }, // decline-probe
      { outcome: "opened", store: cred.store }, // verify-open under the typed passphrase
    ]);
    let linesAtPrompt: readonly string[] = [];
    const { deps, calls, lines } = spyDeps({
      openCredential: credentialResults,
      presence: () => ({ credential: "passphrase-mode", providerKeys: "orphaned-descriptor" }),
      prompt: async () => {
        linesAtPrompt = [...lines];
        return { outcome: "provided", passphrase: "shared-pass" };
      },
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result.outcome).toBe("provider");
    expect(calls.prompt).toBe(1);
    expect(calls.promptNew).toBe(0);
    expect(calls.openCredential).toBe(2);
    expect(calls.openProviderKeys).toBe(0);
    // The verify-open's DW-14 writer lock is released exactly once.
    expect(cred.calls.close).toBe(1);
    expect(lines).toEqual([NOTICE_PROVIDER_KEYS, REMEDY]);
    expect(linesAtPrompt).toEqual([NOTICE_PROVIDER_KEYS, REMEDY]);
  });

  // This store has never been set up, but the OTHER one has an orphaned descriptor.
  // `anyDescriptorPresent` is true because of that FOREIGN orphan, so `runCreatePath`
  // is unreachable and the user gets zero prompts — not even the create prompt they
  // would get on a truly virgin machine.
  //
  // This is the CORRECT, data-safe routing and must not be "fixed" into a create.
  // Be precise about WHY, because the obvious reason is wrong: `runCreatePath` calls
  // `openCredential` only, and the credential store writes only its OWN descriptor —
  // it never touches `provider-keys.meta.json`, so creating here does not overwrite
  // the orphaned descriptor and a restored provider `.enc` stays decryptable by its
  // original passphrase. The real hazard is passphrase DIVERGENCE under the "two
  // descriptors, one passphrase" convention (`store-presence.ts`): a create mints a
  // fresh salt for THIS store, so the user would end up holding one passphrase for
  // the store created today and a different, older one for whatever the surviving
  // descriptor still protects — with nothing in the product to tell them which is
  // which. Being told what is broken and doing nothing beats silently splitting the
  // app dir across two passphrases.
  //
  // On REACHABILITY, which differs between the two rows and must not be conflated:
  //  - `credential: "first-run"` is genuinely reachable. Descriptor absent AND `.enc`
  //    absent with the keychain down makes the real `openPersistent` fall through to
  //    its passphrase fallback, so the decline-probe really does return
  //    `passphrase-declined` and control really does reach step (5).
  //  - `credential: "keychain-mode"` is NOT reachable through `runFirstRunSetup` in
  //    production. Descriptor absent + `.enc` present takes `openPersistent`'s
  //    keychain arm (`credential-store.ts`), which never calls the passphrase
  //    provider at all — the probe returns `opened`/`key-unavailable`/`key-invalid`
  //    and the pre-flight skips at step (3) with no advisory whatsoever. That gap is
  //    real, pre-existing, and tracked as DW-135; it is NOT what this row proves.
  //    The row is kept as a synthetic entry point that pins `unlockTarget` and the
  //    advisory block for the presence combination itself, so the loop stays correct
  //    if DW-135 is ever fixed by letting that layout through.
  const trappedCases: Array<[string, StorePresenceResult]> = [
    [
      "credential first-run + providerKeys orphaned (reachable in production)",
      { credential: "first-run", providerKeys: "orphaned-descriptor" },
    ],
    [
      "credential keychain-mode + providerKeys orphaned (synthetic: the real probe skips at step 3 — DW-135)",
      { credential: "keychain-mode", providerKeys: "orphaned-descriptor" },
    ],
  ];
  for (const [description, presence] of trappedCases) {
    test(`${description} → the FOREIGN orphan blocks the create path: zero prompts, promptNew never called, skip`, async () => {
      const { deps, calls, lines } = spyDeps({
        openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }), // decline-probe
        presence: () => presence,
      });
      const result = await runFirstRunSetup("persistent", {}, deps);
      expect(result).toEqual({ outcome: "skip" });
      // Zero prompts of EITHER kind — in particular `promptNew`, which is what a
      // "this store is first-run, so create it" reading would have called.
      expect(calls.prompt).toBe(0);
      expect(calls.promptNew).toBe(0);
      // Only the decline-probe touched a store; nothing was created or written.
      expect(calls.openCredential).toBe(1);
      expect(calls.openProviderKeys).toBe(0);
      // …and the user is told exactly why, including why nothing is created here.
      expect(lines).toEqual([NOTICE_PROVIDER_KEYS, REMEDY, BLOCKED]);
    });
  }
});

describe("runFirstRunSetup — create (true first run, no descriptor anywhere)", () => {
  test("no descriptor anywhere → promptNew used (never prompt), eager open, provider", async () => {
    const cred = fakeCredentialStore();
    const credentialResults = sequence<CredentialOpenResult>([
      { outcome: "passphrase-declined", detail: "x" }, // decline-probe: true first run, keychain down
      { outcome: "opened", store: cred.store }, // eager create-open under the new passphrase
    ]);
    const { deps, calls } = spyDeps({
      openCredential: credentialResults,
      presence: () => ({ credential: "first-run", providerKeys: "first-run" }),
      promptNew: async () => ({ outcome: "provided", passphrase: "new-pass" }),
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result.outcome).toBe("provider");
    expect(calls.promptNew).toBe(1);
    expect(calls.prompt).toBe(0);
    expect(calls.openCredential).toBe(2);
    expect(cred.calls.close).toBe(1);
    // Review fix: assert the returned provider actually carries the typed
    // passphrase, not just that the outcome tag is "provider".
    if (result.outcome !== "provider") throw new Error("unreachable");
    expect(result.provider({ reason: "keychain-unavailable", isFirstRun: true })).toEqual({
      outcome: "provided",
      passphrase: "new-pass",
    });
  });

  test("eager open fails after a valid confirmation → skip, failure detail on stderr", async () => {
    const credentialResults = sequence<CredentialOpenResult>([
      { outcome: "passphrase-declined", detail: "x" },
      { outcome: "unavailable", detail: "disk full" },
    ]);
    const { deps, calls, lines } = spyDeps({
      openCredential: credentialResults,
      presence: () => ({ credential: "first-run", providerKeys: "first-run" }),
      promptNew: async () => ({ outcome: "provided", passphrase: "new-pass" }),
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result).toEqual({ outcome: "skip" });
    // One preamble line (why a passphrase is being asked for) plus one failure
    // line naming the store-open detail.
    expect(calls.stderr).toBe(2);
    expect(lines.some((l) => l.includes("disk full"))).toBe(true);
  });
});

describe("runFirstRunSetup — prompt decline-reason mapping", () => {
  const nonAbortReasons: readonly PromptDeclineReason[] = ["non-tty", "empty", "mismatch", "unsupported"];

  for (const reason of nonAbortReasons) {
    test(`unlock: prompt declined:${reason} → skip, a reason line then the QS_PASSPHRASE_FD pointer`, async () => {
      const { deps, calls, lines } = spyDeps({
        openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }),
        presence: () => ({ credential: "passphrase-mode", providerKeys: "first-run" }),
        prompt: async () => ({ outcome: "declined", reason }),
      });
      const result = await runFirstRunSetup("persistent", {}, deps);
      expect(result).toEqual({ outcome: "skip" });
      // Review fix: the reason is now explained BEFORE the transport pointer — all
      // four reasons used to emit the FD line and nothing else.
      expect(calls.stderr).toBe(2);
      expect(lines[0]).not.toContain("QS_PASSPHRASE_FD");
      expect(lines[1]).toContain("QS_PASSPHRASE_FD");
    });

    test(`create: promptNew declined:${reason} → skip, one QS_PASSPHRASE_FD stderr pointer`, async () => {
      const { deps, calls, lines } = spyDeps({
        openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }),
        presence: () => ({ credential: "first-run", providerKeys: "first-run" }),
        promptNew: async () => ({ outcome: "declined", reason }),
      });
      const result = await runFirstRunSetup("persistent", {}, deps);
      expect(result).toEqual({ outcome: "skip" });
      // One preamble-context line PLUS the FD pointer both go to stderr; only the
      // FD pointer's exact wording matters here, so search across all lines.
      expect(calls.stderr).toBeGreaterThanOrEqual(1);
      expect(lines.some((l) => l.includes("QS_PASSPHRASE_FD"))).toBe(true);
    });
  }

  test("each non-abort decline reason gets a DISTINCT explanation line", async () => {
    const explanations: string[] = [];
    for (const reason of nonAbortReasons) {
      const { deps, lines } = spyDeps({
        openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }),
        presence: () => ({ credential: "passphrase-mode", providerKeys: "first-run" }),
        prompt: async () => ({ outcome: "declined", reason }),
      });
      await runFirstRunSetup("persistent", {}, deps);
      explanations.push(lines[0] ?? "");
    }
    expect(new Set(explanations).size).toBe(nonAbortReasons.length);
    expect(explanations.every((l) => l.startsWith("quick-studio: "))).toBe(true);
  });

  test("unlock: prompt declined:aborted → {outcome:'aborted'}, this module never calls process.exit", async () => {
    const { deps, calls } = spyDeps({
      openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }),
      presence: () => ({ credential: "passphrase-mode", providerKeys: "first-run" }),
      prompt: async () => ({ outcome: "declined", reason: "aborted" }),
    });
    // If this module ever called process.exit, this test process would terminate
    // here instead of reaching the assertions below.
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result).toEqual({ outcome: "aborted" });
    expect(calls.prompt).toBe(1);
  });

  test("create: promptNew declined:aborted → {outcome:'aborted'}", async () => {
    const { deps } = spyDeps({
      openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }),
      presence: () => ({ credential: "first-run", providerKeys: "first-run" }),
      promptNew: async () => ({ outcome: "declined", reason: "aborted" }),
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result).toEqual({ outcome: "aborted" });
  });
});
