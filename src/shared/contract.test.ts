import { describe, expect, test } from "bun:test";
import {
  FROZEN_SCHEMA_VERSION,
  SANDBOX_PROTOCOL_VERSION,
  assertIsoUtc,
  decode,
  encode,
  errorReply,
  isSandboxInbound,
  isSandboxOutbound,
  okReply,
  toIsoUtc,
  type FrozenData,
  type SandboxInbound,
  type SandboxOutbound,
} from "./contract.ts";

const fixture: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
    { name: "active", type: "boolean" },
    { name: "created_at", type: "date" },
    { name: "deleted_at", type: "null" },
  ],
  rows: [
    [
      { kind: "number", value: 1 },
      { kind: "string", value: "alpha" },
      { kind: "boolean", value: true },
      { kind: "date", iso: "2026-07-06T12:00:00Z" },
      { kind: "null" },
    ],
    [
      { kind: "number", value: 2 },
      { kind: "string", value: "" },
      { kind: "boolean", value: false },
      { kind: "date", iso: "2020-01-01T00:00:00.500Z" },
      { kind: "null" },
    ],
  ],
};

describe("frozen-data round-trip", () => {
  test("decode(encode(x)) deep-equals x", () => {
    const round = decode(encode(fixture));
    expect(round).toEqual(fixture);
  });

  test("encode is idempotent", () => {
    expect(encode(encode(fixture))).toEqual(encode(fixture));
  });

  test("survives the real JSON wire boundary", () => {
    // encode/decode are in-memory transforms, but the RPC path serializes with
    // JSON.stringify. Prove the round-trip holds across an actual JSON hop.
    const wire = JSON.parse(JSON.stringify(encode(fixture)));
    expect(decode(wire)).toEqual(fixture);
  });

  test("normalizes -0 to 0 so it is JSON-wire-stable", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "n", type: "number" }],
      rows: [[{ kind: "number", value: -0 }]],
    };
    const wire = JSON.parse(JSON.stringify(encode(data)));
    const cell = decode(wire).rows[0]?.[0];
    expect(cell).toEqual({ kind: "number", value: 0 });
    expect(Object.is((cell as { value: number }).value, 0)).toBe(true);
  });

  test("carries the schema version", () => {
    expect(encode(fixture).schemaVersion).toBe(FROZEN_SCHEMA_VERSION);
  });

  test("rejects an unsupported schema version", () => {
    const bad = { ...fixture, schemaVersion: 999 } as unknown as FrozenData;
    expect(() => encode(bad)).toThrow();
    expect(() => decode(bad)).toThrow();
  });

  test("rejects a non-finite number cell", () => {
    const bad: FrozenData = {
      ...fixture,
      rows: [[{ kind: "number", value: Number.POSITIVE_INFINITY }]],
      columns: [{ name: "n", type: "number" }],
    };
    expect(() => encode(bad)).toThrow();
  });

  test("rejects a ragged row (cell count != column count)", () => {
    const bad: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [
        { name: "a", type: "number" },
        { name: "b", type: "string" },
      ],
      rows: [[{ kind: "number", value: 1 }]], // 1 cell for 2 columns
    };
    expect(() => encode(bad)).toThrow();
    expect(() => decode(bad)).toThrow();
  });

  test("rejects a cell whose kind disagrees with its column type", () => {
    const bad: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "id", type: "number" }],
      rows: [[{ kind: "string", value: "x" }]],
    };
    expect(() => encode(bad)).toThrow();
    expect(() => decode(bad)).toThrow();
  });

  test("admits a null cell in any typed column", () => {
    const ok: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "id", type: "number" }],
      rows: [[{ kind: "null" }]],
    };
    expect(() => encode(ok)).not.toThrow();
    expect(decode(encode(ok))).toEqual(ok);
  });

  test("rejects non-array columns/rows", () => {
    const badCols = { ...fixture, columns: null } as unknown as FrozenData;
    const badRows = { ...fixture, rows: null } as unknown as FrozenData;
    expect(() => encode(badCols)).toThrow();
    expect(() => encode(badRows)).toThrow();
  });
});

describe("ISO-8601 UTC enforcement", () => {
  test("accepts canonical UTC instants", () => {
    expect(() => assertIsoUtc("2026-07-06T12:00:00Z")).not.toThrow();
    expect(() => assertIsoUtc("2026-07-06T12:00:00.123Z")).not.toThrow();
  });

  test("rejects a non-UTC offset date", () => {
    expect(() => assertIsoUtc("2026-07-06T12:00:00+02:00")).toThrow();
  });

  test("rejects a missing Z / date-only string", () => {
    expect(() => assertIsoUtc("2026-07-06T12:00:00")).toThrow();
    expect(() => assertIsoUtc("2026-07-06")).toThrow();
  });

  test("rejects an invalid calendar date", () => {
    expect(() => assertIsoUtc("2026-13-40T99:00:00Z")).toThrow();
  });

  test("rejects garbage", () => {
    expect(() => assertIsoUtc("not-a-date")).toThrow();
    expect(() => assertIsoUtc("")).toThrow();
  });

  test("encode throws on a non-UTC date cell", () => {
    const bad: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "d", type: "date" }],
      rows: [[{ kind: "date", iso: "2026-07-06T12:00:00+02:00" }]],
    };
    expect(() => encode(bad)).toThrow();
  });

  test("toIsoUtc produces an assertable canonical string", () => {
    const iso = toIsoUtc(new Date(Date.UTC(2026, 6, 6, 12, 0, 0)));
    expect(iso).toBe("2026-07-06T12:00:00.000Z");
    expect(() => assertIsoUtc(iso)).not.toThrow();
  });

  test("toIsoUtc throws a TypeError on an invalid Date (not a raw RangeError)", () => {
    expect(() => toIsoUtc(new Date("garbage"))).toThrow(TypeError);
    expect(() => toIsoUtc(new Date(NaN))).toThrow(TypeError);
  });
});

describe("sandbox protocol guards (Story 5.5; widened in 5.6)", () => {
  // A valid protocol-2 render frame: escaped Markdown + a validated chart naming real
  // columns of `fixture` + the canonical FrozenData.
  const renderFrame: SandboxInbound = {
    type: "render",
    protocolVersion: SANDBOX_PROTOCOL_VERSION,
    markdown: "# heading\n\nsome **prose**",
    chart: { mark: "bar", x: "name", y: "id" },
    data: fixture,
  };

  describe("isSandboxInbound", () => {
    test("accepts a valid render frame carrying markdown, a valid chart, and valid FrozenData", () => {
      expect(isSandboxInbound(renderFrame)).toBe(true);
    });

    test("accepts a chart-less render frame (chart: null)", () => {
      expect(isSandboxInbound({ ...renderFrame, chart: null })).toBe(true);
    });

    test("rejects a wrong tag", () => {
      expect(isSandboxInbound({ ...renderFrame, type: "run-query" })).toBe(false);
      expect(isSandboxInbound({ ...renderFrame, type: "data-request" })).toBe(false);
    });

    test("rejects a wrong / absent protocol version", () => {
      expect(isSandboxInbound({ ...renderFrame, protocolVersion: 999 })).toBe(false);
      expect(isSandboxInbound({ ...renderFrame, protocolVersion: 1 })).toBe(false); // old version
      expect(isSandboxInbound({ type: "render", markdown: "", chart: null, data: fixture })).toBe(false);
    });

    test("rejects a non-object", () => {
      expect(isSandboxInbound(null)).toBe(false);
      expect(isSandboxInbound("render")).toBe(false);
      expect(isSandboxInbound(undefined)).toBe(false);
    });

    test("rejects a non-string or over-long markdown (untrusted text is length-capped)", () => {
      expect(isSandboxInbound({ ...renderFrame, markdown: 7 })).toBe(false);
      expect(isSandboxInbound({ ...renderFrame, markdown: undefined })).toBe(false);
      expect(isSandboxInbound({ ...renderFrame, markdown: "x".repeat(20000) })).toBe(true);
      expect(isSandboxInbound({ ...renderFrame, markdown: "x".repeat(20001) })).toBe(false);
    });

    test("rejects a chart naming a column absent from the pushed data", () => {
      expect(isSandboxInbound({ ...renderFrame, chart: { mark: "bar", x: "nope", y: "id" } })).toBe(false);
      expect(isSandboxInbound({ ...renderFrame, chart: { mark: "line", x: "name", y: "missing" } })).toBe(false);
    });

    test("rejects a malformed chart (unknown mark / not-an-object / absent field)", () => {
      expect(isSandboxInbound({ ...renderFrame, chart: { mark: "pie", x: "name", y: "id" } })).toBe(false);
      expect(isSandboxInbound({ ...renderFrame, chart: { x: "name", y: "id" } })).toBe(false);
      expect(isSandboxInbound({ ...renderFrame, chart: "line" })).toBe(false);
      // `chart` must be exactly null-or-valid — an absent (undefined) chart is not admissible.
      expect(isSandboxInbound({ ...renderFrame, chart: undefined })).toBe(false);
    });

    test("rejects a render frame whose data fails FrozenData decoding", () => {
      const ragged = {
        schemaVersion: FROZEN_SCHEMA_VERSION,
        columns: [{ name: "a", type: "number" }, { name: "b", type: "string" }],
        rows: [[{ kind: "number", value: 1 }]], // one cell for two columns
      };
      const base = { type: "render", protocolVersion: SANDBOX_PROTOCOL_VERSION, markdown: "", chart: null };
      expect(isSandboxInbound({ ...base, data: ragged })).toBe(false);
      expect(isSandboxInbound({ ...base })).toBe(false); // no data
      expect(isSandboxInbound({ ...base, data: null })).toBe(false);
    });
  });

  describe("isSandboxOutbound", () => {
    const ready: SandboxOutbound = { type: "ready", protocolVersion: SANDBOX_PROTOCOL_VERSION };
    const height: SandboxOutbound = { type: "height", protocolVersion: SANDBOX_PROTOCOL_VERSION, px: 240 };
    const clicked: SandboxOutbound = { type: "datum-clicked", protocolVersion: SANDBOX_PROTOCOL_VERSION, row: 2, col: 3 };
    const err: SandboxOutbound = { type: "error", protocolVersion: SANDBOX_PROTOCOL_VERSION, message: "boom" };

    test("accepts every valid signal frame", () => {
      for (const frame of [ready, height, clicked, err]) {
        expect(isSandboxOutbound(frame)).toBe(true);
      }
    });

    test("rejects a wrong tag", () => {
      expect(isSandboxOutbound({ type: "render", protocolVersion: SANDBOX_PROTOCOL_VERSION })).toBe(false);
      expect(isSandboxOutbound({ type: "data", protocolVersion: SANDBOX_PROTOCOL_VERSION })).toBe(false);
    });

    test("rejects a wrong / absent protocol version", () => {
      expect(isSandboxOutbound({ ...ready, protocolVersion: 1 })).toBe(false); // old version
      expect(isSandboxOutbound({ type: "ready" })).toBe(false);
    });

    test("rejects a non-object", () => {
      expect(isSandboxOutbound(null)).toBe(false);
      expect(isSandboxOutbound(42)).toBe(false);
    });

    test("rejects a malformed numeric payload", () => {
      expect(isSandboxOutbound({ ...height, px: "240" })).toBe(false);
      expect(isSandboxOutbound({ ...height, px: Number.NaN })).toBe(false);
      expect(isSandboxOutbound({ ...clicked, row: 1.5 })).toBe(false);
      expect(isSandboxOutbound({ ...clicked, col: "3" })).toBe(false);
      expect(isSandboxOutbound({ ...err, message: 7 })).toBe(false);
    });

    test("rejects a negative height px (bounds an untrusted guest field)", () => {
      expect(isSandboxOutbound({ ...height, px: -1 })).toBe(false);
      // Zero is a legitimate measured height (empty content).
      expect(isSandboxOutbound({ ...height, px: 0 })).toBe(true);
    });

    test("rejects negative datum-clicked coordinates (never a negative grid index)", () => {
      expect(isSandboxOutbound({ ...clicked, row: -1 })).toBe(false);
      expect(isSandboxOutbound({ ...clicked, col: -1 })).toBe(false);
      // Zero coordinates are the first cell — admissible.
      expect(isSandboxOutbound({ ...clicked, row: 0, col: 0 })).toBe(true);
    });

    test("rejects an over-long error message (untrusted guest text is length-capped)", () => {
      expect(isSandboxOutbound({ ...err, message: "x".repeat(1000) })).toBe(true);
      expect(isSandboxOutbound({ ...err, message: "x".repeat(1001) })).toBe(false);
    });
  });
});

describe("error-envelope shape", () => {
  test("okReply wraps a typed result", () => {
    const reply = okReply({ status: "ok" as const, schemaVersion: FROZEN_SCHEMA_VERSION });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result.status).toBe("ok");
      expect(reply.result.schemaVersion).toBe(FROZEN_SCHEMA_VERSION);
    }
  });

  test("errorReply yields { code, message } without detail", () => {
    const reply = errorReply("unauthorized", "missing token");
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error).toEqual({ code: "unauthorized", message: "missing token" });
      expect(reply.error).not.toHaveProperty("detail");
    }
  });

  test("errorReply carries detail when provided", () => {
    const reply = errorReply("unknown_method", "no such method", "method=frobnicate");
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error).toEqual({
        code: "unknown_method",
        message: "no such method",
        detail: "method=frobnicate",
      });
    }
  });
});
