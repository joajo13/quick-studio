/**
 * Unit tests for the Ring-2 Live Report export (Story 6.4): the SQL-only block-mapping matrix,
 * the no-secret/no-data HTML, `publishAndOpen`, the `runExport` publish/fetch/error paths, and
 * the deterministic filename. Click-driven coverage lives here (this repo has no jsdom) —
 * `runExport` is injectable so it needs no DOM.
 */

import { describe, expect, mock, test } from "bun:test";
import { FROZEN_SCHEMA_VERSION, okReply, errorReply, type FrozenData, type LiveReportPublishResult, type RpcReply } from "../../shared/contract.ts";
import { LIVE_REPORT_SCHEMA_VERSION } from "../../shared/live-report.ts";
import type { ReportBlock } from "./report-state.ts";
import {
  buildLiveReportHtml,
  liveReportFilename,
  publishAndOpen,
  runExport,
  toLiveReportBlock,
  toLiveReportDoc,
} from "./export-live-report.ts";

const numData: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [
    { name: "k", type: "number" },
    { name: "v", type: "number" },
  ],
  rows: [[{ kind: "number", value: 1 }, { kind: "number", value: 10 }]],
};

function queryBlock(overrides: Partial<Extract<ReportBlock, { kind: "query" }>>): ReportBlock {
  return { id: 1, kind: "query", sql: "select k, v", result: null, view: "table", chart: null, ...overrides };
}

const okPublish = (path = "/live/abc"): RpcReply<LiveReportPublishResult> => okReply({ path });

describe("toLiveReportBlock (mapping matrix)", () => {
  test("prose → prose", () => {
    expect(toLiveReportBlock({ id: 1, kind: "prose", markdown: "# hi" })).toEqual({ kind: "prose", markdown: "# hi" });
  });

  test("query (non-blank sql) → query with sql+view+chart and NO data/encode", () => {
    const out = toLiveReportBlock(
      queryBlock({ sql: "select k, v", view: "chart", chart: { mark: "line", x: "k", y: "v" }, result: numData }),
    );
    expect(out).toEqual({ kind: "query", sql: "select k, v", view: "chart", chart: { mark: "line", x: "k", y: "v" } });
    // No data field carried.
    expect(Object.prototype.hasOwnProperty.call(out, "data")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, "result")).toBe(false);
  });

  test("query (blank sql) → empty('no query')", () => {
    expect(toLiveReportBlock(queryBlock({ sql: "   " }))).toEqual({ kind: "empty", note: "no query" });
  });
});

describe("toLiveReportDoc", () => {
  test("stamps the schema version and maps every block; carries the chart spec", () => {
    const doc = toLiveReportDoc([
      { id: 1, kind: "prose", markdown: "a" },
      queryBlock({ id: 2, sql: "select k, v", view: "chart", chart: { mark: "bar", x: "k", y: "v" } }),
      queryBlock({ id: 3, sql: "" }),
    ]);
    expect(doc.schemaVersion).toBe(LIVE_REPORT_SCHEMA_VERSION);
    expect(doc.blocks.map((b) => b.kind)).toEqual(["prose", "query", "empty"]);
    const q = doc.blocks[1]!;
    if (q.kind === "query") expect(q.chart).toEqual({ mark: "bar", x: "k", y: "v" });
  });
});

describe("buildLiveReportHtml", () => {
  test("embeds the SQL but NO FrozenData / rows / __QS_TOKEN__ / credential", () => {
    const html = buildLiveReportHtml([queryBlock({ sql: "select secret from t", result: numData })], "/* rt */");
    expect(html).toContain("select secret from t");
    expect(html).not.toContain("__QS_TOKEN__");
    expect(html).not.toContain('"columns"');
    expect(html).not.toContain('"rows"');
    expect(html).not.toContain("postgres://");
    // Live egress boundary present (not the snapshot's 'none').
    expect(html).toContain("connect-src 'self'");
  });
});

/** A distinct opaque window handle for the two-phase seam (a real `Window` in the app). */
type FakeWin = { readonly id: string };
const aWindow: FakeWin = { id: "w" };

describe("publishAndOpen", () => {
  test("calls rpc('livereport.publish', doc) then navigates the reserved window to the path", async () => {
    const rpc = mock(
      async (_method: string, _params: unknown): Promise<RpcReply<LiveReportPublishResult>> => okPublish("/live/xyz"),
    );
    const navigate = mock((_h: FakeWin, _path: string) => {});
    const closeWindow = mock((_h: FakeWin) => {});
    const out = await publishAndOpen({ blocks: [{ id: 1, kind: "prose", markdown: "hi" }], rpc, handle: aWindow, navigate, closeWindow });
    expect(out).toEqual({ popupBlocked: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![0]).toBe("livereport.publish");
    expect((rpc.mock.calls[0]![1] as { schemaVersion: number }).schemaVersion).toBe(LIVE_REPORT_SCHEMA_VERSION);
    expect(navigate).toHaveBeenCalledWith(aWindow, "/live/xyz");
    expect(closeWindow).not.toHaveBeenCalled();
  });

  test("a null handle (popup blocked) → reports popupBlocked, never navigates", async () => {
    const rpc = mock(async (): Promise<RpcReply<LiveReportPublishResult>> => okPublish("/live/xyz"));
    const navigate = mock((_h: FakeWin, _path: string) => {});
    const out = await publishAndOpen({ blocks: [], rpc, handle: null, navigate, closeWindow: () => {} });
    expect(out).toEqual({ popupBlocked: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  test("a failed publish closes the reserved window and throws (no navigate, no false success)", async () => {
    const rpc = mock(async (): Promise<RpcReply<LiveReportPublishResult>> => errorReply("bad_request", "nope"));
    const navigate = mock((_h: FakeWin, _path: string) => {});
    const closeWindow = mock((_h: FakeWin) => {});
    await expect(publishAndOpen({ blocks: [], rpc, handle: aWindow, navigate, closeWindow })).rejects.toThrow("nope");
    expect(navigate).not.toHaveBeenCalled();
    expect(closeWindow).toHaveBeenCalledWith(aWindow);
  });
});

describe("runExport", () => {
  test("reserves the window synchronously (before publish resolves), then navigates it to the returned path", async () => {
    // A deferred publish: assert the window is reserved BEFORE the publish resolves, and navigated
    // only AFTER — proving reserveWindow runs synchronously in the gesture, not post-await.
    let resolvePublish!: (r: RpcReply<LiveReportPublishResult>) => void;
    const rpc = mock(
      (): Promise<RpcReply<LiveReportPublishResult>> => new Promise((res) => (resolvePublish = res)),
    );
    const reserveWindow = mock((): FakeWin | null => aWindow);
    const navigate = mock((_h: FakeWin, _path: string) => {});
    const download = mock((_html: string, _file: string) => {});
    const p = runExport({
      blocks: [{ id: 1, kind: "prose", markdown: "hi" }],
      fetchRuntime: async () => "/* runtime */",
      download,
      rpc,
      reserveWindow,
      navigate,
      closeWindow: () => {},
    });
    // Reserved synchronously, and NOT yet navigated (publish still pending).
    expect(reserveWindow).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    resolvePublish(okPublish("/live/xyz"));
    await p;
    expect(navigate).toHaveBeenCalledWith(aWindow, "/live/xyz");
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![0]).toContain("__qs_livereport");
  });

  test("a null reserveWindow (popup blocked) surfaces an error but STILL downloads the portable copy", async () => {
    const rpc = mock(async (): Promise<RpcReply<LiveReportPublishResult>> => okPublish("/live/xyz"));
    const navigate = mock((_h: FakeWin, _path: string) => {});
    const download = mock((_html: string, _file: string) => {});
    await expect(
      runExport({
        blocks: [{ id: 1, kind: "prose", markdown: "hi" }],
        fetchRuntime: async () => "/* runtime */",
        download,
        rpc,
        reserveWindow: () => null,
        navigate,
        closeWindow: () => {},
      }),
    ).rejects.toThrow(/popup/i);
    // The headline open failed, but the portable copy still shipped, and nothing was navigated.
    expect(navigate).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledTimes(1);
  });

  test("a livereport.publish error surfaces, does not navigate, and downloads nothing", async () => {
    const rpc = mock(async (): Promise<RpcReply<LiveReportPublishResult>> => errorReply("internal_error", "down"));
    const navigate = mock((_h: FakeWin, _path: string) => {});
    const download = mock((_html: string, _file: string) => {});
    await expect(
      runExport({
        blocks: [],
        fetchRuntime: async () => "/* rt */",
        download,
        rpc,
        reserveWindow: () => aWindow,
        navigate,
        closeWindow: () => {},
      }),
    ).rejects.toThrow("down");
    expect(navigate).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  test("a non-OK runtime fetch throws before any download, but AFTER opening the live view (view NOT closed)", async () => {
    const rpc = mock(async (): Promise<RpcReply<LiveReportPublishResult>> => okPublish());
    const navigate = mock((_h: FakeWin, _path: string) => {});
    const closeWindow = mock((_h: FakeWin) => {});
    const download = mock((_html: string, _file: string) => {});
    await expect(
      runExport({
        blocks: [],
        fetchRuntime: async () => {
          throw new Error("live report runtime unavailable (500)");
        },
        download,
        rpc,
        reserveWindow: () => aWindow,
        navigate,
        closeWindow,
      }),
    ).rejects.toThrow("unavailable");
    expect(download).not.toHaveBeenCalled();
    // The live view already opened; a portable-copy failure must NOT tear it down.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  test("an empty runtime body throws before any download", async () => {
    const rpc = mock(async (): Promise<RpcReply<LiveReportPublishResult>> => okPublish());
    const download = mock((_html: string, _file: string) => {});
    await expect(
      runExport({
        blocks: [],
        fetchRuntime: async () => "",
        download,
        rpc,
        reserveWindow: () => aWindow,
        navigate: () => {},
        closeWindow: () => {},
      }),
    ).rejects.toThrow("empty");
    expect(download).not.toHaveBeenCalled();
  });
});

describe("liveReportFilename", () => {
  test("is deterministic under an injected clock", () => {
    const clock = () => new Date("2026-07-12T09:08:07Z");
    expect(liveReportFilename(clock)).toBe("quick-studio-live-report-20260712-090807.html");
  });
});
