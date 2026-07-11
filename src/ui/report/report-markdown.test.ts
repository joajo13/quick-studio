/**
 * quick-studio UI (Ring 2) — Report Markdown renderer tests (Story 6.1).
 *
 * Assert the trust model (R5 / no-code-execution): raw HTML is ESCAPED not emitted, a
 * `<script>` never survives as live markup, and dangerous URL schemes (`javascript:`,
 * `data:`, obfuscated whitespace/control-char variants, protocol-relative `//host`) are
 * neutralized to `#`. Ordinary Markdown + safe links still render.
 */

import { describe, expect, test } from "bun:test";
import { renderReportMarkdown } from "./report-markdown.ts";

describe("renderReportMarkdown", () => {
  test("renders ordinary Markdown to HTML", () => {
    const html = renderReportMarkdown("# Title\n\nsome **bold** text");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  test("escapes raw HTML — a <script> is never emitted live", () => {
    const html = renderReportMarkdown("hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("escapes a raw <img onerror> — never live markup", () => {
    const html = renderReportMarkdown("and <img onerror=x>");
    expect(html).not.toContain("<img onerror");
    // The dangerous markup survives only in escaped form.
    expect(html).toContain("&lt;img onerror=x&gt;");
  });

  test("neutralizes a javascript: link destination (never a live javascript: href)", () => {
    const html = renderReportMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    // The emitted href is neutralized — empty (micromark blanks it) or '#' (our pass).
    expect(/href="(#|)"/.test(html)).toBe(true);
  });

  test("an obfuscated java\\tscript: destination never becomes a live link", () => {
    // micromark rejects a link destination containing whitespace/control chars, so the
    // text stays INERT (no anchor at all) rather than emitting a live javascript href.
    const html = renderReportMarkdown("[x](java\tscript:alert(1))");
    expect(html).not.toMatch(/href="[^"]*script:/i);
    // And a destination wrapped so micromark DOES parse it is still neutralized to #.
    const html2 = renderReportMarkdown("[x](\tjavascript:alert(1))");
    expect(html2).not.toMatch(/href="[^"]*javascript:/i);
  });

  test("neutralizes a protocol-relative //host destination", () => {
    const html = renderReportMarkdown("[x](//evil.example/path)");
    expect(html).toContain('href="#"');
    expect(html).not.toContain("//evil.example");
  });

  test("neutralizes backslash protocol-relative variants (/\\host, \\\\host)", () => {
    // Browsers read leading `/\` and `\\` as protocol-relative off-origin; the backslash
    // survives the control-char strip, so they must still be rewritten to `#`.
    const slashBackslash = renderReportMarkdown("[x](/\\evil.example)");
    expect(slashBackslash).toContain('href="#"');
    expect(slashBackslash).not.toContain("evil.example");
    const doubleBackslash = renderReportMarkdown("[x](\\\\evil.example)");
    expect(doubleBackslash).toContain('href="#"');
    expect(doubleBackslash).not.toContain("evil.example");
  });

  test("keeps a safe http(s)/mailto/relative link intact", () => {
    expect(renderReportMarkdown("[x](https://example.com)")).toContain('href="https://example.com"');
    expect(renderReportMarkdown("[x](mailto:a@b.com)")).toContain('href="mailto:a@b.com"');
    expect(renderReportMarkdown("[x](/local/path)")).toContain('href="/local/path"');
  });
});
