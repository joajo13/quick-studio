/**
 * Unit tests for the Snapshot payload guard (Story 6.3). `isSnapshotDoc` is the sole trust
 * gate the offline runtime applies to the embedded payload it just parsed out of a possibly
 * corrupted / hand-edited / schema-drifted file, so it must DEEP-validate every block.
 */

import { describe, expect, test } from "bun:test";
import { FROZEN_SCHEMA_VERSION, type FrozenData } from "./contract.ts";
import { isSnapshotDoc, normalizeSnapshotDoc, SNAPSHOT_SCHEMA_VERSION, type SnapshotDoc } from "./snapshot.ts";

const validData: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [
    { name: "a", type: "number" },
    { name: "b", type: "string" },
  ],
  rows: [
    [
      { kind: "number", value: 1 },
      { kind: "string", value: "x" },
    ],
  ],
};

const wellFormedDoc: SnapshotDoc = {
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  blocks: [
    { kind: "prose", markdown: "# hi" },
    { kind: "table", data: validData, truncated: false },
    { kind: "chart", chart: { mark: "bar", x: "a", y: "a" }, data: validData, truncated: true },
    { kind: "empty", note: "no data" },
  ],
};

describe("isSnapshotDoc", () => {
  test("accepts a well-formed doc with every block kind + the truncated flag", () => {
    expect(isSnapshotDoc(wellFormedDoc)).toBe(true);
  });

  test("rejects a wrong doc schemaVersion", () => {
    expect(isSnapshotDoc({ ...wellFormedDoc, schemaVersion: 2 })).toBe(false);
  });

  test("rejects a missing / non-array blocks", () => {
    expect(isSnapshotDoc({ schemaVersion: SNAPSHOT_SCHEMA_VERSION })).toBe(false);
    expect(isSnapshotDoc({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, blocks: "nope" })).toBe(false);
  });

  test("rejects an unknown block kind", () => {
    expect(
      isSnapshotDoc({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, blocks: [{ kind: "video", src: "x" }] }),
    ).toBe(false);
  });

  test("rejects a table block missing the truncated flag", () => {
    expect(
      isSnapshotDoc({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, blocks: [{ kind: "table", data: validData }] }),
    ).toBe(false);
  });

  test("rejects a table/chart data that is a bare object but NOT valid FrozenData (ragged rows)", () => {
    const ragged: unknown = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "a", type: "number" }, { name: "b", type: "string" }],
      rows: [[{ kind: "number", value: 1 }]], // 1 cell for a 2-column table
    };
    expect(
      isSnapshotDoc({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        blocks: [{ kind: "table", data: ragged, truncated: false }],
      }),
    ).toBe(false);
  });

  test("rejects a table whose columns are not an array", () => {
    const bad: unknown = { schemaVersion: FROZEN_SCHEMA_VERSION, columns: "nope", rows: [] };
    expect(
      isSnapshotDoc({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        blocks: [{ kind: "table", data: bad, truncated: false }],
      }),
    ).toBe(false);
  });

  test("rejects a block whose inner data.schemaVersion differs from FROZEN_SCHEMA_VERSION", () => {
    const drifted: unknown = { ...validData, schemaVersion: 999 };
    expect(
      isSnapshotDoc({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        blocks: [{ kind: "table", data: drifted, truncated: false }],
      }),
    ).toBe(false);
  });

  test("rejects a chart block whose spec does not validate against the data columns", () => {
    expect(
      isSnapshotDoc({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        blocks: [{ kind: "chart", chart: { mark: "bar", x: "missing", y: "a" }, data: validData, truncated: false }],
      }),
    ).toBe(false);
  });

  test("rejects a non-object / null", () => {
    expect(isSnapshotDoc(null)).toBe(false);
    expect(isSnapshotDoc("doc")).toBe(false);
  });
});

describe("normalizeSnapshotDoc — millisecond precision (DW-6)", () => {
  const overPreciseData: FrozenData = {
    schemaVersion: FROZEN_SCHEMA_VERSION,
    columns: [{ name: "t", type: "date" }],
    rows: [[{ kind: "date", iso: "2026-07-06T12:00:00.123456Z" }]],
  };

  test("a doc with an over-precise date cell passes isSnapshotDoc and floors to .123Z", () => {
    const doc: SnapshotDoc = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      blocks: [{ kind: "table", data: overPreciseData, truncated: false }],
    };
    // The guard accepts it (decode succeeds) but never rewrites the payload…
    expect(isSnapshotDoc(doc)).toBe(true);
    // …so normalizeSnapshotDoc is what canonicalizes the embedded cell.
    const normalized = normalizeSnapshotDoc(doc);
    const block = normalized.blocks[0] as { kind: "table"; data: FrozenData };
    expect(block.data.rows[0]?.[0]).toEqual({ kind: "date", iso: "2026-07-06T12:00:00.123Z" });
  });

  test("passes prose/empty blocks through by reference", () => {
    const prose = { kind: "prose", markdown: "# hi" } as const;
    const empty = { kind: "empty", note: "no data" } as const;
    const doc: SnapshotDoc = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, blocks: [prose, empty] };
    const normalized = normalizeSnapshotDoc(doc);
    expect(normalized.blocks[0]).toBe(prose);
    expect(normalized.blocks[1]).toBe(empty);
  });
});
