/**
 * quick-studio Core — Chat responder tests (Story 5.2, streamed in Story 5.4).
 *
 * Exercises the full streaming I/O matrix with an INJECTED `generateStream` (no
 * network, no real key): reasoning-vs-text routing, the terminal `done.query`
 * extracted from the ACCUMULATED answer text, the pre-flight error chunks
 * (not-configured / unknown kind / blank message / no-schema / registry failure),
 * and a mid-stream throw → a redacted `error` chunk. Crucially asserts the assembled
 * payload the model receives carries ZERO rows (`rowSample: null`, schema text only)
 * and that the raw key NEVER appears in any chunk or the stderr log.
 */

import { describe, expect, test } from "bun:test";
import type { ChatStreamChunk, DatabaseSchema } from "../shared/contract.ts";
import type { ResolveModelResult } from "./ai-provider.ts";
import type { RegistryResult } from "./provider-registry.ts";
import {
  assemblePayload,
  buildChatSystemPrompt,
  buildSchemaContext,
  createChatResponder,
  extractQuery,
  type ChatStreamPart,
  type GenerateStreamFn,
} from "./chat.ts";

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

/** A `generateStream` whose `fullStream` yields the given parts in order. */
function streamOf(...parts: ChatStreamPart[]): GenerateStreamFn {
  return () => ({
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  });
}

/** A responder wired with sensible defaults; each test overrides the seams it cares about. */
function makeResponder(overrides: {
  getSchema?: () => Promise<DatabaseSchema>;
  getKey?: (provider: string) => RegistryResult<string | null>;
  resolveModel?: () => ResolveModelResult;
  generateStream?: GenerateStreamFn;
}) {
  let streamCalls = 0;
  let seenSystem = "";
  const inner = overrides.generateStream ?? streamOf({ type: "text-delta", text: "ok" });
  const responder = createChatResponder({
    getSchema: overrides.getSchema ?? (async () => SCHEMA),
    getKey: (overrides.getKey ?? (() => ({ ok: true, value: SECRET }))) as never,
    resolveModel: overrides.resolveModel ?? (() => okModel),
    generateStream: (args) => {
      streamCalls += 1;
      seenSystem = args.system;
      return inner(args);
    },
  });
  return { responder, calls: () => streamCalls, system: () => seenSystem };
}

/** Drain an async generator into an array. */
async function collect(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
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
    expect(JSON.stringify(payload)).not.toContain("answered");
  });
});

describe("buildChatSystemPrompt", () => {
  test("composes the SQL-emitting instruction with the engine and the schema stanzas", () => {
    const prompt = buildChatSystemPrompt(assemblePayload(SCHEMA));
    expect(prompt).toContain("postgres database");
    expect(prompt).toContain("```sql fenced block");
    expect(prompt).toContain("do not invent tables or columns");
    expect(prompt).toContain("table public.customers");
    expect(prompt).toContain("table public.orders");
  });
});

describe("extractQuery", () => {
  test("extracts a ```sql fenced block, trimmed", () => {
    const text = "here you go:\n```sql\nSELECT * FROM customers;\n```\nlet me know.";
    expect(extractQuery(text)).toBe("SELECT * FROM customers;");
  });

  test("extracts a bare ``` fenced block when no `sql` tag is present", () => {
    expect(extractQuery("```\nSELECT 1;\n```")).toBe("SELECT 1;");
  });

  test("a non-`sql` language tag (```postgresql) is consumed, not captured into the query", () => {
    expect(extractQuery("```postgresql\nSELECT 1;\n```")).toBe("SELECT 1;");
    expect(extractQuery("```mysql\nSELECT 2;\n```")).toBe("SELECT 2;");
  });

  test("prose-only answer (no fenced block) -> null", () => {
    expect(extractQuery("there are 2 tables: customers and orders.")).toBeNull();
  });

  test("multiple fenced blocks -> the first one wins", () => {
    const text = "```sql\nSELECT 1;\n```\nand also\n```sql\nSELECT 2;\n```";
    expect(extractQuery(text)).toBe("SELECT 1;");
  });

  test("an empty fenced block -> null", () => {
    expect(extractQuery("```sql\n\n```")).toBeNull();
  });
});

describe("createChatResponder — answerStream I/O matrix", () => {
  test("routes reasoning vs text and ends with a done chunk (prose-only -> query null)", async () => {
    const { responder, calls } = makeResponder({
      generateStream: streamOf(
        { type: "reasoning-start" },
        { type: "reasoning-delta", text: "let me think " },
        { type: "reasoning-delta", text: "about tables" },
        { type: "text-start" },
        { type: "text-delta", text: "there are " },
        { type: "text-delta", text: "2 tables" },
        { type: "text-end" },
      ),
    });
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "how many?" }));
    expect(chunks).toEqual([
      { type: "reasoning-delta", text: "let me think " },
      { type: "reasoning-delta", text: "about tables" },
      { type: "text-delta", text: "there are " },
      { type: "text-delta", text: "2 tables" },
      { type: "done", query: null, context: { policy: "schema-only", tables: 2, rowsIncluded: 0 } },
    ]);
    expect(calls()).toBe(1);
  });

  test("done.query is extracted from the ACCUMULATED answer text (spanning deltas)", async () => {
    const { responder } = makeResponder({
      generateStream: streamOf(
        { type: "text-delta", text: "run:\n```sql\nSELECT count(*)" },
        { type: "text-delta", text: " FROM customers;\n```" },
      ),
    });
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "how many?" }));
    const done = chunks.at(-1);
    expect(done).toEqual({
      type: "done",
      query: "SELECT count(*) FROM customers;",
      context: { policy: "schema-only", tables: 2, rowsIncluded: 0 },
    });
  });

  test("the payload the model receives carries the schema text and zero rows", async () => {
    const { responder, system } = makeResponder({});
    await collect(responder.answerStream({ provider: "google", message: "hi" }));
    expect(system()).toContain("table public.orders");
    expect(system()).toContain("fk: customer_id -> public.customers(id)");
    // No row value can appear — schema is names/types/PK/FK only.
    expect(system()).not.toContain("answered");
  });

  test("provider not configured -> single error chunk (not_found), no outbound call, no secret", async () => {
    const { responder, calls } = makeResponder({ getKey: () => ({ ok: true, value: null }) });
    const chunks = await collect(responder.answerStream({ provider: "openai", message: "hi" }));
    expect(chunks).toEqual([{ type: "error", code: "not_found", message: "provider not configured" }]);
    expect(JSON.stringify(chunks)).not.toContain(SECRET);
    expect(calls()).toBe(0);
  });

  test("unknown provider kind -> error chunk (bad_request), no outbound call", async () => {
    const { responder, calls } = makeResponder({});
    const chunks = await collect(responder.answerStream({ provider: "bogus", message: "hi" }));
    expect(chunks).toEqual([{ type: "error", code: "bad_request", message: "invalid provider" }]);
    expect(calls()).toBe(0);
  });

  test("blank message -> error chunk (bad_request), no outbound call", async () => {
    const { responder, calls } = makeResponder({});
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "   " }));
    expect(chunks).toEqual([{ type: "error", code: "bad_request", message: "message required" }]);
    expect(calls()).toBe(0);
  });

  test("no active connection (getSchema throws) -> error chunk (bad_request), no outbound call, no secret", async () => {
    const { responder, calls } = makeResponder({
      getSchema: async () => {
        throw new Error("connection unavailable (network)");
      },
    });
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    expect(chunks).toEqual([{ type: "error", code: "bad_request", message: "no active connection" }]);
    expect(JSON.stringify(chunks)).not.toContain(SECRET);
    expect(calls()).toBe(0);
  });

  test("registry getKey failure propagates its own code as the error chunk", async () => {
    const { responder, calls } = makeResponder({
      getKey: () => ({ ok: false, code: "internal_error", message: "store unavailable" }),
    });
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    expect(chunks).toEqual([{ type: "error", code: "internal_error", message: "store unavailable" }]);
    expect(calls()).toBe(0);
  });

  test("mid-stream throw -> redacted error chunk, key never in any chunk or the log", async () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const failing: GenerateStreamFn = () => ({
        fullStream: (async function* () {
          yield { type: "text-delta", text: "partial " } as ChatStreamPart;
          throw new Error(`auth failed for ${SECRET}`);
        })(),
      });
      const { responder } = makeResponder({ generateStream: failing });
      const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
      // The partial delta streamed, then a redacted terminal error (no `done`).
      expect(chunks).toEqual([
        { type: "text-delta", text: "partial " },
        { type: "error", code: "internal_error", message: "provider call failed" },
      ]);
      expect(JSON.stringify(chunks)).not.toContain(SECRET);
      const logged = writes.join("");
      expect(logged).toContain("[chat] provider stream failed");
      expect(logged).not.toContain(SECRET);
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
  });

  test("the caller's AbortSignal is threaded into the generate seam (client-disconnect teardown)", async () => {
    let seenSignal: AbortSignal | undefined;
    const recording: GenerateStreamFn = (args) => {
      seenSignal = args.abortSignal;
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "hi" } as ChatStreamPart;
        })(),
      };
    };
    const responder = createChatResponder({
      getSchema: async () => SCHEMA,
      getKey: (() => ({ ok: true, value: SECRET })) as never,
      resolveModel: () => okModel,
      generateStream: recording,
    });
    const controller = new AbortController();
    await collect(responder.answerStream({ provider: "anthropic", message: "hi" }, controller.signal));
    // The exact signal the caller passed reaches `streamText`'s `abortSignal`.
    expect(seenSignal).toBe(controller.signal);
  });

  test("openai receives NO maxOutputTokens (never silently capped), anthropic does", async () => {
    const seen: { provider: string; maxOutputTokens?: number }[] = [];
    const recording: GenerateStreamFn = (args) => {
      seen.push({ provider: "", maxOutputTokens: args.maxOutputTokens });
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "ok" } as ChatStreamPart;
        })(),
      };
    };
    const make = (provider: string) =>
      createChatResponder({
        getSchema: async () => SCHEMA,
        getKey: (() => ({ ok: true, value: SECRET })) as never,
        resolveModel: () => okModel,
        generateStream: recording,
      }).answerStream({ provider, message: "hi" });
    await collect(make("openai"));
    await collect(make("anthropic"));
    expect(seen[0]?.maxOutputTokens).toBeUndefined();
    expect(seen[1]?.maxOutputTokens).toBeGreaterThan(0);
  });

  test("an SDK-emitted `error` part is treated as a redacted mid-stream failure", async () => {
    const { responder } = makeResponder({
      generateStream: streamOf(
        { type: "text-delta", text: "hi" },
        { type: "error", error: new Error(`boom ${SECRET}`) },
      ),
    });
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    expect(chunks).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "error", code: "internal_error", message: "provider call failed" },
    ]);
    expect(JSON.stringify(chunks)).not.toContain(SECRET);
  });
});
