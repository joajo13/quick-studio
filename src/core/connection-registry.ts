/**
 * quick-studio Core — connection registry (Story 2.4).
 *
 * The sole Core-side holder of the credential store for the manage-connections
 * surface. It CONSUMES the untouched substrate (`credential-store.ts`) and exposes
 * list/add/edit/remove over it, mirroring `connection.ts`'s lazy-memoized-manager
 * style: the store is opened LAZILY on the first call and memoized on SUCCESS ONLY,
 * so a transient `unavailable` does not permanently poison the surface (the next
 * call retries the open).
 *
 * Trust boundary: results are credential-free. Every list/add/edit reply carries a
 * {@link ConnectionSummary} (`{ id, name, host, engine }`) — never a url, user, or
 * password. `host`/`engine` are derived in Core via `new URL(url)`. Ids are minted
 * Core-side (`randomUUID`) on add; the store upserts by `record.id` and mints nothing.
 *
 * Error mapping lives here, in one place, and translates directly to the RPC
 * envelope at the handler edge:
 *  - `bad_request`   — param validation (empty/whitespace name, unparseable url).
 *  - `not_found`     — edit addressing an id absent from the store.
 *  - `internal_error`— any store-open failure (`unavailable`/`corrupt`/`key-*`/
 *                      passphrase*) or a `write-failed` flush.
 * Remove is idempotent-ok (matches the store's absent-id no-op).
 */

import { randomUUID } from "node:crypto";
import type {
  AddConnectionParams,
  ConnectionSummary,
  EditConnectionParams,
  RemoveConnectionParams,
  RemoveConnectionResult,
  RpcErrorCode,
} from "../shared/contract.ts";
import {
  openCredentialStore,
  type CredentialStore,
  type CredentialStoreDeps,
  type OpenResult,
  type StoredConnection,
} from "./credential-store.ts";

/**
 * A registry operation outcome. `ok` carries the credential-free value; a failure
 * carries the RPC error code + neutral message (+ optional detail) that the handler
 * maps 1:1 onto `okReply`/`errorReply`.
 */
export type RegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: RpcErrorCode;
      readonly message: string;
      readonly detail?: string;
    };

/**
 * A Core-internal id→url lookup outcome (Story 6.2). Kept DISTINCT: `not-found`
 * (no such saved id) vs `unavailable` (the credential store could not be opened), so
 * a valid target during a transient store failure is never mislabeled "unknown".
 */
export type StoredUrlLookup =
  | {
      readonly kind: "found";
      readonly url: string;
      /** The record's pinned introspection scope (Story 10.2), absent when unpinned. */
      readonly schema?: string;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable"; readonly detail: string };

/** The live registry handle returned by {@link createConnectionRegistry}. */
export type ConnectionRegistry = {
  /** All saved connections as credential-free summaries. */
  list(): RegistryResult<ReadonlyArray<ConnectionSummary>>;
  /** Mint an id, persist a new connection, return its summary. */
  add(params: AddConnectionParams): RegistryResult<ConnectionSummary>;
  /** Rename-only (no `url`) or repoint (with `url`) an existing connection. */
  edit(params: EditConnectionParams): RegistryResult<ConnectionSummary>;
  /** Remove a connection by id. Idempotent: an absent id is still a success. */
  remove(params: RemoveConnectionParams): RegistryResult<RemoveConnectionResult>;
  /**
   * Core-INTERNAL id→url resolution for the re-target executor (Story 6.2). This is
   * the ONLY place a stored url is read back out, and it is NEVER dispatched over RPC
   * (no `getStoredUrl` handler) — the url stays in Ring 1. Returns a `not-found` for an
   * unknown id, distinct from a store-open `unavailable`, so a target during a store
   * blip is not misreported as unknown.
   */
  getStoredUrl(id: string): StoredUrlLookup;
  /**
   * Release the memoized store (DW-14): close its single-writer lock and clear the
   * cache. TERMINAL — the registry does NOT re-open after close: a subsequent
   * list/add/etc. returns an `internal_error` rather than re-acquiring the lock, so
   * an op racing shutdown cannot resurrect the store. Best-effort — swallows any
   * close error. Wired into `Core.stop` so a clean shutdown frees the lock; a
   * relaunch then needs no reclaim.
   */
  close(): void;
};

/**
 * Dependencies for {@link createConnectionRegistry}. Either inject an `openStore`
 * seam directly (tests drive a fixed-key temp-dir store, or a failing open) OR pass
 * `storeDeps` forwarded to the default `openCredentialStore` (e.g. `{ mode }`).
 */
export type ConnectionRegistryDeps = {
  /** Store-open seam. Defaults to `() => openCredentialStore(storeDeps)`. */
  readonly openStore?: () => OpenResult;
  /** Deps for the default store open. Ignored when `openStore` is supplied. */
  readonly storeDeps?: CredentialStoreDeps;
};

/** A validated, trimmed value, or the offending field name. */
type FieldCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly field: string; readonly reason: string };

/** name: a non-empty trimmed string. */
function checkName(name: unknown): FieldCheck {
  if (typeof name !== "string") {
    return { ok: false, field: "name", reason: "name must be a string" };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, field: "name", reason: "name must not be empty" };
  }
  return { ok: true, value: trimmed };
}

/**
 * schema (Story 10.2): an OPTIONAL pinned introspection scope. Mirrors `checkName`'s
 * trim discipline but is never required — a trimmed-empty value is a legitimate
 * "unset/clear" (R1), not a `bad_request`. The value stays opaque: a schema name is a
 * server-side identifier this story deliberately does NOT validate against the live
 * database (it is bound as a query parameter, never spliced into SQL).
 */
function checkSchema(
  schema: unknown,
): { readonly ok: true; readonly value: string | undefined } | Extract<FieldCheck, { ok: false }> {
  if (typeof schema !== "string") {
    return { ok: false, field: "schema", reason: "schema must be a string" };
  }
  const trimmed = schema.trim();
  return { ok: true, value: trimmed.length === 0 ? undefined : trimmed };
}

/** url: a `new URL()`-parseable string WITH a host (shape only — scheme is NOT validated here). */
function checkUrl(url: unknown): FieldCheck {
  if (typeof url !== "string" || url.trim().length === 0) {
    return { ok: false, field: "url", reason: "url must be a non-empty string" };
  }
  // Persist the trimmed form: emptiness is already checked on `url.trim()`, so a
  // padded-but-nonempty url must not round-trip surrounding whitespace to disk.
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, field: "url", reason: "url is not a parseable URL" };
  }
  // Shape check, NOT a scheme allowlist: reject a hostless url (e.g. `foo:bar`,
  // `mailto:x`) so `toSummary`'s `host`/`engine` derivation is always meaningful.
  // Scheme validation is out of scope here — it belongs to the connect flow.
  if (parsed.host.length === 0) {
    return { ok: false, field: "url", reason: "url has no host" };
  }
  return { ok: true, value: trimmed };
}

/**
 * Derive the credential-free summary from a stored record. `engine` is the url
 * protocol without its trailing colon; `host` is `URL.host` (host[:port]). Safe
 * because every stored url passed {@link checkUrl} on the way in.
 */
function toSummary(record: StoredConnection): ConnectionSummary {
  const parsed = new URL(record.url);
  return {
    id: record.id,
    name: record.name,
    host: parsed.host,
    engine: parsed.protocol.replace(/:$/, ""),
    // CONDITIONAL, not `schema: undefined`: an unpinned connection's summary must
    // carry no `schema` KEY at all, so its shape stays byte-identical to pre-10.2.
    ...(record.schema === undefined ? {} : { schema: record.schema }),
  };
}

/**
 * Total variant of {@link toSummary} for the READ-BACK paths (`list`, `edit`): a
 * record whose stored url is unparseable — only reachable via an externally-written/
 * legacy store, since `add`/repoint guard on the way in — degrades to an empty
 * host/engine (keeping id/name) rather than throwing. This keeps `list` total AND
 * lets `edit` return/persist a rename against such a record without surfacing a
 * spurious `internal_error` (the throw would otherwise escape AFTER the write
 * already committed, diverging on-disk state from the reply). `add` deliberately
 * uses the strict `toSummary` because its url just passed `checkUrl`.
 */
function safeSummary(record: StoredConnection): ConnectionSummary {
  try {
    return toSummary(record);
  } catch {
    return {
      id: record.id,
      name: record.name,
      host: "",
      engine: "",
      ...(record.schema === undefined ? {} : { schema: record.schema }),
    };
  }
}

function badRequest(check: Extract<FieldCheck, { ok: false }>): RegistryResult<never> {
  return {
    ok: false,
    code: "bad_request",
    message: check.reason,
    detail: `field=${check.field}`,
  };
}

/**
 * Build the connection registry. The store is NOT opened here — it opens lazily on
 * the first list/add/edit/remove and is memoized only on success (failures stay
 * retryable).
 */
export function createConnectionRegistry(
  deps: ConnectionRegistryDeps = {},
): ConnectionRegistry {
  const openStore = deps.openStore ?? (() => openCredentialStore(deps.storeDeps));

  // Memoize SUCCESS only — a transient open failure must not poison the surface.
  let cached: CredentialStore | null = null;
  // Terminal shutdown latch — once `close()` runs, `obtain()` never re-opens.
  let closed = false;

  /** Obtain (open once, then reuse) the store, or map an open failure to internal_error. */
  function obtain(): RegistryResult<CredentialStore> {
    // After close() the registry is terminal: never re-open (which would re-acquire
    // the single-writer lock an op racing shutdown could otherwise resurrect).
    if (closed) {
      return {
        ok: false,
        code: "internal_error",
        message: "credential store is unavailable",
        detail: "closed",
      };
    }
    if (cached !== null) return { ok: true, value: cached };
    const opened = openStore();
    if (opened.outcome === "opened") {
      cached = opened.store;
      return { ok: true, value: cached };
    }
    // Every non-opened arm (unavailable/key-invalid/corrupt/schema-unknown/
    // passphrase-declined/passphrase-invalid/key-unavailable) is an internal_error.
    // `detail` carries ONLY the safe outcome LABEL — never `opened.detail`, whose
    // `err.message` text may embed absolute app-dir paths / errno strings (same
    // convention as rpc.ts: do not echo raw exception text to the client).
    return {
      ok: false,
      code: "internal_error",
      message: "credential store is unavailable",
      detail: opened.outcome,
    };
  }

  // `detail` is a fixed safe label, NOT the store's raw `mutation.detail` (which is
  // an `err.message` that may carry paths / errno text). Never echo that to the wire.
  function writeFailed(): RegistryResult<never> {
    return {
      ok: false,
      code: "internal_error",
      message: "failed to persist the connection",
      detail: "write-failed",
    };
  }

  return {
    list() {
      const store = obtain();
      if (!store.ok) return store;
      // `list` MUST be total: a single stored record with an unparseable url (only
      // reachable via an externally-written/legacy store, since add/edit now guard)
      // would otherwise throw in `toSummary` and take down the ENTIRE list surface.
      // `safeSummary` degrades a malformed record to an empty host/engine.
      const summaries = store.value.listConnections().map(safeSummary);
      return { ok: true, value: summaries };
    },

    add(params) {
      const name = checkName(params?.name);
      if (!name.ok) return badRequest(name);
      const url = checkUrl(params?.url);
      if (!url.ok) return badRequest(url);
      // Optional (Story 10.2): absent OR blank ⇒ unpinned, so the key is simply
      // never written and the record stays byte-identical to a pre-10.2 one.
      const schema = params?.schema === undefined ? undefined : checkSchema(params.schema);
      if (schema !== undefined && !schema.ok) return badRequest(schema);

      const store = obtain();
      if (!store.ok) return store;

      // Id is minted Core-side; the store upserts by id and mints nothing.
      const record: StoredConnection = {
        id: randomUUID(),
        name: name.value,
        url: url.value,
        ...(schema === undefined || schema.value === undefined ? {} : { schema: schema.value }),
      };
      const mutation = store.value.saveConnection(record);
      if (mutation.outcome !== "ok") return writeFailed();
      return { ok: true, value: toSummary(record) };
    },

    edit(params) {
      const id = params?.id;
      if (typeof id !== "string" || id.length === 0) {
        return badRequest({ ok: false, field: "id", reason: "id must be a non-empty string" });
      }

      const store = obtain();
      if (!store.ok) return store;

      const existing = store.value.getConnection(id);
      if (existing === undefined) {
        return {
          ok: false,
          code: "not_found",
          message: "no connection with that id",
          detail: `id=${id}`,
        };
      }

      // Nothing to change (neither name, url, nor schema supplied): return the
      // unchanged summary WITHOUT a save — avoid a needless re-encrypt + disk flush.
      // Ordered AFTER the not_found check so an unknown id still errors. `schema` MUST
      // be part of this test — otherwise a schema-only edit silently no-ops. A BLANK
      // schema against an already-unpinned record is likewise nothing to change: R1
      // makes it a clear, and clearing an absent pin rebuilds a byte-identical record.
      // Non-strings still fall through, so `checkSchema` can reject them.
      const schemaIsNoOp =
        params.schema === undefined ||
        (existing.schema === undefined &&
          typeof params.schema === "string" &&
          params.schema.trim().length === 0);
      if (params.name === undefined && params.url === undefined && schemaIsNoOp) {
        return { ok: true, value: safeSummary(existing) };
      }

      // Rename-only keeps the stored url; a provided url replaces it (re-encrypted).
      let nextName = existing.name;
      if (params.name !== undefined) {
        const name = checkName(params.name);
        if (!name.ok) return badRequest(name);
        nextName = name.value;
      }
      let nextUrl = existing.url;
      if (params.url !== undefined) {
        const url = checkUrl(params.url);
        if (!url.ok) return badRequest(url);
        nextUrl = url.value;
      }
      // R1: for `schema` — and ONLY for `schema` — a blank value CLEARS the pin (an
      // absent key still means "keep"). Safe here because `schema` rides on the
      // summary, so the edit form pre-fills it and an emptied field is unambiguous;
      // the credential-bearing url the UI never held keeps its "absent ⇒ keep" rule.
      let nextSchema = existing.schema;
      if (params.schema !== undefined) {
        const schema = checkSchema(params.schema);
        if (!schema.ok) return badRequest(schema);
        nextSchema = schema.value;
      }

      const record: StoredConnection = {
        id,
        name: nextName,
        url: nextUrl,
        // A cleared schema drops the key entirely rather than storing `undefined`.
        ...(nextSchema === undefined ? {} : { schema: nextSchema }),
      };
      const mutation = store.value.saveConnection(record);
      if (mutation.outcome !== "ok") return writeFailed();
      // `safeSummary`, not `toSummary`: a rename-only edit keeps a possibly-malformed
      // legacy `existing.url`, and the write above already committed — a throw here
      // would report a persisted rename as `internal_error`.
      return { ok: true, value: safeSummary(record) };
    },

    remove(params) {
      const id = params?.id;
      if (typeof id !== "string" || id.length === 0) {
        return badRequest({ ok: false, field: "id", reason: "id must be a non-empty string" });
      }

      const store = obtain();
      if (!store.ok) return store;

      // Idempotent: the store's deleteConnection is a no-op `ok` for an absent id.
      const mutation = store.value.deleteConnection(id);
      if (mutation.outcome !== "ok") return writeFailed();
      return { ok: true, value: { removed: true } };
    },

    getStoredUrl(id) {
      const store = obtain();
      if (!store.ok) {
        // A store-OPEN failure is distinct from an unknown id. Emit the same terse
        // stderr diagnostic other store-open failures in this module rely on, but never
        // echo the raw detail to a caller that may put it on the wire — surface only the
        // safe label so the resolver can classify it `internal_error`, not `not-found`.
        process.stderr.write(
          `[connection-registry] getStoredUrl: credential store unavailable (${store.detail ?? "open-failed"})\n`,
        );
        return { kind: "unavailable", detail: store.detail ?? "credential store unavailable" };
      }
      const record = store.value.getConnection(id);
      if (record === undefined) return { kind: "not-found" };
      // The pinned schema rides along (Story 10.2) so the per-target resolver can key
      // its cache on it and hand it to `listSchema` — still credential-free.
      return {
        kind: "found",
        url: record.url,
        ...(record.schema === undefined ? {} : { schema: record.schema }),
      };
    },

    close() {
      // Terminal: mark closed first so any op racing shutdown cannot re-open, then
      // release the memoized store's single-writer lock and drop the cache. Swallow
      // any close error — teardown must never throw.
      closed = true;
      try {
        cached?.close();
      } catch {
        /* best-effort: a wedged close must not block shutdown. */
      }
      cached = null;
    },
  };
}
