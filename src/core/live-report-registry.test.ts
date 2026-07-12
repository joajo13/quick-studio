/**
 * Unit tests for the Live Report registry (Story 6.4): publish returns distinct non-sequential
 * ids; get round-trips the doc; get(unknown) → null; publish(invalid) throws; a bounded
 * registry evicts the oldest.
 */

import { describe, expect, test } from "bun:test";
import { LIVE_REPORT_SCHEMA_VERSION, type LiveReportDoc } from "../shared/live-report.ts";
import { createLiveReportRegistry, InvalidLiveReportError } from "./live-report-registry.ts";

const doc = (markdown: string): LiveReportDoc => ({
  schemaVersion: LIVE_REPORT_SCHEMA_VERSION,
  blocks: [{ kind: "prose", markdown }],
});

describe("createLiveReportRegistry", () => {
  test("publish returns distinct, non-sequential opaque ids", () => {
    const reg = createLiveReportRegistry();
    const a = reg.publish(doc("a"));
    const b = reg.publish(doc("b"));
    expect(a).not.toBe(b);
    // Opaque hex (mirrors the session token), not a small counter.
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(Number.isNaN(Number(a))).toBe(true);
  });

  test("get round-trips the published doc", () => {
    const reg = createLiveReportRegistry();
    const d = doc("hello");
    const id = reg.publish(d);
    expect(reg.get(id)).toEqual(d);
  });

  test("get(unknown) → null", () => {
    const reg = createLiveReportRegistry();
    expect(reg.get("nope")).toBeNull();
  });

  test("publish(invalid) throws InvalidLiveReportError", () => {
    const reg = createLiveReportRegistry();
    expect(() => reg.publish({ schemaVersion: 99, blocks: [] } as unknown as LiveReportDoc)).toThrow(
      InvalidLiveReportError,
    );
    expect(() => reg.publish({ blocks: "nope" } as unknown as LiveReportDoc)).toThrow();
  });

  test("a bounded registry evicts the oldest", () => {
    const reg = createLiveReportRegistry(2);
    const idA = reg.publish(doc("a"));
    const idB = reg.publish(doc("b"));
    const idC = reg.publish(doc("c")); // evicts A
    expect(reg.get(idA)).toBeNull();
    expect(reg.get(idB)).toEqual(doc("b"));
    expect(reg.get(idC)).toEqual(doc("c"));
  });
});
