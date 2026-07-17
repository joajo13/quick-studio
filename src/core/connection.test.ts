/**
 * quick-studio Core — connection-manager tests (fake driver, no live DB).
 *
 * Every case injects a FAKE `createDriver` so the manager's idempotency, failure
 * classification, teardown, and no-target handling are exercised without a live
 * Postgres/MySQL (the DI testability seam).
 */

import { describe, expect, test } from "bun:test";
import type { DatabaseSchema } from "../shared/contract.ts";
import { createConnectionManager } from "./connection.ts";
import { DriverConnectionError, type Driver, type DriverFactory } from "./driver.ts";

const SAMPLE_SCHEMA: DatabaseSchema = {
  engine: "postgres",
  tables: [
    {
      schema: "public",
      name: "users",
      columns: [{ name: "id", dataType: "integer", nullable: false }],
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

/** A fake driver + factory recording how often each verb ran. */
function fakeDriver(behavior: {
  onConnect?: () => Promise<void>;
  schema?: DatabaseSchema;
}): {
  factory: DriverFactory;
  counts: { factory: number; connect: number; listSchema: number; close: number };
} {
  const counts = { factory: 0, connect: 0, listSchema: 0, close: 0 };
  const driver: Driver = {
    async connect() {
      counts.connect++;
      if (behavior.onConnect) await behavior.onConnect();
    },
    async listSchema() {
      counts.listSchema++;
      return behavior.schema ?? SAMPLE_SCHEMA;
    },
    async query() {
      return { columns: [], rows: [] };
    },
    async queryReadOnly() {
      return { columns: [], rows: [] };
    },
    quoteIdent(ident: string) {
      return `"${ident}"`;
    },
    async close() {
      counts.close++;
    },
  };
  const factory: DriverFactory = () => {
    counts.factory++;
    return driver;
  };
  return { factory, counts };
}

/** A manually-resolved promise, to gate a fake `connect` mid-flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("connection manager", () => {
  test("happy path returns {status:'connected', schema}", async () => {
    const { factory } = fakeDriver({ schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    const result = await mgr.connect();
    expect(result).toEqual({ status: "connected", schema: SAMPLE_SCHEMA });
  });

  test("a DriverConnectionError('auth') becomes {status:'failed', failure:'auth'} — never thrown", async () => {
    const { factory } = fakeDriver({
      onConnect: async () => {
        throw new DriverConnectionError("auth", "the database rejected the provided credentials");
      },
    });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:bad@h/db", createDriver: factory });

    const result = await mgr.connect();
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure).toBe("auth");
      // No credentials leak into the neutral message.
      expect(result.message).not.toContain("bad");
    }
  });

  test("is idempotent: a second connect reuses the live connection (factory + connect run once)", async () => {
    const { factory, counts } = fakeDriver({ schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    const first = await mgr.connect();
    const second = await mgr.connect();

    expect(second).toBe(first); // same cached object
    expect(counts.factory).toBe(1);
    expect(counts.connect).toBe(1);
    expect(counts.listSchema).toBe(1);
  });

  test("close() closes an open driver", async () => {
    const { factory, counts } = fakeDriver({ schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    await mgr.connect();
    await mgr.close();
    expect(counts.close).toBe(1);
  });

  test("close() before any connect is a safe no-op", async () => {
    const { factory, counts } = fakeDriver({ schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    await mgr.close();
    expect(counts.close).toBe(0);
    expect(counts.factory).toBe(0);
  });

  test("a null databaseUrl reports a clear no-target failure without a driver", async () => {
    const { factory, counts } = fakeDriver({ schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: null, createDriver: factory });

    const result = await mgr.connect();
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure).toBe("unsupported_scheme");
      expect(result.message).toContain("no connection target");
    }
    expect(counts.factory).toBe(0);
  });

  test("a failed connect is NOT cached — the manager stays retryable", async () => {
    let attempt = 0;
    const counts = { factory: 0, connect: 0 };
    const factory: DriverFactory = () => {
      counts.factory++;
      return {
        async connect() {
          counts.connect++;
          attempt++;
          if (attempt === 1) throw new DriverConnectionError("network", "unreachable");
        },
        async listSchema() {
          return SAMPLE_SCHEMA;
        },
        async query() {
          return { columns: [], rows: [] };
        },
        async queryReadOnly() {
          return { columns: [], rows: [] };
        },
        quoteIdent(ident: string) {
          return `"${ident}"`;
        },
        async close() {},
      };
    };
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    const first = await mgr.connect();
    expect(first.status).toBe("failed");
    const second = await mgr.connect();
    expect(second.status).toBe("connected");
    expect(counts.factory).toBe(2); // retried, not cached
  });

  test("a failed connect closes its driver — no orphaned connection is left open", async () => {
    const { factory, counts } = fakeDriver({
      onConnect: async () => {
        throw new DriverConnectionError("network", "unreachable");
      },
    });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    const result = await mgr.connect();
    expect(result.status).toBe("failed");
    expect(counts.close).toBe(1); // driver torn down, not leaked
  });

  test("a listSchema failure closes the half-open driver and surfaces as a thrown bug", async () => {
    const counts = { close: 0 };
    const factory: DriverFactory = () => ({
      async connect() {},
      async listSchema(): Promise<DatabaseSchema> {
        throw new Error("permission denied for information_schema");
      },
      async query() {
        return { columns: [], rows: [] };
      },
      async queryReadOnly() {
        return { columns: [], rows: [] };
      },
      quoteIdent(ident: string) {
        return `"${ident}"`;
      },
      async close() {
        counts.close++;
      },
    });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    // Not a DriverConnectionError → propagates to `internal_error` at the RPC edge…
    await expect(mgr.connect()).rejects.toThrow();
    // …but the connection opened by `connect()` is closed first, not orphaned.
    expect(counts.close).toBe(1);
  });

  test("a listSchema failure CLASSIFIED as DriverConnectionError becomes {status:'failed'} — not thrown (DW-19)", async () => {
    // The real adapters now wrap `listSchema` so a post-handshake introspection denial
    // (an unprivileged account, a mid-introspection reset, or the DW-20 timeout) exits as
    // a classified `DriverConnectionError`. `open()` must turn that into a neutral
    // status:"failed" payload — never an `internal_error` — and tear down the half-open
    // driver, exactly as it does for a classified connect failure.
    const counts = { close: 0 };
    const factory: DriverFactory = () => ({
      async connect() {},
      async listSchema(): Promise<DatabaseSchema> {
        throw new DriverConnectionError("auth", "the database rejected the provided credentials");
      },
      async query() {
        return { columns: [], rows: [] };
      },
      async queryReadOnly() {
        return { columns: [], rows: [] };
      },
      quoteIdent(ident: string) {
        return `"${ident}"`;
      },
      async close() {
        counts.close++;
      },
    });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    const result = await mgr.connect();
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure).toBe("auth");
      // No credentials leak into the neutral message.
      expect(result.message).not.toContain("p@h");
    }
    // The half-open driver is torn down, not orphaned.
    expect(counts.close).toBe(1);
  });

  test("concurrent connect() calls share ONE attempt — the driver opens exactly once", async () => {
    const gate = deferred();
    const { factory, counts } = fakeDriver({ onConnect: () => gate.promise, schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    const a = mgr.connect();
    const b = mgr.connect(); // arrives before the first resolves
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toEqual({ status: "connected", schema: SAMPLE_SCHEMA });
    expect(rb).toBe(ra); // both got the single shared result
    expect(counts.factory).toBe(1);
    expect(counts.connect).toBe(1); // opened exactly once, no leaked second driver
  });

  test("close() during an in-flight connect awaits it, then leaves nothing open", async () => {
    const gate = deferred();
    const { factory, counts } = fakeDriver({ onConnect: () => gate.promise, schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    const connecting = mgr.connect();
    const closing = mgr.close(); // begins while connect is still gated
    gate.resolve();
    await Promise.all([connecting, closing]);

    expect(counts.close).toBe(1); // the driver opened mid-shutdown was torn down
  });

  test("close() after a connect never rejects even if the driver's close() throws", async () => {
    const factory: DriverFactory = () => ({
      async connect() {},
      async listSchema() {
        return SAMPLE_SCHEMA;
      },
      async query() {
        return { columns: [], rows: [] };
      },
      async queryReadOnly() {
        return { columns: [], rows: [] };
      },
      quoteIdent(ident: string) {
        return `"${ident}"`;
      },
      async close() {
        throw new Error("socket wedged");
      },
    });
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    await mgr.connect();
    // A rejecting driver.close() must not propagate — else server.stop() never releases the port.
    await expect(mgr.close()).resolves.toBeUndefined();
  });

  test("describe() derives {engine, host, database} from the in-memory url — no driver opened, no secret", () => {
    const { factory, counts } = fakeDriver({ schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({
      databaseUrl: "postgres://alice:s3cret@db.example.com:5432/shop",
      createDriver: factory,
    });

    const descriptor = mgr.describe();
    expect(descriptor).toEqual({ engine: "postgres", host: "db.example.com:5432", database: "shop" });
    // Credential-free by construction: no userinfo, no password anywhere in the reply.
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("s3cret");
    // Pure read: derives from the held url only — the driver is NEVER opened.
    expect(counts.factory).toBe(0);
  });

  test("describe() returns null when no databaseUrl is configured", () => {
    const { factory, counts } = fakeDriver({ schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: null, createDriver: factory });

    expect(mgr.describe()).toBeNull();
    expect(counts.factory).toBe(0);
  });

  test("describe() returns null (never throws) on an unparseable url", () => {
    const { factory, counts } = fakeDriver({ schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: "not a url", createDriver: factory });

    expect(() => mgr.describe()).not.toThrow();
    expect(mgr.describe()).toBeNull();
    expect(counts.factory).toBe(0);
  });

  test("describe() returns null on a parseable-but-hostless url (mirrors the registry host guard)", () => {
    const { factory, counts } = fakeDriver({ schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: "postgres:///shop", createDriver: factory });

    expect(mgr.describe()).toBeNull();
    expect(counts.factory).toBe(0);
  });
});
