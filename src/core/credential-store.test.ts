/**
 * Covers the credential-store I/O matrix (UJ-2, FR-4/5/6, AR-7, AR-9):
 * relaunch survival, raw file has no plaintext/no key, ephemeral writes nothing,
 * delete, keychain-unavailable, key-invalid, corrupt file, unknown schema, and
 * first-run empty.
 *
 * Failure arms use INJECTED deps (a fixed key / stubbed key provider) so they are
 * deterministic without a live keychain. One happy-path test exercises the REAL
 * Linux keychain via a run-unique account and self-cleans; on a keychain-less box
 * it degrades to the typed `unavailable` outcome (green). All temp dirs and the
 * keychain entry are removed unconditionally in `afterAll`.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { KEY_LENGTH_BYTES, encryptJson, type CryptoEnvelope } from "./crypto.ts";
import {
  openCredentialStore,
  STORE_FILE_NAME,
  STORE_SCHEMA_VERSION,
} from "./credential-store.ts";
import {
  DEFAULT_STORE_KEY_DEPS,
  loadOrCreateStoreKey,
  STORE_KEY_SERVICE,
  type StoreKeyDeps,
  type StoreKeyResult,
} from "./store-key.ts";
import { deleteSecret, type KeychainGetResult } from "./keychain.ts";

// Track temp dirs so every run self-cleans.
const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = join(tmpdir(), `qs-store-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

// A deterministic fixed key provider for the failure/behaviour arms.
const FIXED_KEY = randomBytes(KEY_LENGTH_BYTES);
const fixedKeyProvider = (): StoreKeyResult => ({ outcome: "loaded", key: FIXED_KEY });

const rec = (id: string, name: string, url: string) => ({ id, name, url });

describe("credential-store — persistent behaviour with an injected fixed key", () => {
  test("relaunch survival: save, reopen fresh instance over same dir/key → decrypted round-trip", () => {
    const dir = makeTempDir();
    const open1 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open1.outcome).toBe("opened");
    if (open1.outcome !== "opened") return;

    const conn = rec("c1", "prod", "postgres://admin:s3cr3t@db/prod");
    expect(open1.store.saveConnection(conn).outcome).toBe("ok");

    // Fresh instance = simulated relaunch.
    const open2 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open2.outcome).toBe("opened");
    if (open2.outcome !== "opened") return;
    expect(open2.store.getConnection("c1")).toEqual(conn);
    expect(open2.store.listConnections()).toHaveLength(1);
  });

  test("raw file contains none of the distinctive field values and no key material", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    // Distinctive, collision-proof values: if ANY field leaks verbatim to disk
    // the assertion catches it — not a few hand-picked substrings.
    const id = crypto.randomUUID();
    const name = `conn-${crypto.randomUUID()}`;
    const url = `mysql://root:${crypto.randomUUID()}@h/${crypto.randomUUID()}`;
    open.store.saveConnection(rec(id, name, url));

    const bytes = readFileSync(join(dir, STORE_FILE_NAME));
    const text = bytes.toString("utf8");
    // None of the actual field values written may appear at rest.
    for (const value of [id, name, url]) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain(FIXED_KEY.toString("base64"));
    expect(text).not.toContain(FIXED_KEY.toString("hex"));
    // The raw key bytes must not appear anywhere in the file either.
    expect(bytes.includes(FIXED_KEY)).toBe(false);
    // It IS a valid envelope with the expected fields.
    const env = JSON.parse(text) as CryptoEnvelope;
    expect(Object.keys(env).sort()).toEqual(["authTag", "ciphertext", "iv", "schemaVersion"].sort());
  });

  test("atomic write leaves no .tmp residue and round-trips normally (P1)", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(open.store.saveConnection(rec("c1", "a", "postgres://x@h/a")).outcome).toBe("ok");
    expect(open.store.saveConnection(rec("c2", "b", "postgres://x@h/b")).outcome).toBe("ok");

    // The store file exists; NO sibling temp file is left behind.
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(true);
    const residue = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(residue).toEqual([]);

    // And a fresh instance round-trips both records (old file never truncated).
    const reopen = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (reopen.outcome !== "opened") throw new Error("expected opened");
    expect(reopen.store.listConnections()).toHaveLength(2);
  });

  test("forced write failure leaves memory == disk (no divergence) (P5)", () => {
    // Point the store at a non-existent subdir so the temp write fails (ENOENT).
    const dir = join(makeTempDir(), "missing-subdir");
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");

    const result = open.store.saveConnection(rec("c1", "a", "postgres://x@h/a"));
    expect(result.outcome).toBe("write-failed");
    // The in-memory map must NOT retain the change — matches the (absent) disk state.
    expect(open.store.getConnection("c1")).toBeUndefined();
    expect(open.store.listConnections()).toHaveLength(0);
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });

  test("getConnection/listConnections return copies, not live internal records (P9)", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    open.store.saveConnection(rec("c1", "orig", "postgres://x@h/a"));

    const got = open.store.getConnection("c1");
    if (got === undefined) throw new Error("expected record");
    (got as { name: string }).name = "mutated";
    // The internal record is unaffected by the caller's mutation.
    expect(open.store.getConnection("c1")?.name).toBe("orig");
  });

  test("delete: record and credential gone after reopen", () => {
    const dir = makeTempDir();
    const o1 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    o1.store.saveConnection(rec("c1", "a", "postgres://x@h/a"));
    o1.store.saveConnection(rec("c2", "b", "postgres://x@h/b"));
    expect(o1.store.deleteConnection("c1").outcome).toBe("ok");

    const o2 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (o2.outcome !== "opened") throw new Error("expected opened");
    expect(o2.store.getConnection("c1")).toBeUndefined();
    expect(o2.store.getConnection("c2")).toEqual(rec("c2", "b", "postgres://x@h/b"));
  });

  test("committed store file is owner-only (0o600) on POSIX", () => {
    if (process.platform === "win32") return; // POSIX perms are advisory on Windows
    const dir = makeTempDir();
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    open.store.saveConnection(rec("c1", "a", "postgres://x@h/a"));
    // Overwriting an existing file (second save) must also land 0o600.
    open.store.saveConnection(rec("c2", "b", "postgres://x@h/b"));
    const mode = statSync(join(dir, STORE_FILE_NAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("delete of an absent id is a no-op that writes nothing (P9-adjacent)", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    // No prior file, no matching record: delete must succeed WITHOUT creating a file.
    expect(open.store.deleteConnection("never-existed").outcome).toBe("ok");
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });

  test("first run (no file) → empty store, no error, no file until a mutation", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("opened");
    if (open.outcome !== "opened") return;
    expect(open.store.listConnections()).toHaveLength(0);
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });

  test("upsert: saving the same id twice replaces, does not duplicate", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open.outcome !== "opened") throw new Error("expected opened");
    open.store.saveConnection(rec("c1", "old", "postgres://x@h/old"));
    open.store.saveConnection(rec("c1", "new", "postgres://x@h/new"));
    expect(open.store.listConnections()).toHaveLength(1);
    expect(open.store.getConnection("c1")?.name).toBe("new");
  });
});

describe("credential-store — ephemeral mode writes nothing", () => {
  test("save in ephemeral mode keeps records in memory and creates no file", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({ mode: "ephemeral", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("opened");
    if (open.outcome !== "opened") return;
    expect(open.store.mode).toBe("ephemeral");
    expect(open.store.saveConnection(rec("c1", "a", "postgres://x@h/a")).outcome).toBe("ok");
    expect(open.store.getConnection("c1")).toBeDefined();
    // NOTHING on disk.
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });
});

describe("credential-store — typed failure arms via injected deps", () => {
  test("keychain unavailable on open → typed unavailable, no file written", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: (): StoreKeyResult => ({ outcome: "unavailable", detail: "no D-Bus" }),
    });
    expect(open.outcome).toBe("unavailable");
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });

  test("key not decoding to 32 bytes → typed key-invalid, no file written", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: (): StoreKeyResult => ({ outcome: "key-invalid", detail: "short key" }),
    });
    expect(open.outcome).toBe("key-invalid");
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });

  test("tampered store file → typed corrupt", () => {
    const dir = makeTempDir();
    // Write a valid file, then corrupt the ciphertext.
    const o1 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    o1.store.saveConnection(rec("c1", "a", "postgres://x@h/a"));

    const filePath = join(dir, STORE_FILE_NAME);
    const env = JSON.parse(readFileSync(filePath, "utf8")) as CryptoEnvelope;
    const ct = Buffer.from(env.ciphertext, "base64");
    ct[0] = ct[0]! ^ 0xff;
    writeFileSync(filePath, JSON.stringify({ ...env, ciphertext: ct.toString("base64") }));

    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("corrupt");
  });

  test("wrong key on existing file → typed corrupt", () => {
    const dir = makeTempDir();
    const o1 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    o1.store.saveConnection(rec("c1", "a", "postgres://x@h/a"));

    const otherKey = randomBytes(KEY_LENGTH_BYTES);
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: (): StoreKeyResult => ({ outcome: "loaded", key: otherKey }),
    });
    expect(open.outcome).toBe("corrupt");
  });

  test("I/O read error (store path is a directory) → typed unavailable, not corrupt", () => {
    const dir = makeTempDir();
    // A present-but-unreadable store path (here a directory) makes readFileSync
    // throw EISDIR. The ciphertext isn't corrupt, so the honest, non-destructive
    // verdict is `unavailable`, not `corrupt`.
    mkdirSync(join(dir, STORE_FILE_NAME));
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("unavailable");
  });

  test("unreadable/garbage file → typed corrupt, never a throw", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, STORE_FILE_NAME), "not json at all");
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("corrupt");
  });

  test("valid JSON that is not a well-formed envelope → typed corrupt, never a throw (P2)", () => {
    // `null`, `{}`, `[]` are all valid JSON but NOT envelopes: each must be
    // `corrupt` (not schema-unknown), and a `null.schemaVersion` must never throw.
    for (const literal of ["null", "{}", "[]", "42", '"a string"']) {
      const dir = makeTempDir();
      writeFileSync(join(dir, STORE_FILE_NAME), literal);
      const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
      expect(open.outcome).toBe("corrupt");
    }
  });

  test("well-formed envelope with a different numeric schemaVersion → schema-unknown (P2)", () => {
    const dir = makeTempDir();
    const enc = encryptJson(FIXED_KEY, { schemaVersion: STORE_SCHEMA_VERSION, connections: [] });
    if (enc.outcome !== "encrypted") throw new Error("expected encrypted");
    writeFileSync(join(dir, STORE_FILE_NAME), JSON.stringify({ ...enc.envelope, schemaVersion: 2 }));
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("schema-unknown");
  });

  test("decrypted payload with a malformed connection element → typed corrupt (P7)", () => {
    const dir = makeTempDir();
    // Valid envelope + known payload schema, but a broken connections element.
    const enc = encryptJson(FIXED_KEY, {
      schemaVersion: STORE_SCHEMA_VERSION,
      connections: [{ id: "ok", name: "n", url: "u" }, null, 42, { id: 1 }],
    });
    if (enc.outcome !== "encrypted") throw new Error("expected encrypted");
    writeFileSync(join(dir, STORE_FILE_NAME), JSON.stringify(enc.envelope));
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("corrupt");
  });

  test("unrecognized envelope schemaVersion → typed schema-unknown (no silent overwrite)", () => {
    const dir = makeTempDir();
    const enc = encryptJson(FIXED_KEY, { schemaVersion: STORE_SCHEMA_VERSION, connections: [] });
    if (enc.outcome !== "encrypted") throw new Error("expected encrypted");
    const future: CryptoEnvelope = { ...enc.envelope, schemaVersion: 999 };
    writeFileSync(join(dir, STORE_FILE_NAME), JSON.stringify(future));

    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("schema-unknown");
  });

  test("unrecognized payload schemaVersion → typed schema-unknown", () => {
    const dir = makeTempDir();
    const enc = encryptJson(FIXED_KEY, { schemaVersion: 999, connections: [] });
    if (enc.outcome !== "encrypted") throw new Error("expected encrypted");
    writeFileSync(join(dir, STORE_FILE_NAME), JSON.stringify(enc.envelope));

    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("schema-unknown");
  });
});

// --- Real-keychain happy path (self-cleaning) ---------------------------------
// Uses a run-unique keychain account so cleanup never touches the user's real key.
const TEST_KEY_ACCOUNT = `store-cred-test-${crypto.randomUUID()}`;
const realKeyDeps: StoreKeyDeps = {
  getSecret: (service): KeychainGetResult =>
    DEFAULT_STORE_KEY_DEPS.getSecret(service, TEST_KEY_ACCOUNT),
  setSecret: (service, _a, value) =>
    DEFAULT_STORE_KEY_DEPS.setSecret(service, TEST_KEY_ACCOUNT, value),
  deleteSecret: (service) => DEFAULT_STORE_KEY_DEPS.deleteSecret(service, TEST_KEY_ACCOUNT),
};

afterAll(() => {
  deleteSecret(STORE_KEY_SERVICE, TEST_KEY_ACCOUNT);
});

describe("credential-store — real Linux keychain happy path (or unavailable, both green)", () => {
  test("relaunch survival keyed by the real OS keychain, self-cleaning", () => {
    const dir = makeTempDir();
    const provider = (): StoreKeyResult => loadOrCreateStoreKey(realKeyDeps);

    const o1 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: provider });
    if (o1.outcome === "unavailable") {
      // Keychain-less box (WSL / headless CI). Expected, first-class outcome.
      expect(o1.detail.length).toBeGreaterThan(0);
      expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
      return;
    }
    expect(o1.outcome).toBe("opened");
    if (o1.outcome !== "opened") return;

    const conn = rec("real-1", "prod", "postgres://admin:s3cr3t@db/prod");
    expect(o1.store.saveConnection(conn).outcome).toBe("ok");

    const o2 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: provider });
    expect(o2.outcome).toBe("opened");
    if (o2.outcome === "opened") {
      expect(o2.store.getConnection("real-1")).toEqual(conn);
    }
  });
});
