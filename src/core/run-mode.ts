/**
 * quick-studio Core — Persistent/Ephemeral run-mode gate (FR-4/5/6, UJ-2).
 *
 * Epic 2's promise is twofold: in Persistent mode a saved Connection survives
 * across launches (encrypted at rest), while in Ephemeral mode NOTHING is ever
 * written to disk — no store file, no restored state. The credential store
 * consults this gate to decide whether a mutation is flushed to disk or kept in
 * memory only.
 *
 * {@link resolveRunMode} is PURE and total: it maps `QS_MODE` to a typed mode,
 * defaulting to `"persistent"`. Any unrecognized value falls back to the safe,
 * expected daily-driver default rather than throwing.
 */

/** The two run modes. `persistent` writes encrypted to disk; `ephemeral` never touches disk. */
export type RunMode = "persistent" | "ephemeral";

/** Environment variable that selects the run mode. */
export const RUN_MODE_ENV_VAR = "QS_MODE";

/** The mode used when `QS_MODE` is unset or unrecognized. */
export const DEFAULT_RUN_MODE: RunMode = "persistent";

/** The subset of environment variables the mode gate consults. */
export type RunModeEnv = {
  readonly QS_MODE?: string | undefined;
  readonly [key: string]: string | undefined;
};

/**
 * Resolve the run mode from `env`. Pure and total. `QS_MODE=ephemeral` (case- and
 * whitespace-insensitive) selects Ephemeral; anything else — including unset or an
 * unknown value — is Persistent.
 */
export function resolveRunMode(env: RunModeEnv): RunMode {
  const raw = env.QS_MODE?.trim().toLowerCase();
  return raw === "ephemeral" ? "ephemeral" : DEFAULT_RUN_MODE;
}
