/**
 * quick-studio Core — sandbox origin (Ring 3) server tests.
 *
 * Boots a REAL ephemeral `startSandboxServer` with a STUB bundle (no build needed)
 * and asserts the served configuration that IS the containment boundary:
 *  - GET / -> 200 guest HTML carrying the exact locked-down CSP + nosniff, no token;
 *  - GET /guest.js -> 200 with the injected bundle as JS;
 *  - POST /rpc, GET /chat/stream, and any other path/method -> bare 404 (no token);
 *  - stop() frees the port (a re-bind on the same port succeeds).
 * Pure `sandboxCspHeaders`/`renderGuestHtml` are asserted directly too.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderGuestHtml, sandboxCspHeaders, startSandboxServer, type SandboxServer } from "./sandbox-server.ts";

const STUB_JS = "/* stub guest bundle */ console.log('guest boot');";

let server: SandboxServer;

beforeAll(() => {
  server = startSandboxServer({ host: "127.0.0.1", port: 0, bundle: { js: STUB_JS } });
});

afterAll(async () => {
  await server.stop();
});

describe("pure builders", () => {
  test("sandboxCspHeaders carries the exact egress-blocking CSP + nosniff", () => {
    const h = sandboxCspHeaders();
    const csp = h["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'self'");
    // `frame-ancestors` must NOT be set: Core embeds the guest cross-origin (a different
    // loopback port), so any origin-exact `frame-ancestors` would block the embed and
    // break the Ring 2 -> Ring 3 loop. The guest holds no secret worth clickjacking.
    expect(csp).not.toContain("frame-ancestors");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  test("renderGuestHtml loads only the same-origin module and bakes in no token/data", () => {
    const html = renderGuestHtml();
    expect(html).toContain('src="/guest.js"');
    expect(html).not.toContain("__QS_TOKEN__");
    expect(html).not.toContain("<script>window"); // no inline data script
  });
});

describe("live sandbox origin", () => {
  test("GET / returns the guest doc with the locked-down CSP, nosniff, and no token", async () => {
    const res = await fetch(`${server.origin}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toContain('src="/guest.js"');
    expect(body).not.toContain("__QS_TOKEN__");
  });

  test("GET /guest.js returns the injected bundle as JavaScript", async () => {
    const res = await fetch(`${server.origin}/guest.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toBe(STUB_JS);
  });

  test("POST /rpc is a bare 404 — no dispatch, no token in the response", async () => {
    const res = await fetch(`${server.origin}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "health" }),
    });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("token");
    expect(body).not.toContain("ok");
  });

  test("GET /chat/stream is a bare 404", async () => {
    const res = await fetch(`${server.origin}/chat/stream`);
    expect(res.status).toBe(404);
  });

  test("an arbitrary path / method is a bare 404", async () => {
    expect((await fetch(`${server.origin}/anything`)).status).toBe(404);
    expect((await fetch(`${server.origin}/`, { method: "POST" })).status).toBe(404);
  });
});

// DW-48: `startSandboxServer` CLAMPS its requested host to loopback rather than binding
// it. What these tests actually cover, stated exactly, because the clamp is a containment
// control and an overclaiming comment here is worse than no comment:
//
//  - the DERIVED ORIGIN for every clamped shape (`0.0.0.0` -> `127.0.0.1`, `::` -> `::1`,
//    `::1` verbatim), which is what Ring 2 injects and points the iframe at;
//  - that the reported IPv4 origin is LIVE — a fetch of it returns the guest document
//    under `GUEST_CSP`, so the clamp did not simply rewrite a string onto a dead address.
//
// What they do NOT and CANNOT cover from here: that the socket is loopback-ONLY. A server
// bound to `0.0.0.0` also answers on `127.0.0.1`, so the fetch below passes either way and
// cannot by itself refute a wildcard socket; and the IPv6 cases deliberately do not fetch
// at all, since an IPv6 loopback round-trip is not portable across the boxes this suite
// runs on (the pre-existing `::1` case never fetched either). What rules the wildcard
// socket out instead is construction plus `binding.test.ts`: there is exactly ONE host
// value inside `startSandboxServer`, feeding both `Bun.serve` and `deriveOpenUrl`, so bind
// and origin cannot disagree unless the clamp itself is wrong — and the clamp is
// unit-tested exhaustively there. A negative assertion (bind a routable local address,
// expect connection refused) is what would close the gap; it is left out because the
// available non-loopback local addresses differ per box and per CI runner.
//
// Requesting a wildcard here is safe in a way that booting a real wildcard CORE is not
// (see `server.test.ts`): this origin serves only the guest document, carries no session
// token and has no `/rpc` — and after the clamp it is not listening off-loopback at all.
describe("loopback clamp + navigable origin under wildcard / IPv6 binds", () => {
  test("a wildcard 0.0.0.0 request binds 127.0.0.1 and reports that origin", async () => {
    const s = startSandboxServer({ host: "0.0.0.0", port: 0, bundle: { js: STUB_JS } });
    try {
      expect(s.origin).toBe(`http://127.0.0.1:${s.port}`);
      // The origin is not merely a nicer string: the socket is really there, serving the
      // guest under `GUEST_CSP`. This proves the injected `__QS_SANDBOX_ORIGIN__` names a
      // live address — NOT that the socket is loopback-only (a wildcard bind answers here
      // too); see the block comment above for what covers that.
      const res = await fetch(`${s.origin}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy") ?? "").toContain("connect-src 'none'");
      expect(await res.text()).toContain('src="/guest.js"');
    } finally {
      await s.stop();
    }
  });

  test("a wildcard :: request binds ::1 — the address family is preserved", async () => {
    const s = startSandboxServer({ host: "::", port: 0, bundle: { js: STUB_JS } });
    try {
      // Clamping v6 to `127.0.0.1` would also be loopback, but it would retire
      // `deriveOpenUrl`'s bracketing path from the binds that reach it today.
      expect(s.origin).toBe(`http://[::1]:${s.port}`);
    } finally {
      await s.stop();
    }
  });

  test("an IPv6 loopback ::1 bind is unchanged and bracketed so the port separator is unambiguous", async () => {
    const s = startSandboxServer({ host: "::1", port: 0, bundle: { js: STUB_JS } });
    try {
      expect(s.origin).toBe(`http://[::1]:${s.port}`);
    } finally {
      await s.stop();
    }
  });
});

describe("teardown", () => {
  test("stop() frees the port so it can be re-bound", async () => {
    const s = startSandboxServer({ host: "127.0.0.1", port: 0, bundle: { js: STUB_JS } });
    const port = s.port;
    expect(port).toBeGreaterThan(0);
    await s.stop();
    // Re-binding the freed port must succeed (proves the listener is gone).
    const again = startSandboxServer({ host: "127.0.0.1", port, bundle: { js: STUB_JS } });
    expect(again.port).toBe(port);
    await again.stop();
  });
});
