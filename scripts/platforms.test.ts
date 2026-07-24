import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PKG_PREFIX, PLATFORMS } from "./platforms.ts";

/**
 * Unit-testable core of the Story 11.2 I/O matrix. Everything else about the
 * release matrix is CI-runtime behavior (native runners, the keyring gate),
 * which cannot be exercised from this working tree — see the spec's
 * "Manual checks" section. This file asserts the platform table's SHAPE and
 * its CLI output modes.
 *
 * These assertions are NOT all growth-neutral, deliberately: the `no darwin row`
 * guard, the exact-asset-list assertion, and the arm-label guard are TRIPWIRES.
 * A future macOS row must edit them ON PURPOSE — that is the point, since a
 * darwin row must not appear before its keyring CI leg is green. What stays
 * automatic is everything downstream: the release matrix, the packaging script,
 * and `publish.yml` all derive from the table and need no edit.
 */

const SCRIPT = path.join(import.meta.dir, "platforms.ts");

function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });
  // Without this, a spawn failure (e.g. `bun` not on PATH) leaves status/stdout/
  // stderr null and every CLI test below dies with `TypeError: null.split` —
  // masking the real cause behind an unrelated-looking assertion error.
  if (result.error) throw result.error;
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("PLATFORMS — table shape", () => {
  test("every row's key is `${os}-${cpu}`", () => {
    for (const row of PLATFORMS) {
      expect(row.key).toBe(`${row.os}-${row.cpu}`);
    }
  });

  test("keys are unique", () => {
    // Two rows sharing an os+cpu share a `key`, which is the artifact name in
    // `release.yml` (`binary-${{ matrix.key }}`) and the npm package suffix in
    // `build-npm-packages.ts`. Today the exact-asset assertion below happens to
    // block that too, but that assertion is a TRIPWIRE the macOS phase is meant
    // to edit — this one is an invariant that must survive the edit.
    const keys = PLATFORMS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("asset filenames are unique and exactly the three current names", () => {
    const assets = PLATFORMS.map((r) => r.asset);
    expect(new Set(assets).size).toBe(assets.length);
    expect(assets).toEqual([
      "quick-studio-windows-x64.exe",
      "quick-studio-linux-x64",
      "quick-studio-linux-arm64",
    ]);
  });

  test("windows asset uses the `windows` token and `.exe` (not `win32`)", () => {
    const winRow = PLATFORMS.find((r) => r.os === "win32");
    expect(winRow).toBeDefined();
    expect(winRow!.asset).toBe("quick-studio-windows-x64.exe");
    expect(winRow!.asset).not.toContain("win32");
  });

  test("cross-compile guard, as data: runner label is well-formed, matches os, and ends in `-arm` iff arm64", () => {
    for (const row of PLATFORMS) {
      // A bare `startsWith`/`includes` pair is satisfied by a typo'd label like
      // `ubuntu-24.04-armadillo`. Pin the label's SHAPE first (still permitting
      // a future `macos-latest` row), then require an exact `-arm` suffix.
      expect(row.runner).toMatch(/^(windows|ubuntu|macos)-[a-z0-9.]+(-arm)?$/);
      expect(row.runner.startsWith("windows")).toBe(row.os === "win32");
      expect(row.runner.startsWith("ubuntu")).toBe(row.os === "linux");
      expect(row.cpu === "arm64").toBe(row.runner.endsWith("-arm"));
    }
  });

  test("no darwin/macos row exists — the macOS boundary, enforced as data", () => {
    for (const row of PLATFORMS) {
      expect(row.os).not.toBe("darwin");
      expect(row.key).not.toContain("darwin");
      expect(row.runner).not.toContain("macos");
    }
  });
});

describe("platforms.ts CLI — --github-matrix", () => {
  test("prints exactly one line of JSON that parses back to PLATFORMS", () => {
    const { code, stdout, stderr } = run("--github-matrix");
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(PLATFORMS);
  });
});

describe("platforms.ts CLI — --assets", () => {
  test("prints the assets, one per line, in table order", () => {
    const { code, stdout, stderr } = run("--assets");
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual(PLATFORMS.map((r) => r.asset));
  });
});

describe("platforms.ts CLI — --packages", () => {
  test("prints the npm package names, one per line, in table order", () => {
    const { code, stdout, stderr } = run("--packages");
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual(PLATFORMS.map((r) => PKG_PREFIX + r.key));
  });
});

describe("platforms.ts CLI — --help", () => {
  test("writes usage to STDOUT and exits 0 (asking for help is not an error)", () => {
    for (const flag of ["--help", "-h"]) {
      const { code, stdout, stderr } = run(flag);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("usage:");
    }
  });
});

describe("platforms.ts CLI — bogus/absent args", () => {
  test("an unknown flag writes usage to stderr and exits 1", () => {
    const { code, stderr, stdout } = run("--bogus");
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout).toBe("");
  });

  test("no args at all writes usage to stderr and exits 1", () => {
    const { code, stderr } = run();
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("more than one argument writes usage to stderr and exits 1", () => {
    // The `args.length === 1` guard also rejects a valid flag with extra
    // arguments — `--assets --github-matrix` and `--assets extra` are errors,
    // not a silently-honored first flag.
    for (const argv of [["--assets", "--github-matrix"], ["--assets", "extra"]]) {
      const { code, stderr, stdout } = run(...argv);
      expect(code).toBe(1);
      expect(stderr.length).toBeGreaterThan(0);
      expect(stdout).toBe("");
    }
  });
});
