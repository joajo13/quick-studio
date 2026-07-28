/**
 * Spawn-based tests for `bin/quick-studio.ts`'s hidden `QS_SELFCHECK` branch (DW-89).
 *
 * The branch is an entry-point early exit: it lives above `parseCliArgs` and ends
 * in `process.exit`, so nothing about it is reachable from an in-process unit
 * test. Its automated proof has to be a real process, or its only proof would be
 * a CI leg that has never run — which is precisely the state DW-89 exists to get
 * out of.
 *
 * We spawn `process.execPath` (the Bun already running this suite) rather than a
 * `bun`/`node` name on PATH: `bin/quick-studio-shim.test.ts` takes the latter
 * approach out of necessity (it tests a Node CJS launcher) and its cases fail on
 * any box without `node` installed. This file must not inherit that fragility.
 *
 * These run against the SOURCE tree, not a `bun build --compile` artifact — the
 * compiled-binary leg is `release.yml`'s job. What is proven here is the branch's
 * control flow: that it fires, that it exits, that the Core never boots, that argv
 * cannot reach it, and that an unset `QS_SELFCHECK` changes nothing.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { VERSION } from "../src/core/version.generated.ts";

const ENTRY = path.join(import.meta.dir, "quick-studio.ts");

/**
 * Generous, but a bound. A hang is a real failure mode here (a self-check that
 * fell through would boot the Core and listen forever), so every case must FAIL
 * on a stall rather than stall the suite: `spawnSync`'s own `timeout` kills the
 * child, leaving `status: null`, which every assertion below rejects.
 */
const SPAWN_TIMEOUT_MS = 60_000;
/** The bun:test budget must exceed the child's, or the runner aborts before the kill lands. */
const TEST_TIMEOUT_MS = 90_000;

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the entry with a deliberately scrubbed environment. Every `QS_*` and
 * `KEYRING_*` variable is dropped from the inherited env first: a developer with
 * `QS_MODE`, `QS_PORT`, or `KEYRING_REQUIRE_ROUNDTRIP` exported would otherwise
 * change what these cases actually assert. `QS_NO_OPEN=1` is set on every run so
 * that no case can launch a browser even if the branch under test regressed into
 * a normal boot.
 */
function runEntry(args: readonly string[], env: Record<string, string>): RunResult {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("QS_") || key.startsWith("KEYRING_")) continue;
    base[key] = value;
  }
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    env: { ...base, QS_NO_OPEN: "1", ...env },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  // Surface a spawn-level failure (ENOENT, EACCES) as itself instead of letting
  // it masquerade as a null exit status from the program under test.
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("QS_SELFCHECK=keychain", () => {
  test(
    "runs the keychain self-check, exits 0, and never boots the Core",
    () => {
      const run = runEntry([], { QS_SELFCHECK: "keychain" });
      // Exit 0 on ANY host: a box with a working keychain round-trips, a headless
      // one reports typed `unavailable` outcomes — both are passes, because this
      // gate proves the addon LOADED, not that a backend exists.
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("selfcheck: OK");
      // The Core booting would be the whole failure mode: these two strings are
      // the listening-URL line and the Port-Exposure Warning, i.e. proof that
      // `startCore` ran.
      expect(run.stderr).not.toContain("listening on");
      expect(run.stderr).not.toContain("PORT-EXPOSURE");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ignores argv entirely — even argv that is a usage error",
    () => {
      // `--persistent <positional>` is a contradictory mode selection: if argv
      // were parsed at all, this would exit 1 with "contradictory mode
      // selection". Exit 0 is the proof that the branch resolves first.
      const run = runEntry(["--persistent", "nonsense"], { QS_SELFCHECK: "keychain" });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("selfcheck: OK");
      expect(run.stderr).not.toContain("contradictory mode selection");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("QS_SELFCHECK with an unrecognized value", () => {
  test(
    "fails fast, names the variable and the expected value, and writes nothing to stdout",
    () => {
      const run = runEntry([], { QS_SELFCHECK: "bogus" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("QS_SELFCHECK");
      expect(run.stderr).toContain("bogus");
      expect(run.stderr).toContain("keychain");
      // stdout is reserved for requested output (--help/--version/self-check
      // progress); a diagnostic must never land there.
      expect(run.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "preempts --version — a stray value is never masked by argv that would have exited 0",
    () => {
      // The empty-argv case above cannot see this: the branch sits ABOVE
      // `parseCliArgs`, so `--version` (an exit-0 stdout path) is exactly the
      // argv that would hide a misconfigured gate if the ordering ever moved.
      // The gate invokes the binary with whatever argv the workflow passes, and
      // a leg that printed a version and exited 0 while QS_SELFCHECK was garbage
      // is the accidental green this ordering exists to prevent.
      const run = runEntry(["--version"], { QS_SELFCHECK: "bogus" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("unknown QS_SELFCHECK");
      expect(run.stderr).toContain("bogus");
      expect(run.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "preempts --help the same way",
    () => {
      const run = runEntry(["--help"], { QS_SELFCHECK: "bogus" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("unknown QS_SELFCHECK");
      expect(run.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a value differing only in trailing whitespace is not echoed back as `keychain`",
    () => {
      // The resolver is deliberately untrimmed, and the printing site collapses
      // whitespace — so without a hint arm a trailing space or a CRLF (what a
      // YAML scalar or a Windows-edited workflow file produces) prints the
      // self-contradictory `unknown QS_SELFCHECK 'keychain' (want: keychain)`.
      // This arm exists to make a CI misconfiguration a five-second diagnosis;
      // a line that appears to reject the value it asks for defeats that.
      const run = runEntry([], { QS_SELFCHECK: "keychain\r\n" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("unknown QS_SELFCHECK");
      expect(run.stderr).toContain("surrounding whitespace/control characters");
      expect(run.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an all-whitespace value says so instead of echoing an empty string",
    () => {
      const run = runEntry([], { QS_SELFCHECK: "   " });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("entirely whitespace or control characters");
      expect(run.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "sanitizes the echoed value — a newline in it cannot forge a second log line",
    () => {
      // The value is arbitrary environment text landing in a public CI log.
      // `formatSelfCheckValue` collapses control characters and whitespace, so
      // the diagnostic stays exactly one line no matter what was set.
      const run = runEntry([], {
        QS_SELFCHECK: "bogus\nquick-studio Core listening on http://attacker.example",
      });
      expect(run.status).toBe(1);
      expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(run.stderr).toContain("bogus quick-studio Core listening on");
      expect(run.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("QS_SELFCHECK unset or empty", () => {
  test(
    "an empty value changes nothing — --version still prints the version and exits 0",
    () => {
      // The no-regression proof: an empty variable resolves to `none` and the
      // pre-existing early exits behave byte-identically.
      const run = runEntry(["--version"], { QS_SELFCHECK: "" });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`${VERSION}\n`);
      expect(run.stdout).not.toContain("selfcheck");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "unset behaves identically to empty",
    () => {
      const run = runEntry(["--version"], {});
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`${VERSION}\n`);
    },
    TEST_TIMEOUT_MS,
  );
});
