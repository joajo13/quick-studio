import { describe, expect, test } from "bun:test";
import {
  deriveOpenUrl,
  isExposed,
  isLoopbackHost,
  isWildcardHost,
  resolveBindHost,
} from "./binding.ts";

describe("resolveBindHost", () => {
  test("defaults to 127.0.0.1 when unset/empty/whitespace", () => {
    expect(resolveBindHost(undefined)).toBe("127.0.0.1");
    expect(resolveBindHost("")).toBe("127.0.0.1");
    expect(resolveBindHost("   ")).toBe("127.0.0.1");
    expect(resolveBindHost("\t \n")).toBe("127.0.0.1");
  });

  test("trims surrounding whitespace off a real host", () => {
    expect(resolveBindHost("  0.0.0.0  ")).toBe("0.0.0.0");
    expect(resolveBindHost("localhost")).toBe("localhost");
    expect(resolveBindHost("192.168.1.10")).toBe("192.168.1.10");
  });

  test("lower-cases the host so the bound authority matches the browser Host", () => {
    // A browser sends a lower-cased `Host`, and `validateOrigin` compares it
    // verbatim against `${boundHost}:${port}`. Without this fold, a mixed-case
    // `QS_HOST=LocalHost` binds fine and classifies loopback (case-insensitive)
    // yet 403s every RPC. Resolution normalizes so all three paths agree.
    expect(resolveBindHost("LocalHost")).toBe("localhost");
    expect(resolveBindHost("  LOCALHOST  ")).toBe("localhost");
    expect(resolveBindHost("::1")).toBe("::1");
  });
});

describe("classification — loopback set (not exposed)", () => {
  for (const host of ["localhost", "::1", "127.0.0.1", "127.0.0.2"]) {
    test(`${host} is loopback, not exposed, not wildcard`, () => {
      expect(isLoopbackHost(host)).toBe(true);
      expect(isExposed(host)).toBe(false);
      expect(isWildcardHost(host)).toBe(false);
    });
  }
});

describe("classification — 127.-prefixed lookalikes are NOT loopback (exposed)", () => {
  // A hostname that merely starts with `127.` is not a loopback IPv4 address;
  // it must be classified exposed so its Port-Exposure Warning still fires.
  for (const host of ["127.attacker.example", "127.0.0.1.evil.com", "1270.0.0.1", "127."]) {
    test(`${host} is exposed, not loopback`, () => {
      expect(isLoopbackHost(host)).toBe(false);
      expect(isExposed(host)).toBe(true);
    });
  }
});

describe("classification — wildcard (exposed + wildcard)", () => {
  for (const host of ["0.0.0.0", "::"]) {
    test(`${host} is exposed and wildcard`, () => {
      expect(isLoopbackHost(host)).toBe(false);
      expect(isExposed(host)).toBe(true);
      expect(isWildcardHost(host)).toBe(true);
    });
  }
});

describe("classification — concrete non-loopback IP (exposed, not wildcard)", () => {
  for (const host of ["192.168.1.10", "10.0.0.5", "203.0.113.7"]) {
    test(`${host} is exposed but not wildcard`, () => {
      expect(isLoopbackHost(host)).toBe(false);
      expect(isExposed(host)).toBe(true);
      expect(isWildcardHost(host)).toBe(false);
    });
  }
});

describe("deriveOpenUrl — navigable, gate-passing browser URL", () => {
  test("loopback host is used verbatim", () => {
    expect(deriveOpenUrl("127.0.0.1", 4321)).toBe("http://127.0.0.1:4321");
  });

  test("wildcard v4 (0.0.0.0) remaps to 127.0.0.1", () => {
    expect(deriveOpenUrl("0.0.0.0", 4321)).toBe("http://127.0.0.1:4321");
  });

  test("wildcard v6 (::) remaps to bracketed [::1]", () => {
    expect(deriveOpenUrl("::", 4321)).toBe("http://[::1]:4321");
  });

  test("a bare IPv6 literal is bracketed so the port separator is unambiguous", () => {
    expect(deriveOpenUrl("::1", 4321)).toBe("http://[::1]:4321");
  });

  test("a concrete non-loopback host is used verbatim", () => {
    expect(deriveOpenUrl("192.168.1.10", 4321)).toBe("http://192.168.1.10:4321");
  });

  test("the scheme-default port 80 is omitted from the authority", () => {
    expect(deriveOpenUrl("127.0.0.1", 80)).toBe("http://127.0.0.1");
    expect(deriveOpenUrl("0.0.0.0", 80)).toBe("http://127.0.0.1");
  });

  test("padded/mixed-case host is normalized (trim + lower-case)", () => {
    expect(deriveOpenUrl("  127.0.0.1  ", 4321)).toBe("http://127.0.0.1:4321");
  });
});
