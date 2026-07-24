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
import {
  REPAIRABLE_HOSTILE_SANDBOX_ORIGINS,
  UNUSABLE_SANDBOX_ORIGINS,
  USABLE_SANDBOX_ORIGINS,
} from "../shared/sandbox-origin.fixtures.ts";
import { resolveAppDir } from "./app-dir.ts";
import { mintCspNonce } from "./auth.ts";
import { DriverConnectionError, type Driver, type DriverFactory } from "./driver.ts";
import { overBodyLimit, renderIndexHtml, shellCspHeaders, startCore, type Core } from "./server.ts";
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
      // Story 10.5: the bare existence bit rides alongside the descriptor.
      expect(reply.result.hasTarget).toBe(true);
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
      // Nothing configured at all — the schema tree contributes NO boot root for this.
      expect(reply.result.hasTarget).toBe(false);
    } finally {
      await c.stop();
    }
  });

  test("connection.active on a configured-but-undescribable boot url reports hasTarget:true with connection:null", async () => {
    // A url that PARSES but has no host (`describe()` → null) is the one real
    // "configured but broken" case reachable by the UI — `cli-args.ts` rejects a
    // genuinely unparseable `--url` before any UI exists. The boolean is what lets the
    // tree render an ERROR root here instead of the calm "Sin conexión activa".
    const c = await startCore(0, { databaseUrl: "postgres:///shop", mode: "ephemeral" });
    try {
      const res = await rpc(c, { method: "connection.active" });
      const reply = await res.json();
      expect(res.status).toBe(200);
      expect(reply.ok).toBe(true);
      expect(reply.result.connection).toBeNull();
      expect(reply.result.hasTarget).toBe(true);
    } finally {
      await c.stop();
    }
  });
});

describe("renderIndexHtml exposure injection", () => {
  test("carries exposed:true and the bound host into the served HTML", () => {
    const html = renderIndexHtml(
      "abc123",
      { exposed: true, host: "0.0.0.0", port: 4321 },
      "http://127.0.0.1:5555",
      "0123456789abcdef0123456789abcdef",
    );
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
      "0123456789abcdef0123456789abcdef",
    );
    // The literal `</script>` sequence must never appear unescaped in the shell.
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("\\u003c");
  });

  test("injects a usable sandbox origin verbatim", () => {
    const html = renderIndexHtml(
      "abc123",
      { exposed: false, host: "127.0.0.1", port: 80 },
      "http://127.0.0.1:6789",
      "0123456789abcdef0123456789abcdef",
    );
    expect(html).toContain("window.__QS_SANDBOX_ORIGIN__");
    expect(html).toContain("http://127.0.0.1:6789");
  });

  test("refuses an untrusted sandbox origin whole rather than repairing it", () => {
    // Accept-or-reject on the RAW value, the same rule `shellCspHeaders` applies. The
    // earlier character filter would have kept the survivors — for a breakout payload
    // that is inert residue, but for `"http://evil.test\\:6789"` it was a valid,
    // fabricated REMOTE origin that the shell, the header and the iframe then agreed on.
    for (const hostile of REPAIRABLE_HOSTILE_SANDBOX_ORIGINS) {
      const html = renderIndexHtml(
        "abc123",
        { exposed: false, host: "127.0.0.1", port: 80 },
        hostile,
        "0123456789abcdef0123456789abcdef",
      );
      expect(html).not.toContain("<script>alert(1)");
      // The injected global is empty — which Ring 2 renders as `about:blank` — and no
      // residue of the payload survives anywhere in the document.
      expect(html).toContain("window.__QS_SANDBOX_ORIGIN__ = \"\";");
      expect(html).not.toContain("evil.test");
      expect(html).not.toContain("unsafe-inline");
    }
  });

  // Story 11.7: the fourth inline global. Its whole failure mode is silent-closed
  // (a missing/mismatched nonce means the browser refuses the tag, and the UI never
  // learns it is a first run), so the nonce-pairing assertion is the load-bearing one.
  describe("firstRun injection (Story 11.7)", () => {
    const NONCE = "0123456789abcdef0123456789abcdef";
    const EXPOSURE = { exposed: false, host: "127.0.0.1", port: 80 } as const;
    const SANDBOX = "http://127.0.0.1:6789";

    test("firstRun: true renders window.__QS_FIRST_RUN__ = true, carrying the same nonce as the other three globals", () => {
      const html = renderIndexHtml("abc123", EXPOSURE, SANDBOX, NONCE, true);
      expect(html).toContain("window.__QS_FIRST_RUN__ = true;");
      // Every inline <script nonce="..."> tag in the shell carries the SAME nonce —
      // proves the fourth global did not introduce a second, drifting nonce source.
      const nonceTags = html.match(/<script nonce="[^"]*">/g) ?? [];
      expect(nonceTags.length).toBe(4);
      for (const tag of nonceTags) {
        expect(tag).toBe(`<script nonce="${NONCE}">`);
      }
    });

    test("firstRun: false renders window.__QS_FIRST_RUN__ = false", () => {
      const html = renderIndexHtml("abc123", EXPOSURE, SANDBOX, NONCE, false);
      expect(html).toContain("window.__QS_FIRST_RUN__ = false;");
    });

    test("the defaulted call (no fifth argument) also renders false — every pre-11.7 call site keeps compiling and stays byte-for-byte on the OTHER three globals", () => {
      const withDefault = renderIndexHtml("abc123", EXPOSURE, SANDBOX, NONCE);
      const withExplicitFalse = renderIndexHtml("abc123", EXPOSURE, SANDBOX, NONCE, false);
      expect(withDefault).toContain("window.__QS_FIRST_RUN__ = false;");
      expect(withDefault).toBe(withExplicitFalse);
    });

    test("the shell now carries five <script> tags: four nonce-bearing inline globals plus the external module", () => {
      const html = renderIndexHtml("abc123", EXPOSURE, SANDBOX, NONCE, true);
      const scriptOpenTags = html.match(/<script[ >]/g) ?? [];
      expect(scriptOpenTags.length).toBe(5);
      const nonceTags = html.match(/<script nonce="[^"]*">/g) ?? [];
      expect(nonceTags.length).toBe(4);
    });

  });
});

// The `renderIndexHtml` unit tests above prove the template renders whatever it is
// handed, but nothing there covers the threading that actually feeds it —
// `bin/` -> `StartCoreOptions.firstRun` -> `options.firstRun ?? false` -> the
// template. A regression that dropped the option on the floor (always rendering
// `false`) would leave the CLI hint printing while the UI never routed, with a fully
// green suite. These boot a real Core and read the served shell over the socket.
describe("startCore — firstRun option threading (Story 11.7)", () => {
  test("startCore({ firstRun: true }) serves a shell whose global is true", async () => {
    const c = await startCore(0, { firstRun: true });
    try {
      const html = await (await fetch(`${c.url}/`)).text();
      expect(html).toContain("window.__QS_FIRST_RUN__ = true;");
    } finally {
      await c.stop();
    }
  });

  test("startCore with the option omitted serves false — every pre-11.7 boot is unchanged", async () => {
    const c = await startCore(0);
    try {
      const html = await (await fetch(`${c.url}/`)).text();
      expect(html).toContain("window.__QS_FIRST_RUN__ = false;");
    } finally {
      await c.stop();
    }
  });
});

// DW-2: the token-bearing app shell is served under a strict per-boot CSP with a
// CSPRNG nonce on its three inline scripts. These lock the exact header set, the
// header<->body nonce agreement, per-boot freshness, both fail-closed corners, and
// that none of it leaked onto the separately-contracted `/live/<id>` page.
describe("app-shell CSP (DW-2)", () => {
  /** A well-formed 32-hex nonce, standing in for `mintCspNonce()` output. */
  const NONCE = "0123456789abcdef0123456789abcdef";
  const SANDBOX = "http://127.0.0.1:6789";
  const EXPOSURE = { exposed: false, host: "127.0.0.1", port: 80 } as const;

  /**
   * The exact, complete source list for every directive that does NOT depend on boot
   * state. Only `script-src` (per-boot nonce) and `frame-src` (per-boot sandbox origin)
   * are excluded, and both are pinned separately at each call site.
   *
   * Exact strings, not substrings, because a CSP only ever regresses by WIDENING: every
   * `.toContain("connect-src 'self'")` in this file used to pass unchanged against
   * `connect-src 'self' https://attacker.example`, so the suite placed no upper bound on
   * what any directive permitted. `toBe` on the whole directive is the only assertion
   * shape that says "this and nothing more".
   */
  const FIXED_SHELL_DIRECTIVES: Record<string, string> = {
    "default-src": "default-src 'self'",
    // No nonce/hash here on purpose: per spec either would make `'unsafe-inline'` inert
    // and break the 47 React `style={{…}}` attributes plus three runtime `<style>` injectors.
    "style-src": "style-src 'self' 'unsafe-inline'",
    // `data:` for CodeMirror's `.cm-highlightTab` background, and NO remote scheme —
    // that omission is what blocks a stored-XSS from beaconing out via an `<img src>`.
    "img-src": "img-src 'self' data:",
    "font-src": "font-src 'self'",
    // The egress pin on scripted REQUESTS (fetch/XHR/WebSocket/EventSource). It does not
    // reach scripted navigation; that residual is recorded on the constant in `server.ts`.
    "connect-src": "connect-src 'self'",
    "worker-src": "worker-src 'none'",
    "object-src": "object-src 'none'",
    "base-uri": "base-uri 'none'",
    "form-action": "form-action 'none'",
    "frame-ancestors": "frame-ancestors 'none'",
  };

  /**
   * Every directive name the shell policy is allowed to emit. An allowlist, not a
   * spot-check: a directive name the browser does not recognize is DISCARDED wholesale
   * (`img-scr 'self'` silently grants everything `img-src` was meant to deny), and a
   * loose `.toContain()` on the rest of the policy would never notice.
   */
  const EXPECTED_DIRECTIVE_NAMES = [
    ...Object.keys(FIXED_SHELL_DIRECTIVES),
    "script-src",
    "frame-src",
  ];

  /** Pull the nonce off the shell's first inline `<script>` (absent ⇒ null). */
  function bodyNonce(html: string): string | null {
    const m = /<script nonce="([0-9a-f]+)">/.exec(html);
    return m === null ? null : (m[1] as string);
  }

  /** Pull the `'nonce-…'` value out of a policy's `script-src` (absent ⇒ null). */
  function headerNonce(csp: string): string | null {
    const m = /'nonce-([^']*)'/.exec(csp);
    return m === null ? null : (m[1] as string);
  }

  /**
   * The single `name source…` directive called `name`, or `""` when absent. Every
   * negative assertion goes through this rather than `csp.not.toContain("…")`: a
   * substring check on the whole policy is scoped to nothing, so
   * `not.toContain("script-src 'self' 'unsafe-inline'")` happily passes for the very
   * string it exists to forbid (`script-src 'self' 'nonce-…' 'unsafe-inline'`).
   */
  function directiveOf(csp: string, name: string): string {
    return (
      csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d === name || d.startsWith(`${name} `)) ?? ""
    );
  }

  /**
   * Well-formedness AND tightness, asserted together against EVERY matrix input rather
   * than only the happy path — because both halves of the contract have the same silent
   * failure mode.
   *
   * Structural: every `;`-separated directive is a name plus at least one non-empty
   * source, no directive NAME repeats, and every name is on the allowlist. (Every
   * directive this policy emits carries sources by construction; CSP's valueless
   * directives like `upgrade-insecure-requests` are not part of the shell policy, so
   * "must have ≥1 source" is a statement about THIS policy, not about CSP in general.)
   * A browser that cannot parse a directive may drop it — or the entire policy — and
   * silently hand back the ambient authority the CSP exists to remove.
   *
   * Tightness: every boot-independent directive equals its {@link FIXED_SHELL_DIRECTIVES}
   * entry EXACTLY. Without this the whole file was one-sided — it proved the policy was
   * at least as strict as intended and never that it was no LOOSER, which is the only
   * direction a CSP regresses in.
   *
   * The two BOOT-DEPENDENT directives cannot be pinned to a constant, so they are pinned
   * to their complete shape instead: `script-src` is `'self'` alone or `'self'` plus one
   * full-width minted nonce, and `frame-src` is `'none'` or exactly one `scheme://host`
   * source. That closes the last hole this helper had — two of its call sites pinned only
   * `frame-src`, so a `script-src 'self' 'unsafe-inline'` would have passed them.
   */
  function expectWellFormed(csp: string): void {
    expect(csp).not.toMatch(/;\s*;/);
    // An empty `'nonce-'` token — what a naive interpolation of a blank nonce emits.
    expect(csp).not.toContain("'nonce-'");
    const names: string[] = [];
    for (const directive of csp.split(";")) {
      const trimmed = directive.trim();
      // `name source [source…]`: a leading directive name, then ≥1 non-empty source.
      expect(trimmed).toMatch(/^[a-z-]+ \S[^;]*$/);
      names.push(trimmed.split(" ")[0] as string);
    }
    // A REPEATED directive name is not an error the browser reports — it takes the
    // first occurrence and silently ignores every later one, so an appended
    // `script-src 'unsafe-inline'` reads as harmless while an appended
    // `frame-ancestors *` reads as effective. Neither is something a `.toContain()`
    // on the policy string can see.
    expect(names.length).toBe(new Set(names).size);
    // And a name that is not on the allowlist is either a typo (discarded ⇒ the
    // protection silently evaporates) or a directive nobody reviewed.
    for (const name of names) {
      expect(EXPECTED_DIRECTIVE_NAMES).toContain(name);
    }
    // Every boot-independent directive is PRESENT and is EXACTLY its pinned value —
    // no extra source, no dropped directive, in any of the fail-closed corners either.
    for (const [name, expected] of Object.entries(FIXED_SHELL_DIRECTIVES)) {
      expect(directiveOf(csp, name)).toBe(expected);
    }
    // The two boot-dependent directives, bounded by SHAPE since their value varies:
    // nothing rides along behind the nonce, and nothing rides along behind the origin.
    expect(directiveOf(csp, "script-src")).toMatch(
      /^script-src 'self'( 'nonce-[0-9a-f]{32}')?$/,
    );
    expect(directiveOf(csp, "frame-src")).toMatch(
      /^frame-src ('none'|https?:\/\/[A-Za-z0-9[\]][A-Za-z0-9.:[\]-]*)$/,
    );
  }

  describe("shellCspHeaders (pure builder)", () => {
    test("emits every directive from the verified Ring 2 inventory", () => {
      const csp = shellCspHeaders(NONCE, SANDBOX)["content-security-policy"] ?? "";
      // The ten boot-independent directives are pinned EXACTLY (value and completeness)
      // by `expectWellFormed`; the two boot-dependent ones are pinned here.
      expectWellFormed(csp);
      // The nonce rides on `script-src` and `'unsafe-inline'`/`'unsafe-eval'` are absent —
      // that pairing IS the XSS mitigation; either keyword would make the nonce pointless.
      // `toBe`, so an appended source cannot slip in behind a passing substring check.
      expect(directiveOf(csp, "script-src")).toBe(`script-src 'self' 'nonce-${NONCE}'`);
      expect(csp).not.toContain("'unsafe-eval'");
      expect(directiveOf(csp, "frame-src")).toBe(`frame-src ${SANDBOX}`);
      // Redundant with the exact pins above, kept because they name the specific
      // regressions: a nonce/hash in `style-src` makes `'unsafe-inline'` inert, and ANY
      // remote scheme in `img-src` reopens the no-gesture beacon channel.
      expect(directiveOf(csp, "style-src")).not.toContain("'nonce-");
      expect(directiveOf(csp, "style-src")).not.toContain("'sha");
      expect(directiveOf(csp, "img-src")).not.toMatch(/https?:/);
      // `child-src` is deliberately NOT duplicated — a second copy of the sandbox origin
      // inside a security control is a drift hazard, not a fallback worth having.
      expect(csp).not.toContain("child-src");
      // The directive SET is closed: exactly the twelve names, no thirteenth.
      const names = csp.split(";").map((d) => d.trim().split(" ")[0]);
      expect(names.sort()).toEqual([...EXPECTED_DIRECTIVE_NAMES].sort());
    });

    test("preserves the existing shell header contract and adds the framing guard", () => {
      const h = shellCspHeaders(NONCE, SANDBOX);
      expect(h["content-type"]).toBe("text/html; charset=utf-8");
      // `no-store` keeps the embedded per-boot token out of the on-disk cache — the CSP
      // work must not have dropped it.
      expect(h["cache-control"]).toBe("no-store");
      expect(h["x-content-type-options"]).toBe("nosniff");
      // `frame-ancestors` is the modern control; XFO covers browsers that predate it.
      expect(h["x-frame-options"]).toBe("DENY");
    });

    test("frame-src fails closed to 'none' for an unusable sandbox origin", () => {
      // Exactly the values `buildSandboxIframeAttrs` rejects — both consumers now call
      // the SAME `isUsableSandboxOrigin`, so this loop and the one in
      // `sandbox-host.test.ts` are two views of ONE shared matrix. The interesting
      // members are the hostless and empty-host forms (`"http://"`, `"http://:1234"`,
      // `"http://[:]:80"`): they clear a bare `^https?://` shape test yet would emit
      // sources like `frame-src http://` that are not source expressions at all — and an
      // unparseable directive is exactly the "browser may drop the policy" failure here.
      for (const origin of UNUSABLE_SANDBOX_ORIGINS) {
        const csp = shellCspHeaders(NONCE, origin)["content-security-policy"] ?? "";
        // `toBe`, not `toContain`: the fallback must be the WHOLE directive, so a
        // residue of the rejected value cannot ride along as a second source.
        expect(directiveOf(csp, "frame-src")).toBe("frame-src 'none'");
        // Never a dangling `frame-src;` — the exact malformed output being guarded against.
        expect(csp).not.toContain("frame-src ;");
        expect(csp).not.toContain("frame-src http://;");
        expect(csp).not.toContain("frame-src https://;");
        expectWellFormed(csp);
      }
    });

    // The Ring 1 half of the cross-ring agreement (DW-2 review): every origin the
    // iframe WILL navigate to is admitted verbatim, and admitted alone. Paired with
    // `sandbox-host.test.ts`'s matrix test over the same lists — that pairing is what
    // now enforces the "header and frame reach the same verdict" claim these files make.
    test("a usable sandbox origin is admitted verbatim, and is the only frame-src source", () => {
      for (const origin of USABLE_SANDBOX_ORIGINS) {
        const csp = shellCspHeaders(NONCE, origin)["content-security-policy"] ?? "";
        expect(directiveOf(csp, "frame-src")).toBe(`frame-src ${origin}`);
        expectWellFormed(csp);
      }
    });

    // DW-2 residual, recorded deliberately: on `QS_HOST=::1` / `::` the sandbox origin is
    // a bracketed IPv6 literal, which CSP3's `host-part` grammar (ALPHA / DIGIT / `-`)
    // does not formally admit — Chromium and Gecko accept it, a spec-strict browser would
    // not. The emitted value must nonetheless stay BYTE-IDENTICAL to the iframe `src`:
    // there is no portable CSP spelling for an IPv6 origin, and every alternative is a
    // real loosening. The failure mode on a strict browser is a blank preview pane (the
    // frame is refused) — it fails closed, never open.
    test("an IPv6 sandbox origin is emitted verbatim, byte-identical to the iframe src", () => {
      const origin = "http://[::1]:5555";
      const csp = shellCspHeaders(NONCE, origin)["content-security-policy"] ?? "";
      expect(csp).toContain(`frame-src ${origin}`);
      // The brackets and inner colons must reach the header untouched — a mangled origin
      // would not match the frame's actual origin and would block it, which is the
      // second reason (after the forged-host one) there is no filter in this path.
      expect(directiveOf(csp, "frame-src")).toBe(`frame-src ${origin}`);
      expectWellFormed(csp);
    });

    // The mutation this test exists to kill: gate a REPAIRED origin instead of the raw
    // one. Under the removed character filter every value below survived into a
    // well-formed policy — and the first three into a policy naming a host or a port the
    // input never denoted, which the injected global and the iframe `src` then agreed on.
    // A filter that can hand its caller a valid origin is not a sanitizer, it is a
    // forger; the gate now decides on the raw value and refuses all of these.
    test("a hostile sandbox origin is refused whole — never filtered into a valid one", () => {
      for (const hostile of REPAIRABLE_HOSTILE_SANDBOX_ORIGINS) {
        const csp = shellCspHeaders(NONCE, hostile)["content-security-policy"] ?? "";
        expect(directiveOf(csp, "frame-src")).toBe("frame-src 'none'");
        // No forged second directive, and no fabricated host anywhere in the policy.
        expect(csp).not.toContain("script-src 'unsafe-inline'");
        expect(csp).not.toContain("evil.test");
        expect(csp).toContain(`script-src 'self' 'nonce-${NONCE}'`);
        expectWellFormed(csp);
      }
    });

    test("anything that is not a full minted nonce drops the source entirely", () => {
      // All-or-nothing, and the PARTIAL cases are the point. A filter-and-keep rule
      // ("strip non-hex, use the survivors") fails OPEN precisely where it matters:
      // `"ab;evil cd"` would collapse to a well-formed `'nonce-abecd'` carrying ~20 bits
      // — a valid-looking policy with a brute-forceable nonce. Only a fully-destroyed
      // input would have hit the safe branch. So: valid-or-nothing.
      for (const bad of [
        "", // empty
        "zz;", // no hex at all
        "!!!",
        "ghijklmnop",
        "ab;evil cd", // partially hex — the fail-open case
        'ab"><x cd', // partially hex + an HTML-attribute breakout attempt
        "0123456789abcdef0123456789abcde", // 31 chars: one short of a minted nonce
        "0123456789abcdef0123456789abcdef0", // 33 chars: one long
        "0123456789ABCDEF0123456789ABCDEF", // hex, right width, but not the minted case
        `${NONCE};script-src 'unsafe-inline'`, // directive-injection attempt
      ]) {
        const csp = shellCspHeaders(bad, SANDBOX)["content-security-policy"] ?? "";
        expect(csp).toContain("script-src 'self'");
        // No `'nonce-…'` source of ANY entropy — not a short one, not an empty one.
        expect(csp).not.toContain("'nonce-");
        expect(headerNonce(csp)).toBeNull();
        // The rejected payload leaves no residue at all: `script-src` degrades to exactly
        // the bare `'self'` form, never a forged extra source.
        expect(directiveOf(csp, "script-src")).toBe("script-src 'self'");
        expect(csp).not.toContain("evil");
        expectWellFormed(csp);
      }
    });
  });

  describe("renderIndexHtml nonce injection", () => {
    test("stamps the nonce on all three inline scripts and none on the module tag", () => {
      const html = renderIndexHtml("abc123", { exposed: false, host: "127.0.0.1", port: 80 }, SANDBOX, NONCE);
      // All three inline scripts must carry it — the header's nonce is inert without
      // them, and a missing one means no token / no banner / no sandbox origin.
      expect(html).toContain(`<script nonce="${NONCE}">window.__QS_TOKEN__`);
      expect(html).toContain(`<script nonce="${NONCE}">window.__QS_EXPOSURE__`);
      expect(html).toContain(`<script nonce="${NONCE}">window.__QS_SANDBOX_ORIGIN__`);
      // `/app.js` is external + same-origin, already covered by `script-src 'self'`.
      expect(html).toContain('<script type="module" src="/app.js"></script>');
    });

    test("anything but a full minted nonce omits the attribute rather than emitting nonce=\"\"", () => {
      for (const bad of [
        "",
        "zz;",
        "!!!",
        "ghijklmnop",
        "ab;evil cd", // partially hex — must NOT degrade to a live `nonce="abecd"`
        'ab"><x cd', // partially hex + an attribute breakout attempt
        "0123456789abcdef0123456789abcde", // one char short
        "0123456789abcdef0123456789abcdef0", // one char long
      ]) {
        const html = renderIndexHtml("abc123", EXPOSURE, SANDBOX, bad);
        // `nonce=""` would be an attribute an injected script could trivially replicate,
        // and a SHORT nonce is one it could brute-force — so the fail-closed choice is no
        // attribute at all, matching the builder, which drops the source for the same
        // input. The scripts are then simply refused by the browser: blank UI, not a
        // silently weakened policy.
        expect(html).not.toContain('nonce=""');
        expect(html).not.toContain("nonce=");
        expect(bodyNonce(html)).toBeNull();
        expect(html).toContain("<script>window.__QS_TOKEN__");
        expect(html).toContain("<script>window.__QS_EXPOSURE__");
        expect(html).toContain("<script>window.__QS_SANDBOX_ORIGIN__");
        // The rejected payload never reaches the attribute context.
        expect(html).not.toContain("<x ");
        expect(html).not.toContain("evil");
      }
    });
  });

  describe("nonce contract (mint <-> header <-> body)", () => {
    // The guarantee the shared `safeCspNonce` helper exists to make real: header and
    // body derive their nonce from ONE rule, so they cannot disagree. A disagreement is
    // the silent-breakage mode — a perfectly valid policy in which every inline script
    // is refused: no token, no banner, no UI, and no error anyone reads.
    test("shellCspHeaders and renderIndexHtml agree for every class of input", () => {
      for (const input of [
        mintCspNonce(), // a real minted nonce — must survive on BOTH sides
        "ab;evil cd", // partially filterable — must die on BOTH sides
        "!!!", // fully invalid
        "", // empty
      ]) {
        const csp = shellCspHeaders(input, SANDBOX)["content-security-policy"] ?? "";
        const html = renderIndexHtml("abc123", EXPOSURE, SANDBOX, input);
        // The single assertion that matters: same value, or absent on both sides.
        expect(headerNonce(csp)).toBe(bodyNonce(html));
        expectWellFormed(csp);
      }
    });

    // The mint/consumer contract. Without this, changing `mintCspNonce`'s width, case, or
    // alphabet would pass its own tests, pass every CSP test that uses a hand-written
    // constant, and white-screen the real app — the consumers would silently reject every
    // minted nonce. This is the test that turns that into a red suite instead.
    test("mintCspNonce output always survives into a live source AND a live attribute", () => {
      for (let i = 0; i < 64; i++) {
        const n = mintCspNonce();
        const csp = shellCspHeaders(n, SANDBOX)["content-security-policy"] ?? "";
        const html = renderIndexHtml("abc123", EXPOSURE, SANDBOX, n);
        expect(headerNonce(csp)).toBe(n);
        expect(csp).toContain(`script-src 'self' 'nonce-${n}'`);
        expect(bodyNonce(html)).toBe(n);
        expect(html).toContain(`<script nonce="${n}">window.__QS_TOKEN__`);
        expectWellFormed(csp);
      }
    });
  });

  describe("served shell", () => {
    test("GET / carries the strict CSP header plus the preserved no-store/nosniff contract", async () => {
      const res = await fetch(`${core.url}/`);
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy") ?? "";
      // Same exact pins as the pure builder, asserted on what the SERVER actually
      // emitted — the builder being right is worth nothing if the route serves
      // `htmlHeaders` or a stale precomputed copy.
      expectWellFormed(csp);
      expect(directiveOf(csp, "script-src")).toMatch(/^script-src 'self' 'nonce-[0-9a-f]{32}'$/);
      // The sandbox is a distinct PORT, so `default-src 'self'` would block it — the
      // real bound origin must appear verbatim or the Ring 2 -> Ring 3 loop breaks.
      expect(directiveOf(csp, "frame-src")).toBe(`frame-src ${core.sandboxOrigin}`);
      expect(csp).not.toContain("'unsafe-eval'");
      // `frame-ancestors` is silently ignored in a <meta> policy (Story 6.4 lesson), so
      // the header delivery + the XFO twin are both load-bearing here.
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      // Pre-existing guarantees, unweakened.
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    });

    test("GET /index.html is byte-identical to GET / in both headers and body", async () => {
      // `date` is wall-clock and would differ between two requests; everything else is
      // compared, name AND value. Naming four headers explicitly would let a future
      // alias branch ADD or DROP a fifth (a `set-cookie`, a missing `cache-control`)
      // without a single assertion noticing — the alias must not be a second, weaker
      // code path, so the whole header set is the contract.
      const headerSet = (res: Response): string[] =>
        [...res.headers.entries()]
          .filter(([name]) => name.toLowerCase() !== "date")
          .map(([name, value]) => `${name.toLowerCase()}: ${value}`)
          .sort();

      const [root, alias] = await Promise.all([fetch(`${core.url}/`), fetch(`${core.url}/index.html`)]);
      expect(alias.status).toBe(root.status);
      expect(headerSet(alias)).toEqual(headerSet(root));
      // Sanity: the comparison is not vacuously passing on an empty set.
      expect(headerSet(root)).toContain(`content-security-policy: ${root.headers.get("content-security-policy") as string}`);
      expect(await alias.text()).toBe(await root.text());
    });

    test("the header nonce is exactly the nonce on all three inline scripts", async () => {
      const res = await fetch(`${core.url}/`);
      const csp = res.headers.get("content-security-policy") ?? "";
      const html = await res.text();
      const nonce = bodyNonce(html);
      // A mismatch here is the silent-breakage failure mode: the page loads, the CSP is
      // valid, and every inline script is refused — no token, no UI.
      expect(nonce).not.toBeNull();
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(csp).toContain(`'nonce-${nonce as string}'`);
      expect(html).toContain(`<script nonce="${nonce as string}">window.__QS_TOKEN__`);
      expect(html).toContain(`<script nonce="${nonce as string}">window.__QS_EXPOSURE__`);
      expect(html).toContain(`<script nonce="${nonce as string}">window.__QS_SANDBOX_ORIGIN__`);
      // The nonce and the session token are different secrets of different widths, so
      // `nonce !== token` is true for every value the program can produce and asserts
      // nothing. What IS worth pinning: the token must not have leaked into the response
      // headers. The shell hands it to script via the inline `<script>` and nowhere else,
      // and a header carrying it would put it in every proxy and devtools log.
      for (const [, value] of res.headers.entries()) {
        expect(value).not.toContain(core.token);
      }
    });

    test("a second boot mints a different nonce that never appears in the first boot's shell", async () => {
      const c = await startCore(0);
      try {
        const [a, b] = await Promise.all([
          fetch(`${core.url}/`).then((r) => r.text()),
          fetch(`${c.url}/`).then((r) => r.text()),
        ]);
        const nonceA = bodyNonce(a);
        const nonceB = bodyNonce(b);
        expect(nonceA).not.toBeNull();
        expect(nonceB).not.toBeNull();
        // Per-boot freshness: a nonce leaked from one session must not unlock the next.
        expect(nonceB).not.toBe(nonceA);
        expect(a).not.toContain(nonceB as string);
        expect(b).not.toContain(nonceA as string);
      } finally {
        await c.stop();
      }
    }, 30000);

    test("the shell CSP did not leak onto the separately-contracted /live/<id> page", async () => {
      const pub = await callRpc(core.token, {
        method: "livereport.publish",
        params: {
          schemaVersion: 1,
          blocks: [{ kind: "prose", markdown: "# csp regression" }],
        },
      });
      const reply = await pub.json();
      expect(reply.ok).toBe(true);
      const res = await fetch(`${core.url}${reply.result.path as string}`);
      expect(res.status).toBe(200);
      // AD-3 pins the live page's header contract: `frame-ancestors 'none'` and NOTHING
      // else. The shell policy would break its inlined runtime and inline styles.
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    });
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

// Story 10.4: `table.rows` and `connect` accept an optional `connectionId` and resolve it
// through the SAME per-target pool `execute` uses, so a request can browse a SAVED
// connection instead of the boot one. Driven end-to-end through the real server + gate
// with a fake driver that serves a DIFFERENT catalog per url (no live DB), and an
// Ephemeral (memory-only) credential store so nothing touches disk.
describe("targeted read RPCs resolve by connectionId (Story 10.4)", () => {
  const BOOT_URL = "postgres://bootuser:bootpw@boot-host/bootdb";
  const TARGET_URL = "postgres://targetuser:targetpw@target-host:5432/targetdb";
  /** A saved connection whose driver refuses the handshake (the classified-failure path). */
  const FAILING_URL = "postgres://baduser:badpw@fail-host/db";
  /** A saved connection carrying a PINNED introspection scope (Story 10.2). Its own url,
   *  so scoping it cannot move any other case in this block. */
  const PINNED_URL = "postgres://pinuser:pinpw@pin-host/pindb";
  const PINNED_SCOPE = "reporting";

  /** The boot connection's catalog — `widgets` exists ONLY here. */
  const BOOT_SCHEMA: DatabaseSchema = {
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

  /** The saved target's catalog — `invoices` exists ONLY here, which is what proves routing. */
  const TARGET_SCHEMA: DatabaseSchema = {
    engine: "postgres",
    tables: [
      {
        schema: "public",
        name: "invoices",
        columns: [{ name: "id", dataType: "integer", nullable: false }],
        primaryKey: ["id"],
        indexes: [],
        foreignKeys: [],
      },
    ],
  };

  /** The pinned target's catalog — it SPANS two schemas, so the pin is the only thing
   *  that can hide `public.orders` from a read that resolves through this connection. */
  const PINNED_TARGET_SCHEMA: DatabaseSchema = {
    engine: "postgres",
    tables: [
      {
        schema: "public",
        name: "orders",
        columns: [{ name: "id", dataType: "integer", nullable: false }],
        primaryKey: ["id"],
        indexes: [],
        foreignKeys: [],
      },
      {
        schema: PINNED_SCOPE,
        name: "metrics",
        columns: [{ name: "id", dataType: "integer", nullable: false }],
        primaryKey: ["id"],
        indexes: [],
        foreignKeys: [],
      },
    ],
  };

  async function rpc(target: Core, body: unknown): Promise<Response> {
    return fetch(`${target.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qs-token": target.token },
      body: JSON.stringify(body),
    });
  }

  /**
   * Boot a Core whose fake driver answers per URL, save ONE connection in the registry,
   * and hand the test both the core and that connection's id. `opened` records every url
   * a driver actually opened, so "rejected before any round-trip" is directly assertable;
   * `introspections` counts `listSchema` per url, so a memo hit and a RE-introspection are
   * distinguishable per target (the DW-45 chain, end to end).
   *
   * Each boot gets its OWN mutable catalogs: a `CREATE TABLE` executed through the real
   * `execute` RPC actually changes what that url's next `listSchema` answers, so the whole
   * `execute → invalidateSchema → next getSchema re-introspects` chain runs for real
   * instead of stopping at a fake seam.
   */
  async function withTargetedCore(
    fn: (c: Core, savedId: string, opened: string[], introspections: Record<string, number>) => Promise<void>,
  ): Promise<void> {
    const opened: string[] = [];
    const introspections: Record<string, number> = {};
    const catalogs = new Map<string, DatabaseSchema>([
      [BOOT_URL, BOOT_SCHEMA],
      [TARGET_URL, TARGET_SCHEMA],
      [PINNED_URL, PINNED_TARGET_SCHEMA],
    ]);
    const factory: DriverFactory = (url: string) => {
      const catalog = (): DatabaseSchema => catalogs.get(url) ?? BOOT_SCHEMA;
      return {
        async connect() {
          opened.push(url);
          if (url === FAILING_URL) {
            throw new DriverConnectionError("auth", "the database rejected the provided credentials");
          }
        },
        async listSchema(pinnedSchema?: string) {
          introspections[url] = (introspections[url] ?? 0) + 1;
          const full = catalog();
          // Honor the pin the way a real driver does (Story 10.2): the introspection
          // itself is SCOPED, so an out-of-scope table is simply absent from the catalog
          // every read path validates against. Discarding the argument — as this fake used
          // to — made the 10.2 × 10.4 interaction untestable. Unpinned targets (the boot
          // manager, the `target` connection) are handed `undefined` and see everything,
          // so every other assertion in this block is unaffected.
          if (pinnedSchema === undefined) return full;
          return { ...full, tables: full.tables.filter((t) => t.schema === pinnedSchema) };
        },
        async query(text: string) {
          // The fake's whole DDL vocabulary: `CREATE TABLE <name>` appends to THIS url's
          // catalog, so the next introspection of this target (and only this one) differs.
          const created = /^CREATE TABLE (\w+)/i.exec(text);
          if (created !== null) {
            catalogs.set(url, {
              engine: "postgres",
              tables: [
                ...catalog().tables,
                {
                  schema: "public",
                  name: created[1]!,
                  columns: [{ name: "id", dataType: "integer", nullable: false }],
                  primaryKey: ["id"],
                  indexes: [],
                  foreignKeys: [],
                },
              ],
            });
            return { columns: [], rows: [], rowsAffected: 0 };
          }
          return text.startsWith("SELECT COUNT")
            ? { columns: [{ name: "total" }], rows: [[1]] }
            : { columns: catalog().tables[0]!.columns.map((c) => ({ name: c.name })), rows: [[7]] };
        },
        async queryReadOnly() {
          return { columns: [], rows: [] };
        },
        quoteIdent(ident: string) {
          return `"${ident}"`;
        },
        async close() {},
      };
    };
    // Ephemeral: the credential store is memory-only, so `connections.add` persists nothing.
    const c = await startCore(0, { mode: "ephemeral", databaseUrl: BOOT_URL, createDriver: factory });
    try {
      const added = await (
        await rpc(c, { method: "connections.add", params: { name: "target", url: TARGET_URL } })
      ).json();
      expect(added.ok).toBe(true);
      await fn(c, added.result.id as string, opened, introspections);
    } finally {
      await c.stop();
    }
  }

  test("table.rows with a valid connectionId reads THAT target's catalog, not the boot one", async () => {
    await withTargetedCore(async (c, savedId, opened) => {
      const res = await rpc(c, {
        method: "table.rows",
        params: { schema: "public", table: "invoices", page: 1, pageSize: 10, connectionId: savedId },
      });
      const raw = await res.text();
      expect(res.status).toBe(200);
      const reply = JSON.parse(raw);
      expect(reply.ok).toBe(true);
      // The browse path passes the introspected `SchemaColumnInfo` DESCRIPTORS through, so
      // the column carries the target catalog's own `data_type` alongside the neutral kind.
      expect(reply.result.data.columns).toEqual([
        { name: "id", type: "number", dataType: "integer" },
      ]);
      expect(reply.result.total).toBe(1);
      // The target's driver was opened — and it is the target's URL, resolved in Core.
      expect(opened).toEqual([TARGET_URL]);
      // Credential-free bytes: the resolved url never rides back to the caller.
      expect(raw).not.toContain("targetuser");
      expect(raw).not.toContain("targetpw");
      expect(raw).not.toContain("postgres://");

      // The mirror image: the SAME request without the id validates against the BOOT
      // catalog, where `invoices` does not exist — the byte-identical default path.
      const bootRes = await rpc(c, {
        method: "table.rows",
        params: { schema: "public", table: "invoices", page: 1, pageSize: 10 },
      });
      expect(bootRes.status).toBe(404);
      const bootReply = await bootRes.json();
      expect(bootReply.error.code).toBe("not_found");
      expect(opened).toEqual([TARGET_URL, BOOT_URL]);
    });
  });

  test("connect with a valid connectionId returns THAT target's schema as a normal OK payload", async () => {
    await withTargetedCore(async (c, savedId, opened) => {
      const res = await rpc(c, { method: "connect", params: { connectionId: savedId } });
      const raw = await res.text();
      expect(res.status).toBe(200);
      const reply = JSON.parse(raw);
      expect(reply.ok).toBe(true);
      expect(reply.result).toEqual({ status: "connected", schema: TARGET_SCHEMA });
      expect(opened).toEqual([TARGET_URL]);
      expect(raw).not.toContain("targetuser");
      expect(raw).not.toContain("targetpw");
      expect(raw).not.toContain("postgres://");

      // The paramless call still opens the BOOT connection, unchanged.
      const bootReply = await (await rpc(c, { method: "connect" })).json();
      expect(bootReply.result).toEqual({ status: "connected", schema: BOOT_SCHEMA });
      expect(opened).toEqual([TARGET_URL, BOOT_URL]);
    });
  });

  test("an UNKNOWN connectionId → not_found 'no connection with that id' on both RPCs, nothing opened", async () => {
    await withTargetedCore(async (c, _savedId, opened) => {
      for (const body of [
        { method: "table.rows", params: { table: "invoices", connectionId: "ghost" } },
        { method: "connect", params: { connectionId: "ghost" } },
      ]) {
        const res = await rpc(c, body);
        expect(res.status).toBe(404);
        const reply = await res.json();
        expect(reply.ok).toBe(false);
        expect(reply.error.code).toBe("not_found");
        expect(reply.error.message).toBe("no connection with that id");
        // Neutral: an unknown id never leaks a url or a store detail.
        expect(JSON.stringify(reply.error)).not.toContain("postgres://");
      }
      expect(opened).toEqual([]); // no target — and no fallback to the boot connection
    });
  });

  test("a MALFORMED connectionId → bad_request before any connection round-trip", async () => {
    await withTargetedCore(async (c, _savedId, opened) => {
      for (const body of [
        { method: "table.rows", params: { table: "invoices", connectionId: 5 } },
        { method: "connect", params: { connectionId: 5 } },
      ]) {
        const res = await rpc(c, body);
        expect(res.status).toBe(400);
        const reply = await res.json();
        expect(reply.ok).toBe(false);
        expect(reply.error.code).toBe("bad_request");
        expect(reply.error.message).toContain("'connectionId' must be a string or null");
      }
      // The load-bearing half of "shape-check first": no driver was ever opened.
      expect(opened).toEqual([]);
    });
  });

  test("a targeted connect whose driver fails is a DOMAIN payload, never an error envelope", async () => {
    await withTargetedCore(async (c) => {
      const added = await (
        await rpc(c, { method: "connections.add", params: { name: "broken", url: FAILING_URL } })
      ).json();
      expect(added.ok).toBe(true);

      const res = await rpc(c, { method: "connect", params: { connectionId: added.result.id } });
      const raw = await res.text();
      // A classified driver failure on a RESOLVED target rides inside okReply exactly as
      // it does for the boot connection — never an `internal_error`, never a 500.
      expect(res.status).toBe(200);
      const reply = JSON.parse(raw);
      expect(reply.ok).toBe(true);
      expect(reply.result.status).toBe("failed");
      expect(reply.result.failure).toBe("auth");
      expect(raw).not.toContain("baduser");
      expect(raw).not.toContain("badpw");
    });
  });

  test("a params that is PRESENT but not an object → bad_request, never a silent boot fallback", async () => {
    await withTargetedCore(async (c, savedId, opened) => {
      for (const body of [
        { method: "connect", params: savedId }, // the id sent in the WRONG place
        { method: "connect", params: 7 },
        { method: "connect", params: [savedId] },
        { method: "table.rows", params: "invoices" },
      ]) {
        const res = await rpc(c, body);
        expect(res.status).toBe(400);
        const reply = await res.json();
        expect(reply.ok).toBe(false);
        expect(reply.error.code).toBe("bad_request");
        expect(reply.error.message).toContain("requires a params object");
      }
      // The bug this locks: a non-object `params` used to read as "no connectionId", so
      // `{"method":"connect","params":"<id>"}` cheerfully answered ok:true with the BOOT
      // connection's schema. Nothing may be opened, and nothing may be answered.
      expect(opened).toEqual([]);
    });
  });

  test("connectionId:null is the boot connection — byte-identical to omitting it", async () => {
    await withTargetedCore(async (c, _savedId, opened) => {
      const withNull = await (await rpc(c, { method: "connect", params: { connectionId: null } })).json();
      const bare = await (await rpc(c, { method: "connect" })).json();
      expect(withNull).toEqual(bare);
      expect(withNull.result).toEqual({ status: "connected", schema: BOOT_SCHEMA });
      expect(opened).toEqual([BOOT_URL]); // one boot connection, reused (idempotent)
    });
  });

  // DW-45, END TO END. Every other assertion for it stops at a fake boundary (fake seams in
  // executor.test.ts, a fake driver in connection.test.ts, a fake manager in
  // connection-targets.test.ts), so the composed chain — `execute` RPC → executor →
  // `seams.invalidateSchema()` → the resolved manager → the NEXT read re-introspecting — was
  // never exercised. This block drives it through the real Core.
  test("a table created through the execute RPC appears on the next read of THAT target only", async () => {
    await withTargetedCore(async (c, savedId, _opened, introspections) => {
      const names = (schema: DatabaseSchema): string[] => schema.tables.map((t) => t.name);
      const connect = async (connectionId: string | null) =>
        (await (await rpc(c, { method: "connect", params: { connectionId } })).json()).result.schema as DatabaseSchema;

      // Warm both memos, so any later introspection is unambiguously a RE-introspection.
      expect(names(await connect(savedId))).toEqual(["invoices"]);
      expect(names(await connect(null))).toEqual(["widgets"]);
      expect(introspections[TARGET_URL]).toBe(1);
      expect(introspections[BOOT_URL]).toBe(1);

      const exec = await (
        await rpc(c, {
          method: "execute",
          params: { shape: "raw", sql: "CREATE TABLE receipts (id integer)", confirmed: true, connectionId: savedId },
        })
      ).json();
      expect(exec.ok).toBe(true);
      expect(exec.result.status).toBe("ok");

      // The memo was busted for real: the next connect re-introspects and sees the DDL.
      expect(names(await connect(savedId))).toEqual(["invoices", "receipts"]);
      expect(introspections[TARGET_URL]).toBe(2);

      // …and the bust was SCOPED: the boot catalog served its memo, untouched.
      expect(names(await connect(null))).toEqual(["widgets"]);
      expect(introspections[BOOT_URL]).toBe(1);

      // The refreshed catalog is itself memoized — a second read costs nothing.
      expect(names(await connect(savedId))).toEqual(["invoices", "receipts"]);
      expect(introspections[TARGET_URL]).toBe(2);
    });
  });

  test("N confirmed statements cost ONE re-introspection, not N (the engine is not a catalog read)", async () => {
    await withTargetedCore(async (c, savedId, _opened, introspections) => {
      await rpc(c, { method: "connect", params: { connectionId: savedId } });
      expect(introspections[TARGET_URL]).toBe(1);

      // Five confirmed raw mutations, each busting the target's memo. Every raw execute
      // opens with a `getEngine()` — routing THAT through the memoized catalog made each
      // statement pay a full re-introspection (five on Postgres, serialized in front of it).
      for (let i = 0; i < 5; i++) {
        const reply = await (
          await rpc(c, {
            method: "execute",
            params: { shape: "raw", sql: "UPDATE invoices SET id = id", confirmed: true, connectionId: savedId },
          })
        ).json();
        expect(reply.ok).toBe(true);
      }
      expect(introspections[TARGET_URL]).toBe(1);

      // The busts are real, though: the next actual catalog read pays exactly ONE refresh.
      await rpc(c, { method: "connect", params: { connectionId: savedId } });
      expect(introspections[TARGET_URL]).toBe(2);
    });
  });

  // Story 10.2 × 10.4. `ConnectionSummary.schema` now CLAIMS that a request carrying a
  // `connectionId` honors that connection's pinned introspection scope — the claim decides
  // which catalog a targeted read is validated against, and it held no evidence: the fake
  // driver above discarded the pin. Asserted end to end here, on its own url so the
  // unpinned cases stay byte-identical.
  test("a targeted read honors the saved connection's PINNED schema, per connection", async () => {
    await withTargetedCore(async (c, unpinnedId) => {
      const added = await (
        await rpc(c, {
          method: "connections.add",
          params: { name: "pinned", url: PINNED_URL, schema: PINNED_SCOPE },
        })
      ).json();
      expect(added.ok).toBe(true);
      expect(added.result.schema).toBe(PINNED_SCOPE);
      const pinnedId = added.result.id as string;

      // `public.orders` exists at that url and is absent from what the target answers —
      // the pin is what scoped the introspection the resolved manager ran.
      const reply = await (await rpc(c, { method: "connect", params: { connectionId: pinnedId } })).json();
      expect(reply.ok).toBe(true);
      const qualified = (reply.result.schema as DatabaseSchema).tables.map((t) => `${t.schema}.${t.name}`);
      expect(qualified).toEqual([`${PINNED_SCOPE}.metrics`]);

      // Load-bearing for the read path, not cosmetic: a table outside the pin validates
      // against the SCOPED catalog and is `not_found` — never quietly read anyway.
      const outOfScope = await rpc(c, {
        method: "table.rows",
        params: { schema: "public", table: "orders", page: 1, pageSize: 10, connectionId: pinnedId },
      });
      expect(outOfScope.status).toBe(404);
      expect((await outOfScope.json()).error.code).toBe("not_found");

      // The scope is PER CONNECTION: the unpinned saved target and the paramless boot call
      // still see their whole catalogs, unchanged by another connection's pin.
      const target = await (await rpc(c, { method: "connect", params: { connectionId: unpinnedId } })).json();
      expect(target.result).toEqual({ status: "connected", schema: TARGET_SCHEMA });
      const boot = await (await rpc(c, { method: "connect" })).json();
      expect(boot.result).toEqual({ status: "connected", schema: BOOT_SCHEMA });
    });
  });

  // The chat wiring's `getSchema` lambda (`connectionTargets.resolve` → the typed
  // `NoConnectionTargetError`) lives in `server.ts` and was asserted NOWHERE: `chat.test.ts`
  // stops at a fake `getSchema` seam, and every case above enters through `/rpc`. Driven here
  // through the real `/chat/stream` endpoint.
  //
  // An UNRESOLVABLE id is the half reachable with no network. `prepareRequest` orders
  // provider → message → id shape → `getKey` → `getSchema`, and opens the provider stream
  // only AFTER that: a configured key carries the request past `getKey`, and the resolve miss
  // ends it before any outbound call. The chunk being the pre-flight `bad_request` — not the
  // `internal_error` a real call on this bogus key would yield — is itself that proof.
  test("/chat/stream with an unresolvable connectionId yields the neutral no-connection chunk", async () => {
    await withTargetedCore(async (c, _savedId, opened) => {
      const configured = await (
        await rpc(c, {
          method: "providers.set",
          params: { provider: "anthropic", apiKey: "not-a-real-key" },
        })
      ).json();
      expect(configured.ok).toBe(true);

      const res = await fetch(`${c.url}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-qs-token": c.token },
        body: JSON.stringify({ provider: "anthropic", message: "how many invoices?", connectionId: "ghost" }),
      });
      // A validation failure always rides INSIDE the stream — the status stays 200.
      expect(res.status).toBe(200);
      const raw = await res.text();
      const chunks = raw
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice("data: ".length)));

      // Exactly one terminal error chunk: no delta was committed and no `done` frame closed
      // it, so nothing was streamed from a provider.
      expect(chunks).toEqual([{ type: "error", code: "bad_request", message: "no active connection" }]);
      // Neutral by construction: the unresolvable id never rides back to the caller…
      expect(raw).not.toContain("ghost");
      // …and no driver was opened for a target that does not exist — chat does not fall
      // back to the boot connection when an id was explicitly sent.
      expect(opened).toEqual([]);
    });
  });
});
