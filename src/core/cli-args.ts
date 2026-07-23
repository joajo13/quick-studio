/**
 * quick-studio Core — CLI argument parsing + mode selection (Story 1.2).
 *
 * A dependency-free, unit-testable pure module. `parseCliArgs` turns raw
 * `argv` + `env` into a resolved `{ action, mode, databaseUrl, openBrowser }`
 * decision so `bin/` stays a thin wire-up with zero branching. It is the
 * single home for the Ephemeral/Persistent precedence rules (FR-4/5/6, UJ-2),
 * plus the `--help`/`--version` early exits (Story 11.1):
 *
 *   0. `--help`/`--version` → `action` short-circuits BEFORE any guard below
 *      (help wins if both are passed); `bin/` prints to stdout and exits 0
 *      without ever booting the Core.
 *   1. A DB-URL positional + `--persistent` is contradictory → refuse. So is
 *      `--ephemeral` + `--persistent` (checked first, own message).
 *   2. A DB-URL positional (alone) → Ephemeral; the URL is carried forward for
 *      Story 1.3 to actually connect. Only its *shape* is validated here.
 *   3. `--ephemeral` (alone, no URL) → Ephemeral with `databaseUrl: null` — a
 *      session with no connection configured.
 *   4. `--persistent` → Persistent.
 *   5. Otherwise fall back to `resolveRunMode(env)` (honors `QS_MODE`, default
 *      Persistent). The DB URL / `--ephemeral` are the strongest signals and
 *      override `QS_MODE`.
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
  /** Non-empty value disables the TTL-cached update check (Story 11.5), in every mode. */
  readonly QS_NO_UPDATE_CHECK?: string | undefined;
};

/** The resolved CLI decision handed to `bin/`. */
export type CliArgs = {
  /**
   * What `bin/` should do: `"help"`/`"version"` are early-exit requests for
   * stdout output (never boot the Core); `"run"` is the normal path. A flat
   * field rather than a discriminated union — see Design Notes in
   * spec-11-1-cli-surface-help-version.md for why: it keeps every pre-existing
   * field always present (so untouched tests never need to narrow) while
   * still making help/version mutually exclusive by construction. `"update"`
   * (Story 11.5) is a sibling early-exit request: `bin/` prints the upgrade
   * instructions and exits 0 without booting the Core.
   */
  readonly action: "run" | "help" | "version" | "update";
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
  let values: {
    help?: boolean;
    version?: boolean;
    persistent?: boolean;
    ephemeral?: boolean;
    "no-open"?: boolean;
  };
  let positionals: string[];
  try {
    // `strict: true` (the default) rejects unknown options; `allowPositionals`
    // lets a bare DB URL through as a positional.
    const parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        persistent: { type: "boolean" },
        ephemeral: { type: "boolean" },
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

  // Browser-open is resolved up here so the help/version early return below can
  // carry the same value the normal path would — those fields are never read
  // (`bin/` exits first), but a stale/invented value is a trap for the next
  // reader.
  const noOpen =
    values["no-open"] === true ||
    (typeof env.QS_NO_OPEN === "string" && env.QS_NO_OPEN.length > 0);

  // Help/version are early exits: they must outrank BOTH the positional-count
  // guard and the contradiction gate below, so e.g. `--help <url> --persistent`
  // still yields help instead of an error (help/version short-circuit before
  // the contradictory-mode gate can ever run). Help wins if both are passed.
  // The remaining fields are filled from the pure fallback since `bin/`
  // exits before ever reading them.
  if (values.help === true || values.version === true) {
    return {
      action: values.help === true ? "help" : "version",
      mode: resolveRunMode(env),
      databaseUrl: null,
      openBrowser: !noOpen,
    };
  }

  // `quick-studio update` (Story 11.5): the sole literal `update` positional is
  // intercepted as the subcommand BEFORE the too-many-args guard and the URL
  // shape check below. Unambiguous because a database URL always carries a scheme
  // (`postgres://…`), so a bare `update` can never be mistaken for one. Any other
  // positional falls through and is parsed as a URL exactly as before.
  if (positionals.length === 1 && positionals[0] === "update") {
    return {
      action: "update",
      mode: resolveRunMode(env),
      databaseUrl: null,
      openBrowser: !noOpen,
    };
  }

  if (positionals.length > 1) {
    throw new CliArgsError(
      `too many arguments: expected at most one database URL, got ${positionals.length}`,
    );
  }

  const urlArg = positionals[0] ?? null;
  const persistent = values.persistent === true;
  const ephemeral = values.ephemeral === true;

  // Precedence gate 1: `--ephemeral` and `--persistent` select opposite modes
  // — asking for both at once is contradictory, so refuse. Checked BEFORE the
  // URL+`--persistent` gate below, whose message stays byte-identical.
  if (ephemeral && persistent) {
    throw new CliArgsError(
      "contradictory mode selection: --ephemeral and --persistent select opposite modes",
    );
  }

  // Precedence gate 2: a URL selects Ephemeral, `--persistent` selects
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
  } else if (ephemeral) {
    // Explicit --ephemeral with no URL: a session with no connection
    // configured (databaseUrl stays null). Sits below the URL branch so
    // `--ephemeral <url>` still carries the URL through.
    mode = "ephemeral";
  } else if (persistent) {
    mode = "persistent";
  } else {
    // Neither URL nor flag: honor QS_MODE (default Persistent).
    mode = resolveRunMode(env);
  }

  return { action: "run", mode, databaseUrl, openBrowser: !noOpen };
}
