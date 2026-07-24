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

import type { ConnectResult, DatabaseSchema, DbEngine } from "../shared/contract.ts";
import {
  SAFE_FALLBACK_SESSION_MODES,
  DriverConnectionError,
  createDriver as realCreateDriver,
  type Driver,
  type DriverFactory,
  type DriverQueryResult,
  type SessionModes,
} from "./driver.ts";

/**
 * Thrown by the read path (`getSchema`/`query`/`queryReadOnly` via `ensureDriver`)
 * when there is NO connection target configured at all (`databaseUrl === null`) — the
 * normal shape of a Persistent boot before any connection is saved. A TYPE (not a
 * message string) so read-path callers can `instanceof`-branch it into a neutral
 * `bad_request` "no active connection" reply instead of letting it degrade into the
 * generic `internal_error` catch-all. The message stays credential-free.
 */
export class NoConnectionTargetError extends Error {
  constructor() {
    super("no connection target configured");
    this.name = "NoConnectionTargetError";
  }
}

/** The live connection manager handle returned by {@link createConnectionManager}. */
export type ConnectionManager = {
  /**
   * Open (once) and introspect the connection, returning a neutral
   * {@link ConnectResult}. Idempotent: subsequent calls reuse the live connection
   * and the cached result — re-introspecting first when {@link
   * ConnectionManager.invalidateSchema} marked it stale, so the result carries the
   * current catalog. After {@link ConnectionManager.close} it stops serving the memo
   * and answers the neutral `{status:"failed", failure:"network"}` "connection is
   * unavailable" payload instead, so a call that races shutdown never reports a
   * connection that is already being released. Never throws for a classified driver
   * failure — that is the payload, not an exception.
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
   * The engine of the live connection (`postgres` / `mysql`). Opens the driver
   * lazily+once — which is what populates the memo — and then reads the engine straight
   * off that memo, deliberately WITHOUT honoring the stale flag: the engine is a property
   * of the CONNECTION (fixed by its url scheme), not of the catalog, so no DDL can change
   * it and a stale memo is a perfectly valid source for it. (Opening a cold connection
   * still introspects once, exactly as `connect`/`getSchema` do; what this seam avoids is
   * every SUBSEQUENT call.) Routing it through {@link ConnectionManager.getSchema} instead
   * would make every statement after a schema-mutating one pay a FULL re-introspection
   * just to learn a value that never changes (five introspection queries on Postgres,
   * serialized before the statement) — N confirmed statements would cost N
   * re-introspections. Throws if the connection cannot be opened or was closed, exactly
   * like `getSchema`.
   */
  getEngine(): Promise<DbEngine>;
  /**
   * The connection's detected SQL-parsing modes (DW-39) — the inputs the raw-statement
   * splitter needs beyond the engine. Opens the driver lazily+once (which populates the
   * memo) and reads the modes straight off the driver, deliberately WITHOUT honoring the
   * stale flag: like {@link ConnectionManager.getEngine}, modes are a property of the
   * CONNECTION (fixed at connect — no `SET` is issued, no DDL changes them), not of the
   * catalog, so `refreshIfStale` is irrelevant and a schema-mutating statement never
   * re-probes them. Throws if the connection cannot be opened or was closed, exactly like
   * `getEngine`.
   */
  getSessionModes(): Promise<SessionModes>;
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
  /**
   * Mark the memoized schema STALE (DW-45) so the next {@link ConnectionManager.getSchema}
   * / {@link ConnectionManager.connect} re-introspects instead of serving the memo — the
   * seam a successful schema-mutating `execute` fires against the connection it just
   * mutated. A PURE flag set: opens no driver, runs no query, never throws, and is inert
   * on a never-connected or closed manager (there is no memo to bust). Deliberately NOT
   * an eviction: the memo lives in this closure and `close()` is latched+permanent, so
   * eviction cannot serve the boot manager (which the Core owns for the whole session).
   */
  invalidateSchema(): void;
  /**
   * Derive a credential-free descriptor of the in-memory active target from the
   * closure-held url (Story 8.7). Pure + synchronous: opens NO driver, forces no
   * `connect`, mutates no cached state. Returns `null` when no url is configured or the
   * url is hostless (e.g. `postgres:///shop` — the reachable broken-target case); also,
   * for an unparseable url, which the CLI rejects long before a manager exists (see
   * {@link ConnectionManager.hasTarget}) — guarded, degrade-not-throw. Exposes ONLY `engine`/`host`
   * (+ optional non-sensitive `database`) — the raw url, user, and password never
   * leave this closure, mirroring the {@link ConnectionSummary} boundary.
   */
  describe(): { engine: string; host: string; database?: string } | null;
  /**
   * Whether a connection target is CONFIGURED at all (Story 10.5) — `databaseUrl !== null`,
   * nothing more. Pure + synchronous: opens no driver, parses nothing, never throws. It
   * exists because {@link ConnectionManager.describe} answers `null` for BOTH "no url" and
   * "a url I cannot describe", which left the UI unable to distinguish a boot with nothing
   * configured from a boot configured with a broken url. The one REACHABLE broken case is a
   * url that PARSES but has no host (e.g. `postgres:///shop`), which `describe` rejects by
   * its own host guard. (An unparseable url is `describe`-less too, but it never reaches a
   * running manager from the CLI: `cli-args.ts:104-114` shape-checks the positional url with
   * `new URL()` and throws `CliArgsError` → `exit(1)` first — true, but unreachable.) A bare
   * boolean, deliberately not a tri-state: what the target IS remains `describe`'s job, and
   * whether it WORKS remains `connect`'s.
   */
  hasTarget(): boolean;
  /** Close any open driver. Idempotent; swallows teardown errors. */
  close(): Promise<void>;
};

/** Dependencies for {@link createConnectionManager}. `createDriver` is the test seam. */
export type ConnectionManagerDeps = {
  /** The in-memory Ephemeral URL, or `null`/`undefined` when no target is configured. */
  readonly databaseUrl?: string | null | undefined;
  /**
   * The saved connection's pinned introspection scope (Story 10.2), forwarded to
   * `Driver.listSchema`. `undefined` (the boot manager's case — a CLI `--url` has no
   * saved record) keeps the pre-10.2 engine-default scope.
   */
  readonly schema?: string | undefined;
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
  const pinnedSchema = deps.schema;
  const createDriver = deps.createDriver ?? realCreateDriver;

  let driver: Driver | null = null;
  let cached: ConnectResult | null = null;
  // Memoizes the FIRST in-flight open so concurrent `connect` RPCs (the dispatch
  // is async and `Bun.serve` is concurrent) share one attempt instead of each
  // opening — and leaking — its own driver. Cleared once the attempt settles.
  let inflight: Promise<ConnectResult> | null = null;
  // Latched by `close()`: no new connection is opened after shutdown begins.
  let closed = false;
  // DW-45: set by `invalidateSchema()` when something (a schema-mutating `execute`)
  // has made the memoized `cached.schema` a lie. Cleared only by a SUCCESSFUL
  // re-introspection, so a failed refresh stays retryable instead of silently
  // re-serving the stale memo forever.
  let schemaStale = false;
  // Memoizes the in-flight re-introspection so N concurrent readers arriving after one
  // `invalidateSchema()` share ONE `listSchema` — the same single-flight discipline
  // `inflight` gives the initial open.
  let refreshing: Promise<void> | null = null;
  // Bumped by EVERY `invalidateSchema()`. An introspection captures this counter BEFORE
  // awaiting `listSchema` and may only COMMIT its answer (write `cached`, clear the stale
  // flag) if the counter is unchanged when it lands. Without it the memo has a lost-update
  // window that silently resurrects DW-45: `CREATE TABLE b` → invalidate → a reader starts
  // a refresh the DB will answer `[a,b]` → `CREATE TABLE c` commits and invalidates while
  // that answer is still in flight → the refresh lands, writes `[a,b]` and clears the flag,
  // so `c` never appears and nothing will ever re-introspect again.
  let schemaGeneration = 0;
  // Ceiling on how many turns ONE `refreshIfStale` call may spend chasing a current answer
  // before it settles for the memo it has. The loop below only makes progress while
  // introspection out-runs invalidation; sustained schema-mutating traffic on a target
  // (every success invalidates) inverts that, and WITHOUT this bound a single
  // `getSchema()`/`connect()` never resolves — an unbounded hang on the read path, not a
  // slow read. Measured against a driver that invalidates once per in-flight `listSchema`:
  // one reader re-introspected indefinitely. On giving up the stale flag stays SET, so this
  // caller knowingly serves a memo at most a few DDLs behind and the NEXT reader picks the
  // chase back up — bounded staleness is the cheaper failure than bounded-by-nothing latency.
  // Three turns covers the real cases: a lone reader commits on turn 1, and a reader that
  // joins someone else's already-in-flight (therefore possibly stale) answer still gets its
  // own introspection on turn 2.
  const MAX_REFRESH_TURNS = 3;

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
    // Captured BEFORE the awaits: an invalidation raised while this open is in flight
    // describes a catalog change this `listSchema` may not have seen, so it must NOT be
    // swallowed by the `schemaStale = false` below (the same lost update `refreshIfStale`
    // guards against, reachable here because `open` also commits an introspection).
    const generation = schemaGeneration;
    try {
      await d.connect();
      const schema = await d.listSchema(pinnedSchema);
      driver = d;
      cached = { status: "connected", schema };
      // This memo was just built from a live introspection, so it satisfies any
      // invalidation raised before the connection was ever opened — leaving the flag set
      // would make the very first read re-introspect a schema it just fetched. But only
      // invalidations OLDER than this introspection are satisfied: a newer one leaves the
      // flag set so the next read re-introspects (`cached` still lands, so the connection
      // is usable either way).
      if (schemaGeneration === generation) schemaStale = false;
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

  /**
   * Re-introspect IN PLACE when the memo was marked stale (DW-45), replacing `cached`
   * with a fresh `{status:"connected", schema}` under the SAME pinned scope, so the
   * scope can never widen on a refresh. A no-op when nothing is stale. Single-flight:
   * concurrent callers join the one in-flight `listSchema`. On failure the flag stays
   * set (the next read retries) and `cached` is left intact — the caller decides
   * whether that surfaces as a throw (`getSchema`) or a neutral payload (`connect`).
   *
   * The LOOP is the lost-update fix: an introspection only satisfies the invalidations
   * that predate it, so a caller whose invalidation landed while the joined refresh was
   * already in flight is handed a provably-stale answer. Such a caller re-checks the flag
   * and starts its OWN introspection instead of accepting it — otherwise the newest DDL
   * would be invisible forever (nothing else ever re-arms the flag). It is bounded by
   * {@link MAX_REFRESH_TURNS} so a writer that out-runs introspection can never hang a
   * reader; see that constant for why bounded staleness is the right side to fail on.
   */
  async function refreshIfStale(d: Driver): Promise<void> {
    // `closed` stops the loop: after shutdown there is nothing left to refresh, and
    // re-introspecting over a released driver would only resurrect a dead memo. Joining
    // someone else's flight counts as a turn too — otherwise a caller could sit in the
    // join branch forever while other callers keep installing newer flights.
    for (let turn = 0; schemaStale && !closed && turn < MAX_REFRESH_TURNS; turn++) {
      const pending = refreshing;
      if (pending !== null) {
        // Join the single flight, then re-test the flag: still set ⇒ that answer did not
        // cover our invalidation, so the next turn of the loop introspects again.
        await pending;
        continue;
      }
      const generation = schemaGeneration;
      const run = (async () => {
        const schema = await d.listSchema(pinnedSchema);
        // COMMIT GUARD. Skip when something invalidated while `listSchema` was in flight
        // (this answer predates that change), and skip when the manager was closed
        // meanwhile — writing `cached` there would resurrect the memo of a torn-down
        // connection and make a later `connect()` answer "connected" over a dead driver.
        if (schemaGeneration !== generation || closed) return;
        cached = { status: "connected", schema };
        // Cleared only here — AFTER a successful, still-current introspection.
        schemaStale = false;
      })();
      refreshing = run;
      try {
        await run;
      } finally {
        // Only the owner clears its own flight (a later iteration may have installed a
        // newer one; dropping that would let two introspections run concurrently).
        if (refreshing === run) refreshing = null;
      }
    }
  }

  /** The public `connect` body — extracted so `getSchema`/`query` can share it. */
  async function doConnect(): Promise<ConnectResult> {
    // After shutdown, never re-open — and never serve the memo either. This check sits
    // ABOVE the idempotent branch because `close()` latches `closed` BEFORE it awaits the
    // in-flight open/refresh and nulls `cached`: a `connect` landing inside that window
    // would otherwise hand back `{status:"connected"}` for a driver already being
    // released. Neutral, handled — never a throw.
    if (closed) {
      return { status: "failed", failure: "network", message: "connection is unavailable" };
    }
    // Idempotent: reuse the live connection + cached success.
    if (cached !== null) {
      // …but honor a pending invalidation first (DW-45), so a `connect` after a DDL
      // hands back the NEW catalog rather than the memo captured at first open.
      if (driver !== null) {
        try {
          await refreshIfStale(driver);
        } catch (err) {
          // `connect` is documented never to throw for a classified driver failure, so a
          // refresh that fails that way exits as the same neutral payload `open()` builds.
          // `cached` and `schemaStale` are untouched: the connection stays usable and the
          // next call retries the refresh.
          if (err instanceof DriverConnectionError) {
            return { status: "failed", failure: err.kind, message: err.message };
          }
          throw err;
        }
      }
      // Re-read AFTER the await: a successful refresh REPLACED `cached`, and returning
      // the pre-await binding would hand the caller the stale object it just busted.
      //
      // The re-read can come back NULL, and the compiler will not say so: TypeScript keeps
      // the narrowing from the `cached !== null` test above across the await, while
      // `close()` latches `closed`, awaits the in-flight refresh, and only THEN nulls
      // `cached` — so a `connect` parked on that very refresh resumes into a torn-down
      // manager. Reproduced: `connect()` resolved `null`, and the RPC layer wraps whatever
      // it gets (`okReply(await seams.connect())`), shipping `result: null` to a UI that
      // reads `reply.result.status`. Answer the same neutral shutdown failure the
      // `closed` guard at the top of this function returns.
      const fresh = cached;
      if (fresh === null) {
        return { status: "failed", failure: "network", message: "connection is unavailable" };
      }
      return fresh;
    }
    // A concurrent attempt is already open — join it instead of opening a second.
    if (inflight !== null) return inflight;

    // No target configured (e.g. a Persistent boot with no URL). This is a
    // domain failure, handled — never a throw. Its own `no-target` kind (not
    // `unsupported_scheme`) says "there is nothing to connect to", not "bad URL".
    if (databaseUrl === null) {
      return {
        status: "failed",
        failure: "no-target",
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
    // "No target configured" gets a TYPED throw so read-path callers can translate it
    // into a neutral `bad_request` "no active connection" instead of `internal_error`.
    if (result.status === "failed" && result.failure === "no-target") {
      throw new NoConnectionTargetError();
    }
    throw new Error(
      result.status === "failed"
        ? `connection unavailable (${result.failure})`
        : "connection unavailable",
    );
  }

  return {
    connect: doConnect,

    async getSchema(): Promise<DatabaseSchema> {
      const d = await ensureDriver();
      // DW-45: bust the memo BEFORE reading it when a schema-mutating statement marked
      // it stale. A refresh failure PROPAGATES here — unlike `connect`, the read path's
      // contract is "throw when the connection cannot serve a usable schema" — and
      // leaves the flag set so the next read retries.
      await refreshIfStale(d);
      // `ensureDriver`→`doConnect` populates `cached` with the introspected schema
      // on success, so this is a memoized read (no re-introspection per call).
      if (cached !== null && cached.status === "connected") return cached.schema;
      // Defensive: a live driver with no cached schema (shouldn't happen) — introspect
      // under the SAME pinned scope, so the fallback can never widen it.
      return ensureDriver().then((d) => d.listSchema(pinnedSchema));
    },

    async getEngine(): Promise<DbEngine> {
      // Opens the driver lazily+once (which also populates `cached` with the introspected
      // schema), then reads the engine off that memo. Deliberately WITHOUT `refreshIfStale`:
      // the engine is fixed by the connection's url scheme, so no DDL can change it, and
      // honoring the stale flag here would charge every statement after a schema-mutating
      // one a full re-introspection (N confirmed statements ⇒ N `listSchema`s) for a value
      // that is already known. A stale memo is a perfectly valid source for it.
      const d = await ensureDriver();
      if (cached !== null && cached.status === "connected") return cached.schema.engine;
      // Defensive: a live driver with no cached schema (shouldn't happen) — introspect
      // under the SAME pinned scope, mirroring `getSchema`'s own fallback.
      return (await d.listSchema(pinnedSchema)).engine;
    },

    async getSessionModes(): Promise<SessionModes> {
      // Modes are fixed at connect (a connection property, not catalog state) — like getEngine,
      // read them straight off the driver without honoring the stale flag. The `??` fallback is a
      // fake-driver concession only: every real adapter implements `sessionModes` (with its own
      // probe-failure safety), so this branch is unreachable in production. It resolves to the
      // over-reject-safe fallback (NOT DEFAULT) so that a hypothetical adapter omitting the method
      // fails CLOSED (backslash-literal ⇒ over-count) rather than assuming backslash-active — the
      // same fail-closed posture every probe-failure path already takes.
      const d = await ensureDriver();
      return d.sessionModes?.() ?? SAFE_FALLBACK_SESSION_MODES;
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

    invalidateSchema(): void {
      // Nothing but a flag + a counter bump: no driver open, no query, no throw — safe to
      // call from the executor's success path without widening what a mutation can fail on.
      // Inert when never connected or closed (`cached` is null, so the next read introspects
      // anyway).
      schemaStale = true;
      // The bump is what makes the flag survive an introspection that is ALREADY in flight:
      // that answer was fetched before this call, so it must not be allowed to commit and
      // clear the flag (see `schemaGeneration`). Monotonic, so no ABA on the guard.
      schemaGeneration++;
    },

    describe(): { engine: string; host: string; database?: string } | null {
      if (databaseUrl === null) return null;
      try {
        const u = new URL(databaseUrl);
        // Reject a hostless url (e.g. `foo:///bar`) so the derived `host` is always
        // meaningful — mirrors the registry's `checkUrl` host guard (connection-registry.ts).
        // Collapses the empty-host case into the clean "no active entry" path.
        if (u.host.length === 0) return null;
        return { engine: u.protocol.replace(/:$/, ""), host: u.host, database: u.pathname.slice(1) || undefined };
      } catch {
        return null;
      }
    },

    hasTarget(): boolean {
      // Existence only — the url is never parsed here, so a HOSTLESS target (the reachable
      // broken case, e.g. `postgres:///shop`) still answers `true`, which is the whole
      // point: `describe()` cannot say so. An unparseable url answers `true` as well, but
      // the CLI rejects that one before any manager exists (`cli-args.ts:104-114`).
      return databaseUrl !== null;
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
      // Same hazard from the OTHER direction: a re-introspection that settles AFTER the
      // `cached = null` below would resurrect the memo of a torn-down manager, and the
      // next `connect()` would answer `{status:"connected"}` over a driver we already
      // closed instead of the documented "connection is unavailable" failure. The commit
      // guard in `refreshIfStale` already refuses to write once `closed` is latched;
      // waiting here drains the flight we can see so it is not still reading the driver we
      // are about to release. Note what actually makes that total: `closed` is latched
      // ABOVE, and `refreshIfStale`'s loop tests it, so no NEW flight can start after this
      // point — the single flight captured here is therefore the last one. Loosen that loop
      // condition and this await stops being sufficient. Its failure is swallowed —
      // shutdown must never be blocked by, or made to throw from, a refresh nobody is
      // waiting on any more.
      const refresh = refreshing;
      if (refresh !== null) {
        try {
          await refresh;
        } catch {
          /* a failed refresh holds nothing to release */
        }
      }
      const d = driver;
      driver = null;
      cached = null;
      if (d !== null) await safeClose(d);
    },
  };
}
