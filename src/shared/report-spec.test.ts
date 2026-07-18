/**
 * quick-studio — report-spec tests (Story 9.7).
 *
 * Pure parse/validate layer: `extractReport` splits prose from a ` ```report ` block
 * (mirrors `extractChartFence`), and `parseReportSpec` accepts ONLY a whitelisted,
 * non-empty ordered block list. Adversarial cases (malformed JSON, empty/non-array
 * blocks, a block missing `sql`/`markdown`, a bad chart `mark`) all coerce to `null` —
 * nothing ever opens from an invalid spec.
 */

import { describe, expect, test } from "bun:test";
import { extractReport, hasReportFence, parseReportSpec } from "./report-spec.ts";

describe("extractReport", () => {
  test("splits the prose from a ```report block and JSON-parses the block", () => {
    const body = JSON.stringify({
      title: "Revenue by country",
      blocks: [
        { kind: "prose", markdown: "# intro" },
        { kind: "query", sql: "SELECT country, sum(amount) FROM orders GROUP BY country" },
      ],
    });
    const text = `before\n\n\`\`\`report\n${body}\n\`\`\`\n\nafter`;
    const { markdown, rawReport } = extractReport(text);
    expect(rawReport).toEqual(JSON.parse(body));
    expect(markdown).toContain("before");
    expect(markdown).toContain("after");
    expect(markdown).not.toContain("```report");
  });

  test("no ```report fence -> rawReport null, markdown unchanged (verbatim)", () => {
    const text = "just prose\n\n```sql\nSELECT 1;\n```";
    const { markdown, rawReport } = extractReport(text);
    expect(rawReport).toBeNull();
    expect(markdown).toBe(text);
  });

  test("malformed JSON inside the fence -> rawReport null (never throws), fence stripped", () => {
    const text = "p\n\n```report\n{ not json ]\n```\ntail";
    const { markdown, rawReport } = extractReport(text);
    expect(rawReport).toBeNull();
    expect(markdown).toContain("p");
    expect(markdown).toContain("tail");
    expect(markdown).not.toContain("```report");
  });

  test("an UNTERMINATED fence is treated as no report, prose left intact", () => {
    const text = 'before\n\n```report\n{ "blocks": [';
    const { markdown, rawReport } = extractReport(text);
    expect(rawReport).toBeNull();
    expect(markdown).toBe(text);
  });
});

describe("parseReportSpec", () => {
  test("a full spec (title + prose + query + chart) round-trips", () => {
    const raw = {
      title: "Revenue by country",
      blocks: [
        { kind: "prose", markdown: "# Revenue by country" },
        {
          kind: "query",
          sql: "SELECT country, sum(amount) AS revenue FROM orders GROUP BY country",
          chart: { mark: "bar", x: "country", y: "revenue", title: "revenue" },
        },
      ],
    };
    expect(parseReportSpec(raw)).toEqual({
      title: "Revenue by country",
      blocks: [
        { kind: "prose", markdown: "# Revenue by country" },
        {
          kind: "query",
          sql: "SELECT country, sum(amount) AS revenue FROM orders GROUP BY country",
          chart: { mark: "bar", x: "country", y: "revenue", title: "revenue" },
        },
      ],
    });
  });

  test("a spec with no title is valid (title omitted from the result)", () => {
    const raw = { blocks: [{ kind: "query", sql: "SELECT 1" }] };
    expect(parseReportSpec(raw)).toEqual({ blocks: [{ kind: "query", sql: "SELECT 1" }] });
  });

  test("a query block with no chart is valid", () => {
    const raw = { blocks: [{ kind: "query", sql: "SELECT 1" }] };
    const parsed = parseReportSpec(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.blocks[0]).toEqual({ kind: "query", sql: "SELECT 1" });
  });

  test("empty blocks array -> null", () => {
    expect(parseReportSpec({ blocks: [] })).toBeNull();
  });

  test("non-array blocks -> null", () => {
    expect(parseReportSpec({ blocks: "nope" })).toBeNull();
    expect(parseReportSpec({ blocks: null })).toBeNull();
    expect(parseReportSpec({})).toBeNull();
  });

  test("a prose block missing markdown -> null (whole spec rejected)", () => {
    expect(parseReportSpec({ blocks: [{ kind: "prose" }] })).toBeNull();
    expect(parseReportSpec({ blocks: [{ kind: "prose", markdown: "" }] })).toBeNull();
    expect(parseReportSpec({ blocks: [{ kind: "prose", markdown: 5 }] })).toBeNull();
  });

  test("a query block missing sql -> null (whole spec rejected)", () => {
    expect(parseReportSpec({ blocks: [{ kind: "query" }] })).toBeNull();
    expect(parseReportSpec({ blocks: [{ kind: "query", sql: "" }] })).toBeNull();
    expect(parseReportSpec({ blocks: [{ kind: "query", sql: "   " }] })).toBeNull();
  });

  test("an unknown block kind -> null (whole spec rejected)", () => {
    expect(parseReportSpec({ blocks: [{ kind: "bogus" }] })).toBeNull();
  });

  test("a chart with a bad mark -> the whole block (and spec) is rejected", () => {
    const raw = { blocks: [{ kind: "query", sql: "SELECT 1", chart: { mark: "pie", x: "a", y: "b" } }] };
    expect(parseReportSpec(raw)).toBeNull();
  });

  test("a chart missing x/y -> the whole block (and spec) is rejected", () => {
    expect(
      parseReportSpec({ blocks: [{ kind: "query", sql: "SELECT 1", chart: { mark: "bar", x: "a" } }] }),
    ).toBeNull();
    expect(
      parseReportSpec({
        blocks: [{ kind: "query", sql: "SELECT 1", chart: { mark: "bar", x: "", y: "b" } }],
      }),
    ).toBeNull();
  });

  test("a chart's optional series/title (present, valid) round-trip", () => {
    const raw = {
      blocks: [
        {
          kind: "query",
          sql: "SELECT 1",
          chart: { mark: "line", x: "a", y: "b", series: "c", title: "t" },
        },
      ],
    };
    const parsed = parseReportSpec(raw);
    expect(parsed!.blocks[0]).toEqual({
      kind: "query",
      sql: "SELECT 1",
      chart: { mark: "line", x: "a", y: "b", series: "c", title: "t" },
    });
  });

  test("an oversized title -> null", () => {
    const raw = { title: "x".repeat(201), blocks: [{ kind: "query", sql: "SELECT 1" }] };
    expect(parseReportSpec(raw)).toBeNull();
  });

  test("a non-object / null / array top-level value -> null", () => {
    expect(parseReportSpec(null)).toBeNull();
    expect(parseReportSpec("report")).toBeNull();
    expect(parseReportSpec([{ blocks: [] }])).toBeNull();
    expect(parseReportSpec(42)).toBeNull();
  });

  test("an explicit chart:null means 'no chart' -> a plain query block (NOT a rejection)", () => {
    const parsed = parseReportSpec({ blocks: [{ kind: "query", sql: "SELECT 1", chart: null }] });
    expect(parsed).not.toBeNull();
    expect(parsed!.blocks[0]).toEqual({ kind: "query", sql: "SELECT 1" });
  });

  test("more than MAX_BLOCKS blocks -> null (magnitude guard on untrusted output)", () => {
    const many = Array.from({ length: 101 }, () => ({ kind: "query" as const, sql: "SELECT 1" }));
    expect(parseReportSpec({ blocks: many })).toBeNull();
    const ok = Array.from({ length: 100 }, () => ({ kind: "query" as const, sql: "SELECT 1" }));
    expect(parseReportSpec({ blocks: ok })).not.toBeNull();
  });

  test("an oversized sql string -> null (magnitude guard, mirrors the markdown cap)", () => {
    const raw = { blocks: [{ kind: "query", sql: `SELECT ${"1".repeat(20001)}` }] };
    expect(parseReportSpec(raw)).toBeNull();
  });

  test("a whitespace-only title is treated as ABSENT (validator is the source of truth)", () => {
    expect(parseReportSpec({ title: "   ", blocks: [{ kind: "query", sql: "SELECT 1" }] })).toEqual({
      blocks: [{ kind: "query", sql: "SELECT 1" }],
    });
  });

  test("a multiline title is collapsed to a single line (never multiple headings)", () => {
    expect(
      parseReportSpec({ title: "Rev\n\n## Injected", blocks: [{ kind: "query", sql: "SELECT 1" }] }),
    ).toEqual({ title: "Rev ## Injected", blocks: [{ kind: "query", sql: "SELECT 1" }] });
  });
});

describe("extractReport magnitude guard", () => {
  test("an oversized fence body -> rawReport null, but the fence is still stripped", () => {
    const body = `{"blocks":[{"kind":"prose","markdown":"${"x".repeat(200001)}"}]}`;
    const text = `p\n\n\`\`\`report\n${body}\n\`\`\`\ntail`;
    const { markdown, rawReport } = extractReport(text);
    expect(rawReport).toBeNull();
    expect(markdown).not.toContain("```report");
    expect(markdown).toContain("tail");
  });
});

describe("hasReportFence", () => {
  test("true for a well-formed OR an unterminated ```report opener; false otherwise", () => {
    expect(hasReportFence("intro\n\n```report\n{}\n```\n")).toBe(true);
    expect(hasReportFence("intro\n\n```report\n{ unterminated")).toBe(true);
    expect(hasReportFence("just prose")).toBe(false);
    expect(hasReportFence("```sql\nSELECT 1\n```")).toBe(false);
  });
});
