/**
 * Covers `resolveSelfCheckMode`'s entire decision surface — three arms over a
 * one-variable input, so the table below is exhaustive by construction rather
 * than by sampling.
 *
 * The rows that matter are the ones that are NOT `keychain`: `"Keychain"` and
 * `" keychain "` prove that the exact match is deliberate (a lenient resolver
 * would quietly accept both and this file would be the only place that noticed),
 * and `"kaychain"` is the CI-typo row — an unknown value MUST resolve to
 * `unknown` so `bin/` can fail fast instead of falling through and booting the
 * Core on a runner, where the leg would report a `timeout-minutes` hang rather
 * than a one-character mistake.
 *
 * `formatSelfCheckValue` is covered here too: the resolver deliberately keeps the
 * offending value verbatim, so bounding it is the PRINTING site's job, and these
 * rows are what keep a value carrying newlines or ANSI from forging lines in a
 * public CI log.
 */

import { describe, expect, test } from "bun:test";
import {
  formatSelfCheckValue,
  resolveSelfCheckMode,
  type SelfCheckMode,
} from "./self-check.ts";

describe("resolveSelfCheckMode", () => {
  const rows: ReadonlyArray<{
    readonly name: string;
    readonly value: string | undefined;
    readonly expected: SelfCheckMode;
  }> = [
    { name: "unset", value: undefined, expected: { kind: "none" } },
    { name: "empty string", value: "", expected: { kind: "none" } },
    { name: "exactly 'keychain'", value: "keychain", expected: { kind: "keychain" } },
    {
      name: "'Keychain' (case-sensitive by design)",
      value: "Keychain",
      expected: { kind: "unknown", value: "Keychain" },
    },
    {
      name: "'kaychain' (the CI typo)",
      value: "kaychain",
      expected: { kind: "unknown", value: "kaychain" },
    },
    {
      name: "' keychain ' (untrimmed by design)",
      value: " keychain ",
      expected: { kind: "unknown", value: " keychain " },
    },
  ];

  for (const row of rows) {
    test(`${row.name} -> ${row.expected.kind}`, () => {
      expect(resolveSelfCheckMode({ QS_SELFCHECK: row.value })).toEqual(row.expected);
    });
  }

  test("a missing key and an explicit undefined are the same input", () => {
    // `process.env.QS_SELFCHECK` is `undefined` when unset, but a test double or
    // a spread env object can just as easily omit the key entirely.
    expect(resolveSelfCheckMode({})).toEqual({ kind: "none" });
  });

  test("the unknown arm echoes the offending value verbatim", () => {
    // The RESOLVER stays verbatim on purpose — it is the printing site, not this
    // one, that bounds the value (see `formatSelfCheckValue` below). Normalizing
    // here would also make `" keychain "` and `"keychain"` indistinguishable to a
    // caller trying to explain what was actually set.
    const mode = resolveSelfCheckMode({ QS_SELFCHECK: "keychain\n" });
    expect(mode).toEqual({ kind: "unknown", value: "keychain\n" });
  });
});

describe("formatSelfCheckValue", () => {
  // `bin/quick-studio.ts` echoes an unrecognized value into stderr, which on a
  // release leg is a public CI log. The value is arbitrary environment text, so
  // the printing site bounds it exactly the way `keychain.ts` bounds a `detail`.

  test("an ordinary value passes through unchanged", () => {
    expect(formatSelfCheckValue("kaychain")).toBe("kaychain");
  });

  test("newlines cannot forge a second log line", () => {
    const forged = "bogus\nquick-studio Core listening on http://attacker.example";
    const out = formatSelfCheckValue(forged);
    expect(out).not.toContain("\n");
    expect(out).toBe("bogus quick-studio Core listening on http://attacker.example");
  });

  test("carriage returns and tabs collapse too", () => {
    expect(formatSelfCheckValue("a\r\n\tb")).toBe("a b");
  });

  test("an ESC byte is neutralized so ANSI cannot repaint the log", () => {
    // `ESC[2J ESC[H` clears the screen and homes the cursor; reaching a terminal
    // verbatim it would erase whatever the operator was reading. ESC is not
    // whitespace, so the whitespace collapse alone would not have caught it.
    const out = formatSelfCheckValue("\u001b[2J\u001b[Hgone");
    expect(out).not.toContain("\u001b");
    expect(out).toBe("[2J [Hgone");
  });

  test("a long value is truncated by code point, with an ellipsis", () => {
    const out = formatSelfCheckValue("x".repeat(500));
    expect(out).toBe(`${"x".repeat(60)}…`);
  });

  test("truncation never splits an astral character in half", () => {
    // Slicing UTF-16 units would cut a surrogate pair and emit a lone half.
    const out = formatSelfCheckValue("😀".repeat(100));
    expect(out).toBe(`${"😀".repeat(60)}…`);
    expect(out).not.toContain("�");
  });

  test("a bidi override cannot reorder the rest of the log line", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE is not a control byte and not whitespace, so
    // neither the Cc class nor the whitespace collapse would catch it on its own.
    // Left in, it visually reverses everything the log prints AFTER the echoed
    // value — `(want: keychain)` included — which is log forgery without a single
    // newline. Same class as the ESC case above; the `Cf` half of the character
    // class is what covers it.
    const out = formatSelfCheckValue("bo\u202egus");
    expect(out).not.toContain("\u202e");
    expect(out).toBe("bo gus");
  });

  test("zero-width and isolate characters are neutralized too", () => {
    // U+200B ZWSP and U+2066 LEFT-TO-RIGHT ISOLATE render as nothing, so a value
    // could otherwise be echoed back looking IDENTICAL to a value it is not.
    const out = formatSelfCheckValue("key\u200bcha\u2066in");
    expect(out).not.toContain("\u200b");
    expect(out).not.toContain("\u2066");
    expect(out).toBe("key cha in");
  });

  test("a value made only of control characters collapses to the empty string", () => {
    // The message still names QS_SELFCHECK, so an empty echo is legible; what
    // matters is that nothing unprintable reaches the log. `bin/quick-studio.ts`
    // appends an explicit hint on this exact result, because a bare `''` echo
    // would not tell the operator that the value was whitespace rather than unset.
    expect(formatSelfCheckValue("\u0000\u001b\n\t")).toBe("");
  });
});
