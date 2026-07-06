/**
 * quick-studio Core — mode-aware encrypted credential store (UJ-2, FR-4/5/6, AR-7, AR-9).
 *
 * This is the Epic 2 persistence substrate: it saves Connection records so a
 * developer enters a connection ONCE and has it back on the next launch, with the
 * credential encrypted at rest (AES-256-GCM) and the key held only in the OS
 * keychain (AR-7). It is the substrate Story 2.4 (manage Connections) and Epic 5
 * (Provider keys) build on.
 *
 * It composes the four Ring-1 pieces: {@link resolveAppDir}/`ensureAppDir` for the
 * OS-convention home (AR-9), {@link loadOrCreateStoreKey} for the master key
 * (AR-7), {@link encryptJson}/{@link decryptJson} for the at-rest cipher, and
 * {@link resolveRunMode} for the Persistent/Ephemeral gate.
 *
 * Guarantees:
 *  - Persistent mode: mutations flush an AES-256-GCM `credential-store.enc` under
 *    the app dir. The file holds only ciphertext — never the key, never plaintext.
 *  - Ephemeral mode: records live in memory only. NOTHING is written to disk — the
 *    keychain is not even touched.
 *  - `openCredentialStore` is total: keychain `unavailable`, a non-32-byte key
 *    (`key-invalid`), a tampered/wrong-key file (`corrupt`), and an unrecognized
 *    on-disk `schemaVersion` (`schema-unknown`) are all TYPED results — never a
 *    throw, never a plaintext fallback, never a silent overwrite.
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
import { ensureAppDir } from "./app-dir.ts";
import {
  CRYPTO_SCHEMA_VERSION,
  decryptJson,
  encryptJson,
  type CryptoEnvelope,
} from "./crypto.ts";
import { resolveRunMode, type RunMode } from "./run-mode.ts";
import {
  loadOrCreateStoreKey,
  type StoreKeyResult,
} from "./store-key.ts";

/** Encrypted store filename under the app dir. */
export const STORE_FILE_NAME = "credential-store.enc";

/** Schema version of the DECRYPTED payload (distinct from the envelope's). */
export const STORE_SCHEMA_VERSION = 1;

/**
 * A persisted Connection record. `url` carries the secret (credentials embedded in
 * the connection string), so this whole record is what the store encrypts.
 */
export type StoredConnection = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
};

/** The decrypted on-disk payload shape. */
type StorePayload = {
  readonly schemaVersion: number;
  readonly connections: readonly StoredConnection[];
};

/** Result of a store mutation ({@link CredentialStore.saveConnection}/`deleteConnection`). */
export type MutationResult =
  | { readonly outcome: "ok" }
  | { readonly outcome: "write-failed"; readonly detail: string };

/** The live store handle returned by a successful {@link openCredentialStore}. */
export type CredentialStore = {
  /** The mode this store opened in. */
  readonly mode: RunMode;
  /** Upsert a Connection by id. Persistent → flush ciphertext; ephemeral → memory only. */
  readonly saveConnection: (record: StoredConnection) => MutationResult;
  /** Read a Connection by id, or `undefined` when absent. */
  readonly getConnection: (id: string) => StoredConnection | undefined;
  /** Snapshot of all Connections (defensive copy). */
  readonly listConnections: () => readonly StoredConnection[];
  /** Remove a Connection by id. Persistent → flush; ephemeral → memory only. */
  readonly deleteConnection: (id: string) => MutationResult;
};

/** Outcome of {@link openCredentialStore}. Every failure arm is a typed hook. */
export type OpenResult =
  | { readonly outcome: "opened"; readonly store: CredentialStore }
  | { readonly outcome: "unavailable"; readonly detail: string }
  | { readonly outcome: "key-invalid"; readonly detail: string }
  | { readonly outcome: "corrupt"; readonly detail: string }
  | { readonly outcome: "schema-unknown"; readonly detail: string };

/**
 * Injectable dependencies so the failure arms (`unavailable`/`key-invalid`/
 * `corrupt`/`schema-unknown`) are unit-testable without a live keychain or the
 * user's real app dir. Every field defaults to the real implementation.
 */
export type CredentialStoreDeps = {
  /** Persistent/Ephemeral gate. Defaults to `resolveRunMode(process.env)`. */
  readonly mode?: RunMode;
  /** App-data directory (persistent mode only). Defaults to `ensureAppDir()`. */
  readonly dir?: string;
  /** Master-key provider. Defaults to `loadOrCreateStoreKey()`. */
  readonly loadStoreKey?: () => StoreKeyResult;
};

/**
 * Type guard: a parsed value is a well-formed {@link CryptoEnvelope}. A store file
 * holding a bare `null`, `{}`, `[]`, or any non-envelope JSON is NOT trusted —
 * this keeps a later property access from throwing and breaking the total boundary.
 */
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

/**
 * Type guard: a parsed value has the {@link StorePayload} envelope shape — a
 * non-null object with a numeric `schemaVersion` and an array `connections`.
 * Element shapes are validated separately (see {@link isStoredConnection}) AFTER
 * the version gate, so a future schema is classified `schema-unknown`, not `corrupt`.
 */
function isStorePayload(value: unknown): value is StorePayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.schemaVersion === "number" && Array.isArray(v.connections);
}

/**
 * Type guard: a decrypted `connections` element is a well-formed
 * {@link StoredConnection} (non-null object with string `id`/`name`/`url`). Guards
 * against `records.set(rec.id, ...)` running with `rec.id === undefined`.
 */
function isStoredConnection(value: unknown): value is StoredConnection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.url === "string"
  );
}

/**
 * Open the credential store. Total — returns a typed {@link OpenResult}; never
 * throws for the expected failure conditions. In Ephemeral mode nothing is read
 * or written and the keychain is not touched.
 */
export function openCredentialStore(deps: CredentialStoreDeps = {}): OpenResult {
  const mode = deps.mode ?? resolveRunMode(process.env);

  // Ephemeral: pure in-memory store, no keychain, no disk.
  if (mode === "ephemeral") {
    return { outcome: "opened", store: buildStore(mode, [], null, null) };
  }

  // Persistent: obtain the master key from the keychain (AR-7).
  const keyResult = (deps.loadStoreKey ?? loadOrCreateStoreKey)();
  if (keyResult.outcome === "unavailable") {
    return { outcome: "unavailable", detail: keyResult.detail };
  }
  if (keyResult.outcome === "key-invalid") {
    return { outcome: "key-invalid", detail: keyResult.detail };
  }
  const key = keyResult.key;

  // Resolving/creating the app dir (mkdir) can throw on EACCES/EROFS/read-only
  // home, or when no absolute home can be resolved (see ensureAppDir). Keep the
  // boundary total by surfacing a typed `unavailable` instead of the throw.
  let dir: string;
  try {
    dir = deps.dir ?? ensureAppDir();
  } catch (err) {
    return {
      outcome: "unavailable",
      detail: err instanceof Error ? err.message : "app-data directory unavailable",
    };
  }
  const filePath = join(dir, STORE_FILE_NAME);

  // First run: no file → empty store, ready to save.
  if (!existsSync(filePath)) {
    return { outcome: "opened", store: buildStore(mode, [], key, filePath) };
  }

  // Load + parse the existing file.
  let parsed: unknown;
  try {
    const raw = readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    // Distinguish an I/O failure from genuinely malformed content: a filesystem
    // error carries a POSIX `code`, a JSON.parse SyntaxError does not.
    const code =
      err !== null && typeof err === "object" && "code" in err
        ? (err as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      // TOCTOU: the file vanished between existsSync and read → treat as first run.
      return { outcome: "opened", store: buildStore(mode, [], key, filePath) };
    }
    if (typeof code === "string") {
      // EACCES/EIO/EISDIR/… — the ciphertext may be intact; a `corrupt` verdict
      // could prompt destructive recovery. Surface a non-destructive `unavailable`.
      return {
        outcome: "unavailable",
        detail: err instanceof Error ? err.message : "store file unreadable",
      };
    }
    // No POSIX code → malformed JSON content → genuinely corrupt.
    return {
      outcome: "corrupt",
      detail: err instanceof Error ? err.message : "unreadable store file",
    };
  }

  // Valid JSON that is NOT a well-formed envelope (null, {}, [], a bare number)
  // is `corrupt`, not `schema-unknown`. Only a well-formed envelope with a
  // recognized-but-different numeric schemaVersion is `schema-unknown`.
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
  if (decrypted.value.schemaVersion !== STORE_SCHEMA_VERSION) {
    return {
      outcome: "schema-unknown",
      detail: `unrecognized store schemaVersion ${String(decrypted.value.schemaVersion)}`,
    };
  }
  // Known schema: every connection element must be well-formed, else the payload
  // is corrupt (do not load a broken map with undefined ids).
  if (!decrypted.value.connections.every(isStoredConnection)) {
    return { outcome: "corrupt", detail: "decrypted payload contains a malformed connection" };
  }

  return {
    outcome: "opened",
    store: buildStore(mode, decrypted.value.connections, key, filePath),
  };
}

/**
 * Construct the live store over an in-memory record map. When `key`/`filePath` are
 * non-null (persistent mode) mutations flush ciphertext; when null (ephemeral)
 * they stay in memory. Not exported — the only way to a store is `openCredentialStore`.
 */
function buildStore(
  mode: RunMode,
  initial: readonly StoredConnection[],
  key: Buffer | null,
  filePath: string | null,
): CredentialStore {
  const records = new Map<string, StoredConnection>();
  for (const rec of initial) records.set(rec.id, rec);

  /**
   * Encrypt a PROSPECTIVE record set and write the envelope to disk atomically
   * (persistent only): write a sibling temp file with mode 0o600, then `rename`
   * over the target so an interrupted write can never truncate the live store.
   * Ephemeral (key/filePath null) is a no-op `ok`.
   */
  const flush = (next: Map<string, StoredConnection>): MutationResult => {
    if (key === null || filePath === null) return { outcome: "ok" };
    const payload: StorePayload = {
      schemaVersion: STORE_SCHEMA_VERSION,
      connections: [...next.values()],
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
      // `rename` moves the 0o600 temp inode over the target, so the committed
      // file keeps owner-only perms. A post-rename chmod is redundant AND unsafe:
      // if it failed after the durable rename, flush would report `write-failed`
      // while disk already held the new data — diverging memory from disk.
      renameSync(tmpPath, filePath);
      return { outcome: "ok" };
    } catch (err) {
      // Best-effort cleanup so a failed write leaves no `.tmp` residue.
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
  };

  /**
   * Persist a prospective record set, then commit it to the live map ONLY on a
   * durable write — so observable state never diverges from what is on disk.
   */
  const commit = (next: Map<string, StoredConnection>): MutationResult => {
    const result = flush(next);
    if (result.outcome === "ok") {
      records.clear();
      for (const [id, rec] of next) records.set(id, rec);
    }
    return result;
  };

  return {
    mode,
    saveConnection(record) {
      const next = new Map(records);
      next.set(record.id, record);
      return commit(next);
    },
    getConnection(id) {
      const rec = records.get(id);
      // Return a shallow copy so a caller can't mutate the internal record.
      return rec === undefined ? undefined : { ...rec };
    },
    listConnections() {
      return [...records.values()].map((rec) => ({ ...rec }));
    },
    deleteConnection(id) {
      // Deleting an absent id is a no-op: skip the re-encrypt+write so an
      // idempotent delete can't churn the file or fail with `write-failed`.
      if (!records.has(id)) return { outcome: "ok" };
      const next = new Map(records);
      next.delete(id);
      return commit(next);
    },
  };
}
