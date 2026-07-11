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
import { renderIndexHtml, startCore, type Core } from "./server.ts";
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
});

describe("renderIndexHtml exposure injection", () => {
  test("carries exposed:true and the bound host into the served HTML", () => {
    const html = renderIndexHtml("abc123", { exposed: true, host: "0.0.0.0", port: 4321 });
    expect(html).toContain("window.__QS_EXPOSURE__");
    expect(html).toContain('"exposed":true');
    expect(html).toContain('"host":"0.0.0.0"');
    expect(html).toContain('"port":4321');
  });

  test("script-escapes an untrusted host so it cannot break out of <script>", () => {
    const html = renderIndexHtml("abc123", {
      exposed: true,
      host: "</script><script>alert(1)</script>",
      port: 80,
    });
    // The literal `</script>` sequence must never appear unescaped in the shell.
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("\\u003c");
  });
});
