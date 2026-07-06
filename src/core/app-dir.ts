/**
 * quick-studio Core — OS-convention application-data directory resolver (AR-9).
 *
 * Every persistent artifact this product writes (the encrypted credential store
 * of Story 2.2, and later ERD layouts, panel/session state, and Reports) must
 * live under ONE OS-convention directory so the app has a single, predictable
 * home per platform (FR-4/5/6, AR-9). This module is that resolver.
 *
 * {@link resolveAppDir} is a PURE function of `(env, platform)` — no filesystem
 * access, no `process` reads — so it is exhaustively table-testable across every
 * platform and env permutation. {@link ensureAppDir} is the only impure surface:
 * it resolves the path from the live process environment and creates it.
 *
 * Platform conventions:
 *  - win32:  `%APPDATA%\quick-studio`
 *  - linux:  `$XDG_DATA_HOME/quick-studio`, else `~/.local/share/quick-studio`
 *  - darwin: `~/Library/Application Support/quick-studio`
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The app's directory name under every platform's data root. */
export const APP_DIR_NAME = "quick-studio";

/** The subset of environment variables the resolver consults. */
export type AppDirEnv = {
  readonly APPDATA?: string | undefined;
  readonly XDG_DATA_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  readonly [key: string]: string | undefined;
};

/**
 * Resolve the OS-convention app-data directory for `platform` given `env`.
 *
 * Pure and total: never throws, never touches the filesystem. `home` defaults to
 * `os.homedir()` but is injectable for deterministic testing. `platform` matches
 * the values of `process.platform` (`"win32"`, `"darwin"`, anything else is
 * treated as Linux/XDG).
 */
export function resolveAppDir(
  env: AppDirEnv,
  platform: NodeJS.Platform,
  home: string = homedir(),
): string {
  const homeRoot = env.HOME && env.HOME.length > 0 ? env.HOME : home;

  if (platform === "win32") {
    const appData =
      env.APPDATA && env.APPDATA.length > 0
        ? env.APPDATA
        : join(homeRoot, "AppData", "Roaming");
    return join(appData, APP_DIR_NAME);
  }

  if (platform === "darwin") {
    return join(homeRoot, "Library", "Application Support", APP_DIR_NAME);
  }

  // Linux / everything else: honour XDG_DATA_HOME, else the XDG default.
  const xdg =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : join(homeRoot, ".local", "share");
  return join(xdg, APP_DIR_NAME);
}

/**
 * Resolve the app-data directory from the live process environment and create it
 * (recursive `mkdir`, mode `0o700`, idempotent). Returns the absolute path.
 * Impure: reads `process.env`/`process.platform` and touches the filesystem.
 *
 * Throws if the resolved path is not absolute (e.g. `HOME` unset AND
 * `os.homedir()` empty, which would yield a CWD-relative path) — callers at the
 * total Ring-1 boundary ({@link openCredentialStore}) catch this and surface a
 * typed `unavailable` instead of silently writing to a relative location.
 */
export function ensureAppDir(): string {
  const dir = resolveAppDir(process.env, process.platform);
  if (!isAbsolute(dir)) {
    throw new Error(
      "could not resolve an absolute app-data directory (no HOME and no OS home available)",
    );
  }
  // 0o700 keeps the app dir owner-only (ignored on Windows, harmless there).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
