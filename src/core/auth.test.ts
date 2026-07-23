import { describe, expect, spyOn, test } from "bun:test";
import { mintCspNonce, mintSessionToken, validateOrigin, validateToken } from "./auth.ts";
import { deriveOpenUrl } from "./binding.ts";

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

describe("mintCspNonce (DW-2)", () => {
  test("produces 128-bit (32 hex char) lowercase-hex nonces", () => {
    const n = mintCspNonce();
    // Load-bearing: the value is interpolated raw into BOTH a `'nonce-…'` CSP source
    // token and an HTML attribute. Restricting it to lowercase hex means no character
    // it can ever contain (`;`, space, `"`, `<`) could terminate either context.
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(n.length).toBe(32);
  });

  test("100 draws in one process yield 100 distinct values", () => {
    // A predictable nonce is a full CSP bypass: an injected `<script nonce="…">` that
    // guessed it would execute with the shell's ambient authority. This does NOT prove
    // the source is a CSPRNG — no non-repeating source could fail it, and 100 draws from
    // 128 bits would collide only by miracle. What it DOES catch is the realistic
    // regression: a value hoisted to module scope, memoized, or otherwise minted once
    // and handed out again. Per-BOOT freshness is a separate claim, and it is asserted
    // where two real boots exist, in `server.test.ts`.
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(mintCspNonce());
    expect(seen.size).toBe(100);
  });

  test("two consecutive calls differ — the mint is not a cached constant", () => {
    expect(mintCspNonce()).not.toBe(mintCspNonce());
  });
});

describe("both mints draw from the CSPRNG, not Math.random", () => {
  // The one property no shape or uniqueness assertion above can reach. Swapping
  // `crypto.getRandomValues` for `Math.floor(Math.random() * 256)` inside the shared
  // `randomHex` keeps every hex shape, every length and every distinctness check green
  // while degrading BOTH secrets at once — and `tsc` does not pin it either, since the
  // replacement typechecks. The sharing that makes a hardening fix reach both mints
  // makes an anti-hardening change reach both too, so the source needs its own guard.
  //
  // A spy, deliberately, rather than an injected RNG parameter: an injection seam on a
  // security primitive is a way to pass a weak RNG in production, which is a worse trade
  // than observing the global the module already uses.
  test("mintSessionToken and mintCspNonce both call crypto.getRandomValues", () => {
    const spy = spyOn(crypto, "getRandomValues");
    try {
      const token = mintSessionToken();
      const nonce = mintCspNonce();
      expect(spy).toHaveBeenCalledTimes(2);
      // And the widths reach the CSPRNG itself, not just the hex encoder: 32 bytes for
      // the token, 16 for the nonce. A shortened draw padded out to the right hex width
      // would pass every other test in this file.
      const widths = spy.mock.calls.map((args) => (args[0] as Uint8Array).length);
      expect(widths).toEqual([32, 16]);
      // Sanity: the spy passed the real implementation through, so these are real values.
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      spy.mockRestore();
    }
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

describe("validateOrigin — scheme-default port 80 (browser omits the port)", () => {
  const host = "127.0.0.1";

  test("accepts a bare-host Host with absent/matching bare-host Origin", () => {
    // A browser at http://127.0.0.1 (port 80 implicit) sends Host: 127.0.0.1 and
    // Origin: http://127.0.0.1 — both without the port.
    expect(validateOrigin(null, host, host, 80)).toBe(true);
    expect(validateOrigin("", host, host, 80)).toBe(true);
    expect(validateOrigin(`http://${host}`, host, host, 80)).toBe(true);
  });

  test("still accepts the explicit :80 authority form", () => {
    expect(validateOrigin(`http://${host}:80`, `${host}:80`, host, 80)).toBe(true);
    expect(validateOrigin(null, `${host}:80`, host, 80)).toBe(true);
  });

  test("rejects a foreign bare Host / Origin even on port 80", () => {
    expect(validateOrigin(null, "localhost", host, 80)).toBe(false);
    expect(validateOrigin("http://localhost", host, host, 80)).toBe(false);
    expect(validateOrigin("http://evil.example.com", host, host, 80)).toBe(false);
  });

  test("a non-80 port still REQUIRES the explicit port (no bare-host relaxation)", () => {
    const port = 4321;
    // Bare host with no port is rejected when the bound port is not 80.
    expect(validateOrigin(null, host, host, port)).toBe(false);
    expect(validateOrigin(`http://${host}`, host, host, port)).toBe(false);
    // The explicit authority still works.
    expect(validateOrigin(null, `${host}:${port}`, host, port)).toBe(true);
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

describe("validateOrigin — concrete IPv6 bind (::1)", () => {
  // A browser opens `deriveOpenUrl("::1", port)` = `http://[::1]:<port>`, so it
  // sends a BRACKETED Host/Origin. The gate must bracket the bound host to match,
  // otherwise every RPC on an IPv6 loopback bind 403s.
  const boundHost = "::1";
  const port = 4321;

  test("accepts the bracketed [::1]:<port> authority", () => {
    const authority = `[::1]:${port}`;
    expect(validateOrigin(null, authority, boundHost, port)).toBe(true);
    expect(validateOrigin(`http://${authority}`, authority, boundHost, port)).toBe(true);
  });

  test("rejects an unbracketed or foreign IPv6 Host", () => {
    expect(validateOrigin(null, `::1:${port}`, boundHost, port)).toBe(false);
    expect(validateOrigin(null, `[::2]:${port}`, boundHost, port)).toBe(false);
  });

  test("port-80 bind accepts the portless bracketed authority", () => {
    expect(validateOrigin(null, "[::1]", boundHost, 80)).toBe(true);
    expect(validateOrigin("http://[::1]", "[::1]", boundHost, 80)).toBe(true);
  });
});

describe("validateOrigin ⇔ deriveOpenUrl coherence (the URL we open passes the gate)", () => {
  // Regression harness for the class of bug where browser-open navigates to a URL
  // the Origin/Host gate then rejects (wildcard+80, bracketed IPv6). For each bind
  // config, simulate exactly what the browser sends for `deriveOpenUrl`'s output:
  // Host = the authority, Origin = the full URL (the browser already dropped :80).
  const cases: Array<[string, number]> = [
    ["127.0.0.1", 5555],
    ["127.0.0.1", 80],
    ["0.0.0.0", 5555],
    ["0.0.0.0", 80],
    ["::1", 5555],
    ["::1", 80],
    ["::", 5555],
    ["::", 80],
    ["192.168.1.10", 5555],
    ["192.168.1.10", 80],
  ];

  for (const [bindHost, port] of cases) {
    test(`deriveOpenUrl(${bindHost}, ${port}) is accepted by validateOrigin`, () => {
      const url = deriveOpenUrl(bindHost, port);
      const authority = url.slice("http://".length);
      // Browser sends both the Origin (full URL) and a Host (the authority).
      expect(validateOrigin(url, authority, bindHost, port)).toBe(true);
      // Non-CORS caller (curl): Origin absent, Host present.
      expect(validateOrigin(null, authority, bindHost, port)).toBe(true);
    });
  }
});
