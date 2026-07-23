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
  getSchema?: (connectionId?: string | null) => Promise<DatabaseSchema>;
  getKey?: (provider: string) => RegistryResult<string | null>;
  resolveModel?: () => ResolveModelResult;
  generateStream?: GenerateStreamFn;
}) {
  let streamCalls = 0;
  let seenSystem = "";
  // Story 10.4: records the target the responder resolved the schema for, so the
  // request-body `connectionId` can be proven to reach the schema seam untouched.
  const seenConnectionIds: Array<string | null | undefined> = [];
  const inner = overrides.generateStream ?? streamOf({ type: "text-delta", text: "ok" });
  const getSchema = overrides.getSchema ?? (async () => SCHEMA);
  const responder = createChatResponder({
    getSchema: (connectionId) => {
      seenConnectionIds.push(connectionId);
      return getSchema(connectionId);
    },
    getKey: (overrides.getKey ?? (() => ({ ok: true, value: SECRET }))) as never,
    resolveModel: overrides.resolveModel ?? (() => okModel),
    generateStream: (args) => {
      streamCalls += 1;
      seenSystem = args.system;
      return inner(args);
    },
  });
  return {
    responder,
    calls: () => streamCalls,
    system: () => seenSystem,
    connectionIds: () => seenConnectionIds,
  };
}

/** Drain an async generator into an array. */
async function collect(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

/**
 * Run `fn` with `process.stderr.write` captured (same swap-restore pattern the
 * redaction tests use), returning everything written so the caller can assert the
 * provider key never reaches the log.
 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  return writes.join("");
}

/** A `generateStream` that streams one delta then throws `err` mid-stream. */
function throwingStream(err: unknown): GenerateStreamFn {
  return () => ({
    fullStream: (async function* () {
      yield { type: "text-delta", text: "partial " } as ChatStreamPart;
      throw err;
    })(),
  });
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

  test("also instructs the ```chart fenced JSON spec with the whitelisted marks (Story 5.6)", () => {
    const prompt = buildChatSystemPrompt(assemblePayload(SCHEMA));
    // The chart directive rides alongside the (preserved) SQL-block behavior.
    expect(prompt).toContain("```chart");
    expect(prompt).toContain("line, bar, dot, area");
    expect(prompt).toContain("markdown");
    // SQL-block behavior is preserved (both directives coexist).
    expect(prompt).toContain("```sql fenced block");
  });

  test("also instructs the ```report fenced JSON spec (Story 9.7), alongside sql/chart", () => {
    const prompt = buildChatSystemPrompt(assemblePayload(SCHEMA));
    expect(prompt).toContain("```report");
    expect(prompt).toContain("blocks");
    expect(prompt).toContain("```sql fenced block");
    expect(prompt).toContain("```chart");
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
      { type: "done", query: null, report: null, context: { policy: "schema-only", tables: 2, rowsIncluded: 0 } },
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
      report: null,
      context: { policy: "schema-only", tables: 2, rowsIncluded: 0 },
    });
  });

  test("done.report is extracted + validated from a ```report fence over the ACCUMULATED answer", async () => {
    const spec = {
      title: "Revenue by country",
      blocks: [
        { kind: "query" as const, sql: "SELECT country, sum(amount) AS revenue FROM orders GROUP BY country" },
      ],
    };
    const { responder } = makeResponder({
      generateStream: streamOf(
        { type: "text-delta", text: "here you go:\n\n```report\n" },
        { type: "text-delta", text: `${JSON.stringify(spec)}\n\`\`\`` },
      ),
    });
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "make a report" }));
    const done = chunks.at(-1);
    expect(done && "report" in done ? done.report : undefined).toEqual(spec);
    // A report answer degrades cleanly: `extractQuery` runs over the report-fence-STRIPPED
    // markdown, so the ```report JSON is NEVER mis-captured as a runnable query (which would
    // surface a spurious "run query" affordance alongside the "open report" action).
    expect(done && "query" in done ? done.query : undefined).toBeNull();
    expect(done && "context" in done ? done.context : undefined).toEqual({
      policy: "schema-only",
      tables: 2,
      rowsIncluded: 0,
    });
  });

  test("a malformed ```report fence -> done.report is null (degrades, opens nothing)", async () => {
    const { responder } = makeResponder({
      generateStream: streamOf({ type: "text-delta", text: "```report\n{ not json ]\n```" }),
    });
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "make a report" }));
    const done = chunks.at(-1);
    expect(done && "report" in done ? done.report : undefined).toBeNull();
  });

  test("no ```report fence (prose-only answer) -> done.report is null", async () => {
    const { responder } = makeResponder({
      generateStream: streamOf({ type: "text-delta", text: "there are 2 tables" }),
    });
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "how many?" }));
    const done = chunks.at(-1);
    expect(done && "report" in done ? done.report : undefined).toBeNull();
  });

  test("a report answer that ALSO carries a standalone ```sql fence still suppresses done.query", async () => {
    // A report answer is its own answer type: even a genuinely separate ```sql fence must
    // not surface a "run query" affordance beside the "open report" action.
    const spec = { blocks: [{ kind: "query" as const, sql: "SELECT 1" }] };
    const text = `here:\n\n\`\`\`report\n${JSON.stringify(spec)}\n\`\`\`\n\nalso:\n\n\`\`\`sql\nSELECT 99\n\`\`\``;
    const { responder } = makeResponder({ generateStream: streamOf({ type: "text-delta", text }) });
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "make a report" }));
    const done = chunks.at(-1);
    expect(done && "report" in done ? done.report : undefined).toEqual(spec);
    expect(done && "query" in done ? done.query : undefined).toBeNull();
  });

  test("a FAILED report attempt + a valid standalone ```sql fence keeps done.query (query not swallowed)", async () => {
    // Suppression is gated on a VALID report (`report !== null`), not the mere presence of a
    // ```report fence. A report the model abandoned/mangled is NOT a report answer, so a
    // genuinely runnable ```sql block in the same message must still surface its run affordance.
    const badReport = `\`\`\`report\n{ "blocks": [] }\n\`\`\``; // empty blocks -> parseReportSpec null
    const text = `${badReport}\n\nrun this instead:\n\n\`\`\`sql\nSELECT count(*) FROM customers;\n\`\`\``;
    const { responder } = makeResponder({ generateStream: streamOf({ type: "text-delta", text }) });
    const chunks = await collect(responder.answerStream({ provider: "anthropic", message: "make a report" }));
    const done = chunks.at(-1);
    expect(done && "report" in done ? done.report : undefined).toBeNull();
    expect(done && "query" in done ? done.query : undefined).toBe("SELECT count(*) FROM customers;");
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

  /* ---- Story 10.4: the optional per-request connection target ---------- */

  /** A DIFFERENT database's catalog, so "which schema was summarized" is observable. */
  const TARGET_SCHEMA: DatabaseSchema = {
    engine: "postgres",
    tables: [
      {
        schema: "public",
        name: "invoices",
        columns: [{ name: "id", dataType: "integer", nullable: false }],
        primaryKey: ["id"],
        indexes: [],
        foreignKeys: [],
      },
    ],
  };

  test("a connectionId is forwarded to getSchema and scopes the context to THAT database", async () => {
    const { responder, system, connectionIds } = makeResponder({
      getSchema: async (connectionId) => (connectionId === "conn-b" ? TARGET_SCHEMA : SCHEMA),
    });
    const chunks = await collect(
      responder.answerStream({ provider: "anthropic", message: "hi", connectionId: "conn-b" }),
    );

    expect(connectionIds()).toEqual(["conn-b"]);
    // The model saw the TARGET's catalog, not the boot connection's.
    expect(system()).toContain("table public.invoices");
    expect(system()).not.toContain("table public.orders");
    // …and targeting changed only WHICH schema, never the schema-only invariant.
    const done = chunks.at(-1);
    expect(done && "context" in done ? done.context : undefined).toEqual({
      policy: "schema-only",
      tables: 1,
      rowsIncluded: 0,
    });
  });

  test("an existing paramless call still resolves the default target (getSchema sees undefined)", async () => {
    const { responder, connectionIds } = makeResponder({});
    await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    expect(connectionIds()).toEqual([undefined]);
  });

  test("an explicit connectionId:null is the default target too (never a resolve attempt)", async () => {
    const { responder, connectionIds } = makeResponder({});
    await collect(responder.answerStream({ provider: "anthropic", message: "hi", connectionId: null }));
    expect(connectionIds()).toEqual([null]);
  });

  test("a malformed connectionId -> error chunk (bad_request), no key lookup, no outbound call", async () => {
    // A wrong TYPE is a protocol violation, rejected on the same `field=`-detail path as
    // `provider`/`message` — the `detail` is Core-internal (the wire chunk deliberately
    // carries only code+message), so the distinguishing evidence here is the message.
    let keyLookups = 0;
    const { responder, calls, connectionIds } = makeResponder({
      getKey: () => {
        keyLookups += 1;
        return { ok: true, value: SECRET };
      },
    });
    const chunks = await collect(
      responder.answerStream({ provider: "anthropic", message: "hi", connectionId: 5 }),
    );
    expect(chunks).toEqual([{ type: "error", code: "bad_request", message: "invalid connectionId" }]);
    expect(keyLookups).toBe(0); // rejected before any key/schema round-trip
    expect(connectionIds()).toEqual([]);
    expect(calls()).toBe(0);
  });

  test("an UNRESOLVABLE connectionId reuses the existing 'no active connection' reply — no new code", async () => {
    const { responder, calls } = makeResponder({
      getSchema: async (connectionId) => {
        if (connectionId === "ghost") throw new Error("no connection target configured");
        return SCHEMA;
      },
    });
    const chunks = await collect(
      responder.answerStream({ provider: "anthropic", message: "hi", connectionId: "ghost" }),
    );
    expect(chunks).toEqual([{ type: "error", code: "bad_request", message: "no active connection" }]);
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
    let chunks: ChatStreamChunk[] = [];
    const logged = await captureStderr(async () => {
      chunks = await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    });
    expect(chunks).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "error", code: "internal_error", message: "provider call failed" },
    ]);
    expect(JSON.stringify(chunks)).not.toContain(SECRET);
    // The SDK `error`-part path lands in the same catch: a generic, key-free log line.
    expect(logged).toBe("[chat] provider stream failed\n");
    expect(logged).not.toContain(SECRET);
  });

  // The redaction invariant is ABSOLUTE: the provider key must never reach stderr in
  // ANY form. The catch no longer interpolates the raw error, so an auth body echoing
  // the key — verbatim, URL-encoded, base64, truncated, or nested in a structure —
  // cannot leak by construction. Each case drives a mid-stream throw and asserts the
  // log is the fixed generic line, free of the key and its encodings.
  test("a URL-encoded key echoed in the thrown message never reaches stderr", async () => {
    const encoded = encodeURIComponent(SECRET);
    const { responder } = makeResponder({
      generateStream: throwingStream(new Error(`auth failed: token=${encoded}`)),
    });
    const logged = await captureStderr(async () => {
      await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    });
    expect(logged).toBe("[chat] provider stream failed\n");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(encoded);
  });

  test("a base64-encoded key echoed in the thrown message never reaches stderr", async () => {
    const b64 = Buffer.from(SECRET).toString("base64");
    const { responder } = makeResponder({
      generateStream: throwingStream(new Error(`rejected credential ${b64}`)),
    });
    const logged = await captureStderr(async () => {
      await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    });
    expect(logged).toBe("[chat] provider stream failed\n");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(b64);
  });

  test("a truncated/partial key echoed in the thrown message never reaches stderr", async () => {
    const partial = SECRET.slice(0, 12);
    const { responder } = makeResponder({
      generateStream: throwingStream(new Error(`invalid key prefix ${partial}...`)),
    });
    const logged = await captureStderr(async () => {
      await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    });
    expect(logged).toBe("[chat] provider stream failed\n");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(partial);
  });

  test("a key nested in a structured error (.message + .cause/custom prop) never reaches stderr", async () => {
    const nested = Object.assign(new Error(`auth failed for ${SECRET}`), {
      cause: new Error(`upstream rejected ${SECRET}`),
      requestKey: SECRET,
    });
    const { responder } = makeResponder({ generateStream: throwingStream(nested) });
    const logged = await captureStderr(async () => {
      await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    });
    expect(logged).toBe("[chat] provider stream failed\n");
    expect(logged).not.toContain(SECRET);
  });

  test("a numeric statusCode is surfaced as (http 401) while the key stays absent", async () => {
    const err = Object.assign(new Error(`401 unauthorized for ${SECRET}`), { statusCode: 401 });
    const { responder } = makeResponder({ generateStream: throwingStream(err) });
    const logged = await captureStderr(async () => {
      await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    });
    expect(logged).toBe("[chat] provider stream failed (http 401)\n");
    expect(logged).not.toContain(SECRET);
  });

  // The numeric status is the ONE provider-derived value the log is allowed to carry,
  // so the `typeof === number` + integer/range guard in `errorStatusCode` is the single
  // load-bearing seam the whole invariant rests on. These adversarially probe it: a
  // status that is a secret-bearing STRING, or an object with a numeric `valueOf`, must
  // be rejected (never interpolated), and a throwing getter must not escape the catch.
  test("a secret-bearing STRING statusCode/status is rejected, never reaching stderr", async () => {
    const err = Object.assign(new Error("auth failed"), {
      statusCode: SECRET,
      status: `401 for ${SECRET}`,
    });
    const { responder } = makeResponder({ generateStream: throwingStream(err) });
    const logged = await captureStderr(async () => {
      await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    });
    expect(logged).toBe("[chat] provider stream failed\n");
    expect(logged).not.toContain(SECRET);
  });

  test("a non-number statusCode with a numeric valueOf is rejected (no (http ...) suffix)", async () => {
    const err = Object.assign(new Error("auth failed"), {
      statusCode: { valueOf: () => 401, toString: () => SECRET },
    });
    const { responder } = makeResponder({ generateStream: throwingStream(err) });
    const logged = await captureStderr(async () => {
      await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    });
    expect(logged).toBe("[chat] provider stream failed\n");
    expect(logged).not.toContain(SECRET);
  });

  test("a throwing statusCode getter does not escape the catch — stream still ends cleanly", async () => {
    const err = new Error("auth failed");
    Object.defineProperty(err, "statusCode", {
      get() {
        throw new Error(`boom ${SECRET}`);
      },
    });
    const { responder } = makeResponder({ generateStream: throwingStream(err) });
    let chunks: ChatStreamChunk[] = [];
    const logged = await captureStderr(async () => {
      chunks = await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
    });
    expect(chunks).toEqual([
      { type: "text-delta", text: "partial " },
      { type: "error", code: "internal_error", message: "provider call failed" },
    ]);
    expect(logged).toBe("[chat] provider stream failed\n");
    expect(logged).not.toContain(SECRET);
  });

  test("out-of-range / non-integer status codes are omitted, not printed as (http ...)", async () => {
    for (const bogus of [0, -1, 401.5, 1e21, 700]) {
      const err = Object.assign(new Error("auth failed"), { statusCode: bogus });
      const { responder } = makeResponder({ generateStream: throwingStream(err) });
      const logged = await captureStderr(async () => {
        await collect(responder.answerStream({ provider: "anthropic", message: "hi" }));
      });
      expect(logged).toBe("[chat] provider stream failed\n");
    }
  });
});
