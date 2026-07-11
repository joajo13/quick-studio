/**
 * quick-studio Sandbox (Ring 3) — guest runtime tests.
 *
 * No DOM at test runtime, so every real path is exercised through the pure,
 * injectable `createGuestRouter` (fed STUB `postToParent`/`render`), plus direct
 * unit tests of `buildFrozenHtml` and `resolveDatumClick`. The matrix:
 *  - handshake: the first valid `render` frame pins the parent origin;
 *  - valid `render` -> `ready` then `height`, posted to the pinned origin;
 *  - wrong-origin (post-handshake) frame dropped, no outbound;
 *  - pre-handshake garbage frame dropped WITHOUT pinning;
 *  - `run-query` / `data-request` / unknown / malformed inbound dropped, no outbound;
 *  - a render throw becomes a terse `error` signal (never data);
 *  - `handleClick` emits `datum-clicked` for a cell and drops an off-grid / pre-pin click;
 *  - `resolveDatumClick` maps a cell to `{row,col}` and returns null off-grid;
 *  - `buildFrozenHtml` emits `data-row`/`data-col` cells and escapes markup.
 */

import { describe, expect, test } from "bun:test";
import {
  FROZEN_SCHEMA_VERSION,
  SANDBOX_PROTOCOL_VERSION,
  type FrozenData,
  type SandboxOutbound,
} from "../shared/contract.ts";
import {
  buildFrozenHtml,
  createGuestRouter,
  resolveDatumClick,
  type DatumElement,
  type GuestMessageEvent,
} from "./guest.ts";

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
  const rendered: FrozenData[] = [];
  const router = createGuestRouter({
    postToParent: (frame, targetOrigin) => sent.push({ frame, targetOrigin }),
    render: (data) => {
      rendered.push(data);
      return renderHeight;
    },
    isParentSource: () => true,
  });
  return { router, sent, rendered };
}

function renderEvent(origin: string, data: FrozenData): GuestMessageEvent {
  return { origin, data: { type: "render", protocolVersion: SANDBOX_PROTOCOL_VERSION, data } };
}

describe("createGuestRouter — handshake + render", () => {
  test("first valid render frame pins the parent origin and emits ready then height", () => {
    const { router, sent, rendered } = makeRouter(300);
    expect(router.pinnedOrigin()).toBeNull();

    router.handleMessage(renderEvent(PARENT, fixture));

    expect(router.pinnedOrigin()).toBe(PARENT);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toEqual(fixture);
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

describe("createGuestRouter — handleClick", () => {
  /** A minimal element carrying data-row/data-col (and an optional parent chain). */
  function cell(row: string | null, col: string | null, parent: DatumElement | null = null): DatumElement {
    return {
      getAttribute: (name) => (name === "data-row" ? row : name === "data-col" ? col : null),
      parentElement: parent,
    };
  }

  test("a cell click after handshake emits datum-clicked to the pinned origin", () => {
    const { router, sent } = makeRouter();
    router.handleMessage(renderEvent(PARENT, fixture));
    sent.length = 0;

    router.handleClick(cell("1", "0"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.frame).toEqual({
      type: "datum-clicked",
      protocolVersion: SANDBOX_PROTOCOL_VERSION,
      row: 1,
      col: 0,
    });
    expect(sent[0]!.targetOrigin).toBe(PARENT);
  });

  test("an off-grid click emits nothing", () => {
    const { router, sent } = makeRouter();
    router.handleMessage(renderEvent(PARENT, fixture));
    sent.length = 0;
    router.handleClick(cell(null, null));
    router.handleClick(null);
    expect(sent).toHaveLength(0);
  });

  test("a click before any handshake is dropped (no parent pinned)", () => {
    const { router, sent } = makeRouter();
    router.handleClick(cell("0", "0"));
    expect(sent).toHaveLength(0);
  });
});

describe("resolveDatumClick", () => {
  function el(attrs: Record<string, string>, parent: DatumElement | null = null): DatumElement {
    return { getAttribute: (name) => attrs[name] ?? null, parentElement: parent };
  }

  test("maps a data-cell element to its {row,col}", () => {
    expect(resolveDatumClick(el({ "data-row": "3", "data-col": "2" }))).toEqual({ row: 3, col: 2 });
  });

  test("walks up to an ancestor cell when the click lands on a descendant", () => {
    const parent = el({ "data-row": "5", "data-col": "1" });
    const child = el({}, parent);
    expect(resolveDatumClick(child)).toEqual({ row: 5, col: 1 });
  });

  test("returns null off-grid (no data attributes anywhere up the chain)", () => {
    expect(resolveDatumClick(el({}))).toBeNull();
    expect(resolveDatumClick(null)).toBeNull();
  });

  test("returns null for a malformed coordinate", () => {
    expect(resolveDatumClick(el({ "data-row": "x", "data-col": "2" }))).toBeNull();
    expect(resolveDatumClick(el({ "data-row": "-1", "data-col": "0" }))).toBeNull();
  });

  test("rejects empty and hex-like attrs (no bogus 0 / 31 coercion)", () => {
    // Strict decimal-only parse: `""`→0 and `"0x1f"`→31 must NOT forge a cell.
    expect(resolveDatumClick(el({ "data-row": "", "data-col": "0" }))).toBeNull();
    expect(resolveDatumClick(el({ "data-row": "0", "data-col": "" }))).toBeNull();
    expect(resolveDatumClick(el({ "data-row": "0x1f", "data-col": "0" }))).toBeNull();
    expect(resolveDatumClick(el({ "data-row": "1", "data-col": " 2 " }))).toBeNull();
    // A clean decimal pair still resolves.
    expect(resolveDatumClick(el({ "data-row": "0", "data-col": "0" }))).toEqual({ row: 0, col: 0 });
  });
});

describe("buildFrozenHtml", () => {
  test("emits a data-row/data-col cell for every datum", () => {
    const html = buildFrozenHtml(fixture);
    expect(html).toContain('<td data-row="0" data-col="0">1</td>');
    expect(html).toContain('<td data-row="0" data-col="1">alpha</td>');
    expect(html).toContain('<td data-row="1" data-col="0">2</td>');
    expect(html).toContain('<td data-row="1" data-col="1">beta</td>');
    // Column headers render (no data-* on the header row).
    expect(html).toContain("<th>id</th>");
    expect(html).toContain("<th>name</th>");
  });

  test("HTML-escapes cell + column text so a value can never inject markup", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "<script>", type: "string" }],
      rows: [[{ kind: "string", value: "</td><img src=x>" }]],
    };
    const html = buildFrozenHtml(data);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;/td&gt;&lt;img src=x&gt;");
  });

  test("renders a null cell as an empty cell and a date as its iso string", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "at", type: "date" }, { name: "gone", type: "null" }],
      rows: [[{ kind: "date", iso: "2026-07-06T12:00:00Z" }, { kind: "null" }]],
    };
    const html = buildFrozenHtml(data);
    expect(html).toContain('<td data-row="0" data-col="0">2026-07-06T12:00:00Z</td>');
    expect(html).toContain('<td data-row="0" data-col="1"></td>');
  });
});
