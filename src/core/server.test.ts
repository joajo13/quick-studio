/**
 * quick-studio Core — server-level shutdown-RPC wiring tests.
 *
 * Locks the story-1.5-specific behaviors a pure `dispatch` test cannot reach:
 * `startCore` routes the `shutdown` RPC to the injected `onShutdownRequested`,
 * deferred to a macrotask so the ack flushes first; the gates still guard it;
 * and importing/booting `startCore` never reaches `process.exit` (the runner
 * surviving these tests is that assertion).
 *
 * One shared boot keeps the suite fast — hence a generous `beforeAll` timeout
 * and sequential assertions on a single Core. As of story 1.7 the UI is bundled
 * at build time (`src/core/ui-bundle.generated.ts`) and served pre-built, so the
 * generated module MUST exist before `bun test` (run `bun run build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSchema } from "../shared/contract.ts";
import { resolveAppDir } from "./app-dir.ts";
import { DriverConnectionError, type Driver, type DriverFactory } from "./driver.ts";
import { overBodyLimit, renderIndexHtml, startCore, type Core } from "./server.ts";
import { uiBundle } from "./ui-bundle.generated.ts";

let core: Core;
let shutdownCalls = 0;

beforeAll(async () => {
  // Spy hook (never stops the real server) so we can assert the RPC routes to
  // it without tearing the shared Core down between assertions.
  core = await startCore(0, {
    onShutdownRequested: () => {
      shutdownCalls += 1;
    },
  });
}, 30000);

afterAll(() => {
  void core.stop();
});

/** POST an RPC. `fetch` sets Host to the loopback authority automatically and
 *  an absent Origin is allowed by `validateOrigin`, so only the token varies. */
async function callRpc(token: string, body: unknown): Promise<Response> {
  return fetch(`${core.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-qs-token": token },
    body: JSON.stringify(body),
  });
}

test("unauthenticated shutdown is rejected 403 and never triggers teardown", async () => {
  const res = await callRpc("wrong-token", { method: "shutdown" });
  const reply = await res.json();

  expect(res.status).toBe(403);
  expect(reply.ok).toBe(false);
  await new Promise((r) => setTimeout(r, 5));
  expect(shutdownCalls).toBe(0);
});

test("authenticated shutdown acks {stopping:true} and defers onShutdownRequested to a macrotask", async () => {
  const res = await callRpc(core.token, { method: "shutdown" });
  const reply = await res.json();

  expect(res.status).toBe(200);
  expect(reply).toEqual({ ok: true, result: { stopping: true } });
  // Ack-before-teardown: the hook has NOT fired during the request…
  expect(shutdownCalls).toBe(0);
  // …it fires on the next macrotask, after the reply has flushed.
  await new Promise((r) => setTimeout(r, 5));
  expect(shutdownCalls).toBe(1);
});

test("default boot is not exposed and injects exposed:false into the served HTML", async () => {
  expect(core.exposed).toBe(false);
  const html = await (await fetch(`${core.url}/`)).text();
  expect(html).toContain("window.__QS_EXPOSURE__");
  expect(html).toContain('"exposed":false');
});

// DW-7: shared max-request-body guard — an over-limit `Content-Length` is rejected
// (413 `bad_request`) at BOTH POST endpoints, AFTER the token gate and BEFORE
// `req.json()` buffers the body. Bun's `fetch` recomputes `content-length` from the
// actual body (a manually set header is ignored), so the over-limit cases send a
// genuinely >8 MiB body — cheap over loopback — to force the real header past the limit.
describe("max request-body guard (DW-7)", () => {
  // One byte past the 8 MiB limit so the real `content-length` trips the guard.
  const overLimitBody = "x".repeat(8 * 1024 * 1024 + 1);

  test("POST /rpc with a valid token and an over-limit body → 413 bad_request", async () => {
    const res = await fetch(`${core.url}/rpc`, {
      method: "POST",
      // `connection: close` so the unconsumed 8 MiB body doesn't ride a reused
      // keep-alive connection and pollute the next request (server returns before draining it).
      headers: { "content-type": "application/json", "x-qs-token": core.token, connection: "close" },
      body: overLimitBody,
    });
    expect(res.status).toBe(413);
    const reply = await res.json();
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("bad_request");
  });

  test("POST /chat/stream with a valid token and an over-limit body → 413 bad_request", async () => {
    const res = await fetch(`${core.url}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qs-token": core.token, connection: "close" },
      body: overLimitBody,
    });
    expect(res.status).toBe(413);
    const reply = await res.json();
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("bad_request");
  });

  test("a within-limit request still succeeds (guard doesn't break normal calls)", async () => {
    const res = await callRpc(core.token, { method: "health" });
    expect(res.status).toBe(200);
    const reply = await res.json();
    expect(reply.ok).toBe(true);
    expect(reply.result.status).toBe("ok");
  });

  test("an over-limit body with a bad token → 403 (token gate fires before the guard)", async () => {
    const res = await fetch(`${core.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qs-token": "not-the-token", connection: "close" },
      body: overLimitBody,
    });
    expect(res.status).toBe(403);
    const reply = await res.json();
    expect(reply.ok).toBe(false);
    // Assert the TOKEN gate specifically — not just "a 403" (the Origin gate also
    // returns 403) — so this proves the guard sits after the token check.
    expect(reply.error.code).toBe("unauthorized");
  });
});

// Story 10.1: the shared Core boots with NO databaseUrl (null target), so the read
// paths hit the typed `NoConnectionTargetError` seam. `table.rows` must translate it
// into a neutral `bad_request` "no active connection" — never the generic
// `internal_error: RPC handler failed` regression, and never a credential in the envelope.
describe("table.rows with no connection target configured (Story 10.1)", () => {
  test("returns bad_request 'no active connection', never internal_error, no credential leak", async () => {
    const res = await callRpc(core.token, {
      method: "table.rows",
      params: { schema: "public", table: "users", page: 1, pageSize: 10 },
    });
    // A `bad_request` envelope rides HTTP 400 (never a 500/internal_error).
    expect(res.status).toBe(400);
    const reply = await res.json();
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("bad_request");
    expect(reply.error.code).not.toBe("internal_error");
    expect(reply.error.message).toContain("no active connection");
    // Credential-free by construction: no URL/host/user/password anywhere in the envelope.
    const serialized = JSON.stringify(reply.error);
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("password");
  });
});

// DW-7 (predicate unit tests): `overBodyLimit` reads only the `content-length`
// header, so a minimal header stub exercises every boundary without allocating a
// real body — including the >8 MiB / Infinity-overflow inputs that Bun's `fetch`
// won't let an integration test forge (it recomputes `content-length` from the body).
describe("overBodyLimit predicate (DW-7)", () => {
  const LIMIT = 8 * 1024 * 1024;
  const withCL = (cl: string | null): Request =>
    ({ headers: { get: (name: string) => (name === "content-length" ? cl : null) } }) as unknown as Request;

  test("exactly at the limit is allowed (guard is strictly greater-than)", () => {
    expect(overBodyLimit(withCL(String(LIMIT)))).toBe(false);
  });

  test("one byte over the limit is rejected", () => {
    expect(overBodyLimit(withCL(String(LIMIT + 1)))).toBe(true);
  });

  test("an all-digit value that overflows Number() to Infinity is rejected", () => {
    // The bug this guards: `Number.isFinite(Infinity) === false` used to let a
    // gigantic declared size slip through the guard's own upper bound.
    expect(overBodyLimit(withCL("9".repeat(400)))).toBe(true);
  });

  test("absent, empty, zero, non-numeric, and negative content-length all proceed", () => {
    expect(overBodyLimit(withCL(null))).toBe(false); // Number(null) === 0
    expect(overBodyLimit(withCL(""))).toBe(false); // Number("") === 0
    expect(overBodyLimit(withCL("0"))).toBe(false);
    expect(overBodyLimit(withCL("not-a-number"))).toBe(false); // NaN → excused
    expect(overBodyLimit(withCL("-100"))).toBe(false); // invalid HTTP, not a large body
  });
});

// Story 5.5: Core boots a SECOND server (the Ring 3 sandbox origin) on a distinct
// port and injects that origin into the served HTML for Ring 2 to point the iframe at.
describe("Ring 3 sandbox origin (Story 5.5)", () => {
  test("core.sandboxOrigin is a distinct loopback origin injected into the HTML", async () => {
    expect(core.sandboxOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // A genuinely separate origin: same host, DIFFERENT port from the Core.
    expect(core.sandboxOrigin).not.toBe(core.url);
    const html = await (await fetch(`${core.url}/`)).text();
    expect(html).toContain("window.__QS_SANDBOX_ORIGIN__");
    expect(html).toContain(core.sandboxOrigin);
  });

  test("the sandbox origin serves the guest doc under connect-src 'none' and no token", async () => {
    const res = await fetch(`${core.sandboxOrigin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy") ?? "").toContain("connect-src 'none'");
    const body = await res.text();
    expect(body).not.toContain("__QS_TOKEN__");
    // The sandbox origin exposes no data endpoints.
    expect((await fetch(`${core.sandboxOrigin}/rpc`, { method: "POST" })).status).toBe(404);
  });

  test("core.stop() also tears the sandbox server down (its origin stops answering)", async () => {
    const c = await startCore(0);
    const sandboxOrigin = c.sandboxOrigin;
    expect((await fetch(`${sandboxOrigin}/`)).status).toBe(200);
    await c.stop();
    // After teardown the sandbox listener is gone — a fetch now fails to connect.
    await expect(fetch(`${sandboxOrigin}/`)).rejects.toThrow();
  });

  test("core.stop() still stops the Core server even when sandbox stop rejects", async () => {
    // A throwing sandbox teardown must NEVER skip the Core `server.stop()` (try/finally):
    // both ports are always released, never orphaned by an ordering accident.
    let sandboxStopCalls = 0;
    const c = await startCore(0, {
      startSandboxServer: () => ({
        port: 65535,
        origin: "http://127.0.0.1:65535",
        stop: () => {
          sandboxStopCalls += 1;
          throw new Error("sandbox stop boom");
        },
      }),
    });
    const coreUrl = c.url;
    // The Core is live before teardown.
    expect((await fetch(`${coreUrl}/`)).status).toBe(200);
    // stop() surfaces the sandbox failure…
    await expect(c.stop()).rejects.toThrow("sandbox stop boom");
    expect(sandboxStopCalls).toBe(1);
    // …but the Core server was still stopped in the `finally` — its port is freed.
    await expect(fetch(`${coreUrl}/`)).rejects.toThrow();
  });
});

// The exposed-path injection is unit-tested via the exported `renderIndexHtml`
// rather than a second `startCore({ host: "0.0.0.0" })` boot — booting a real
// wildcard listener would open a token-bearing endpoint to the whole LAN for the
// duration of the run, an unacceptable smell in a security-first story. The
// `startCore` → `core.exposed` plumbing is proven by the default boot above; the
// `isExposed` classification is covered in `binding.test.ts`.
// Story 1.7: the Core serves the pre-built UI bundle from the ONE generated
// module — never a runtime `Bun.build`. These assertions lock that boot serves
// exactly `uiBundle.js` / `uiBundle.css`, which is what makes the compiled
// binary and the global-install path ship a byte-identical UI.
describe("serves the pre-built UI bundle", () => {
  test("GET /app.js returns 200 with the React app bundle", async () => {
    const res = await fetch(`${core.url}/app.js`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body.length).toBeGreaterThan(100);
    // Proof it's the real app bundle: the entry mounts into `#root`.
    expect(body).toContain("root");
    // Boot serves exactly the pre-built module, not a runtime build.
    expect(body).toBe(uiBundle.js);
  });

  test("GET /app.css returns 200 with the pre-built stylesheet", async () => {
    const res = await fetch(`${core.url}/app.css`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toBe(uiBundle.css);
  });
});

// Story 1.2: threads the run mode through `startCore` and exposes a navigable
// `openUrl`. The default (loopback) boot above already proves the plumbing for
// `openUrl`; here we lock the Ephemeral no-write guarantee and mode threading.
// A fresh temp dir is pointed at by every app-dir env var so `resolveAppDir`
// (whichever platform branch runs) lands under it — and must stay absent after a
// full boot, the concrete regressible form of "Ephemeral writes nothing".
describe("Ephemeral boot writes nothing to the app-data dir", () => {
  test("no app dir is created and core.mode/openUrl are set", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "qs-ephemeral-"));
    const saved = {
      APPDATA: process.env.APPDATA,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      HOME: process.env.HOME,
    };
    process.env.APPDATA = tmp;
    process.env.XDG_DATA_HOME = tmp;
    process.env.HOME = tmp;

    let ephemeralCore: Core | undefined;
    try {
      const appDir = resolveAppDir(process.env, process.platform);
      ephemeralCore = await startCore(0, { mode: "ephemeral" });

      expect(ephemeralCore.mode).toBe("ephemeral");
      // Loopback default bind → the navigable open URL is the bind host verbatim.
      expect(ephemeralCore.openUrl).toBe(`http://127.0.0.1:${ephemeralCore.port}`);
      // The hard guarantee: boot touched no disk writer, so the app dir is absent.
      expect(existsSync(appDir)).toBe(false);
    } finally {
      if (ephemeralCore) await ephemeralCore.stop();
      // Restore env exactly (delete if it was originally unset).
      for (const key of ["APPDATA", "XDG_DATA_HOME", "HOME"] as const) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// Story 1.3: the `connect` RPC opens the Core-held URL through the uniform driver
// and returns a neutral ConnectResult — proven end-to-end through the real server
// + gate with a FAKE driver factory (no live Postgres/MySQL). Each case boots its
// own Core so the shared-boot spy above stays untouched.
describe("connect RPC through the gate (Story 1.3)", () => {
  const FAKE_SCHEMA: DatabaseSchema = {
    engine: "postgres",
    tables: [
      {
        schema: "public",
        name: "widgets",
        columns: [{ name: "id", dataType: "integer", nullable: false }],
        primaryKey: ["id"],
        indexes: [],
        foreignKeys: [],
      },
    ],
  };

  /** POST an RPC to an arbitrary core with a valid token. */
  async function rpc(target: Core, body: unknown): Promise<Response> {
    return fetch(`${target.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qs-token": target.token },
      body: JSON.stringify(body),
    });
  }

  test("valid target → 200 with status:'connected' and a neutral schema", async () => {
    const factory: DriverFactory = () => ({
      async connect() {},
      async listSchema() {
        return FAKE_SCHEMA;
      },
      async query() {
        return { columns: [], rows: [] };
      },
      async queryReadOnly() {
        return { columns: [], rows: [] };
      },
      quoteIdent(ident: string) {
        return `"${ident}"`;
      },
      async close() {},
    });
    const c = await startCore(0, {
      databaseUrl: "postgres://u:p@h/db",
      createDriver: factory,
    });
    try {
      const res = await rpc(c, { method: "connect" });
      const reply = await res.json();
      expect(res.status).toBe(200);
      expect(reply.ok).toBe(true);
      expect(reply.result).toEqual({ status: "connected", schema: FAKE_SCHEMA });
    } finally {
      await c.stop();
    }
  });

  test("auth-failing driver → 200 with status:'failed', failure:'auth' (domain payload, no leak)", async () => {
    const factory: DriverFactory = () => ({
      async connect() {
        throw new DriverConnectionError("auth", "the database rejected the provided credentials");
      },
      async listSchema() {
        return FAKE_SCHEMA;
      },
      async query() {
        return { columns: [], rows: [] };
      },
      async queryReadOnly() {
        return { columns: [], rows: [] };
      },
      quoteIdent(ident: string) {
        return `"${ident}"`;
      },
      async close() {},
    });
    const c = await startCore(0, {
      databaseUrl: "postgres://u:wrong@h/db",
      createDriver: factory,
    });
    try {
      const res = await rpc(c, { method: "connect" });
      const reply = await res.json();
      expect(res.status).toBe(200);
      expect(reply.ok).toBe(true);
      expect(reply.result.status).toBe("failed");
      expect(reply.result.failure).toBe("auth");
      expect(reply.result.message).not.toContain("wrong");
    } finally {
      await c.stop();
    }
  });

  test("stop() closes the live driver (nothing lingers past teardown)", async () => {
    let closes = 0;
    let connects = 0;
    const driver: Driver = {
      async connect() {
        connects++;
      },
      async listSchema() {
        return FAKE_SCHEMA;
      },
      async query() {
        return { columns: [], rows: [] };
      },
      async queryReadOnly() {
        return { columns: [], rows: [] };
      },
      quoteIdent(ident: string) {
        return `"${ident}"`;
      },
      async close() {
        closes++;
      },
    };
    const factory: DriverFactory = () => driver;
    const c = await startCore(0, {
      databaseUrl: "postgres://u:p@h/db",
      createDriver: factory,
    });

    // Open the connection, then a second call proves idempotency (connect once).
    await rpc(c, { method: "connect" });
    await rpc(c, { method: "connect" });
    expect(connects).toBe(1);

    await c.stop();
    expect(closes).toBe(1);
  });

  test("connection.active on an ephemeral boot returns the derived, credential-free descriptor + mode", async () => {
    const factory: DriverFactory = () => ({
      async connect() {},
      async listSchema() {
        return FAKE_SCHEMA;
      },
      async query() {
        return { columns: [], rows: [] };
      },
      async queryReadOnly() {
        return { columns: [], rows: [] };
      },
      quoteIdent(ident: string) {
        return `"${ident}"`;
      },
      async close() {},
    });
    const c = await startCore(0, {
      databaseUrl: "postgres://alice:s3cret@db.example.com:5432/shop",
      createDriver: factory,
      mode: "ephemeral",
    });
    try {
      const res = await rpc(c, { method: "connection.active" });
      const raw = await res.text();
      expect(res.status).toBe(200);
      // The active read must NOT force a driver open (pure derivation from the held url).
      const reply = JSON.parse(raw);
      expect(reply.ok).toBe(true);
      expect(reply.result.mode).toBe("ephemeral");
      expect(reply.result.connection).toEqual({
        engine: "postgres",
        host: "db.example.com:5432",
        database: "shop",
      });
      // Credential-free bytes: no password, no user, no full url on the wire.
      expect(raw).not.toContain("s3cret");
      expect(raw).not.toContain("alice");
      expect(raw).not.toContain("postgres://");
    } finally {
      await c.stop();
    }
  });

  test("connection.active on a persistent boot with no url returns connection:null", async () => {
    const c = await startCore(0, { mode: "persistent" });
    try {
      const res = await rpc(c, { method: "connection.active" });
      const reply = await res.json();
      expect(res.status).toBe(200);
      expect(reply.ok).toBe(true);
      expect(reply.result.mode).toBe("persistent");
      expect(reply.result.connection).toBeNull();
    } finally {
      await c.stop();
    }
  });
});

describe("renderIndexHtml exposure injection", () => {
  test("carries exposed:true and the bound host into the served HTML", () => {
    const html = renderIndexHtml("abc123", { exposed: true, host: "0.0.0.0", port: 4321 }, "http://127.0.0.1:5555");
    expect(html).toContain("window.__QS_EXPOSURE__");
    expect(html).toContain('"exposed":true');
    expect(html).toContain('"host":"0.0.0.0"');
    expect(html).toContain('"port":4321');
  });

  test("script-escapes an untrusted host so it cannot break out of <script>", () => {
    const html = renderIndexHtml(
      "abc123",
      { exposed: true, host: "</script><script>alert(1)</script>", port: 80 },
      "http://127.0.0.1:5555",
    );
    // The literal `</script>` sequence must never appear unescaped in the shell.
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("\\u003c");
  });

  test("injects the sandbox origin and URL-charset-filters it", () => {
    const html = renderIndexHtml("abc123", { exposed: false, host: "127.0.0.1", port: 80 }, "http://127.0.0.1:6789");
    expect(html).toContain("window.__QS_SANDBOX_ORIGIN__");
    expect(html).toContain("http://127.0.0.1:6789");
  });

  test("strips a script-breakout attempt from an untrusted sandbox origin", () => {
    const html = renderIndexHtml(
      "abc123",
      { exposed: false, host: "127.0.0.1", port: 80 },
      'http://127.0.0.1:1</script><script>alert(1)</script>',
    );
    expect(html).not.toContain("<script>alert(1)");
    // The filter drops `<`/`>`/space so the injected value is inert.
    expect(html).not.toContain("</script><script>alert(1)");
  });
});

// Story 6.4: the Core publishes a layout+SQL Live Report and serves it same-origin at
// `/live/<id>` with its per-boot token injected (mirroring the app shell), while `/rpc`
// keeps its UNCHANGED second-caller gate so the live page is an explicit second caller.
describe("Live Report serving (Story 6.4)", () => {
  const liveDoc = {
    schemaVersion: 1,
    blocks: [
      { kind: "prose", markdown: "# live" },
      { kind: "query", sql: "select 1 as k", view: "table", chart: null },
    ],
  };

  async function publish(): Promise<string> {
    const res = await callRpc(core.token, { method: "livereport.publish", params: liveDoc });
    const reply = await res.json();
    expect(reply.ok).toBe(true);
    return reply.result.path as string;
  }

  test("GET /live/<id> returns the assembled HTML with the injected token AND connect-src 'self'", async () => {
    const path = await publish();
    expect(path).toMatch(/^\/live\/[0-9a-f]{32}$/);
    const res = await fetch(`${core.url}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    // The serving Core injects its per-boot token (like the app shell).
    expect(html).toContain("window.__QS_TOKEN__");
    expect(html).toContain(core.token);
    // The load-bearing egress boundary: connect-src 'self', NOT 'none'.
    expect(html).toContain("connect-src 'self'");
    expect(html).not.toContain("connect-src 'none'");
    // The published payload carries only layout+SQL — no frozen data embedded. Check the
    // embedded payload script specifically (the inlined runtime bundle legitimately contains
    // the word "columns" in minified Plot/micromark code).
    expect(html).toContain("select 1 as k");
    const payload = /<script type="application\/json" id="__qs_livereport">([\s\S]*?)<\/script>/.exec(html);
    expect(payload).not.toBeNull();
    expect(payload![1]).not.toContain("columns");
    expect(payload![1]).not.toContain("rows");
  });

  test("GET /live/<id> delivers a REAL HTTP anti-framing header (a <meta> frame-ancestors is inert)", async () => {
    const path = await publish();
    const res = await fetch(`${core.url}${path}`);
    expect(res.status).toBe(200);
    // The token-bearing page must be un-framable via headers browsers actually honor —
    // `frame-ancestors` in the <meta> CSP is silently dropped by browsers, so the clickjacking
    // guard the CSP asserts is enforced only when delivered as an HTTP header.
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy") ?? "").toContain("frame-ancestors 'none'");
  });

  test("an unknown live-report id → 404 with a human-readable expiry/re-export note", async () => {
    const res = await fetch(`${core.url}/live/deadbeefdeadbeefdeadbeefdeadbeef`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.toLowerCase()).toContain("expired");
    expect(body.toLowerCase()).toContain("re-export");
  });

  test("an invalid published doc → bad_request (never a throw through the envelope)", async () => {
    const res = await callRpc(core.token, {
      method: "livereport.publish",
      params: { schemaVersion: 99, blocks: [] },
    });
    const reply = await res.json();
    expect(res.status).toBe(400);
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("bad_request");
  });

  test("GET /live-report-runtime.js is served open with the JS content-type", async () => {
    const res = await fetch(`${core.url}/live-report-runtime.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100);
    // Open + data-free: no token baked into the served bundle.
    expect(body).not.toContain(core.token);
  });

  test("/rpc still rejects an absent/bad token and a foreign Origin (gate UNCHANGED)", async () => {
    // Bad token → 403.
    const bad = await callRpc("not-the-token", { method: "livereport.publish", params: liveDoc });
    expect(bad.status).toBe(403);
    // Foreign Origin → 403 (checked before the token).
    const foreign = await fetch(`${core.url}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qs-token": core.token,
        origin: "http://evil.example.com",
      },
      body: JSON.stringify({ method: "livereport.publish", params: liveDoc }),
    });
    expect(foreign.status).toBe(403);
  });
});
