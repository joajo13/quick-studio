/**
 * quick-studio Core — interactive passphrase prompt (Story 11.6).
 *
 * The terminal half of the first-run setup flow: reads a passphrase from the
 * user with echo suppressed, never from a non-interactive stdin, and never
 * leaves the terminal in a broken (echo-off) state on ANY exit path — success,
 * blank input, a mismatched confirmation, an exhausted retry budget, `Ctrl-C`,
 * `Ctrl-D`, or an unexpected throw from the readline layer itself.
 *
 * Fully dependency-injected (`input`, `output`, `createInterface`) so it is unit-
 * tested with fake streams and a fake interface — this module NEVER touches a real
 * terminal in `bun test`. The default wraps `node:readline` with `terminal: true`:
 * on a real TTY that puts the interface in control of raw mode, line editing, EOF,
 * and SIGINT delivery, and echo suppression is then a `_writeToOutput` override —
 * the standard Node password-prompt recipe, at the line-discipline level, not a
 * hand-rolled raw-mode reimplementation (see spec-11-6 Design Notes, Block-If #2).
 *
 * The passphrase is NEVER echoed, logged, or written anywhere by this module — it
 * flows out only as the `passphrase` field of a `provided` {@link PromptResult}.
 */

import { createInterface as nodeCreateInterface } from "node:readline";

/** The narrow readline-interface surface this module needs — real or faked. */
export type PromptInterface = {
  readonly question: (query: string, callback: (answer: string) => void) => void;
  readonly close: () => void;
  readonly on: (event: "SIGINT", listener: () => void) => void;
  readonly once: (event: "close", listener: () => void) => void;
  /**
   * Node's readline internal output writer. Present on every real `Interface`
   * (it is how every keystroke is echoed back under `terminal: true`). Optional
   * only in the TYPE, so a hand-written fake can omit it — but overriding it is
   * the ONLY mute mechanism this module has, so {@link readLineMuted} refuses to
   * prompt at all when an interface does not expose it (fail CLOSED, never
   * unmuted — see the guard there).
   */
  _writeToOutput?: (stringToWrite: string) => void;
};

/** A readable stream with the `isTTY` flag `process.stdin` carries when interactive. */
export type PromptInput = NodeJS.ReadableStream & {
  readonly isTTY?: boolean;
  /**
   * Node's raw-mode toggle, present on a real TTY `input` stream. Optional here
   * because a test fake need not implement it. Review fix: used as a best-effort
   * restore if `createInterface` throws AFTER already flipping raw mode on — see
   * {@link readLineMuted}.
   */
  readonly setRawMode?: (mode: boolean) => void;
};

/**
 * A writable stream with the `isTTY` flag `process.stdout`/`process.stderr` carry
 * when interactive. Widened (review fix) so {@link isInteractive} can require BOTH
 * `input` and `output` to be a real TTY, not just `input`.
 */
export type PromptOutput = NodeJS.WritableStream & { readonly isTTY?: boolean };

/** Injected dependencies. Every field defaults to the real terminal. */
export type PromptDeps = {
  readonly input: PromptInput;
  readonly output: PromptOutput;
  readonly createInterface: (input: PromptInput, output: PromptOutput) => PromptInterface;
};

/**
 * The real terminal, wrapped behind {@link PromptInterface}. Review fix: `output`
 * is `process.stderr`, not `process.stdout` — every other pre-flight message goes
 * to stderr (stdout is reserved for requested output: `--help`, `--version`,
 * `update`), and piping stdout (`quick-studio --persistent > log.txt`) would
 * otherwise swallow the prompt label into the file, leaving the user facing an
 * apparently hung process.
 */
export const DEFAULT_PROMPT_DEPS: PromptDeps = {
  input: process.stdin,
  output: process.stderr,
  createInterface: (input, output) =>
    nodeCreateInterface({ input, output, terminal: true }) as unknown as PromptInterface,
};

/** Every reason a prompt can decline instead of returning a passphrase. */
export type PromptDeclineReason =
  | "non-tty"
  | "aborted"
  | "empty"
  | "mismatch"
  | "unsupported";

/** Outcome of a prompt: a passphrase, or a typed reason it declined. */
export type PromptResult =
  | { readonly outcome: "provided"; readonly passphrase: string }
  | { readonly outcome: "declined"; readonly reason: PromptDeclineReason };

/**
 * True only when BOTH `deps.input` and `deps.output` are a real TTY. Never prompts
 * otherwise. Review fix: previously checked `input` alone — with `output` now
 * defaulting to stderr, a caller can redirect stderr while stdin stays a real
 * terminal (`quick-studio --persistent 2>/dev/null`), and the prompt label would
 * then be silently discarded while still waiting on interactive input. Requiring
 * both sides to be a TTY keeps the label visible whenever the process is willing
 * to prompt.
 */
export function isInteractive(deps: Pick<PromptDeps, "input" | "output"> = DEFAULT_PROMPT_DEPS): boolean {
  return deps.input.isTTY === true && deps.output.isTTY === true;
}

/** Bounded confirmation-mismatch retry budget for {@link promptNewPassphrase}. */
export const MAX_CONFIRM_ATTEMPTS = 3;

/**
 * Write one advisory line, swallowing a failed write. Review fix: the EPIPE
 * hardening was previously applied only to the muted echo path, so a closed or
 * broken `output` still turned a purely cosmetic line into a thrown EPIPE that
 * propagated out of the prompt, out of `runFirstRunSetup`, and out to `bin/`'s
 * catch — reported as `first-run setup failed` and exit 1. Nothing this module
 * writes is load-bearing enough to abort a boot over.
 */
function writeBestEffort(output: PromptOutput, line: string): void {
  try {
    output.write(line);
  } catch {
    /* best-effort: a failed advisory write must never hang or abort the prompt. */
  }
}

/** One raw line read, before the empty/blank classification is applied. */
type RawLine =
  | { readonly kind: "line"; readonly value: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "unsupported" };

/**
 * Read exactly one line with echo suppressed. `deps.createInterface` throwing —
 * or returning an interface with no `_writeToOutput` to mute — is mapped to
 * `unsupported` before any label is written (Block-If #2's contained fallback:
 * degrade to today's env/fd behavior rather than prompt with echo ON).
 * `SIGINT` (Ctrl-C) and an unprompted `close` (Ctrl-D /
 * EOF before Enter) both map to `aborted`. The interface is closed EXACTLY ONCE on
 * every path via a settle latch, in addition to a `process.once("exit", …)` safety
 * close that is de-registered as soon as this read settles normally.
 */
function readLineMuted(label: string, deps: PromptDeps): Promise<RawLine> {
  return new Promise((resolve) => {
    let iface: PromptInterface;
    try {
      iface = deps.createInterface(deps.input, deps.output);
    } catch {
      // Review fix: `readline.Interface` with `terminal: true` calls
      // `input.setRawMode(true)` INSIDE its own constructor — a throw after that
      // point (e.g. a broken terminal driver) leaves raw mode on with nothing left
      // to restore it, which would violate the "echo restored on every exit path"
      // invariant this module promises. Best-effort restore before degrading to
      // the env/fd behavior; `setRawMode` itself must never be allowed to throw
      // out of this catch.
      try {
        deps.input.setRawMode?.(false);
      } catch {
        /* best-effort: restoring raw mode must never throw out of this path. */
      }
      resolve({ kind: "unsupported" });
      return;
    }

    // Review fix (fail CLOSED): overriding `_writeToOutput` is the ONLY echo
    // suppression this module has. Previously the override was installed behind a
    // `typeof === "function"` guard AFTER `question()` had already been issued, so
    // an interface that does not expose it — a different readline implementation, a
    // shimmed `createInterface`, a future Bun release — silently prompted UNMUTED
    // and echoed the passphrase in plaintext into the user's scrollback. The spec's
    // Block-If #2 is explicit that "a prompt that echoes a passphrase to the screen
    // is worse than no prompt at all" and that the correct fallback is to SKIP
    // prompting, so a missing writer now degrades to `unsupported` (i.e. today's
    // env/fd behavior) BEFORE any label is written or any key can be typed.
    if (typeof iface._writeToOutput !== "function") {
      try {
        iface.close();
      } catch {
        /* best-effort: close() must never throw out of this path. */
      }
      resolve({ kind: "unsupported" });
      return;
    }

    let settled = false;
    let closed = false;
    const doClose = (): void => {
      if (closed) return;
      closed = true;
      try {
        iface.close();
      } catch {
        /* best-effort: close() must never throw out of this path. */
      }
    };
    const exitHandler = (): void => doClose();
    process.once("exit", exitHandler);
    const settle = (result: RawLine): void => {
      if (settled) return;
      settled = true;
      process.removeListener("exit", exitHandler);
      resolve(result);
    };

    iface.on("SIGINT", () => {
      settle({ kind: "aborted" });
      doClose();
    });
    iface.once("close", () => {
      // A close that fires WITHOUT the question callback having settled first is
      // Ctrl-D/EOF (or any other unprompted close) — treat it the same as Ctrl-C.
      settle({ kind: "aborted" });
    });

    iface.question(label, (answer) => {
      settle({ kind: "line", value: answer });
      doClose();
    });
    // The label was just written via the interface's normal (unmuted) writer.
    // From this point on, every further write — i.e. every typed-character
    // echo — is swallowed. Line endings are preserved so a real terminal's
    // cursor still returns to column 0 without ever echoing a typed character.
    // The writer's existence was already proven by the fail-closed guard above.
    iface._writeToOutput = (stringToWrite: string) => {
      if (stringToWrite === "\r\n" || stringToWrite === "\n" || stringToWrite === "\r") {
        // Review fix: `deps.output.write` can throw (EPIPE / a closed stdout)
        // from inside readline's internal write path — uncaught, that would
        // escape this override and leave the settle promise unsettled (a hung
        // boot). Best-effort echo only; same defensive shape spec 11.5 already
        // applied to its stderr sink.
        writeBestEffort(deps.output, stringToWrite);
      }
      // else: swallowed — this is the echo suppression.
    };
  });
}

/**
 * Prompt once for a passphrase to UNLOCK an existing store (no confirmation). A
 * non-interactive `input` never prompts at all — zero interface creations — and
 * returns `declined:"non-tty"` immediately. Blank input is `declined:"empty"`.
 */
export async function promptPassphrase(
  label: string,
  deps: PromptDeps = DEFAULT_PROMPT_DEPS,
): Promise<PromptResult> {
  if (!isInteractive(deps)) {
    return { outcome: "declined", reason: "non-tty" };
  }
  const raw = await readLineMuted(label, deps);
  if (raw.kind === "unsupported") return { outcome: "declined", reason: "unsupported" };
  if (raw.kind === "aborted") return { outcome: "declined", reason: "aborted" };
  if (raw.value.trim().length === 0) return { outcome: "declined", reason: "empty" };
  return { outcome: "provided", passphrase: raw.value };
}

/**
 * Prompt for a passphrase to CREATE a new store: typed twice and compared, within
 * a bounded {@link MAX_CONFIRM_ATTEMPTS} mismatch-retry budget. A non-interactive
 * `input` never prompts. Blank first entry is `declined:"empty"`; the budget
 * exhausted on repeated mismatches is `declined:"mismatch"` — never an unbounded
 * retry loop.
 */
export async function promptNewPassphrase(
  deps: PromptDeps = DEFAULT_PROMPT_DEPS,
): Promise<PromptResult> {
  if (!isInteractive(deps)) {
    return { outcome: "declined", reason: "non-tty" };
  }
  for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt++) {
    const first = await readLineMuted("New passphrase: ", deps);
    if (first.kind === "unsupported") return { outcome: "declined", reason: "unsupported" };
    if (first.kind === "aborted") return { outcome: "declined", reason: "aborted" };
    if (first.value.trim().length === 0) return { outcome: "declined", reason: "empty" };

    const second = await readLineMuted("Confirm passphrase: ", deps);
    if (second.kind === "unsupported") return { outcome: "declined", reason: "unsupported" };
    if (second.kind === "aborted") return { outcome: "declined", reason: "aborted" };

    if (second.value === first.value) {
      return { outcome: "provided", passphrase: first.value };
    }
    // Review fix: previously re-prompted with identical copy and no explanation,
    // so the user had no way to distinguish a mismatch from a hang. One line to
    // `deps.output`, never echoing either typed value, before retrying within the
    // bounded budget.
    writeBestEffort(deps.output, "quick-studio: passphrases did not match, try again.\n");
  }
  return { outcome: "declined", reason: "mismatch" };
}
