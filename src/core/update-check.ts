/**
 * quick-studio Core — TTL-cached update-availability check + `update` command (Story 11.5).
 *
 * Once quick-studio is installed rather than run from a checkout, a copy can sit
 * at an old version indefinitely with no signal. This module adds a check that is
 * cheap, quiet, honest about failure, and mode-aware:
 *
 *  1. On a Persistent boot, read `update-check.json` from the app-data directory
 *     ({@link resolveAppDir}). If the cached `latest` is a stable version newer
 *     than {@link VERSION}, print ONE terse stderr line. If the cache is older
 *     than the 24h TTL (or absent), fire a NON-BLOCKING registry request and
 *     write the result back for the *next* boot. Boot never waits on the network.
 *  2. Ephemeral mode does not participate at all — no read, no write, and
 *     `ensureAppDir()` is not even called (it would `mkdir`, itself a disk write).
 *     This is the hardest invariant in the story (Epic 2: Ephemeral never writes).
 *  3. `quick-studio update` delegates — it detects how the running copy was
 *     installed and prints the exact command or URL. No download, no self-replace.
 *
 * The pure helpers (`parseSemver`, `isNewer`, `isCacheStale`, `shouldNotify`,
 * `detectInstallChannel`, `updateInstructions`) are exhaustively table-testable.
 * The impure surface — {@link runUpdateCheck} and {@link printUpdateInstructions}
 * — takes every seam through an injectable `deps` bag defaulting to real impls,
 * so a test can assert the Ephemeral/disabled paths invoke ZERO seams.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAppDir, resolveAppDir } from "./app-dir.ts";
import type { RunMode } from "./run-mode.ts";
import { VERSION } from "./version.generated.ts";

/** npm registry endpoint for the latest published version — a plain version lookup, no telemetry. */
const REGISTRY_URL = "https://registry.npmjs.org/quick-studio/latest";
/** GitHub Releases page for standalone-binary downloads (matches `bin/quick-studio.cjs`). */
const RELEASES_URL = "https://github.com/joajo13/quick-studio/releases";
/** Cache filename, beside `credential-store.enc` / `workspace-state.json` under the app-data dir. */
const CACHE_FILE_NAME = "update-check.json";
/** Cache TTL: 24 hours in ms. A cache older than this triggers a background refresh. */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Registry fetch timeout in ms — a hung socket must not keep a background promise alive. */
const FETCH_TIMEOUT_MS = 1500;

/**
 * The same anchored semver shape `scripts/build-version.ts` validates
 * `package.json` against: `major.minor.patch` with optional `-prerelease` and/or
 * `+build`, and NOTHING after it. A fetched `latest` is validated against this
 * before being trusted, so registry garbage is discarded like any malformed input.
 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** How the running executable was delivered. `unknown` → print both instruction sets. */
export type InstallChannel = "npm" | "standalone" | "unknown";

/** The on-disk cache shape. `checkedAt` is epoch ms. Contains no secrets. */
export type CachedUpdate = {
  readonly latest: string;
  readonly checkedAt: number;
};

/** A parsed stable semver core. `prerelease` records whether a `-tail` was present. */
export type Semver = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
};

/**
 * Parse `s` into its numeric `major.minor.patch` plus whether it carries a
 * prerelease tail. Returns `null` for anything outside the anchored semver shape.
 * Build metadata (`+…`) is discarded; the prerelease flag is kept because a
 * prerelease `latest` must never trigger a notice. Pure and total.
 */
export function parseSemver(s: string): Semver | null {
  if (typeof s !== "string" || !SEMVER_RE.test(s)) return null;
  // Strip build metadata (`+…`), then split off any prerelease (`-…`).
  const core = s.split("+", 1)[0] ?? s;
  const dash = core.indexOf("-");
  const prerelease = dash !== -1;
  const mmp = prerelease ? core.slice(0, dash) : core;
  const [major, minor, patch] = mmp.split(".").map(Number);
  return { major: major ?? 0, minor: minor ?? 0, patch: patch ?? 0, prerelease };
}

/**
 * True when the stable version `latest` is strictly newer than `current` by
 * numeric `major.minor.patch` comparison. A prerelease `latest` never counts as
 * newer (we only ever notify about stable releases); unparseable input is never
 * newer. Pure and total.
 */
export function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (l === null || c === null) return false;
  if (l.prerelease) return false;
  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  return l.patch > c.patch;
}

/**
 * True when `checkedAt` is at least `ttlMs` older than `now`. A non-finite
 * `checkedAt` (corrupt cache) is treated as stale so it is refreshed. Pure.
 */
export function isCacheStale(checkedAt: number, now: number, ttlMs: number): boolean {
  if (!Number.isFinite(checkedAt)) return true;
  // A `checkedAt` in the future is implausible (clock skew, or a cache written
  // while the clock was wrong). Treat it as stale so the check keeps refreshing —
  // otherwise `now - checkedAt` stays negative forever and updates silently stop.
  if (checkedAt > now) return true;
  return now - checkedAt >= ttlMs;
}

/**
 * Whether a notice should be shown for `currentVersion` given the `cached`
 * result: only when a cache exists and its `latest` is a stable version strictly
 * newer than current. Staleness governs the background *refresh*, not the notice
 * — a stale cache still shows its (older) notice immediately — so `now` is
 * accepted for signature symmetry but the decision is version-only. Pure.
 */
export function shouldNotify(
  currentVersion: string,
  cached: CachedUpdate | null,
  now: number,
): boolean {
  void now;
  if (cached === null) return false;
  return isNewer(cached.latest, currentVersion);
}

/**
 * Infer the install channel from `execPath` (a path test on `process.execPath`).
 * When installed via npm/npx the standalone binary is spawned from
 * `node_modules/quick-studio-<platform>-<arch>/`, so its path carries a
 * `node_modules` segment → `"npm"`. A bare downloaded binary keeps a
 * quick-studio basename and sits outside any `node_modules` tree → `"standalone"`.
 * Anything else (e.g. launched through a bare `bun`/`node` runtime, or an empty
 * path) is not confidently either → `"unknown"`, and the caller prints both. This
 * is inference, not fact — hence the "print both on ambiguity" fallback. Pure.
 */
export function detectInstallChannel(execPath: string): InstallChannel {
  if (typeof execPath !== "string" || execPath.length === 0) return "unknown";
  const segments = execPath.split(/[/\\]/);
  if (segments.includes("node_modules")) return "npm";
  const base = segments[segments.length - 1] ?? "";
  // The compiled standalone binary keeps a recognizable basename: `quick-studio`,
  // `quick-studio.exe`, or the packaged `quick-studio-<platform>-<arch>[.exe]`.
  if (/^quick-studio(-[\w.-]+)?(\.exe)?$/i.test(base)) return "standalone";
  return "unknown";
}

/**
 * Render the update instructions for `channel`. `unknown` prints both sets so the
 * user picks the one that matches their install (Block-If #1: degrade to all
 * applicable instructions rather than guessing wrong). Pure.
 */
export function updateInstructions(channel: InstallChannel): string {
  const npm = "  npm i -g quick-studio@latest";
  const standalone =
    "  Download the latest binary for your platform from:\n" +
    `    ${RELEASES_URL}\n` +
    "  Then verify it against SHA256SUMS from the same release before running it.";
  if (channel === "npm") {
    return `Update quick-studio (installed via npm):\n${npm}\n`;
  }
  if (channel === "standalone") {
    return `Update quick-studio (standalone binary):\n${standalone}\n`;
  }
  return (
    "Update quick-studio — could not tell how this copy was installed, so both apply:\n\n" +
    `  If you installed it via npm (npm i -g / npx):\n${npm}\n\n` +
    `  If you downloaded a standalone binary:\n${standalone}\n`
  );
}

/** Injected seams for {@link runUpdateCheck}. All default to real impls below. */
export type RunUpdateCheckDeps = {
  /** Current epoch ms (default `Date.now`). */
  readonly now: () => number;
  /** Read the cache; corrupt/absent → `null`. Never throws. */
  readonly readCache: () => CachedUpdate | null;
  /** Atomically persist the cache. Never throws. */
  readonly writeCache: (data: CachedUpdate) => void;
  /** Registry fetch (default global `fetch`). */
  readonly fetchImpl: typeof fetch;
  /** Diagnostic sink for the one-line notice (default `process.stderr.write`). */
  readonly stderr: (line: string) => void;
};

/** Injected seams for {@link printUpdateInstructions}. */
export type PrintInstructionsDeps = {
  /** The running executable path to detect the install channel from (default `process.execPath`). */
  readonly execPath: string;
  /** Requested-output sink (default `process.stdout.write`) — instructions are asked-for, not diagnostics. */
  readonly stdout: (text: string) => void;
};

/** Resolve the cache file path (pure — no FS, no mkdir). */
function cacheFilePath(): string {
  return join(resolveAppDir(process.env, process.platform), CACHE_FILE_NAME);
}

/**
 * Read + parse the cache from disk, treating it as untrusted input: a missing,
 * unparseable, or shape-invalid file yields `null` (no cache). Never throws.
 */
function readCacheFromDisk(): CachedUpdate | null {
  try {
    const path = cacheFilePath();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { latest?: unknown }).latest === "string" &&
      typeof (parsed as { checkedAt?: unknown }).checkedAt === "number"
    ) {
      const { latest, checkedAt } = parsed as CachedUpdate;
      return { latest, checkedAt };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically persist the cache with owner-only perms: `ensureAppDir()` (the only
 * Persistent-only disk write), a sibling temp, then `rename` over the target —
 * the credential-store idiom, so an abrupt exit can at worst orphan a `*.tmp`
 * file, never truncate the live cache. Best-effort temp cleanup. Never throws.
 */
function writeCacheToDisk(data: CachedUpdate): void {
  let finalPath: string;
  try {
    finalPath = join(ensureAppDir(), CACHE_FILE_NAME);
  } catch {
    return; // could not resolve/create the app-data dir → silent no-op
  }
  const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, finalPath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
}

const DEFAULT_RUN_DEPS: RunUpdateCheckDeps = {
  now: () => Date.now(),
  readCache: readCacheFromDisk,
  writeCache: writeCacheToDisk,
  fetchImpl: fetch,
  stderr: (line) => {
    process.stderr.write(line);
  },
};

const DEFAULT_PRINT_DEPS: PrintInstructionsDeps = {
  execPath: process.execPath,
  stdout: (text) => {
    process.stdout.write(text);
  },
};

/**
 * Fetch the latest published version and, if valid, write it to the cache for the
 * *next* boot. A floating promise fired by {@link runUpdateCheck}: every failure —
 * offline, DNS failure, abort/timeout, registry 5xx, malformed JSON, non-semver
 * `version`, write failure — is caught and swallowed to a silent no-op. Never
 * rejects, so an unhandled rejection can never surface from the fire-and-forget.
 */
async function refreshCache(deps: RunUpdateCheckDeps): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let latest: unknown;
    try {
      // Explicit, fixed headers so the outbound request is deterministic and
      // advertises nothing about the runtime: the default `fetch` User-Agent would
      // leak the Bun/Node version, contradicting the "no machine info" guarantee.
      // A fixed `quick-studio` UA reveals nothing the URL (`/quick-studio/latest`)
      // does not already say.
      const res = await deps.fetchImpl(REGISTRY_URL, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": "quick-studio" },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { version?: unknown };
      latest = body.version;
    } finally {
      clearTimeout(timer);
    }
    // Validate before trusting: only a stable-or-prerelease semver string is cached.
    if (typeof latest !== "string" || !SEMVER_RE.test(latest)) return;
    deps.writeCache({ latest, checkedAt: deps.now() });
  } catch {
    /* every failure is a silent no-op — never surfaced, never rethrown */
  }
}

/**
 * The mode/env-guarded update check. Returns `void`, NEVER throws, and is NEVER
 * awaited by `bin/` — modeled on the fire-and-forget `openBrowser` call.
 *
 * Order matters: the Ephemeral and `QS_NO_UPDATE_CHECK` guards run BEFORE any
 * seam is touched, so both paths perform ZERO filesystem/network work (no read,
 * no write, no `ensureAppDir`). Then it reads the cache, shows at most one stderr
 * notice, and — when the cache is stale or absent — fires a floating background
 * refresh. Boot never waits on any of it.
 */
export function runUpdateCheck(
  mode: RunMode,
  env: { readonly QS_NO_UPDATE_CHECK?: string | undefined; readonly [key: string]: string | undefined },
  deps: RunUpdateCheckDeps = DEFAULT_RUN_DEPS,
): void {
  // Hardest invariant first: Ephemeral touches NOTHING on disk — not even a read.
  if (mode === "ephemeral") return;
  // Same non-empty-string convention as `QS_NO_OPEN`: any non-empty value disables.
  if (typeof env.QS_NO_UPDATE_CHECK === "string" && env.QS_NO_UPDATE_CHECK.length > 0) {
    return;
  }

  // Self-contained guard: like `openBrowser`, this call is fire-and-forget from the
  // boot path and must be structurally incapable of failing it. The default seams
  // don't throw (readCache swallows, refreshCache never rejects), but an injected
  // or a broken sink — e.g. `process.stderr.write` raising EPIPE on a closed pipe
  // mid-notice — must not propagate into the boot try/catch and fake a Core failure.
  try {
    const cached = deps.readCache();
    const now = deps.now();

    if (shouldNotify(VERSION, cached, now) && cached !== null) {
      deps.stderr(
        `quick-studio: update available — ${VERSION} → ${cached.latest}. ` +
          "Run 'quick-studio update' to see how to upgrade.\n",
      );
    }

    if (cached === null || isCacheStale(cached.checkedAt, now, TTL_MS)) {
      void refreshCache(deps);
    }
  } catch {
    /* fire-and-forget: never let the update check fail or delay the boot */
  }
}

/**
 * Print the update instructions for however this copy was installed, then return.
 * Read-only and advisory: no download, no write, no process replacement, no Core
 * boot (`bin/` exits 0 after this). `unknown` prints both sets (Block-If #1).
 */
export function printUpdateInstructions(deps: PrintInstructionsDeps = DEFAULT_PRINT_DEPS): void {
  const channel = detectInstallChannel(deps.execPath);
  deps.stdout(updateInstructions(channel));
}
