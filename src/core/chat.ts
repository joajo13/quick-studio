/**
 * quick-studio Core — Chat Q&A responder (Story 5.2, Ring 1 sole-caller).
 *
 * The Core is the ONLY holder of a provider key and the ONLY outbound provider
 * caller (AR-6 / R5). This module resolves the requested provider's key in Ring 1,
 * introspects the single live connection's schema, assembles a typed, inspectable,
 * SCHEMA-ONLY payload (schema + a distinct `rowSample` field that is always `null`
 * in this story — zero rows leave the machine), and runs one non-streaming
 * `generateText` call, returning the answer plus a schema-only context summary.
 *
 * `buildSchemaContext`/`assemblePayload` are pure (no rows, deterministic) so the
 * assembly is unit-tested with no network. `createChatResponder` takes an INJECTED
 * `generate` (defaulting to a thin `generateText` wrapper) so the full I/O matrix —
 * validation, not-configured, no-connection, SDK-throw — is exercised with no real
 * key and no network. The raw key is NEVER returned, logged, or placed in a `detail`.
 */

import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type {
  ChatAskResult,
  ChatContextSummary,
  ChatProviderPayload,
  DatabaseSchema,
  ProviderKind,
  SchemaForModel,
  SchemaTableInfo,
} from "../shared/contract.ts";
import { PROVIDER_KINDS } from "../shared/contract.ts";
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

/** The non-streaming generate seam — narrowed to exactly what the responder needs. */
export type GenerateFn = (args: {
  model: LanguageModel;
  system: string;
  prompt: string;
}) => Promise<{ text: string }>;

/** The default `generate`: a thin, non-streaming `generateText` wrapper (Ring 1 only). */
const defaultGenerate: GenerateFn = ({ model, system, prompt }) =>
  generateText({ model, system, prompt });

/** Dependencies for {@link createChatResponder}. `generate` is the test-injection seam. */
export type ChatResponderDeps = {
  /** The single live schema source (memoized `connectionManager.getSchema`). */
  readonly getSchema: () => Promise<DatabaseSchema>;
  /** Core-internal raw-key lookup for a kind (null when unconfigured). */
  readonly getKey: (provider: ProviderKind) => RegistryResult<string | null>;
  /** Map a kind + key to a model handle (pure construction, no network). */
  readonly resolveModel: (provider: ProviderKind, apiKey: string) => ResolveModelResult;
  /** Non-streaming generate. Defaults to a `generateText` wrapper; injected in tests. */
  readonly generate?: GenerateFn;
};

/** The live chat responder handle. */
export type ChatResponder = {
  /**
   * Answer one `chat.ask`. Validates the request, resolves the key in Ring 1,
   * introspects the live schema, assembles the schema-only payload, and runs one
   * non-streaming generate. Total — returns a typed {@link RegistryResult}; the raw
   * key is never returned nor placed in any error `detail`.
   */
  answer(params: unknown): Promise<RegistryResult<ChatAskResult>>;
};

function badRequest(message: string, detail: string): RegistryResult<never> {
  return { ok: false, code: "bad_request", message, detail };
}

/**
 * Build the chat responder. The provider key resolves via `getKey` inside Ring 1
 * only; no key ever crosses back to a caller or into an error `detail`.
 */
export function createChatResponder(deps: ChatResponderDeps): ChatResponder {
  const generate = deps.generate ?? defaultGenerate;

  return {
    async answer(params: unknown): Promise<RegistryResult<ChatAskResult>> {
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

      // The single outbound provider call. A network/auth throw is caught: the raw
      // cause goes to stderr ONLY (never the client detail), and a neutral typed
      // internal_error is returned — the key never appears in any of this.
      let text: string;
      try {
        const result = await generate({
          model: resolved.model,
          system: payload.schema.text,
          prompt: message,
        });
        text = result.text;
      } catch (err) {
        // Redact the key from the cause before logging: a provider auth error can
        // echo the credential, and the spec forbids the key ever being logged.
        const rawCause = err instanceof Error ? err.message : String(err);
        const cause = apiKey.length > 0 ? rawCause.split(apiKey).join("***") : rawCause;
        process.stderr.write(`[chat] provider call failed: ${cause}\n`);
        return { ok: false, code: "internal_error", message: "provider call failed" };
      }

      const context: ChatContextSummary = {
        policy: "schema-only",
        tables: payload.schema.tables,
        rowsIncluded: 0,
      };
      return { ok: true, value: { answer: text, context } };
    },
  };
}
