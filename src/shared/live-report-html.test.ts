/**
 * Unit tests for the Live Report HTML assembler (Story 6.4). Proves: the embedded JSON parses
 * back to the doc; `connect-src 'self'` present AND `connect-src 'none'` absent; zero external
 * references; a `token = null` build carries NO secret; a token is script-json-escaped; a
 * `</script>` inside a SQL string stays inert; a hostile `runtimeJs` is neutralized; and no
 * FrozenData/rows/credential/driver is embedded.
 */

import { describe, expect, test } from "bun:test";
import { assembleLiveReportHtml } from "./live-report-html.ts";
import { LIVE_REPORT_SCHEMA_VERSION, type LiveReportDoc } from "./live-report.ts";

const doc: LiveReportDoc = {
  schemaVersion: LIVE_REPORT_SCHEMA_VERSION,
  blocks: [
    { kind: "prose", markdown: "# report" },
    { kind: "query", sql: "select 1 as k, 2 as v", view: "chart", chart: { mark: "line", x: "k", y: "v" } },
  ],
};

function extractPayload(html: string): unknown {
  const m = /<script type="application\/json" id="__qs_livereport">([\s\S]*?)<\/script>/.exec(html);
  return JSON.parse(m![1] as string);
}

describe("assembleLiveReportHtml", () => {
  test("the embedded JSON parses back to the doc", () => {
    const html = assembleLiveReportHtml(doc, "/* rt */", null);
    expect(extractPayload(html)).toEqual(doc);
  });

  test("CSP has connect-src 'self' and NOT connect-src 'none'", () => {
    const html = assembleLiveReportHtml(doc, "/* rt */", null);
    expect(html).toContain("connect-src 'self'");
    expect(html).not.toContain("connect-src 'none'");
  });

  test("CSP blocks framing/clickjacking with frame-ancestors 'none' (the served page holds a token)", () => {
    const html = assembleLiveReportHtml(doc, "/* rt */", null);
    expect(html).toContain("frame-ancestors 'none'");
  });

  test("zero external http/https references", () => {
    const html = assembleLiveReportHtml(doc, "/* rt */", "abc123");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  test("token = null → NO __QS_TOKEN__ and no secret", () => {
    const html = assembleLiveReportHtml(doc, "/* rt */", null);
    expect(html).not.toContain("__QS_TOKEN__");
  });

  test("a token is injected script-json-escaped", () => {
    const html = assembleLiveReportHtml(doc, "/* rt */", "deadbeef");
    expect(html).toContain("window.__QS_TOKEN__ =");
    expect(html).toContain('"deadbeef"');
  });

  test("a </script> inside a SQL string stays inert (payload escape)", () => {
    const hostile: LiveReportDoc = {
      schemaVersion: LIVE_REPORT_SCHEMA_VERSION,
      blocks: [{ kind: "query", sql: "select '</script><script>alert(1)</script>'", view: "table", chart: null }],
    };
    const html = assembleLiveReportHtml(hostile, "/* rt */", null);
    // The literal breakout sequence must not appear unescaped in the payload script.
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c"); // `<` \u-escaped in the payload
    // Round-trips cleanly back out.
    expect(extractPayload(html)).toEqual(hostile);
  });

  test("a hostile runtimeJs containing </script> is neutralized (only the real script tags survive)", () => {
    const hostileRuntime = "var x = 1; // </script><script>alert(2)</script>";
    const html = assembleLiveReportHtml(doc, hostileRuntime, null);
    expect(html).not.toContain("</script><script>alert(2)");
    expect(html).toContain("<\\/script"); // escaped form present
  });

  test("embeds no FrozenData / rows / credential / driver", () => {
    const html = assembleLiveReportHtml(doc, "/* rt */", "abc123");
    expect(html).not.toContain('"columns"');
    expect(html).not.toContain('"rows"');
    expect(html).not.toContain("password");
    expect(html).not.toContain("postgres://");
  });
});
