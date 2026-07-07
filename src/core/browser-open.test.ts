import { describe, expect, test } from "bun:test";
import { openBrowser, type SpawnFn } from "./browser-open.ts";

/** Capture the argv a spawn call receives without launching anything. */
function recordingSpawn(): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnFn = (cmd) => {
    calls.push(cmd);
    return undefined;
  };
  return { spawn, calls };
}

const URL = "http://127.0.0.1:4321";

describe("openBrowser — per-platform launcher argv", () => {
  test("darwin → open <url>", () => {
    const { spawn, calls } = recordingSpawn();
    openBrowser(URL, { platform: "darwin", spawn });
    expect(calls).toEqual([["open", URL]]);
  });

  test("linux → xdg-open <url>", () => {
    const { spawn, calls } = recordingSpawn();
    openBrowser(URL, { platform: "linux", spawn });
    expect(calls).toEqual([["xdg-open", URL]]);
  });

  test("win32 → cmd /c start \"\" <url>", () => {
    const { spawn, calls } = recordingSpawn();
    openBrowser(URL, { platform: "win32", spawn });
    expect(calls).toEqual([["cmd", "/c", "start", "", URL]]);
  });

  test("unknown platform falls back to xdg-open", () => {
    const { spawn, calls } = recordingSpawn();
    openBrowser(URL, { platform: "freebsd" as NodeJS.Platform, spawn });
    expect(calls).toEqual([["xdg-open", URL]]);
  });
});

describe("openBrowser — resilience (best-effort, never throws)", () => {
  test("a throwing spawn is swallowed (call does not throw)", () => {
    const spawn: SpawnFn = () => {
      throw new Error("no launcher on this box");
    };
    expect(() => openBrowser(URL, { platform: "linux", spawn })).not.toThrow();
  });
});
