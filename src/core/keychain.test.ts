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
 *
 * It also covers the identifier guard added for DW-13: `validateIdentifiers` and
 * the `invalid-argument` outcome that distinguishes a caller programming error
 * (missing/empty/blank `service`/`account`) from a backend-`unavailable` condition,
 * including the never-throws boundary for `null`/`undefined`/non-string inputs.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  deleteSecret,
  formatErrorDetail,
  getSecret,
  isNotFoundError,
  setSecret,
  validateIdentifiers,
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

describe("validateIdentifiers — pure, deterministic identifier guard", () => {
  const invalidCases: ReadonlyArray<{
    readonly label: string;
    readonly service: string;
    readonly account: string;
    readonly names: string;
  }> = [
    { label: "empty service", service: "", account: "acct", names: "service" },
    { label: "blank service", service: "   ", account: "acct", names: "service" },
    { label: "empty account", service: "svc", account: "", names: "account" },
    { label: "blank account", service: "svc", account: "   ", names: "account" },
  ];

  for (const c of invalidCases) {
    test(`returns a non-empty reason naming "${c.names}" for ${c.label}`, () => {
      const reason = validateIdentifiers(c.service, c.account);
      expect(typeof reason).toBe("string");
      expect(reason!.length).toBeGreaterThan(0);
      expect(reason).toContain(c.names);
    });
  }

  test("returns null for a valid non-blank (service, account) pair", () => {
    expect(validateIdentifiers(SERVICE, ACCOUNT)).toBeNull();
  });

  test("checks service before account when both are invalid", () => {
    expect(validateIdentifiers("", "")).toContain("service");
  });

  // The defensive boundary must survive an untyped caller (any/JS/IPC/JSON) that
  // slips a null/undefined/non-string past the `string` signature: the guard must
  // classify it (never let `.trim()` throw), upholding the never-throws contract.
  test("classifies null/undefined/non-string identifiers without ever throwing", () => {
    expect(() => validateIdentifiers(null as unknown as string, ACCOUNT)).not.toThrow();
    expect(validateIdentifiers(null as unknown as string, ACCOUNT)).toContain("service");
    expect(validateIdentifiers(undefined as unknown as string, ACCOUNT)).toContain("service");
    expect(validateIdentifiers(SERVICE, null as unknown as string)).toContain("account");
    expect(validateIdentifiers(SERVICE, undefined as unknown as string)).toContain("account");
    expect(validateIdentifiers(42 as unknown as string, ACCOUNT)).toContain("service");
    expect(validateIdentifiers(null as unknown as string, null as unknown as string)).toContain(
      "service",
    );
  });
});

describe("invalid-argument — surfaced programming error, distinct from unavailable", () => {
  // Each wrapper must reject an empty/blank service or account with a typed
  // `invalid-argument` result BEFORE touching the native store — never routing a
  // caller bug through the `unavailable` fail-safe.
  const wrappers: ReadonlyArray<{
    readonly name: string;
    readonly run: (service: string, account: string) => { readonly outcome: string; readonly detail?: string };
  }> = [
    { name: "setSecret", run: (s, a) => setSecret(s, a, SECRET) },
    { name: "getSecret", run: (s, a) => getSecret(s, a) },
    { name: "deleteSecret", run: (s, a) => deleteSecret(s, a) },
  ];

  const badIdentifierCases: ReadonlyArray<{
    readonly label: string;
    readonly service: string;
    readonly account: string;
  }> = [
    { label: "empty service", service: "", account: ACCOUNT },
    { label: "blank service", service: "   ", account: ACCOUNT },
    { label: "empty account", service: SERVICE, account: "" },
    { label: "blank account", service: SERVICE, account: "   " },
  ];

  for (const w of wrappers) {
    for (const c of badIdentifierCases) {
      test(`${w.name} yields invalid-argument for ${c.label}`, () => {
        const result = w.run(c.service, c.account);
        expect(result.outcome).toBe("invalid-argument");
        expect(typeof result.detail).toBe("string");
        expect(result.detail!.length).toBeGreaterThan(0);
      });
    }

    test(`${w.name} yields invalid-argument (never throws) for a null identifier`, () => {
      let result: { readonly outcome: string; readonly detail?: string } | undefined;
      expect(() => {
        result = w.run(null as unknown as string, ACCOUNT);
      }).not.toThrow();
      expect(result!.outcome).toBe("invalid-argument");
    });

    test(`${w.name} does NOT yield invalid-argument for a valid pair`, () => {
      const result = w.run(SERVICE, ACCOUNT);
      expect(result.outcome).not.toBe("invalid-argument");
    });
  }

  test("setSecret invalid-argument detail never contains the secret value", () => {
    const secret = `super-secret-${crypto.randomUUID()}`;
    const result = setSecret("", "acct", secret);
    expect(result.outcome).toBe("invalid-argument");
    if (result.outcome !== "invalid-argument") throw new Error("expected invalid-argument");
    expect(result.detail).not.toContain(secret);
  });
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
