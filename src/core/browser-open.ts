/**
 * quick-studio Core — best-effort OS default-browser launcher (Story 1.2).
 *
 * After boot, `bin/` opens the Workspace in the user's default browser on a
 * navigable, gate-passing URL. This is strictly best-effort: a missing launcher
 * (e.g. `xdg-open` absent on a headless box) or any spawn failure must NEVER take
 * down the Core — the session keeps running and the user can open the logged URL
 * by hand. `--no-open` / `QS_NO_OPEN` skip this entirely (decided upstream).
 *
 * `spawn` and `platform` are injected so the per-OS argv and the swallow-on-error
 * behavior are unit-testable without actually launching a browser.
 */

/** Injected spawn — matches `Bun.spawn(cmd: string[])`'s shape (fire-and-forget). */
export type SpawnFn = (cmd: string[]) => unknown;

/** Injected dependencies for {@link openBrowser}. */
export type BrowserOpenDeps = {
  /** Target platform (matches `process.platform`). */
  readonly platform: NodeJS.Platform;
  /** Spawn function (e.g. `Bun.spawn`). */
  readonly spawn: SpawnFn;
};

/**
 * Build the per-OS launcher argv:
 *  - darwin: `open <url>`
 *  - win32:  `cmd /c start "" <url>`  (the empty `""` is `start`'s title arg, so
 *            a URL with special chars is treated as the target, not a title)
 *  - other (linux/BSD): `xdg-open <url>`
 */
function launcherArgv(platform: NodeJS.Platform, url: string): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

/**
 * Launch the OS default browser on `url`. Fire-and-forget: it does NOT await the
 * child. Any spawn failure is swallowed with a terse stderr note — this function
 * never throws, so a launch failure can never abort the session.
 */
export function openBrowser(url: string, deps: BrowserOpenDeps): void {
  try {
    deps.spawn(launcherArgv(deps.platform, url));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `quick-studio: could not open browser (${msg}); open ${url} manually\n`,
    );
  }
}
