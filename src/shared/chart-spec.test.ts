/**
 * quick-studio — chart-spec tests (Story 5.6).
 *
 * Pure parse/validate layer: `extractChartFence` splits prose from a ` ```chart ` block,
 * and `parseChartSpec` accepts ONLY a whitelisted, column-referencing spec. Adversarial
 * cases (unknown mark, non-string channel, column-not-in-data, oversized title, malformed
 * JSON) all coerce to `null` — the guest then draws Markdown only, never a bogus chart.
 */

import { describe, expect, test } from "bun:test";
import { extractChartFence, MARK_KINDS, parseChartSpec } from "./chart-spec.ts";

const COLUMNS = ["month", "revenue", "region"] as const;

describe("extractChartFence", () => {
  test("splits the prose from a ```chart block and JSON-parses the block", () => {
    const text = "before\n\n```chart\n{ \"mark\": \"line\", \"x\": \"month\", \"y\": \"revenue\" }\n```\n\nafter";
    const { markdown, rawChart } = extractChartFence(text);
    expect(rawChart).toEqual({ mark: "line", x: "month", y: "revenue" });
    // Prose stays intact; the chart fence is removed.
    expect(markdown).toContain("before");
    expect(markdown).toContain("after");
    expect(markdown).not.toContain("```chart");
  });

  test("no ```chart fence -> rawChart null, markdown unchanged (verbatim)", () => {
    const text = "just prose\n\n```sql\nSELECT 1;\n```";
    const { markdown, rawChart } = extractChartFence(text);
    expect(rawChart).toBeNull();
    expect(markdown).toBe(text);
  });

  test("malformed JSON inside the fence -> rawChart null (never throws), fence stripped", () => {
    const text = "p\n\n```chart\n{ not json ]\n```\ntail";
    const { markdown, rawChart } = extractChartFence(text);
    expect(rawChart).toBeNull();
    expect(markdown).toContain("p");
    expect(markdown).toContain("tail");
    expect(markdown).not.toContain("```chart");
  });

  test("only the FIRST ```chart fence is consulted; a later fence stays in the prose", () => {
    const text = "```chart\n{ \"mark\": \"bar\", \"x\": \"month\", \"y\": \"revenue\" }\n```\nmid\n```chart\n{}\n```";
    const { markdown, rawChart } = extractChartFence(text);
    expect(rawChart).toEqual({ mark: "bar", x: "month", y: "revenue" });
    expect(markdown).toContain("mid");
    expect(markdown).toContain("```chart"); // the second fence remains verbatim
  });

  test("an UNTERMINATED fence (no closing ``` on its own line) is treated as no chart, prose left intact", () => {
    // The old non-greedy `...```` match would have truncated mid-JSON; the line-anchored
    // close means an unterminated opener is simply not a match — no partial JSON leaks.
    const text = "before\n\n```chart\n{ \"mark\": \"line\", \"x\": \"month\", \"y\": \"revenue\"";
    const { markdown, rawChart } = extractChartFence(text);
    expect(rawChart).toBeNull();
    expect(markdown).toBe(text); // verbatim — no mid-JSON truncation surfaced as prose
  });

  test("a ``` sequence INSIDE a JSON string value does not terminate the fence early", () => {
    // The backticks sit mid-line inside `title`, so they are NOT the closing fence — the
    // real close is the ``` on its own line, and the full JSON (incl. the title) parses.
    const text = "p\n\n```chart\n{ \"mark\": \"bar\", \"x\": \"month\", \"y\": \"revenue\", \"title\": \"a ``` b\" }\n```\ntail";
    const { markdown, rawChart } = extractChartFence(text);
    expect(rawChart).toEqual({ mark: "bar", x: "month", y: "revenue", title: "a ``` b" });
    expect(markdown).toContain("p");
    expect(markdown).toContain("tail");
    expect(markdown).not.toContain("```chart");
    // Crucially, no partial/raw JSON leaked into the visible prose.
    expect(markdown).not.toContain("mark");
    expect(markdown).not.toContain("revenue");
  });

  test("the closing fence at end-of-text (no trailing newline) still terminates", () => {
    const text = "lead\n\n```chart\n{ \"mark\": \"dot\", \"x\": \"month\", \"y\": \"revenue\" }\n```";
    const { markdown, rawChart } = extractChartFence(text);
    expect(rawChart).toEqual({ mark: "dot", x: "month", y: "revenue" });
    expect(markdown).toContain("lead");
    expect(markdown).not.toContain("```chart");
  });
});

describe("parseChartSpec", () => {
  test("accepts a valid spec for every whitelisted mark", () => {
    for (const mark of MARK_KINDS) {
      expect(parseChartSpec({ mark, x: "month", y: "revenue" }, COLUMNS)).toEqual({
        mark,
        x: "month",
        y: "revenue",
      });
    }
  });

  test("accepts an optional series + title (present, valid)", () => {
    expect(
      parseChartSpec({ mark: "line", x: "month", y: "revenue", series: "region", title: "monthly revenue" }, COLUMNS),
    ).toEqual({ mark: "line", x: "month", y: "revenue", series: "region", title: "monthly revenue" });
  });

  test("rejects an unknown mark", () => {
    expect(parseChartSpec({ mark: "pie", x: "month", y: "revenue" }, COLUMNS)).toBeNull();
    expect(parseChartSpec({ mark: 3, x: "month", y: "revenue" }, COLUMNS)).toBeNull();
  });

  test("rejects a non-string channel", () => {
    expect(parseChartSpec({ mark: "line", x: 1, y: "revenue" }, COLUMNS)).toBeNull();
    expect(parseChartSpec({ mark: "line", x: "month", y: null }, COLUMNS)).toBeNull();
  });

  test("rejects a channel naming a column NOT in the data", () => {
    expect(parseChartSpec({ mark: "line", x: "month", y: "nope" }, COLUMNS)).toBeNull();
    expect(parseChartSpec({ mark: "line", x: "ghost", y: "revenue" }, COLUMNS)).toBeNull();
    // A series naming an absent column is rejected too.
    expect(parseChartSpec({ mark: "line", x: "month", y: "revenue", series: "ghost" }, COLUMNS)).toBeNull();
  });

  test("rejects an oversized title (untrusted text bounded at 200)", () => {
    expect(parseChartSpec({ mark: "bar", x: "month", y: "revenue", title: "x".repeat(200) }, COLUMNS)).not.toBeNull();
    expect(parseChartSpec({ mark: "bar", x: "month", y: "revenue", title: "x".repeat(201) }, COLUMNS)).toBeNull();
    expect(parseChartSpec({ mark: "bar", x: "month", y: "revenue", title: 5 }, COLUMNS)).toBeNull();
  });

  test("rejects a non-object / null / array", () => {
    expect(parseChartSpec(null, COLUMNS)).toBeNull();
    expect(parseChartSpec("line", COLUMNS)).toBeNull();
    expect(parseChartSpec([{ mark: "line" }], COLUMNS)).toBeNull();
    expect(parseChartSpec(42, COLUMNS)).toBeNull();
  });

  test("an explicit null series/title is treated as absent (spec still valid)", () => {
    expect(parseChartSpec({ mark: "dot", x: "month", y: "revenue", series: null, title: null }, COLUMNS)).toEqual({
      mark: "dot",
      x: "month",
      y: "revenue",
    });
  });
});
