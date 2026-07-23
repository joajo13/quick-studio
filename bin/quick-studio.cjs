#!/usr/bin/env node
/**
 * quick-studio — Node-compatible launcher shim (npm/npx entry).
 *
 * Dependency-free CommonJS. This is the one file that runs BEFORE any product
 * code, so it may only use Node built-ins and must run on Node 18 with no
 * transpilation. It maps the running platform+arch to a prebuilt platform
 * package (`quick-studio-<platform>-<arch>`, published by Story 11.4), resolves
 * the standalone binary inside it, and spawns it with the CLI's argv verbatim
 * and inherited stdio. It forwards SIGINT/SIGTERM so the Core's clean-shutdown
 * path runs, then mirrors the child's exit. It never imports product code and
 * never falls back to running the TypeScript entry through Bun.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// One shared platform map (three consumers: release matrix, packaging, shim).
// The later macOS phase adds two entries here and nothing else.
const SUPPORTED = {
  "win32-x64": "quick-studio-win32-x64",
  "linux-x64": "quick-studio-linux-x64",
  "linux-arm64": "quick-studio-linux-arm64",
};
const RELEASES_URL = "https://github.com/joajo13/quick-studio/releases";

/**
 * Write an actionable, multi-line diagnostic to stderr and exit non-zero.
 * Never prints a raw MODULE_NOT_FOUND stack — the whole point of the branch.
 * Uses a SYNCHRONOUS write: `process.exit()` does not flush an async
 * `stderr.write` when stderr is a pipe (e.g. `2> log`), which would truncate
 * the one message this function exists to deliver.
 */
function fail(key, notInstalled, execProblem) {
  const lines = [];
  lines.push(`quick-studio: no prebuilt binary for this platform (detected: ${key}).`);
  if (key.startsWith("darwin")) {
    lines.push("macOS is not yet supported (a later release will add it).");
  }
  if (notInstalled) {
    lines.push(
      "The platform package for your system was not installed (or its binary is",
      "missing) — this usually means the install ran with --no-optional, or the",
      "optional install failed. Try reinstalling quick-studio (without",
      "--no-optional) so the matching binary is fetched.",
    );
  }
  if (execProblem) {
    lines.push(
      "The binary was found but could not be executed — it may have lost its",
      "executable bit during packaging (a packaging issue, not a config problem).",
    );
  }
  lines.push("Supported platforms: windows-x64, linux-x64, linux-arm64.");
  lines.push(`Download a standalone binary: ${RELEASES_URL}`);
  fs.writeSync(2, lines.join("\n") + "\n");
  process.exit(1);
}

const key = `${process.platform}-${process.arch}`;

if (!SUPPORTED[key]) {
  fail(key);
}

let resolved;
try {
  resolved = require.resolve(`${SUPPORTED[key]}/package.json`);
} catch (_e) {
  fail(key, /* notInstalled */ true);
}

const binary = path.join(
  path.dirname(resolved),
  process.platform === "win32" ? "quick-studio.exe" : "quick-studio",
);

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

child.on("error", (e) => {
  if (e.code === "ENOENT") {
    // The binary is not at the resolved location: a missing/partial install or
    // a packaging layout that differs from the pinned `<pkg>/quick-studio[.exe]`.
    fail(key, /* notInstalled */ true, /* execProblem */ false);
  } else if (e.code === "EACCES") {
    // The binary is present but not runnable — almost always a lost exec bit.
    fail(key, /* notInstalled */ false, /* execProblem */ true);
  } else {
    fs.writeSync(2, `quick-studio: failed to launch: ${e.message}\n`);
    process.exit(1);
  }
});

child.on("close", (code, signal) => {
  if (signal) {
    process.exit(128 + (os.constants.signals[signal] || 0));
  } else {
    process.exit(code == null ? 1 : code);
  }
});

// Signal forwarding (Story 1.5 clean-shutdown guarantee, all three platforms).
// On POSIX, forward the terminating signals so the Core's ShutdownController
// runs (or, for the signals it does not handle, so the child terminates instead
// of being orphaned when the signal targets the shim's PID alone — e.g.
// `kill -HUP <shim>` from a process manager). SIGINT/SIGTERM drive the graceful
// path; SIGHUP/SIGQUIT default-terminate the child but never leave it running
// with the port still bound. The Core's controller is idempotent, so a duplicate
// signal (kernel group-delivery on a terminal + this forward) is a safe no-op.
// On Windows we deliberately do NOT child.kill (Node maps these to
// TerminateProcess = a hard kill that defeats graceful shutdown); the shared
// console delivers CTRL_C to the child directly. Registering the handlers keeps
// Node from auto-terminating the shim, so it waits for the child's `close`.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
  process.on(sig, () => {
    if (process.platform !== "win32") {
      try {
        child.kill(sig);
      } catch {}
    }
  });
}
