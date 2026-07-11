/**
 * quick-studio Sandbox (Ring 3) — the adversarial CONTAINMENT BATTERY (Story 5.5).
 *
 * The boundary is the browser; `bun test` has no DOM and the repo has no headless
 * harness, so this battery proves the two things that ARE in-repo-verifiable:
 *  (a) the exact CSP/route CONFIGURATION the sandbox origin serves (live server),
 *  (b) the iframe ATTRS the host builds exclude `allow-same-origin`,
 *  (c) the guest ROUTER drops wrong-origin + run-query/data-request/unknown inbound
 *      and emits no data,
 *  (d) the host ROUTER drops non-iframe-source messages and has no data-reply path,
 *  (e) a TYPE-LEVEL proof that `SandboxOutbound` cannot carry `FrozenData` or a query.
 * The browser's live enforcement of `sandbox`/CSP is covered by the documented manual
 * check and noted as residual (same posture as 5.4's no-live-integration note).
 *
 * Ring discipline: this file is inside `src/sandbox/`, which may import ONLY
 * `src/shared`. The cross-ring modules it must EXERCISE (the Core sandbox server, the
 * Ring 2 host) are pulled via dynamic `import()` inside the relevant tests — never a
 * static top-level cross-ring import — so the ring-discipline grep stays clean.
 */

import { describe, expect, test } from "bun:test";
import {
  FROZEN_SCHEMA_VERSION,
  SANDBOX_PROTOCOL_VERSION,
  type FrozenData,
  type SandboxOutbound,
} from "../shared/contract.ts";
import { createGuestRouter, type GuestMessageEvent } from "./guest.ts";

const fixture: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [{ name: "id", type: "number" }],
  rows: [[{ kind: "number", value: 1 }]],
};

/* (a) The live sandbox origin serves only the guest doc + bundle, under the CSP. --- */
describe("(a) cross-origin server config — egress blocked, no data endpoints, no token", () => {
  test("guest doc carries default-src/connect-src 'none'; /rpc & /chat/stream are 404; no token", async () => {
    const { startSandboxServer } = await import("../core/sandbox-server.ts");
    const server = startSandboxServer({ host: "127.0.0.1", port: 0, bundle: { js: "/* guest */" } });
    try {
      const doc = await fetch(`${server.origin}/`);
      expect(doc.status).toBe(200);
      const csp = doc.headers.get("content-security-policy") ?? "";
      // Story 5.6 security invariant: the guest CSP is byte-for-byte the Story-5.5 string —
      // rich rendering is done by the TRUSTED bundle over declarative inputs, so the boundary
      // NEVER widens. Asserting EXACT equality (not just substrings) makes ANY accidental
      // widening — a new source, a relaxed directive, an added `unsafe-eval` — fail here.
      const STORY_5_5_GUEST_CSP =
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
      expect(csp).toBe(STORY_5_5_GUEST_CSP);
      // Redundant explicit guards, kept for intent even though equality already implies them.
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'none'"); // the egress block
      expect(csp).not.toContain("unsafe-eval");
      const body = await doc.text();
      expect(body).not.toContain("__QS_TOKEN__");
      expect(body).not.toContain("x-qs-token");

      // The sandbox origin exposes NO data endpoints — every escape route is 404.
      expect((await fetch(`${server.origin}/rpc`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${server.origin}/chat/stream`)).status).toBe(404);
      expect((await fetch(`${server.origin}/chat/stream`, { method: "POST" })).status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

/* (b) The iframe attrs never re-grant same-origin. ----------------------------------- */
describe("(b) iframe attrs exclude allow-same-origin", () => {
  test("buildSandboxIframeAttrs yields exactly allow-scripts", async () => {
    const { buildSandboxIframeAttrs } = await import("../ui/sandbox/sandbox-host.ts");
    const attrs = buildSandboxIframeAttrs("http://127.0.0.1:5555");
    expect(attrs.sandbox).toBe("allow-scripts");
    expect(attrs.sandbox).not.toContain("allow-same-origin");
  });
});

/* (c) The guest router refuses every inward capability attempt. ---------------------- */
describe("(c) guest router — inward capability & wrong-origin attempts drop with no data out", () => {
  function makeRouter() {
    const sent: SandboxOutbound[] = [];
    const router = createGuestRouter({
      postToParent: (frame) => sent.push(frame),
      render: () => 100,
      isParentSource: () => true,
    });
    return { router, sent };
  }

  test("run-query / data-request / unknown / malformed inbound are dropped, nothing emitted", () => {
    const { router, sent } = makeRouter();
    const attempts: unknown[] = [
      { type: "run-query", sql: "SELECT secret FROM keys" },
      { type: "data-request", table: "keys" },
      { type: "execute", op: {} },
      { type: "render", protocolVersion: 1, markdown: "", chart: null, data: fixture }, // old/wrong version
      { type: "render", protocolVersion: SANDBOX_PROTOCOL_VERSION, chart: null, data: fixture }, // no markdown
      { type: "render" }, // no data
      { nope: true },
      null,
    ];
    for (const data of attempts) router.handleMessage({ origin: "http://127.0.0.1:4321", data });
    expect(sent).toHaveLength(0);
    expect(router.pinnedOrigin()).toBeNull(); // none of them pinned an origin
  });

  test("a wrong-origin frame after the handshake is dropped", () => {
    const { router, sent } = makeRouter();
    const pin: GuestMessageEvent = {
      origin: "http://127.0.0.1:4321",
      data: { type: "render", protocolVersion: SANDBOX_PROTOCOL_VERSION, markdown: "", chart: null, data: fixture },
    };
    router.handleMessage(pin); // pins + emits ready/height
    sent.length = 0;
    router.handleMessage({ ...pin, origin: "http://evil.example" });
    expect(sent).toHaveLength(0);
  });
});

/* (d) The host router refuses a spoofed source and has no data-reply path. ------------ */
describe("(d) host router — spoofed source dropped, no data ever returned", () => {
  test("a message from a foreign event.source routes nothing", async () => {
    const { createSandboxHost } = await import("../ui/sandbox/sandbox-host.ts");
    const iframe = { postMessage: () => {} };
    const signals: SandboxOutbound[] = [];
    const host = createSandboxHost({ iframeWindow: iframe, onSignal: (s) => signals.push(s) });
    // Correctly-shaped signal, but from an impostor window → dropped by the identity gate.
    host.handleMessage({
      source: { impostor: true },
      origin: "null",
      data: { type: "ready", protocolVersion: SANDBOX_PROTOCOL_VERSION },
    });
    expect(signals).toHaveLength(0);
  });

  test("the host never posts anything back in response to a guest message (no data reply)", async () => {
    const { createSandboxHost } = await import("../ui/sandbox/sandbox-host.ts");
    const posts: unknown[] = [];
    const iframe = { postMessage: (m: unknown) => posts.push(m) };
    const host = createSandboxHost({ iframeWindow: iframe, onSignal: () => {} });
    host.handleMessage({
      source: iframe,
      origin: "null",
      data: { type: "datum-clicked", protocolVersion: SANDBOX_PROTOCOL_VERSION, row: 0, col: 0 },
    });
    // Routing a guest signal must NEVER cause a post back — there is no reply channel.
    expect(posts).toHaveLength(0);
  });
});

/* (e) Type-level proof: the outbound union structurally cannot carry data or a query. - */
describe("(e) SandboxOutbound cannot structurally express data or a query", () => {
  test("no data-carrying field exists on any union member (compile-time enforced)", () => {
    // Union-distributed key set of every SandboxOutbound member.
    type AllKeys<T> = T extends unknown ? keyof T : never;
    type OutboundFieldKeys = AllKeys<SandboxOutbound>;
    // If a `data`/`sql`/`query`/`rows` field ever leaked into the union, this Exclude
    // would no longer be `never` and the assignment below would fail `tsc --noEmit`.
    type NonSignalKeys = Exclude<
      OutboundFieldKeys,
      "type" | "protocolVersion" | "px" | "row" | "col" | "message"
    >;
    const _noDataField: [NonSignalKeys] extends [never] ? true : false = true;
    expect(_noDataField).toBe(true);

    // Excess-property proof: a data payload is not assignable to any member.
    // @ts-expect-error — `data` is not a field of any SandboxOutbound member.
    const _illegalData: SandboxOutbound = { type: "ready", protocolVersion: SANDBOX_PROTOCOL_VERSION, data: fixture };
    // @ts-expect-error — a query field is likewise unrepresentable.
    const _illegalQuery: SandboxOutbound = { type: "ready", protocolVersion: SANDBOX_PROTOCOL_VERSION, query: "SELECT 1" };
    void _illegalData;
    void _illegalQuery;
  });
});
