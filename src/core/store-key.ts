/**
 * quick-studio Core — keychain-backed master-key manager (AR-7, FR-4/5/6).
 *
 * The AES-256-GCM key that encrypts the credential store lives ONLY in the OS
 * keychain (AR-7) — never in the store file, never on disk, never in a log. This
 * module gets-or-creates that 32-byte key by reusing the Story 2.1 keychain
 * wrapper (`keychain.ts`); it does NOT call `@napi-rs/keyring` directly.
 *
 * Contract ({@link loadOrCreateStoreKey} is total — never throws):
 *  - `found` + decodes to exactly 32 bytes  → `loaded`.
 *  - `found` + does NOT decode to 32 bytes  → `key-invalid` (an empty or
 *    wrong-length AES key is never usable; we refuse rather than guess).
 *  - `not-found`                            → generate a 32-byte CSPRNG key,
 *    store it (base64) and return it as `created`.
 *  - `unavailable`                          → propagate unchanged; this is the
 *    designed hook Story 2.3's passphrase fallback keys off. Never a plaintext
 *    fallback, never a throw.
 *
 * The service/account are FIXED non-empty constants (not caller-supplied), so the
 * wrapper's invalid-argument-vs-unavailable ambiguity never arises here. Key
 * bytes are never logged.
 */

import { randomBytes } from "node:crypto";
import { KEY_LENGTH_BYTES } from "./crypto.ts";
import {
  getSecret as realGetSecret,
  setSecret as realSetSecret,
  deleteSecret as realDeleteSecret,
  type KeychainGetResult,
  type KeychainSetResult,
  type KeychainDeleteResult,
} from "./keychain.ts";

/** Durable keychain identity for the credential-store master key. */
export const STORE_KEY_SERVICE = "quick-studio";
/** Durable keychain account under {@link STORE_KEY_SERVICE}. */
export const STORE_KEY_ACCOUNT = "credential-store-key";

/**
 * Injectable keychain surface so `key-invalid`/`unavailable` are unit-testable
 * without a live keychain. Defaults to the real `keychain.ts` functions.
 */
export type StoreKeyDeps = {
  readonly getSecret: (service: string, account: string) => KeychainGetResult;
  readonly setSecret: (
    service: string,
    account: string,
    value: string,
  ) => KeychainSetResult;
  readonly deleteSecret: (
    service: string,
    account: string,
  ) => KeychainDeleteResult;
};

/** The real keychain wrapper, used when no deps are injected. */
export const DEFAULT_STORE_KEY_DEPS: StoreKeyDeps = {
  getSecret: realGetSecret,
  setSecret: realSetSecret,
  deleteSecret: realDeleteSecret,
};

/**
 * Outcome of {@link loadOrCreateStoreKey}. `loaded`/`created` carry the raw
 * 32-byte key Buffer (Ring-1 only — never serialized). The failure arms are the
 * typed hooks the store surfaces to its caller.
 */
export type StoreKeyResult =
  | { readonly outcome: "loaded"; readonly key: Buffer }
  | { readonly outcome: "created"; readonly key: Buffer }
  | { readonly outcome: "key-invalid"; readonly detail: string }
  | { readonly outcome: "unavailable"; readonly detail: string };

/**
 * Decode a base64 keychain value to a Buffer and confirm it is exactly the AES-256
 * key length. Pure. Returns `null` when the value does not decode to 32 bytes.
 */
function decodeKey(value: string): Buffer | null {
  const key = Buffer.from(value, "base64");
  return key.length === KEY_LENGTH_BYTES ? key : null;
}

/**
 * Get-or-create the 32-byte credential-store master key from the OS keychain.
 * Total: every branch returns a typed {@link StoreKeyResult}; never throws and
 * never logs key bytes. `deps` defaults to the real keychain wrapper.
 */
export function loadOrCreateStoreKey(
  deps: StoreKeyDeps = DEFAULT_STORE_KEY_DEPS,
): StoreKeyResult {
  const got = deps.getSecret(STORE_KEY_SERVICE, STORE_KEY_ACCOUNT);

  if (got.outcome === "unavailable") {
    return { outcome: "unavailable", detail: got.detail };
  }

  if (got.outcome === "found") {
    const key = decodeKey(got.value);
    if (key === null) {
      return {
        outcome: "key-invalid",
        detail: `keychain key does not decode to ${KEY_LENGTH_BYTES} bytes`,
      };
    }
    return { outcome: "loaded", key };
  }

  // not-found → generate a fresh CSPRNG key and persist it (base64).
  const key = randomBytes(KEY_LENGTH_BYTES);
  const set = deps.setSecret(
    STORE_KEY_SERVICE,
    STORE_KEY_ACCOUNT,
    key.toString("base64"),
  );
  if (set.outcome === "unavailable") {
    return { outcome: "unavailable", detail: set.detail };
  }
  return { outcome: "created", key };
}
