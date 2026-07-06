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

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCore, type Core } from "./server.ts";

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
