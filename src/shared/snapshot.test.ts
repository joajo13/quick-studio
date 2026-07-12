/**
 * Unit tests for the Snapshot payload guard (Story 6.3). `isSnapshotDoc` is the sole trust
 * gate the offline runtime applies to the embedded payload it just parsed out of a possibly
 * corrupted / hand-edited / schema-drifted file, so it must DEEP-validate every block.
 */

import { describe, expect, test } from "bun:test";
import { FROZEN_SCHEMA_VERSION, type FrozenData } from "./contract.ts";
import { isSnapshotDoc, SNAPSHOT_SCHEMA_VERSION, type SnapshotDoc } from "./snapshot.ts";

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
