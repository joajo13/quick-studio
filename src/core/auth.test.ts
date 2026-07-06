import { describe, expect, test } from "bun:test";
import { mintSessionToken, validateOrigin, validateToken } from "./auth.ts";

describe("mintSessionToken", () => {
  test("produces 256-bit (64 hex char) lowercase-hex tokens", () => {
    const t = mintSessionToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is fresh on every call (no repeats)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(mintSessionToken());
    expect(seen.size).toBe(100);
  });
});

describe("validateToken", () => {
  const current = mintSessionToken();

  test("accepts the exact current token", () => {
    expect(validateToken(current, current)).toBe(true);
  });

  test("rejects an absent token (null/undefined/blank)", () => {
    expect(validateToken(null, current)).toBe(false);
    expect(validateToken(undefined, current)).toBe(false);
    expect(validateToken("", current)).toBe(false);
  });

  test("rejects a foreign token", () => {
    expect(validateToken(mintSessionToken(), current)).toBe(false);
    expect(validateToken(current + "0", current)).toBe(false);
    expect(validateToken(current.slice(0, -1), current)).toBe(false);
  });
});

describe("validateOrigin", () => {
  const host = "127.0.0.1";
  const port = 4321;
  const authority = `${host}:${port}`;

  test("accepts absent Origin with matching Host", () => {
    expect(validateOrigin(null, authority, host, port)).toBe(true);
    expect(validateOrigin(undefined, authority, host, port)).toBe(true);
    expect(validateOrigin("", authority, host, port)).toBe(true);
  });

  test("accepts the exact loopback Origin with matching Host", () => {
    expect(validateOrigin(`http://${authority}`, authority, host, port)).toBe(true);
  });

  test("rejects a foreign Origin", () => {
    expect(validateOrigin("http://evil.example.com", authority, host, port)).toBe(false);
    expect(validateOrigin(`https://${authority}`, authority, host, port)).toBe(false);
  });

  test("treats localhost as a distinct (rejected) origin", () => {
    expect(validateOrigin(`http://localhost:${port}`, authority, host, port)).toBe(false);
    expect(validateOrigin(`http://${authority}`, `localhost:${port}`, host, port)).toBe(false);
  });

  test("rejects a foreign / mismatched Host", () => {
    expect(validateOrigin(null, "127.0.0.1:9999", host, port)).toBe(false);
    expect(validateOrigin(null, "evil.example.com", host, port)).toBe(false);
    expect(validateOrigin(null, null, host, port)).toBe(false);
  });
});
