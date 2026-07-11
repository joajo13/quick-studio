/**
 * quick-studio Sandbox (Ring 3) — render-helper tests (Story 5.6).
 *
 * No DOM at test runtime: these assert the PURE outputs — the HTML-escaped Markdown
 * string, the Observable Plot OPTIONS object (marks + channels), and the record
 * conversion. The actual `Plot.plot(...)` DOM write lives in the guest bootstrap and is
 * never exercised here. `Plot.line/barY/dot/areaY` only CONSTRUCT mark objects (no DOM),
 * so importing Plot under `bun test` is safe.
 */

import { describe, expect, test } from "bun:test";
import { FROZEN_SCHEMA_VERSION, type FrozenData } from "../shared/contract.ts";
import { MARK_KINDS, type ChartSpec } from "../shared/chart-spec.ts";
import { buildPlotOptions, frozenToRecords, renderMarkdownToHtml } from "./render.ts";

const data: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [
    { name: "month", type: "string" },
    { name: "revenue", type: "number" },
    { name: "region", type: "string" },
    { name: "active", type: "boolean" },
    { name: "at", type: "date" },
    { name: "gone", type: "null" },
  ],
  rows: [
    [
      { kind: "string", value: "jan" },
      { kind: "number", value: 10 },
      { kind: "string", value: "us" },
      { kind: "boolean", value: true },
      { kind: "date", iso: "2026-01-01T00:00:00Z" },
      { kind: "null" },
    ],
    [
      { kind: "string", value: "feb" },
      { kind: "number", value: 20 },
      { kind: "string", value: "eu" },
      { kind: "boolean", value: false },
      { kind: "date", iso: "2026-02-01T00:00:00Z" },
      { kind: "null" },
    ],
  ],
};

/** Read a Plot mark's ariaLabel + channel value map without leaning on Plot's types. */
function markInfo(mark: unknown): { ariaLabel: string; channels: Record<string, { value: unknown }> } {
  const m = mark as { ariaLabel: string; channels: Record<string, { value: unknown }> };
  return { ariaLabel: m.ariaLabel, channels: m.channels };
}

/**
 * The source column NAME a Plot channel binds to. Plot wraps a string x/y accessor into
 * `{ transform, label }` (label = the field), while a stroke/fill accessor stays a bare
 * string — so we normalize both to the underlying field name.
 */
function channelField(ch: { value: unknown } | undefined): unknown {
  const v = ch?.value;
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && "label" in v) return (v as { label: unknown }).label;
  return v;
}

/**
 * The bound column name on the x / y position channel. Plot names it `x`/`y` for
 * line/dot but `x1`/`y1` for the stacked bar/area marks — normalize across both.
 */
function xField(channels: Record<string, { value: unknown }>): unknown {
  return channelField(channels.x ?? channels.x1);
}
function yField(channels: Record<string, { value: unknown }>): unknown {
  return channelField(channels.y ?? channels.y1);
}

describe("renderMarkdownToHtml", () => {
  test("renders headings and bold", () => {
    const html = renderMarkdownToHtml("# Title\n\nsome **bold** text");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  test("ESCAPES raw <script> / <img onerror> — never emits live markup", () => {
    const html = renderMarkdownToHtml("hi <script>alert(1)</script> and <img onerror=x>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
    // The dangerous markup survives only in escaped form.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img onerror=x&gt;");
  });

  test("NEUTRALIZES a javascript: link destination — never a live javascript: href", () => {
    const html = renderMarkdownToHtml("[click me](javascript:alert(1))");
    // The dangerous scheme never survives into a live href (micromark blanks it; our
    // post-process is the belt-and-suspenders backstop). The link TEXT still renders.
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
    // The emitted href is neutralized (empty or '#') — never the dangerous destination.
    expect(/href="(#|)"/.test(html)).toBe(true);
  });

  test("our allowlist NEUTRALIZES a non-http(s)/mailto scheme micromark would otherwise pass (defense-in-depth)", () => {
    // micromark's own URL sanitizer permits `irc:` etc.; our stricter allowlist
    // (http/https/mailto/relative only) rewrites it to a harmless '#'. This proves the
    // post-process runs and is the load-bearing narrowing over micromark's wider default.
    const html = renderMarkdownToHtml("[chat](irc://irc.example.org/room)");
    expect(html).not.toContain("irc://");
    expect(html).toContain('href="#"');
  });

  test("PRESERVES safe http/https/mailto and relative link destinations", () => {
    const https = renderMarkdownToHtml("[a](https://example.com/path?q=1)");
    expect(https).toContain('href="https://example.com/path?q=1"');
    const mail = renderMarkdownToHtml("[b](mailto:x@example.com)");
    expect(mail).toContain('href="mailto:x@example.com"');
    const rel = renderMarkdownToHtml("[c](/local/page)");
    expect(rel).toContain('href="/local/page"');
  });

  test("NEUTRALIZES a protocol-relative `//host` destination (off-origin, not truly relative)", () => {
    const html = renderMarkdownToHtml("[x](//evil.example.com/?leak=1)");
    expect(html).toContain('href="#"');
    expect(html).not.toContain("//evil.example.com");
  });
});

describe("frozenToRecords", () => {
  test("flattens tagged cells to plain records keyed by column name (dates stay ISO)", () => {
    const records = frozenToRecords(data);
    expect(records).toEqual([
      { month: "jan", revenue: 10, region: "us", active: true, at: "2026-01-01T00:00:00Z", gone: null },
      { month: "feb", revenue: 20, region: "eu", active: false, at: "2026-02-01T00:00:00Z", gone: null },
    ]);
  });
});

describe("buildPlotOptions", () => {
  test("maps every whitelisted mark to the right Plot mark with x/y channels", () => {
    const ariaByMark: Record<string, string> = { line: "line", bar: "bar", dot: "dot", area: "area" };
    for (const mark of MARK_KINDS) {
      const spec: ChartSpec = { mark, x: "month", y: "revenue" };
      const options = buildPlotOptions(spec, data);
      expect(options.marks).toHaveLength(1);
      const info = markInfo((options.marks as unknown[])[0]);
      expect(info.ariaLabel).toBe(ariaByMark[mark] as string);
      expect(xField(info.channels)).toBe("month");
      expect(yField(info.channels)).toBe("revenue");
    }
  });

  test("carries the title through when present, omits it when absent", () => {
    const withTitle = buildPlotOptions({ mark: "line", x: "month", y: "revenue", title: "Revenue" }, data);
    expect(withTitle.title).toBe("Revenue");
    const noTitle = buildPlotOptions({ mark: "line", x: "month", y: "revenue" }, data);
    expect(noTitle.title).toBeUndefined();
  });

  test("a raw null `series`/`title` (unnormalized frame) yields NO null channel and no title", () => {
    // The guest forwards the RAW inbound chart; a `{series:null,title:null}` frame passes
    // isSandboxInbound (parseChartSpec drops nulls). buildPlotOptions must not hand Plot a
    // null channel/title — the `!= null` guards mirror the validator's normalization.
    const raw = { mark: "line", x: "month", y: "revenue", series: null, title: null } as unknown as ChartSpec;
    const options = buildPlotOptions(raw, data);
    expect(options.title).toBeUndefined();
    expect(markInfo((options.marks as unknown[])[0]).channels.stroke).toBeUndefined();
  });

  test("a series groups a line/dot by stroke", () => {
    const options = buildPlotOptions({ mark: "line", x: "month", y: "revenue", series: "region" }, data);
    const info = markInfo((options.marks as unknown[])[0]);
    expect(channelField(info.channels.stroke)).toBe("region");
  });

  test("a series groups a bar/area by fill", () => {
    const bar = buildPlotOptions({ mark: "bar", x: "month", y: "revenue", series: "region" }, data);
    expect(channelField(markInfo((bar.marks as unknown[])[0]).channels.fill)).toBe("region");
    const area = buildPlotOptions({ mark: "area", x: "month", y: "revenue", series: "region" }, data);
    expect(channelField(markInfo((area.marks as unknown[])[0]).channels.fill)).toBe("region");
  });

  test("the mark carries the converted records as its data", () => {
    const options = buildPlotOptions({ mark: "line", x: "month", y: "revenue" }, data);
    const mark = (options.marks as unknown[])[0] as { data: unknown[] };
    expect(mark.data).toEqual(frozenToRecords(data));
  });
});
