/**
 * quick-studio Core — the bare-command boot-level first-run signal (Story 11.7).
 *
 * `store-presence.ts` (Story 11.6) deliberately answers ONLY "what does the disk
 * say?" — it has no notion of run mode and no notion of "first run" as a boot
 * decision (its own Code Map: "keep it free of any prompt/boot concern"). This
 * module is the one place that turns that raw classification into the single
 * boolean `bin/` needs to decide whether to print the first-run hint and route
 * the UI to onboarding. It is a thin, total wrapper — the actual disk-presence
 * logic is NEVER re-implemented here, only delegated to.
 *
 * {@link isFirstRunBoot} is pure-ish (its only effects are the injected `deps`
 * calls) and NEVER throws — it degrades to `true` (treat as first-run) on any
 * failure, because a missed hint is a minor discoverability annoyance while a
 * swallowed crash on every boot is not an option (I/O matrix: "App-data dir
 * unreadable ... Total, never throws"). Note on HOW that holds for the REAL
 * seams: an unreadable app-data directory does not reach the `catch` at all —
 * `resolveAppDir` is documented total, and `existsSync` SWALLOWS `EACCES` and
 * returns `false`, so the classification lands on `first-run`/`first-run` and the
 * matrix row is satisfied by the normal path. The `try/catch` is therefore a
 * belt-and-suspenders guard over the INJECTED seams (and any future dep that is
 * not total), not the mechanism behind that row.
 */

import { isAbsolute } from "node:path";
import { resolveAppDir, type AppDirEnv } from "./app-dir.ts";
import type { RunMode } from "./run-mode.ts";
import { classifyStorePresence, type StorePresenceResult } from "./store-presence.ts";

/**
 * Injectable seams for {@link isFirstRunBoot}, mirroring `store-presence.ts`'s own
 * injectable-`fs` convention so the decision is unit-testable without touching
 * real disk. Both default to the real implementations.
 */
export type FirstRunSignalDeps = {
  readonly resolveDir: (env: AppDirEnv, platform: NodeJS.Platform) => string;
  readonly classify: (dir: string) => StorePresenceResult;
};

/** The real seams, used when no deps are injected. */
const DEFAULT_FIRST_RUN_SIGNAL_DEPS: FirstRunSignalDeps = {
  resolveDir: resolveAppDir,
  classify: classifyStorePresence,
};

/**
 * True when `mode` is Persistent AND neither persistent store has ever been
 * touched on this machine (both {@link classifyStorePresence} results are
 * `"first-run"`). Ephemeral mode short-circuits to `false` BEFORE either dep is
 * invoked — the probe must never consult the app-data directory for a session
 * that promises to never touch disk at all (Epic 2's Ephemeral invariant, which
 * this story does not get to relax). A store that exists but holds zero saved
 * connections is `"passphrase-mode"`/`"keychain-mode"` on disk, so it correctly
 * classifies as configured here — that emptiness is the UI's business, not the
 * CLI's (I/O matrix: "Store present, zero connections").
 *
 * Never throws: any error from either dep (an unreadable app-data directory, a
 * platform quirk) is caught and treated as first-run — the safer default is a
 * hint the user can ignore, not a boot-time crash over a stat failure.
 */
export function isFirstRunBoot(
  mode: RunMode,
  env: AppDirEnv,
  platform: NodeJS.Platform,
  deps: Partial<FirstRunSignalDeps> = {},
): boolean {
  if (mode !== "persistent") return false;

  const resolveDir = deps.resolveDir ?? DEFAULT_FIRST_RUN_SIGNAL_DEPS.resolveDir;
  const classify = deps.classify ?? DEFAULT_FIRST_RUN_SIGNAL_DEPS.classify;

  try {
    const dir = resolveDir(env, platform);
    // The SAME absoluteness precondition `ensureAppDir` enforces by throwing
    // (`app-dir.ts`): with `HOME` unset AND `os.homedir()` empty, `resolveAppDir`
    // returns a RELATIVE path, and `existsSync` would then resolve it against the
    // process CWD — so running from a directory that happens to contain a
    // `quick-studio/` folder would report "configured" on a virgin machine (and the
    // converse elsewhere). A non-absolute dir means we cannot locate the store at
    // all, which is exactly the "cannot tell" case this function answers `true` to.
    if (!isAbsolute(dir)) return true;
    const { credential, providerKeys } = classify(dir);
    return credential === "first-run" && providerKeys === "first-run";
  } catch {
    return true;
  }
}

/**
 * The one-block stderr hint printed after the listening-URL line on a first-run
 * Persistent boot. Naming BOTH paths forward — the UI form and the Ephemeral
 * one-liner — is the whole point: a returning user's boot must stay byte-for-byte
 * silent, and a first-run boot must never leave the user guessing what to do next.
 * Carries no path, no URL, and no credential (the "never leak a path" boundary) —
 * the listening URL is printed separately, immediately above this block, by `bin/`.
 *
 * On the wording: it says "no connections saved yet", NOT "nothing configured
 * yet". Two reasons. (1) Accuracy — on a keychain-less host the Story 11.6
 * pre-flight may have just walked the user through creating a passphrase in this
 * very boot, and telling them "nothing configured" seconds later contradicts what
 * they just did. (2) It matches where the hint (and the UI routing) actually sends
 * them: the connections form. The predicate can only be true when there is no
 * credential store AND no provider-key store, so "no connections" is always
 * literally true when this prints.
 *
 * The labels are quoted in the spelling each control ACTUALLY renders, which is not
 * uniform: the Tab is titled `"Settings"` with a capital S (`workspace-state.ts`'s
 * `openOrFocusSettings`, rendered verbatim by `TabBar.tsx` with no casing utility),
 * while the section button inside the panel is lowercase mono `"connections"`
 * (`SettingsPanel.tsx`). Quoting both lowercase reads tidier but sends the user
 * hunting for a Tab that does not exist under that name.
 */
export const FIRST_RUN_HINT =
  "quick-studio: no connections saved yet — this looks like a first run.\n" +
  '  - Add one in the UI at the URL above: the "Settings" Tab, "connections" section.\n' +
  "  - Or start a throwaway session directly: quick-studio <database-url>\n";
