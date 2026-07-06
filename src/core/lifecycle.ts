/**
 * quick-studio Core — shutdown lifecycle controller.
 *
 * The single convergence point for every shutdown trigger (SIGINT, SIGTERM,
 * UI-initiated `shutdown` RPC). `initiate()` runs `stop()` then `exit()` AT
 * MOST ONCE — a second call (signal mashed, or a signal racing the UI path)
 * is a safe no-op. Dependency-free. `stop` is awaited before `exit`, so a
 * future async teardown (e.g. `await pool.end()` once a DB pool exists) genuinely
 * completes before the process terminates — the header's async seam is real, not
 * decorative. `exit` runs even if `stop` rejects, so a failed teardown can never
 * wedge the process (the exact hang this controller prevents).
 */

export type ShutdownIo = {
  /** Release the server / port. Awaited first; may be sync or async. */
  readonly stop: () => void | Promise<void>;
  /** Terminate the process. Called second, ALWAYS — even if `stop` rejects. */
  readonly exit: () => void;
};

export type ShutdownController = {
  /** Run stop→exit exactly once, no matter how many times this is called. */
  initiate(): Promise<void>;
};

/** Build an idempotent shutdown controller over injected stop/exit hooks. */
export function createShutdownController(io: ShutdownIo): ShutdownController {
  let done = false;
  return {
    async initiate(): Promise<void> {
      if (done) return;
      done = true;
      // Exit must run even if `stop` throws/rejects — otherwise a failed
      // teardown would set `done` and then never exit, hanging forever. Swallow
      // the stop error (we are terminating regardless) so `initiate` never
      // rejects into a fire-and-forget caller (signal handler / macrotask).
      try {
        await io.stop();
      } catch {
        // best-effort teardown; exit below regardless
      }
      io.exit();
    },
  };
}
