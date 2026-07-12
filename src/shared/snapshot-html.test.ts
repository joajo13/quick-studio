/**
 * Unit tests for the Snapshot HTML assembler (Story 6.3). Proves the self-contained document
 * is offline (no external ref, `connect-src 'none'`) and injection-safe on BOTH the embedded
 * data AND the inlined runtime bundle.
 */

import { describe, expect, test } from "bun:test";
import { decode, FROZEN_SCHEMA_VERSION, type FrozenData } from "./contract.ts";
import { SNAPSHOT_SCHEMA_VERSION, type SnapshotDoc } from "./snapshot.ts";
import { assembleSnapshotHtml, embedJson } from "./snapshot-html.ts";

const data: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [{ name: "note", type: "string" }],
  rows: [[{ kind: "string", value: "hello" }]],
};

const doc: SnapshotDoc = {
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  blocks: [
    { kind: "prose", markdown: "# title" },
    { kind: "table", data, truncated: false },
  ],
};

/** Pull the embedded JSON payload back out of the assembled document. */
function extractPayload(html: string): unknown {
  const m = /<script type="application\/json" id="__qs_snapshot">([\s\S]*?)<\/script>/.exec(html);
  if (m === null) throw new Error("payload script not found");
  return JSON.parse(m[1] as string);
}

describe("assembleSnapshotHtml", () => {
  test("embeds the doc as JSON that parses back to the input (decode round-trip)", () => {
    const html = assembleSnapshotHtml(doc, "/* runtime */");
    const parsed = extractPayload(html) as SnapshotDoc;
    expect(parsed.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(parsed.blocks).toHaveLength(2);
    const table = parsed.blocks[1] as { kind: "table"; data: FrozenData };
    // The frozen data round-trips through the embed → parse → decode path unchanged.
    expect(decode(table.data)).toEqual(decode(data));
  });

  test("has no http(s) external reference anywhere", () => {
    const html = assembleSnapshotHtml(doc, "/* runtime */");
    expect(/https?:\/\//.test(html)).toBe(false);
  });

  test("declares the offline CSP with connect-src 'none'", () => {
    const html = assembleSnapshotHtml(doc, "/* runtime */");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });

  test("a </script> inside a cell value stays inert (escaped in the payload)", () => {
    const hostileData: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "x", type: "string" }],
      rows: [[{ kind: "string", value: "</script><img src=x onerror=alert(1)>" }]],
    };
    const hostileDoc: SnapshotDoc = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      blocks: [{ kind: "table", data: hostileData, truncated: false }],
    };
    const html = assembleSnapshotHtml(hostileDoc, "/* runtime */");
    // The payload carries no raw `</script` — only the two real script closers exist, so the
    // hostile cell cannot break out. And the value survives a round-trip decode intact.
    const payload = extractPayload(html) as SnapshotDoc;
    const table = payload.blocks[0] as { kind: "table"; data: FrozenData };
    expect((table.data.rows[0]![0] as { value: string }).value).toBe(
      "</script><img src=x onerror=alert(1)>",
    );
    expect((html.match(/<\/script/gi) ?? []).length).toBe(2);
  });

  test("a hostile runtime containing a literal </script> is neutralized (exactly two real closers)", () => {
    const hostileRuntime = "console.log('</script><img src=x>'); var a = 1 </SCRIPT bad;";
    const html = assembleSnapshotHtml(doc, hostileRuntime);
    // Both `</script` occurrences inside the runtime (lower AND upper case) are escaped to
    // `<\/script`, so the only real closing tags are the two the assembler emits (json payload
    // + runtime script). If either had broken out, the count would exceed two.
    expect((html.match(/<\/script/gi) ?? []).length).toBe(2);
    // The runtime text is still present, but every closer is neutralized with a backslash.
    expect(html).toContain("<\\/script>");
    expect(html).toContain("<\\/script bad;");
  });
});

describe("embedJson", () => {
  test("escapes <, >, & and stays valid JSON that round-trips", () => {
    const value = { s: "a<b>c&d" };
    const out = embedJson(value);
    expect(out.includes("<")).toBe(false);
    expect(out.includes(">")).toBe(false);
    expect(JSON.parse(out)).toEqual(value);
  });
});
