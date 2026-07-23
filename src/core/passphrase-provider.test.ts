/**
 * Covers the default env passphrase provider (FR-5, AD-5): a set `QS_PASSPHRASE`
 * yields `provided`; unset/empty/whitespace yields `declined`. Uses a plain env
 * object per call so `process.env` is never touched — no leakage between tests.
 */

import { describe, expect, test } from "bun:test";
import {
  PASSPHRASE_ENV_VAR,
  PASSPHRASE_FD_ENV_VAR,
  envPassphraseProvider,
  fdPassphraseProvider,
  hasPassphraseTransport,
  resolvePassphraseProvider,
  staticPassphraseProvider,
  type FdReader,
  type PassphraseContext,
} from "./passphrase-provider.ts";

const CTX: PassphraseContext = { reason: "keychain-unavailable", isFirstRun: true };

/**
 * Build an {@link FdReader} that models REAL single-read fd semantics: it returns
 * `value` on the FIRST call and `""` on every subsequent call (a drained fd reads
 * EOF). Each stub owns a fresh counter, so re-reads across the SAME provider are what
 * exercise the memoization guarantee — a stub that returned `value` every time would
 * mask the single-read defect.
 */
function singleReadStub(value: string): FdReader {
  let n = 0;
  return (_fd: number) => (n++ === 0 ? value : "");
}

describe("passphrase-provider — envPassphraseProvider", () => {
  test("env var constant is QS_PASSPHRASE", () => {
    expect(PASSPHRASE_ENV_VAR).toBe("QS_PASSPHRASE");
  });

  test("QS_PASSPHRASE set → provided with the exact value", () => {
    const provider = envPassphraseProvider({ QS_PASSPHRASE: "hunter2" });
    const r = provider(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe("hunter2");
  });

  test("QS_PASSPHRASE unset → declined", () => {
    expect(envPassphraseProvider({})(CTX).outcome).toBe("declined");
  });

  test("QS_PASSPHRASE empty → declined", () => {
    expect(envPassphraseProvider({ QS_PASSPHRASE: "" })(CTX).outcome).toBe("declined");
  });

  test("QS_PASSPHRASE whitespace-only → declined", () => {
    for (const ws of ["   ", "\t", "\n"]) {
      expect(envPassphraseProvider({ QS_PASSPHRASE: ws })(CTX).outcome).toBe("declined");
    }
  });

  test("a non-blank passphrase with surrounding spaces is kept verbatim", () => {
    const r = envPassphraseProvider({ QS_PASSPHRASE: " pw " })(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe(" pw ");
  });
});

describe("passphrase-provider — fdPassphraseProvider", () => {
  test("fd env var constant is QS_PASSPHRASE_FD", () => {
    expect(PASSPHRASE_FD_ENV_VAR).toBe("QS_PASSPHRASE_FD");
  });

  test("fd holds a passphrase → provided with one trailing newline stripped", () => {
    const r = fdPassphraseProvider(3, singleReadStub("hunter2\n"))(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe("hunter2");
  });

  test("no trailing newline → provided with the exact value", () => {
    const r = fdPassphraseProvider(3, singleReadStub("hunter2"))(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe("hunter2");
  });

  test("CRLF trailing line ending is stripped", () => {
    const r = fdPassphraseProvider(3, singleReadStub("hunter2\r\n"))(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe("hunter2");
  });

  test("interior and leading spaces are preserved; only the terminal newline is stripped", () => {
    const r = fdPassphraseProvider(3, singleReadStub(" pw \n"))(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe(" pw ");
  });

  test("exactly ONE trailing newline is stripped — a second blank line is kept", () => {
    const r = fdPassphraseProvider(3, singleReadStub("pw\n\n"))(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe("pw\n");
  });

  test("fd holds only a newline → declined", () => {
    expect(fdPassphraseProvider(3, singleReadStub("\n"))(CTX).outcome).toBe("declined");
  });

  test("fd empty / EOF → declined", () => {
    expect(fdPassphraseProvider(3, singleReadStub(""))(CTX).outcome).toBe("declined");
  });

  test("fd whitespace-only → declined", () => {
    expect(fdPassphraseProvider(3, singleReadStub("   "))(CTX).outcome).toBe("declined");
  });

  test("reader throws (EBADF / closed fd) → declined, never throws", () => {
    const throwing: FdReader = () => {
      throw new Error("EBADF: bad file descriptor");
    };
    expect(fdPassphraseProvider(3, throwing)(CTX).outcome).toBe("declined");
  });

  test("MEMOIZED: fd is read at most once — 2nd and 3rd calls still return the passphrase", () => {
    // The stub yields the passphrase ONCE then `""` (a drained fd). A re-reading
    // provider would decline on the 2nd call (the two-store / retry defect); a
    // memoizing one returns the captured passphrase every time.
    const provider = fdPassphraseProvider(3, singleReadStub("hunter2\n"));
    for (let i = 0; i < 3; i++) {
      const r = provider(CTX);
      expect(r.outcome).toBe("provided");
      if (r.outcome !== "provided") return;
      expect(r.passphrase).toBe("hunter2");
    }
  });

  test("MEMOIZED: a declined first read stays declined without re-reading", () => {
    // Even the `declined` outcome is cached — a second read of a drained fd must not
    // flip a decline into anything else.
    let calls = 0;
    const reader: FdReader = (_fd) => {
      calls++;
      return "";
    };
    const provider = fdPassphraseProvider(3, reader);
    expect(provider(CTX).outcome).toBe("declined");
    expect(provider(CTX).outcome).toBe("declined");
    expect(calls).toBe(1);
  });

  test("LAZY: constructing the provider does not read the fd; the read defers to first call", () => {
    // The read must be lazy so a provider built at `startCore` (regardless of run
    // mode) never drains stdin/an fd until a store actually opens.
    let calls = 0;
    const reader: FdReader = (_fd) => {
      calls++;
      return "hunter2\n";
    };
    const provider = fdPassphraseProvider(0, reader);
    expect(calls).toBe(0); // not read at construction
    const r = provider(CTX);
    expect(calls).toBe(1); // read on first invocation
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe("hunter2");
  });

  test("result never leaks the fd number or reader internals", () => {
    const r = fdPassphraseProvider(3, singleReadStub("hunter2\n"))(CTX);
    // The provided arm carries ONLY the passphrase — no fd, no detail field.
    expect(JSON.stringify(r)).toBe(JSON.stringify({ outcome: "provided", passphrase: "hunter2" }));
  });
});

describe("passphrase-provider — resolvePassphraseProvider", () => {
  test("QS_PASSPHRASE_FD unset → env provider (reads QS_PASSPHRASE)", () => {
    const provider = resolvePassphraseProvider(
      { QS_PASSPHRASE: "fromenv" },
      singleReadStub("fromfd\n"),
    );
    const r = provider(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe("fromenv");
  });

  test("QS_PASSPHRASE_FD blank/whitespace → env provider (unchanged behavior)", () => {
    for (const blank of ["", "   ", "\t"]) {
      const provider = resolvePassphraseProvider(
        { QS_PASSPHRASE_FD: blank, QS_PASSPHRASE: "fromenv" },
        singleReadStub("fromfd\n"),
      );
      const r = provider(CTX);
      expect(r.outcome).toBe("provided");
      if (r.outcome !== "provided") return;
      expect(r.passphrase).toBe("fromenv");
    }
  });

  test("valid fd → fd provider; QS_PASSPHRASE is IGNORED", () => {
    const provider = resolvePassphraseProvider(
      { QS_PASSPHRASE_FD: "3", QS_PASSPHRASE: "fromenv" },
      singleReadStub("fromfd\n"),
    );
    const r = provider(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe("fromfd");
  });

  test('fd "0" (stdin) is a valid fd', () => {
    const provider = resolvePassphraseProvider(
      { QS_PASSPHRASE_FD: "0" },
      singleReadStub("fromstdin\n"),
    );
    const r = provider(CTX);
    expect(r.outcome).toBe("provided");
    if (r.outcome !== "provided") return;
    expect(r.passphrase).toBe("fromstdin");
  });

  test("resolved fd provider is itself memoized (single read shared across calls)", () => {
    const provider = resolvePassphraseProvider(
      { QS_PASSPHRASE_FD: "3" },
      singleReadStub("fromfd\n"),
    );
    for (let i = 0; i < 3; i++) {
      const r = provider(CTX);
      expect(r.outcome).toBe("provided");
      if (r.outcome !== "provided") return;
      expect(r.passphrase).toBe("fromfd");
    }
  });

  test("malformed fd → declined WITHOUT reading QS_PASSPHRASE", () => {
    for (const bad of ["abc", "-1", "3.5", "0x3", "1e2", "+3"]) {
      // A reader that throws if invoked proves the fd is never read; QS_PASSPHRASE is
      // set to prove the env transport is NOT used as a silent fallback.
      const reader: FdReader = () => {
        throw new Error("must not read fd for malformed value");
      };
      const provider = resolvePassphraseProvider(
        { QS_PASSPHRASE_FD: bad, QS_PASSPHRASE: "fromenv" },
        reader,
      );
      expect(provider(CTX).outcome).toBe("declined");
    }
  });
});

/**
 * Review fix: `hasPassphraseTransport` and `staticPassphraseProvider` are Story
 * 11.6 exports with no direct coverage before this — they were only exercised
 * indirectly through mocks in `first-run-setup.test.ts`. This block covers both
 * directly.
 */
describe("passphrase-provider — hasPassphraseTransport", () => {
  const cases: Array<[string, Record<string, string | undefined>, boolean]> = [
    ["both unset", {}, false],
    ["QS_PASSPHRASE non-blank", { QS_PASSPHRASE: "hunter2" }, true],
    ["QS_PASSPHRASE blank (empty string)", { QS_PASSPHRASE: "" }, false],
    ["QS_PASSPHRASE whitespace-only", { QS_PASSPHRASE: "   " }, false],
    ["QS_PASSPHRASE_FD valid", { QS_PASSPHRASE_FD: "3" }, true],
    ["QS_PASSPHRASE_FD malformed ('abc')", { QS_PASSPHRASE_FD: "abc" }, true],
    ["QS_PASSPHRASE_FD blank (empty string)", { QS_PASSPHRASE_FD: "" }, false],
    ["QS_PASSPHRASE_FD whitespace-only", { QS_PASSPHRASE_FD: "   " }, false],
    ["both set", { QS_PASSPHRASE: "hunter2", QS_PASSPHRASE_FD: "3" }, true],
  ];
  for (const [description, env, expected] of cases) {
    test(`${description} → ${expected}`, () => {
      expect(hasPassphraseTransport(env)).toBe(expected);
    });
  }
});

describe("passphrase-provider — staticPassphraseProvider", () => {
  test("returns the exact passphrase regardless of ctx.isFirstRun (true)", () => {
    const provider = staticPassphraseProvider("captured-pass");
    const r = provider({ reason: "keychain-unavailable", isFirstRun: true });
    expect(r).toEqual({ outcome: "provided", passphrase: "captured-pass" });
  });

  test("returns the exact passphrase regardless of ctx.isFirstRun (false)", () => {
    const provider = staticPassphraseProvider("captured-pass");
    const r = provider({ reason: "keychain-unavailable", isFirstRun: false });
    expect(r).toEqual({ outcome: "provided", passphrase: "captured-pass" });
  });

  test("stable across repeated calls with the same instance", () => {
    const provider = staticPassphraseProvider("captured-pass");
    for (let i = 0; i < 3; i++) {
      expect(provider(CTX)).toEqual({ outcome: "provided", passphrase: "captured-pass" });
    }
  });
});
