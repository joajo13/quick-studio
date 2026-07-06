/**
 * quick-studio Core — server-level shutdown-RPC wiring tests.
 *
 * Locks the story-1.5-specific behaviors a pure `dispatch` test cannot reach:
 * `startCore` routes the `shutdown` RPC to the injected `onShutdownRequested`,
 * deferred to a macrotask so the ack flushes first; the gates still guard it;
 * and importing/booting `startCore` never reaches `process.exit` (the runner
 * surviving these tests is that assertion).
 *
 * One shared boot: `startCore` runs `buildUiBundle` (a full Tailwind build) on
 * every call, so booting once keeps the suite fast — hence a generous
 * `beforeAll` timeout and sequential assertions on a single Core.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderIndexHtml, startCore, type Core } from "./server.ts";

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
