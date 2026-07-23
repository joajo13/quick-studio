import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Spawn-based tests for the Node launcher shim (bin/quick-studio.cjs).
 *
 * The real platform package (`quick-studio-<platform>-<arch>`) does not exist
 * in this repo — Story 11.4 builds it. So we materialize a FAKE one under a temp
 * dir and point the spawned shim at it via NODE_PATH (which require.resolve
 * honors), exercising the real resolve + spawn + exit path rather than a mock.
 */

const SHIM = path.join(import.meta.dir, "quick-studio.cjs");
const KEY = `${process.platform}-${process.arch}`;
const SUPPORTED_HERE = ["win32-x64", "linux-x64", "linux-arm64"].includes(KEY);
const RELEASES_URL = "https://github.com/joajo13/quick-studio/releases";
const BIN_NAME = process.platform === "win32" ? "quick-studio.exe" : "quick-studio";

/**
 * A fake platform binary: a `#!/usr/bin/env node` script that echoes its argv
 * as JSON to stdout and exits with a code from QS_FAKE_EXIT. When
 * QS_FAKE_TRAP_SIGINT is set it instead traps SIGINT, prints READY, and stays
 * alive until signalled (exiting with marker code 42) — for the signal test.
 * When QS_FAKE_SELF_SIGNAL is set it kills itself with that signal (no handler),
 * so the shim observes a signal-death `close` and must exit `128 + signum`.
 */
const FAKE_BINARY = `#!/usr/bin/env node
if (process.env.QS_FAKE_SELF_SIGNAL) {
  process.kill(process.pid, process.env.QS_FAKE_SELF_SIGNAL);
  setInterval(() => {}, 1000);
} else if (process.env.QS_FAKE_TRAP_SIGINT) {
  process.on("SIGINT", () => process.exit(42));
  process.stdout.write("READY\\n");
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify(process.argv.slice(2)));
  const code = process.env.QS_FAKE_EXIT ? Number(process.env.QS_FAKE_EXIT) : 0;
  process.exit(code);
}
`;

/** Create <root>/node_modules/quick-studio-<platform>-<arch>/{package.json,binary}. */
function materializeFakePkg(root: string): void {
  const pkgDir = path.join(root, "node_modules", `quick-studio-${KEY}`);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: `quick-studio-${KEY}`, version: "0.0.0" }),
  );
  const binPath = path.join(pkgDir, BIN_NAME);
  writeFileSync(binPath, FAKE_BINARY);
  if (process.platform !== "win32") chmodSync(binPath, 0o755);
}

/** Package dir with a resolvable manifest but NO binary → spawn ENOENT. */
function materializePkgMissingBinary(root: string): void {
  const pkgDir = path.join(root, "node_modules", `quick-studio-${KEY}`);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: `quick-studio-${KEY}`, version: "0.0.0" }),
  );
}

/** Package dir with a present but non-executable binary → spawn EACCES (POSIX). */
function materializePkgNonExec(root: string): void {
  materializeFakePkg(root);
  chmodSync(path.join(root, "node_modules", `quick-studio-${KEY}`, BIN_NAME), 0o644);
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RunHandle {
  child: ChildProcess;
  done: Promise<RunResult>;
  currentStdout: () => string;
}

/** Spawn `node bin/quick-studio.cjs <args>` with NODE_PATH pointed at `nodePath`. */
function runShim(
  args: string[],
  opts: { nodePath: string; env?: Record<string, string> },
): RunHandle {
  const child = spawn("node", [SHIM, ...args], {
    env: { ...process.env, NODE_PATH: opts.nodePath, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  const done = new Promise<RunResult>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done, currentStdout: () => stdout };
}

let pkgRoot: string;
let emptyRoot: string;
let missingBinRoot: string;
let nonExecRoot: string;

beforeAll(() => {
  pkgRoot = mkdtempSync(path.join(os.tmpdir(), "qs-shim-"));
  emptyRoot = mkdtempSync(path.join(os.tmpdir(), "qs-shim-empty-"));
  missingBinRoot = mkdtempSync(path.join(os.tmpdir(), "qs-shim-nobin-"));
  nonExecRoot = mkdtempSync(path.join(os.tmpdir(), "qs-shim-noexec-"));
  materializeFakePkg(pkgRoot);
  materializePkgMissingBinary(missingBinRoot);
  if (process.platform !== "win32") materializePkgNonExec(nonExecRoot);
});

afterAll(() => {
  rmSync(pkgRoot, { recursive: true, force: true });
  rmSync(emptyRoot, { recursive: true, force: true });
  rmSync(missingBinRoot, { recursive: true, force: true });
  rmSync(nonExecRoot, { recursive: true, force: true });
});

const nodePath = () => path.join(pkgRoot, "node_modules");

describe("quick-studio shim — argv & stdio fidelity", () => {
  test.skipIf(!SUPPORTED_HERE)(
    "argv passes through byte-identical (incl. a database URL positional)",
    async () => {
      const args = ["--ephemeral", "postgres://u:p@h/db?x=1&y=2"];
      const { code, stdout } = await runShim(args, { nodePath: nodePath() }).done;
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual(args);
    },
  );

  test.skipIf(!SUPPORTED_HERE)("no arguments → empty argv", async () => {
    const { code, stdout } = await runShim([], { nodePath: nodePath() }).done;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test.skipIf(!SUPPORTED_HERE)(
    "--version stdout reaches the parent, exit 0",
    async () => {
      const { code, stdout } = await runShim(["--version"], { nodePath: nodePath() }).done;
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual(["--version"]);
    },
  );
});

describe("quick-studio shim — exit-code passthrough", () => {
  test.skipIf(!SUPPORTED_HERE)("child exit code is mirrored exactly", async () => {
    const { code } = await runShim([], {
      nodePath: nodePath(),
      env: { QS_FAKE_EXIT: "3" },
    }).done;
    expect(code).toBe(3);
  });
});

describe("quick-studio shim — resolution failure UX", () => {
  test("unresolvable platform package → actionable stderr, non-zero exit", async () => {
    // emptyRoot has no node_modules → require.resolve throws; the package also
    // does not exist in the repo tree, so resolution genuinely fails.
    const { code, stderr } = await runShim([], {
      nodePath: path.join(emptyRoot, "node_modules"),
    }).done;
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(stderr).toContain(KEY);
    expect(stderr).toContain("windows-x64, linux-x64, linux-arm64");
    expect(stderr).toContain(RELEASES_URL);
    expect(stderr).not.toContain("MODULE_NOT_FOUND");
  });

  // The darwin-wording branch only fires when process.platform is darwin.
  test.skipIf(process.platform !== "darwin")(
    "darwin → stderr says macOS is not yet supported",
    async () => {
      const { stderr } = await runShim([], {
        nodePath: path.join(emptyRoot, "node_modules"),
      }).done;
      expect(stderr).toContain("macOS is not yet supported");
    },
  );
});

describe("quick-studio shim — signal forwarding (POSIX)", () => {
  test.skipIf(process.platform === "win32")(
    "SIGINT is forwarded; shim mirrors the child's graceful exit",
    async () => {
      const handle = runShim([], {
        nodePath: nodePath(),
        env: { QS_FAKE_TRAP_SIGINT: "1" },
      });
      // Wait for the fake child to signal readiness before delivering SIGINT.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fake never became READY")), 10000);
        const poll = setInterval(() => {
          if (handle.currentStdout().includes("READY")) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve();
          }
        }, 25);
      });
      handle.child.kill("SIGINT");
      const { code } = await handle.done;
      // Fake traps SIGINT and exits 42; shim mirrors that code.
      expect(code).toBe(42);
    },
  );
});

describe("quick-studio shim — signal-death mirroring (POSIX)", () => {
  test.skipIf(process.platform === "win32")(
    "child killed by a signal → shim exits 128 + signum",
    async () => {
      const { code } = await runShim([], {
        nodePath: nodePath(),
        env: { QS_FAKE_SELF_SIGNAL: "SIGKILL" },
      }).done;
      // The child dies from SIGKILL; the shim reports 128 + signum (137).
      expect(code).toBe(128 + os.constants.signals.SIGKILL);
    },
  );
});

describe("quick-studio shim — spawn-error failure UX", () => {
  test.skipIf(!SUPPORTED_HERE)(
    "binary missing at the resolved path → 'not installed' message, non-zero exit",
    async () => {
      // Manifest resolves but the binary is absent → spawn ENOENT → fail(...).
      const { code, stderr } = await runShim([], {
        nodePath: path.join(missingBinRoot, "node_modules"),
      }).done;
      expect(code).not.toBe(0);
      expect(code).not.toBeNull();
      expect(stderr).toContain("was not installed");
      expect(stderr).toContain(RELEASES_URL);
      expect(stderr).not.toContain("MODULE_NOT_FOUND");
    },
  );

  test.skipIf(process.platform === "win32" || !SUPPORTED_HERE)(
    "binary present but not executable → 'executable bit' message, non-zero exit",
    async () => {
      // Binary exists but is chmod 0o644 → spawn EACCES → exec-problem message.
      const { code, stderr } = await runShim([], {
        nodePath: path.join(nonExecRoot, "node_modules"),
      }).done;
      expect(code).not.toBe(0);
      expect(code).not.toBeNull();
      expect(stderr).toContain("executable bit");
      expect(stderr).not.toContain("MODULE_NOT_FOUND");
    },
  );
});
