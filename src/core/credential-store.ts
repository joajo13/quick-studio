/**
 * quick-studio Core — mode-aware encrypted credential store (UJ-2, FR-4/5/6, AR-7, AR-9, AD-5).
 *
 * This is the Epic 2 persistence substrate: it saves Connection records so a
 * developer enters a connection ONCE and has it back on the next launch, with the
 * credential encrypted at rest (AES-256-GCM) and the key held either in the OS
 * keychain (AR-7) or — on a keychain-less machine — derived from a passphrase via
 * scrypt (FR-5, AD-5). It is the substrate Story 2.4 (manage Connections) and
 * Epic 5 (Provider keys) build on.
 *
 * It composes the Ring-1 pieces: `ensureAppDir` for the OS-convention home (AR-9),
 * {@link loadOrCreateStoreKey} for the keychain master key (AR-7),
 * {@link derivePassphraseKey} for the passphrase fallback key (FR-5),
 * {@link encryptJson}/{@link decryptJson} for the at-rest cipher, and
 * {@link resolveRunMode} for the Persistent/Ephemeral gate.
 *
 * Key mode is decided by an on-disk, NON-SECRET key descriptor
 * (`credential-store.meta.json`), which is AUTHORITATIVE for an existing store:
 *  - descriptor present (passphrase mode) → re-derive the key from the persisted
 *    salt/params via the injected passphrase provider; the keychain is ignored.
 *  - descriptor absent + `.enc` present → keychain mode (Story 2.2 back-compat).
 *  - descriptor absent + no `.enc` (true first run) → try the keychain; if it is
 *    unavailable, fall back to passphrase mode via the provider.
 * Keychain availability decides the mode ONLY for a brand-new store.
 *
 * Guarantees:
 *  - Persistent mode: mutations flush an AES-256-GCM `credential-store.enc` under
 *    the app dir. The file holds only ciphertext — never a key, never a passphrase,
 *    never plaintext. A passphrase store additionally writes the non-secret
 *    descriptor AND an eagerly-encrypted empty `.enc` at creation, so a later reopen
 *    always has ciphertext to authenticate a passphrase against (a wrong passphrase
 *    on a not-yet-saved store fails GCM → `corrupt`, never a silent accept).
 *  - Ephemeral mode: records live in memory only. NOTHING is written to disk — the
 *    keychain is not even touched.
 *  - `openCredentialStore` is total: keychain `unavailable`, a non-32-byte key
 *    (`key-invalid`), a passphrase decline (`passphrase-declined`) or empty
 *    passphrase (`passphrase-invalid`), a keychain-mode file with the key now gone
 *    (`key-unavailable`), a tampered/wrong-key file (`corrupt`), and an unrecognized
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
import { acquireStoreLock, type StoreLockResult } from "./store-lock.ts";

/** Encrypted store filename under the app dir. */
export const STORE_FILE_NAME = "credential-store.enc";

/**
 * Advisory single-writer lock filename under the app dir (DW-14). Created 0o600 via
 * `O_EXCL`, held for the persistent store's lifetime, released on `store.close()`.
 * Records only pid/host/token/timestamp — never a secret. Absent for ephemeral stores.
 */
export const STORE_LOCK_FILE_NAME = "credential-store.lock";

/**
 * Non-secret key descriptor sidecar filename. Present ⇒ passphrase mode; absent ⇒
 * keychain mode (preserving Story 2.2's `.enc`-only layout and back-compat).
 */
export const STORE_META_FILE_NAME = "credential-store.meta.json";

/** Schema version of the DECRYPTED payload (distinct from the envelope's). */
export const STORE_SCHEMA_VERSION = 1;

/** Schema version of the on-disk key descriptor. */
export const STORE_META_SCHEMA_VERSION = 1;

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
  /**
   * Release the persistent single-writer lock (DW-14). Idempotent — calling it more
   * than once, or on an ephemeral store, is a safe no-op. Wired into clean shutdown
   * via `connectionRegistry.close()` so a relaunch needs no reclaim.
   */
  readonly close: () => void;
};

/** Outcome of {@link openCredentialStore}. Every failure arm is a typed hook. */
export type OpenResult =
  | { readonly outcome: "opened"; readonly store: CredentialStore }
  | { readonly outcome: "unavailable"; readonly detail: string }
  /** A live writer already holds the single-writer lock (DW-14). Nothing written. */
  | { readonly outcome: "locked"; readonly detail: string }
  | { readonly outcome: "key-invalid"; readonly detail: string }
  | { readonly outcome: "corrupt"; readonly detail: string }
  | { readonly outcome: "schema-unknown"; readonly detail: string }
  /** Keychain unavailable and the developer declined the passphrase fallback. Nothing written. */
  | { readonly outcome: "passphrase-declined"; readonly detail: string }
  /** Passphrase was empty/whitespace-only — never a usable key. Nothing written. */
  | { readonly outcome: "passphrase-invalid"; readonly detail: string }
  /** Keychain-mode file present but the keychain key is gone (distinct from `corrupt`). */
  | { readonly outcome: "key-unavailable"; readonly detail: string };

/**
 * The non-secret on-disk key descriptor. It holds ONLY re-derivation material —
 * a base64 salt and the scrypt cost params — never a passphrase or a derived key.
 * Its mere presence signals passphrase mode.
 */
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

/**
 * Injectable dependencies so the failure arms are unit-testable without a live
 * keychain or the user's real app dir. Every field defaults to the real
 * implementation.
 */
export type CredentialStoreDeps = {
  /** Persistent/Ephemeral gate. Defaults to `resolveRunMode(process.env)`. */
  readonly mode?: RunMode;
  /** App-data directory (persistent mode only). Defaults to `ensureAppDir()`. */
  readonly dir?: string;
  /** Keychain master-key provider. Defaults to `loadOrCreateStoreKey()`. */
  readonly loadStoreKey?: () => StoreKeyResult;
  /** Passphrase source for the keychain-less fallback. Defaults to `envPassphraseProvider(process.env)`. */
  readonly passphraseProvider?: PassphraseProvider;
  /**
   * Single-writer lock seam (DW-14). Defaults to `acquireStoreLock`. Injected in
   * tests to drive the `locked`/`unavailable` arms and observe `release` without
   * touching real disk. Persistent mode only — ephemeral never calls it.
   */
  readonly acquireLock?: (lockPath: string) => StoreLockResult;
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
 * Type guard: a parsed value is a well-formed {@link KeyDescriptor} — a passphrase
 * key descriptor with a base64 salt and numeric scrypt params. A file that parses
 * as JSON but does NOT match this shape is descriptor `corrupt`, not "keychain
 * mode" (an absent FILE means keychain mode; a malformed one means corruption).
 */
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

/** Result of reading the descriptor sidecar. Mirrors the `.enc` read-path classification. */
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

/**
 * Validate the non-secret KDF params of a descriptor BEFORE deriving. Rejects a
 * degenerate salt (e.g. an empty/`""` base64 → 0-byte salt → weakened KDF), a
 * wrong key length, or a hostile/out-of-range work factor (which could make the
 * synchronous `scryptSync` hang or exhaust memory). Returns the name of the first
 * invalid field, or `null` when every field is sane. Salt/params are non-secret, so
 * naming the field never leaks a secret.
 */
function invalidKdfField(kdf: KeyDescriptor["kdf"]): string | null {
  if (Buffer.from(kdf.salt, "base64").length !== SALT_LENGTH_BYTES) return "kdf salt";
  if (kdf.keylen !== KEY_LENGTH_BYTES) return "kdf keylen";
  // N must be a power of two in [2**14, 2**20] (scrypt requires a power of two).
  if (!isPowerOfTwo(kdf.n) || kdf.n < 2 ** 14 || kdf.n > 2 ** 20) return "kdf n";
  if (!Number.isInteger(kdf.r) || kdf.r < 1 || kdf.r > 32) return "kdf r";
  if (!Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > 16) return "kdf p";
  return null;
}

/**
 * Read + classify the key descriptor sidecar. ENOENT → `absent` (keychain mode /
 * first run). A non-ENOENT POSIX I/O error → `unavailable`. Malformed JSON or a
 * bad shape → `corrupt`. Never throws.
 */
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
    // EACCES/EISDIR/EIO/… — non-destructive: the store may be intact.
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
  // Version gate mirrors the payload path: an unrecognized descriptor schema is
  // `schema-unknown`, never `corrupt` (it may be a newer, forward-compatible file).
  if (parsed.schemaVersion !== STORE_META_SCHEMA_VERSION) {
    return {
      kind: "schema-unknown",
      detail: `unrecognized descriptor schemaVersion ${String(parsed.schemaVersion)}`,
    };
  }
  // Reject degenerate/hostile KDF params before they ever reach scryptSync.
  const badField = invalidKdfField(parsed.kdf);
  if (badField !== null) {
    return { kind: "corrupt", detail: `${badField} invalid` };
  }
  return { kind: "present", descriptor: parsed };
}

/**
 * Atomically write the non-secret descriptor with owner-only perms (0o600): write
 * a sibling temp then `rename` over the target. Returns a typed result; never
 * throws. The descriptor carries only salt + params — never a passphrase or key.
 */
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
 * Encrypt a record set under `key` and atomically write the envelope to `filePath`
 * with owner-only perms (0o600): write a sibling temp then `rename` over the target
 * so an interrupted write can never truncate the live store. On any failure the
 * temp is best-effort removed and a typed `write-failed` is returned; never throws.
 * Shared by a normal flush ({@link buildStore}) and by passphrase-store creation.
 */
function writeStoreFile(
  filePath: string,
  key: Buffer,
  connections: readonly StoredConnection[],
): MutationResult {
  const payload: StorePayload = {
    schemaVersion: STORE_SCHEMA_VERSION,
    connections: [...connections],
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
    // `rename` moves the 0o600 temp inode over the target, so the committed file
    // keeps owner-only perms. A post-rename chmod is redundant AND unsafe.
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
}

/** Build a descriptor for a fresh passphrase store from its salt + scrypt params. */
function buildDescriptor(salt: Buffer, params: ScryptParams): KeyDescriptor {
  return {
    schemaVersion: STORE_META_SCHEMA_VERSION,
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
 * Open the credential store. Total — returns a typed {@link OpenResult}; never
 * throws for the expected failure conditions. In Ephemeral mode nothing is read
 * or written and the keychain is not touched.
 */
export function openCredentialStore(deps: CredentialStoreDeps = {}): OpenResult {
  const mode = deps.mode ?? resolveRunMode(process.env);

  // Ephemeral: pure in-memory store, no keychain, no disk, no lock. `close()` is a
  // no-op (release is null) — nothing was acquired.
  if (mode === "ephemeral") {
    return { outcome: "opened", store: buildStore(mode, [], null, null, null) };
  }

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
  const metaPath = join(dir, STORE_META_FILE_NAME);
  const lockPath = join(dir, STORE_LOCK_FILE_NAME);

  // Single-writer guarantee (DW-14): acquire the cross-process advisory writer lock
  // ONCE, here — after ensureAppDir, before the descriptor read / key load / first-
  // run mint — and hold it for the store's lifetime. A second live writer on this
  // host is refused with `locked`; a lock I/O error is the non-destructive
  // `unavailable`. On acquire, `openPersistent` runs the real open and the lock is
  // released on EVERY non-`opened` arm (a failed open must never leak the lock); on
  // success the store owns the release via `close()`.
  const acquireLock = deps.acquireLock ?? ((p) => acquireStoreLock(p));
  const lock = acquireLock(lockPath);
  if (lock.outcome === "held") {
    return { outcome: "locked", detail: lock.detail };
  }
  if (lock.outcome === "unavailable") {
    return { outcome: "unavailable", detail: lock.detail };
  }
  let result: OpenResult;
  try {
    result = openPersistent(deps, mode, filePath, metaPath, lock.release);
  } catch (err) {
    // `openPersistent` is total for expected conditions, but an UNEXPECTED throw
    // (a contract-violating seam, an allocation failure, etc.) must still never leak
    // the acquired lock. Release best-effort (idempotent), then let the exceptional
    // error propagate — the store was never returned, so nothing else owns release.
    try {
      lock.release();
    } catch {
      /* best-effort: release must not mask the original throw. */
    }
    throw err;
  }
  if (result.outcome !== "opened") {
    // Best-effort: a failed open must never leak the lock, but the release seam must
    // also never turn a typed failure into a throw at this boundary.
    try {
      lock.release();
    } catch {
      /* best-effort: release must not throw out of a failed open. */
    }
  }
  return result;
}

/**
 * The persistent-mode open logic, run ONLY while holding the advisory writer lock
 * (see {@link openCredentialStore}). Total — returns a typed {@link OpenResult}.
 * `release` is threaded into {@link buildStore} on success so `store.close()`
 * releases the lock once; the caller releases it on every non-`opened` result.
 */
function openPersistent(
  deps: CredentialStoreDeps,
  mode: RunMode,
  filePath: string,
  metaPath: string,
  release: () => void,
): OpenResult {
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
      // Non-destructive: the ciphertext is intact, we just can't build the key
      // right now (e.g. tampered params). Do not risk a `corrupt` overwrite.
      return { outcome: "unavailable", detail: derived.detail };
    }
    return loadStoreFromFile(mode, derived.key, filePath, release);
  }

  // --- Descriptor absent + `.enc` present: keychain mode (Story 2.2 back-compat).
  if (existsSync(filePath)) {
    const keyResult = loadStoreKey();
    // File present but the keychain had to CREATE a fresh key ⇒ the ORIGINAL key is
    // gone (keychain reset / logout wipe / profile migration). A brand-new key can
    // never decrypt this `.enc`, so — exactly like `unavailable` — this is the
    // DISTINCT `key-unavailable` condition (file present, key gone), NOT `corrupt`.
    // Decrypting with the fresh key would GCM-fail and be misreported as `corrupt`.
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
    return loadStoreFromFile(mode, keyResult.key, filePath, release);
  }

  // --- True first run (no descriptor, no `.enc`): keychain decides the mode.
  const keyResult = loadStoreKey();
  if (keyResult.outcome === "key-invalid") {
    return { outcome: "key-invalid", detail: keyResult.detail };
  }
  if (keyResult.outcome === "loaded" || keyResult.outcome === "created") {
    // Keychain available → keychain mode. Writes NO descriptor (absent ⇒ keychain).
    return {
      outcome: "opened",
      store: buildStore(mode, [], keyResult.key, filePath, release),
    };
  }

  // Keychain unavailable on a brand-new store → passphrase fallback via provider.
  const response = passphraseProvider({
    reason: "keychain-unavailable",
    isFirstRun: true,
  });
  if (response.outcome === "declined") {
    // Write NOTHING — no descriptor, no `.enc`, no plaintext.
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
    // Empty/whitespace passphrase → nothing written.
    return { outcome: "passphrase-invalid", detail: derived.detail };
  }
  if (derived.outcome === "derive-failed") {
    return { outcome: "unavailable", detail: derived.detail };
  }
  // Persist the non-secret descriptor ONCE, before handing back a writable store.
  const written = writeDescriptor(metaPath, buildDescriptor(salt, DEFAULT_SCRYPT_PARAMS));
  if (!written.ok) {
    return { outcome: "unavailable", detail: written.detail };
  }
  // Eagerly encrypt+write the EMPTY connection set now (not lazily on first save).
  // Reason: without ciphertext, a wrong passphrase on a later reopen of a not-yet-
  // saved store is silently accepted (nothing to authenticate against) and a save
  // then bakes in the wrong key, permanently locking out the correct one. Writing
  // the `.enc` at creation means every reopen has ciphertext → a wrong passphrase
  // fails GCM → `corrupt`, consistent with the intent-contract matrix. Descriptor is
  // written FIRST so a crash can only ever leave the benign descriptor-without-`.enc`
  // state, never a `.enc`-without-descriptor (which would misread as keychain mode).
  const seeded = writeStoreFile(filePath, derived.key, []);
  if (seeded.outcome !== "ok") {
    // Roll back the descriptor so nothing half-committed remains on disk.
    try {
      rmSync(metaPath, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    return { outcome: "unavailable", detail: seeded.detail };
  }
  return {
    outcome: "opened",
    store: buildStore(mode, [], derived.key, filePath, release),
  };
}

/**
 * Load + decrypt an EXISTING store file under `key`. A missing file is a ready
 * empty store (first save creates it). Total: classifies I/O errors, malformed
 * envelopes, wrong keys, and unknown schema versions into typed {@link OpenResult}
 * arms exactly as the keychain path did. Shared by the keychain and passphrase
 * reopen branches.
 */
function loadStoreFromFile(
  mode: RunMode,
  key: Buffer,
  filePath: string,
  release: () => void,
): OpenResult {
  // No file yet → empty store, ready to save.
  if (!existsSync(filePath)) {
    return { outcome: "opened", store: buildStore(mode, [], key, filePath, release) };
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
      return { outcome: "opened", store: buildStore(mode, [], key, filePath, release) };
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
    // A wrong passphrase yields a wrong key → GCM auth-tag fail, INDISTINGUISHABLE
    // from tamper by design. Both surface here as `corrupt`.
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
    store: buildStore(mode, decrypted.value.connections, key, filePath, release),
  };
}

/**
 * Construct the live store over an in-memory record map. When `key`/`filePath` are
 * non-null (persistent mode) mutations flush ciphertext; when null (ephemeral)
 * they stay in memory. `release` is the persistent single-writer lock's release fn
 * (null for ephemeral); `close()` invokes it AT MOST ONCE via a latch, so a double
 * `close()` — or an ephemeral `close()` — is a safe no-op. Not exported — the only
 * way to a store is `openCredentialStore`.
 */
function buildStore(
  mode: RunMode,
  initial: readonly StoredConnection[],
  key: Buffer | null,
  filePath: string | null,
  release: (() => void) | null,
): CredentialStore {
  const records = new Map<string, StoredConnection>();
  for (const rec of initial) records.set(rec.id, rec);

  // Latch the lock release so `close()` runs it once even if called repeatedly. The
  // underlying `release` is itself idempotent — this is belt-and-suspenders.
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    // Best-effort: honor the "close never throws" boundary even against a release
    // seam that throws (the latch above still flips, so this runs at most once).
    try {
      if (release !== null) release();
    } catch {
      /* best-effort: a throwing release must not escape close(). */
    }
  };

  /**
   * Encrypt a PROSPECTIVE record set and write the envelope to disk atomically
   * (persistent only) via {@link writeStoreFile}. Ephemeral (key/filePath null) is
   * a no-op `ok`.
   */
  const flush = (next: Map<string, StoredConnection>): MutationResult => {
    if (key === null || filePath === null) return { outcome: "ok" };
    return writeStoreFile(filePath, key, [...next.values()]);
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
    close,
  };
}
