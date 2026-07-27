import { describe, expect, test } from "bun:test";
import {
  type CachedUpdate,
  type RunUpdateCheckDeps,
  detectInstallChannel,
  isCacheStale,
  isNewer,
  parseSemver,
  printUpdateInstructions,
  runUpdateCheck,
  shouldNotify,
  updateInstructions,
} from "./update-check.ts";

const HOUR_MS = 60 * 60 * 1000;
const TTL_MS = 24 * HOUR_MS;
const NOW = 1_700_000_000_000;

describe("parseSemver", () => {
  const cases: Array<[string, ReturnType<typeof parseSemver>]> = [
    ["0.0.1", { major: 0, minor: 0, patch: 1, prerelease: false }],
    ["1.2.3", { major: 1, minor: 2, patch: 3, prerelease: false }],
    ["10.20.30", { major: 10, minor: 20, patch: 30, prerelease: false }],
    ["1.2.3-beta.1", { major: 1, minor: 2, patch: 3, prerelease: true }],
    ["1.2.3+build.5", { major: 1, minor: 2, patch: 3, prerelease: false }],
    ["1.2.3-rc.1+build", { major: 1, minor: 2, patch: 3, prerelease: true }],
    // Malformed → null.
    ["1.2", null],
    ["1.2.3.4", null],
    ["v1.2.3", null],
    ["not-a-version", null],
    ["", null],
    ["1.2.3 oops", null],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(parseSemver(input)).toEqual(expected);
    });
  }
});

describe("isNewer (stable major.minor.patch only)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["0.0.2", "0.0.1", true],
    ["0.1.0", "0.0.9", true],
    ["1.0.0", "0.9.9", true],
    ["1.2.4", "1.2.3", true],
    // Equal or older → false.
    ["0.0.1", "0.0.1", false],
    ["1.2.3", "1.2.4", false],
    ["0.9.9", "1.0.0", false],
    // A prerelease `latest` never notifies, even when numerically ahead.
    ["1.3.0-beta.1", "1.2.9", false],
    ["2.0.0-rc.1", "1.9.9", false],
    // Unparseable input is never newer.
    ["garbage", "1.0.0", false],
    ["1.0.0", "garbage", false],
  ];
  for (const [latest, current, expected] of cases) {
    test(`isNewer(${latest}, ${current}) === ${expected}`, () => {
      expect(isNewer(latest, current)).toBe(expected);
    });
  }
});

describe("isCacheStale", () => {
  test("younger than TTL → not stale", () => {
    expect(isCacheStale(NOW - HOUR_MS, NOW, TTL_MS)).toBe(false);
  });
  test("exactly TTL old → stale", () => {
    expect(isCacheStale(NOW - TTL_MS, NOW, TTL_MS)).toBe(true);
  });
  test("older than TTL → stale", () => {
    expect(isCacheStale(NOW - TTL_MS - 1, NOW, TTL_MS)).toBe(true);
  });
  test("non-finite checkedAt (corrupt) → stale", () => {
    expect(isCacheStale(Number.NaN, NOW, TTL_MS)).toBe(true);
  });
  test("future checkedAt (clock skew) → stale, so the check keeps refreshing", () => {
    expect(isCacheStale(NOW + HOUR_MS, NOW, TTL_MS)).toBe(true);
    expect(isCacheStale(Number.POSITIVE_INFINITY, NOW, TTL_MS)).toBe(true);
  });
});

describe("shouldNotify", () => {
  test("no cache → false", () => {
    expect(shouldNotify("0.0.1", null, NOW)).toBe(false);
  });
  test("cached latest newer → true (even when stale)", () => {
    const cached: CachedUpdate = { latest: "0.0.2", checkedAt: NOW - 2 * TTL_MS };
    expect(shouldNotify("0.0.1", cached, NOW)).toBe(true);
  });
  test("cached latest equal → false", () => {
    expect(shouldNotify("0.0.1", { latest: "0.0.1", checkedAt: NOW }, NOW)).toBe(false);
  });
  test("cached latest older → false", () => {
    expect(shouldNotify("1.0.0", { latest: "0.9.0", checkedAt: NOW }, NOW)).toBe(false);
  });
  test("cached prerelease latest → false", () => {
    expect(shouldNotify("0.0.1", { latest: "0.0.2-beta.1", checkedAt: NOW }, NOW)).toBe(false);
  });
});

describe("detectInstallChannel", () => {
  const cases: Array<[string, ReturnType<typeof detectInstallChannel>]> = [
    ["/home/u/proj/node_modules/quick-studio-linux-x64/quick-studio", "npm"],
    ["C:\\Users\\u\\proj\\node_modules\\quick-studio-win32-x64\\quick-studio.exe", "npm"],
    ["/home/u/.npm/_npx/abc123/node_modules/quick-studio-linux-x64/quick-studio", "npm"],
    ["/usr/local/bin/quick-studio", "standalone"],
    ["/home/u/Downloads/quick-studio-linux-x64", "standalone"],
    ["C:\\tools\\quick-studio-windows-x64.exe", "standalone"],
    // Bare runtime / ambiguous → unknown → print both.
    ["/usr/local/bin/bun", "unknown"],
    ["/usr/bin/node", "unknown"],
    ["", "unknown"],
  ];
  for (const [execPath, expected] of cases) {
    test(`${execPath || "<empty>"} → ${expected}`, () => {
      expect(detectInstallChannel(execPath)).toBe(expected);
    });
  }
});

describe("updateInstructions", () => {
  test("npm → the global-install command", () => {
    const text = updateInstructions("npm");
    expect(text).toContain("npm i -g quick-studio@latest");
    expect(text).not.toContain("Download");
  });
  test("standalone → Releases URL + SHA256SUMS verify", () => {
    const text = updateInstructions("standalone");
    expect(text).toContain("https://github.com/joajo13/quick-studio/releases");
    expect(text).toContain("SHA256SUMS");
    expect(text).not.toContain("npm i -g");
  });
  test("unknown → both instruction sets", () => {
    const text = updateInstructions("unknown");
    expect(text).toContain("npm i -g quick-studio@latest");
    expect(text).toContain("https://github.com/joajo13/quick-studio/releases");
  });
});

/** A deps bag whose every seam is a counting spy, so a test can assert zero calls. */
function spyDeps(overrides: Partial<RunUpdateCheckDeps> = {}) {
  const calls = { now: 0, readCache: 0, writeCache: 0, fetchImpl: 0, stderr: 0 };
  const lines: string[] = [];
  const writes: CachedUpdate[] = [];
  const deps: RunUpdateCheckDeps = {
    now: () => {
      calls.now++;
      return NOW;
    },
    readCache: () => {
      calls.readCache++;
      return null;
    },
    writeCache: (data) => {
      calls.writeCache++;
      writes.push(data);
    },
    fetchImpl: (async () => {
      calls.fetchImpl++;
      throw new Error("network disabled in test");
    }) as unknown as typeof fetch,
    stderr: (line) => {
      calls.stderr++;
      lines.push(line);
    },
    ...overrides,
  };
  return { deps, calls, lines, writes };
}

describe("runUpdateCheck — mode/env guards (zero seams)", () => {
  test("Ephemeral mode → NO seam invoked (hardest invariant)", () => {
    const { deps, calls } = spyDeps();
    runUpdateCheck("ephemeral", {}, deps);
    expect(calls).toEqual({ now: 0, readCache: 0, writeCache: 0, fetchImpl: 0, stderr: 0 });
  });

  test("QS_NO_UPDATE_CHECK set → NO seam invoked, in Persistent mode", () => {
    const { deps, calls } = spyDeps();
    runUpdateCheck("persistent", { QS_NO_UPDATE_CHECK: "1" }, deps);
    expect(calls).toEqual({ now: 0, readCache: 0, writeCache: 0, fetchImpl: 0, stderr: 0 });
  });

  test("QS_NO_UPDATE_CHECK empty string does NOT disable (non-empty convention)", () => {
    const { deps, calls } = spyDeps();
    runUpdateCheck("persistent", { QS_NO_UPDATE_CHECK: "" }, deps);
    // Empty is not "set" — the check proceeds and reads the cache.
    expect(calls.readCache).toBe(1);
  });
});

describe("runUpdateCheck — Persistent behavior", () => {
  test("no cache → no notice, background refresh fired", () => {
    const { deps, calls, lines } = spyDeps({ readCache: () => null });
    runUpdateCheck("persistent", {}, deps);
    expect(lines).toEqual([]);
    expect(calls.fetchImpl).toBe(1);
  });

  test("fresh up-to-date cache → no notice, no refresh", () => {
    const cached: CachedUpdate = { latest: "0.0.1", checkedAt: NOW - HOUR_MS };
    const { deps, calls, lines } = spyDeps({ readCache: () => cached });
    runUpdateCheck("persistent", {}, deps);
    expect(lines).toEqual([]);
    expect(calls.fetchImpl).toBe(0);
  });

  test("fresh cache with newer version → one stderr notice, no refresh", () => {
    const cached: CachedUpdate = { latest: "9.9.9", checkedAt: NOW - HOUR_MS };
    const { deps, calls, lines } = spyDeps({ readCache: () => cached });
    runUpdateCheck("persistent", {}, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("9.9.9");
    expect(lines[0]).toContain("update available");
    expect(calls.fetchImpl).toBe(0);
  });

  test("stale cache with newer version → notice shown AND refresh fired", () => {
    const cached: CachedUpdate = { latest: "9.9.9", checkedAt: NOW - 2 * TTL_MS };
    const { deps, calls, lines } = spyDeps({ readCache: () => cached });
    runUpdateCheck("persistent", {}, deps);
    expect(lines.length).toBe(1);
    expect(calls.fetchImpl).toBe(1);
  });

  test("corrupt cache (readCache throws in real impl → null here) → discarded, no throw", () => {
    // The real readCache swallows corruption to null; simulate that contract.
    const { deps } = spyDeps({ readCache: () => null });
    expect(() => runUpdateCheck("persistent", {}, deps)).not.toThrow();
  });

  test("a throwing stderr sink (e.g. EPIPE mid-notice) never propagates into the boot path", () => {
    // Boot invariant: the fire-and-forget check must be structurally incapable of
    // failing the boot, even if the diagnostic sink itself throws.
    const cached: CachedUpdate = { latest: "9.9.9", checkedAt: NOW - HOUR_MS };
    const { deps } = spyDeps({
      readCache: () => cached,
      stderr: () => {
        throw new Error("EPIPE: broken pipe");
      },
    });
    expect(() => runUpdateCheck("persistent", {}, deps)).not.toThrow();
  });
});

describe("runUpdateCheck — refresh writes valid, ignores invalid", () => {
  test("valid registry version → cache written", async () => {
    let resolveWrite: (() => void) | undefined;
    const written = new Promise<void>((r) => {
      resolveWrite = r;
    });
    const { deps, writes } = spyDeps({
      readCache: () => null,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ version: "1.2.3" }),
      })) as unknown as typeof fetch,
      writeCache: (data) => {
        writes.push(data);
        resolveWrite?.();
      },
    });
    runUpdateCheck("persistent", {}, deps);
    await written;
    expect(writes).toEqual([{ latest: "1.2.3", checkedAt: NOW }]);
  });

  test("garbage registry version → no write, no throw", async () => {
    const { deps, writes } = spyDeps({
      readCache: () => null,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ version: "not-semver" }),
      })) as unknown as typeof fetch,
    });
    runUpdateCheck("persistent", {}, deps);
    // Let the floating refresh promise settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(writes).toEqual([]);
  });

  test("registry 5xx → no write, no throw", async () => {
    const { deps, writes } = spyDeps({
      readCache: () => null,
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
    });
    runUpdateCheck("persistent", {}, deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(writes).toEqual([]);
  });

  test("fetch rejects (offline) → silent no-op", async () => {
    const { deps, writes } = spyDeps({ readCache: () => null });
    expect(() => runUpdateCheck("persistent", {}, deps)).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(writes).toEqual([]);
  });
});

describe("printUpdateInstructions", () => {
  test("npm execPath → prints npm command to the injected sink", () => {
    let out = "";
    printUpdateInstructions({
      execPath: "/p/node_modules/quick-studio-linux-x64/quick-studio",
      stdout: (t) => {
        out += t;
      },
    });
    expect(out).toContain("npm i -g quick-studio@latest");
  });

  test("standalone execPath → prints Releases URL", () => {
    let out = "";
    printUpdateInstructions({
      execPath: "/usr/local/bin/quick-studio",
      stdout: (t) => {
        out += t;
      },
    });
    expect(out).toContain("https://github.com/joajo13/quick-studio/releases");
  });

  test("unknown execPath → prints both", () => {
    let out = "";
    printUpdateInstructions({
      execPath: "/usr/local/bin/bun",
      stdout: (t) => {
        out += t;
      },
    });
    expect(out).toContain("npm i -g quick-studio@latest");
    expect(out).toContain("https://github.com/joajo13/quick-studio/releases");
  });
});
