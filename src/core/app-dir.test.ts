/**
 * Table-driven proof of the OS-convention app-dir resolver (AR-9): each platform,
 * `XDG_DATA_HOME` set vs unset fallback, and `%APPDATA%` on Windows. `resolveAppDir`
 * is pure, so these assertions need no filesystem and no `process` mutation.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { APP_DIR_NAME, resolveAppDir, type AppDirEnv } from "./app-dir.ts";

const HOME = "/home/dev";

describe("resolveAppDir — OS conventions (AR-9)", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly env: AppDirEnv;
    readonly platform: NodeJS.Platform;
    readonly expected: string;
  }> = [
    {
      name: "linux honours XDG_DATA_HOME when set",
      env: { XDG_DATA_HOME: "/custom/xdg" },
      platform: "linux",
      expected: join("/custom/xdg", APP_DIR_NAME),
    },
    {
      name: "linux falls back to ~/.local/share when XDG unset",
      env: {},
      platform: "linux",
      expected: join(HOME, ".local", "share", APP_DIR_NAME),
    },
    {
      name: "linux treats empty XDG_DATA_HOME as unset",
      env: { XDG_DATA_HOME: "" },
      platform: "linux",
      expected: join(HOME, ".local", "share", APP_DIR_NAME),
    },
    {
      name: "win32 uses %APPDATA%",
      env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      platform: "win32",
      expected: join("C:\\Users\\dev\\AppData\\Roaming", APP_DIR_NAME),
    },
    {
      name: "win32 falls back to ~/AppData/Roaming when APPDATA unset",
      env: {},
      platform: "win32",
      expected: join(HOME, "AppData", "Roaming", APP_DIR_NAME),
    },
    {
      name: "darwin uses ~/Library/Application Support",
      env: {},
      platform: "darwin",
      expected: join(HOME, "Library", "Application Support", APP_DIR_NAME),
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(resolveAppDir(c.env, c.platform, HOME)).toBe(c.expected);
    });
  }

  test("HOME from env overrides the injected home default", () => {
    expect(resolveAppDir({ HOME: "/env/home" }, "linux", HOME)).toBe(
      join("/env/home", ".local", "share", APP_DIR_NAME),
    );
  });
});
