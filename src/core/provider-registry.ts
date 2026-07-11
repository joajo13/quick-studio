/**
 * quick-studio Core — provider-key registry (Story 5.1).
 *
 * The sole Core-side holder of the provider-key store for the AI-providers Settings
 * surface. It CONSUMES the untouched substrate (`provider-key-store.ts`) and exposes
 * list/set/remove over it, mirroring `connection-registry.ts`'s lazy-memoized style:
 * the store is opened LAZILY on the first call and memoized on SUCCESS ONLY, so a
 * transient `unavailable` does not permanently poison the surface (the next call
 * retries the open).
 *
 * Trust boundary: list/set replies are SECRET-FREE. Every summary is a
 * {@link ProviderSummary} (`{ provider, keyPreview }`) — never the raw key, only a
 * last-4 preview. `getKey(kind)` is the Core-INTERNAL path (never wired to an RPC
 * handler); it returns the raw key for the unified AI layer to construct a model.
 *
 * Error mapping lives here in one place:
 *  - `bad_request`   — unknown provider kind, or a blank/whitespace-only key.
 *  - `internal_error`— any store-open failure or a `write-failed` flush.
 * Remove is idempotent-ok (matches the store's absent-kind no-op).
 */

import {
  PROVIDER_KINDS,
  type ListProvidersResult,
  type ProviderKind,
  type ProviderSummary,
  type RemoveProviderParams,
  type RemoveProviderResult,
  type RpcErrorCode,
  type SetProviderParams,
  type SetProviderResult,
} from "../shared/contract.ts";
import {
  openProviderKeyStore,
  type OpenResult,
  type ProviderKeyStore,
  type ProviderKeyStoreDeps,
  type StoredProviderKey,
} from "./provider-key-store.ts";

/** A registry operation outcome. Mirrors `connection-registry`'s {@link RegistryResult}. */
export type RegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: RpcErrorCode;
      readonly message: string;
      readonly detail?: string;
    };

/** The live registry handle returned by {@link createProviderRegistry}. */
export type ProviderRegistry = {
  /** All configured provider keys as secret-free summaries. */
  list(): RegistryResult<ListProvidersResult>;
  /** Upsert a provider key by kind, return its secret-free summary. */
  set(params: SetProviderParams): RegistryResult<SetProviderResult>;
  /** Remove a provider key by kind. Idempotent: an absent kind is still a success. */
  remove(params: RemoveProviderParams): RegistryResult<RemoveProviderResult>;
  /**
   * Core-INTERNAL: the raw key for a kind (or `null` when unconfigured), for the
   * unified AI layer only. NEVER wired to an RPC handler — the raw key stays in Ring 1.
   */
  getKey(provider: ProviderKind): RegistryResult<string | null>;
};

/** Dependencies for {@link createProviderRegistry}, mirroring the connection registry. */
export type ProviderRegistryDeps = {
  /** Store-open seam. Defaults to `() => openProviderKeyStore(storeDeps)`. */
  readonly openStore?: () => OpenResult;
  /** Deps for the default store open. Ignored when `openStore` is supplied. */
  readonly storeDeps?: ProviderKeyStoreDeps;
};

/** True when `value` is one of the known {@link ProviderKind}s. */
function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Derive the secret-free summary from a stored record: the last 4 characters of the
 * key, prefixed with an ellipsis so it reads as a preview and never the whole key.
 * A key shorter than 4 chars (already rejected on the way in) shows what it has.
 */
function toSummary(record: StoredProviderKey): ProviderSummary {
  const key = record.apiKey;
  return {
    provider: record.provider,
    // Never reveal the whole secret: a key of 4 or fewer chars would make the
    // "last 4" the entire key, so it collapses to a bare ellipsis instead.
    keyPreview: key.length <= 4 ? "…" : `…${key.slice(-4)}`,
  };
}

function badRequest(message: string, field: string): RegistryResult<never> {
  return { ok: false, code: "bad_request", message, detail: `field=${field}` };
}

/**
 * Build the provider-key registry. The store is NOT opened here — it opens lazily on
 * the first list/set/remove/getKey and is memoized only on success (failures stay
 * retryable).
 */
export function createProviderRegistry(
  deps: ProviderRegistryDeps = {},
): ProviderRegistry {
  const openStore = deps.openStore ?? (() => openProviderKeyStore(deps.storeDeps));

  // Memoize SUCCESS only — a transient open failure must not poison the surface.
  let cached: ProviderKeyStore | null = null;

  function obtain(): RegistryResult<ProviderKeyStore> {
    if (cached !== null) return { ok: true, value: cached };
    const opened = openStore();
    if (opened.outcome === "opened") {
      cached = opened.store;
      return { ok: true, value: cached };
    }
    // Every non-opened arm is an internal_error. `detail` carries ONLY the safe
    // outcome LABEL — never `opened.detail`, whose text may embed app-dir paths.
    return {
      ok: false,
      code: "internal_error",
      message: "provider-key store is unavailable",
      detail: opened.outcome,
    };
  }

  function writeFailed(): RegistryResult<never> {
    return {
      ok: false,
      code: "internal_error",
      message: "failed to persist the provider key",
      detail: "write-failed",
    };
  }

  return {
    list() {
      const store = obtain();
      if (!store.ok) return store;
      const providers = store.value.listKeys().map(toSummary);
      return { ok: true, value: { providers } };
    },

    set(params) {
      const provider = params?.provider;
      if (!isProviderKind(provider)) {
        return badRequest("unknown provider kind", "provider");
      }
      const apiKey = params?.apiKey;
      if (typeof apiKey !== "string") {
        return badRequest("apiKey must be a string", "apiKey");
      }
      // Trim: a whitespace-only key is never a usable secret and is rejected before
      // anything is stored. The trimmed form is what's persisted.
      const trimmed = apiKey.trim();
      if (trimmed.length === 0) {
        return badRequest("apiKey must not be empty", "apiKey");
      }

      const store = obtain();
      if (!store.ok) return store;

      const record: StoredProviderKey = { provider, apiKey: trimmed };
      const mutation = store.value.saveKey(record);
      if (mutation.outcome !== "ok") return writeFailed();
      return { ok: true, value: toSummary(record) };
    },

    remove(params) {
      const provider = params?.provider;
      if (!isProviderKind(provider)) {
        return badRequest("unknown provider kind", "provider");
      }

      const store = obtain();
      if (!store.ok) return store;

      // Idempotent: the store's deleteKey is a no-op `ok` for an absent kind.
      const mutation = store.value.deleteKey(provider);
      if (mutation.outcome !== "ok") return writeFailed();
      return { ok: true, value: { removed: true } };
    },

    getKey(provider) {
      if (!isProviderKind(provider)) {
        return badRequest("unknown provider kind", "provider");
      }
      const store = obtain();
      if (!store.ok) return store;
      const record = store.value.getKey(provider);
      return { ok: true, value: record === undefined ? null : record.apiKey };
    },
  };
}
