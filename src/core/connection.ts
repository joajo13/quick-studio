/**
 * quick-studio Core — connection manager (memory-only, idempotent).
 *
 * Owns the Core-held Ephemeral database connection lifecycle. It threads the
 * in-memory `databaseUrl` (never persisted, never logged) to the uniform driver,
 * opening the connection LAZILY and exactly ONCE — a second `connect` returns the
 * cached {@link ConnectResult} without re-opening. Domain failures (host / auth /
 * network / unsupported-scheme) are returned as a `status:"failed"` payload, never
 * thrown; only a genuine bug propagates (→ `internal_error` at the RPC boundary).
 * `close` releases any open driver on shutdown so nothing lingers past `stop()`.
 *
 * DI seam: `createDriver` is injectable (mirroring `credential-store` /
 * `browser-open`), so every test drives a FAKE driver — no live Postgres/MySQL.
 */

import type { ConnectResult, DatabaseSchema } from "../shared/contract.ts";
import {
  DriverConnectionError,
  createDriver as realCreateDriver,
  type Driver,
  type DriverFactory,
  type DriverQueryResult,
} from "./driver.ts";

/** The live connection manager handle returned by {@link createConnectionManager}. */
export type ConnectionManager = {
  /**
   * Open (once) and introspect the connection, returning a neutral
   * {@link ConnectResult}. Idempotent: subsequent calls reuse the live connection
   * and the cached result.
   */
  connect(): Promise<ConnectResult>;
  /**
   * The introspected schema of the live connection (Story 3.2). Opens the driver
   * lazily+once (shares `connect`'s memoization) and returns the cached schema.
   * Throws if the connection cannot be opened or was closed — surfaced as
   * `internal_error` at the RPC boundary, never a leaked credential.
   */
  getSchema(): Promise<DatabaseSchema>;
  /**
   * Run a row-returning query on the live connection (Story 3.2 browse path).
   * Opens the driver lazily+once; throws if unopenable or closed. The caller
   * (Core) composes the only SQL — no user value is ever passed as raw text.
   */
  query(text: string, params?: ReadonlyArray<unknown>): Promise<DriverQueryResult>;
  /**
   * Run a statement inside an engine READ-ONLY transaction (rolled back) on the live
   * connection — the seam feeding the executor's `runReadOnly` auto-classified-read
   * path (Story 3.1). Opens the driver lazily+once; throws if unopenable or closed.
   */
  queryReadOnly(text: string, params?: ReadonlyArray<unknown>): Promise<DriverQueryResult>;
  /**
   * Quote an identifier via the live driver's engine rules. Requires an already-
   * open driver (call after {@link ConnectionManager.getSchema}); throws otherwise.
   */
  quoteIdent(ident: string): string;
  /** Close any open driver. Idempotent; swallows teardown errors. */
  close(): Promise<void>;
};

/** Dependencies for {@link createConnectionManager}. `createDriver` is the test seam. */
export type ConnectionManagerDeps = {
  /** The in-memory Ephemeral URL, or `null`/`undefined` when no target is configured. */
  readonly databaseUrl?: string | null | undefined;
  /** Driver factory. Defaults to the real scheme-selecting {@link realCreateDriver}. */
  readonly createDriver?: DriverFactory;
};

/**
 * Build the Core's connection manager. Holds the URL in a closure (never on
 * `Core`, never logged) and memoizes the first successful connection so
 * `connect` is idempotent. A failed attempt is NOT cached — it returns the
 * classified failure but leaves the manager retryable.
 */
export function createConnectionManager(
  deps: ConnectionManagerDeps,
): ConnectionManager {
  const databaseUrl = deps.databaseUrl ?? null;
  const createDriver = deps.createDriver ?? realCreateDriver;

  let driver: Driver | null = null;
  let cached: ConnectResult | null = null;
  // Memoizes the FIRST in-flight open so concurrent `connect` RPCs (the dispatch
  // is async and `Bun.serve` is concurrent) share one attempt instead of each
  // opening — and leaking — its own driver. Cleared once the attempt settles.
  let inflight: Promise<ConnectResult> | null = null;
  // Latched by `close()`: no new connection is opened after shutdown begins.
  let closed = false;

  /** Best-effort driver teardown — never throws (shutdown must not be blocked). */
  async function safeClose(d: Driver): Promise<void> {
    try {
      await d.close();
    } catch {
      /* best-effort */
    }
  }

  /**
   * Open + introspect exactly one connection, closing the driver on ANY failure
   * so nothing is orphaned (a failed connect, or a `listSchema` throw after the
   * socket opened, would otherwise leak the live connection).
   */
  async function open(url: string): Promise<ConnectResult> {
    let d: Driver;
    try {
      // `createDriver` may throw `unsupported_scheme` BEFORE any driver/socket exists.
      d = createDriver(url);
    } catch (err) {
      if (err instanceof DriverConnectionError) {
        return { status: "failed", failure: err.kind, message: err.message };
      }
      throw err;
    }
    try {
      await d.connect();
      const schema = await d.listSchema();
      driver = d;
      cached = { status: "connected", schema };
      return cached;
    } catch (err) {
      // Close the half-open / allocated driver before surfacing the outcome.
      await safeClose(d);
      // Classified driver failure → neutral payload (no URL, no credentials).
      if (err instanceof DriverConnectionError) {
        return { status: "failed", failure: err.kind, message: err.message };
      }
      // Anything else is a genuine bug — let it reach `dispatch` → internal_error.
      throw err;
    }
  }

  /** The public `connect` body — extracted so `getSchema`/`query` can share it. */
  async function doConnect(): Promise<ConnectResult> {
    // Idempotent: reuse the live connection + cached success.
    if (cached !== null) return cached;
    // After shutdown, never re-open. Neutral, handled — never a throw.
    if (closed) {
      return { status: "failed", failure: "network", message: "connection is unavailable" };
    }
    // A concurrent attempt is already open — join it instead of opening a second.
    if (inflight !== null) return inflight;

    // No target configured (e.g. a Persistent boot with no URL). This is a
    // domain failure, handled — never a throw. `unsupported_scheme` is the
    // closest neutral bucket for "there is nothing to connect to".
    if (databaseUrl === null) {
      return {
        status: "failed",
        failure: "unsupported_scheme",
        message: "no connection target configured",
      };
    }

    inflight = open(databaseUrl);
    try {
      return await inflight;
    } finally {
      // A failed attempt is NOT cached — clearing `inflight` leaves it retryable.
      inflight = null;
    }
  }

  /**
   * Resolve the live {@link Driver}, opening it via `doConnect` if needed. Unlike
   * the neutral `connect` payload, the read path (browse) needs a hard failure when
   * there is no usable connection, so a non-`connected` outcome throws here (→
   * `internal_error`). The message stays neutral — no URL, no credentials.
   */
  async function ensureDriver(): Promise<Driver> {
    if (closed) throw new Error("connection is unavailable (shutting down)");
    if (driver !== null) return driver;
    const result = await doConnect();
    if (result.status === "connected" && driver !== null) return driver;
    throw new Error(
      result.status === "failed"
        ? `connection unavailable (${result.failure})`
        : "connection unavailable",
    );
  }

  return {
    connect: doConnect,

    async getSchema(): Promise<DatabaseSchema> {
      await ensureDriver();
      // `ensureDriver`→`doConnect` populates `cached` with the introspected schema
      // on success, so this is a memoized read (no re-introspection per call).
      if (cached !== null && cached.status === "connected") return cached.schema;
      // Defensive: a live driver with no cached schema (shouldn't happen) — introspect.
      return ensureDriver().then((d) => d.listSchema());
    },

    async query(text: string, params?: ReadonlyArray<unknown>): Promise<DriverQueryResult> {
      const d = await ensureDriver();
      return d.query(text, params);
    },

    async queryReadOnly(text: string, params?: ReadonlyArray<unknown>): Promise<DriverQueryResult> {
      const d = await ensureDriver();
      return d.queryReadOnly(text, params);
    },

    quoteIdent(ident: string): string {
      if (driver === null) {
        throw new Error("quoteIdent requires an open connection");
      }
      return driver.quoteIdent(ident);
    },

    async close(): Promise<void> {
      closed = true;
      // Wait for any in-flight open to settle first, so its `driver = d` assignment
      // cannot land AFTER we read `driver` below and leak past `stop()`.
      const pending = inflight;
      if (pending !== null) {
        try {
          await pending;
        } catch {
          /* the open's own failure path already closed its driver */
        }
      }
      const d = driver;
      driver = null;
      cached = null;
      if (d !== null) await safeClose(d);
    },
  };
}
