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
  { pkg: "quick-studio-windows-x64", asset: "quick-studio-windows-x64.exe", binaryName: "quick-studio.exe", os: "win32", cpu: "x64" },
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
  // Distinct sentinel text, not a copy of the real MIT terms: the assertions below
  // check that THIS file is what lands in every package, so a generator that
  // hardcoded license text instead of copying the repo's would still fail.
  writeFileSync(path.join(repoRoot, "LICENSE"), "FAKE LICENSE TEXT for the packaging test\n");
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
      expect(m.files).toEqual([binaryName, "LICENSE"]);
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
    expect([...m.files].sort()).toEqual(["LICENSE", "README.md", "quick-studio.cjs"]);
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

  // A package that declares no license is what npm warns about and what auditing
  // tools read as all-rights-reserved — the state every package was in before
  // 0.1.0. Three things have to agree, so all three are pinned here: the SPDX id
  // in each generated manifest, the LICENSE file actually inside each tarball,
  // and the root package.json the repo publishes from.
  test("every generated package declares MIT and ships the repo's LICENSE text verbatim", () => {
    const sourceLicense = readFileSync(path.join(repoRoot, "LICENSE"), "utf8");

    for (const { pkg } of [...EXPECTED, { pkg: "quick-studio" }]) {
      const m = readManifest(pkg) as Record<string, unknown>;
      expect(m.license).toBe("MIT");

      // The SPDX id alone is not enough: the text must be inside the tarball and
      // byte-identical to the repo's, so anyone vendoring the package gets the
      // actual terms rather than a claim about them.
      const shipped = path.join(outDir, pkg, "LICENSE");
      expect(existsSync(shipped)).toBe(true);
      expect(readFileSync(shipped, "utf8")).toBe(sourceLicense);
    }
  });

  // Without `repository.url`, npm's OIDC publish fails with a 422: it attaches a
  // sigstore provenance statement naming the source repo and refuses to publish a
  // manifest that does not match it. Cosmetic-looking field, hard publish blocker
  // — the first v0.1.0 attempt died here, after the packages were already built.
  test("every generated package declares repository.url (required by provenance)", () => {
    for (const { pkg } of [...EXPECTED, { pkg: "quick-studio" }]) {
      const m = readManifest(pkg) as { repository?: { type?: string; url?: string } };
      expect(m.repository?.url).toBeTruthy();
      expect(m.repository?.url).toContain("github.com/joajo13/quick-studio");
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

// The tests above run against a temp repoRoot, so they prove the generator COPIES
// whatever license the repo has — not that the repo has the right one. These
// assert the real tree, where the three sources must agree: a mismatch (an SPDX
// id with no file, or a file the manifest never declares) is what makes a
// published package read as unlicensed.
describe("the repository's own license declaration", () => {
  const REPO = path.join(import.meta.dir, "..");

  test("package.json declares MIT and ships LICENSE in `files`", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as {
      license?: string;
      files?: string[];
    };
    expect(pkg.license).toBe("MIT");
    expect(pkg.files).toContain("LICENSE");
  });

  test("a LICENSE file exists at the repo root and carries the MIT terms", () => {
    const text = readFileSync(path.join(REPO, "LICENSE"), "utf8");
    expect(text).toContain("MIT License");
    // The permission grant itself, not just the title — a stub file titled
    // "MIT License" with no terms would satisfy a title-only check.
    expect(text).toContain("Permission is hereby granted, free of charge");
    expect(text).toMatch(/Copyright \(c\) \d{4}/);
  });

  test("the repository URL the generator stamps matches the one package.json declares", () => {
    // These two drifting apart is silent until a release: the generated manifests
    // would name a repo that the provenance statement does not, and npm 422s.
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as {
      repository?: { url?: string };
    };
    expect(pkg.repository?.url).toBeTruthy();

    const source = readFileSync(path.join(REPO, "scripts", "build-npm-packages.ts"), "utf8");
    const match = source.match(/const REPOSITORY_URL = "([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(pkg.repository!.url);
  });

  test("the id the generator stamps matches the one package.json declares", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as {
      license?: string;
    };
    const source = readFileSync(path.join(REPO, "scripts", "build-npm-packages.ts"), "utf8");
    const match = source.match(/const LICENSE_ID = "([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(pkg.license);
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
