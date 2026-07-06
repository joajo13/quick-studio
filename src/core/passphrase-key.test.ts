/**
 * Covers the scrypt passphrase-key derivation (FR-5, AR-7, AD-5): determinism,
 * salt sensitivity, empty/whitespace rejection, 32-byte output, secret-free
 * `detail`, and the `derive-failed` path on impossible params. Pure — no I/O,
 * no keychain, nothing to clean up.
 */

import { describe, expect, test } from "bun:test";
import { KEY_LENGTH_BYTES } from "./crypto.ts";
import {
  DEFAULT_SCRYPT_PARAMS,
  MAX_PASSPHRASE_LENGTH,
  SALT_LENGTH_BYTES,
  derivePassphraseKey,
  generateSalt,
} from "./passphrase-key.ts";

describe("passphrase-key — derivePassphraseKey", () => {
  test("deterministic: same passphrase + salt + params → identical key", () => {
    const salt = generateSalt();
    const a = derivePassphraseKey("correct horse battery staple", salt);
    const b = derivePassphraseKey("correct horse battery staple", salt);
    expect(a.outcome).toBe("derived");
    expect(b.outcome).toBe("derived");
    if (a.outcome !== "derived" || b.outcome !== "derived") return;
    expect(a.key.equals(b.key)).toBe(true);
  });

  test("different salt → different key for the same passphrase", () => {
    const a = derivePassphraseKey("same-passphrase", generateSalt());
    const b = derivePassphraseKey("same-passphrase", generateSalt());
    if (a.outcome !== "derived" || b.outcome !== "derived") throw new Error("expected derived");
    expect(a.key.equals(b.key)).toBe(false);
  });

  test("derived key is exactly the AES-256 key length (32 bytes)", () => {
    const r = derivePassphraseKey("a-passphrase", generateSalt());
    if (r.outcome !== "derived") throw new Error("expected derived");
    expect(r.key.length).toBe(KEY_LENGTH_BYTES);
  });

  test("empty passphrase → passphrase-invalid", () => {
    const r = derivePassphraseKey("", generateSalt());
    expect(r.outcome).toBe("passphrase-invalid");
  });

  test("whitespace-only passphrase → passphrase-invalid", () => {
    for (const ws of ["   ", "\t", "\n", " \t\n "]) {
      const r = derivePassphraseKey(ws, generateSalt());
      expect(r.outcome).toBe("passphrase-invalid");
    }
  });

  test("passphrase longer than MAX_PASSPHRASE_LENGTH → passphrase-invalid (P5)", () => {
    const tooLong = "a".repeat(MAX_PASSPHRASE_LENGTH + 1);
    const r = derivePassphraseKey(tooLong, generateSalt());
    expect(r.outcome).toBe("passphrase-invalid");
    if (r.outcome !== "passphrase-invalid") return;
    expect(r.detail).toBe("passphrase too long");
    // A passphrase at exactly the bound is still accepted.
    const ok = derivePassphraseKey("a".repeat(MAX_PASSPHRASE_LENGTH), generateSalt());
    expect(ok.outcome).toBe("derived");
  });

  test("DEFAULT_SCRYPT_PARAMS derives successfully (maxmem headroom regression, P6)", () => {
    // Guards the scrypt maxmem boundary: DEFAULT params sit just over Node's 32 MB
    // default, so SCRYPT_MAXMEM must give headroom. A future param bump that breaks
    // this fails here instead of silently at runtime.
    const r = derivePassphraseKey("a-passphrase", generateSalt(), DEFAULT_SCRYPT_PARAMS);
    expect(r.outcome).toBe("derived");
    if (r.outcome !== "derived") return;
    expect(r.key.length).toBe(KEY_LENGTH_BYTES);
  });

  test("derive-failed on impossible params, and detail never leaks the passphrase", () => {
    const passphrase = "super-secret-passphrase-value";
    // N far too large: 128 * N * r blows past maxmem → scrypt throws synchronously.
    const r = derivePassphraseKey(passphrase, generateSalt(), {
      ...DEFAULT_SCRYPT_PARAMS,
      N: 2 ** 30,
    });
    expect(r.outcome).toBe("derive-failed");
    if (r.outcome !== "derive-failed") return;
    expect(r.detail.length).toBeGreaterThan(0);
    expect(r.detail).not.toContain(passphrase);
  });
});

describe("passphrase-key — generateSalt", () => {
  test("returns a 16-byte buffer", () => {
    expect(generateSalt().length).toBe(SALT_LENGTH_BYTES);
  });

  test("two calls produce different salts (CSPRNG)", () => {
    expect(generateSalt().equals(generateSalt())).toBe(false);
  });
});
