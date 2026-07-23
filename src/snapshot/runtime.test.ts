/**
 * Unit tests for the Snapshot offline runtime (Story 6.3): render correctness, HTML-escaping,
 * per-kind cell formatting, the truncation affordance, per-block render isolation, and the
 * "cannot open snapshot" fallback — all pure, no DOM (this repo has no jsdom).
 */

import { describe, expect, test } from "bun:test";
import { FROZEN_SCHEMA_VERSION, type FrozenData } from "../shared/contract.ts";
import { SNAPSHOT_SCHEMA_VERSION, type SnapshotBlock, type SnapshotDoc } from "../shared/snapshot.ts";
import type { PlotOptions } from "@observablehq/plot";
import {
  EMPTY_REPORT_HTML,
  escapeHtml,
  FALLBACK_HTML,
  formatCell,
  mountSnapshot,
  NULL_PLACEHOLDER,
  renderBlock,
  renderDocInto,
  renderTableToHtml,
  type MountHost,
} from "./runtime.ts";

const data: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [
    { name: "a", type: "number" },
    { name: "b", type: "number" },
  ],
  rows: [
    [
      { kind: "number", value: 1 },
      { kind: "number", value: 10 },
    ],
  ],
};

/** A fake mount host that records what was appended (no DOM). */
function fakeHost(): { calls: string[]; charts: PlotOptions[]; errors: string[]; host: MountHost } {
  const calls: string[] = [];
  const charts: PlotOptions[] = [];
  const errors: string[] = [];
  const host: MountHost = {
    appendHtml: (html) => calls.push(html),
    appendChart: (options) => charts.push(options),
    appendError: (message) => errors.push(message),
  };
  return { calls, charts, errors, host };
}

describe("escapeHtml + formatCell", () => {
  test("escapeHtml neutralizes a </td><script> value", () => {
    expect(escapeHtml("</td><script>alert(1)</script>")).toBe(
      "&lt;/td&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("formatCell renders each kind (date→iso, null→placeholder, number/bool/string)", () => {
    expect(formatCell({ kind: "date", iso: "2026-07-12T00:00:00Z" })).toBe("2026-07-12T00:00:00Z");
    expect(formatCell({ kind: "null" })).toBe(NULL_PLACEHOLDER);
    expect(formatCell({ kind: "number", value: 42 })).toBe("42");
    expect(formatCell({ kind: "boolean", value: true })).toBe("true");
    expect(formatCell({ kind: "string", value: "hi" })).toBe("hi");
  });
});

describe("renderTableToHtml", () => {
  test("escapes every cell AND column name", () => {
    const hostile: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "</th><script>", type: "string" }],
      rows: [[{ kind: "string", value: "</td><script>x</script>" }]],
    };
    const html = renderTableToHtml(hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/th&gt;&lt;script&gt;"); // column name escaped
    expect(html).toContain("&lt;/td&gt;&lt;script&gt;"); // cell escaped
  });
});

describe("renderBlock (pure dispatch)", () => {
  test("prose → html via renderMarkdownToHtml", () => {
    const r = renderBlock({ kind: "prose", markdown: "# hi" });
    expect(r.kind).toBe("html");
    if (r.kind === "html") expect(r.html).toContain("<h1>hi</h1>");
  });

  test("table (not truncated) → html with no truncation affordance", () => {
    const r = renderBlock({ kind: "table", data, truncated: false });
    expect(r.kind).toBe("html");
    if (r.kind === "html") {
      expect(r.html).toContain("<table");
      expect(r.html).not.toContain("truncated");
    }
  });

  test("table (truncated) → html WITH a visible truncation affordance", () => {
    const r = renderBlock({ kind: "table", data, truncated: true });
    expect(r.kind).toBe("html");
    if (r.kind === "html") expect(r.html).toContain("truncated");
  });

  test("chart → plot options + the truncated flag (no DOM)", () => {
    const block: SnapshotBlock = { kind: "chart", chart: { mark: "line", x: "a", y: "b" }, data, truncated: true };
    const r = renderBlock(block);
    expect(r.kind).toBe("chart");
    if (r.kind === "chart") {
      expect(r.truncated).toBe(true);
      expect(Array.isArray(r.options.marks)).toBe(true);
    }
  });

  test("empty → an escaped note", () => {
    const r = renderBlock({ kind: "empty", note: "no data" });
    expect(r.kind).toBe("html");
    if (r.kind === "html") expect(r.html).toContain("no data");
  });
});

describe("renderDocInto (per-block isolation + truncation)", () => {
  test("a truncated chart emits the truncation affordance", () => {
    const { calls, charts, host } = fakeHost();
    renderDocInto([{ kind: "chart", chart: { mark: "line", x: "a", y: "b" }, data, truncated: true }], host);
    expect(charts).toHaveLength(1);
    expect(calls.some((c) => c.includes("truncated"))).toBe(true);
  });

  test("a zero-block report renders the 'no blocks' affordance (never a blank body)", () => {
    const { calls, charts, errors, host } = fakeHost();
    renderDocInto([], host);
    expect(calls).toEqual([EMPTY_REPORT_HTML]);
    expect(calls[0]).toContain("This report has no blocks.");
    expect(charts).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test("one throwing block renders an inline error WITHOUT aborting siblings", () => {
    const errors: string[] = [];
    const appended: string[] = [];
    let firstChart = true;
    const host: MountHost = {
      appendHtml: (html) => appended.push(html),
      // Simulate Observable Plot throwing on the FIRST chart (a bad channel in a real browser).
      appendChart: () => {
        if (firstChart) {
          firstChart = false;
          throw new Error("plot boom");
        }
      },
      appendError: (message) => errors.push(message),
    };
    renderDocInto(
      [
        { kind: "chart", chart: { mark: "line", x: "a", y: "b" }, data, truncated: false },
        { kind: "prose", markdown: "still here" },
      ],
      host,
    );
    expect(errors).toEqual(["plot boom"]);
    // The sibling prose block still rendered despite the earlier throw.
    expect(appended.some((h) => h.includes("still here"))).toBe(true);
  });
});

describe("mountSnapshot (fallback + happy path)", () => {
  const goodDoc: SnapshotDoc = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    blocks: [{ kind: "prose", markdown: "hello" }],
  };

  test("a valid payload renders its blocks", () => {
    const { calls, host } = fakeHost();
    mountSnapshot(JSON.stringify(goodDoc), host);
    expect(calls.some((c) => c.includes("hello"))).toBe(true);
    expect(calls).not.toContain(FALLBACK_HTML);
  });

  test("a null payload → the 'cannot open snapshot' fallback", () => {
    const { calls, host } = fakeHost();
    mountSnapshot(null, host);
    expect(calls).toEqual([FALLBACK_HTML]);
  });

  test("an unparseable payload → the fallback (never a blank page)", () => {
    const { calls, host } = fakeHost();
    mountSnapshot("{not json", host);
    expect(calls).toEqual([FALLBACK_HTML]);
  });

  test("a failed-guard payload (wrong schemaVersion) → the fallback", () => {
    const { calls, host } = fakeHost();
    mountSnapshot(JSON.stringify({ ...goodDoc, schemaVersion: 99 }), host);
    expect(calls).toEqual([FALLBACK_HTML]);
  });

  test("an over-precise date cell renders the millisecond form, never the microsecond string (DW-6)", () => {
    const doc: SnapshotDoc = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      blocks: [
        {
          kind: "table",
          data: {
            schemaVersion: FROZEN_SCHEMA_VERSION,
            columns: [{ name: "t", type: "date" }],
            rows: [[{ kind: "date", iso: "2026-07-06T12:00:00.123456Z" }]],
          },
          truncated: false,
        },
      ],
    };
    const { calls, host } = fakeHost();
    mountSnapshot(JSON.stringify(doc), host);
    const html = calls.join("");
    expect(html).toContain("2026-07-06T12:00:00.123Z");
    expect(html).not.toContain("2026-07-06T12:00:00.123456Z");
  });
});
