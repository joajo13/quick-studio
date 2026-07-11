/**
 * Covers the provider-key-store I/O matrix (Story 5.1): persistent round-trip and
 * relaunch survival, raw file carries no key material, EPHEMERAL writes nothing,
 * upsert-by-kind (one record per provider), idempotent remove, empty list, and the
 * typed failure arms (key-invalid, corrupt, unknown schema) — mirroring the Epic 2
 * credential-store tests. Failure/behaviour arms use an INJECTED fixed key so they
 * are deterministic without a live keychain.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { KEY_LENGTH_BYTES, encryptJson, type CryptoEnvelope } from "./crypto.ts";
import {
  openProviderKeyStore,
  PROVIDER_STORE_FILE_NAME,
  PROVIDER_STORE_META_FILE_NAME,
  PROVIDER_STORE_SCHEMA_VERSION,
} from "./provider-key-store.ts";
import type { StoreKeyResult } from "./store-key.ts";
import type { PassphraseProvider } from "./passphrase-provider.ts";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = join(tmpdir(), `qs-provider-store-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

const FIXED_KEY = randomBytes(KEY_LENGTH_BYTES);
const fixedKeyProvider = (): StoreKeyResult => ({ outcome: "loaded", key: FIXED_KEY });

describe("provider-key-store — persistent behaviour with an injected fixed key", () => {
  test("relaunch survival: save then reopen fresh instance → decrypted round-trip", () => {
    const dir = makeTempDir();
    const open1 = openProviderKeyStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open1.outcome).toBe("opened");
    if (open1.outcome !== "opened") return;

    const rec = { provider: "anthropic", apiKey: "sk-ant-secret-1234" } as const;
    expect(open1.store.saveKey(rec).outcome).toBe("ok");

    const open2 = openProviderKeyStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open2.outcome).toBe("opened");
    if (open2.outcome !== "opened") return;
    expect(open2.store.getKey("anthropic")).toEqual(rec);
    expect(open2.store.listKeys()).toHaveLength(1);
  });

  test("raw file contains no raw key material and IS a valid envelope", () => {
    const dir = makeTempDir();
    const open = openProviderKeyStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    const apiKey = `sk-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    open.store.saveKey({ provider: "openai", apiKey });

    const bytes = readFileSync(join(dir, PROVIDER_STORE_FILE_NAME));
    const text = bytes.toString("utf8");
    expect(text).not.toContain(apiKey);
    expect(text).not.toContain(FIXED_KEY.toString("base64"));
    expect(bytes.includes(FIXED_KEY)).toBe(false);
    const env = JSON.parse(text) as CryptoEnvelope;
    expect(Object.keys(env).sort()).toEqual(["authTag", "ciphertext", "iv", "schemaVersion"].sort());
  });

  test("upsert by kind: a second set for the same provider overwrites (one record)", () => {
    const dir = makeTempDir();
    const open = openProviderKeyStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    open.store.saveKey({ provider: "google", apiKey: "first-key" });
    open.store.saveKey({ provider: "google", apiKey: "second-key" });
    expect(open.store.listKeys()).toHaveLength(1);
    expect(open.store.getKey("google")?.apiKey).toBe("second-key");
  });

  test("idempotent remove: first removes, second is a no-op success", () => {
    const dir = makeTempDir();
    const open = openProviderKeyStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    open.store.saveKey({ provider: "anthropic", apiKey: "k" });
    expect(open.store.deleteKey("anthropic").outcome).toBe("ok");
    expect(open.store.deleteKey("anthropic").outcome).toBe("ok"); // no-op
    expect(open.store.listKeys()).toEqual([]);
  });

  test("distinct providers coexist (identity is the kind)", () => {
    const dir = makeTempDir();
    const open = openProviderKeyStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    open.store.saveKey({ provider: "anthropic", apiKey: "a" });
    open.store.saveKey({ provider: "openai", apiKey: "b" });
    expect(open.store.listKeys()).toHaveLength(2);
  });
});

describe("provider-key-store — ephemeral writes nothing to disk", () => {
  test("a set in ephemeral mode holds in memory and writes no file under the dir", () => {
    const dir = makeTempDir();
    const open = openProviderKeyStore({ mode: "ephemeral", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("opened");
    if (open.outcome !== "opened") return;
    expect(open.store.mode).toBe("ephemeral");
    expect(open.store.saveKey({ provider: "anthropic", apiKey: "sk-mem" }).outcome).toBe("ok");
    expect(open.store.getKey("anthropic")?.apiKey).toBe("sk-mem");
    // HARD no-write guarantee: the app dir is untouched.
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, PROVIDER_STORE_FILE_NAME))).toBe(false);
  });
});

describe("provider-key-store — empty list and typed failure arms", () => {
  test("a fresh store lists nothing", () => {
    const dir = makeTempDir();
    const open = openProviderKeyStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(open.store.listKeys()).toEqual([]);
  });

  test("key-invalid from the key provider surfaces as a typed result, not a throw", () => {
    const dir = makeTempDir();
    const open = openProviderKeyStore({
      mode: "persistent",
      dir,
      loadStoreKey: (): StoreKeyResult => ({ outcome: "key-invalid", detail: "bad" }),
    });
    // No `.enc` yet → first-run keychain path → key-invalid arm.
    expect(open.outcome).toBe("key-invalid");
  });

  test("a tampered/wrong-key file → corrupt (not a throw)", () => {
    const dir = makeTempDir();
    // Write a valid envelope under a DIFFERENT key so GCM auth fails on reopen.
    const otherKey = randomBytes(KEY_LENGTH_BYTES);
    const enc = encryptJson(otherKey, { schemaVersion: PROVIDER_STORE_SCHEMA_VERSION, keys: [] });
    if (enc.outcome !== "encrypted") throw new Error("setup failed");
    writeFileSync(join(dir, PROVIDER_STORE_FILE_NAME), JSON.stringify(enc.envelope));
    const open = openProviderKeyStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("corrupt");
  });

  test("a well-formed envelope with an unknown payload schema → schema-unknown", () => {
    const dir = makeTempDir();
    const enc = encryptJson(FIXED_KEY, { schemaVersion: 999, keys: [] });
    if (enc.outcome !== "encrypted") throw new Error("setup failed");
    writeFileSync(join(dir, PROVIDER_STORE_FILE_NAME), JSON.stringify(enc.envelope));
    const open = openProviderKeyStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("schema-unknown");
  });
});

describe("provider-key-store — passphrase fallback (keychain unavailable)", () => {
  // Force the keychain-less path so the store derives its key from a passphrase.
  const noKeychain = (): StoreKeyResult => ({ outcome: "unavailable", detail: "no keychain" });
  const providePass =
    (passphrase: string): PassphraseProvider =>
    () => ({ outcome: "provided", passphrase });
  const declinePass: PassphraseProvider = () => ({ outcome: "declined" });

  test("first run seeds a descriptor + empty .enc, then round-trips on reopen with the same passphrase", () => {
    const dir = makeTempDir();
    const open1 = openProviderKeyStore({
      mode: "persistent",
      dir,
      loadStoreKey: noKeychain,
      passphraseProvider: providePass("correct horse battery"),
    });
    expect(open1.outcome).toBe("opened");
    if (open1.outcome !== "opened") return;
    // Descriptor (present ⇒ passphrase mode) and the eagerly-seeded ciphertext both exist.
    expect(existsSync(join(dir, PROVIDER_STORE_META_FILE_NAME))).toBe(true);
    expect(existsSync(join(dir, PROVIDER_STORE_FILE_NAME))).toBe(true);
    expect(open1.store.saveKey({ provider: "anthropic", apiKey: "sk-pass-1234" }).outcome).toBe("ok");

    const open2 = openProviderKeyStore({
      mode: "persistent",
      dir,
      loadStoreKey: noKeychain,
      passphraseProvider: providePass("correct horse battery"),
    });
    expect(open2.outcome).toBe("opened");
    if (open2.outcome !== "opened") return;
    expect(open2.store.getKey("anthropic")?.apiKey).toBe("sk-pass-1234");
  });

  test("reopen with the WRONG passphrase fails GCM → corrupt (never silently accepted)", () => {
    const dir = makeTempDir();
    const open1 = openProviderKeyStore({
      mode: "persistent",
      dir,
      loadStoreKey: noKeychain,
      passphraseProvider: providePass("right-passphrase"),
    });
    if (open1.outcome !== "opened") throw new Error("expected opened");
    open1.store.saveKey({ provider: "openai", apiKey: "sk-secret" });

    const open2 = openProviderKeyStore({
      mode: "persistent",
      dir,
      loadStoreKey: noKeychain,
      passphraseProvider: providePass("wrong-passphrase"),
    });
    expect(open2.outcome).toBe("corrupt");
  });

  test("a declined passphrase on first run → passphrase-declined and writes nothing", () => {
    const dir = makeTempDir();
    const open = openProviderKeyStore({
      mode: "persistent",
      dir,
      loadStoreKey: noKeychain,
      passphraseProvider: declinePass,
    });
    expect(open.outcome).toBe("passphrase-declined");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("descriptor present but .enc removed → corrupt (no empty-store re-key under an unverified passphrase)", () => {
    const dir = makeTempDir();
    const open1 = openProviderKeyStore({
      mode: "persistent",
      dir,
      loadStoreKey: noKeychain,
      passphraseProvider: providePass("pw"),
    });
    if (open1.outcome !== "opened") throw new Error("expected opened");
    // Remove the ciphertext out from under the still-present descriptor.
    rmSync(join(dir, PROVIDER_STORE_FILE_NAME), { force: true });

    const open2 = openProviderKeyStore({
      mode: "persistent",
      dir,
      loadStoreKey: noKeychain,
      passphraseProvider: providePass("pw"),
    });
    expect(open2.outcome).toBe("corrupt");
  });
});
