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
  STORE_LOCK_FILE_NAME,
  STORE_META_FILE_NAME,
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
import { derivePassphraseKey } from "./passphrase-key.ts";
import type { PassphraseProvider } from "./passphrase-provider.ts";

// Track temp dirs so every run self-cleans.
const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = join(tmpdir(), `qs-store-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

// Snapshot QS_PASSPHRASE so no test leaks it into another (the default provider
// reads it). Restored after every test.
const ORIGINAL_QS_PASSPHRASE = process.env.QS_PASSPHRASE;

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
  if (ORIGINAL_QS_PASSPHRASE === undefined) {
    delete process.env.QS_PASSPHRASE;
  } else {
    process.env.QS_PASSPHRASE = ORIGINAL_QS_PASSPHRASE;
  }
});

// A deterministic fixed key provider for the failure/behaviour arms.
const FIXED_KEY = randomBytes(KEY_LENGTH_BYTES);
const fixedKeyProvider = (): StoreKeyResult => ({ outcome: "loaded", key: FIXED_KEY });

// Keychain-down provider: drives every passphrase-fallback branch.
const keychainDown = (): StoreKeyResult => ({ outcome: "unavailable", detail: "no keychain" });
// Provider factories for the passphrase seam.
const providePassphrase = (passphrase: string): PassphraseProvider => () => ({ outcome: "provided", passphrase });
const declineProvider: PassphraseProvider = () => ({ outcome: "declined" });

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
    // Inject a no-op lock (DW-14): the real lock would fail to create its file in the
    // missing dir, but this test's subject is the SAVE-time write divergence, not lock
    // acquisition, so bypass the lock seam to reach it.
    const dir = join(makeTempDir(), "missing-subdir");
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: fixedKeyProvider,
      acquireLock: () => ({ outcome: "acquired", release: () => {} }),
    });
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

describe("credential-store — single-writer lock (DW-14)", () => {
  test("a held lock → `locked`, and writes NOTHING (no .enc / .meta / lock)", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: fixedKeyProvider,
      acquireLock: () => ({ outcome: "held", detail: "held by a live process (pid 999)" }),
    });
    expect(open.outcome).toBe("locked");
    if (open.outcome === "locked") expect(open.detail).toContain("999");
    // Contention is non-destructive: no store/descriptor/lock file created.
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
    expect(existsSync(join(dir, STORE_META_FILE_NAME))).toBe(false);
    expect(existsSync(join(dir, STORE_LOCK_FILE_NAME))).toBe(false);
  });

  test("a lock I/O error → `unavailable` (non-destructive)", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: fixedKeyProvider,
      acquireLock: () => ({ outcome: "unavailable", detail: "EACCES" }),
    });
    expect(open.outcome).toBe("unavailable");
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });

  test("store.close() invokes the lock release exactly once", () => {
    const dir = makeTempDir();
    let released = 0;
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: fixedKeyProvider,
      acquireLock: () => ({ outcome: "acquired", release: () => { released++; } }),
    });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(released).toBe(0);
    open.store.close();
    expect(released).toBe(1);
    // Idempotent: a second close does not release again.
    open.store.close();
    expect(released).toBe(1);
  });

  test("ephemeral close() is a no-op and touches no disk", () => {
    const open = openCredentialStore({ mode: "ephemeral" });
    if (open.outcome !== "opened") throw new Error("expected opened");
    // Must not throw and must have no observable effect.
    expect(() => open.store.close()).not.toThrow();
  });

  test("in-process reopen of the same real dir still succeeds (same-PID reentrancy)", () => {
    // Uses the REAL default lock: the first open records our PID; the reopen sees its
    // own live PID and reclaims → opens. Proves the existing suite's repeated in-
    // process opens stay green under the default lock.
    const dir = makeTempDir();
    const o1 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(o1.outcome).toBe("opened");
    const o2 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(o2.outcome).toBe("opened");
    // A real lock file exists under the dir (distinct from the .enc/.meta names).
    expect(existsSync(join(dir, STORE_LOCK_FILE_NAME))).toBe(true);
  });

  test("a post-acquire failure arm (corrupt descriptor) releases the real lock", () => {
    const dir = makeTempDir();
    // Write a malformed descriptor so the open fails AFTER the lock is acquired.
    writeFileSync(join(dir, STORE_META_FILE_NAME), "{ not valid json");
    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("corrupt");
    // The lock was released (removed) on the failure arm — no leaked lock file, and
    // no `.stale.*` residue from the release path.
    expect(existsSync(join(dir, STORE_LOCK_FILE_NAME))).toBe(false);
    const stale = readdirSync(dir).filter((f) => f.includes(".stale."));
    expect(stale).toEqual([]);
  });

  test("an unexpected throw during open releases the lock instead of leaking it", () => {
    const dir = makeTempDir();
    let released = 0;
    // A key seam that THROWS (contract violation) rather than returning a typed
    // result: it escapes openPersistent's total-return contract. The acquired lock
    // must still be released on the way out — a failed open must never leak the lock.
    const throwingKey = (): never => {
      throw new Error("boom: contract-violating key seam");
    };
    expect(() =>
      openCredentialStore({
        mode: "persistent",
        dir,
        loadStoreKey: throwingKey,
        acquireLock: () => ({ outcome: "acquired", release: () => { released++; } }),
      }),
    ).toThrow("boom");
    expect(released).toBe(1);
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
  test("keychain unavailable, first run, default provider (no QS_PASSPHRASE) → passphrase-declined, nothing written", () => {
    const dir = makeTempDir();
    // The default env provider decides: with no QS_PASSPHRASE it declines, so the
    // keychain-unavailable first-run path now yields passphrase-declined (Story 2.3),
    // not the old bare `unavailable`.
    delete process.env.QS_PASSPHRASE;
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: (): StoreKeyResult => ({ outcome: "unavailable", detail: "no D-Bus" }),
    });
    expect(open.outcome).toBe("passphrase-declined");
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
    expect(existsSync(join(dir, STORE_META_FILE_NAME))).toBe(false);
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

  test("a LEGACY record with no `schema` still loads (additive-optional, no version bump) — Story 10.2", () => {
    const dir = makeTempDir();
    // A store written before 10.2: same STORE_SCHEMA_VERSION, records with no
    // `schema` key. It must open cleanly (never `schema-unknown`/`corrupt`) and
    // read back with `schema === undefined`.
    const enc = encryptJson(FIXED_KEY, {
      schemaVersion: STORE_SCHEMA_VERSION,
      connections: [{ id: "c1", name: "legacy", url: "postgres://u:p@h/db" }],
    });
    if (enc.outcome !== "encrypted") throw new Error("expected encrypted");
    writeFileSync(join(dir, STORE_FILE_NAME), JSON.stringify(enc.envelope));

    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("opened");
    if (open.outcome !== "opened") return;
    expect(open.store.getConnection("c1")?.schema).toBeUndefined();
  });

  test("a non-string `schema` on a record → typed corrupt (the guard rejects it) — Story 10.2", () => {
    const dir = makeTempDir();
    // A hand-edited/corrupt store must never bind a non-string into introspection SQL.
    const enc = encryptJson(FIXED_KEY, {
      schemaVersion: STORE_SCHEMA_VERSION,
      connections: [{ id: "c1", name: "n", url: "postgres://u:p@h/db", schema: 7 }],
    });
    if (enc.outcome !== "encrypted") throw new Error("expected encrypted");
    writeFileSync(join(dir, STORE_FILE_NAME), JSON.stringify(enc.envelope));

    const open = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    expect(open.outcome).toBe("corrupt");
  });
});

describe("credential-store — optional pinned schema round-trip (Story 10.2)", () => {
  test("a record WITH a schema survives a relaunch, and one without stays key-free", () => {
    const dir = makeTempDir();
    const open1 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open1.outcome !== "opened") throw new Error("expected opened");
    open1.store.saveConnection({
      id: "pinned",
      name: "a",
      url: "postgres://u:p@h/a",
      schema: "reporting",
    });
    open1.store.saveConnection(rec("plain", "b", "postgres://u:p@h/b"));

    const open2 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (open2.outcome !== "opened") throw new Error("expected opened");
    expect(open2.store.getConnection("pinned")?.schema).toBe("reporting");
    const plain = open2.store.getConnection("plain");
    expect(plain).toBeDefined();
    expect(Object.keys(plain!).sort()).toEqual(["id", "name", "url"]);
  });
});

describe("credential-store — passphrase fallback (keychain unavailable)", () => {
  test("first run + passphrase provided → opens, writes non-secret descriptor, survives reopen with same passphrase", () => {
    const dir = makeTempDir();
    const conn = rec("c1", "prod", "postgres://admin:s3cr3t@db/prod");

    const o1 = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("hunter2"),
    });
    expect(o1.outcome).toBe("opened");
    if (o1.outcome !== "opened") return;
    // Descriptor AND an empty encrypted `.enc` are both written at creation now
    // (eager seed, P2), so a wrong passphrase on reopen always has ciphertext to
    // authenticate against.
    expect(existsSync(join(dir, STORE_META_FILE_NAME))).toBe(true);
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(true);
    expect(o1.store.saveConnection(conn).outcome).toBe("ok");
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(true);

    // Fresh instance, keychain STILL down, same passphrase → re-derives + decrypts.
    const o2 = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("hunter2"),
    });
    expect(o2.outcome).toBe("opened");
    if (o2.outcome !== "opened") return;
    expect(o2.store.getConnection("c1")).toEqual(conn);
    expect(o2.store.listConnections()).toHaveLength(1);
  });

  test("passphrase declined → passphrase-declined, nothing written", () => {
    const dir = makeTempDir();
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: declineProvider,
    });
    expect(open.outcome).toBe("passphrase-declined");
    expect(existsSync(join(dir, STORE_META_FILE_NAME))).toBe(false);
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });

  test("empty/whitespace passphrase → passphrase-invalid, nothing written", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      const dir = makeTempDir();
      const open = openCredentialStore({
        mode: "persistent",
        dir,
        loadStoreKey: keychainDown,
        passphraseProvider: providePassphrase(blank),
      });
      expect(open.outcome).toBe("passphrase-invalid");
      expect(existsSync(join(dir, STORE_META_FILE_NAME))).toBe(false);
      expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
    }
  });

  test("reopen passphrase store with the WRONG passphrase → corrupt (GCM auth-tag fail)", () => {
    const dir = makeTempDir();
    const o1 = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("right-passphrase"),
    });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    o1.store.saveConnection(rec("c1", "a", "postgres://x@h/a"));

    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("WRONG-passphrase"),
    });
    expect(open.outcome).toBe("corrupt");
  });

  test("EMPTY passphrase store (never saved), reopen with WRONG passphrase → corrupt, not silently opened (P2)", () => {
    const dir = makeTempDir();
    // Create the store but do NOT save anything. The eager empty-`.enc` seed (P2)
    // means there IS ciphertext to authenticate against.
    const o1 = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("right-passphrase"),
    });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(true);

    // Wrong passphrase must FAIL (GCM) rather than be silently accepted + reseeded.
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("WRONG-passphrase"),
    });
    expect(open.outcome).toBe("corrupt");

    // And the correct passphrase still opens the (empty) store — not locked out.
    const ok = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("right-passphrase"),
    });
    expect(ok.outcome).toBe("opened");
    if (ok.outcome !== "opened") return;
    expect(ok.store.listConnections()).toHaveLength(0);
  });

  test("descriptor present but .enc removed → corrupt (no empty-store re-key under an unverified passphrase, DW-84)", () => {
    const dir = makeTempDir();
    const o1 = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("right-passphrase"),
    });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    o1.store.saveConnection(rec("c1", "a", "postgres://x@h/a"));
    o1.store.close();

    // Remove the ciphertext out from under the still-present descriptor (a crash
    // between the two writes, a failed rollback, or a user deleting the file).
    rmSync(join(dir, STORE_FILE_NAME), { force: true });
    expect(existsSync(join(dir, STORE_META_FILE_NAME))).toBe(true);

    // The CORRECT passphrase must not open an empty store either: without ciphertext
    // there is nothing to authenticate against, so "opened" would be a guess, and the
    // first save would re-key the store and lock out the real one.
    const samePass = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("right-passphrase"),
    });
    expect(samePass.outcome).toBe("corrupt");
    if (samePass.outcome === "corrupt") {
      expect(samePass.detail).toBe("descriptor present but store file is missing");
    }

    // And a DIFFERENT passphrase is equally rejected — never silently accepted. The
    // detail is asserted here too: without it, a `corrupt` arriving for some
    // unrelated reason (a future guard, a decode failure) would satisfy this test
    // while the missing-`.enc` guard itself had stopped firing.
    const otherPass = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("some-other-passphrase"),
    });
    expect(otherPass.outcome).toBe("corrupt");
    if (otherPass.outcome !== "corrupt") throw new Error("unreachable");
    expect(otherPass.detail).toBe("descriptor present but store file is missing");

    // Neither failed open may write anything back — the `.enc` stays gone.
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
    // And, more importantly, the DESCRIPTOR survives both failed opens. It holds the
    // salt, so it is the only thing that can ever decrypt an `.enc` restored from a
    // backup — losing it is the actually unrecoverable outcome, strictly worse than
    // the missing `.enc` this test is about. A failed open that "cleaned up" the
    // descriptor would pass every assertion above.
    expect(existsSync(join(dir, STORE_META_FILE_NAME))).toBe(true);
  });

  test("descriptor present, .enc removed, provider DECLINES → passphrase-declined (guard sits AFTER the provider call, DW-86)", () => {
    // The Story 11.6 pre-flight's decline-probe asks the REAL open path whether a
    // passphrase is needed, using an always-declining provider. If the missing-`.enc`
    // guard ran BEFORE that call this would answer `corrupt`, the pre-flight would
    // classify it as "a different problem" and skip, and the DW-86 short-circuit
    // would be unreachable. This pins the ordering.
    const dir = makeTempDir();
    const o1 = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("right-passphrase"),
    });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    o1.store.close();
    rmSync(join(dir, STORE_FILE_NAME), { force: true });

    const probe = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: declineProvider,
    });
    expect(probe.outcome).toBe("passphrase-declined");
  });

  test("descriptor present, .enc removed, EMPTY passphrase → passphrase-invalid, not corrupt (guard sits AFTER the derivation)", () => {
    // The guard's placement is held by TWO independent constraints, and the test
    // above pins only the first (after the PROVIDER call, so the decline-probe still
    // sees `passphrase-declined`). That constraint is already satisfied by the
    // declined check at the top of the arm, so a hoist to just below it would keep
    // the test above green while changing this one: an empty passphrase is decided by
    // `derivePassphraseKey`, which runs after. `passphrase-invalid` describes what the
    // CALLER did wrong and must keep winning over `corrupt`, which describes the disk
    // — the pre-flight's `classifyUnlockAttempt` maps them differently, so collapsing
    // one into the other is a real behaviour change. Twin of the same test in
    // `provider-key-store.test.ts`.
    const dir = makeTempDir();
    const o1 = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("right-passphrase"),
    });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    o1.store.close();
    rmSync(join(dir, STORE_FILE_NAME), { force: true });

    for (const empty of ["", "   "]) {
      const open = openCredentialStore({
        mode: "persistent",
        dir,
        loadStoreKey: keychainDown,
        passphraseProvider: providePassphrase(empty),
      });
      expect(open.outcome).toBe("passphrase-invalid");
    }
  });

  test("keychain-mode file, keychain now unavailable → key-unavailable (NOT routed to passphrase)", () => {
    const dir = makeTempDir();
    // Create a keychain-mode store (fixed key → NO descriptor written) and save.
    const o1 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    o1.store.saveConnection(rec("c1", "a", "postgres://x@h/a"));
    expect(existsSync(join(dir, STORE_META_FILE_NAME))).toBe(false);

    // Keychain now down; a passphrase can't decrypt a keychain-keyed file.
    let passphraseConsulted = false;
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: () => {
        passphraseConsulted = true;
        return { outcome: "provided", passphrase: "irrelevant" };
      },
    });
    expect(open.outcome).toBe("key-unavailable");
    expect(passphraseConsulted).toBe(false);
  });

  test("keychain-mode file, keychain MINTED a fresh key (created) → key-unavailable, .enc not overwritten (P1)", () => {
    const dir = makeTempDir();
    // Existing keychain-mode store (fixed key → NO descriptor) with saved data.
    const o1 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    o1.store.saveConnection(rec("c1", "a", "postgres://x@h/a"));
    expect(existsSync(join(dir, STORE_META_FILE_NAME))).toBe(false);
    const encBefore = readFileSync(join(dir, STORE_FILE_NAME));

    // Keychain had to CREATE a fresh key → the original key is gone. Decrypting
    // with the new key would GCM-fail and misreport `corrupt`; instead it must be
    // the distinct `key-unavailable` (file present, key gone).
    const freshKey = randomBytes(KEY_LENGTH_BYTES);
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: (): StoreKeyResult => ({ outcome: "created", key: freshKey }),
    });
    expect(open.outcome).toBe("key-unavailable");
    // The original ciphertext must be untouched — no destructive overwrite.
    expect(readFileSync(join(dir, STORE_FILE_NAME)).equals(encBefore)).toBe(true);
  });

  test("descriptor is authoritative: passphrase store reopened while keychain is AVAILABLE still uses passphrase", () => {
    const dir = makeTempDir();
    const conn = rec("c1", "a", "postgres://x@h/a");
    const o1 = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("the-passphrase"),
    });
    if (o1.outcome !== "opened") throw new Error("expected opened");
    o1.store.saveConnection(conn);

    // Keychain is now UP, but the descriptor pins passphrase mode → keychain ignored.
    let keychainConsulted = false;
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: (): StoreKeyResult => {
        keychainConsulted = true;
        return { outcome: "loaded", key: FIXED_KEY };
      },
      passphraseProvider: providePassphrase("the-passphrase"),
    });
    expect(open.outcome).toBe("opened");
    if (open.outcome !== "opened") return;
    expect(keychainConsulted).toBe(false);
    expect(open.store.getConnection("c1")).toEqual(conn);
  });

  test("raw files hold no plaintext, no passphrase, and no derived key", () => {
    const dir = makeTempDir();
    const passphrase = `pass-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    const name = `conn-${crypto.randomUUID()}`;
    const url = `mysql://root:${crypto.randomUUID()}@h/${crypto.randomUUID()}`;

    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase(passphrase),
    });
    if (open.outcome !== "opened") throw new Error("expected opened");
    open.store.saveConnection(rec(id, name, url));

    const encText = readFileSync(join(dir, STORE_FILE_NAME), "utf8");
    const metaText = readFileSync(join(dir, STORE_META_FILE_NAME), "utf8");

    // Re-derive the key from the persisted descriptor to prove it is NOT at rest.
    const meta = JSON.parse(metaText) as {
      keyMode: string;
      kdf: { salt: string; n: number; r: number; p: number; keylen: number };
    };
    expect(meta.keyMode).toBe("passphrase");
    const derived = derivePassphraseKey(passphrase, Buffer.from(meta.kdf.salt, "base64"), {
      N: meta.kdf.n,
      r: meta.kdf.r,
      p: meta.kdf.p,
      keylen: meta.kdf.keylen,
    });
    if (derived.outcome !== "derived") throw new Error("expected derived");

    for (const text of [encText, metaText]) {
      for (const secret of [id, name, url, passphrase]) {
        expect(text).not.toContain(secret);
      }
      expect(text).not.toContain(derived.key.toString("base64"));
      expect(text).not.toContain(derived.key.toString("hex"));
    }
    expect(readFileSync(join(dir, STORE_FILE_NAME)).includes(derived.key)).toBe(false);
    // The descriptor exposes only non-secret re-derivation material.
    expect(Object.keys(meta).sort()).toEqual(["kdf", "keyMode", "schemaVersion"].sort());
  });

  test("descriptor 0o600 on POSIX", () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir();
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("pw"),
    });
    if (open.outcome !== "opened") throw new Error("expected opened");
    const mode = statSync(join(dir, STORE_META_FILE_NAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("malformed descriptor content (bad JSON / wrong shape) → corrupt", () => {
    for (const bad of ["not json at all", "{}", "null", '{"keyMode":"passphrase"}']) {
      const dir = makeTempDir();
      writeFileSync(join(dir, STORE_META_FILE_NAME), bad);
      const open = openCredentialStore({
        mode: "persistent",
        dir,
        loadStoreKey: keychainDown,
        passphraseProvider: providePassphrase("pw"),
      });
      expect(open.outcome).toBe("corrupt");
    }
  });

  // Helper: write a well-shaped descriptor with the given kdf overrides applied.
  const writeDescriptorWith = (
    dir: string,
    over: Partial<{ schemaVersion: number; salt: string; n: number; r: number; p: number; keylen: number }> = {},
  ): void => {
    const descriptor = {
      schemaVersion: over.schemaVersion ?? 1,
      keyMode: "passphrase",
      kdf: {
        algo: "scrypt",
        salt: over.salt ?? randomBytes(16).toString("base64"),
        n: over.n ?? 2 ** 15,
        r: over.r ?? 8,
        p: over.p ?? 1,
        keylen: over.keylen ?? KEY_LENGTH_BYTES,
      },
    };
    writeFileSync(join(dir, STORE_META_FILE_NAME), JSON.stringify(descriptor));
  };

  test("descriptor with an unrecognized schemaVersion → schema-unknown (P3)", () => {
    const dir = makeTempDir();
    writeDescriptorWith(dir, { schemaVersion: 2 });
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("pw"),
    });
    expect(open.outcome).toBe("schema-unknown");
  });

  test("descriptor with degenerate/hostile KDF params → corrupt (P4)", () => {
    // Each case is a well-shaped descriptor with ONE invalid KDF field.
    const cases: Partial<{ salt: string; n: number; r: number; p: number; keylen: number }>[] = [
      { salt: "" }, // empty salt → 0-byte salt → weakened KDF
      { keylen: 16 }, // wrong AES key length
      { n: 3000 }, // not a power of two
      { n: 2 ** 30 }, // power of two but far out of range
      { n: 2 ** 13 }, // power of two but below the floor
      { r: 0 }, // r out of range
      { p: 0 }, // p out of range
    ];
    for (const over of cases) {
      const dir = makeTempDir();
      writeDescriptorWith(dir, over);
      const open = openCredentialStore({
        mode: "persistent",
        dir,
        loadStoreKey: keychainDown,
        passphraseProvider: providePassphrase("pw"),
      });
      expect(open.outcome).toBe("corrupt");
    }
  });

  test("descriptor I/O read error (path is a directory) → unavailable, not corrupt", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, STORE_META_FILE_NAME)); // readFileSync → EISDIR
    const open = openCredentialStore({
      mode: "persistent",
      dir,
      loadStoreKey: keychainDown,
      passphraseProvider: providePassphrase("pw"),
    });
    expect(open.outcome).toBe("unavailable");
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

    // No QS_PASSPHRASE: on a keychain-less box the first-run path declines the
    // passphrase fallback rather than deriving one, so degrade to a green return.
    delete process.env.QS_PASSPHRASE;
    const o1 = openCredentialStore({ mode: "persistent", dir, loadStoreKey: provider });
    if (o1.outcome === "unavailable" || o1.outcome === "passphrase-declined") {
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
