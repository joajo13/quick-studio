/**
 * quick-studio Core — per-target resolver tests (Story 6.2).
 *
 * Drives {@link createConnectionTargets} over FAKE connection managers + a mutable
 * id→url seam (no live DB, no credential store). Proves: default→boot, id→new manager
 * (created once + cached), unknown id→not-found, store-unavailable→distinct reason,
 * `closeAll` closes every opened manager, cache self-invalidation on a url change
 * (re-opens at the new url, closes the old) and on removal (evict + not-found), and
 * resolve-after-`closeAll`→not-found with no leaked manager.
 */

import { describe, expect, test } from "bun:test";
import type { ConnectResult, DatabaseSchema } from "../shared/contract.ts";
import type { ConnectionManager } from "./connection.ts";
import type { DriverQueryResult } from "./driver.ts";
import { createConnectionTargets, type StoredUrlLookup } from "./connection-targets.ts";

const SCHEMA: DatabaseSchema = { engine: "postgres", tables: [] };

/** A fake connection manager tagged with its url + pinned schema; records `query` + `close`. */
function fakeManager(url: string, schema?: string) {
  let closed = false;
  const queries: string[] = [];
  const manager: ConnectionManager = {
    connect: async (): Promise<ConnectResult> => ({ status: "connected", schema: SCHEMA }),
    getSchema: async () => SCHEMA,
    query: async (text: string): Promise<DriverQueryResult> => {
      queries.push(text);
      return { columns: [], rows: [], rowsAffected: 0 };
    },
    queryReadOnly: async (): Promise<DriverQueryResult> => ({ columns: [], rows: [], rowsAffected: 0 }),
    quoteIdent: (i: string) => `"${i}"`,
    describe: () => {
      try {
        const u = new URL(url);
        return { engine: u.protocol.replace(/:$/, ""), host: u.host, database: u.pathname.slice(1) || undefined };
      } catch {
        return null;
      }
    },
    close: async () => {
      closed = true;
    },
  };
  return { url, schema, manager, isClosed: () => closed, queries };
}

/**
 * A harness: a mutable id→url store (plus the optional id→pinned-schema map of Story
 * 10.2) + a manager factory recording every manager built, with the url AND schema it
 * was built at.
 */
function harness(initial: Record<string, string> = {}) {
  const urls = new Map<string, string>(Object.entries(initial));
  const schemas = new Map<string, string>();
  const created: Array<ReturnType<typeof fakeManager>> = [];
  const boot = fakeManager("boot://db");

  const getStoredUrl = (id: string): StoredUrlLookup => {
    const url = urls.get(id);
    if (url === undefined) return { kind: "not-found" };
    const schema = schemas.get(id);
    // Conditional, exactly like the registry's: an unpinned record carries no key.
    return { kind: "found", url, ...(schema === undefined ? {} : { schema }) };
  };
  const createManager = (url: string, schema?: string): ConnectionManager => {
    const m = fakeManager(url, schema);
    created.push(m);
    return m.manager;
  };

  const targets = createConnectionTargets({ bootManager: boot.manager, getStoredUrl, createManager });
  return { targets, urls, schemas, created, boot };
}

describe("createConnectionTargets — default + basic resolution", () => {
  test("null / undefined id → the boot manager's seams", async () => {
    const { targets, boot, created } = harness();
    for (const id of [null, undefined]) {
      const r = targets.resolve(id);
      expect(r.ok).toBe(true);
      if (r.ok) await r.seams.runQuery("SELECT boot", []);
    }
    expect(boot.queries).toEqual(["SELECT boot", "SELECT boot"]);
    expect(created.length).toBe(0); // no target manager ever built for the default path
  });

  test("a known id → a new manager built ONCE and cached across resolves", async () => {
    const { targets, created, boot } = harness({ a: "postgres://a" });
    const r1 = targets.resolve("a");
    const r2 = targets.resolve("a");
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok) await r1.seams.runQuery("SELECT a", []);
    expect(created.length).toBe(1); // built once …
    expect(created[0]!.url).toBe("postgres://a");
    expect(created[0]!.queries).toEqual(["SELECT a"]); // … and it is the one that ran
    expect(boot.queries.length).toBe(0);
  });

  test("an unknown id → not-found, no manager built", () => {
    const { targets, created } = harness();
    const r = targets.resolve("ghost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
    expect(created.length).toBe(0);
  });

  test("a store-unavailable lookup → reason 'unavailable' (distinct from not-found), no evict/build", () => {
    const boot = fakeManager("boot://db");
    const cached = fakeManager("postgres://a");
    let first = true;
    const targets = createConnectionTargets({
      bootManager: boot.manager,
      // First resolve: found (opens+caches). Second: the store is transiently unavailable.
      getStoredUrl: (): StoredUrlLookup =>
        first ? { kind: "found", url: "postgres://a" } : { kind: "unavailable", detail: "store open failed" },
      createManager: () => cached.manager,
    });
    const r1 = targets.resolve("a");
    expect(r1.ok).toBe(true);
    first = false;
    const r2 = targets.resolve("a");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("unavailable");
    // A store blip must NOT evict/close the good cached manager.
    expect(cached.isClosed()).toBe(false);
  });
});

describe("createConnectionTargets — cache self-invalidation", () => {
  test("a repointed url → the stale manager is closed+evicted and re-opened at the new url", async () => {
    const { targets, urls, created } = harness({ a: "postgres://old" });
    const r1 = targets.resolve("a");
    expect(r1.ok).toBe(true);
    expect(created[0]!.url).toBe("postgres://old");

    urls.set("a", "postgres://new"); // repointed in Settings
    const r2 = targets.resolve("a");
    expect(r2.ok).toBe(true);
    if (r2.ok) await r2.seams.runQuery("SELECT new", []);

    expect(created.length).toBe(2);
    expect(created[0]!.isClosed()).toBe(true); // old closed …
    expect(created[1]!.url).toBe("postgres://new"); // … new opened at the new url
    expect(created[1]!.queries).toEqual(["SELECT new"]); // and it is the one that runs
  });

  test("a removed connection → the cached manager is evicted+closed and resolve returns not-found", () => {
    const { targets, urls, created } = harness({ a: "postgres://a" });
    expect(targets.resolve("a").ok).toBe(true);
    urls.delete("a"); // removed in Settings
    const r = targets.resolve("a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
    expect(created[0]!.isClosed()).toBe(true); // the stale live connection is closed
  });
});

describe("createConnectionTargets — pinned schema scope (Story 10.2)", () => {
  test("the record's pinned schema reaches the manager factory; unpinned passes undefined", () => {
    const { targets, schemas, created } = harness({ a: "postgres://a", b: "postgres://b" });
    schemas.set("a", "reporting");

    expect(targets.resolve("a").ok).toBe(true);
    expect(targets.resolve("b").ok).toBe(true);
    expect(created[0]!.schema).toBe("reporting");
    expect(created[1]!.schema).toBeUndefined();
  });

  test("a schema-ONLY edit evicts+closes the stale manager and re-creates it at the new scope", async () => {
    const { targets, schemas, created } = harness({ a: "postgres://a" });
    const r1 = targets.resolve("a");
    expect(r1.ok).toBe(true);
    expect(created[0]!.schema).toBeUndefined();

    schemas.set("a", "reporting"); // pinned in Settings — the url did NOT change
    const r2 = targets.resolve("a");
    expect(r2.ok).toBe(true);
    if (r2.ok) await r2.seams.runQuery("SELECT scoped", []);

    // Url-only equality would have kept serving the old (unscoped) introspection.
    expect(created.length).toBe(2);
    expect(created[0]!.isClosed()).toBe(true);
    expect(created[1]!.schema).toBe("reporting");
    expect(created[1]!.queries).toEqual(["SELECT scoped"]);
  });

  test("clearing the pin likewise re-creates the manager (unscoped again, same session)", () => {
    const { targets, schemas, created } = harness({ a: "postgres://a" });
    schemas.set("a", "reporting");
    expect(targets.resolve("a").ok).toBe(true);

    schemas.delete("a"); // blanked in Settings
    expect(targets.resolve("a").ok).toBe(true);
    expect(created.length).toBe(2);
    expect(created[1]!.schema).toBeUndefined();
  });

  test("an unchanged pin is still a cache HIT (no needless re-open)", () => {
    const { targets, schemas, created } = harness({ a: "postgres://a" });
    schemas.set("a", "reporting");
    expect(targets.resolve("a").ok).toBe(true);
    expect(targets.resolve("a").ok).toBe(true);
    expect(created.length).toBe(1);
  });
});

describe("createConnectionTargets — shutdown", () => {
  test("closeAll closes EVERY opened target manager (not the boot manager, which the caller owns)", async () => {
    const { targets, created, boot } = harness({ a: "postgres://a", b: "postgres://b" });
    targets.resolve("a");
    targets.resolve("b");
    expect(created.length).toBe(2);
    await targets.closeAll();
    expect(created.every((m) => m.isClosed())).toBe(true);
    expect(boot.isClosed()).toBe(false); // boot is closed by server.ts, not here
  });

  test("resolve AFTER closeAll → not-found, no new (leaked) manager opened", () => {
    const { targets, created } = harness({ a: "postgres://a" });
    void targets.closeAll();
    const r = targets.resolve("a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
    expect(created.length).toBe(0); // latched closed: nothing opened
  });
});
