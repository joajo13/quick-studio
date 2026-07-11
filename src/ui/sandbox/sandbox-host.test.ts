/**
 * quick-studio UI (Ring 2) — sandbox host controller tests.
 *
 * No DOM at test runtime, so the controller is driven through the pure, injectable
 * `createSandboxHost` (fed a STUB `iframeWindow` + `onSignal`) and the pure
 * `buildSandboxIframeAttrs`. The matrix:
 *  - pushData posts a `render` frame to the iframe window with targetOrigin "*";
 *  - a valid SandboxOutbound from the iframe source + opaque origin routes to onSignal;
 *  - a message from a FOREIGN event.source is dropped (spoofed-host containment);
 *  - a non-opaque origin is dropped (identity+origin gate);
 *  - a malformed / data-shaped payload is dropped (no data-reply path);
 *  - after dispose(), pushData/handleMessage are inert;
 *  - buildSandboxIframeAttrs yields `allow-scripts` and NEVER `allow-same-origin`.
 */

import { describe, expect, test } from "bun:test";
import {
  FROZEN_SCHEMA_VERSION,
  SANDBOX_PROTOCOL_VERSION,
  type FrozenData,
  type SandboxOutbound,
} from "../../shared/contract.ts";
import {
  buildSandboxIframeAttrs,
  createSandboxHost,
  type HostMessageEvent,
  type PostMessageTarget,
} from "./sandbox-host.ts";

const fixture: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [{ name: "id", type: "number" }],
  rows: [[{ kind: "number", value: 1 }]],
};

/** A stub iframe window recording every posted (message, targetOrigin) pair. */
function makeIframe(): PostMessageTarget & { posts: Array<{ message: unknown; targetOrigin: string }> } {
  const posts: Array<{ message: unknown; targetOrigin: string }> = [];
  return {
    posts,
    postMessage: (message, targetOrigin) => posts.push({ message, targetOrigin }),
  };
}

describe("createSandboxHost — pushData", () => {
  test("posts a render frame to the iframe window with targetOrigin '*'", () => {
    const iframe = makeIframe();
    const host = createSandboxHost({ iframeWindow: iframe, onSignal: () => {} });
    host.pushData(fixture);
    expect(iframe.posts).toHaveLength(1);
    expect(iframe.posts[0]!.targetOrigin).toBe("*");
    expect(iframe.posts[0]!.message).toEqual({
      type: "render",
      protocolVersion: SANDBOX_PROTOCOL_VERSION,
      data: fixture,
    });
  });
});

describe("createSandboxHost — handleMessage", () => {
  const ready: SandboxOutbound = { type: "ready", protocolVersion: SANDBOX_PROTOCOL_VERSION };

  function evt(over: Partial<HostMessageEvent>, source: unknown): HostMessageEvent {
    return { source, origin: "null", data: ready, ...over };
  }

  test("routes a valid outbound from the iframe source + opaque origin to onSignal", () => {
    const iframe = makeIframe();
    const signals: SandboxOutbound[] = [];
    const host = createSandboxHost({ iframeWindow: iframe, onSignal: (s) => signals.push(s) });
    const clicked: SandboxOutbound = { type: "datum-clicked", protocolVersion: SANDBOX_PROTOCOL_VERSION, row: 1, col: 0 };
    host.handleMessage({ source: iframe, origin: "null", data: clicked });
    expect(signals).toEqual([clicked]);
  });

  test("drops a message from a FOREIGN event.source (spoofed-host containment)", () => {
    const iframe = makeIframe();
    const signals: SandboxOutbound[] = [];
    const host = createSandboxHost({ iframeWindow: iframe, onSignal: (s) => signals.push(s) });
    host.handleMessage(evt({}, { not: "the iframe" }));
    expect(signals).toHaveLength(0);
  });

  test("drops a message whose origin is not the opaque 'null'", () => {
    const iframe = makeIframe();
    const signals: SandboxOutbound[] = [];
    const host = createSandboxHost({ iframeWindow: iframe, onSignal: (s) => signals.push(s) });
    host.handleMessage({ source: iframe, origin: "http://evil.example", data: ready });
    expect(signals).toHaveLength(0);
  });

  test("drops a malformed / data-shaped payload (no data-reply path)", () => {
    const iframe = makeIframe();
    const signals: SandboxOutbound[] = [];
    const host = createSandboxHost({ iframeWindow: iframe, onSignal: (s) => signals.push(s) });
    // A frame trying to smuggle data back is not a valid SandboxOutbound → dropped.
    host.handleMessage({ source: iframe, origin: "null", data: { type: "render", data: fixture } });
    host.handleMessage({ source: iframe, origin: "null", data: { type: "unknown" } });
    expect(signals).toHaveLength(0);
  });

  test("drops a source:null message when the iframe window is itself nullish", () => {
    // A spoofed `source: null` must NOT satisfy the identity gate when `iframeWindow`
    // is nullish — the non-nullish guard closes that null-equals-null hole.
    const signals: SandboxOutbound[] = [];
    const host = createSandboxHost({
      iframeWindow: null as unknown as PostMessageTarget,
      onSignal: (s) => signals.push(s),
    });
    host.handleMessage({ source: null, origin: "null", data: ready });
    expect(signals).toHaveLength(0);
  });

  test("after dispose(), handleMessage and pushData are inert", () => {
    const iframe = makeIframe();
    const signals: SandboxOutbound[] = [];
    const host = createSandboxHost({ iframeWindow: iframe, onSignal: (s) => signals.push(s) });
    host.dispose();
    host.pushData(fixture);
    host.handleMessage({ source: iframe, origin: "null", data: ready });
    expect(iframe.posts).toHaveLength(0);
    expect(signals).toHaveLength(0);
  });
});

describe("buildSandboxIframeAttrs", () => {
  test("yields allow-scripts and never allow-same-origin", () => {
    const attrs = buildSandboxIframeAttrs("http://127.0.0.1:5555");
    expect(attrs.src).toBe("http://127.0.0.1:5555");
    expect(attrs.sandbox).toBe("allow-scripts");
    // The sacred negative: the sandbox token list must never re-grant same-origin.
    expect(attrs.sandbox).not.toContain("allow-same-origin");
  });

  test("an empty or non-http origin falls back to about:blank — never ''", () => {
    // `src=""` resolves to the parent Core document (the token-bearing page) — the
    // opposite of containment. An empty/garbage origin must yield about:blank.
    for (const bad of ["", "   ", "javascript:alert(1)", "//evil.example", "ftp://x"]) {
      const attrs = buildSandboxIframeAttrs(bad);
      expect(attrs.src).toBe("about:blank");
      expect(attrs.sandbox).toBe("allow-scripts");
    }
    // A valid https origin is passed through verbatim.
    expect(buildSandboxIframeAttrs("https://127.0.0.1:5555").src).toBe("https://127.0.0.1:5555");
  });
});
