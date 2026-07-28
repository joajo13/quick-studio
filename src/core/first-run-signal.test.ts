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
 *
 * THREE cases deliberately leave `resolveDir` UN-spied, for the same underlying
 * reason — a spy handing back a ready-made path renders the real resolver
 * invisible: the DW-93 separator regression (which spies `classify` only, since the
 * separator bug lived inside the real `resolveAppDir`) and both `defaults` cases
 * (which inject nothing at all, so BOTH real seams run).
 *
 * On what keeps this file honest: NO workflow in `.github/workflows/` runs this
 * suite — `keyring-spike.yml` runs `src/core/keychain.test.ts` and nothing else,
 * and `publish.yml`/`release.yml` run no tests. Its greenness therefore only ever
 * reflects whichever machine a developer happened to run it on (POSIX in practice).
 * No second host will ever flag a host-dependent case for us, so there must not be
 * one — which is what the split below is about.
 *
 * The HOST/TARGET split rules every case in this file, since DW-93 made the
 * resolver's separator come from its `platform` ARGUMENT instead of the host:
 *  - A case that only asserts a PATH STRING (spied seams, or the pure `resolveAppDir`
 *    with a spied `classify`) may hardcode a platform — nothing about it depends on
 *    which machine runs it.
 *  - A case that touches the REAL FILESYSTEM must ask for `process.platform` and set
 *    the env key THAT platform's convention actually reads, because the disk it
 *    writes to is the host's ({@link hostAppDirFixture}). Pairing a host-built
 *    fixture (`mkdtempSync`/`join`/`tmpdir`) with a hardcoded foreign platform is
 *    the trap: on a Windows runner `posix.isAbsolute("C:\\…\\qs-11-7-XXXX/quick-studio")`
 *    is `false`, the absoluteness guard fires, and a case expecting `false` gets
 *    `true`.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR_NAME, type AppDirEnv } from "./app-dir.ts";
import { STORE_META_FILE_NAME } from "./credential-store.ts";
import { FIRST_RUN_HINT, isFirstRunBoot, type FirstRunSignalDeps } from "./first-run-signal.ts";
import type { StorePresence, StorePresenceResult } from "./store-presence.ts";

const ENV = {};
/**
 * The platform for the PRE-EXISTING spied cases (matrix, throws, Ephemeral) — the
 * value they have always used, kept named so it is obviously arbitrary: with
 * `resolveDir` spied, no arm of the resolver runs and the platform only reaches the
 * absoluteness check, which `/fake/app-dir` passes under either flavour.
 *
 * The two newer spied cases use bare `"win32"` literals instead, deliberately: they
 * are ABOUT the win32 arm, and they are still host-independent for the reason in the
 * header — they assert pure path strings and touch no disk. What must never appear
 * is a hardcoded platform on a case that writes to the real filesystem; those use
 * `process.platform` + {@link hostAppDirFixture}.
 */
const PLATFORM: NodeJS.Platform = "linux";

const FAKE_DIR = "/fake/app-dir";

/**
 * The `(env, appDir)` pair a real-filesystem fixture rooted at `root` must use on
 * THIS host: the env key the host's own `resolveAppDir` arm reads, and the directory
 * that arm will therefore resolve to. Paired with `process.platform` at the call
 * site, so host `join` is the correct flavour here by construction.
 *
 * Exists because the fixture root comes from `mkdtempSync`/`tmpdir`, i.e. from the
 * host — so the platform asked of `isFirstRunBoot` must be the host's too (DW-93).
 * Hardcoding `"linux"` + `XDG_DATA_HOME` worked only for as long as the resolver
 * inherited the host's separator.
 */
function hostAppDirFixture(root: string): { readonly env: AppDirEnv; readonly appDir: string } {
  if (process.platform === "win32") {
    return { env: { APPDATA: root }, appDir: join(root, APP_DIR_NAME) };
  }
  if (process.platform === "darwin") {
    return {
      env: { HOME: root },
      appDir: join(root, "Library", "Application Support", APP_DIR_NAME),
    };
  }
  return { env: { XDG_DATA_HOME: root }, appDir: join(root, APP_DIR_NAME) };
}

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

  // The same guard, win32 arm, FAILING direction. `C:quick-studio` is the
  // drive-RELATIVE Windows form: `win32.isAbsolute` says `false` for it, so the
  // guard must fire exactly as it does for the posix case above. Without this the
  // win32 arm would only ever be exercised in its passing direction, and a guard
  // that had been weakened to `platform === "win32" || isAbsolute(dir)` would still
  // look covered. Spied `resolveDir` → asserts a pure decision, no disk.
  test("a win32-RELATIVE resolved dir under platform win32 → true WITHOUT classifying", () => {
    const { deps, calls } = spyDeps({ resolveDir: () => "C:quick-studio" });
    expect(isFirstRunBoot("persistent", ENV, "win32", deps)).toBe(true);
    expect(calls.classify).toBe(0);
  });

  // DW-93 regression. Deliberately NO `resolveDir` spy: the bug lived in the REAL
  // `resolveAppDir`, which used to join with the HOST's separator, so a spy handing
  // back a ready-made path cannot see it. Pre-fix, on a POSIX host this returned the
  // mixed `C:\Users\dev\AppData\Roaming/quick-studio`, the host `isAbsolute` called
  // it RELATIVE, and the guard short-circuited to a spurious `true` without ever
  // reaching `classify`. So the load-bearing assertion is that `classify` IS
  // invoked, with the all-backslash win32 path. `resolveAppDir` is pure and
  // `classify` is spied, so nothing here touches disk — which is why hardcoding
  // `"win32"` is legitimate in this case and not in the real-seam ones below.
  //
  // This regression is ONE-DIRECTIONAL, and only discriminating on a POSIX host —
  // where it is the only host this suite is ever run on (see the header), so it is
  // the right test for the machine that can run it. On a Windows runner the host
  // flavour IS win32, `win32.isAbsolute` accepts the dir, `classify` is reached and
  // the separator comes out all-backslash anyway: the case would pass against a
  // completely unfixed implementation.
  //
  // There is deliberately no mirror case in the foreign-POSIX direction
  // (`platform: "linux"` + spied `classify`). It could not fail on EITHER host:
  // `win32.isAbsolute("/custom/xdg/quick-studio")` is `true`, so a Windows runner
  // reaches `classify` with a host-flavoured resolver too, and `posix.join` on a
  // POSIX host is the host flavour by definition. A test that cannot fail is worse
  // than the asymmetry it would paper over; `app-dir.test.ts` pins that direction
  // where it CAN be pinned, on the pure resolver's `not.toContain("\\")` rows.
  test("a foreign win32 platform with %APPDATA% set → the guard does NOT fire; classify is reached with the all-backslash win32 path", () => {
    const APPDATA = "C:\\Users\\dev\\AppData\\Roaming";
    const seen: string[] = [];
    // The returned boolean is deliberately NOT asserted: it would only measure the
    // fabricated `classify` stub below and couple this separator claim to the
    // presence matrix's AND-logic, which its own block already owns.
    isFirstRunBoot("persistent", { APPDATA }, "win32", {
      classify: (dir) => {
        seen.push(dir);
        return { credential: "passphrase-mode", providerKeys: "first-run" };
      },
    });
    // The LITERAL, not `win32.join(APPDATA, APP_DIR_NAME)`: recomputing with the
    // same primitive the implementation uses would leave this circular, saved only
    // by the `not.toContain("/")` below. `app-dir.test.ts` pins the identical
    // literal for the same path.
    expect(seen).toEqual(["C:\\Users\\dev\\AppData\\Roaming\\quick-studio"]);
    expect(seen[0]).not.toContain("/");
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
      // REAL disk, so `process.platform` and the matching env key — never a
      // hardcoded `"linux"` + `XDG_DATA_HOME` against a host-built temp dir
      // (DW-93). Only the meta file is written and no `.enc`, so since DW-84 this
      // exercises `orphaned-descriptor` specifically, not `passphrase-mode` —
      // which is the point: a descriptor with no ciphertext is
      // configured-and-broken, and the first-run hint must stay OFF for it just
      // the same.
      const { env, appDir } = hostAppDirFixture(root);
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, STORE_META_FILE_NAME), "{}");
      expect(isFirstRunBoot("persistent", env, process.platform)).toBe(false);
      // Same env, same seams, file removed → flips back to true. Pins that the
      // `false` above came from the FILE, not from the env shape.
      rmSync(join(appDir, STORE_META_FILE_NAME));
      expect(isFirstRunBoot("persistent", env, process.platform)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory that does not exist → first-run, and the real seams never throw", () => {
    // Also a REAL-seam case (`classifyStorePresence` calls `existsSync`), so the
    // same rule applies: an absolute root the host understands, asked for under the
    // host's own platform.
    //
    // The root must be BOTH unique and absent, and a fixed name under the shared
    // system temp dir is neither. `$TMPDIR` is world-writable and shared across
    // users and concurrent runs, so anything that once created
    // `<fixed-root>/…/quick-studio/*.meta.json` — a crashed run of this very file, a
    // parallel job — would flip this case to `false` and keep it there. `mkdtempSync`
    // buys the uniqueness (the OS guarantees the name was free), and removing it
    // immediately buys the absence, on a path no one else can now collide with.
    const root = mkdtempSync(join(tmpdir(), "qs-11-7-absent-"));
    rmSync(root, { recursive: true, force: true });
    const { env } = hostAppDirFixture(root);
    expect(isFirstRunBoot("persistent", env, process.platform)).toBe(true);
  });

  // The XDG DEFAULT arm (`HOME` → `~/.local/share`) against real disk. The
  // `hostAppDirFixture` cases above drive the linux arm through `XDG_DATA_HOME`,
  // which returns before `platformPath.join(homeRoot, ".local", "share")` ever runs
  // — leaving that join covered by the pure table in `app-dir.test.ts` and by
  // nothing that touches a filesystem. This case restores that.
  //
  // Host-GATED, not host-dependent: it is skipped where the linux arm is not the arm
  // the host takes, rather than asserting a linux layout on a machine that would
  // resolve a different one. Same DW-93 rule as its siblings — a host-built
  // `mkdtempSync` root is only ever asked for under `process.platform`.
  const xdgDefaultOnHost = process.platform !== "win32" && process.platform !== "darwin";
  test.skipIf(!xdgDefaultOnHost)(
    "real seams, HOME with XDG_DATA_HOME unset → resolves under ~/.local/share and classifies there",
    () => {
      const root = mkdtempSync(join(tmpdir(), "qs-11-7-xdg-default-"));
      try {
        const appDir = join(root, ".local", "share", APP_DIR_NAME);
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, STORE_META_FILE_NAME), "{}");
        // `false` is reachable only if the real `resolveAppDir` took the XDG-default
        // branch and landed exactly here, and the real `classifyStorePresence` found
        // the descriptor.
        expect(isFirstRunBoot("persistent", { HOME: root }, process.platform)).toBe(false);
        rmSync(join(appDir, STORE_META_FILE_NAME));
        expect(isFirstRunBoot("persistent", { HOME: root }, process.platform)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
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
