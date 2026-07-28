/**
 * The single platform table (Story 11.2) — THE authoritative mapping, consumed
 * by the release matrix (`.github/workflows/release.yml`), the npm packaging
 * script (`scripts/build-npm-packages.ts`, Story 11.4), and `publish.yml`'s
 * asset check. The shim (`bin/quick-studio.cjs`) cannot import this — it is
 * dependency-free CommonJS shipped standalone — so `bin/quick-studio-shim.test.ts`
 * asserts its `SUPPORTED` map stays in sync as text instead.
 *
 * Dependency-free ON PURPOSE: the `platforms` job in `release.yml` runs this
 * right after `checkout` + `setup-bun`, with NO `bun install`, so it must not
 * import anything that would require node_modules to exist.
 *
 * Adding macOS later is NOT a one-line edit, and deliberately so. What IS
 * automatic: the release matrix, the packaging script, and `publish.yml` all
 * derive from this table and need no edit. What is NOT automatic: the darwin
 * guard and the exact-asset assertion in `scripts/platforms.test.ts` are
 * TRIPWIRES — the macOS phase must edit them ON PURPOSE, which is the point.
 * Never add a darwin row until its keyring CI leg is green (see
 * `docs/keyring-spike-decision.md`); the test enforces that boundary as data,
 * not just as prose.
 *
 * Doubles as a CLI, because neither a GitHub Actions matrix nor a bash loop can
 * `import` TypeScript:
 *   --github-matrix   one line of compact JSON (the rows), for `fromJSON(...)`
 *   --assets          one asset filename per line, in table order
 *   --packages        one npm package name per line, in table order
 *   --asset <key>     the ONE asset filename for that row (exit 1 if unknown)
 *
 * `--asset <key>` exists for the DW-80 guard in `publish.yml`, which must name a
 * single binary (the only one its ubuntu runner can execute) instead of the
 * whole list. It is a lookup, not a fourth copy of the names: rename a row's
 * asset here and the guard follows.
 */

/** The ONE package-name prefix constant. Naming can be revisited here alone. */
export const PKG_PREFIX = "quick-studio-";

// Every field is `readonly`: `readonly PlatformRow[]` alone only blocks
// reassigning the array, leaving `PLATFORMS[0].asset = …` a typechecking edit.
export interface PlatformRow {
  /** `<platform>-<arch>` key, identical to the shim's SUPPORTED keys. */
  readonly key: string;
  /**
   * Suffix of the PUBLISHED npm package name (`PKG_PREFIX + pkgKey`). Usually
   * identical to `key`, and deliberately NOT derived from it: npm's automated
   * filter flagged `quick-studio-win32-x64` as a security-holding package one
   * second after it was created (2026-07-22T20:33Z), which permanently blocks
   * that name, so Windows publishes as `windows-x64` instead. `key` must keep
   * matching `process.platform`-`process.arch` for the shim's lookup — only the
   * published name moves. Same reason the asset already says `windows`, not
   * `win32`.
   */
  readonly pkgKey: string;
  /** npm `os` field value (`process.platform`). */
  readonly os: string;
  /** npm `cpu` field value (`process.arch`). */
  readonly cpu: string;
  /** Release-asset filename produced by `release.yml`. */
  readonly asset: string;
  /** GitHub Actions `runs-on` label; the binary MUST be compiled on a host matching `os`/`cpu`. */
  readonly runner: string;
}

export const PLATFORMS: readonly PlatformRow[] = [
  {
    key: "win32-x64",
    pkgKey: "windows-x64",
    os: "win32",
    cpu: "x64",
    asset: "quick-studio-windows-x64.exe",
    runner: "windows-latest",
  },
  {
    key: "linux-x64",
    pkgKey: "linux-x64",
    os: "linux",
    cpu: "x64",
    asset: "quick-studio-linux-x64",
    runner: "ubuntu-latest",
  },
  {
    key: "linux-arm64",
    pkgKey: "linux-arm64",
    os: "linux",
    cpu: "arm64",
    asset: "quick-studio-linux-arm64",
    runner: "ubuntu-24.04-arm",
  },
];

// --- CLI wrapper ---

const USAGE =
  "usage: bun scripts/platforms.ts --github-matrix | --assets | --packages | --asset <key>\n";

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === "--github-matrix") {
    console.log(JSON.stringify(PLATFORMS));
  } else if (args.length === 1 && args[0] === "--assets") {
    for (const row of PLATFORMS) {
      console.log(row.asset);
    }
  } else if (args.length === 1 && args[0] === "--packages") {
    for (const row of PLATFORMS) {
      console.log(PKG_PREFIX + row.pkgKey);
    }
  } else if (args.length === 2 && args[0] === "--asset") {
    // The only two-argument mode, and it is a SEPARATE arm rather than a
    // relaxation of the `args.length === 1` chain above — those stay exact, so
    // `--assets extra` and `--assets --github-matrix` remain errors instead of
    // silently honoring the first flag.
    const row = PLATFORMS.find((r) => r.key === args[1]);
    if (!row) {
      // Nothing on stdout for an unknown key. The caller (publish.yml's DW-80
      // guard) substitutes this straight into a path, and an empty string there
      // would degrade to `bin-dl/` — a directory, chmod'd and "run" — so an
      // unknown key must be a loud exit 1, never an empty success.
      process.stderr.write(USAGE);
      process.exit(1);
    }
    console.log(row.asset);
  } else if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    // Asking for help is not an error: usage goes to stdout, exit 0.
    process.stdout.write(USAGE);
  } else {
    process.stderr.write(USAGE);
    process.exit(1);
  }
}
