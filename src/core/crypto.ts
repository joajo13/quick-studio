/**
 * quick-studio Core — AES-256-GCM at-rest cipher (FR-4/5/6, AR-7).
 *
 * This is the crypto primitive behind Story 2.2's encrypted credential store:
 * it turns an arbitrary JSON-serializable value into an authenticated ciphertext
 * envelope and back. AES-256-GCM gives both confidentiality and integrity, so a
 * tampered file or a wrong key is DETECTED (auth-tag verification) rather than
 * silently producing garbage.
 *
 * Invariants (the store relies on these):
 *  - The 32-byte key is NEVER placed in the envelope and never logged. The
 *    envelope carries only `{ schemaVersion, iv, authTag, ciphertext }`.
 *  - A fresh CSPRNG 12-byte IV is generated per `encryptJson` call (GCM nonce
 *    reuse under one key is catastrophic — a new IV every time avoids it).
 *  - `decryptJson` is TOTAL: it verifies the auth tag and returns a typed
 *    `corrupt` result instead of throwing on tamper / wrong-key / malformed
 *    input. Ring-1 boundary code never surfaces an exception for these expected
 *    conditions.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";

/** Envelope schema version. Bump when the envelope shape or algorithm changes. */
export const CRYPTO_SCHEMA_VERSION = 1;

/** AES-256-GCM. */
const ALGORITHM: CipherGCMTypes = "aes-256-gcm";

/** AES-256 key length in bytes. */
export const KEY_LENGTH_BYTES = 32;

/** GCM nonce (IV) length in bytes — 96 bits is the AES-GCM standard. */
const IV_LENGTH_BYTES = 12;

/** GCM authentication tag length in bytes. */
const AUTH_TAG_LENGTH_BYTES = 16;

/**
 * The at-rest ciphertext envelope. All binary fields are base64. The encryption
 * key is intentionally absent — it lives only in the OS keychain (AR-7).
 */
export type CryptoEnvelope = {
  readonly schemaVersion: number;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
};

/**
 * Result of {@link encryptJson}: the envelope, a bad-key rejection, or a
 * `serialize-failed` verdict when `value` is not JSON-serializable (circular
 * reference, BigInt, or a bare `undefined`).
 */
export type EncryptResult =
  | { readonly outcome: "encrypted"; readonly envelope: CryptoEnvelope }
  | { readonly outcome: "key-invalid"; readonly detail: string }
  | { readonly outcome: "serialize-failed"; readonly detail: string };

/**
 * Result of {@link decryptJson}: the recovered value, a bad-key rejection, or a
 * `corrupt` verdict (tamper / wrong key / malformed envelope — auth-tag failure).
 */
export type DecryptResult<T> =
  | { readonly outcome: "decrypted"; readonly value: T }
  | { readonly outcome: "key-invalid"; readonly detail: string }
  | { readonly outcome: "corrupt"; readonly detail: string };

/** True when `key` is a Buffer of exactly the AES-256 key length. Pure. */
export function isValidKey(key: Buffer): boolean {
  return key.length === KEY_LENGTH_BYTES;
}

/**
 * Encrypt `value` (any JSON-serializable data) under `key` (32 bytes). Returns an
 * envelope with a fresh random IV and the GCM auth tag. Total for a valid key;
 * an out-of-spec key length is returned as `key-invalid` and a non-serializable
 * `value` (circular ref / BigInt / bare `undefined`) as `serialize-failed` —
 * never thrown. The key is never included in the result and never logged.
 */
export function encryptJson(key: Buffer, value: unknown): EncryptResult {
  if (!isValidKey(key)) {
    return {
      outcome: "key-invalid",
      detail: `expected a ${KEY_LENGTH_BYTES}-byte key, got ${key.length}`,
    };
  }

  // JSON.stringify can throw (circular ref, BigInt) or return `undefined`
  // (value === undefined); both would otherwise break the total-for-valid-key
  // contract at `Buffer.from(undefined)`.
  let serialized: string;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      return {
        outcome: "serialize-failed",
        detail: "value is not JSON-serializable (serialized to undefined)",
      };
    }
    serialized = json;
  } catch (err) {
    return {
      outcome: "serialize-failed",
      detail: err instanceof Error ? err.message : "value is not JSON-serializable",
    };
  }

  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  const plaintext = Buffer.from(serialized, "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    outcome: "encrypted",
    envelope: {
      schemaVersion: CRYPTO_SCHEMA_VERSION,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
  };
}

/**
 * Decrypt and JSON-parse an {@link CryptoEnvelope} under `key`. Verifies the GCM
 * auth tag BEFORE parsing, so any tamper, wrong key, or malformed field surfaces
 * as a typed `corrupt` result — never a thrown exception, never a silent partial
 * read. `key-invalid` is returned for an out-of-spec key length.
 */
export function decryptJson<T>(
  key: Buffer,
  envelope: CryptoEnvelope,
): DecryptResult<T> {
  if (!isValidKey(key)) {
    return {
      outcome: "key-invalid",
      detail: `expected a ${KEY_LENGTH_BYTES}-byte key, got ${key.length}`,
    };
  }

  try {
    const iv = Buffer.from(envelope.iv, "base64");
    const authTag = Buffer.from(envelope.authTag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");

    if (iv.length !== IV_LENGTH_BYTES) {
      return { outcome: "corrupt", detail: "iv length mismatch" };
    }
    if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
      return { outcome: "corrupt", detail: "auth tag length mismatch" };
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAuthTag(authTag);
    // `final()` throws if the auth tag does not verify — the tamper/wrong-key hook.
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const value = JSON.parse(plaintext.toString("utf8")) as T;
    return { outcome: "decrypted", value };
  } catch (err) {
    return {
      outcome: "corrupt",
      detail: err instanceof Error ? err.message : "decrypt failed",
    };
  }
}
