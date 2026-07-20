/**
 * quick-studio Core — Chat Q&A responder (Story 5.2, Ring 1 sole-caller).
 *
 * The Core is the ONLY holder of a provider key and the ONLY outbound provider
 * caller (AR-6 / R5). This module resolves the requested provider's key in Ring 1,
 * introspects the single live connection's schema, assembles a typed, inspectable,
 * SCHEMA-ONLY payload (schema + a distinct `rowSample` field that is always `null`
 * — zero rows leave the machine), and opens one STREAMING provider call (Story 5.4),
 * yielding a typed `ChatStreamChunk` sequence: `reasoning-delta` / `text-delta`
 * tokens then a terminal `done` (Core-extracted `query` + schema-only context).
 *
 * `buildSchemaContext`/`assemblePayload` are pure (no rows, deterministic) so the
 * assembly is unit-tested with no network. The validate→key→schema→model→payload→
 * system-prompt pipeline is extracted into ONE shared `prepareRequest` helper so the
 * streaming path cannot drift from the schema-only invariant. `createChatResponder`
 * takes an INJECTED `generateStream` (defaulting to a thin `streamText` wrapper) so
 * the full I/O matrix — validation, not-configured, no-connection, mid-stream throw —
 * is exercised with no real key and no network. The raw key is NEVER returned, logged,
 * or placed in any chunk or `detail`.
 *
 * Story 5.3 turns the answer into a runnable query: the system prompt
 * (`buildChatSystemPrompt`, pure) instructs the model to emit one SQL statement in a
 * fenced block when appropriate, and `extractQuery` (pure, dumb — no validation/
 * classification) runs once over the fully-accumulated answer at end-of-stream into a
 * distinct `query` on the terminal `done` chunk. The outbound payload is UNCHANGED —
 * schema-only, `rowSample: null` — streaming only shapes what comes back.
 */

import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type {
  ChatContextSummary,
  ChatProviderPayload,
  ChatStreamChunk,
  DatabaseSchema,
  ProviderKind,
  SchemaForModel,
  SchemaTableInfo,
} from "../shared/contract.ts";
import { PROVIDER_KINDS } from "../shared/contract.ts";
import { extractReport, parseReportSpec } from "../shared/report-spec.ts";
import { reasoningProviderOptions } from "./ai-provider.ts";
import type { ResolveModelResult } from "./ai-provider.ts";
import type { RegistryResult } from "./provider-registry.ts";

/** True when `value` is one of the known {@link ProviderKind}s. */
function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

/** Compact, deterministic, ROW-FREE serialization of one table (names/types/PK/FK). */
function serializeTable(table: SchemaTableInfo): string {
  const qualified = table.schema.trim() === "" ? table.name : `${table.schema}.${table.name}`;
  const lines: string[] = [`table ${qualified}`];
  const columns = table.columns
    .map((c) => `${c.name} ${c.dataType}${c.nullable ? "" : " not null"}`)
    .join(", ");
  lines.push(`  columns: ${columns}`);
  if (table.primaryKey.length > 0) {
    lines.push(`  pk: ${table.primaryKey.join(", ")}`);
  }
  for (const fk of table.foreignKeys) {
    const ref =
      fk.referencedSchema.trim() === ""
        ? fk.referencedTable
        : `${fk.referencedSchema}.${fk.referencedTable}`;
    lines.push(`  fk: ${fk.columns.join(", ")} -> ${ref}(${fk.referencedColumns.join(", ")})`);
  }
  return lines.join("\n");
}

/**
 * Flatten a {@link DatabaseSchema} to a compact, deterministic, ROW-FREE text block —
 * one stanza per table (names, column types, PK, FKs). This is the ONLY database
 * context handed to the model; it never carries a single row value.
 */
export function buildSchemaContext(schema: DatabaseSchema): string {
  return schema.tables.map(serializeTable).join("\n\n");
}

/**
 * Compose the system prompt from the live schema: an instruction stanza (answer
 * using only this `{engine}` schema; when a query answers the question, emit
 * EXACTLY ONE statement in a ```sql fenced block; never invent tables/columns) plus
 * the existing row-free {@link buildSchemaContext} stanzas. Pure and deterministic —
 * no network, so the composed shape is unit-testable with no live model.
 */
export function buildChatSystemPrompt(payload: ChatProviderPayload): string {
  const instruction = [
    `you are a sql assistant for a ${payload.schema.engine} database. use only the schema below.`,
    "write your prose as markdown.",
    "when a query answers the question, output exactly one statement in a ```sql fenced block.",
    "when a chart helps, also emit exactly one ```chart fenced block containing a json object with:",
    `  "mark" (one of line, bar, dot, area), "x" and "y" set to result column names, an optional "series" column, and an optional "title".`,
    "when the user asks you to build a report, emit exactly one ```report fenced block containing a json object with:",
    `  an optional "title" string, and a non-empty "blocks" array of ordered blocks, each either`,
    `  {"kind":"prose","markdown":"..."} or {"kind":"query","sql":"...","chart"?:{"mark":..., "x":..., "y":..., "series"?:..., "title"?:...}}.`,
    "do not invent tables or columns.",
  ].join("\n");
  return `${instruction}\n\n${payload.schema.text}`;
}

/**
 * Extract the first fenced code block from `text` — preferring a ` ```sql ` fence,
 * falling back to a bare ` ``` ` fence — trimmed, or `null` when none is present.
 * When multiple blocks exist, the FIRST one wins. Pure and dumb by design (Design
 * Notes): it does not validate or classify the extracted SQL — the guarded `execute`
 * path remains the sole read/mutate classifier (AR-3), so this stays Ring-2-safe to
 * hand the extracted string to verbatim.
 */
export function extractQuery(text: string): string | null {
  const sqlFence = /```sql[ \t]*\r?\n([\s\S]*?)```/i;
  // Any other ```<lang> tag (```postgresql, ```mysql, ...): consume the language
  // token on the fence line so it never leaks into the extracted statement.
  const langFence = /```[a-z0-9_+-]+[ \t]*\r?\n([\s\S]*?)```/i;
  const bareFence = /```[ \t]*\r?\n?([\s\S]*?)```/;
  const match = sqlFence.exec(text) ?? langFence.exec(text) ?? bareFence.exec(text);
  if (match === null) return null;
  const body = match[1]?.trim() ?? "";
  return body.length > 0 ? body : null;
}

/**
 * Assemble the outbound provider payload from the live schema. `schema` and
 * `rowSample` are DISTINCT fields; `rowSample` is ALWAYS `null` in Story 5.2 (zero
 * rows leave the machine). The schema projection carries only the row-free text plus
 * the table count — an inspectable proof of the schema-only policy.
 */
export function assemblePayload(schema: DatabaseSchema): ChatProviderPayload {
  const forModel: SchemaForModel = {
    engine: schema.engine,
    text: buildSchemaContext(schema),
    tables: schema.tables.length,
  };
  return { schema: forModel, rowSample: null };
}

/**
 * One part of the provider's streamed response, narrowed to exactly what the
 * responder reads. The Vercel AI SDK's `fullStream` yields many part `type`s; the
 * responder routes only `text-delta`/`reasoning-delta` (both carry `.text`) and
 * observes `error` (a mid-stream failure the SDK surfaces as a part rather than a
 * throw). Every other part type is ignored.
 */
export type ChatStreamPart = {
  readonly type: string;
  readonly text?: string;
  readonly error?: unknown;
};

/**
 * The STREAMING generate seam — narrowed to exactly what the responder needs. Returns
 * synchronously (mirrors `streamText`); `fullStream` is consumed with `for await`.
 * `providerOptions` enables the reasoning channel where supported; `maxOutputTokens`
 * (OPTIONAL — only set for reasoning-enabled providers) gives the model room beyond
 * any thinking budget, so a non-reasoning provider keeps the SDK's own default ceiling.
 * `abortSignal` (OPTIONAL) tears the provider stream down on a client disconnect so the
 * Core never pulls a billable stream to completion after the reader is gone.
 */
export type GenerateStreamFn = (args: {
  model: LanguageModel;
  system: string;
  prompt: string;
  providerOptions?: Record<string, unknown>;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}) => { fullStream: AsyncIterable<ChatStreamPart> };

/** The default `generateStream`: a thin `streamText` wrapper (Ring 1 only). */
const defaultGenerateStream: GenerateStreamFn = ({
  model,
  system,
  prompt,
  providerOptions,
  maxOutputTokens,
  abortSignal,
}) => {
  const result = streamText({
    model,
    system,
    prompt,
    providerOptions: providerOptions as never,
    maxOutputTokens,
    abortSignal,
  });
  return { fullStream: result.fullStream as unknown as AsyncIterable<ChatStreamPart> };
};

/** Dependencies for {@link createChatResponder}. `generateStream` is the test seam. */
export type ChatResponderDeps = {
  /** The single live schema source (memoized `connectionManager.getSchema`). */
  readonly getSchema: () => Promise<DatabaseSchema>;
  /** Core-internal raw-key lookup for a kind (null when unconfigured). */
  readonly getKey: (provider: ProviderKind) => RegistryResult<string | null>;
  /** Map a kind + key to a model handle (pure construction, no network). */
  readonly resolveModel: (provider: ProviderKind, apiKey: string) => ResolveModelResult;
  /** Streaming generate. Defaults to a `streamText` wrapper; injected in tests. */
  readonly generateStream?: GenerateStreamFn;
};

/** The live chat responder handle. */
export type ChatResponder = {
  /**
   * Stream one chat response (Story 5.4). Runs the shared request-prep (validate →
   * key → schema → model → payload → system-prompt), opens ONE streaming provider
   * call, and yields a typed {@link ChatStreamChunk} sequence: `reasoning-delta` /
   * `text-delta` tokens, then a terminal `done` carrying the Core-extracted `query`
   * plus the schema-only `context`. A pre-flight failure OR a mid-stream throw yields
   * a single redacted `error` chunk (the raw key never appears in any chunk). Total —
   * never throws to the caller. An optional `signal` is threaded into the provider
   * stream so a client disconnect tears the (billable) provider call down promptly.
   */
  answerStream(params: unknown, signal?: AbortSignal): AsyncGenerator<ChatStreamChunk>;
};

function badRequest(message: string, detail: string): RegistryResult<never> {
  return { ok: false, code: "bad_request", message, detail };
}

/** The fully-prepared, schema-only request handed to the single streaming call. */
type PreparedRequest = {
  readonly provider: ProviderKind;
  readonly model: LanguageModel;
  readonly system: string;
  readonly prompt: string;
  readonly tables: number;
};

/**
 * The SHARED request-prep pipeline (Story 5.4): validate params, resolve the key in
 * Ring 1, introspect the live schema, construct the model handle, assemble the
 * SCHEMA-ONLY payload (`rowSample: null` — zero rows leave), and compose the system
 * prompt. Extracted so the streaming path CANNOT drift from the schema-only invariant.
 * Total — returns a typed {@link RegistryResult}; the raw key never appears in a
 * `detail`. `deps` are the responder's injected seams.
 */
function prepareRequest(
  deps: Pick<ChatResponderDeps, "getSchema" | "getKey" | "resolveModel">,
  params: unknown,
): Promise<RegistryResult<PreparedRequest>> {
  return (async () => {
    const p =
      typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : null;

    // Unknown / missing provider kind → bad_request (nothing sent).
    const provider = p?.provider;
    if (!isProviderKind(provider)) {
      return badRequest("invalid provider", "field=provider");
    }

    // Blank / non-string message → bad_request (no outbound call).
    const message = p?.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      return badRequest("message required", "field=message");
    }

    // Resolve the key in Ring 1. A registry failure (store unavailable) propagates
    // its own code; an unconfigured provider (null) is a clean not_found.
    const keyResult = deps.getKey(provider);
    if (!keyResult.ok) return keyResult;
    if (keyResult.value === null) {
      return {
        ok: false,
        code: "not_found",
        message: "provider not configured",
        detail: `provider=${provider}`,
      };
    }
    const apiKey = keyResult.value;

    // Introspect the single live connection's schema. No live connection (or a
    // connect failure) surfaces here as a throw → a neutral no-connection error
    // (never a key/secret in the detail).
    let schema: DatabaseSchema;
    try {
      schema = await deps.getSchema();
    } catch {
      return badRequest("no active connection", "schema=unavailable");
    }

    // Construct the model handle (pure; no network, no key validation).
    const resolved = deps.resolveModel(provider, apiKey);
    if (!resolved.ok) {
      // Only reachable via an unchecked cast; provider was already validated above.
      return badRequest("invalid provider", resolved.detail);
    }

    // Assemble the schema-only payload (rowSample: null — zero rows leave).
    const payload = assemblePayload(schema);
    return {
      ok: true,
      value: {
        provider,
        model: resolved.model,
        system: buildChatSystemPrompt(payload),
        prompt: message,
        tables: payload.schema.tables,
      },
    };
  })();
}

/**
 * Extract a numeric HTTP status from a provider error — its own `statusCode` then
 * `status`, returned only when it is an integer in the HTTP range 100–599 (else
 * `undefined`). A `number` primitive cannot encode the key, so it is the ONLY
 * provider-derived value the error path is allowed to log (see the `answerStream`
 * catch invariant); the range/integer check merely keeps the diagnostic honest.
 */
function errorStatusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  for (const key of ["statusCode", "status"] as const) {
    // A hostile error could expose `statusCode`/`status` as a throwing getter;
    // reading it must never escape (answerStream's catch is Total — never throws).
    let v: unknown;
    try {
      v = (err as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599) return v;
  }
  return undefined;
}

/**
 * Build the chat responder. The provider key resolves via `getKey` inside Ring 1
 * only; no key ever crosses back to a caller or into an error `detail`.
 */
export function createChatResponder(deps: ChatResponderDeps): ChatResponder {
  const generateStream = deps.generateStream ?? defaultGenerateStream;

  return {
    async *answerStream(params: unknown, signal?: AbortSignal): AsyncGenerator<ChatStreamChunk> {
      // Shared prep — a pre-flight failure is mapped to a single terminal error chunk
      // (no delta, no streaming bubble committed) and the generator ends.
      const prepared = await prepareRequest(deps, params);
      if (!prepared.ok) {
        yield { type: "error", code: prepared.code, message: prepared.message };
        return;
      }
      const { provider, model, system, prompt, tables } = prepared.value;

      const context: ChatContextSummary = {
        policy: "schema-only",
        tables,
        rowsIncluded: 0,
      };

      // Accumulate the ANSWER channel only; `extractQuery` runs once on the full text
      // at end-of-stream. Reasoning tokens are routed to their own channel and never
      // fed to the extractor.
      let full = "";
      try {
        // Spread the per-provider reasoning options: a reasoning-enabled provider gets
        // both its thinking `providerOptions` AND the output ceiling; a non-reasoning
        // provider (openai gpt-4o) gets neither — no silent `maxOutputTokens` cap.
        const { fullStream } = generateStream({
          model,
          system,
          prompt,
          ...reasoningProviderOptions(provider),
          abortSignal: signal,
        });
        for await (const part of fullStream) {
          if (part.type === "text-delta") {
            const text = part.text ?? "";
            full += text;
            yield { type: "text-delta", text };
          } else if (part.type === "reasoning-delta") {
            yield { type: "reasoning-delta", text: part.text ?? "" };
          } else if (part.type === "error") {
            // The SDK surfaced a mid-stream failure as a part (not a throw): redact
            // and terminate with an error chunk, exactly as the catch below does.
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
          // Every other part type (start/end/step/tool/…) is ignored.
        }
      } catch (err) {
        // A client disconnect aborts the provider stream, surfacing here as a throw —
        // but that is a deliberate teardown, not a provider failure. Stay silent: no
        // spurious "stream failed" log, and no misleading `error` chunk (the caller is
        // already gone and the controller is dead, so it could not be delivered anyway).
        if (signal?.aborted) return;
        // Security invariant: the provider key must NEVER reach any log. An auth error
        // can echo the credential in forms substring-redaction can't cover, so we never
        // interpolate the raw provider error — only a numeric status, which cannot carry it.
        const status = errorStatusCode(err);
        process.stderr.write(
          `[chat] provider stream failed${status === undefined ? "" : ` (http ${status})`}\n`,
        );
        yield { type: "error", code: "internal_error", message: "provider call failed" };
        return;
      }

      // Terminal frame: extract the query + report once over the fully-accumulated
      // answer. `parseReportSpec` is the Core-side gate — a missing/malformed fence
      // yields `null`, and NOTHING opens on the UI side until a spec passes it. A report
      // answer is its own answer type: when the model produced a VALID report
      // (`report !== null`), the standalone "run query" affordance is suppressed so a
      // report never doubles as a runnable single query. But a report attempt that FAILS
      // validation is NOT a report answer — it must not swallow a genuinely separate,
      // runnable ` ```sql ` block in the same message, so the query affordance is kept.
      const report = parseReportSpec(extractReport(full).rawReport);
      const query = report !== null ? null : extractQuery(full);
      yield { type: "done", query, report, context };
    },
  };
}
