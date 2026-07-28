/**
 * npm publish-artifact generator (Story 11.4).
 *
 * The repo's own `package.json` is the DEVELOPMENT manifest and is NOT the thing
 * we publish: its `files` allowlist ships the whole `src/` tree, its 33 runtime
 * `dependencies` are all already compiled into the binary, and its `prepare`
 * hook assumes a Bun toolchain the consumer may not have. Publishing it verbatim
 * would produce an enormous, slow, fragile package.
 *
 * Instead we GENERATE the published artifacts from the release binaries. This
 * script takes a directory of the three release binaries plus a version and
 * emits, into an output directory:
 *   - one package per platform (`quick-studio-<platform>-<arch>`), each holding
 *     only that platform's binary plus a generated manifest declaring `os`/`cpu`
 *     (so npm resolves exactly one onto any given machine), and
 *   - the main `quick-studio` package: the 11.3 launcher shim + the README, with
 *     NO runtime `dependencies`, NO build scripts, and `optionalDependencies`
 *     naming every platform package at the EXACT same version.
 *
 * Cross-story contract (DW-77, from Story 11.3's shim resolution): each platform
 * manifest carries NO restrictive `exports` field, and each binary sits at the
 * package root as `quick-studio` (POSIX) / `quick-studio.exe` (win32) with the
 * executable bit set on POSIX. The 11.3 shim's `require.resolve(<pkg>/package.json)`
 * + fixed `<pkgroot>/quick-studio[.exe]` join resolves against exactly this.
 *
 * Fails loudly (throws) on a missing/blank/invalid version or any missing release
 * asset, and validates ALL inputs BEFORE writing anything, so a failure never
 * leaves a partial package tree behind.
 *
 * Mirrors `scripts/build-version.ts`'s anchored-semver validation and loud-throw
 * style. Run: `bun scripts/build-npm-packages.ts --binaries <dir> --version <v> --out <dir>`.
 */

import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PKG_PREFIX, PLATFORMS } from "./platforms.ts";

/** Short description reused across every generated manifest. */
const DESCRIPTION = "Lightweight, local-first database manager (Postgres + MySQL).";

/**
 * SPDX id stamped into every generated manifest. Must stay in lockstep with the
 * root `package.json` `license` field and the `LICENSE` file copied alongside —
 * `build-npm-packages.test.ts` asserts all three agree, because a package that
 * declares no license (the state before 0.1.0) makes npm warn and makes auditing
 * tools read it as all-rights-reserved.
 */
const LICENSE_ID = "MIT";

/**
 * Repository URL stamped into every generated manifest — REQUIRED, not cosmetic.
 * `publish.yml` publishes via OIDC, and npm then attaches a sigstore provenance
 * statement naming the repo the build came from. The registry REJECTS the publish
 * (422) unless the manifest's own `repository.url` matches that statement, so a
 * manifest without this field cannot be published from CI at all:
 *
 *   422 Unprocessable Entity — Error verifying sigstore provenance bundle:
 *   package.json: "repository.url" is "", expected to match
 *   "https://github.com/joajo13/quick-studio" from provenance
 *
 * That is exactly how the first v0.1.0 publish died. Kept in lockstep with the
 * root package.json by `build-npm-packages.test.ts`.
 */
const REPOSITORY_URL = "git+https://github.com/joajo13/quick-studio.git";

// The shared platform table now lives in `scripts/platforms.ts` — THE
// authoritative mapping, consumed by Story 11.2's release matrix and Story
// 11.3's shim `SUPPORTED` keys. Note the deliberate token mismatch: the npm
// PACKAGE uses `win32` (from `process.platform`, so the shim's
// `require.resolve` matches) while the release ASSET uses `windows`, so
// `asset` is an explicit field, not a string transform. Adding macOS later
// needs no edit HERE — this file, the release matrix, and `publish.yml` all
// read the table — but it is not a pure data change either: `platforms.test.ts`
// carries deliberate tripwires (a no-darwin guard and an exact-asset list) that
// the macOS phase must clear on purpose. That is the point of them.

/** In-package binary filename for a row (DW-77): win32 → `.exe`, else bare. */
function binaryNameFor(os: string): string {
  return os === "win32" ? "quick-studio.exe" : "quick-studio";
}

/**
 * Anchored semver validation, same shape as `scripts/build-version.ts`: a
 * `major.minor.patch` with an optional `-prerelease` and/or `+build` tail and
 * NOTHING after it. An unanchored pattern would accept trailing garbage
 * (`1.2.3.4`, `1.2.3 oops`) and pin the platform packages to a bad version.
 */
function isValidVersion(version: unknown): version is string {
  return (
    typeof version === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  );
}

export interface BuildNpmPackagesOptions {
  /** Directory holding the three downloaded release binaries. */
  binariesDir: string;
  /** The release version (from the tag), pinned exactly into every manifest. */
  version: string;
  /** Output directory the package tree is written into. */
  outDir: string;
  /** Repo root, source of `bin/quick-studio.cjs` and `README.md` to copy. */
  repoRoot: string;
}

/**
 * Generate the platform packages + the main package into `outDir`. Pure and
 * unit-testable: no CWD assumptions, no process.exit — throws on any failure.
 */
export function buildNpmPackages(options: BuildNpmPackagesOptions): void {
  const { binariesDir, version, outDir, repoRoot } = options;

  // --- Validate EVERYTHING before writing anything (no partial tree on failure) ---

  if (!isValidVersion(version)) {
    throw new Error(
      `build-npm-packages: --version must be a non-empty semver string, got ${JSON.stringify(version)}`,
    );
  }

  for (const row of PLATFORMS) {
    const assetPath = path.join(binariesDir, row.asset);
    let assetStat;
    try {
      assetStat = statSync(assetPath);
    } catch {
      throw new Error(
        `build-npm-packages: missing release binary for ${row.key}: expected ${assetPath}`,
      );
    }
    // A file that exists is not enough: a failed `gh release download` can leave a
    // zero-byte placeholder or an HTML error page, and a directory at that path
    // would only blow up mid-copy (partial tree). Require a regular, non-empty file.
    if (!assetStat.isFile() || assetStat.size === 0) {
      throw new Error(
        `build-npm-packages: release binary for ${row.key} is not a regular non-empty file: ${assetPath}`,
      );
    }
  }

  const shimSrc = path.join(repoRoot, "bin", "quick-studio.cjs");
  const readmeSrc = path.join(repoRoot, "README.md");
  // Every published package carries the license TEXT, not just the SPDX id in
  // the manifest: npm shows the id, but a tarball with no LICENSE file reads as
  // unlicensed to auditing tools and to anyone who vendors the package.
  const licenseSrc = path.join(repoRoot, "LICENSE");
  // Validate the copied sources with the same strictness as the binaries above:
  // require a regular file, not merely an existing path. A directory at either
  // path would otherwise slip past `existsSync` and only blow up mid-copy at
  // `copyFileSync` — after platform dirs are written — breaking this function's
  // "validate everything before writing anything / no partial tree" guarantee.
  for (const src of [shimSrc, readmeSrc, licenseSrc]) {
    let srcStat;
    try {
      srcStat = statSync(src);
    } catch {
      throw new Error(`build-npm-packages: missing source file to copy: ${src}`);
    }
    if (!srcStat.isFile()) {
      throw new Error(`build-npm-packages: source to copy is not a regular file: ${src}`);
    }
  }

  // --- Emit one package per platform ---

  const optionalDependencies: Record<string, string> = {};

  for (const row of PLATFORMS) {
    const pkg = PKG_PREFIX + row.pkgKey;
    const binaryName = binaryNameFor(row.os);
    const pkgDir = path.join(outDir, pkg);
    // Clear a stale package dir from a prior run so leftover files can't be
    // published alongside the fresh binary/manifest. Scoped to the dir we own.
    rmSync(pkgDir, { recursive: true, force: true });
    mkdirSync(pkgDir, { recursive: true });

    const binaryDest = path.join(pkgDir, binaryName);
    copyFileSync(path.join(binariesDir, row.asset), binaryDest);
    // POSIX targets keep the executable bit — npm preserves modes in the tarball,
    // but the packaging script must set them (11.3's matrix flags a lost mode bit
    // as a packaging-side bug).
    if (row.os !== "win32") {
      chmodSync(binaryDest, 0o755);
    }

    copyFileSync(licenseSrc, path.join(pkgDir, "LICENSE"));

    // Generated platform manifest: NO exports, NO bin, NO dependencies, NO scripts.
    const platformManifest = {
      name: pkg,
      version,
      description: `${DESCRIPTION} Prebuilt binary for ${row.os}-${row.cpu}.`,
      license: LICENSE_ID,
      repository: { type: "git", url: REPOSITORY_URL },
      os: [row.os],
      cpu: [row.cpu],
      files: [binaryName, "LICENSE"],
    };
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(platformManifest, null, 2) + "\n",
    );

    // Exact pin (never a range) — a shim can never resolve a binary from a
    // different build than the shim it shipped with.
    optionalDependencies[pkg] = version;
  }

  // --- Emit the main package ---

  const mainDir = path.join(outDir, "quick-studio");
  rmSync(mainDir, { recursive: true, force: true });
  mkdirSync(mainDir, { recursive: true });

  // The shim is copied to the package ROOT (flattening `bin/`), so `bin` and
  // `files` both point at the bare `quick-studio.cjs` filename.
  const shimName = "quick-studio.cjs";
  copyFileSync(shimSrc, path.join(mainDir, shimName));
  copyFileSync(readmeSrc, path.join(mainDir, "README.md"));
  copyFileSync(licenseSrc, path.join(mainDir, "LICENSE"));

  // Generated main manifest: NO dependencies/devDependencies, NO scripts.
  const mainManifest = {
    name: "quick-studio",
    version,
    description: DESCRIPTION,
    license: LICENSE_ID,
    repository: { type: "git", url: REPOSITORY_URL },
    bin: { "quick-studio": shimName },
    files: [shimName, "README.md", "LICENSE"],
    engines: { node: ">=18" },
    optionalDependencies,
  };
  writeFileSync(
    path.join(mainDir, "package.json"),
    JSON.stringify(mainManifest, null, 2) + "\n",
  );
}

// --- CLI wrapper ---

/** Minimal `--flag value` parser (no external deps). */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`build-npm-packages: flag --${name} requires a value`);
      }
      out[name] = value;
      i++;
    }
  }
  return out;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const binariesDir = args.binaries;
  const version = args.version;
  const outDir = args.out;

  if (!binariesDir || !version || !outDir) {
    throw new Error(
      "build-npm-packages: usage: bun scripts/build-npm-packages.ts --binaries <dir> --version <v> --out <dir>",
    );
  }

  buildNpmPackages({
    binariesDir,
    version,
    outDir,
    repoRoot: process.cwd(),
  });

  process.stderr.write(
    `build-npm-packages: wrote ${PLATFORMS.length} platform packages + quick-studio into ${outDir} (version ${version})\n`,
  );
}
