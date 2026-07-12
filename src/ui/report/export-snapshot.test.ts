/**
 * Unit tests for the Ring-2 Snapshot export (Story 6.3): the block-mapping matrix, the frozen
 * round-trip, the `runExport` fetch/error paths, the deterministic filename, and the
 * `triggerHtmlDownload` no-DOM no-op. Click-driven coverage lives here (not in the React smoke
 * test) because this repo has no jsdom — `runExport` is injectable so it needs no DOM.
 */

import { describe, expect, mock, test } from "bun:test";
import { decode, FROZEN_SCHEMA_VERSION, type FrozenData } from "../../shared/contract.ts";
import { SNAPSHOT_SCHEMA_VERSION, type SnapshotDoc } from "../../shared/snapshot.ts";
import type { ReportBlock } from "./report-state.ts";
import {
  buildSnapshotHtml,
  runExport,
  snapshotFilename,
  toSnapshotBlock,
  toSnapshotDoc,
  triggerHtmlDownload,
} from "./export-snapshot.ts";

const numData: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [
    { name: "k", type: "number" },
    { name: "v", type: "number" },
  ],
  rows: [
    [
      { kind: "number", value: 1 },
      { kind: "number", value: 10 },
    ],
  ],
};

function queryBlock(overrides: Partial<Extract<ReportBlock, { kind: "query" }>>): ReportBlock {
  return {
    id: 1,
    kind: "query",
    sql: "select 1",
    result: null,
    view: "table",
    chart: null,
    ...overrides,
  };
}

describe("toSnapshotBlock (mapping matrix)", () => {
  test("prose → prose", () => {
    expect(toSnapshotBlock({ id: 1, kind: "prose", markdown: "# hi" })).toEqual({
      kind: "prose",
      markdown: "# hi",
    });
  });

  test("query + result (table view) → table, carrying truncated + encoded data (round-trip)", () => {
    const block = queryBlock({ result: numData, view: "table", truncated: true });
    const out = toSnapshotBlock(block);
    expect(out.kind).toBe("table");
    if (out.kind === "table") {
      expect(out.truncated).toBe(true);
      expect(decode(out.data)).toEqual(decode(numData));
    }
  });

  test("query + result (chart view, valid spec) → chart", () => {
    const block = queryBlock({ result: numData, view: "chart", chart: { mark: "line", x: "k", y: "v" } });
    const out = toSnapshotBlock(block);
    expect(out.kind).toBe("chart");
    if (out.kind === "chart") expect(out.chart).toEqual({ mark: "line", x: "k", y: "v" });
  });

  test("query + result (chart view, spec invalid vs current columns) → table fallback", () => {
    const block = queryBlock({ result: numData, view: "chart", chart: { mark: "line", x: "gone", y: "v" } });
    expect(toSnapshotBlock(block).kind).toBe("table");
  });

  test("query, null result, no info → empty('no data')", () => {
    expect(toSnapshotBlock(queryBlock({ result: null }))).toEqual({ kind: "empty", note: "no data" });
  });

  test("query, null result WITH info (non-SELECT ok) → empty with the info note", () => {
    expect(toSnapshotBlock(queryBlock({ result: null, info: "3 rows affected" }))).toEqual({
      kind: "empty",
      note: "3 rows affected",
    });
  });

  test("errored query (result null, error set) → empty('no data')", () => {
    expect(toSnapshotBlock(queryBlock({ result: null, error: "boom" }))).toEqual({
      kind: "empty",
      note: "no data",
    });
  });

  test("a block whose encode() throws → empty('could not freeze this block')", () => {
    const bad: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "n", type: "number" }],
      rows: [[{ kind: "number", value: Infinity }]], // non-finite → encode throws
    };
    expect(toSnapshotBlock(queryBlock({ result: bad }))).toEqual({
      kind: "empty",
      note: "could not freeze this block",
    });
  });
});

describe("toSnapshotDoc", () => {
  test("stamps the schema version and serializes every block; one bad block does not drop the others", () => {
    const bad: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "n", type: "number" }],
      rows: [[{ kind: "number", value: Infinity }]],
    };
    const doc = toSnapshotDoc([
      { id: 1, kind: "prose", markdown: "a" },
      queryBlock({ id: 2, result: bad }),
      queryBlock({ id: 3, result: numData }),
    ]);
    expect(doc.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(doc.blocks.map((b) => b.kind)).toEqual(["prose", "empty", "table"]);
  });
});

describe("buildSnapshotHtml", () => {
  test("embeds the report's frozen data (decode round-trip out of the HTML)", () => {
    const html = buildSnapshotHtml([queryBlock({ result: numData })], "/* rt */");
    const m = /<script type="application\/json" id="__qs_snapshot">([\s\S]*?)<\/script>/.exec(html);
    const doc = JSON.parse(m![1] as string) as SnapshotDoc;
    const table = doc.blocks[0] as { kind: "table"; data: FrozenData };
    expect(decode(table.data)).toEqual(decode(numData));
  });
});

describe("runExport", () => {
  test("a successful fetch calls download with the assembled HTML", async () => {
    const download = mock((_html: string, _file: string) => {});
    await runExport({
      blocks: [{ id: 1, kind: "prose", markdown: "hi" }],
      fetchRuntime: async () => "/* runtime */",
      download,
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![0]).toContain("__qs_snapshot");
  });

  test("a non-OK runtime fetch (fetchRuntime throws) does NOT call download", async () => {
    const download = mock((_html: string, _file: string) => {});
    await expect(
      runExport({
        blocks: [],
        fetchRuntime: async () => {
          throw new Error("snapshot runtime unavailable (500)");
        },
        download,
      }),
    ).rejects.toThrow("unavailable");
    expect(download).not.toHaveBeenCalled();
  });

  test("an empty runtime body throws before any download", async () => {
    const download = mock((_html: string, _file: string) => {});
    await expect(
      runExport({ blocks: [], fetchRuntime: async () => "", download }),
    ).rejects.toThrow("empty");
    expect(download).not.toHaveBeenCalled();
  });
});

describe("snapshotFilename", () => {
  test("is deterministic under an injected clock", () => {
    const clock = () => new Date("2026-07-12T09:08:07Z");
    expect(snapshotFilename(clock)).toBe("quick-studio-snapshot-20260712-090807.html");
  });
});

describe("triggerHtmlDownload", () => {
  test("no-ops (no throw) when document is undefined (no DOM under bun test)", () => {
    expect(() => triggerHtmlDownload("<html></html>", "x.html")).not.toThrow();
  });
});
