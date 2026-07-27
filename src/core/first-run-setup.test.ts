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
    const { deps, calls } = spyDeps({
      openCredential: () => ({ outcome: "passphrase-declined", detail: "x" }), // decline-probe: credential is true-first-run, keychain down
      openProviderKeys: () => ({ outcome: "opened", store: providerStore }),
      presence: () => ({ credential: "first-run", providerKeys: "passphrase-mode" }),
      prompt: async () => ({ outcome: "provided", passphrase: "shared-pass" }),
    });
    const result = await runFirstRunSetup("persistent", {}, deps);
    expect(result.outcome).toBe("provider");
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
