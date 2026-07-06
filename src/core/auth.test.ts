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

  test("non-wildcard behavior is unchanged (regression)", () => {
    // A concrete non-loopback bind still requires an exact authority match —
    // the wildcard relaxation must NOT leak into the concrete-IP path.
    const lan = "192.168.1.10";
    const lanAuthority = `${lan}:${port}`;
    expect(validateOrigin(null, lanAuthority, lan, port)).toBe(true);
    expect(validateOrigin(`http://${lanAuthority}`, lanAuthority, lan, port)).toBe(true);
    // Any other Host (even correct port) is rejected against a concrete bind.
    expect(validateOrigin(null, `localhost:${port}`, lan, port)).toBe(false);
    expect(validateOrigin(null, `127.0.0.1:${port}`, lan, port)).toBe(false);
  });
});

describe("validateOrigin — wildcard bind (0.0.0.0 / ::)", () => {
  const port = 4321;

  for (const boundHost of ["0.0.0.0", "::"]) {
    test(`${boundHost}: accepts localhost:<port> Host with matching/absent Origin`, () => {
      const authority = `localhost:${port}`;
      expect(validateOrigin(null, authority, boundHost, port)).toBe(true);
      expect(validateOrigin("", authority, boundHost, port)).toBe(true);
      expect(validateOrigin(`http://${authority}`, authority, boundHost, port)).toBe(true);
    });

    test(`${boundHost}: accepts a LAN-IP Host with matching/absent Origin`, () => {
      const authority = `192.168.1.10:${port}`;
      expect(validateOrigin(null, authority, boundHost, port)).toBe(true);
      expect(validateOrigin(`http://${authority}`, authority, boundHost, port)).toBe(true);
    });

    test(`${boundHost}: accepts a bracketed IPv6 Host (port parsed after the last colon)`, () => {
      const authority = `[::1]:${port}`;
      expect(validateOrigin(null, authority, boundHost, port)).toBe(true);
      expect(validateOrigin(`http://${authority}`, authority, boundHost, port)).toBe(true);
    });

    test(`${boundHost}: rejects a plain cross-origin request (Origin differs from Host)`, () => {
      // The degraded wildcard gate still blocks classic cross-origin: a page at
      // evil.com doing fetch() to the LAN IP sends Origin=evil.com, Host=lan-ip.
      const authority = `192.168.1.10:${port}`;
      expect(validateOrigin("http://evil.example.com", authority, boundHost, port)).toBe(false);
      expect(
        validateOrigin(`http://localhost:${port}`, `192.168.1.10:${port}`, boundHost, port),
      ).toBe(false);
    });

    test(`${boundHost}: a same-value DNS-rebind passes THIS gate — the token is the boundary`, () => {
      // Honest documentation of the degraded gate: in a real DNS-rebind the
      // attacker controls both headers, so Origin === Host === attacker-authority
      // and Origin==Host is satisfied. This predicate does NOT stop it; the
      // session token (validateToken, checked separately) is what blocks the RPC.
      const rebind = `evil.example.com:${port}`;
      expect(validateOrigin(`http://${rebind}`, rebind, boundHost, port)).toBe(true);
    });

    test(`${boundHost}: rejects a wrong-port Host`, () => {
      expect(validateOrigin(null, `192.168.1.10:${port + 1}`, boundHost, port)).toBe(false);
      // No port in Host → no port to match → rejected.
      expect(validateOrigin(null, "192.168.1.10", boundHost, port)).toBe(false);
    });

    test(`${boundHost}: rejects an absent Host header`, () => {
      expect(validateOrigin(null, null, boundHost, port)).toBe(false);
      expect(validateOrigin(null, undefined, boundHost, port)).toBe(false);
    });
  }
});
