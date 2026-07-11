/**
 * quick-studio Core — mode-aware encrypted provider-key store (Story 5.1).
 *
 * The secure home for the user's AI provider API keys (Anthropic/OpenAI/Google).
 * It mirrors the Epic 2 credential store (`credential-store.ts`) exactly: keys are
 * encrypted at rest (AES-256-GCM) under the SAME keychain master key (AR-7) — one
 * unlock covers both stores — or, on a keychain-less machine, a passphrase-derived
 * key (FR-5) whose non-secret salt descriptor lives beside its own `.enc`. In
 * Ephemeral mode nothing is ever written to disk (mirror the credential-store gate).
 *
 * Identity is the provider KIND: at most one key per kind. Its own on-disk files
 * (`provider-keys.enc` + `provider-keys.meta.json`) and its own payload schema
 * version keep it entirely separate from the connections payload — a provider key
 * is NEVER stored inside `StoredConnection`/`credential-store.enc`.
 *
 * `openProviderKeyStore` is TOTAL: every keychain/passphrase/decrypt failure is a
 * typed {@link OpenResult} arm — never a throw, never a plaintext fallback.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PROVIDER_KINDS, type ProviderKind } from "../shared/contract.ts";
import { ensureAppDir } from "./app-dir.ts";
import {
  CRYPTO_SCHEMA_VERSION,
  KEY_LENGTH_BYTES,
  decryptJson,
  encryptJson,
  type CryptoEnvelope,
} from "./crypto.ts";
import {
  DEFAULT_SCRYPT_PARAMS,
  SALT_LENGTH_BYTES,
  derivePassphraseKey,
  generateSalt,
  type ScryptParams,
} from "./passphrase-key.ts";
import {
  envPassphraseProvider,
  type PassphraseProvider,
} from "./passphrase-provider.ts";
import { resolveRunMode, type RunMode } from "./run-mode.ts";
import {
  loadOrCreateStoreKey,
  type StoreKeyResult,
} from "./store-key.ts";

/** Encrypted provider-key store filename under the app dir (distinct from connections). */
export const PROVIDER_STORE_FILE_NAME = "provider-keys.enc";

/**
 * Non-secret key descriptor sidecar filename. Present ⇒ passphrase mode; absent ⇒
 * keychain mode. Its own file so the two stores' key modes stay independent.
 */
export const PROVIDER_STORE_META_FILE_NAME = "provider-keys.meta.json";

/** Schema version of the DECRYPTED provider-key payload. */
export const PROVIDER_STORE_SCHEMA_VERSION = 1;

/** Schema version of the on-disk key descriptor. */
export const PROVIDER_STORE_META_SCHEMA_VERSION = 1;

/**
 * A persisted provider-key record. `apiKey` carries the secret, so this whole
 * record is what the store encrypts. `provider` is the identity (one per kind).
 */
export type StoredProviderKey = {
  readonly provider: ProviderKind;
  readonly apiKey: string;
};

/** The decrypted on-disk payload shape. */
type StorePayload = {
  readonly schemaVersion: number;
  readonly keys: readonly StoredProviderKey[];
};

/** Result of a store mutation ({@link ProviderKeyStore.saveKey}/`deleteKey`). */
export type MutationResult =
  | { readonly outcome: "ok" }
  | { readonly outcome: "write-failed"; readonly detail: string };

/** The live store handle returned by a successful {@link openProviderKeyStore}. */
export type ProviderKeyStore = {
  /** The mode this store opened in. */
  readonly mode: RunMode;
  /** Upsert a key by provider kind. Persistent → flush ciphertext; ephemeral → memory only. */
  readonly saveKey: (record: StoredProviderKey) => MutationResult;
  /** Read a key by provider kind, or `undefined` when absent. */
  readonly getKey: (provider: ProviderKind) => StoredProviderKey | undefined;
  /** Snapshot of all provider keys (defensive copy). */
  readonly listKeys: () => readonly StoredProviderKey[];
  /** Remove a key by provider kind. Persistent → flush; ephemeral → memory only. */
  readonly deleteKey: (provider: ProviderKind) => MutationResult;
};

/** Outcome of {@link openProviderKeyStore}. Every failure arm is a typed hook. */
export type OpenResult =
  | { readonly outcome: "opened"; readonly store: ProviderKeyStore }
  | { readonly outcome: "unavailable"; readonly detail: string }
  | { readonly outcome: "key-invalid"; readonly detail: string }
  | { readonly outcome: "corrupt"; readonly detail: string }
  | { readonly outcome: "schema-unknown"; readonly detail: string }
  | { readonly outcome: "passphrase-declined"; readonly detail: string }
  | { readonly outcome: "passphrase-invalid"; readonly detail: string }
  | { readonly outcome: "key-unavailable"; readonly detail: string };

/** The non-secret on-disk key descriptor — salt + scrypt params only, never a key. */
type KeyDescriptor = {
  readonly schemaVersion: number;
  readonly keyMode: "passphrase";
  readonly kdf: {
    readonly algo: "scrypt";
    readonly salt: string;
    readonly n: number;
    readonly r: number;
    readonly p: number;
    readonly keylen: number;
  };
};

/** Injectable deps so the failure arms are unit-testable without a live keychain. */
export type ProviderKeyStoreDeps = {
  /** Persistent/Ephemeral gate. Defaults to `resolveRunMode(process.env)`. */
  readonly mode?: RunMode;
  /** App-data directory (persistent mode only). Defaults to `ensureAppDir()`. */
  readonly dir?: string;
  /** Keychain master-key provider. Defaults to `loadOrCreateStoreKey()`. */
  readonly loadStoreKey?: () => StoreKeyResult;
  /** Passphrase source for the keychain-less fallback. Defaults to `envPassphraseProvider(process.env)`. */
  readonly passphraseProvider?: PassphraseProvider;
};

/** Type guard: a parsed value is a well-formed {@link CryptoEnvelope}. */
function isCryptoEnvelope(value: unknown): value is CryptoEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.schemaVersion === "number" &&
    typeof v.iv === "string" &&
    typeof v.authTag === "string" &&
    typeof v.ciphertext === "string"
  );
}

/** Type guard: a parsed value has the {@link StorePayload} envelope shape. */
function isStorePayload(value: unknown): value is StorePayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.schemaVersion === "number" && Array.isArray(v.keys);
}

/** True when `value` is one of the known {@link ProviderKind}s. */
function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Type guard: a decrypted `keys` element is a well-formed {@link StoredProviderKey}
 * (a known provider kind + a string apiKey). Guards against loading a record with
 * an unknown/undefined provider identity.
 */
function isStoredProviderKey(value: unknown): value is StoredProviderKey {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isProviderKind(v.provider) && typeof v.apiKey === "string";
}

/** Type guard: a parsed value is a well-formed {@link KeyDescriptor}. */
function isKeyDescriptor(value: unknown): value is KeyDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.schemaVersion !== "number") return false;
  if (v.keyMode !== "passphrase") return false;
  if (typeof v.kdf !== "object" || v.kdf === null) return false;
  const kdf = v.kdf as Record<string, unknown>;
  return (
    kdf.algo === "scrypt" &&
    typeof kdf.salt === "string" &&
    typeof kdf.n === "number" &&
    typeof kdf.r === "number" &&
    typeof kdf.p === "number" &&
    typeof kdf.keylen === "number"
  );
}

/** Result of reading the descriptor sidecar. */
type DescriptorRead =
  | { readonly kind: "present"; readonly descriptor: KeyDescriptor }
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt"; readonly detail: string }
  | { readonly kind: "schema-unknown"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/** A positive integer that is an exact power of two. */
function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/** Validate the non-secret KDF params before deriving; returns the first bad field or null. */
function invalidKdfField(kdf: KeyDescriptor["kdf"]): string | null {
  if (Buffer.from(kdf.salt, "base64").length !== SALT_LENGTH_BYTES) return "kdf salt";
  if (kdf.keylen !== KEY_LENGTH_BYTES) return "kdf keylen";
  if (!isPowerOfTwo(kdf.n) || kdf.n < 2 ** 14 || kdf.n > 2 ** 20) return "kdf n";
  if (!Number.isInteger(kdf.r) || kdf.r < 1 || kdf.r > 32) return "kdf r";
  if (!Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > 16) return "kdf p";
  return null;
}

/** Read + classify the key descriptor sidecar. ENOENT → absent. Never throws. */
function readDescriptor(metaPath: string): DescriptorRead {
  let raw: string;
  try {
    raw = readFileSync(metaPath, "utf8");
  } catch (err) {
    const code =
      err !== null && typeof err === "object" && "code" in err
        ? (err as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") return { kind: "absent" };
    return {
      kind: "unavailable",
      detail: err instanceof Error ? err.message : "descriptor unreadable",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "corrupt",
      detail: err instanceof Error ? err.message : "descriptor is not valid JSON",
    };
  }
  if (!isKeyDescriptor(parsed)) {
    return { kind: "corrupt", detail: "descriptor has an unrecognized shape" };
  }
  if (parsed.schemaVersion !== PROVIDER_STORE_META_SCHEMA_VERSION) {
    return {
      kind: "schema-unknown",
      detail: `unrecognized descriptor schemaVersion ${String(parsed.schemaVersion)}`,
    };
  }
  const badField = invalidKdfField(parsed.kdf);
  if (badField !== null) {
    return { kind: "corrupt", detail: `${badField} invalid` };
  }
  return { kind: "present", descriptor: parsed };
}

/** Atomically write the non-secret descriptor with owner-only perms (0o600). Never throws. */
function writeDescriptor(
  metaPath: string,
  descriptor: KeyDescriptor,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  const tmpPath = `${metaPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(descriptor), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmpPath, metaPath);
    return { ok: true };
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "descriptor write failed",
    };
  }
}

/**
 * Encrypt a key set under `key` and atomically write the envelope to `filePath`
 * (0o600, temp + rename). Returns a typed `write-failed` on any failure; never throws.
 */
function writeStoreFile(
  filePath: string,
  key: Buffer,
  keys: readonly StoredProviderKey[],
): MutationResult {
  const payload: StorePayload = {
    schemaVersion: PROVIDER_STORE_SCHEMA_VERSION,
    keys: [...keys],
  };
  const enc = encryptJson(key, payload);
  if (enc.outcome !== "encrypted") {
    return { outcome: "write-failed", detail: enc.detail };
  }
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(enc.envelope), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
    return { outcome: "ok" };
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    return {
      outcome: "write-failed",
      detail: err instanceof Error ? err.message : "store write failed",
    };
  }
}

/** Build a descriptor for a fresh passphrase store from its salt + scrypt params. */
function buildDescriptor(salt: Buffer, params: ScryptParams): KeyDescriptor {
  return {
    schemaVersion: PROVIDER_STORE_META_SCHEMA_VERSION,
    keyMode: "passphrase",
    kdf: {
      algo: "scrypt",
      salt: salt.toString("base64"),
      n: params.N,
      r: params.r,
      p: params.p,
      keylen: params.keylen,
    },
  };
}

/**
 * Open the provider-key store. Total — returns a typed {@link OpenResult}; never
 * throws for the expected failure conditions. In Ephemeral mode nothing is read or
 * written and the keychain is not touched.
 */
export function openProviderKeyStore(deps: ProviderKeyStoreDeps = {}): OpenResult {
  const mode = deps.mode ?? resolveRunMode(process.env);

  // Ephemeral: pure in-memory store, no keychain, no disk.
  if (mode === "ephemeral") {
    return { outcome: "opened", store: buildStore(mode, [], null, null) };
  }

  let dir: string;
  try {
    dir = deps.dir ?? ensureAppDir();
  } catch (err) {
    return {
      outcome: "unavailable",
      detail: err instanceof Error ? err.message : "app-data directory unavailable",
    };
  }
  const filePath = join(dir, PROVIDER_STORE_FILE_NAME);
  const metaPath = join(dir, PROVIDER_STORE_META_FILE_NAME);
  const passphraseProvider =
    deps.passphraseProvider ?? envPassphraseProvider(process.env);
  const loadStoreKey = deps.loadStoreKey ?? loadOrCreateStoreKey;

  // The descriptor is AUTHORITATIVE for an existing store's key mode.
  const descriptorRead = readDescriptor(metaPath);
  if (descriptorRead.kind === "corrupt") {
    return { outcome: "corrupt", detail: descriptorRead.detail };
  }
  if (descriptorRead.kind === "schema-unknown") {
    return { outcome: "schema-unknown", detail: descriptorRead.detail };
  }
  if (descriptorRead.kind === "unavailable") {
    return { outcome: "unavailable", detail: descriptorRead.detail };
  }

  // --- Passphrase mode (descriptor present): re-derive the key, keychain ignored.
  if (descriptorRead.kind === "present") {
    const descriptor = descriptorRead.descriptor;
    const response = passphraseProvider({
      reason: "keychain-unavailable",
      isFirstRun: false,
    });
    if (response.outcome === "declined") {
      return {
        outcome: "passphrase-declined",
        detail: "passphrase required to unlock the store, but none was provided",
      };
    }
    const salt = Buffer.from(descriptor.kdf.salt, "base64");
    const params: ScryptParams = {
      N: descriptor.kdf.n,
      r: descriptor.kdf.r,
      p: descriptor.kdf.p,
      keylen: descriptor.kdf.keylen,
    };
    const derived = derivePassphraseKey(response.passphrase, salt, params);
    if (derived.outcome === "passphrase-invalid") {
      return { outcome: "passphrase-invalid", detail: derived.detail };
    }
    if (derived.outcome === "derive-failed") {
      return { outcome: "unavailable", detail: derived.detail };
    }
    // A present descriptor means the store was created and its `.enc` eagerly seeded.
    // If the `.enc` is gone (removed out from under the descriptor), `loadStoreFromFile`
    // would open an empty store and silently accept ANY passphrase — so treat the
    // missing file as corruption rather than re-keying under an unverified passphrase.
    if (!existsSync(filePath)) {
      return { outcome: "corrupt", detail: "descriptor present but store file is missing" };
    }
    return loadStoreFromFile(mode, derived.key, filePath);
  }

  // --- Descriptor absent + `.enc` present: keychain mode.
  if (existsSync(filePath)) {
    const keyResult = loadStoreKey();
    if (keyResult.outcome === "unavailable" || keyResult.outcome === "created") {
      const detail =
        keyResult.outcome === "unavailable"
          ? keyResult.detail
          : "keychain regenerated a fresh key; the original store key is gone";
      return { outcome: "key-unavailable", detail };
    }
    if (keyResult.outcome === "key-invalid") {
      return { outcome: "key-invalid", detail: keyResult.detail };
    }
    return loadStoreFromFile(mode, keyResult.key, filePath);
  }

  // --- True first run (no descriptor, no `.enc`): keychain decides the mode.
  const keyResult = loadStoreKey();
  if (keyResult.outcome === "key-invalid") {
    return { outcome: "key-invalid", detail: keyResult.detail };
  }
  if (keyResult.outcome === "loaded" || keyResult.outcome === "created") {
    return {
      outcome: "opened",
      store: buildStore(mode, [], keyResult.key, filePath),
    };
  }

  // Keychain unavailable on a brand-new store → passphrase fallback via provider.
  const response = passphraseProvider({
    reason: "keychain-unavailable",
    isFirstRun: true,
  });
  if (response.outcome === "declined") {
    return {
      outcome: "passphrase-declined",
      detail: "keychain unavailable and no passphrase provided",
    };
  }
  const salt = generateSalt();
  const derived = derivePassphraseKey(
    response.passphrase,
    salt,
    DEFAULT_SCRYPT_PARAMS,
  );
  if (derived.outcome === "passphrase-invalid") {
    return { outcome: "passphrase-invalid", detail: derived.detail };
  }
  if (derived.outcome === "derive-failed") {
    return { outcome: "unavailable", detail: derived.detail };
  }
  // Persist the non-secret descriptor FIRST, then eagerly seed an empty `.enc` so a
  // wrong passphrase on a later reopen fails GCM (nothing to silently accept).
  const written = writeDescriptor(metaPath, buildDescriptor(salt, DEFAULT_SCRYPT_PARAMS));
  if (!written.ok) {
    return { outcome: "unavailable", detail: written.detail };
  }
  const seeded = writeStoreFile(filePath, derived.key, []);
  if (seeded.outcome !== "ok") {
    try {
      rmSync(metaPath, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    return { outcome: "unavailable", detail: seeded.detail };
  }
  return {
    outcome: "opened",
    store: buildStore(mode, [], derived.key, filePath),
  };
}

/**
 * Load + decrypt an EXISTING store file under `key`. A missing file is a ready empty
 * store. Total: classifies I/O errors, malformed envelopes, wrong keys, and unknown
 * schema versions into typed {@link OpenResult} arms.
 */
function loadStoreFromFile(
  mode: RunMode,
  key: Buffer,
  filePath: string,
): OpenResult {
  if (!existsSync(filePath)) {
    return { outcome: "opened", store: buildStore(mode, [], key, filePath) };
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    const code =
      err !== null && typeof err === "object" && "code" in err
        ? (err as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return { outcome: "opened", store: buildStore(mode, [], key, filePath) };
    }
    if (typeof code === "string") {
      return {
        outcome: "unavailable",
        detail: err instanceof Error ? err.message : "store file unreadable",
      };
    }
    return {
      outcome: "corrupt",
      detail: err instanceof Error ? err.message : "unreadable store file",
    };
  }

  if (!isCryptoEnvelope(parsed)) {
    return { outcome: "corrupt", detail: "store file is not a well-formed envelope" };
  }
  const envelope = parsed;

  if (envelope.schemaVersion !== CRYPTO_SCHEMA_VERSION) {
    return {
      outcome: "schema-unknown",
      detail: `unrecognized envelope schemaVersion ${String(envelope.schemaVersion)}`,
    };
  }

  const decrypted = decryptJson<unknown>(key, envelope);
  if (decrypted.outcome === "key-invalid") {
    return { outcome: "key-invalid", detail: decrypted.detail };
  }
  if (decrypted.outcome === "corrupt") {
    return { outcome: "corrupt", detail: decrypted.detail };
  }

  if (!isStorePayload(decrypted.value)) {
    return { outcome: "corrupt", detail: "decrypted payload is malformed" };
  }
  if (decrypted.value.schemaVersion !== PROVIDER_STORE_SCHEMA_VERSION) {
    return {
      outcome: "schema-unknown",
      detail: `unrecognized store schemaVersion ${String(decrypted.value.schemaVersion)}`,
    };
  }
  if (!decrypted.value.keys.every(isStoredProviderKey)) {
    return { outcome: "corrupt", detail: "decrypted payload contains a malformed key" };
  }

  return {
    outcome: "opened",
    store: buildStore(mode, decrypted.value.keys, key, filePath),
  };
}

/**
 * Construct the live store over an in-memory record map keyed by provider kind. When
 * `key`/`filePath` are non-null (persistent) mutations flush ciphertext; when null
 * (ephemeral) they stay in memory. Not exported — the only way in is `openProviderKeyStore`.
 */
function buildStore(
  mode: RunMode,
  initial: readonly StoredProviderKey[],
  key: Buffer | null,
  filePath: string | null,
): ProviderKeyStore {
  const records = new Map<ProviderKind, StoredProviderKey>();
  for (const rec of initial) records.set(rec.provider, rec);

  const flush = (next: Map<ProviderKind, StoredProviderKey>): MutationResult => {
    if (key === null || filePath === null) return { outcome: "ok" };
    return writeStoreFile(filePath, key, [...next.values()]);
  };

  /** Persist a prospective set, then commit to the live map ONLY on a durable write. */
  const commit = (next: Map<ProviderKind, StoredProviderKey>): MutationResult => {
    const result = flush(next);
    if (result.outcome === "ok") {
      records.clear();
      for (const [provider, rec] of next) records.set(provider, rec);
    }
    return result;
  };

  return {
    mode,
    saveKey(record) {
      const next = new Map(records);
      // Store a defensive copy so a later caller mutation can't reach into store state.
      next.set(record.provider, { ...record });
      return commit(next);
    },
    getKey(provider) {
      const rec = records.get(provider);
      return rec === undefined ? undefined : { ...rec };
    },
    listKeys() {
      return [...records.values()].map((rec) => ({ ...rec }));
    },
    deleteKey(provider) {
      // Deleting an absent kind is a no-op: skip the re-encrypt+write so an
      // idempotent delete can't churn the file or fail with `write-failed`.
      if (!records.has(provider)) return { outcome: "ok" };
      const next = new Map(records);
      next.delete(provider);
      return commit(next);
    },
  };
}
