/**
 * quick-studio Core — OS-convention application-data directory resolver (AR-9).
 *
 * Every persistent artifact this product writes (the encrypted credential store
 * of Story 2.2, and later ERD layouts, panel/session state, and Reports) must
 * live under ONE OS-convention directory so the app has a single, predictable
 * home per platform (FR-4/5/6, AR-9). This module is that resolver.
 *
 * {@link resolveAppDir}'s BODY is a pure function of `(env, platform, home)` — no
 * filesystem access, no `process` reads — so it is exhaustively table-testable
 * across every platform and env permutation. The one impure edge is the DEFAULT
 * for `home`: `os.homedir()` reads the OS user database at call time. Passing
 * `home` explicitly (as every table row does) removes it. {@link ensureAppDir} is
 * the fully impure surface: it resolves the path from the live process
 * environment and creates it.
 *
 * Platform conventions:
 *  - win32:  `%APPDATA%\quick-studio`
 *  - linux:  `$XDG_DATA_HOME/quick-studio`, else `~/.local/share/quick-studio`
 *  - darwin: `~/Library/Application Support/quick-studio`
 *
 * On the SEPARATOR (DW-93): the `platform` argument selects BOTH the convention
 * above AND the `node:path` flavour used to join it — never the HOST's. Before
 * DW-93 this module imported the host-flavoured `join`/`isAbsolute`, so asking a
 * POSIX host for the `"win32"` directory produced the mixed-separator
 * `C:\Users\x\AppData\Roaming/quick-studio`, which the host's `isAbsolute` then
 * called RELATIVE — enough to short-circuit `isFirstRunBoot`
 * (`first-run-signal.ts`) to a spurious `true`. That was a LATENT contract
 * violation, not a live user-facing bug: every production caller passes
 * `process.platform`, so host flavour == selected flavour by construction and no
 * real host could ever reach the mixed-separator string. The fix closes the gap
 * between what the signature promises and what the body delivers.
 * {@link pathForPlatform} is now the single source of that platform→flavour rule,
 * and this file's only path import is `{ posix, win32 }` — which narrows what a
 * later edit reaches for BY DEFAULT. It does not forbid anything: `typeof win32`
 * is the whole `PlatformPath` type, so `.win32`, `.posix` and `.resolve()` are
 * still one property access away, and this repo has no lint to enforce otherwise.
 *
 * What that guarantee does NOT cover — it is about the JOIN, and about the path
 * STRING only, never about the local disk — is stated once, on
 * {@link resolveAppDir}. Read it before making a cross-platform call.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** The app's directory name under every platform's data root. */
export const APP_DIR_NAME = "quick-studio";

/**
 * The `node:path` flavour whose separator convention matches `platform`: `win32`
 * for `"win32"`, `posix` for every other `NodeJS.Platform` (darwin, linux, and
 * anything else) — mirroring {@link resolveAppDir}'s convention branching exactly.
 *
 * Exported rather than inlined at each use site because the resolver and its
 * consumer must agree BY CONSTRUCTION: {@link resolveAppDir} builds the path with
 * this flavour and `isFirstRunBoot` (`first-run-signal.ts`) tests the result for
 * absoluteness with it. If either side re-derived `platform === "win32"` on its
 * own, a future change to which platforms count as win32-like would silently
 * desynchronise the two — which is precisely the class of bug DW-93 was.
 */
export function pathForPlatform(platform: NodeJS.Platform): typeof win32 {
  return platform === "win32" ? win32 : posix;
}

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
 * Total: never throws, never touches the filesystem. The body is pure; `home`'s
 * DEFAULT, `os.homedir()`, is the one impure edge (and, per the first caveat
 * below, the easiest way to break this function's precondition) — pass `home`
 * explicitly for deterministic or cross-platform calls. `platform` matches the
 * values of `process.platform` (`"win32"`, `"darwin"`, anything else is treated
 * as Linux/XDG).
 *
 * `platform` selects BOTH the convention AND the separator flavour (DW-93): the
 * segments are joined with {@link pathForPlatform}`(platform).join`, never the
 * host's `join`. GIVEN inputs already written in the target platform's own
 * convention, the result is therefore a valid TARGET-PLATFORM path from any host
 * — on a POSIX host, `resolveAppDir({ APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
 * "win32")` yields the all-backslash `C:\Users\dev\AppData\Roaming\quick-studio`.
 * Nothing changes on a real host: every production caller passes
 * `process.platform`, so the pre-DW-93 host flavour and the selected flavour are
 * the same object, and the mixed-separator result was only ever reachable from a
 * test or a deliberate cross-platform call.
 *
 * The guarantee is about the JOIN, and about the PATH STRING only:
 *  - It presupposes its inputs. A `home`/`env` value written in another platform's
 *    convention comes back out as written —
 *    `resolveAppDir({}, "linux", "C:\\Users\\dev")` still produces the mixed
 *    `C:\Users\dev/.local/share/quick-studio`, and nothing here can un-Windows it
 *    (`C:/Users/dev/...` is not `posix.isAbsolute` either). Passing `home`/`env` in
 *    the TARGET platform's convention is the caller's obligation. The
 *    `home = homedir()` DEFAULT is the primary way to violate it, silently: it
 *    supplies the HOST's convention, so on a Windows host `resolveAppDir({},
 *    "linux")` returns `C:\Users\x/.local/share/quick-studio`. A cross-platform
 *    call must pass `home` (and the arm's `env` key) itself.
 *  - A correct foreign path is still not a probeable one:
 *    `existsSync`/`classifyStorePresence` against a `"win32"` path resolved on
 *    Linux answer a question about the LOCAL filesystem, which is not the question
 *    that path asks.
 */
export function resolveAppDir(
  env: AppDirEnv,
  platform: NodeJS.Platform,
  home: string = homedir(),
): string {
  // The separator flavour comes from the ARGUMENT, not the host (DW-93). Named
  // `platformPath` and not `path` on purpose: a bare `path.join(...)` inside this
  // function reads exactly like the host-flavoured `node:path` a skimmer assumes,
  // and that assumption IS the confusion DW-93 records.
  const platformPath = pathForPlatform(platform);
  const homeRoot = env.HOME && env.HOME.length > 0 ? env.HOME : home;

  if (platform === "win32") {
    const appData =
      env.APPDATA && env.APPDATA.length > 0
        ? env.APPDATA
        : platformPath.join(homeRoot, "AppData", "Roaming");
    return platformPath.join(appData, APP_DIR_NAME);
  }

  if (platform === "darwin") {
    return platformPath.join(homeRoot, "Library", "Application Support", APP_DIR_NAME);
  }

  // Linux / everything else: honour XDG_DATA_HOME, else the XDG default.
  const xdg =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : platformPath.join(homeRoot, ".local", "share");
  return platformPath.join(xdg, APP_DIR_NAME);
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
  // The same flavour the resolver just used. Both sides get `process.platform`
  // here, so this IS the host's rule and nothing about this check changed — it
  // goes through {@link pathForPlatform} so the file keeps zero host-flavoured
  // path bindings in default reach for the next edit (DW-93).
  if (!pathForPlatform(process.platform).isAbsolute(dir)) {
    throw new Error(
      "could not resolve an absolute app-data directory (no HOME and no OS home available)",
    );
  }
  // 0o700 keeps the app dir owner-only (ignored on Windows, harmless there).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
