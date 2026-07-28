/**
 * Table-driven proof of the OS-convention app-dir resolver (AR-9): each platform,
 * `XDG_DATA_HOME` set vs unset fallback, and `%APPDATA%` on Windows. `resolveAppDir`
 * is pure, so these assertions need no filesystem and no `process` mutation.
 *
 * Every `expected` is built with an EXPLICIT `win32.join` / `posix.join` matching
 * that row's `platform` — never the host-flavoured bare `join` (DW-93). With bare
 * `join` the `"win32"` rows asserted `...\AppData\Roaming/quick-studio` on a POSIX
 * host and `...\AppData\Roaming\quick-studio` on a Windows one: two different
 * claims wearing one name, which is exactly how the mixed-separator bug stayed
 * green. Nothing external catches that for us — NO workflow in `.github/workflows/`
 * runs this suite (`keyring-spike.yml` runs `src/core/keychain.test.ts` and nothing
 * else; `publish.yml`/`release.yml` run no tests), so this file's greenness only
 * ever reflects whichever machine a developer happened to run it on, POSIX in
 * practice. There is no second host to notice a host-dependent assertion, which is
 * exactly why there must not be one.
 * These rows assert PATH STRINGS and touch no disk, so hardcoding the platform is
 * the right call here — the opposite rule applies to the real-filesystem cases in
 * `first-run-signal.test.ts`, which must ask for the HOST's platform.
 */

import { describe, expect, test } from "bun:test";
import { join, posix, win32 } from "node:path";
import { APP_DIR_NAME, pathForPlatform, resolveAppDir, type AppDirEnv } from "./app-dir.ts";

const HOME = "/home/dev";
/**
 * A REALISTIC Windows home for the win32 rows. Reusing the POSIX `HOME` would make
 * `win32.join("/home/dev", …)` normalise to the drive-less `\home\dev\…`, which
 * `win32.isAbsolute` accepts but which resolves against whatever the current drive
 * happens to be — not a value worth enshrining as "expected".
 */
const WIN_HOME = "C:\\Users\\dev";
const WIN_APPDATA = "C:\\Users\\dev\\AppData\\Roaming";

describe("resolveAppDir — OS conventions (AR-9)", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly env: AppDirEnv;
    readonly platform: NodeJS.Platform;
    readonly home?: string;
    readonly expected: string;
  }> = [
    {
      name: "linux honours XDG_DATA_HOME when set",
      env: { XDG_DATA_HOME: "/custom/xdg" },
      platform: "linux",
      expected: posix.join("/custom/xdg", APP_DIR_NAME),
    },
    {
      name: "linux falls back to ~/.local/share when XDG unset",
      env: {},
      platform: "linux",
      expected: posix.join(HOME, ".local", "share", APP_DIR_NAME),
    },
    {
      name: "linux treats empty XDG_DATA_HOME as unset",
      env: { XDG_DATA_HOME: "" },
      platform: "linux",
      expected: posix.join(HOME, ".local", "share", APP_DIR_NAME),
    },
    {
      name: "win32 uses %APPDATA%",
      env: { APPDATA: WIN_APPDATA },
      platform: "win32",
      expected: win32.join(WIN_APPDATA, APP_DIR_NAME),
    },
    {
      name: "win32 falls back to ~/AppData/Roaming when APPDATA unset",
      env: {},
      platform: "win32",
      home: WIN_HOME,
      expected: win32.join(WIN_HOME, "AppData", "Roaming", APP_DIR_NAME),
    },
    {
      name: "darwin uses ~/Library/Application Support",
      env: {},
      platform: "darwin",
      expected: posix.join(HOME, "Library", "Application Support", APP_DIR_NAME),
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(resolveAppDir(c.env, c.platform, c.home ?? HOME)).toBe(c.expected);
    });
  }

  test("HOME from env overrides the injected home default", () => {
    expect(resolveAppDir({ HOME: "/env/home" }, "linux", HOME)).toBe(
      posix.join("/env/home", ".local", "share", APP_DIR_NAME),
    );
  });
});

describe("resolveAppDir — the platform argument selects the SEPARATOR too (DW-93)", () => {
  // These are the assertions a host-flavoured `join` cannot satisfy: they pin the
  // separator itself, so they fail on a POSIX runner the moment the resolver goes
  // back to inheriting the host's flavour. Every row carries the separator
  // invariant — an unexplained exception would read as an oversight.
  test("win32 + %APPDATA% resolves with NO forward slash and is win32.isAbsolute", () => {
    const dir = resolveAppDir({ APPDATA: WIN_APPDATA }, "win32", WIN_HOME);
    expect(dir).toBe("C:\\Users\\dev\\AppData\\Roaming\\quick-studio");
    expect(dir).not.toContain("/");
    expect(win32.isAbsolute(dir)).toBe(true);
  });

  test("win32 without %APPDATA% joins the home fallback win32-style, NO forward slash", () => {
    const dir = resolveAppDir({}, "win32", WIN_HOME);
    expect(dir).toBe(win32.join(WIN_HOME, "AppData", "Roaming", APP_DIR_NAME));
    expect(dir).not.toContain("/");
    expect(win32.isAbsolute(dir)).toBe(true);
  });

  test("linux + XDG resolves with NO backslash and is posix.isAbsolute (even on a Windows host)", () => {
    const dir = resolveAppDir({ XDG_DATA_HOME: "/custom/xdg" }, "linux", HOME);
    expect(dir).toBe("/custom/xdg/quick-studio");
    expect(dir).not.toContain("\\");
    expect(posix.isAbsolute(dir)).toBe(true);
  });

  test("darwin resolves with NO backslash and is posix.isAbsolute (even on a Windows host)", () => {
    const dir = resolveAppDir({}, "darwin", HOME);
    expect(dir).toBe("/home/dev/Library/Application Support/quick-studio");
    expect(dir).not.toContain("\\");
    expect(posix.isAbsolute(dir)).toBe(true);
  });

  test("production behaviour is unchanged: on the host's OWN platform the result still equals the host-`join` construction", () => {
    // The ONE place bare, host-flavoured `join` belongs — it reconstructs what the
    // PRE-DW-93 implementation produced. Every production caller passes
    // `process.platform`, so host flavour == selected flavour by construction, and
    // this equality must hold byte-for-byte on whichever runner executes it. Yes,
    // it is a tautology on separator grounds; pinning production behaviour is the
    // job, not proving the separator.
    const env: AppDirEnv = { APPDATA: WIN_APPDATA, XDG_DATA_HOME: "/custom/xdg" };
    const expectedOnHost =
      process.platform === "win32"
        ? join(WIN_APPDATA, APP_DIR_NAME)
        : process.platform === "darwin"
          ? join(HOME, "Library", "Application Support", APP_DIR_NAME)
          : join("/custom/xdg", APP_DIR_NAME);
    expect(resolveAppDir(env, process.platform, HOME)).toBe(expectedOnHost);
  });
});

describe("pathForPlatform — the single source of the platform→flavour rule (DW-93)", () => {
  test("returns the win32 flavour for win32 only", () => {
    expect(pathForPlatform("win32")).toBe(win32);
  });

  test("returns the posix flavour for every other NodeJS.Platform", () => {
    // The COMPLETE non-win32 remainder of the union as `@types/node` declares it
    // (the union has ELEVEN members; the remainder enumerated here is the other
    // TEN). Exhaustiveness is the point — `cygwin`, `haiku` and `netbsd` are the
    // easy ones to drop — and it is COMPILE-ENFORCED rather than asserted: keying a
    // `Record<Exclude<NodeJS.Platform, "win32">, true>` makes a missing member, a
    // duplicated one, or a `@types/node` bump that adds a platform a `tsc` error
    // here. A `readonly NodeJS.Platform[]` plus `toHaveLength(10)` could not do
    // that job: it accepts `"darwin"` twice with `"netbsd"` dropped at the very
    // same length, and the literal `10` is written in the same commit as the list.
    // (This is a TEST-local construction. An earlier review pass rejected shaping
    // `pathForPlatform` ITSELF this way; that rejection stands — the helper keeps
    // its `platform === "win32"` body.)
    const others: Record<Exclude<NodeJS.Platform, "win32">, true> = {
      aix: true,
      android: true,
      cygwin: true,
      darwin: true,
      freebsd: true,
      haiku: true,
      linux: true,
      netbsd: true,
      openbsd: true,
      sunos: true,
    };
    const platforms = Object.keys(others) as ReadonlyArray<Exclude<NodeJS.Platform, "win32">>;
    expect(platforms).toHaveLength(10);
    for (const platform of platforms) {
      expect(pathForPlatform(platform)).toBe(posix);
    }
  });
});
