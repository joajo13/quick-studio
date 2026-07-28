/**
 * Covers `isFirstRunBoot`'s whole decision surface — the Ephemeral short-circuit
 * (zero seam calls, the hardest invariant), the 4×4 `(credential, providerKeys)`
 * classification matrix crossed onto ONE boolean (`true` only when BOTH are
 * `"first-run"`, so the DW-86 `"orphaned-descriptor"` state reports a CONFIGURED
 * machine, not a virgin one), and the total-never-throws fallback — over INJECTED
 * `resolveDir`/`classify` spies, so no real disk is touched. Also covers
 * `FIRST_RUN_HINT`'s "never leak a path" boundary, mirroring
 * `update-check.test.ts`'s `spyDeps` pattern and `store-presence.test.ts`'s
 * hand-rolled table-test convention.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR_NAME } from "./app-dir.ts";
import { STORE_META_FILE_NAME } from "./credential-store.ts";
import { FIRST_RUN_HINT, isFirstRunBoot, type FirstRunSignalDeps } from "./first-run-signal.ts";
import type { StorePresence, StorePresenceResult } from "./store-presence.ts";

const ENV = {};
const PLATFORM: NodeJS.Platform = "linux";

const FAKE_DIR = "/fake/app-dir";

/**
 * A deps bag whose every seam is a counting spy, so a test can assert zero calls.
 * The spies also RECORD their arguments: discarding them would leave the whole
 * `resolveDir(env, platform) -> classify(thatDir)` wiring unverified — a refactor
 * that passed `platform` as `env`, or that classified a hardcoded path instead of
 * the resolved one, would still have passed every row of the matrix below.
 */
function spyDeps(overrides: Partial<FirstRunSignalDeps> = {}) {
  const calls = { resolveDir: 0, classify: 0 };
  const args: {
    resolveDir: { env: unknown; platform: NodeJS.Platform } | null;
    classify: string | null;
  } = { resolveDir: null, classify: null };
  const deps: FirstRunSignalDeps = {
    resolveDir: (env, platform) => {
      calls.resolveDir++;
      args.resolveDir = { env, platform };
      return FAKE_DIR;
    },
    classify: (dir) => {
      calls.classify++;
      args.classify = dir;
      return { credential: "first-run", providerKeys: "first-run" };
    },
    ...overrides,
  };
  return { deps, calls, args };
}

describe("isFirstRunBoot — seam wiring", () => {
  test("resolveDir receives (env, platform) verbatim and classify receives exactly its result", () => {
    const env = { HOME: "/home/someone" };
    const { deps, args } = spyDeps();
    isFirstRunBoot("persistent", env, "win32", deps);
    expect(args.resolveDir).toEqual({ env, platform: "win32" });
    expect(args.classify).toBe(FAKE_DIR);
  });

  test("a non-absolute resolved dir → true WITHOUT classifying (never probe the CWD)", () => {
    // `HOME` unset AND an empty `os.homedir()` makes `resolveAppDir` return a
    // relative path; `existsSync` would resolve it against the process CWD.
    const { deps, calls } = spyDeps({ resolveDir: () => "quick-studio" });
    expect(isFirstRunBoot("persistent", ENV, PLATFORM, deps)).toBe(true);
    expect(calls.classify).toBe(0);
  });
});

describe("isFirstRunBoot — Ephemeral short-circuit (hardest invariant)", () => {
  test("Ephemeral mode → false, with ZERO calls to resolveDir/classify", () => {
    const { deps, calls } = spyDeps();
    expect(isFirstRunBoot("ephemeral", ENV, PLATFORM, deps)).toBe(false);
    expect(calls).toEqual({ resolveDir: 0, classify: 0 });
  });
});

describe("isFirstRunBoot — Persistent, the 4×4 presence matrix", () => {
  // `orphaned-descriptor` (DW-84) is included deliberately: a descriptor on disk
  // means the machine IS configured — broken, but configured — so the first-run
  // hint must stay OFF for it. Only `first-run`/`first-run` is a virgin machine.
  const modes: readonly StorePresence[] = [
    "passphrase-mode",
    "orphaned-descriptor",
    "keychain-mode",
    "first-run",
  ];

  // [credential, providerKeys, expected]
  const cases: Array<[StorePresence, StorePresence, boolean]> = [];
  for (const credential of modes) {
    for (const providerKeys of modes) {
      cases.push([
        credential,
        providerKeys,
        credential === "first-run" && providerKeys === "first-run",
      ]);
    }
  }

  for (const [credential, providerKeys, expected] of cases) {
    test(`credential=${credential}, providerKeys=${providerKeys} → ${expected}`, () => {
      const result: StorePresenceResult = { credential, providerKeys };
      let classifyCalls = 0;
      const { deps, calls } = spyDeps({
        classify: () => {
          classifyCalls++;
          return result;
        },
      });
      expect(isFirstRunBoot("persistent", ENV, PLATFORM, deps)).toBe(expected);
      expect(calls.resolveDir).toBe(1);
      expect(classifyCalls).toBe(1);
    });
  }

  test("descriptor absent, .enc present (Story 2.2 back-compat keychain-mode) → configured, false", () => {
    const { deps } = spyDeps({
      classify: () => ({ credential: "keychain-mode", providerKeys: "first-run" }),
    });
    expect(isFirstRunBoot("persistent", ENV, PLATFORM, deps)).toBe(false);
  });
});

describe("isFirstRunBoot — total, never throws", () => {
  test("a throwing resolveDir → true (degrade to first-run, never crash)", () => {
    const { deps } = spyDeps({
      resolveDir: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(isFirstRunBoot("persistent", ENV, PLATFORM, deps)).toBe(true);
  });

  test("a throwing classify → true (degrade to first-run, never crash)", () => {
    const { deps } = spyDeps({
      classify: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(isFirstRunBoot("persistent", ENV, PLATFORM, deps)).toBe(true);
  });
});

describe("isFirstRunBoot — defaults", () => {
  // Asserting only `true` here would be degenerate — `true` is ALSO what the
  // `catch` and the `!isAbsolute` short-circuit return, so a broken default seam
  // (one that threw, or returned a relative path) would pass while claiming to prove
  // the real wiring. The discriminating assertion is the `false` one below: `false`
  // is reachable ONLY by `resolveAppDir` landing on the real directory AND
  // `classifyStorePresence` finding a real file in it.
  test("real resolveAppDir + real classifyStorePresence: a lone descriptor (an `orphaned-descriptor` store, DW-84) → configured, false", () => {
    const root = mkdtempSync(join(tmpdir(), "qs-11-7-"));
    try {
      // XDG layout: `$XDG_DATA_HOME/quick-studio` (linux arm of `resolveAppDir`).
      // Only the meta file is written and no `.enc`, so since DW-84 this exercises
      // `orphaned-descriptor` specifically, not `passphrase-mode` — which is the
      // point: a descriptor with no ciphertext is configured-and-broken, and the
      // first-run hint must stay OFF for it just the same.
      const appDir = join(root, APP_DIR_NAME);
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, STORE_META_FILE_NAME), "{}");
      expect(isFirstRunBoot("persistent", { XDG_DATA_HOME: root }, "linux")).toBe(false);
      // Same env, same seams, file removed → flips back to true. Pins that the
      // `false` above came from the FILE, not from the env shape.
      rmSync(join(appDir, STORE_META_FILE_NAME));
      expect(isFirstRunBoot("persistent", { XDG_DATA_HOME: root }, "linux")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory that does not exist → first-run, and the real seams never throw", () => {
    expect(
      isFirstRunBoot("persistent", { HOME: "/definitely/does/not/exist/qs-11-7-probe" }, PLATFORM),
    ).toBe(true);
  });
});

describe("FIRST_RUN_HINT — the 'never leak a path' boundary", () => {
  test("names both paths forward: the UI form and the Ephemeral one-liner", () => {
    expect(FIRST_RUN_HINT).toContain("UI");
    // Each label is quoted in the spelling the control ACTUALLY renders, which is
    // NOT uniform — a hint naming a label that does not exist verbatim on screen is
    // a hint the user has to translate. The Tab title is capital-S `Settings`
    // (`openOrFocusSettings`, rendered verbatim by `TabBar`); the section button
    // inside the panel is lowercase mono `connections` (`SettingsPanel`).
    expect(FIRST_RUN_HINT).toContain('"Settings"');
    expect(FIRST_RUN_HINT).toContain('"connections"');
    // Pins the mismatch that a "tidy them all lowercase" edit would reintroduce.
    expect(FIRST_RUN_HINT).not.toContain('"settings"');
    expect(FIRST_RUN_HINT).toContain("quick-studio <database-url>");
  });

  test("says 'no connections', not 'nothing configured' — the 11.6 pre-flight may have just created a store in this same boot", () => {
    expect(FIRST_RUN_HINT).toContain("no connections saved yet");
    expect(FIRST_RUN_HINT).not.toContain("nothing configured");
  });

  test("ends in a newline", () => {
    expect(FIRST_RUN_HINT.endsWith("\n")).toBe(true);
  });

  test("contains no path separator, no URL scheme, and no app-dir substring", () => {
    expect(FIRST_RUN_HINT).not.toContain("/");
    expect(FIRST_RUN_HINT).not.toContain("\\");
    expect(FIRST_RUN_HINT).not.toContain("://");
    expect(FIRST_RUN_HINT.toLowerCase()).not.toContain("appdata");
    expect(FIRST_RUN_HINT.toLowerCase()).not.toContain(".local");
  });
});
