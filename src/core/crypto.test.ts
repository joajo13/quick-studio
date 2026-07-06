/**
 * Unit-tests the crypto matrix rows: round-trip, tamper→corrupt, wrong-key→corrupt,
 * and that the envelope JSON carries NO key and NO plaintext (the at-rest guarantee).
 */

import { describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  CRYPTO_SCHEMA_VERSION,
  decryptJson,
  encryptJson,
  KEY_LENGTH_BYTES,
  type CryptoEnvelope,
} from "./crypto.ts";

const key = () => randomBytes(KEY_LENGTH_BYTES);

function encOrThrow(k: Buffer, value: unknown): CryptoEnvelope {
  const r = encryptJson(k, value);
  if (r.outcome !== "encrypted") throw new Error("expected encrypted");
  return r.envelope;
}

describe("encryptJson / decryptJson — AES-256-GCM round-trip", () => {
  test("round-trips a JSON value", () => {
    const k = key();
    const value = { id: "c1", name: "prod db", url: "postgres://u:p@h/db" };
    const envelope = encOrThrow(k, value);

    const dec = decryptJson<typeof value>(k, envelope);
    expect(dec.outcome).toBe("decrypted");
    if (dec.outcome === "decrypted") expect(dec.value).toEqual(value);
  });

  test("each encrypt uses a fresh IV (no nonce reuse)", () => {
    const k = key();
    const a = encOrThrow(k, { x: 1 });
    const b = encOrThrow(k, { x: 1 });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("envelope carries the expected schema version and base64 fields", () => {
    const envelope = encOrThrow(key(), { x: 1 });
    expect(envelope.schemaVersion).toBe(CRYPTO_SCHEMA_VERSION);
    expect(Buffer.from(envelope.iv, "base64").length).toBe(12);
    expect(Buffer.from(envelope.authTag, "base64").length).toBe(16);
  });
});

describe("envelope excludes the key and plaintext", () => {
  test("serialized envelope contains none of the distinctive field values or key bytes", () => {
    const k = key();
    // Distinctive, collision-proof field values: if any leaks verbatim into the
    // envelope JSON, the assertion catches it (no hand-picked substrings).
    const id = randomUUID();
    const name = `conn-${randomUUID()}`;
    const url = `postgres://admin:${randomUUID()}@db.internal/${randomUUID()}`;
    const envelope = encOrThrow(k, { id, name, url });
    const json = JSON.stringify(envelope);

    // No plaintext field material of ANY saved field.
    for (const value of [id, name, url]) {
      expect(json).not.toContain(value);
    }
    // No key material, in any common encoding.
    expect(json).not.toContain(k.toString("base64"));
    expect(json).not.toContain(k.toString("hex"));
    // Envelope has exactly the intended keys — no stray "key" field.
    expect(Object.keys(envelope).sort()).toEqual(
      ["authTag", "ciphertext", "iv", "schemaVersion"].sort(),
    );
  });
});

describe("encryptJson — non-serializable value → serialize-failed (never throws)", () => {
  test("a BigInt value → serialize-failed, not a throw", () => {
    const r = encryptJson(key(), { n: 1n });
    expect(r.outcome).toBe("serialize-failed");
  });

  test("a circular reference → serialize-failed, not a throw", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = encryptJson(key(), circular);
    expect(r.outcome).toBe("serialize-failed");
  });

  test("a bare undefined value → serialize-failed, not a throw", () => {
    const r = encryptJson(key(), undefined);
    expect(r.outcome).toBe("serialize-failed");
  });
});

describe("decryptJson — tamper / wrong-key detection", () => {
  test("wrong key → corrupt (auth-tag failure)", () => {
    const envelope = encOrThrow(key(), { x: 1 });
    const dec = decryptJson(key(), envelope); // different key
    expect(dec.outcome).toBe("corrupt");
  });

  test("tampered ciphertext → corrupt", () => {
    const k = key();
    const envelope = encOrThrow(k, { x: 1, secret: "abc" });
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 0xff; // flip a bit
    const tampered: CryptoEnvelope = { ...envelope, ciphertext: bytes.toString("base64") };
    expect(decryptJson(k, tampered).outcome).toBe("corrupt");
  });

  test("tampered auth tag → corrupt", () => {
    const k = key();
    const envelope = encOrThrow(k, { x: 1 });
    const tag = Buffer.from(envelope.authTag, "base64");
    tag[0] = tag[0]! ^ 0xff;
    const tampered: CryptoEnvelope = { ...envelope, authTag: tag.toString("base64") };
    expect(decryptJson(k, tampered).outcome).toBe("corrupt");
  });

  test("malformed iv length → corrupt, not a throw", () => {
    const k = key();
    const envelope = encOrThrow(k, { x: 1 });
    const bad: CryptoEnvelope = { ...envelope, iv: Buffer.alloc(4).toString("base64") };
    expect(decryptJson(k, bad).outcome).toBe("corrupt");
  });
});

describe("key validation", () => {
  test("encrypt with a non-32-byte key → key-invalid", () => {
    expect(encryptJson(randomBytes(16), { x: 1 }).outcome).toBe("key-invalid");
  });

  test("decrypt with a non-32-byte key → key-invalid", () => {
    const envelope = encOrThrow(key(), { x: 1 });
    expect(decryptJson(randomBytes(16), envelope).outcome).toBe("key-invalid");
  });
});
