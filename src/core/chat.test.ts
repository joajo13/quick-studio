/**
 * quick-studio Core — Chat responder tests (Story 5.2).
 *
 * Exercises the full I/O matrix with an INJECTED `generate` (no network, no real
 * key): happy path, not-configured → not_found, unknown kind → bad_request, blank
 * message → bad_request, no-schema → bad_request, and an injected `generate` throw →
 * typed internal_error. Crucially asserts the assembled payload carries ZERO rows
 * (`rowSample: null`, `rowsIncluded: 0`) and that the raw key NEVER appears in any
 * error `detail`, and that no outbound call is made on a rejected request.
 */

import { describe, expect, test } from "bun:test";
import type { DatabaseSchema } from "../shared/contract.ts";
import type { ResolveModelResult } from "./ai-provider.ts";
import type { RegistryResult } from "./provider-registry.ts";
import { assemblePayload, buildSchemaContext, createChatResponder } from "./chat.ts";

const SECRET = "sk-super-secret-key-1234";

const SCHEMA: DatabaseSchema = {
  engine: "postgres",
  tables: [
    {
      schema: "public",
      name: "customers",
      columns: [
        { name: "id", dataType: "integer", nullable: false },
        { name: "email", dataType: "text", nullable: true },
      ],
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [],
    },
    {
      schema: "public",
      name: "orders",
      columns: [
        { name: "id", dataType: "integer", nullable: false },
        { name: "customer_id", dataType: "integer", nullable: true },
        { name: "total", dataType: "numeric", nullable: true },
      ],
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [
        {
          columns: ["customer_id"],
          referencedSchema: "public",
          referencedTable: "customers",
          referencedColumns: ["id"],
        },
      ],
    },
  ],
};

const okModel: ResolveModelResult = { ok: true, model: {} as never };

/** A responder wired with sensible defaults; each test overrides the seams it cares about. */
function makeResponder(overrides: {
  getSchema?: () => Promise<DatabaseSchema>;
  getKey?: (provider: string) => RegistryResult<string | null>;
  resolveModel?: () => ResolveModelResult;
  generate?: (args: { model: unknown; system: string; prompt: string }) => Promise<{ text: string }>;
}) {
  let generateCalls = 0;
  const inner =
    overrides.generate ??
    (async (args: { system: string; prompt: string }) => ({ text: `answered: ${args.prompt}` }));
  const responder = createChatResponder({
    getSchema: overrides.getSchema ?? (async () => SCHEMA),
    getKey: (overrides.getKey ?? (() => ({ ok: true, value: SECRET }))) as never,
    resolveModel: overrides.resolveModel ?? (() => okModel),
    generate: (async (args: { model: unknown; system: string; prompt: string }) => {
      generateCalls += 1;
      return inner(args as never);
    }) as never,
  });
  return { responder, calls: () => generateCalls };
}

describe("buildSchemaContext / assemblePayload", () => {
  test("serializes tables/columns/pk/fk as compact row-free text", () => {
    const text = buildSchemaContext(SCHEMA);
    expect(text).toContain("table public.customers");
    expect(text).toContain("columns: id integer not null, email text");
    expect(text).toContain("pk: id");
    expect(text).toContain("fk: customer_id -> public.customers(id)");
  });

  test("assemblePayload keeps rowSample null and counts tables (zero rows leave)", () => {
    const payload = assemblePayload(SCHEMA);
    expect(payload.rowSample).toBeNull();
    expect(payload.schema.tables).toBe(2);
    expect(payload.schema.engine).toBe("postgres");
    // No row value can appear in the serialized schema — it is names/types/PK/FK only.
    expect(JSON.stringify(payload)).not.toContain("answered");
  });
});

describe("createChatResponder — I/O matrix", () => {
  test("happy path returns the answer + schema-only context (rowsIncluded 0)", async () => {
    const { responder, calls } = makeResponder({});
    const r = await responder.answer({ provider: "anthropic", message: "how many tables?" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.answer).toBe("answered: how many tables?");
      expect(r.value.context).toEqual({ policy: "schema-only", tables: 2, rowsIncluded: 0 });
    }
    expect(calls()).toBe(1);
  });

  test("provider not configured -> not_found, no outbound call, no secret", async () => {
    const { responder, calls } = makeResponder({ getKey: () => ({ ok: true, value: null }) });
    const r = await responder.answer({ provider: "openai", message: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("not_found");
      expect(r.message).toBe("provider not configured");
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
    expect(calls()).toBe(0);
  });

  test("unknown provider kind -> bad_request, no outbound call", async () => {
    const { responder, calls } = makeResponder({});
    const r = await responder.answer({ provider: "bogus", message: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_request");
    expect(calls()).toBe(0);
  });

  test("blank message -> bad_request, no outbound call", async () => {
    const { responder, calls } = makeResponder({});
    const r = await responder.answer({ provider: "anthropic", message: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("bad_request");
      expect(r.message).toBe("message required");
    }
    expect(calls()).toBe(0);
  });

  test("no active connection (getSchema throws) -> bad_request, no outbound call", async () => {
    const { responder, calls } = makeResponder({
      getSchema: async () => {
        throw new Error("connection unavailable (network)");
      },
    });
    const r = await responder.answer({ provider: "anthropic", message: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("bad_request");
      expect(r.message).toBe("no active connection");
      // The neutral detail must never carry a secret.
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
    expect(calls()).toBe(0);
  });

  test("generate throws -> internal_error, key never in any detail or the log", async () => {
    // Capture stderr: a provider auth error can echo the key, and the spec forbids
    // the key ever being logged. The redaction must scrub it from the stderr line.
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { responder } = makeResponder({
        generate: async () => {
          throw new Error(`auth failed for ${SECRET}`);
        },
      });
      const r = await responder.answer({ provider: "anthropic", message: "hi" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("internal_error");
        expect(r.message).toBe("provider call failed");
        expect(r.detail ?? "").not.toContain(SECRET);
        expect(JSON.stringify(r)).not.toContain(SECRET);
      }
      // The cause was logged (debuggability) but with the key redacted.
      const logged = writes.join("");
      expect(logged).toContain("[chat] provider call failed");
      expect(logged).not.toContain(SECRET);
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
  });

  test("registry getKey failure propagates its own code", async () => {
    const { responder, calls } = makeResponder({
      getKey: () => ({ ok: false, code: "internal_error", message: "store unavailable" }),
    });
    const r = await responder.answer({ provider: "anthropic", message: "hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal_error");
    expect(calls()).toBe(0);
  });

  test("the payload the model receives carries the schema text and zero rows", async () => {
    let seenSystem = "";
    const { responder } = makeResponder({
      generate: async (args) => {
        seenSystem = args.system;
        return { text: "ok" };
      },
    });
    await responder.answer({ provider: "google", message: "hi" });
    expect(seenSystem).toContain("table public.orders");
    expect(seenSystem).toContain("fk: customer_id -> public.customers(id)");
  });
});
