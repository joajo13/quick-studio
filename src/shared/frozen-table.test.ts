/**
 * Unit tests for the shared frozen-data table renderer (extracted from the 6.3 Snapshot
 * runtime). Guards the renderer directly: a hostile cell value AND a hostile column name
 * render inert, per-kind cell formatting is correct, and the truncation note text is present.
 */

import { describe, expect, test } from "bun:test";
import { FROZEN_SCHEMA_VERSION, type FrozenData } from "./contract.ts";
import { escapeHtml, formatCell, NULL_PLACEHOLDER, renderTableToHtml, truncationNote } from "./frozen-table.ts";

describe("escapeHtml", () => {
  test("neutralizes a </td><script> value", () => {
    expect(escapeHtml("</td><script>alert(1)</script>")).toBe(
      "&lt;/td&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("escapes quotes and ampersands", () => {
    expect(escapeHtml(`a & "b" '<c>'`)).toBe("a &amp; &quot;b&quot; &#39;&lt;c&gt;&#39;");
  });
});

describe("formatCell (per kind)", () => {
  test("date → iso, null → placeholder, number/bool/string as text", () => {
    expect(formatCell({ kind: "date", iso: "2026-07-12T00:00:00Z" })).toBe("2026-07-12T00:00:00Z");
    expect(formatCell({ kind: "null" })).toBe(NULL_PLACEHOLDER);
    expect(formatCell({ kind: "number", value: 42 })).toBe("42");
    expect(formatCell({ kind: "boolean", value: false })).toBe("false");
    expect(formatCell({ kind: "string", value: "hi" })).toBe("hi");
  });
});

describe("renderTableToHtml", () => {
  test("escapes every cell AND column name (hostile both) — renders inert", () => {
    const hostile: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "</th><script>col</script>", type: "string" }],
      rows: [[{ kind: "string", value: "</td><script>x</script>" }]],
    };
    const html = renderTableToHtml(hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/th&gt;&lt;script&gt;"); // column name escaped
    expect(html).toContain("&lt;/td&gt;&lt;script&gt;"); // cell escaped
  });

  test("renders a well-formed grid with head + body", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [
        { name: "a", type: "number" },
        { name: "b", type: "string" },
      ],
      rows: [[{ kind: "number", value: 1 }, { kind: "string", value: "x" }]],
    };
    const html = renderTableToHtml(data);
    expect(html).toContain('<table class="qs-frozen">');
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<th>b</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>x</td>");
  });
});

describe("truncationNote", () => {
  test("carries the visible truncation text", () => {
    expect(truncationNote()).toContain("truncated");
  });
});
