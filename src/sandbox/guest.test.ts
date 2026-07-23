/**
 * quick-studio Sandbox (Ring 3) — guest runtime tests.
 *
 * No DOM at test runtime, so every real path is exercised through the pure,
 * injectable `createGuestRouter` (fed STUB `postToParent`/`render`), plus a direct unit
 * test of the injectable `composeRender` (fed a fake {@link RenderHost}). The matrix:
 *  - handshake: the first valid `render` frame pins the parent origin;
 *  - valid `render` -> `ready` then `height`, posted to the pinned origin;
 *  - wrong-origin (post-handshake) frame dropped, no outbound;
 *  - pre-handshake garbage frame dropped WITHOUT pinning;
 *  - `run-query` / `data-request` / unknown / malformed inbound dropped, no outbound;
 *  - a render throw becomes a terse `error` signal (never data);
 *  - `composeRender` clears→prose→chart→measures, and a THROWING chart still measures
 *    a height (prose + inline note rendered, `ready`+`height` never skipped).
 */

import { describe, expect, test } from "bun:test";
import {
  FROZEN_SCHEMA_VERSION,
  SANDBOX_PROTOCOL_VERSION,
  type FrozenData,
  type SandboxOutbound,
  type SandboxRenderDoc,
} from "../shared/contract.ts";
import { composeRender, createGuestRouter, type GuestMessageEvent, type RenderHost } from "./guest.ts";

const PARENT = "http://127.0.0.1:4321";

const fixture: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
  ],
  rows: [
    [{ kind: "number", value: 1 }, { kind: "string", value: "alpha" }],
    [{ kind: "number", value: 2 }, { kind: "string", value: "beta" }],
  ],
};

/** A router wired to stub seams that record every outbound frame + a fixed height.
 *  `isParentSource` accepts every sender by default (source is exercised separately). */
function makeRouter(renderHeight = 240) {
  const sent: Array<{ frame: SandboxOutbound; targetOrigin: string }> = [];
  const rendered: SandboxRenderDoc[] = [];
  const router = createGuestRouter({
    postToParent: (frame, targetOrigin) => sent.push({ frame, targetOrigin }),
    render: (doc) => {
      rendered.push(doc);
      return renderHeight;
    },
    isParentSource: () => true,
  });
  return { router, sent, rendered };
}

/** A valid protocol-2 render frame (escaped markdown + a validated chart naming real columns). */
function renderEvent(origin: string, data: FrozenData): GuestMessageEvent {
  return {
    origin,
    data: {
      type: "render",
      protocolVersion: SANDBOX_PROTOCOL_VERSION,
      markdown: "# hi",
      chart: { mark: "bar", x: "name", y: "id" },
      data,
    },
  };
}

describe("createGuestRouter — handshake + render", () => {
  test("first valid render frame pins the parent origin and emits ready then height", () => {
    const { router, sent, rendered } = makeRouter(300);
    expect(router.pinnedOrigin()).toBeNull();

    router.handleMessage(renderEvent(PARENT, fixture));

    expect(router.pinnedOrigin()).toBe(PARENT);
    expect(rendered).toHaveLength(1);
    // The router forwards the whole validated render doc (markdown + chart + data).
    expect(rendered[0]).toEqual({ markdown: "# hi", chart: { mark: "bar", x: "name", y: "id" }, data: fixture });
    // ready first, then height — both posted to the pinned origin (never "*").
    expect(sent.map((s) => s.frame.type)).toEqual(["ready", "height"]);
    expect(sent.every((s) => s.targetOrigin === PARENT)).toBe(true);
    expect(sent[1]!.frame).toEqual({ type: "height", protocolVersion: SANDBOX_PROTOCOL_VERSION, px: 300 });
  });

  test("a wrong-origin frame AFTER the handshake is dropped with no outbound", () => {
    const { router, sent } = makeRouter();
    router.handleMessage(renderEvent(PARENT, fixture)); // pin
    sent.length = 0;

    router.handleMessage(renderEvent("http://evil.example", fixture));
    expect(sent).toHaveLength(0);
    expect(router.pinnedOrigin()).toBe(PARENT); // pin unchanged
  });

  test("a pre-handshake garbage frame is dropped WITHOUT pinning", () => {
    const { router, sent } = makeRouter();
    // A malformed inbound arriving before the real handshake must not pin an origin.
    router.handleMessage({ origin: "http://evil.example", data: { type: "run-query", sql: "DROP" } });
    expect(sent).toHaveLength(0);
    expect(router.pinnedOrigin()).toBeNull();

    // The real parent's later handshake still pins correctly.
    router.handleMessage(renderEvent(PARENT, fixture));
    expect(router.pinnedOrigin()).toBe(PARENT);
  });

  test("inward capability attempts — run-query / data-request / unknown / malformed — drop with no outbound", () => {
    const { router, sent } = makeRouter();
    const attempts: unknown[] = [
      { type: "run-query", sql: "SELECT 1" },
      { type: "data-request" },
      { type: "render" }, // no data
      { type: "render", protocolVersion: 999, data: fixture }, // wrong version
      { type: "unknown" },
      null,
      "render",
    ];
    for (const data of attempts) {
      router.handleMessage({ origin: PARENT, data });
    }
    expect(sent).toHaveLength(0);
    expect(router.pinnedOrigin()).toBeNull();
  });

  test("a render throw becomes a terse error signal (never data)", () => {
    const sent: Array<{ frame: SandboxOutbound; targetOrigin: string }> = [];
    const router = createGuestRouter({
      postToParent: (frame, targetOrigin) => sent.push({ frame, targetOrigin }),
      render: () => {
        throw new Error("boom drawing");
      },
      isParentSource: () => true,
    });
    router.handleMessage(renderEvent(PARENT, fixture));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.frame).toEqual({
      type: "error",
      protocolVersion: SANDBOX_PROTOCOL_VERSION,
      message: "boom drawing",
    });
    expect(sent[0]!.targetOrigin).toBe(PARENT);
  });

  test("an over-precise date cell is accepted and the data handed to render is floored to milliseconds (DW-6)", () => {
    const { router, sent, rendered } = makeRouter();
    const dateData: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "t", type: "date" }],
      rows: [[{ kind: "date", iso: "2026-07-06T12:00:00.123456Z" }]],
    };
    router.handleMessage({
      origin: PARENT,
      data: {
        type: "render",
        protocolVersion: SANDBOX_PROTOCOL_VERSION,
        markdown: "# hi",
        chart: null,
        data: dateData,
      },
    });
    // The frame is accepted (ready + height emitted, no error)…
    expect(sent.map((s) => s.frame.type)).toEqual(["ready", "height"]);
    // …and render was handed the CANONICALIZED data, not the microsecond string.
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.data.rows[0]?.[0]).toEqual({ kind: "date", iso: "2026-07-06T12:00:00.123Z" });
  });

  test("a message from a NON-parent source is dropped (never handshakes)", () => {
    // Distinct window sentinels: only `parentWin` is the real embedder.
    const parentWin = { role: "parent" };
    const foreignWin = { role: "opener" };
    const sent: Array<{ frame: SandboxOutbound; targetOrigin: string }> = [];
    const router = createGuestRouter({
      postToParent: (frame, targetOrigin) => sent.push({ frame, targetOrigin }),
      render: () => 100,
      isParentSource: (source) => source === parentWin,
    });

    // A perfectly-shaped handshake frame from a non-parent window must not pin or draw.
    router.handleMessage({ source: foreignWin, ...renderEvent(PARENT, fixture) });
    expect(sent).toHaveLength(0);
    expect(router.pinnedOrigin()).toBeNull();

    // The real parent's identical frame still pins + emits ready/height.
    router.handleMessage({ source: parentWin, ...renderEvent(PARENT, fixture) });
    expect(router.pinnedOrigin()).toBe(PARENT);
    expect(sent.map((s) => s.frame.type)).toEqual(["ready", "height"]);
  });
});

describe("composeRender — clear → prose → chart(-or-error) → measure", () => {
  /** A fake {@link RenderHost} recording the compose sequence; `chartThrows` forces a Plot throw. */
  function makeHost(chartThrows = false, measured = 321) {
    const calls: string[] = [];
    let proseHtml: string | null = null;
    let errorNote: string | null = null;
    const host: RenderHost = {
      reset: () => calls.push("reset"),
      appendProse: (html) => {
        calls.push("prose");
        proseHtml = html;
      },
      appendChartNode: () => {
        calls.push("chart");
        if (chartThrows) throw new TypeError("bad channel type");
      },
      appendErrorNote: (message) => {
        calls.push("error-note");
        errorNote = message;
      },
      measure: () => {
        calls.push("measure");
        return measured;
      },
    };
    return { host, calls, proseHtml: () => proseHtml, errorNote: () => errorNote };
  }

  const chartDoc: SandboxRenderDoc = {
    markdown: "# hi",
    chart: { mark: "bar", x: "name", y: "id" },
    data: fixture,
  };

  test("composes clear → prose → chart → measure for a valid chart, returning the height", () => {
    const { host, calls, proseHtml } = makeHost(false, 500);
    const px = composeRender(chartDoc, host);
    expect(px).toBe(500);
    expect(calls).toEqual(["reset", "prose", "chart", "measure"]);
    expect(proseHtml()).toContain("<h1>hi</h1>"); // escaped-markdown prose
  });

  test("prose-only doc (chart:null) skips the chart node entirely", () => {
    const { host, calls } = makeHost();
    composeRender({ markdown: "just prose", chart: null, data: fixture }, host);
    expect(calls).toEqual(["reset", "prose", "measure"]);
  });

  test("a THROWING chart (P4) still measures a height — prose + an inline note render, height never skipped", () => {
    const { host, calls, errorNote } = makeHost(true, 240);
    const px = composeRender(chartDoc, host);
    // The Plot throw did NOT bubble out: the frame gets a measured height so ready+height fire.
    expect(px).toBe(240);
    expect(calls).toEqual(["reset", "prose", "chart", "error-note", "measure"]);
    expect(errorNote()).toContain("bad channel type");
  });
});
