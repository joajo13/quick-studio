/**
 * quick-studio Core — CLI argument parsing + mode selection (Story 1.2).
 *
 * A dependency-free, unit-testable pure module. `parseCliArgs` turns raw
 * `argv` + `env` into a resolved `{ mode, databaseUrl, openBrowser }` decision so
 * `bin/` stays a thin wire-up with zero branching. It is the single home for the
 * Ephemeral/Persistent precedence rules (FR-4/5/6, UJ-2):
 *
 *   1. A DB-URL positional + `--persistent` is contradictory → refuse.
 *   2. A DB-URL positional (alone) → Ephemeral; the URL is carried forward for
 *      Story 1.3 to actually connect. Only its *shape* is validated here.
 *   3. `--persistent` → Persistent.
 *   4. Otherwise fall back to `resolveRunMode(env)` (honors `QS_MODE`, default
 *      Persistent). The DB URL is the strongest signal and overrides `QS_MODE`.
 *
 * Browser-open defaults on; `--no-open` or a non-empty `QS_NO_OPEN` suppresses it
 * (for CI / headless / dev-loop runs).
 *
 * Failures throw a typed {@link CliArgsError} carrying a terse message only — no
 * stack is surfaced to the user; `bin/` prints the message and `exit(1)`.
 */

import { parseArgs } from "node:util";
import { resolveRunMode, type RunMode, type RunModeEnv } from "./run-mode.ts";

/** The subset of environment variables `parseCliArgs` consults. */
export type CliArgsEnv = RunModeEnv & {
  /** Non-empty value suppresses browser-open, same as `--no-open`. */
  readonly QS_NO_OPEN?: string | undefined;
};

/** The resolved CLI decision handed to `bin/`. */
export type CliArgs = {
  /** Selected run mode (Ephemeral vs Persistent). */
  readonly mode: RunMode;
  /**
   * The Ephemeral DB URL (shape-validated only), or `null` in Persistent mode.
   * Carried in memory for Story 1.3; never persisted.
   */
  readonly databaseUrl: string | null;
  /** Whether to launch the OS default browser after boot. */
  readonly openBrowser: boolean;
};

/**
 * Typed error for any CLI usage problem (unknown flag, too many positionals,
 * contradictory selection, malformed URL). Message-only by contract: `bin/`
 * writes `err.message` to stderr and exits 1 — the stack is never shown.
 */
export class CliArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgsError";
  }
}

/**
 * Parse `argv` (already sliced past the runtime + script, e.g.
 * `process.argv.slice(2)`) and `env` into a resolved {@link CliArgs}. Pure: no
 * I/O, no `process` reads. Throws {@link CliArgsError} on any usage problem.
 */
export function parseCliArgs(argv: readonly string[], env: CliArgsEnv): CliArgs {
  let values: { persistent?: boolean; "no-open"?: boolean };
  let positionals: string[];
  try {
    // `strict: true` (the default) rejects unknown options; `allowPositionals`
    // lets a bare DB URL through as a positional.
    const parsed = parseArgs({
      args: [...argv],
      options: {
        persistent: { type: "boolean" },
        "no-open": { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    // Re-wrap so only the terse message escapes — never the parseArgs stack.
    throw new CliArgsError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length > 1) {
    throw new CliArgsError(
      `too many arguments: expected at most one database URL, got ${positionals.length}`,
    );
  }

  const urlArg = positionals[0] ?? null;
  const persistent = values.persistent === true;

  // Precedence gate 1: a URL selects Ephemeral, `--persistent` selects
  // Persistent — asking for both at once is contradictory, so refuse.
  if (urlArg !== null && persistent) {
    throw new CliArgsError(
      "contradictory mode selection: a database URL selects Ephemeral, but --persistent selects Persistent",
    );
  }

  let mode: RunMode;
  let databaseUrl: string | null = null;

  if (urlArg !== null) {
    // Shape-check ONLY — no engine/scheme validation or connection (Story 1.3).
    try {
      new URL(urlArg);
    } catch {
      // Do NOT echo the URL back — a connection string can embed a password, and
      // this message is written to stderr (capturable into logs/CI). Same
      // no-echo policy as the contradictory-mode / too-many-args errors above.
      throw new CliArgsError(
        "invalid database URL: the positional argument is not a valid URL",
      );
    }
    databaseUrl = urlArg;
    mode = "ephemeral";
  } else if (persistent) {
    mode = "persistent";
  } else {
    // Neither URL nor flag: honor QS_MODE (default Persistent).
    mode = resolveRunMode(env);
  }

  const noOpen =
    values["no-open"] === true ||
    (typeof env.QS_NO_OPEN === "string" && env.QS_NO_OPEN.length > 0);

  return { mode, databaseUrl, openBrowser: !noOpen };
}
