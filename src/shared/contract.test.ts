import { describe, expect, test } from "bun:test";
import {
  FROZEN_SCHEMA_VERSION,
  ISO_UTC_LENIENT_RE,
  ISO_UTC_RE,
  SANDBOX_PROTOCOL_VERSION,
  assertIsoUtc,
  decode,
  encode,
  errorReply,
  isSandboxInbound,
  isSandboxOutbound,
  normalizeIsoUtc,
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

describe("millisecond precision policy (DW-6) — normalizeIsoUtc", () => {
  test("truncates a microsecond instant to milliseconds", () => {
    expect(normalizeIsoUtc("2026-07-06T12:00:00.123456Z")).toBe("2026-07-06T12:00:00.123Z");
  });

  test("truncates, never rounds — the second is left unchanged", () => {
    expect(normalizeIsoUtc("2026-07-06T12:00:59.999999Z")).toBe("2026-07-06T12:00:59.999Z");
  });

  test("floors a sub-millisecond-only fraction to .000 (never carries)", () => {
    expect(normalizeIsoUtc("2026-07-06T12:00:00.000123Z")).toBe("2026-07-06T12:00:00.000Z");
  });

  test("returns in-policy strings (0-3 fractional digits) byte-identical", () => {
    for (const iso of [
      "2026-07-06T12:00:00Z",
      "2026-07-06T12:00:00.5Z",
      "2026-07-06T12:00:00.50Z",
      "2026-07-06T12:00:00.123Z",
    ]) {
      expect(normalizeIsoUtc(iso)).toBe(iso);
    }
  });

  test("is idempotent on an over-precise instant (normalize∘normalize = normalize)", () => {
    const once = normalizeIsoUtc("2026-07-06T12:00:00.123456Z");
    expect(normalizeIsoUtc(once)).toBe(once);
  });

  test("an over-precise date CELL decodes to the millisecond form; the whole payload is accepted", () => {
    const data: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "d", type: "date" }],
      rows: [[{ kind: "date", iso: "2026-07-06T12:00:00.123456Z" }]],
    };
    const cell = decode(data).rows[0]?.[0];
    expect(cell).toEqual({ kind: "date", iso: "2026-07-06T12:00:00.123Z" });
    expect(() => encode(data)).not.toThrow();
  });

  test("an all-zero over-precise fraction floors to .000Z (passes only via assertIsoUtc's trailing-zero compare)", () => {
    expect(normalizeIsoUtc("2026-07-06T12:00:00.0000Z")).toBe("2026-07-06T12:00:00.000Z");
  });

  test("rejects an over-precise NON-UTC offset (only the fractional field may change)", () => {
    expect(() => normalizeIsoUtc("2026-07-06T12:00:00.123456+02:00")).toThrow(TypeError);
  });

  test("rejects an over-precise but impossible calendar date", () => {
    expect(() => normalizeIsoUtc("2026-13-40T12:00:00.123456Z")).toThrow(TypeError);
  });

  test("rejects a leap-second instant even when over-precise", () => {
    expect(() => normalizeIsoUtc("2026-07-06T12:00:60.999999Z")).toThrow(TypeError);
  });

  test("rejects an empty fractional part", () => {
    expect(() => normalizeIsoUtc("2026-07-06T12:00:00.Z")).toThrow(TypeError);
  });

  test("rejects a non-string, and non-serializable inputs that would break JSON.stringify", () => {
    expect(() => normalizeIsoUtc(null as unknown as string)).toThrow(TypeError);
    // A BigInt makes `JSON.stringify` throw — describeIsoInput must String()-echo it instead.
    expect(() => normalizeIsoUtc(123n as unknown as string)).toThrow(TypeError);
    // A cyclic object also breaks JSON.stringify; the message must still build (and be readable).
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let message = "";
    try {
      normalizeIsoUtc(cyclic as unknown as string);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("Invalid ISO-8601 UTC date");
  });

  test("assertIsoUtc accepts 1-, 2- and 3-digit fractions and rejects 4+ (stays strict)", () => {
    expect(() => assertIsoUtc("2026-07-06T12:00:00.1Z")).not.toThrow();
    expect(() => assertIsoUtc("2026-07-06T12:00:00.12Z")).not.toThrow();
    expect(() => assertIsoUtc("2026-07-06T12:00:00.123Z")).not.toThrow();
    expect(() => assertIsoUtc("2026-07-06T12:00:00.1234Z")).toThrow(TypeError);
    expect(() => assertIsoUtc("2026-07-06T12:00:00.123456Z")).toThrow(TypeError);
  });

  test("property: every string matching ISO_UTC_RE also matches ISO_UTC_LENIENT_RE (no drift)", () => {
    const dates = ["2026-07-06", "2020-01-01", "1969-12-31", "0001-01-01"];
    const times = ["12:00:00", "00:00:00", "23:59:59", "12:34:56"];
    const fracs = ["", ".1", ".12", ".123", ".5", ".50", ".500", ".999", ".0", ".00", ".000"];
    // Also throw in some strings the STRICT pattern must reject, to prove the implication is
    // non-vacuous (they are simply skipped, never asserted against the lenient pattern).
    const overPrecise = [".1234", ".123456", ".000123", ".9999"];
    for (const d of dates) {
      for (const t of times) {
        for (const f of [...fracs, ...overPrecise]) {
          const s = `${d}T${t}${f}Z`;
          if (ISO_UTC_RE.test(s)) {
            expect(ISO_UTC_LENIENT_RE.test(s)).toBe(true);
          }
        }
      }
    }
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
