import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNpmPackages } from "./build-npm-packages.ts";

/**
 * Hermetic tests for the npm packaging generator (scripts/build-npm-packages.ts).
 *
 * Materializes a temp `binariesDir` with three fake release binaries and a temp
 * `repoRoot` carrying `bin/quick-studio.cjs` + `README.md`, runs the pure
 * `buildNpmPackages`, and asserts every clause of AC #1 / AC #2 (structure,
 * os/cpu, exec bit, optionalDependencies exact pins, absent dev fields, no
 * exports, loud failures). Temp dirs are cleaned up in afterEach.
 */

const VERSION = "0.0.1";

// key → { asset, binaryName, os, cpu }
const EXPECTED = [
  { pkg: "quick-studio-win32-x64", asset: "quick-studio-windows-x64.exe", binaryName: "quick-studio.exe", os: "win32", cpu: "x64" },
  { pkg: "quick-studio-linux-x64", asset: "quick-studio-linux-x64", binaryName: "quick-studio", os: "linux", cpu: "x64" },
  { pkg: "quick-studio-linux-arm64", asset: "quick-studio-linux-arm64", binaryName: "quick-studio", os: "linux", cpu: "arm64" },
] as const;

let tmpRoot: string;
let binariesDir: string;
let repoRoot: string;
let outDir: string;

function makeBinaries(dir: string, assets: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const asset of assets) {
    writeFileSync(path.join(dir, asset), `fake-binary-bytes-${asset}`);
  }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "qs-npm-pkg-"));
  binariesDir = path.join(tmpRoot, "binaries");
  repoRoot = path.join(tmpRoot, "repo");
  outDir = path.join(tmpRoot, "out");

  makeBinaries(binariesDir, EXPECTED.map((e) => e.asset));

  mkdirSync(path.join(repoRoot, "bin"), { recursive: true });
  writeFileSync(path.join(repoRoot, "bin", "quick-studio.cjs"), "#!/usr/bin/env node\n// fake shim\n");
  writeFileSync(path.join(repoRoot, "README.md"), "# quick-studio\nfake readme\n");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function readManifest(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(outDir, ...segments, "package.json"), "utf8"));
}

describe("buildNpmPackages — happy path", () => {
  beforeEach(() => {
    buildNpmPackages({ binariesDir, version: VERSION, outDir, repoRoot });
  });

  test("emits three platform dirs + the main package dir", () => {
    for (const { pkg } of EXPECTED) {
      expect(existsSync(path.join(outDir, pkg))).toBe(true);
    }
    expect(existsSync(path.join(outDir, "quick-studio"))).toBe(true);
  });

  test("each platform manifest has correct name/version/os/cpu/files and NO exports/bin/dependencies", () => {
    for (const { pkg, binaryName, os: pos, cpu } of EXPECTED) {
      const m = readManifest(pkg);
      expect(m.name).toBe(pkg);
      expect(m.version).toBe(VERSION);
      expect(m.os).toEqual([pos]);
      expect(m.cpu).toEqual([cpu]);
      expect(m.files).toEqual([binaryName]);
      expect(m).not.toHaveProperty("exports");
      expect(m).not.toHaveProperty("bin");
      expect(m).not.toHaveProperty("dependencies");
      expect(m).not.toHaveProperty("scripts");
    }
  });

  test("each platform binary sits at the package root under the right name", () => {
    for (const { pkg, binaryName } of EXPECTED) {
      expect(existsSync(path.join(outDir, pkg, binaryName))).toBe(true);
    }
  });

  test("POSIX platform binaries have the owner-execute bit set", () => {
    for (const { pkg, binaryName, os: pos } of EXPECTED) {
      if (pos === "win32") continue;
      const mode = statSync(path.join(outDir, pkg, binaryName)).mode;
      expect(mode & 0o100).toBe(0o100);
    }
  });

  test("main manifest: bin, files, engines.node, optionalDependencies exact pins", () => {
    const m = readManifest("quick-studio") as Record<string, any>;
    expect(m.name).toBe("quick-studio");
    expect(m.version).toBe(VERSION);
    expect(m.bin["quick-studio"]).toBe("quick-studio.cjs");
    expect([...m.files].sort()).toEqual(["README.md", "quick-studio.cjs"]);
    expect(m.engines?.node).toBeTruthy();

    const optDeps = m.optionalDependencies as Record<string, string>;
    for (const { pkg } of EXPECTED) {
      // Exact pin, NOT a range specifier.
      expect(optDeps[pkg]).toBe(VERSION);
      expect(optDeps[pkg].startsWith("^")).toBe(false);
      expect(optDeps[pkg].startsWith("~")).toBe(false);
    }
  });

  test("main manifest has NO dependencies/devDependencies and no prepare/prepublishOnly scripts", () => {
    const m = readManifest("quick-studio") as Record<string, any>;
    expect(m).not.toHaveProperty("dependencies");
    expect(m).not.toHaveProperty("devDependencies");
    if (m.scripts) {
      expect(m.scripts).not.toHaveProperty("prepare");
      expect(m.scripts).not.toHaveProperty("prepublishOnly");
    }
  });

  test("main package contains the shim and README at its root", () => {
    expect(existsSync(path.join(outDir, "quick-studio", "quick-studio.cjs"))).toBe(true);
    expect(existsSync(path.join(outDir, "quick-studio", "README.md"))).toBe(true);
  });
});

describe("buildNpmPackages — loud failures leave no partial tree", () => {
  test("blank version throws and writes nothing", () => {
    expect(() =>
      buildNpmPackages({ binariesDir, version: "", outDir, repoRoot }),
    ).toThrow();
    expect(existsSync(outDir)).toBe(false);
  });

  test("invalid (non-semver) version throws", () => {
    expect(() =>
      buildNpmPackages({ binariesDir, version: "1.2.3 oops", outDir, repoRoot }),
    ).toThrow();
    expect(existsSync(outDir)).toBe(false);
  });

  test("a missing release binary throws and writes nothing", () => {
    // Rebuild binariesDir missing the arm64 asset.
    rmSync(binariesDir, { recursive: true, force: true });
    makeBinaries(
      binariesDir,
      EXPECTED.filter((e) => e.pkg !== "quick-studio-linux-arm64").map((e) => e.asset),
    );
    expect(() =>
      buildNpmPackages({ binariesDir, version: VERSION, outDir, repoRoot }),
    ).toThrow(/linux-arm64/);
    expect(existsSync(outDir)).toBe(false);
  });

  test("a zero-byte release binary (e.g. a failed download) throws and writes nothing", () => {
    // Truncate the arm64 asset to zero bytes — exists but is not a usable binary.
    writeFileSync(path.join(binariesDir, "quick-studio-linux-arm64"), "");
    expect(() =>
      buildNpmPackages({ binariesDir, version: VERSION, outDir, repoRoot }),
    ).toThrow(/linux-arm64/);
    expect(existsSync(outDir)).toBe(false);
  });

  test("a directory where a binary asset is expected throws (not just exists)", () => {
    rmSync(path.join(binariesDir, "quick-studio-linux-x64"), { force: true });
    mkdirSync(path.join(binariesDir, "quick-studio-linux-x64"), { recursive: true });
    expect(() =>
      buildNpmPackages({ binariesDir, version: VERSION, outDir, repoRoot }),
    ).toThrow(/linux-x64/);
    expect(existsSync(outDir)).toBe(false);
  });

  test("a missing copied source file (shim) throws and writes nothing", () => {
    rmSync(path.join(repoRoot, "bin", "quick-studio.cjs"), { force: true });
    expect(() =>
      buildNpmPackages({ binariesDir, version: VERSION, outDir, repoRoot }),
    ).toThrow(/quick-studio\.cjs/);
    expect(existsSync(outDir)).toBe(false);
  });

  test("a directory where a copied source file is expected throws before writing", () => {
    // Replace the README source with a directory: it exists but is not a file,
    // and must be rejected in the pre-write block (not blow up mid-copy).
    rmSync(path.join(repoRoot, "README.md"), { force: true });
    mkdirSync(path.join(repoRoot, "README.md"), { recursive: true });
    expect(() =>
      buildNpmPackages({ binariesDir, version: VERSION, outDir, repoRoot }),
    ).toThrow(/README\.md/);
    expect(existsSync(outDir)).toBe(false);
  });
});

describe("buildNpmPackages — reused outDir does not publish stale files", () => {
  test("a stale file in a managed package dir is cleared on the next build", () => {
    buildNpmPackages({ binariesDir, version: VERSION, outDir, repoRoot });
    // Plant a stale artifact inside a managed package dir.
    const stale = path.join(outDir, "quick-studio-linux-x64", "STALE.txt");
    writeFileSync(stale, "leftover from a previous run");
    expect(existsSync(stale)).toBe(true);
    // Re-run into the same outDir.
    buildNpmPackages({ binariesDir, version: VERSION, outDir, repoRoot });
    expect(existsSync(stale)).toBe(false);
    // The fresh binary + manifest are still there.
    expect(existsSync(path.join(outDir, "quick-studio-linux-x64", "quick-studio"))).toBe(true);
    expect(existsSync(path.join(outDir, "quick-studio-linux-x64", "package.json"))).toBe(true);
  });
});
