/**
 * quick-studio Core — passphrase-derived AES key via scrypt (FR-5, AR-7, AD-5, UJ-2).
 *
 * Story 2.3's safety net for keychain-less machines: when no OS keychain can hold
 * the credential-store master key, derive that 32-byte key from a developer-supplied
 * passphrase with scrypt (`node:crypto`, NO new dependency). A per-store 16-byte
 * CSPRNG salt plus the scrypt cost params are the ONLY things persisted (as a
 * non-secret descriptor by {@link openCredentialStore}); the passphrase and the
 * derived key are never written to disk and never logged.
 *
 * Contract ({@link derivePassphraseKey} is total — never throws):
 *  - empty / whitespace-only passphrase → `passphrase-invalid` (a blank secret is
 *    never a usable key; we refuse rather than derive a guessable one).
 *  - scrypt throws (impossible params, `maxmem` exceeded) → `derive-failed`.
 *  - otherwise → `derived` with the raw `keylen`-byte key Buffer (Ring-1 only).
 *
 * The passphrase and derived key are NEVER placed in a `detail` string.
 */

import { randomBytes, scryptSync } from "node:crypto";
import { KEY_LENGTH_BYTES } from "./crypto.ts";

/** scrypt cost parameters (`N` cost, `r` block size, `p` parallelism) + output length. */
export type ScryptParams = {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
};

/**
 * Default scrypt work factor. `N = 2**15, r = 8, p = 1`. Node's `maxmem` guard
 * checks `128 * r * (N + p + 2)`, NOT the often-quoted `128 * N * r`: here that is
 * `128 * 8 * (32768 + 1 + 2) ≈ 32.0 MB`, which is JUST over Node's 32 MB default
 * `maxmem` (33,554,432 B) and would THROW `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` — so
 * we raise it via {@link SCRYPT_MAXMEM}. `keylen` is the AES-256 key length.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 2 ** 15,
  r: 8,
  p: 1,
  keylen: KEY_LENGTH_BYTES,
};

/** Per-store salt length in bytes (128-bit CSPRNG salt). */
export const SALT_LENGTH_BYTES = 16;

/**
 * Upper bound on passphrase length. `scryptSync` is synchronous and hashes the
 * full passphrase; a pathological multi-MB input would block the event loop, so we
 * refuse anything longer as `passphrase-invalid`. 1024 chars is far above any real
 * passphrase.
 */
export const MAX_PASSPHRASE_LENGTH = 1024;

/**
 * `maxmem` for scrypt: 64 MB, raised above Node's 32 MB default. Node's guard is
 * `128 * r * (N + p + 2)`, so {@link DEFAULT_SCRYPT_PARAMS} needs ≈ 32.0 MB —
 * marginally over the 32 MB default. 64 MB leaves comfortable headroom so a future
 * param bump does not silently trip `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Outcome of {@link derivePassphraseKey}. Failure arms carry a secret-free `detail`. */
export type DeriveResult =
  | { readonly outcome: "derived"; readonly key: Buffer }
  | { readonly outcome: "passphrase-invalid"; readonly detail: string }
  | { readonly outcome: "derive-failed"; readonly detail: string };

/** Generate a fresh 16-byte CSPRNG salt. The salt is non-secret and persisted. */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH_BYTES);
}

/**
 * Derive an AES key from `passphrase` and `salt` with scrypt. Total: an empty /
 * whitespace-only passphrase is `passphrase-invalid` and any scrypt throw is
 * `derive-failed` — never a thrown exception. Deterministic: identical
 * `passphrase` + `salt` + `params` always yield the identical key, so a store can
 * re-derive its key on reopen from the persisted salt/params. The passphrase and
 * the derived key are never logged and never embedded in `detail`.
 */
export function derivePassphraseKey(
  passphrase: string,
  salt: Buffer,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): DeriveResult {
  if (passphrase.trim().length === 0) {
    return {
      outcome: "passphrase-invalid",
      detail: "passphrase is empty or whitespace-only",
    };
  }

  if (passphrase.length > MAX_PASSPHRASE_LENGTH) {
    return {
      outcome: "passphrase-invalid",
      detail: "passphrase too long",
    };
  }

  try {
    const key = scryptSync(passphrase, salt, params.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return { outcome: "derived", key };
  } catch (err) {
    // scrypt param errors describe N/r/p/maxmem, never the passphrase — but keep
    // the message verbatim only if it is an Error; otherwise use a fixed string.
    return {
      outcome: "derive-failed",
      detail: err instanceof Error ? err.message : "scrypt derivation failed",
    };
  }
}
