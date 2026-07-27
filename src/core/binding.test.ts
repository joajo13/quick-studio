import { describe, expect, test } from "bun:test";
import {
  deriveOpenUrl,
  isExposed,
  isLoopbackHost,
  isWildcardHost,
  resolveBindHost,
  sandboxBindHost,
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

// DW-48: the Ring 3 sandbox origin is tokenless — it has no session token, no `/rpc`
// and no credential of any kind — so it must never listen anywhere the LAN can reach.
// `sandboxBindHost` is the whole rule, and it is asserted here rather than by booting a
// wildcard server (see the standing no-real-wildcard-boot note in `server.test.ts`).
describe("sandboxBindHost — the Ring 3 loopback clamp", () => {
  // A host already unreachable from other machines passes through untouched, which is
  // what makes this function invisible in the default configuration: every existing
  // sandbox origin, iframe `src` and `frame-src` value is byte-identical to before.
  for (const host of ["127.0.0.1", "localhost", "127.0.0.53", "::1"]) {
    test(`${host} is already loopback and passes through verbatim`, () => {
      expect(sandboxBindHost(host)).toBe(host);
    });
  }

  test("the IPv4 wildcard clamps to 127.0.0.1 (QS_HOST=0.0.0.0 must not expose the guest)", () => {
    expect(sandboxBindHost("0.0.0.0")).toBe("127.0.0.1");
  });

  // Family preservation is load-bearing: clamping v6 to `127.0.0.1` would serve fine but
  // would stop `deriveOpenUrl`'s bracketing branch from being reached by the binds that
  // reach it today, quietly making the recorded IPv6 CSP residual describe dead code.
  test("the IPv6 wildcard clamps to ::1, preserving the address family", () => {
    expect(sandboxBindHost("::")).toBe("::1");
  });

  test("a bracketed IPv6 wildcard is still recognized as IPv6-shaped", () => {
    expect(sandboxBindHost("[::]")).toBe("::1");
  });

  // Not just the wildcards: a clamp that only caught `0.0.0.0`/`::` would still hand the
  // guest to the LAN for a concrete routable bind, which is the same exposure by a
  // different spelling. The predicate is "already loopback", not "looks like a wildcard".
  test("a routable IPv4 clamps to 127.0.0.1", () => {
    expect(sandboxBindHost("192.168.1.50")).toBe("127.0.0.1");
  });

  test("a routable IPv6 clamps to ::1", () => {
    expect(sandboxBindHost("fe80::1")).toBe("::1");
  });

  test("a hostname bind clamps to 127.0.0.1", () => {
    expect(sandboxBindHost("dev.local")).toBe("127.0.0.1");
  });

  // Inherits `isLoopbackHost`'s validated dotted-quad match rather than a `127.` prefix,
  // so a lookalike hostname is clamped like any other non-loopback host — it is NOT
  // trusted into a verbatim pass-through by looking vaguely like the loopback range.
  test("127.attacker.example is NOT loopback and is clamped to 127.0.0.1", () => {
    expect(sandboxBindHost("127.attacker.example")).toBe("127.0.0.1");
  });

  test("padded/mixed-case input is normalized (trim + lower-case) before the decision", () => {
    expect(sandboxBindHost("  0.0.0.0  ")).toBe("127.0.0.1");
    expect(sandboxBindHost("  LocalHost ")).toBe("localhost");
    expect(sandboxBindHost("DEV.LOCAL")).toBe("127.0.0.1");
  });

  // The invariant the clamp exists to hold, re-asserted over the whole matrix as one
  // statement: whatever comes out is a host `isLoopbackHost` accepts, so the socket can
  // never be reachable off-machine. Deliberately NOT called a property test — it is a
  // fixed table, so it can only witness the invariant on inputs someone thought of, and
  // it would not catch (say) an out-of-range quad that `isLoopbackHost` already
  // mis-classifies. Its job is to state the invariant in one place, not to search for
  // counterexamples.
  test("every matrix input yields a loopback output (the clamp's invariant)", () => {
    const hosts = [
      "0.0.0.0", "::", "[::]", "192.168.1.50", "fe80::1", "dev.local",
      "127.attacker.example", "127.0.0.1", "localhost", "::1",
    ];
    for (const host of hosts) {
      expect(isLoopbackHost(sandboxBindHost(host))).toBe(true);
    }
  });
});
