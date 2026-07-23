/**
 * Covers the interactive-prompt I/O matrix over FAKE `input`/`output`/
 * `createInterface` — never a real terminal:
 *  - non-TTY input → `declined:"non-tty"` with ZERO interface creations (no hang,
 *    no `createInterface` call at all);
 *  - a typed value → `provided`;
 *  - blank input → `declined:"empty"`;
 *  - `SIGINT` (Ctrl-C) and an unprompted `close` (Ctrl-D/EOF) → `declined:"aborted"`;
 *  - a throwing `createInterface` → `declined:"unsupported"`, terminal never touched;
 *  - `promptNewPassphrase` confirmation: matching → `provided`; a mismatch retried
 *    within the bound → eventually `provided` or, exhausted, `declined:"mismatch"`;
 *  - on EVERY path, `close()` was called EXACTLY once and no typed character was
 *    ever forwarded to `output` (only the label and — where applicable — a line
 *    ending are ever written).
 */

import { describe, expect, test } from "bun:test";
import {
  isInteractive,
  MAX_CONFIRM_ATTEMPTS,
  promptNewPassphrase,
  promptPassphrase,
  type PromptDeps,
  type PromptInput,
  type PromptInterface,
} from "./passphrase-prompt.ts";

/** One fake readline interface's controls, exposed to the test that drives it. */
type FakeControls = {
  readonly iface: PromptInterface;
  readonly calls: { question: number; close: number };
  /** Invoke the pending `question` callback with `value` (simulates Enter). */
  readonly answer: (value: string) => void;
  /** Fire the `SIGINT` listener (simulates Ctrl-C). */
  readonly sigint: () => void;
  /** Fire the `close` listener WITHOUT ever answering (simulates Ctrl-D/EOF). */
  readonly eof: () => void;
  /** Invoke the CURRENT `_writeToOutput` (simulates a per-keystroke echo redraw). */
  readonly echo: (s: string) => void;
};

/**
 * `writeFn` mirrors the REAL default `_writeToOutput` — it writes straight to the
 * shared output (real Node readline's default writer is literally `rl.output.write`).
 * Production code overrides `_writeToOutput` AFTER `question()` has already used the
 * default one to write the label, so the label lands in the shared output exactly as
 * it would on a real terminal, and everything written through the override is
 * subject to the same shared sink — which is what lets the test assert "only the
 * label and line endings ever reach output" as one flat sequence.
 */
function makeFakeInterface(writeFn: (s: string) => void): FakeControls {
  const calls = { question: 0, close: 0 };
  let questionCb: ((answer: string) => void) | null = null;
  let sigintListener: (() => void) | null = null;
  let closeListener: (() => void) | null = null;

  const iface: PromptInterface = {
    question: (query, cb) => {
      calls.question++;
      questionCb = cb;
      // Real readline writes the prompt label via the (still-default) writer
      // BEFORE the caller gets a chance to override it — mirrored here.
      iface._writeToOutput?.(query);
    },
    close: () => {
      calls.close++;
    },
    on: (event, listener) => {
      if (event === "SIGINT") sigintListener = listener;
    },
    once: (event, listener) => {
      if (event === "close") closeListener = listener;
    },
    _writeToOutput: writeFn,
  };

  return {
    iface,
    calls,
    answer: (value) => questionCb?.(value),
    sigint: () => sigintListener?.(),
    eof: () => closeListener?.(),
    echo: (s) => iface._writeToOutput?.(s),
  };
}

/**
 * Test harness: a queue of fake interfaces, one per `createInterface` call.
 * `outputIsTTY` defaults to `true` (review fix: `isInteractive` now requires BOTH
 * `input` and `output` to be a TTY) so every existing test — which only varies
 * `input`'s TTY-ness — keeps prompting exactly as before; tests that specifically
 * exercise the non-TTY-output case pass `false`.
 */
function makeHarness(isTTY: boolean, outputIsTTY = true) {
  const queue: FakeControls[] = [];
  const input = { isTTY } as unknown as PromptInput;
  const outputWrites: string[] = [];
  const output = {
    write: (s: string) => outputWrites.push(String(s)),
    isTTY: outputIsTTY,
  } as unknown as NodeJS.WritableStream;
  let createCalls = 0;
  let throwOnCreate = false;

  const deps: PromptDeps = {
    input,
    output,
    createInterface: () => {
      createCalls++;
      if (throwOnCreate) throw new Error("readline unsupported on this platform");
      const controls = makeFakeInterface((s) => outputWrites.push(s));
      queue.push(controls);
      return controls.iface;
    },
  };

  return {
    deps,
    outputWrites,
    getCreateCalls: () => createCalls,
    setThrowOnCreate: (v: boolean) => {
      throwOnCreate = v;
    },
    /** Wait until the Nth `createInterface` call has happened, draining microtasks. */
    async next(): Promise<FakeControls> {
      for (let i = 0; i < 20 && queue.length === 0; i++) {
        await Promise.resolve();
      }
      const c = queue.shift();
      if (!c) throw new Error("createInterface was not called in time");
      return c;
    },
  };
}

describe("isInteractive", () => {
  test("input.isTTY === true, output.isTTY === true → true", () => {
    expect(
      isInteractive({
        input: { isTTY: true } as unknown as PromptInput,
        output: { isTTY: true } as unknown as NodeJS.WritableStream,
      }),
    ).toBe(true);
  });
  test("input.isTTY === false → false", () => {
    expect(
      isInteractive({
        input: { isTTY: false } as unknown as PromptInput,
        output: { isTTY: true } as unknown as NodeJS.WritableStream,
      }),
    ).toBe(false);
  });
  test("input.isTTY undefined (piped stream) → false", () => {
    expect(
      isInteractive({
        input: {} as unknown as PromptInput,
        output: { isTTY: true } as unknown as NodeJS.WritableStream,
      }),
    ).toBe(false);
  });
  // Review fix: `isInteractive` now requires BOTH sides to be a real TTY — a
  // redirected/piped output (e.g. `quick-studio --persistent 2>/dev/null`) must
  // not leave the process waiting on interactive input the user can never see was
  // requested.
  test("input.isTTY === true, output.isTTY === false → false", () => {
    expect(
      isInteractive({
        input: { isTTY: true } as unknown as PromptInput,
        output: { isTTY: false } as unknown as NodeJS.WritableStream,
      }),
    ).toBe(false);
  });
  test("input.isTTY === true, output.isTTY undefined → false", () => {
    expect(
      isInteractive({
        input: { isTTY: true } as unknown as PromptInput,
        output: {} as unknown as NodeJS.WritableStream,
      }),
    ).toBe(false);
  });
});

describe("promptPassphrase", () => {
  test("non-TTY input → declined:non-tty, zero interface creations", async () => {
    const h = makeHarness(false);
    const result = await promptPassphrase("Passphrase: ", h.deps);
    expect(result).toEqual({ outcome: "declined", reason: "non-tty" });
    expect(h.getCreateCalls()).toBe(0);
  });

  // Review fix: `isInteractive` requires BOTH `input` and `output` to be a TTY —
  // a TTY input with a redirected/non-TTY output must decline exactly like a
  // non-TTY input, never silently prompting into a sink the user cannot see.
  test("TTY input, non-TTY output → declined:non-tty, zero interface creations", async () => {
    const h = makeHarness(true, false);
    const result = await promptPassphrase("Passphrase: ", h.deps);
    expect(result).toEqual({ outcome: "declined", reason: "non-tty" });
    expect(h.getCreateCalls()).toBe(0);
  });

  test("typed value → provided", async () => {
    const h = makeHarness(true);
    const resultPromise = promptPassphrase("Passphrase: ", h.deps);
    const c = await h.next();
    c.answer("hunter2");
    const result = await resultPromise;
    expect(result).toEqual({ outcome: "provided", passphrase: "hunter2" });
    expect(c.calls.close).toBe(1);
  });

  test("blank/whitespace-only input → declined:empty", async () => {
    const h = makeHarness(true);
    const resultPromise = promptPassphrase("Passphrase: ", h.deps);
    const c = await h.next();
    c.answer("   ");
    const result = await resultPromise;
    expect(result).toEqual({ outcome: "declined", reason: "empty" });
    expect(c.calls.close).toBe(1);
  });

  test("SIGINT (Ctrl-C) → declined:aborted, close() called exactly once", async () => {
    const h = makeHarness(true);
    const resultPromise = promptPassphrase("Passphrase: ", h.deps);
    const c = await h.next();
    c.sigint();
    const result = await resultPromise;
    expect(result).toEqual({ outcome: "declined", reason: "aborted" });
    expect(c.calls.close).toBe(1);
  });

  test("unprompted close (Ctrl-D/EOF) → declined:aborted", async () => {
    const h = makeHarness(true);
    const resultPromise = promptPassphrase("Passphrase: ", h.deps);
    const c = await h.next();
    c.eof();
    const result = await resultPromise;
    expect(result).toEqual({ outcome: "declined", reason: "aborted" });
  });

  test("a throwing createInterface → declined:unsupported, terminal never touched", async () => {
    const h = makeHarness(true);
    h.setThrowOnCreate(true);
    const result = await promptPassphrase("Passphrase: ", h.deps);
    expect(result).toEqual({ outcome: "declined", reason: "unsupported" });
    // No fake interface was ever produced — nothing to close, nothing written.
    expect(h.outputWrites).toEqual([]);
  });

  // Review fix: `deps.output.write` can throw (EPIPE / a closed stdout) from
  // inside readline's internal write path; the mute override must swallow that so
  // the prompt still settles instead of hanging the boot forever.
  test("output.write throws on the line-ending echo → prompt still settles normally", async () => {
    const h = makeHarness(true);
    const throwingOutput = {
      isTTY: true,
      write: () => {
        throw new Error("EPIPE: broken pipe");
      },
    } as unknown as NodeJS.WritableStream;
    const deps: PromptDeps = { ...h.deps, output: throwingOutput };
    const resultPromise = promptPassphrase("Passphrase: ", deps);
    const c = await h.next();
    // Simulate the line-ending echo redraw a real terminal would trigger on
    // Enter — this is exactly where the override calls `deps.output.write`.
    c.echo("\n");
    c.answer("hunter2");
    const result = await resultPromise;
    expect(result).toEqual({ outcome: "provided", passphrase: "hunter2" });
    expect(c.calls.close).toBe(1);
  });

  // Review fix: `readline.Interface` with `terminal: true` flips raw mode on
  // INSIDE its constructor — a throw after that point must not leave the terminal
  // stuck in raw mode with nothing to restore it.
  test("createInterface throws → best-effort setRawMode(false) is attempted on input", async () => {
    const h = makeHarness(true);
    h.setThrowOnCreate(true);
    const setRawModeCalls: boolean[] = [];
    const inputWithRawMode = {
      isTTY: true,
      setRawMode: (mode: boolean) => setRawModeCalls.push(mode),
    } as unknown as PromptInput;
    const deps: PromptDeps = { ...h.deps, input: inputWithRawMode };
    const result = await promptPassphrase("Passphrase: ", deps);
    expect(result).toEqual({ outcome: "declined", reason: "unsupported" });
    expect(setRawModeCalls).toEqual([false]);
  });

  test("no typed character is ever forwarded to output — only the label and line endings", async () => {
    const h = makeHarness(true);
    const resultPromise = promptPassphrase("Passphrase: ", h.deps);
    const c = await h.next();
    // Simulate the per-keystroke echo redraws a real terminal would trigger.
    c.echo("x");
    c.echo("xy");
    c.echo("xyz");
    c.echo("\n");
    c.answer("xyz-secret");
    await resultPromise;
    // Only the label (written BEFORE the mute override took effect) and the one
    // preserved line ending ever reach output — every keystroke redraw in between
    // was swallowed, and the answer itself is delivered out-of-band via the
    // callback, never through `_writeToOutput`.
    expect(h.outputWrites).toEqual(["Passphrase: ", "\n"]);
    expect(h.outputWrites.join("")).not.toContain("x");
    expect(h.outputWrites.join("")).not.toContain("xyz");
    expect(h.outputWrites.join("")).not.toContain("secret");
  });
});

describe("promptNewPassphrase", () => {
  test("matching confirmation → provided, exactly two prompts", async () => {
    const h = makeHarness(true);
    const resultPromise = promptNewPassphrase(h.deps);
    const first = await h.next();
    first.answer("correct-horse");
    const second = await h.next();
    second.answer("correct-horse");
    const result = await resultPromise;
    expect(result).toEqual({ outcome: "provided", passphrase: "correct-horse" });
    expect(first.calls.close).toBe(1);
    expect(second.calls.close).toBe(1);
  });

  test("non-TTY input → declined:non-tty, zero interface creations", async () => {
    const h = makeHarness(false);
    const result = await promptNewPassphrase(h.deps);
    expect(result).toEqual({ outcome: "declined", reason: "non-tty" });
    expect(h.getCreateCalls()).toBe(0);
  });

  // Review fix: same both-sides-TTY requirement as promptPassphrase above.
  test("TTY input, non-TTY output → declined:non-tty, zero interface creations", async () => {
    const h = makeHarness(true, false);
    const result = await promptNewPassphrase(h.deps);
    expect(result).toEqual({ outcome: "declined", reason: "non-tty" });
    expect(h.getCreateCalls()).toBe(0);
  });

  test("blank first entry → declined:empty without ever asking for confirmation", async () => {
    const h = makeHarness(true);
    const resultPromise = promptNewPassphrase(h.deps);
    const first = await h.next();
    first.answer("");
    const result = await resultPromise;
    expect(result).toEqual({ outcome: "declined", reason: "empty" });
    expect(h.getCreateCalls()).toBe(1);
  });

  test("one mismatch then a matching pair → provided, within the retry budget", async () => {
    const h = makeHarness(true);
    const resultPromise = promptNewPassphrase(h.deps);

    const round1First = await h.next();
    round1First.answer("secret-a");
    const round1Confirm = await h.next();
    round1Confirm.answer("secret-B-typo"); // mismatch → retry

    const round2First = await h.next();
    round2First.answer("secret-b");
    const round2Confirm = await h.next();
    round2Confirm.answer("secret-b");

    const result = await resultPromise;
    expect(result).toEqual({ outcome: "provided", passphrase: "secret-b" });
    expect(h.getCreateCalls()).toBe(4);
  });

  test(`${MAX_CONFIRM_ATTEMPTS} consecutive mismatches → declined:mismatch, bounded`, async () => {
    const h = makeHarness(true);
    const resultPromise = promptNewPassphrase(h.deps);

    for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt++) {
      const f = await h.next();
      f.answer(`pass-${attempt}`);
      const c = await h.next();
      c.answer(`different-${attempt}`);
    }

    const result = await resultPromise;
    expect(result).toEqual({ outcome: "declined", reason: "mismatch" });
    // Never a third createInterface call beyond the bound (2 per attempt).
    expect(h.getCreateCalls()).toBe(MAX_CONFIRM_ATTEMPTS * 2);
  });

  // Review fix: a mismatch now writes an explanatory line so the user can tell a
  // mismatch from a hang — asserted here to appear exactly once per mismatch and
  // to never contain either typed value.
  test("mismatch writes an explanatory line exactly once, containing neither typed value", async () => {
    const h = makeHarness(true);
    const resultPromise = promptNewPassphrase(h.deps);

    const first = await h.next();
    first.answer("secret-a");
    const confirm = await h.next();
    confirm.answer("secret-B-typo");

    const second1 = await h.next();
    second1.answer("secret-b");
    const second2 = await h.next();
    second2.answer("secret-b");

    await resultPromise;

    const mismatchLines = h.outputWrites.filter((s) =>
      s.includes("passphrases did not match"),
    );
    expect(mismatchLines).toEqual(["quick-studio: passphrases did not match, try again.\n"]);
    expect(h.outputWrites.join("")).not.toContain("secret-a");
    expect(h.outputWrites.join("")).not.toContain("secret-B-typo");
    expect(h.outputWrites.join("")).not.toContain("secret-b");
  });

  test("SIGINT during the confirmation read → declined:aborted", async () => {
    const h = makeHarness(true);
    const resultPromise = promptNewPassphrase(h.deps);
    const first = await h.next();
    first.answer("secret-a");
    const confirm = await h.next();
    confirm.sigint();
    const result = await resultPromise;
    expect(result).toEqual({ outcome: "declined", reason: "aborted" });
  });

  test("a throwing createInterface on the SECOND (confirm) read → declined:unsupported", async () => {
    const h = makeHarness(true);
    const resultPromise = promptNewPassphrase(h.deps);
    const first = await h.next();
    first.answer("secret-a");
    h.setThrowOnCreate(true);
    const result = await resultPromise;
    expect(result).toEqual({ outcome: "declined", reason: "unsupported" });
  });
});

/**
 * Review fix — echo suppression must fail CLOSED. Overriding `_writeToOutput` is
 * the only mute mechanism this module has; an interface that does not expose it
 * (another readline implementation, a shimmed `createInterface`, a future runtime)
 * previously slipped past a `typeof` guard and prompted with echo ON, putting the
 * passphrase in plaintext into the user's scrollback. The spec's Block-If #2 is
 * explicit that this is worse than not prompting at all, so the correct behavior is
 * `unsupported` — and it must be decided BEFORE any label is written.
 */
describe("readLineMuted — an interface with no _writeToOutput fails closed", () => {
  /** A fake interface deliberately missing the mute seam. */
  function makeUnmutableHarness() {
    const outputWrites: string[] = [];
    const calls = { question: 0, close: 0, create: 0 };
    const deps: PromptDeps = {
      input: { isTTY: true } as unknown as PromptInput,
      output: {
        write: (s: string) => outputWrites.push(String(s)),
        isTTY: true,
      } as unknown as NodeJS.WritableStream,
      createInterface: () => {
        calls.create++;
        const iface: PromptInterface = {
          question: (query) => {
            calls.question++;
            outputWrites.push(query);
          },
          close: () => {
            calls.close++;
          },
          on: () => {},
          once: () => {},
          // _writeToOutput deliberately absent.
        };
        return iface;
      },
    };
    return { deps, outputWrites, calls };
  }

  test("promptPassphrase → declined:unsupported, no label written, interface closed once", async () => {
    const h = makeUnmutableHarness();
    const result = await promptPassphrase("passphrase: ", h.deps);
    expect(result).toEqual({ outcome: "declined", reason: "unsupported" });
    expect(h.calls.create).toBe(1);
    // The guard runs BEFORE `question()` — nothing was asked and nothing was
    // written, so there is no window in which a keystroke could have been echoed.
    expect(h.calls.question).toBe(0);
    expect(h.outputWrites).toEqual([]);
    expect(h.calls.close).toBe(1);
  });

  test("promptNewPassphrase → declined:unsupported on the very first read", async () => {
    const h = makeUnmutableHarness();
    const result = await promptNewPassphrase(h.deps);
    expect(result).toEqual({ outcome: "declined", reason: "unsupported" });
    expect(h.calls.create).toBe(1);
    expect(h.calls.question).toBe(0);
    expect(h.outputWrites).toEqual([]);
  });
});

/**
 * Review fix — a failed advisory write must never abort the boot. `deps.output.write`
 * throwing (EPIPE / a closed stderr) on the mismatch notice used to reject the
 * promise, propagate out of `runFirstRunSetup`, and surface in `bin/` as
 * `first-run setup failed` + exit 1 for a purely cosmetic line.
 */
describe("promptNewPassphrase — a throwing output.write on the mismatch notice", () => {
  test("is swallowed; the retry still happens and the passphrase is returned", async () => {
    const queue: FakeControls[] = [];
    const deps: PromptDeps = {
      input: { isTTY: true } as unknown as PromptInput,
      output: {
        write: () => {
          throw new Error("EPIPE");
        },
        isTTY: true,
      } as unknown as NodeJS.WritableStream,
      createInterface: () => {
        // The interface's own label write is readline's business and is not routed
        // through this module's best-effort wrapper — only `deps.output.write` is,
        // which is what the mismatch notice below uses.
        const controls = makeFakeInterface(() => {});
        queue.push(controls);
        return controls.iface;
      },
    };
    const nextIface = async (): Promise<FakeControls> => {
      for (let i = 0; i < 20 && queue.length === 0; i++) await Promise.resolve();
      const c = queue.shift();
      if (!c) throw new Error("createInterface was not called in time");
      return c;
    };

    const resultPromise = promptNewPassphrase(deps);
    (await nextIface()).answer("secret-a");
    (await nextIface()).answer("mismatch");
    // The mismatch notice threw here; the loop must have survived it and re-asked.
    (await nextIface()).answer("secret-b");
    (await nextIface()).answer("secret-b");
    expect(await resultPromise).toEqual({ outcome: "provided", passphrase: "secret-b" });
  });
});
