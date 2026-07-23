/**
 * quick-studio Core — connection-registry tests (Story 2.4).
 *
 * Drives the registry over an INJECTED fixed-key temp-dir store (no live keychain),
 * covering every I/O matrix row: add persistent + reopen survival, add ephemeral
 * writes nothing, bad params, list summary excludes secret bytes, edit rename-only
 * vs repoint, edit unknown-id → not_found, remove existing + remove-absent
 * idempotent, and store-open-failure → internal_error. Self-cleaning per convention.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { KEY_LENGTH_BYTES } from "./crypto.ts";
import {
  openCredentialStore,
  STORE_FILE_NAME,
  type CredentialStore,
  type OpenResult,
  type StoredConnection,
} from "./credential-store.ts";
import type { StoreKeyResult } from "./store-key.ts";
import { createConnectionRegistry } from "./connection-registry.ts";

/**
 * A minimal in-memory fake store, injected via `openStore`, that counts
 * `saveConnection` calls and can be seeded with arbitrary (even malformed) records.
 * Lets us assert the registry's no-write / degrade-not-throw guards precisely.
 */
function fakeStore(initial: StoredConnection[] = []) {
  const records = new Map<string, StoredConnection>(initial.map((r) => [r.id, r]));
  let saveCalls = 0;
  let closeCalls = 0;
  const store: CredentialStore = {
    mode: "persistent",
    saveConnection(record) {
      saveCalls++;
      records.set(record.id, record);
      return { outcome: "ok" };
    },
    getConnection(id) {
      const r = records.get(id);
      return r === undefined ? undefined : { ...r };
    },
    listConnections() {
      return [...records.values()].map((r) => ({ ...r }));
    },
    deleteConnection(id) {
      records.delete(id);
      return { outcome: "ok" };
    },
    close() {
      closeCalls++;
    },
  };
  return { store, saveCalls: () => saveCalls, closeCalls: () => closeCalls };
}

// A deterministic fixed key so the store round-trips without a live keychain.
const FIXED_KEY = randomBytes(KEY_LENGTH_BYTES);
const fixedKeyProvider = (): StoreKeyResult => ({ outcome: "loaded", key: FIXED_KEY });

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = join(tmpdir(), `qs-registry-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

/** A persistent registry over a fixed-key store rooted at `dir`. */
function persistentRegistry(dir: string) {
  return createConnectionRegistry({
    openStore: () =>
      openCredentialStore({ mode: "persistent", dir, loadStoreKey: fixedKeyProvider }),
  });
}

describe("connection-registry — add + list", () => {
  test("add (persistent) mints an id, persists, and returns a credential-free summary", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);

    const added = reg.add({ name: "prod", url: "postgres://admin:s3cr3t@db:5432/prod" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.id).toMatch(/[0-9a-f-]{36}/);
    expect(added.value).toEqual({
      id: added.value.id,
      name: "prod",
      host: "db:5432",
      engine: "postgres",
    });
    // No secret material in the summary.
    expect(JSON.stringify(added.value)).not.toContain("s3cr3t");
  });

  test("add trims the name", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const added = reg.add({ name: "  spaced  ", url: "mysql://root:pw@localhost/db" });
    expect(added.ok).toBe(true);
    if (added.ok) expect(added.value.name).toBe("spaced");
  });

  test("add trims the url before persisting (no surrounding whitespace round-trips to disk)", () => {
    const fake = fakeStore([]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });
    const added = reg.add({ name: "padded", url: "  postgres://u:p@h/db  " });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(fake.store.getConnection(added.value.id)?.url).toBe("postgres://u:p@h/db");
  });

  test("relaunch survival: a fresh registry over the same dir lists the connection", () => {
    const dir = makeTempDir();
    const reg1 = persistentRegistry(dir);
    const added = reg1.add({ name: "prod", url: "postgres://u:p@h/prod" });
    expect(added.ok).toBe(true);

    // Fresh registry = simulated relaunch over the same app dir + key.
    const reg2 = persistentRegistry(dir);
    const list = reg2.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);
    expect(list.value[0]?.name).toBe("prod");
    expect(list.value[0]?.host).toBe("h");
  });

  test("list summaries carry no password and no full url (secret bytes excluded)", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    reg.add({ name: "a", url: "postgres://admin:TOPSECRET@db/a" });
    reg.add({ name: "b", url: "mysql://root:HUNTER2@h:3306/b" });

    const list = reg.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const serialized = JSON.stringify(list.value);
    expect(serialized).not.toContain("TOPSECRET");
    expect(serialized).not.toContain("HUNTER2");
    expect(serialized).not.toContain("admin:");
    expect(list.value).toHaveLength(2);
    // Positive invariant: the summary carries EXACTLY {id,name,host,engine} — no
    // `url`/`user`/`password` field can ride along (substring absence alone would
    // pass a summary that leaked a differently-valued secret).
    for (const s of list.value) {
      expect(Object.keys(s).sort()).toEqual(["engine", "host", "id", "name"]);
    }
  });
});

describe("connection-registry — add ephemeral writes nothing", () => {
  test("ephemeral add keeps the record in memory but creates no store file", () => {
    const dir = makeTempDir();
    const reg = createConnectionRegistry({
      openStore: () =>
        openCredentialStore({ mode: "ephemeral", dir, loadStoreKey: fixedKeyProvider }),
    });

    const added = reg.add({ name: "eph", url: "postgres://u:p@h/eph" });
    expect(added.ok).toBe(true);
    expect(reg.list().ok).toBe(true);
    // NOTHING on disk.
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe("connection-registry — bad params → bad_request", () => {
  test("empty/whitespace name is rejected and nothing is written", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const r = reg.add({ name: "   ", url: "postgres://u:p@h/db" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("bad_request");
    expect(r.detail).toContain("name");
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });

  test("unparseable url is rejected with the offending field named", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const r = reg.add({ name: "ok", url: "not a url" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("bad_request");
    expect(r.detail).toContain("url");
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });

  test("missing url field is a bad_request", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    // deliberately malformed params
    const r = reg.add({ name: "ok" } as unknown as { name: string; url: string });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_request");
  });
});

describe("connection-registry — edit", () => {
  test("rename only: keeps the stored url, updates the name, re-persists", () => {
    const dir = makeTempDir();
    const reg1 = persistentRegistry(dir);
    const added = reg1.add({ name: "old", url: "postgres://u:p@h:5432/db" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const edited = reg1.edit({ id: added.value.id, name: "renamed" });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.name).toBe("renamed");
    // url unchanged → host/engine unchanged.
    expect(edited.value.host).toBe("h:5432");
    expect(edited.value.engine).toBe("postgres");

    // Persisted: a fresh registry sees the rename with the original url intact.
    const reg2 = persistentRegistry(dir);
    const list = reg2.list();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value[0]?.name).toBe("renamed");
      expect(list.value[0]?.host).toBe("h:5432");
    }
  });

  test("repoint: a new url replaces the old one; summary reflects new host/engine", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const added = reg.add({ name: "svc", url: "postgres://u:p@old-host/db" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const edited = reg.edit({ id: added.value.id, url: "mysql://root:pw@new-host:3306/db2" });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.name).toBe("svc"); // name untouched
    expect(edited.value.host).toBe("new-host:3306");
    expect(edited.value.engine).toBe("mysql");
    // Credential-free: the edit reply carries EXACTLY {id,name,host,engine}.
    expect(Object.keys(edited.value).sort()).toEqual(["engine", "host", "id", "name"]);
  });

  test("edit with an unparseable url → bad_request (existing id)", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const added = reg.add({ name: "svc", url: "postgres://u:p@h/db" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const edited = reg.edit({ id: added.value.id, url: "::::" });
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.code).toBe("bad_request");
  });

  test("edit an unknown id → not_found, no mutation", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const r = reg.edit({ id: "does-not-exist", name: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });
});

describe("connection-registry — remove", () => {
  test("remove existing: gone from the next list, and after reopen", () => {
    const dir = makeTempDir();
    const reg1 = persistentRegistry(dir);
    const a = reg1.add({ name: "a", url: "postgres://u:p@h/a" });
    const b = reg1.add({ name: "b", url: "postgres://u:p@h/b" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok) return;

    const removed = reg1.remove({ id: a.value.id });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value).toEqual({ removed: true });

    const reg2 = persistentRegistry(dir);
    const list = reg2.list();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0]?.name).toBe("b");
    }
  });

  test("remove an absent id is idempotent success", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const r = reg.remove({ id: "never-existed" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ removed: true });
  });
});

describe("connection-registry — hostless url rejected (P7)", () => {
  test("add rejects a url that parses but has no host → bad_request, nothing written", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    for (const url of ["foo:bar", "mailto:x@example.com"]) {
      const r = reg.add({ name: "ok", url });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("bad_request");
        expect(r.detail).toContain("url");
      }
    }
    expect(existsSync(join(dir, STORE_FILE_NAME))).toBe(false);
  });

  test("edit rejects a hostless repoint url on an existing id → bad_request", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const added = reg.add({ name: "svc", url: "postgres://u:p@h/db" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const edited = reg.edit({ id: added.value.id, url: "foo:bar" });
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.code).toBe("bad_request");
  });
});

describe("connection-registry — empty edit patch is a no-write no-op (P6)", () => {
  test("edit with neither name nor url returns the unchanged summary without saving", () => {
    const existing: StoredConnection = { id: "c1", name: "keep", url: "postgres://u:p@h:5432/db" };
    const fake = fakeStore([existing]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });

    const edited = reg.edit({ id: "c1" });
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.value).toEqual({ id: "c1", name: "keep", host: "h:5432", engine: "postgres" });
    }
    // No re-encrypt + disk flush for a nothing-to-change edit.
    expect(fake.saveCalls()).toBe(0);
  });

  test("edit an unknown id still errors not_found even with an empty patch", () => {
    const fake = fakeStore([]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });
    const r = reg.edit({ id: "ghost" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
    expect(fake.saveCalls()).toBe(0);
  });
});

describe("connection-registry — list is total over a malformed stored url (P8)", () => {
  test("a single unparseable stored url degrades to empty host/engine, list does not throw", () => {
    const good: StoredConnection = { id: "g", name: "good", url: "postgres://u:p@h/db" };
    const bad: StoredConnection = { id: "b", name: "legacy", url: "not a url" };
    const fake = fakeStore([good, bad]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });

    const list = reg.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(2);
    const byId = new Map(list.value.map((s) => [s.id, s]));
    expect(byId.get("g")).toEqual({ id: "g", name: "good", host: "h", engine: "postgres" });
    // Malformed record keeps its id/name but degrades host/engine to empty.
    expect(byId.get("b")).toEqual({ id: "b", name: "legacy", host: "", engine: "" });
  });
});

describe("connection-registry — edit is total over a malformed stored url (P8-symmetry)", () => {
  test("rename-only on a legacy unparseable-url record persists and returns a degraded summary, not internal_error", () => {
    const legacy: StoredConnection = { id: "b", name: "old", url: "not a url" };
    const fake = fakeStore([legacy]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });

    const edited = reg.edit({ id: "b", name: "renamed" });
    // The write committed; the reply must reflect it — NOT surface a spurious error
    // from `toSummary` throwing on the still-malformed (kept) url.
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value).toEqual({ id: "b", name: "renamed", host: "", engine: "" });
    expect(fake.saveCalls()).toBe(1);
    // On-disk state matches the reply (name updated, url kept).
    expect(fake.store.getConnection("b")).toEqual({ id: "b", name: "renamed", url: "not a url" });
  });

  test("empty-patch no-op on a legacy unparseable-url record returns a degraded summary without saving", () => {
    const legacy: StoredConnection = { id: "b", name: "keep", url: "not a url" };
    const fake = fakeStore([legacy]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });

    const edited = reg.edit({ id: "b" });
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.value).toEqual({ id: "b", name: "keep", host: "", engine: "" });
    }
    expect(fake.saveCalls()).toBe(0);
  });
});

describe("connection-registry — store-open failure mapping", () => {
  test("open-failure detail is the safe outcome label, never a path or errno (P1)", () => {
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({
        outcome: "unavailable",
        // Simulate the store's raw err.message carrying an absolute path + errno.
        detail: "ENOENT: /home/dev/.local/share/quick-studio/credential-store.enc",
      }),
    });
    const list = reg.list();
    expect(list.ok).toBe(false);
    if (!list.ok) {
      expect(list.detail).toBe("unavailable");
      expect(list.detail).not.toContain("/");
      expect(list.detail).not.toContain("ENOENT");
    }
  });

  test("a store that fails to open → internal_error (retryable, not memoized)", () => {
    let attempts = 0;
    const failingOpen = (): OpenResult => {
      attempts++;
      return { outcome: "unavailable", detail: "no keychain" };
    };
    const reg = createConnectionRegistry({ openStore: failingOpen });

    const list = reg.list();
    expect(list.ok).toBe(false);
    if (!list.ok) {
      expect(list.code).toBe("internal_error");
      expect(list.detail).toContain("unavailable");
    }
    // A second call re-attempts the open (failure was NOT memoized).
    reg.list();
    expect(attempts).toBe(2);
  });

  test("corrupt store open also maps to internal_error", () => {
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "corrupt", detail: "auth tag mismatch" }),
    });
    const r = reg.add({ name: "ok", url: "postgres://u:p@h/db" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal_error");
  });
});

describe("connection-registry — close (DW-14)", () => {
  test("close() is TERMINAL: it releases the store and a later op does NOT re-open (P4)", () => {
    const fake = fakeStore([]);
    let opens = 0;
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => {
        opens++;
        return { outcome: "opened", store: fake.store };
      },
    });

    // First list opens + memoizes the store (one open, no close yet).
    expect(reg.list().ok).toBe(true);
    expect(opens).toBe(1);
    expect(fake.closeCalls()).toBe(0);

    // close() forwards to the store's close and clears the cache.
    reg.close();
    expect(fake.closeCalls()).toBe(1);

    // Terminal: a subsequent list does NOT re-open (no new open) and returns the
    // closed internal_error — an op racing shutdown can't re-acquire the lock.
    const list = reg.list();
    expect(list.ok).toBe(false);
    if (!list.ok) {
      expect(list.code).toBe("internal_error");
      expect(list.detail).toBe("closed");
    }
    // add is likewise refused after close, still without re-opening.
    const add = reg.add({ name: "x", url: "postgres://u:p@h/db" });
    expect(add.ok).toBe(false);
    if (!add.ok) {
      expect(add.code).toBe("internal_error");
      expect(add.detail).toBe("closed");
    }
    expect(opens).toBe(1);
  });

  test("close() before any open is a safe no-op (nothing cached)", () => {
    const fake = fakeStore([]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });
    expect(() => reg.close()).not.toThrow();
    expect(fake.closeCalls()).toBe(0);
  });
});

describe("connection-registry — optional pinned schema (Story 10.2)", () => {
  test("add without a schema: the summary carries NO `schema` key at all", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const added = reg.add({ name: "unpinned", url: "postgres://u:p@h/db" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    // The back-compat invariant: an unpinned connection's summary shape is
    // byte-identical to pre-10.2 — a `schema: undefined` key would break it.
    expect(Object.keys(added.value).sort()).toEqual(["engine", "host", "id", "name"]);
  });

  test("add with a schema: trimmed, persisted, and echoed on the summary", () => {
    const dir = makeTempDir();
    const reg1 = persistentRegistry(dir);
    const added = reg1.add({ name: "pinned", url: "postgres://u:p@h/db", schema: "  reporting  " });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.schema).toBe("reporting");

    // Survives a relaunch over the same app dir + key.
    const list = persistentRegistry(dir).list();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value[0]?.schema).toBe("reporting");
  });

  test("add with a blank/whitespace schema is treated as unset (no key stored)", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const added = reg.add({ name: "blank", url: "postgres://u:p@h/db", schema: "   " });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(Object.keys(added.value).sort()).toEqual(["engine", "host", "id", "name"]);
  });

  test("add with a non-string schema → bad_request (field=schema)", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const added = reg.add({
      name: "bad",
      url: "postgres://u:p@h/db",
      schema: 7 as unknown as string,
    });
    expect(added.ok).toBe(false);
    if (added.ok) return;
    expect(added.code).toBe("bad_request");
    expect(added.detail).toBe("field=schema");
  });

  test("edit sets a schema on a previously unpinned connection", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const added = reg.add({ name: "svc", url: "postgres://u:p@h/db" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const edited = reg.edit({ id: added.value.id, schema: "reporting" });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.schema).toBe("reporting");
    expect(edited.value.name).toBe("svc"); // name + url untouched
    expect(edited.value.host).toBe("h");
  });

  test("edit with a BLANK schema CLEARS the pin (R1) — the key is dropped entirely", () => {
    const dir = makeTempDir();
    const reg1 = persistentRegistry(dir);
    const added = reg1.add({ name: "svc", url: "postgres://u:p@h/db", schema: "reporting" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const cleared = reg1.edit({ id: added.value.id, schema: "  " });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(Object.keys(cleared.value).sort()).toEqual(["engine", "host", "id", "name"]);
    // Persisted, not just reported: the reopened store has no `schema` either.
    const list = persistentRegistry(dir).list();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value[0]?.schema).toBeUndefined();
  });

  test("edit omitting `schema` KEEPS the existing pin (absent ≠ blank)", () => {
    const dir = makeTempDir();
    const reg = persistentRegistry(dir);
    const added = reg.add({ name: "svc", url: "postgres://u:p@h/db", schema: "reporting" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const renamed = reg.edit({ id: added.value.id, name: "renamed" });
    expect(renamed.ok).toBe(true);
    if (renamed.ok) expect(renamed.value.schema).toBe("reporting");
  });

  test("a schema-ONLY edit actually writes (it is not swallowed by the empty-patch fast path)", () => {
    const fake = fakeStore([{ id: "c1", name: "svc", url: "postgres://u:p@h/db" }]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });
    const edited = reg.edit({ id: "c1", schema: "reporting" });
    expect(edited.ok).toBe(true);
    expect(fake.saveCalls()).toBe(1);
    // A truly empty patch still short-circuits without a write.
    expect(reg.edit({ id: "c1" }).ok).toBe(true);
    expect(fake.saveCalls()).toBe(1);
  });

  test("a blank schema on an already-unpinned record is a no-write no-op", () => {
    const fake = fakeStore([{ id: "c1", name: "svc", url: "postgres://u:p@h/db" }]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });
    // Clearing a pin that is not there rebuilds a byte-identical record — no reason to
    // re-encrypt and flush the store. (Blank on a PINNED record still writes; covered above.)
    const edited = reg.edit({ id: "c1", schema: "   " });
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.value.schema).toBeUndefined();
    expect(fake.saveCalls()).toBe(0);
  });

  test("edit with a non-string schema → bad_request, no write", () => {
    const fake = fakeStore([{ id: "c1", name: "svc", url: "postgres://u:p@h/db" }]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });
    const edited = reg.edit({ id: "c1", schema: 7 as unknown as string });
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.code).toBe("bad_request");
    expect(fake.saveCalls()).toBe(0);
  });

  test("getStoredUrl carries the pinned schema (and omits it when unpinned)", () => {
    const fake = fakeStore([
      { id: "pinned", name: "a", url: "postgres://u:p@h/a", schema: "reporting" },
      { id: "plain", name: "b", url: "postgres://u:p@h/b" },
    ]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });
    const pinned = reg.getStoredUrl("pinned");
    expect(pinned.kind).toBe("found");
    if (pinned.kind === "found") expect(pinned.schema).toBe("reporting");
    const plain = reg.getStoredUrl("plain");
    expect(plain.kind).toBe("found");
    if (plain.kind === "found") expect(plain.schema).toBeUndefined();
  });

  // `list` is the ONLY path that feeds `ConnectionSummary.schema` to the UI, and the
  // whole "blank clears the pin" asymmetry (R1) rests on the edit form being able to
  // PRE-FILL from it. If `list` ever dropped the key, every edit save would read as a
  // deliberate clear and silently unpin every connection — so it is pinned here, not
  // just on the `add`/`edit` replies.
  test("list carries a pinned schema, and an unpinned row keeps the pre-10.2 key set", () => {
    const fake = fakeStore([
      { id: "pinned", name: "a", url: "postgres://u:p@h/a", schema: "reporting" },
      { id: "plain", name: "b", url: "postgres://u:p@h/b" },
    ]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });
    const list = reg.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value[0]?.schema).toBe("reporting");
    expect(Object.keys(list.value[1] ?? {}).sort()).toEqual(["engine", "host", "id", "name"]);
  });

  test("a malformed-url record still degrades safely WITH its schema (safeSummary arm)", () => {
    const fake = fakeStore([{ id: "c1", name: "legacy", url: "not a url", schema: "reporting" }]);
    const reg = createConnectionRegistry({
      openStore: (): OpenResult => ({ outcome: "opened", store: fake.store }),
    });
    const list = reg.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value[0]).toEqual({
      id: "c1",
      name: "legacy",
      host: "",
      engine: "",
      schema: "reporting",
    });
  });
});
