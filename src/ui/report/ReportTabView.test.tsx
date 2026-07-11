/**
 * quick-studio UI (Ring 2) — ReportTabView smoke test (Story 6.1).
 *
 * Following the repo convention (no jsdom/testing-library): a `react-dom/server`
 * `renderToStaticMarkup` pass proves the builder renders (a) the empty state and (b) a
 * populated MULTI-BLOCK report (prose + two independent query blocks — one showing a
 * table, one showing a Recharts chart) WITHOUT throwing. The pure run/reduce logic is
 * covered by `report-state.test.ts` / `report-chart.test.ts` / `report-markdown.test.ts`.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { errorReply, FROZEN_SCHEMA_VERSION, type FrozenData, type RpcReply } from "../../shared/contract.ts";

// `ReportTabView` → `run-raw-query` → `rpc`. Only invoked on a run click; stub it so the
// module import is inert for a static render (mirrors `ChatTabView.test.tsx`).
const rpcMock = mock(
  async (_method: string, _params?: unknown): Promise<RpcReply<unknown>> =>
    errorReply("internal_error", "unset"),
);
mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }));

const { ReportTabView } = await import("./ReportTabView.tsx");
const {
  addProseBlock,
  addQueryBlock,
  emptyReport,
  setBlockChart,
  setBlockResult,
  setBlockView,
  updateProse,
} = await import("./report-state.ts");

const numData = (a: string, b: string): FrozenData => ({
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [
    { name: a, type: "number" },
    { name: b, type: "number" },
  ],
  rows: [
    [{ kind: "number", value: 1 }, { kind: "number", value: 10 }],
    [{ kind: "number", value: 2 }, { kind: "number", value: 20 }],
  ],
});

describe("ReportTabView", () => {
  test("renders the empty-state prompt", () => {
    const html = renderToStaticMarkup(<ReportTabView state={emptyReport()} onStateChange={() => {}} />);
    expect(html).toContain("empty report");
    expect(html).toContain("+ prose");
    expect(html).toContain("+ query");
  });

  test("renders a populated multi-block report (prose + table + chart) without throwing", () => {
    // prose (id 1) + query-table (id 2) + query-chart (id 3), each independent.
    let s = addProseBlock(emptyReport());
    s = updateProse(s, 1, "## Summary\n\nrevenue is **up**");
    s = addQueryBlock(s);
    s = setBlockResult(s, 2, numData("k", "v"), false);
    s = addQueryBlock(s);
    s = setBlockResult(s, 3, numData("k", "v"), false);
    s = setBlockView(s, 3, "chart");
    s = setBlockChart(s, 3, { mark: "line", x: "k", y: "v" });

    const html = renderToStaticMarkup(<ReportTabView state={s} onStateChange={() => {}} />);
    // Prose rendered as sanitized HTML.
    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("<strong>up</strong>");
    // Both query blocks present with their view toggles.
    expect(html).toContain("block 2/3");
    expect(html).toContain("block 3/3");
    // A data grid renders for the table block.
    expect(html).toContain("<table");
  });
});
