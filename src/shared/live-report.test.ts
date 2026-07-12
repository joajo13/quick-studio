/**
 * Unit tests for the Live Report document guard (Story 6.4). Proves the guard accepts each
 * block kind, rejects a wrong doc schemaVersion / missing blocks / unknown kind / non-string
 * sql / invalid view, and that a well-formed doc carries NO data field (SQL, never data).
 */

import { describe, expect, test } from "bun:test";
import {
  isLiveReportDoc,
  LIVE_REPORT_SCHEMA_VERSION,
  type LiveReportDoc,
} from "./live-report.ts";

const goodDoc: LiveReportDoc = {
  schemaVersion: LIVE_REPORT_SCHEMA_VERSION,
  blocks: [
    { kind: "prose", markdown: "# hi" },
    { kind: "query", sql: "select 1", view: "table", chart: null },
    { kind: "query", sql: "select k, v", view: "chart", chart: { mark: "line", x: "k", y: "v" } },
    { kind: "empty", note: "no query" },
  ],
};

describe("isLiveReportDoc (accepts)", () => {
  test("a well-formed doc with every kind", () => {
    expect(isLiveReportDoc(goodDoc)).toBe(true);
  });

  test("a query block with a null chart and chart view", () => {
    expect(
      isLiveReportDoc({
        schemaVersion: LIVE_REPORT_SCHEMA_VERSION,
        blocks: [{ kind: "query", sql: "select 1", view: "chart", chart: null }],
      }),
    ).toBe(true);
  });
});

describe("isLiveReportDoc (rejects)", () => {
  test("a wrong doc schemaVersion", () => {
    expect(isLiveReportDoc({ ...goodDoc, schemaVersion: 99 })).toBe(false);
  });

  test("a missing/non-array blocks", () => {
    expect(isLiveReportDoc({ schemaVersion: LIVE_REPORT_SCHEMA_VERSION })).toBe(false);
    expect(isLiveReportDoc({ schemaVersion: LIVE_REPORT_SCHEMA_VERSION, blocks: "nope" })).toBe(false);
  });

  test("an unknown block kind", () => {
    expect(
      isLiveReportDoc({ schemaVersion: LIVE_REPORT_SCHEMA_VERSION, blocks: [{ kind: "chart" }] }),
    ).toBe(false);
  });

  test("a non-string sql", () => {
    expect(
      isLiveReportDoc({
        schemaVersion: LIVE_REPORT_SCHEMA_VERSION,
        blocks: [{ kind: "query", sql: 123, view: "table", chart: null }],
      }),
    ).toBe(false);
  });

  test("an invalid view", () => {
    expect(
      isLiveReportDoc({
        schemaVersion: LIVE_REPORT_SCHEMA_VERSION,
        blocks: [{ kind: "query", sql: "select 1", view: "pie", chart: null }],
      }),
    ).toBe(false);
  });

  test("a chart that is neither null nor an object", () => {
    expect(
      isLiveReportDoc({
        schemaVersion: LIVE_REPORT_SCHEMA_VERSION,
        blocks: [{ kind: "query", sql: "select 1", view: "chart", chart: "line" }],
      }),
    ).toBe(false);
  });

  test("non-object / null", () => {
    expect(isLiveReportDoc(null)).toBe(false);
    expect(isLiveReportDoc(42)).toBe(false);
  });
});

describe("no data at rest", () => {
  test("a well-formed doc's blocks carry no FrozenData field", () => {
    const json = JSON.stringify(goodDoc);
    expect(json).not.toContain("schemaVersion\":1,\"columns"); // no nested FrozenData
    for (const b of goodDoc.blocks) {
      expect(Object.prototype.hasOwnProperty.call(b, "data")).toBe(false);
    }
  });
});
