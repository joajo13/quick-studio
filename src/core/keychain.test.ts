/**
 * Repeatable, self-cleaning smoke for the Ring-1 keychain wrapper (Story 2.1 /
 * AR-20). It proves the round-trip on a platform WITH a working OS keychain, and
 * proves the wrapper degrades to a typed `unavailable` result (never an unhandled
 * throw, never plaintext) on a platform WITHOUT one. Both outcomes are green:
 * "unavailable" is a first-class, expected result, not a failure — it is exactly
 * the signal Story 2.3's passphrase fallback keys off.
 *
 * Isolation: a run-unique service/account keeps concurrent runs from colliding,
 * and an unconditional `afterAll` delete guarantees no residual keychain entry.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  deleteSecret,
  formatErrorDetail,
  getSecret,
  isNotFoundError,
  setSecret,
  type KeychainGetResult,
} from "./keychain.ts";

// Dedicated, never-a-real-credential test identity. The random suffix makes the
// smoke self-isolating (no cross-run residue) and repeatable.
const SERVICE = "quick-studio-spike-test";
const ACCOUNT = `smoke-${crypto.randomUUID()}`;
const SECRET = `probe-value-${crypto.randomUUID()}`;

/** Every wrapper result must carry one of these discriminants — never a throw. */
const SET_OUTCOMES = ["stored", "unavailable"] as const;
const GET_OUTCOMES = ["found", "not-found", "unavailable"] as const;
const DELETE_OUTCOMES = ["deleted", "not-found", "unavailable"] as const;

// Belt-and-suspenders: even if an assertion fails mid-test, remove the entry.
afterAll(() => {
  deleteSecret(SERVICE, ACCOUNT);
});

describe("keychain wrapper — typed, never-throwing surface", () => {
  // Table of operations that must each return a typed result rather than throw,
  // whatever the platform's backend state is.
  const operations: ReadonlyArray<{
    readonly name: string;
    readonly run: () => { readonly outcome: string };
    readonly allowed: ReadonlyArray<string>;
  }> = [
    { name: "setSecret", run: () => setSecret(SERVICE, ACCOUNT, SECRET), allowed: SET_OUTCOMES },
    { name: "getSecret", run: () => getSecret(SERVICE, ACCOUNT), allowed: GET_OUTCOMES },
    { name: "deleteSecret", run: () => deleteSecret(SERVICE, ACCOUNT), allowed: DELETE_OUTCOMES },
  ];

  for (const op of operations) {
    test(`${op.name} returns a typed outcome and never throws`, () => {
      let result: { readonly outcome: string } | undefined;
      expect(() => {
        result = op.run();
      }).not.toThrow();
      expect(result).toBeDefined();
      expect(op.allowed).toContain(result!.outcome);
    });
  }
});

describe("keychain wrapper — round-trip OR unavailable (both green)", () => {
  test("stores, retrieves, and deletes a secret when the backend is available", () => {
    const set = setSecret(SERVICE, ACCOUNT, SECRET);

    if (set.outcome === "unavailable") {
      // First-class expected outcome on a keychain-less box (headless Linux /
      // WSL without Secret Service). Validate the shape and stop — do NOT assert
      // a hard round-trip that would fail on a CI leg with no keychain.
      expect(typeof set.detail).toBe("string");
      expect(set.detail.length).toBeGreaterThan(0);
      // A secret must never leak into a diagnostic detail.
      expect(set.detail).not.toContain(SECRET);
      return;
    }

    expect(set.outcome).toBe("stored");

    const got = getSecret(SERVICE, ACCOUNT);
    expect(got.outcome).toBe("found");
    expect((got as Extract<KeychainGetResult, { outcome: "found" }>).value).toBe(SECRET);

    const del = deleteSecret(SERVICE, ACCOUNT);
    expect(del.outcome).toBe("deleted");

    // After delete, the entry is gone — a null-ish not-found, not a throw.
    const gone = getSecret(SERVICE, ACCOUNT);
    expect(gone.outcome).toBe("not-found");
  });

  test("reports not-found (or unavailable) for an entry that was never stored", () => {
    const neverStored = `absent-${crypto.randomUUID()}`;
    const got = getSecret(SERVICE, neverStored);
    // not-found on a working backend; unavailable on a keychain-less one. Both
    // are typed, non-throwing outcomes.
    expect(["not-found", "unavailable"]).toContain(got.outcome);
    if (got.outcome === "unavailable") {
      expect(got.detail.length).toBeGreaterThan(0);
    }
  });

  test("deleting an absent entry is a no-op typed result, not a throw", () => {
    const neverStored = `absent-${crypto.randomUUID()}`;
    const del = deleteSecret(SERVICE, neverStored);
    expect(["not-found", "unavailable"]).toContain(del.outcome);
  });
});

describe("error classification — the not-found vs unavailable linchpin", () => {
  // A thrown NoEntry-style error must map to not-found; anything else must fall
  // through to unavailable (the fail-safe direction that triggers Story 2.3's
  // passphrase fallback rather than masquerading as an empty entry). This is the
  // branch a working backend's null-return path never exercises.
  const notFoundMessages = [
    "No matching entry found in secure storage",
    "no entry",
    "Element not found.", // Windows Credential Manager wording
    "NOT FOUND", // case-insensitive
  ];
  for (const msg of notFoundMessages) {
    test(`classifies "${msg}" as not-found`, () => {
      expect(isNotFoundError(new Error(msg))).toBe(true);
    });
  }

  const unavailableMessages = [
    "Failed to connect to the D-Bus session bus",
    "The name org.freedesktop.secrets was not provided",
    "Platform secure storage failure",
    "", // empty / unknown → must fail safe to unavailable
  ];
  for (const msg of unavailableMessages) {
    test(`classifies "${msg}" as unavailable (not not-found)`, () => {
      expect(isNotFoundError(new Error(msg))).toBe(false);
    });
  }
});

describe("formatErrorDetail — single-line, bounded, secret-free", () => {
  test("collapses whitespace into a single tidy line", () => {
    expect(formatErrorDetail(new Error("line one\n  line two\t\tend"))).toBe(
      "line one line two end",
    );
  });

  test("redacts a verbatim secret echoed back by a native error", () => {
    const secret = "s3cr3t-value-xyz";
    const detail = formatErrorDetail(
      new Error(`keyring set failed for value ${secret} on backend`),
      secret,
    );
    expect(detail).not.toContain(secret);
    expect(detail).toContain("***");
  });

  test("redacts a whitespace-bearing secret echoed verbatim, despite line-collapsing", () => {
    // A secret with a newline/tab would survive if redaction ran only AFTER the
    // whitespace collapse (the collapsed message no longer contains the verbatim
    // secret). This locks the redact-before-normalize order.
    const secret = "pass phrase\twith\nspaces";
    const detail = formatErrorDetail(
      new Error(`keyring set failed for value ${secret} on backend`),
      secret,
    );
    expect(detail).not.toContain("pass phrase");
    expect(detail).not.toContain("with");
    expect(detail).toContain("***");
  });

  test("bounds an overly long native error message", () => {
    const detail = formatErrorDetail(new Error("x".repeat(1000)));
    expect(detail.length).toBeLessThanOrEqual(201); // 200 chars + ellipsis
    expect(detail.endsWith("…")).toBe(true);
  });

  test("bounds by code point, not UTF-16 unit, for astral characters", () => {
    // "😀" is one code point but two UTF-16 units. The impl truncates by code
    // point (`[...raw].slice(0, MAX_DETAIL_LEN)`), so a 1000-emoji message must
    // bound to ≤200 code points (+ ellipsis) even though that is ~400 UTF-16
    // units. Asserting on `.length` alone (as the ASCII case does) would not
    // catch a regression back to UTF-16 slicing, which could split a surrogate.
    const detail = formatErrorDetail(new Error("😀".repeat(1000)));
    expect([...detail].length).toBeLessThanOrEqual(201); // 200 code points + ellipsis
    expect(detail.endsWith("…")).toBe(true);
    // No dangling half-surrogate at the cut: re-encoding round-trips cleanly.
    expect(detail).toBe(detail.normalize());
  });

  test("accepts a non-Error thrown value without throwing", () => {
    expect(formatErrorDetail("plain string failure")).toBe("plain string failure");
  });
});
