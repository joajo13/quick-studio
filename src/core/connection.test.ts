/**
 * quick-studio Core — connection-manager tests (fake driver, no live DB).
 *
 * Every case injects a FAKE `createDriver` so the manager's idempotency, failure
 * classification, teardown, and no-target handling are exercised without a live
 * Postgres/MySQL (the DI testability seam).
 */

import { describe, expect, test } from "bun:test";
import type { DatabaseSchema } from "../shared/contract.ts";
import { createConnectionManager, NoConnectionTargetError } from "./connection.ts";
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
      // Its own first-class kind — never the overloaded `unsupported_scheme` bucket.
      expect(result.failure).toBe("no-target");
      expect(result.message).toContain("no connection target");
    }
    expect(counts.factory).toBe(0);
  });

  test("the read path (getSchema/query) throws NoConnectionTargetError when databaseUrl is null", async () => {
    const { factory, counts } = fakeDriver({ schema: SAMPLE_SCHEMA });
    const mgr = createConnectionManager({ databaseUrl: null, createDriver: factory });

    // A TYPED throw (not a generic Error) so read-path callers can `instanceof`-branch
    // it into a neutral `bad_request` instead of the generic `internal_error`.
    await expect(mgr.getSchema()).rejects.toBeInstanceOf(NoConnectionTargetError);
    await expect(mgr.query("SELECT 1")).rejects.toBeInstanceOf(NoConnectionTargetError);
    // Never opens a driver — there was nothing to connect to.
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

/**
 * A fake driver + factory that RECORDS every `listSchema` argument, so the pinned
 * scope's thread from `ConnectionManagerDeps` to the driver is directly observable.
 */
function recordingDriver(): { factory: DriverFactory; calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  const driver: Driver = {
    async connect() {},
    async listSchema(schema?: string) {
      calls.push(schema);
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
  return { factory: () => driver, calls };
}

/** The catalog AFTER a DDL ran: the same table plus a new one, so a stale memo is visible. */
const SAMPLE_SCHEMA_V2: DatabaseSchema = {
  engine: "postgres",
  tables: [
    ...SAMPLE_SCHEMA.tables,
    {
      schema: "public",
      name: "orders",
      columns: [{ name: "id", dataType: "integer", nullable: false }],
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

/** A THIRD catalog: a table created while a refresh for V2 was already in flight. */
const SAMPLE_SCHEMA_V3: DatabaseSchema = {
  engine: "postgres",
  tables: [
    ...SAMPLE_SCHEMA_V2.tables,
    {
      schema: "public",
      name: "receipts",
      columns: [{ name: "id", dataType: "integer", nullable: false }],
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

/**
 * A fake driver whose `listSchema` reads a MUTABLE schema and counts every call, so a
 * re-introspection (vs a memo hit) is directly observable. `nextError` makes exactly the
 * next introspection throw (the refresh-failure path); `gate`, when set, holds every
 * introspection open so two concurrent readers can be proven to share one call;
 * `onIntrospect`, when set, runs at the start of every introspection — the seam for
 * simulating a writer that keeps committing DDL while a reader is refreshing.
 */
type RefreshableState = {
  schema: DatabaseSchema;
  nextError: unknown;
  gate: Promise<void> | null;
  onIntrospect: (() => void) | null;
};

function refreshableDriver(): {
  factory: DriverFactory;
  counts: { listSchema: number };
  state: RefreshableState;
} {
  const counts = { listSchema: 0 };
  const state: RefreshableState = {
    schema: SAMPLE_SCHEMA,
    nextError: null,
    gate: null,
    onIntrospect: null,
  };
  const driver: Driver = {
    async connect() {},
    async listSchema() {
      counts.listSchema++;
      state.onIntrospect?.();
      // Snapshot at CALL time, before the gate: a real introspection answers the catalog as
      // it was when the query ran, so a DDL committing while the answer is in flight cannot
      // retroactively appear in it. That is exactly the race the lost-update guard covers.
      const answer = state.schema;
      if (state.gate !== null) await state.gate;
      if (state.nextError !== null) {
        const err = state.nextError;
        state.nextError = null;
        throw err;
      }
      return answer;
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
  return { factory: () => driver, counts, state };
}

/**
 * DW-45: the schema memo is per-manager and, before this, only `close()` (latched and
 * permanent) ever cleared it — unusable for the boot manager, which lives for the whole
 * session. `invalidateSchema()` busts it IN PLACE so the next read re-introspects.
 */
describe("connection manager — invalidateSchema (DW-45)", () => {
  test("getSchema is memoized until invalidateSchema, then re-introspects the NEW catalog", async () => {
    const { factory, counts, state } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA);
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA);
    expect(counts.listSchema).toBe(1); // memo served both reads

    // A DDL ran: the catalog changed under the memo.
    state.schema = SAMPLE_SCHEMA_V2;
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA); // still stale — nothing busted it
    mgr.invalidateSchema();
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA_V2);
    expect(counts.listSchema).toBe(2);
    // …and the refreshed value is itself memoized (no per-call introspection).
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA_V2);
    expect(counts.listSchema).toBe(2);
  });

  test("connect() after invalidateSchema returns a ConnectResult carrying the FRESH schema", async () => {
    const { factory, counts, state } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    expect(await mgr.connect()).toEqual({ status: "connected", schema: SAMPLE_SCHEMA });
    state.schema = SAMPLE_SCHEMA_V2;
    mgr.invalidateSchema();

    // The idempotent branch must re-read `cached` AFTER the refresh replaced it — a
    // pre-await binding would hand back the very object that was just busted.
    expect(await mgr.connect()).toEqual({ status: "connected", schema: SAMPLE_SCHEMA_V2 });
    expect(counts.listSchema).toBe(2);
  });

  test("two concurrent getSchema calls after ONE invalidateSchema share a single listSchema", async () => {
    const { factory, counts, state } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    await mgr.getSchema();
    state.schema = SAMPLE_SCHEMA_V2;
    const gate = deferred();
    state.gate = gate.promise;
    mgr.invalidateSchema();

    const a = mgr.getSchema();
    const b = mgr.getSchema(); // arrives while the refresh is still gated
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toEqual(SAMPLE_SCHEMA_V2);
    expect(rb).toEqual(SAMPLE_SCHEMA_V2);
    expect(counts.listSchema).toBe(2); // the initial open + exactly ONE refresh
  });

  test("a failing refresh is asymmetric: connect() reports neutral 'failed', getSchema() rejects, both stay retryable", async () => {
    const { factory, counts, state } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    await mgr.connect();
    mgr.invalidateSchema();

    // `connect` is documented never to throw for a classified driver failure.
    state.nextError = new DriverConnectionError("network", "unreachable");
    const failed = await mgr.connect();
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.failure).toBe("network");
      // Neutral: the held url/credentials never ride the message.
      expect(failed.message).not.toContain("p@h");
    }

    // The read path's contract is the opposite — an unusable schema read throws.
    state.nextError = new DriverConnectionError("network", "unreachable");
    await expect(mgr.getSchema()).rejects.toBeInstanceOf(DriverConnectionError);

    // Neither failure cleared the stale flag, so the next read still retries and lands.
    state.schema = SAMPLE_SCHEMA_V2;
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA_V2);
    expect(counts.listSchema).toBe(4); // open + two failed refreshes + the successful one
  });

  test("an invalidation raised DURING a refresh is NOT swallowed by that refresh's answer", async () => {
    const { factory, counts, state } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA); // the memo: [users]

    // `CREATE TABLE orders` commits → a reader starts the refresh the DB will answer with
    // V2, and that answer is parked in flight.
    state.schema = SAMPLE_SCHEMA_V2;
    mgr.invalidateSchema();
    const gate = deferred();
    state.gate = gate.promise;
    const reading = mgr.getSchema();
    await Promise.resolve(); // the refresh is now inside `listSchema`, holding the gate
    expect(counts.listSchema).toBe(2);

    // `CREATE TABLE receipts` commits WHILE that answer is still in flight.
    state.schema = SAMPLE_SCHEMA_V3;
    mgr.invalidateSchema();

    state.gate = null;
    gate.resolve();
    await reading;

    // The landing answer predates `receipts`, so it must not have cleared the stale flag.
    // Without the generation guard it does: `cached` becomes V2 forever, `receipts` never
    // appears, and nothing ever re-introspects again (DW-45, silently back).
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA_V3);
    expect(counts.listSchema).toBe(3); // open + the raced refresh + the one that covers it
  });

  test("a refresh that lands after close() never resurrects the memo", async () => {
    const { factory, counts, state } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    expect(await mgr.connect()).toEqual({ status: "connected", schema: SAMPLE_SCHEMA });
    state.schema = SAMPLE_SCHEMA_V2;
    mgr.invalidateSchema();

    const gate = deferred();
    state.gate = gate.promise;
    // Starts the refresh, then parks inside `listSchema`. The racing reader's OWN outcome
    // is irrelevant here (the shutdown may well make it throw), so it is swallowed up front.
    const reading = mgr.getSchema().catch(() => undefined);
    await Promise.resolve();

    // Shutdown begins while that refresh is in flight (the same window `core.stop()` and
    // `connection-targets`' fire-and-forget `evict()` open on a repoint).
    const closing = mgr.close();
    state.gate = null;
    gate.resolve();
    await expect(closing).resolves.toBeUndefined(); // close awaits it and never throws
    await reading;

    // The memo must NOT have been rebuilt behind the shutdown: a later connect answers the
    // documented neutral failure instead of "connected" over a driver already released.
    expect(await mgr.connect()).toEqual({
      status: "failed",
      failure: "network",
      message: "connection is unavailable",
    });
    await expect(mgr.getSchema()).rejects.toThrow();
    expect(counts.listSchema).toBe(2); // open + the one refresh; nothing re-opened after close
  });

  test("getEngine does NOT honor the stale flag — N busts cost ONE re-introspection, not N", async () => {
    const { factory, counts, state } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    expect(await mgr.getEngine()).toBe("postgres");
    expect(counts.listSchema).toBe(1); // just the lazy open's own introspection

    // Five confirmed statements, each busting the memo, each starting with a `getEngine`
    // (`executor.ts`'s raw path does). The engine is fixed by the url scheme, so not one of
    // them may re-introspect — routing it through `getSchema` cost FIVE `listSchema`s.
    for (let i = 0; i < 5; i++) {
      mgr.invalidateSchema();
      expect(await mgr.getEngine()).toBe("postgres");
    }
    expect(counts.listSchema).toBe(1);

    // …and the bust is still pending: the next real catalog read pays exactly ONE refresh.
    state.schema = SAMPLE_SCHEMA_V2;
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA_V2);
    expect(counts.listSchema).toBe(2);
  });

  test("a writer that out-runs introspection cannot hang a reader — the refresh loop is bounded", async () => {
    const { factory, counts, state } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA);
    expect(counts.listSchema).toBe(1);

    // Sustained schema-mutating traffic: every `execute` success invalidates, and here one
    // lands inside every introspection — so no answer is ever current and the commit guard
    // rejects each one. The loop that re-arms on a rejected answer then has no exit unless
    // it is bounded: before the fix this single `getSchema()` re-introspected forever
    // (measured: 200+ calls and still going), hanging the read path outright.
    state.onIntrospect = () => mgr.invalidateSchema();
    mgr.invalidateSchema();

    // Settles — that is the whole point — serving the memo it has rather than chasing a
    // catalog that keeps moving.
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA);
    expect(counts.listSchema).toBe(4); // the open + a bounded three turns, not unbounded

    // …and the staleness it accepted is BOUNDED, not lost: the flag stayed set, so the
    // first read after the write storm ends re-introspects and returns the new catalog.
    state.onIntrospect = null;
    state.schema = SAMPLE_SCHEMA_V2;
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA_V2);
    expect(counts.listSchema).toBe(5);
  });

  test("a connect() parked on a refresh that close() drains resolves the neutral failure, never null", async () => {
    const { factory, state } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    expect(await mgr.connect()).toEqual({ status: "connected", schema: SAMPLE_SCHEMA });
    state.schema = SAMPLE_SCHEMA_V2;
    mgr.invalidateSchema();

    // A `connect` takes the idempotent branch, honors the pending invalidation, and parks
    // inside the refresh's `listSchema`.
    const gate = deferred();
    state.gate = gate.promise;
    const connecting = mgr.connect();
    await Promise.resolve();

    // Shutdown begins in that window — `core.stop()`, or `connection-targets`' fire-and-
    // forget `evict()` on a repoint. `close()` latches, drains the refresh, and NULLS the
    // memo the parked `connect` is about to re-read.
    const closing = mgr.close();
    state.gate = null;
    gate.resolve();
    await closing;

    // The compiler cannot catch this one: TypeScript keeps the narrowing from the
    // `cached !== null` test across the await, so before the fix this resolved `null` and
    // the RPC layer shipped `result: null` to a UI that reads `reply.result.status`.
    const result = await connecting;
    expect(result).not.toBeNull();
    expect(result).toEqual({
      status: "failed",
      failure: "network",
      message: "connection is unavailable",
    });
  });

  test("invalidateSchema on a never-connected manager is a harmless no-op", async () => {
    const { factory, counts } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    expect(() => mgr.invalidateSchema()).not.toThrow();
    expect(counts.listSchema).toBe(0); // a pure flag set — it opens nothing
    // The first real read still introspects exactly once.
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA);
    expect(counts.listSchema).toBe(1);
  });

  test("invalidateSchema on a CLOSED manager is a harmless no-op (never re-opens a driver)", async () => {
    const { factory, counts } = refreshableDriver();
    const mgr = createConnectionManager({ databaseUrl: "postgres://u:p@h/db", createDriver: factory });

    await mgr.connect();
    await mgr.close();
    expect(() => mgr.invalidateSchema()).not.toThrow();
    // The shutdown latch still wins: the read path refuses, and nothing re-introspects.
    await expect(mgr.getSchema()).rejects.toThrow();
    expect(counts.listSchema).toBe(1);
  });
});

describe("connection manager — pinned schema scope (Story 10.2)", () => {
  test("the configured schema reaches Driver.listSchema", async () => {
    const { factory, calls } = recordingDriver();
    const mgr = createConnectionManager({
      databaseUrl: "postgres://u:p@h/db",
      schema: "reporting",
      createDriver: factory,
    });

    await mgr.connect();
    expect(calls).toEqual(["reporting"]);
  });

  test("omitting the schema passes `undefined` — the engine-default scope, unchanged", async () => {
    const { factory, calls } = recordingDriver();
    const mgr = createConnectionManager({
      databaseUrl: "postgres://u:p@h/db",
      createDriver: factory,
    });

    await mgr.connect();
    expect(calls).toEqual([undefined]);
    // The memoized read never re-introspects, so the scope cannot drift.
    expect(await mgr.getSchema()).toEqual(SAMPLE_SCHEMA);
    expect(calls).toEqual([undefined]);
  });
});
