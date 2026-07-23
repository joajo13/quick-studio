/**
 * quick-studio Core — passphrase provider seam (FR-5, AR-7, AD-5, UJ-2).
 *
 * The "offer / decline" boundary the credential store consults when the OS
 * keychain is unavailable. Story 2.3 shipped the headless default —
 * {@link envPassphraseProvider}, reading `QS_PASSPHRASE` — so the fallback works on
 * a keychain-less box today. Story 11.6 injects an interactive prompt through this
 * SAME seam via {@link staticPassphraseProvider}: `bin/` runs the prompt
 * asynchronously BEFORE the Core boots (the sync `PassphraseProvider` contract below
 * is never made async) and hands `startCore` a pre-resolved closure that simply
 * replays the captured answer. The context carries NO secret; the passphrase flows
 * out only via a `provided` response.
 */

import { readFileSync } from "node:fs";

/** Environment variable the default provider reads the passphrase from. */
export const PASSPHRASE_ENV_VAR = "QS_PASSPHRASE";

/**
 * Environment variable naming the file descriptor the alternate provider reads the
 * passphrase from (an fd NUMBER, never the secret itself). Opt-in: when set to a
 * valid non-negative integer, {@link resolvePassphraseProvider} selects the fd
 * transport over the env one.
 */
export const PASSPHRASE_FD_ENV_VAR = "QS_PASSPHRASE_FD";

/**
 * Context passed to a {@link PassphraseProvider}. Non-secret: it only explains WHY
 * a passphrase is being requested (`reason`) and whether the store is brand-new
 * (`isFirstRun`), so a prompt can adjust its copy. Never carries a passphrase.
 */
export type PassphraseContext = {
  readonly reason: "keychain-unavailable";
  readonly isFirstRun: boolean;
};

/** A provider's answer: a passphrase, or an explicit decline (fall back to nothing). */
export type PassphraseResponse =
  | { readonly outcome: "provided"; readonly passphrase: string }
  | { readonly outcome: "declined" };

/**
 * Synchronous passphrase source. Total: returns a typed {@link PassphraseResponse}.
 * A `declined` result MUST cause the store to write nothing (no descriptor, no
 * ciphertext, no plaintext).
 */
export type PassphraseProvider = (ctx: PassphraseContext) => PassphraseResponse;

/**
 * Default provider: read the passphrase from `env[QS_PASSPHRASE]`. An unset, empty,
 * or whitespace-only value is a `declined` (there is nothing to unlock with). The
 * value is read at call time so a test/host can set it just before opening.
 *
 * SECURITY — env secret exposure: a passphrase carried in `QS_PASSPHRASE` is
 * readable by same-user tooling via `/proc/<pid>/environ`, is inherited by every
 * spawned child process, and may be captured in a core dump. It is never written to
 * disk or logged, but the environment is a well-known secret-leak surface. On
 * headless hosts prefer the hardened file-descriptor transport — set
 * {@link PASSPHRASE_FD_ENV_VAR} (`QS_PASSPHRASE_FD`) to an fd number and feed the
 * secret over that fd (see {@link fdPassphraseProvider}); the env var then carries
 * only the fd number, not the secret.
 */
export function envPassphraseProvider(
  env: Record<string, string | undefined>,
): PassphraseProvider {
  return (_ctx: PassphraseContext): PassphraseResponse => {
    const value = env[PASSPHRASE_ENV_VAR];
    if (value === undefined || value.trim().length === 0) {
      return { outcome: "declined" };
    }
    return { outcome: "provided", passphrase: value };
  };
}

/**
 * Reads the entire contents of a file descriptor as UTF-8. Injectable so tests can
 * model single-read fd semantics without touching a real fd.
 */
export type FdReader = (fd: number) => string;

/** Default {@link FdReader}: synchronously read the fd to EOF as UTF-8 (`node:fs`). */
export const defaultReadFd: FdReader = (fd: number): string =>
  readFileSync(fd, "utf8");

/**
 * Read the fd exactly once and classify it. Strips exactly ONE trailing line ending
 * (`\r?\n`) — the transport delimiter — then applies the same empty/whitespace-only
 * → `declined` rule as the env provider, preserving leading/interior characters
 * verbatim. Any read failure (invalid/closed fd, EOF-only/empty) → `declined`. Total:
 * never throws.
 */
function readOnce(fd: number, readFd: FdReader): PassphraseResponse {
  let raw: string;
  try {
    raw = readFd(fd);
  } catch {
    // Invalid/closed fd, EBADF, etc. — fail-safe: write nothing. Never surface the
    // fd contents or the error in any detail.
    return { outcome: "declined" };
  }
  // Strip exactly ONE trailing line ending; keep everything else (including a
  // second trailing blank line and any leading/interior spaces) verbatim.
  const stripped = raw.replace(/\r?\n$/, "");
  if (stripped.trim().length === 0) {
    return { outcome: "declined" };
  }
  return { outcome: "provided", passphrase: stripped };
}

/**
 * Alternate provider: read the passphrase from a file descriptor (stdin or an
 * inherited fd) instead of the environment — the hardened transport for headless
 * hosts (see the SECURITY note on {@link envPassphraseProvider}).
 *
 * CRITICAL — an fd is a SINGLE-READ stream: `readFileSync(fd)` reads from the
 * current offset to EOF and does not rewind, so a second read yields `""`. This
 * provider therefore reads the fd AT MOST ONCE and memoizes the resulting
 * {@link PassphraseResponse} in the returned closure. Every subsequent invocation —
 * a retry after a wrong passphrase within one store, or a second store sharing this
 * one instance — returns the captured response WITHOUT re-reading the now-EOF fd.
 * Total: never throws.
 *
 * Trade-off: memoizing keeps the passphrase resident in this closure for the
 * provider's lifetime (in the app, the whole `startCore`) — a necessary,
 * larger retention surface than the per-call env read, but the same lifetime as
 * the derived keys already held by the open stores. It is never written or logged.
 */
export function fdPassphraseProvider(
  fd: number,
  readFd: FdReader = defaultReadFd,
): PassphraseProvider {
  let cached: PassphraseResponse | undefined;
  return (_ctx: PassphraseContext): PassphraseResponse =>
    (cached ??= readOnce(fd, readFd));
}

/**
 * True when an operator has already opted into an explicit passphrase transport —
 * `QS_PASSPHRASE` non-blank, OR `QS_PASSPHRASE_FD` present-and-non-blank (its
 * NUMERIC validity is {@link resolvePassphraseProvider}'s concern, not this
 * predicate's: a malformed fd value still counts as "an operator chose a
 * transport", so the Story 11.6 pre-flight must NOT layer an interactive prompt on
 * top of it as a third silent fallback — see the malformed-fd handling below).
 * Mirrors {@link resolvePassphraseProvider}'s precedence exactly; pure and total.
 */
export function hasPassphraseTransport(
  env: Record<string, string | undefined>,
): boolean {
  const rawFd = env[PASSPHRASE_FD_ENV_VAR];
  if (rawFd !== undefined && rawFd.trim().length > 0) return true;
  const rawPassphrase = env[PASSPHRASE_ENV_VAR];
  return rawPassphrase !== undefined && rawPassphrase.trim().length > 0;
}

/**
 * A pre-resolved {@link PassphraseProvider}: ignores `ctx` entirely and always
 * answers `provided` with the captured `passphrase`. This is how the Story 11.6
 * interactive pre-flight (`first-run-setup.ts`) hands `startCore` an answer that
 * was already obtained asynchronously BEFORE the Core boots, without making the
 * `PassphraseProvider` seam itself async. The passphrase lives only in this
 * closure — never logged, never placed in `process.env`.
 */
export function staticPassphraseProvider(passphrase: string): PassphraseProvider {
  return (_ctx: PassphraseContext): PassphraseResponse => ({
    outcome: "provided",
    passphrase,
  });
}

/**
 * Select the passphrase transport from the environment. `QS_PASSPHRASE_FD` absent or
 * blank (trim-empty) → {@link envPassphraseProvider} (today's behavior, byte-for-
 * byte). Present + a valid non-negative integer (`/^\d+$/`) → {@link fdPassphraseProvider}.
 * Present but malformed (non-integer, negative, decimal, hex, exponent, signed) → a
 * declining provider that MUST NOT fall back to reading `QS_PASSPHRASE`: the operator
 * explicitly opted out of the env transport, so silently reading it would defeat the
 * hardening. Total: never throws.
 */
export function resolvePassphraseProvider(
  env: Record<string, string | undefined>,
  readFd: FdReader = defaultReadFd,
): PassphraseProvider {
  const rawFd = env[PASSPHRASE_FD_ENV_VAR];
  // Absent or blank → today's env transport, unchanged.
  if (rawFd === undefined || rawFd.trim().length === 0) {
    return envPassphraseProvider(env);
  }
  const trimmed = rawFd.trim();
  if (/^\d+$/.test(trimmed)) {
    return fdPassphraseProvider(Number(trimmed), readFd);
  }
  // Present but malformed: the operator opted out of `QS_PASSPHRASE`, so decline
  // rather than silently fall back to the env secret.
  return () => ({ outcome: "declined" });
}
