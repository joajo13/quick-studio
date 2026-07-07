---
title: 'Story 1.3 — Connect to PostgreSQL and MySQL through one engine-neutral driver'
type: 'feature'
created: '2026-07-07'
status: 'done'
baseline_revision: 'd4f11177512d31eb3511e0d3457fb87a00eaad2e'
final_revision: '4fefa47c93cf0ccf4f3f7a274a82e0b150278885'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The Core carries an Ephemeral database URL (Story 1.2 parses it, but `bin/` currently drops it and never threads it into `startCore`) and has no way to open a real connection or read a schema. There is no driver, no `postgres`/`mysql2` dependency, and no engine-neutral schema shape the UI (Ring 2) can consume. Story 1.3 delivers the epic's "run with a URL → see the schema" loop (UJ-1, AR-10).

**Approach:** Thread the in-memory `databaseUrl` `bin/` → `startCore` → a Core-owned connection manager. Add one uniform `Driver` interface with a `postgres.js` adapter and a `mysql2` adapter, selected by URL scheme. A new `connect` RPC opens the connection (lazily, once), introspects the schema, and returns a single engine-neutral `DatabaseSchema`; on failure it returns a classified `ConnectResult` distinguishing host vs auth vs network vs unsupported-scheme. All engine specifics stay behind the driver inside Core.

## Boundaries & Constraints

**Always:**
- One uniform `Driver` interface; all engine-specific SQL, introspection, and error classification live only in Core behind it. Ring 2 sees a single engine-neutral shape (`DatabaseSchema`) regardless of engine (AR-10).
- Engine is chosen by URL scheme: `postgres`/`postgresql` → postgres.js, `mysql` → mysql2. Any other scheme (`file:`, `javascript:`, `data:`, Windows drive `C:\…`) is refused as `unsupported_scheme` with a clear message — this is the sanctioned rejection point for the shallow URL from Story 1.2 (deferred-work item).
- A failed connection returns a classified outcome distinguishing **host** (DNS/unknown host), **auth** (bad credentials), and **network** (refused/timeout/reset) — plus `unsupported_scheme` — never a raw engine exception.
- The database URL and credentials live only in Core memory; they are NEVER logged, echoed into any error `message`, persisted, or exposed on `Core`.
- `connect` is idempotent: a live connection is opened once and reused. DB identifiers (table/column names, type names) mirror the live database verbatim.
- Any open connection/pool is closed on Core shutdown — no socket or driver lingers past `stop()`.
- New dependencies pinned to the stack seed: `postgres` 3.x, `mysql2` 3.22.5. Module files kebab-case; imports use explicit `.ts` paths and `import type` for type-only.

**Block If:**
- Planning artifacts contradict the single engine-neutral schema shape (AR-10) or the PostgreSQL+MySQL-only scope.
- The three-ring model is found to forbid Core holding a live DB pool or the ephemeral URL in memory across the boot→RPC lifetime.

**Never:**
- No row browsing, pagination, query execution, or result-set shipping — schema listing only (that is Epic 3). No live row data flows in this story.
- No credential-store / stored-connection / keychain wiring — `connect` uses only the in-memory ephemeral URL (Epic 2 wires stored connections).
- No NoSQL. No connection retry/backoff/pool-tuning policy beyond a single connect → introspect → reuse → close.
- No change to the session-token or Origin/Host auth model; the new RPC rides the existing gate.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Postgres happy path | Core holds valid `postgres://…`; `connect` RPC | `RpcReply.ok`; `result.status:"connected"`; `schema.engine:"postgres"`; tables/columns listed neutrally | No error expected |
| MySQL happy path | valid `mysql://…`; `connect` RPC | `status:"connected"`; `schema.engine:"mysql"`; same neutral shape | No error expected |
| Auth failure | wrong user/password URL | `status:"failed"`, `failure:"auth"`, clear message, no credentials in message | PG `28P01`/`28000`, MySQL `ER_ACCESS_DENIED_ERROR`/`1045` → auth |
| Unknown host | URL host that does not resolve | `status:"failed"`, `failure:"host"` | `ENOTFOUND`/`EAI_AGAIN` → host |
| Network unreachable | host resolves, port closed / times out | `status:"failed"`, `failure:"network"` | `ECONNREFUSED`/`ETIMEDOUT`/`ECONNRESET`/timeout → network |
| Unsupported scheme | `file:///etc/passwd`, `C:\db` carried from 1.2 | `status:"failed"`, `failure:"unsupported_scheme"`, clear message | `createDriver` refuses before any connect |
| No target configured | Persistent boot, no `databaseUrl`; `connect` RPC | `status:"failed"` with clear "no connection target" message | Handled, not thrown |
| Idempotent connect | `connect` RPC called twice | Second call reuses the live connection; `driver.connect` runs once | No error expected |
| Shutdown with open connection | `stop()` after a successful `connect` | `driver.close()` invoked; pool/socket ends; nothing lingers | Swallow close errors, never block shutdown |

</intent-contract>

## Code Map

- `bin/quick-studio.ts` -- pass `databaseUrl: cli.databaseUrl` into `startCore` options (today it drops it).
- `src/core/cli-args.ts` -- REUSE: already produces `cli.databaseUrl` (memory-only). No change.
- `src/shared/contract.ts` -- ADD engine-neutral types: `DbEngine`, `SchemaColumnInfo`, `SchemaTableInfo`, `DatabaseSchema`, `ConnectionFailureKind`, `ConnectResult`. Follow the `Frozen*` readonly style.
- `src/core/driver.ts` -- NEW: `Driver` interface, `DriverFactory` type, `DriverConnectionError` (typed, carries `kind` + neutral message), `createDriver(url)` (scheme allowlist → adapter), `classifyConnectionError(err): ConnectionFailureKind` (pure).
- `src/core/driver-postgres.ts` -- NEW: postgres.js adapter (`connect`/`listSchema`/`close`); introspect via `information_schema.columns` excluding system schemas.
- `src/core/driver-mysql.ts` -- NEW: mysql2 adapter; introspect the URL's database via `information_schema.columns`.
- `src/core/connection.ts` -- NEW: `createConnectionManager({ databaseUrl, createDriver })` → `{ connect(): Promise<ConnectResult>, close(): Promise<void> }`; idempotent, memory-only, never logs the URL.
- `src/core/rpc.ts` -- make `Handler` allow async; make `dispatch` async and `await` the handler; extend `RpcContext` with `connect: () => Promise<ConnectResult>`; register the `connect` handler.
- `src/core/server.ts` -- add `databaseUrl?: string` and (for tests) `createDriver?: DriverFactory` to `StartCoreOptions`; build the connection manager; add `connect` to `rpcContext`; `await dispatch(...)`; close the manager in `stop()`.
- `package.json` -- add `postgres` (^3) and `mysql2` (3.22.5).

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- add deps `postgres@^3` and `mysql2@3.22.5` (via `bun add postgres mysql2@3.22.5`) -- driver runtimes; none present today.
- [x] `src/shared/contract.ts` -- add `DbEngine = "postgres" | "mysql"`; `SchemaColumnInfo = { name; dataType; nullable }`; `SchemaTableInfo = { schema; name; columns }`; `DatabaseSchema = { engine; tables }`; `ConnectionFailureKind = "host" | "auth" | "network" | "unsupported_scheme"`; `ConnectResult = { status:"connected"; schema } | { status:"failed"; failure; message }` (all `readonly`) -- the single engine-neutral wire shape both rings share (AR-10).
- [x] `src/core/driver.ts` -- define `Driver` (`connect(): Promise<void>`, `listSchema(): Promise<DatabaseSchema>`, `close(): Promise<void>`), `DriverFactory = (url: string) => Driver`, `DriverConnectionError extends Error { kind: ConnectionFailureKind }`, `classifyConnectionError(err)` (maps PG SQLSTATE + MySQL codes + Node errno to `host`/`auth`/`network`, default `network`), and `createDriver(url)` (parse scheme; allowlist → adapter; else throw `DriverConnectionError("unsupported_scheme", …)`) -- the uniform interface + neutral error mapping behind Core.
- [x] `src/core/driver-postgres.ts` -- postgres.js adapter: open `postgres(url, { max: 1, ... })`, verify liveness, `listSchema` queries `information_schema.columns` (exclude `pg_catalog`/`information_schema`), map rows to `DatabaseSchema{engine:"postgres"}` ordered by schema/table/ordinal; `close` → `sql.end()`; wrap connect errors via `classifyConnectionError` into `DriverConnectionError` -- Postgres behind the interface.
- [x] `src/core/driver-mysql.ts` -- mysql2/promise adapter: open a connection/pool, `listSchema` queries `information_schema.columns` for the URL's database, map to `DatabaseSchema{engine:"mysql"}`; `close` ends the connection; wrap connect errors via `classifyConnectionError` -- MySQL behind the same interface.
- [x] `src/core/connection.ts` -- `createConnectionManager({ databaseUrl, createDriver })`: `connect()` returns cached `ConnectResult` when already connected; else `createDriver(url).connect()` + `listSchema()` → `{status:"connected", schema}`; on `DriverConnectionError` → `{status:"failed", failure, message}` (neutral, no URL); no `databaseUrl` → `{status:"failed", failure:"unsupported_scheme"|"network", message:"no connection target"}`; `close()` closes any open driver -- memory-only connection lifecycle.
- [x] `src/core/rpc.ts` -- broaden `Handler` to `(params, ctx) => unknown | Promise<unknown>`; make `dispatch` `async` and `await handler(...)` inside the existing try/catch; add `connect: () => Promise<ConnectResult>` to `RpcContext`; register `HANDLERS.connect = (_p, ctx) => ctx.connect()` -- first async RPC + connect method.
- [x] `src/core/server.ts` -- extend `StartCoreOptions` with `databaseUrl?: string` and `createDriver?: DriverFactory` (default real `createDriver`); build `connectionManager`; set `rpcContext.connect = () => connectionManager.connect()`; change the `/rpc` flow to `await dispatch(...)`; call `connectionManager.close()` in `stop()` -- wire the manager into boot, dispatch, and teardown.
- [x] `bin/quick-studio.ts` -- pass `databaseUrl: cli.databaseUrl ?? undefined` into the `startCore` options object -- stop dropping the parsed Ephemeral URL.

**Tests:**
- [x] `src/core/driver.test.ts` -- `createDriver` selects the PG adapter for `postgres`/`postgresql` and the MySQL adapter for `mysql`, and throws `unsupported_scheme` for `file:`/`javascript:`/`data:`/`C:\…`; `classifyConnectionError` maps synthetic errors (`ENOTFOUND`/`EAI_AGAIN`→host; `28P01`/`28000`/`ER_ACCESS_DENIED_ERROR`/`1045`→auth; `ECONNREFUSED`/`ETIMEDOUT`/`ECONNRESET`→network; unknown→network) -- pure, no live DB.
- [x] `src/core/connection.test.ts` -- inject a fake `createDriver`: happy path → `{status:"connected", schema}`; `connect` throwing `DriverConnectionError("auth")` → `{status:"failed", failure:"auth"}`; idempotency (second `connect` reuses; factory/`driver.connect` called once); `close` calls `driver.close`; null `databaseUrl` → clear `status:"failed"` -- fake driver, no live DB.
- [x] `src/core/rpc.test.ts` -- add: `connect` dispatches to `ctx.connect` and the async `dispatch` resolves a concrete `RpcReply` (not a Promise in `result`); extend `stubCtx` with a `connect`; unknown method still `unknown_method` -- async dispatch + registration guard.
- [x] `src/core/server.test.ts` -- boot `startCore(0, { databaseUrl:"postgres://u:p@h/db", createDriver: fakeFactory })`; `connect` RPC through the gate → 200 + `result.status:"connected"` + neutral schema; a fake factory whose driver throws auth → `result.status:"failed", failure:"auth"`; `stop()` invokes the fake `driver.close` (spy) -- end-to-end through the real server + gate without a live DB.

**Acceptance Criteria:**
- Given a valid PostgreSQL target held by the Core, when the UI calls `connect`, then the Core opens it through the uniform driver and returns `status:"connected"` with an engine-neutral `DatabaseSchema` (`engine:"postgres"`) listing the live schema.
- Given a valid MySQL target, when the UI calls `connect`, then it returns the same neutral `DatabaseSchema` shape with `engine:"mysql"`.
- Given a bad target, when the connection fails, then the result's `failure` distinguishes host vs auth vs network (and unsupported-scheme), and no credentials or raw engine exception leak into the message.
- Given a successful connection, when the Core shuts down, then the driver/pool is closed and no connection lingers.

## Spec Change Log

## Review Triage Log

### 2026-07-07 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 3, low 2)
- defer: 1: (high 0, medium 1, low 0)
- reject: 9
- addressed_findings:
  - `[medium]` `[patch]` Every FAILED connect orphaned a live driver: `createConnectionManager` only assigned `driver` after a successful `listSchema`, so a rejected `connect()` (or a scheme error after the postgres.js client was allocated) left the client un-`end()`ed — and since failed connects are retryable, each retry leaked another. `connect` now closes the driver on any failure path (`open()`'s catch → `safeClose`).
  - `[medium]` `[patch]` A `listSchema` throw AFTER the socket opened orphaned the live connection (driver never assigned, error re-thrown) and surfaced as `internal_error` with a leaked connection. The same `open()` catch now tears the driver down before propagating.
  - `[medium]` `[patch]` `connect()` was not concurrency-safe under the new async `dispatch` + concurrent `Bun.serve`: two `connect` RPCs arriving before the first resolved both passed the synchronous `if (cached)` guard and opened two drivers (one leaked), violating "open exactly once". Added an in-flight promise memo so concurrent callers share one attempt; the memo clears on settle so a failure stays retryable.
  - `[low]` `[patch]` Shutdown race: a `connect()` mid-`await` when `close()` ran would assign `driver` after `close()` had already read `null`, surviving `stop()`. `close()` now latches a `closed` flag (no re-open after shutdown) and awaits the in-flight open before tearing down, so the just-opened driver is closed, not leaked.
  - `[low]` `[patch]` `close()` called `d.close()` without guarding a rejection; a driver whose `close()` throws would reject `connectionManager.close()` and prevent `server.stop(true)` from releasing the port. Teardown now swallows close errors (`safeClose`).
- notes: Blind Hunter + Edge Case Hunter run in parallel at session capability over the diff since baseline. Deferred (1): invalid-catalog (`3D000`/`1049`) classified as `network` — real but needs a new neutral failure kind (out of the story's host/auth/network scope), recorded in `deferred-work.md`. Rejected (9): `assembleSchema` "space-joined key collision" (the separator is actually a `\0` NUL — verified via `cat -A` — which cannot appear in a PG/MySQL identifier; the Read tool rendered it as a space and misled the reviewer); raw-error-to-stderr (`dispatch` logs only `err.message`, terse, server-side — no object/`.query` dump); `data_type`/`is_nullable` null-guards (`information_schema.columns` guarantees both NOT NULL and the `'YES'/'NO'` domain); large-schema OOM (unrealistic for introspection; schema pagination is out of scope); mysql2 partial-connection cleanup (covered by the manager-level `safeClose`; mysql2 self-cleans a rejected `createConnection`); mysql2 connect timeout (its default is already ~10s, matching postgres.js `connect_timeout: 10`); duplicate `unsupported_scheme` messages (situation-distinct, scheme name is non-secret); `unsupported_scheme` reused for no-target (spec-prescribed).

### 2026-07-07 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 3: (high 0, medium 1, low 2)
- reject: 11
- addressed_findings:
  - `[medium]` `[patch]` MySQL adapter teardown was unbounded (`await conn.end()`) while the postgres adapter bounds at 5s (`sql.end({ timeout: 5 })`). A wedged/half-dead MySQL socket at SIGTERM could make `connectionManager.close()` → `Core.stop()` hang until the OS TCP timeout — violating the intent "no socket lingers past `stop()`" and "never block shutdown". `driver-mysql.ts` `close()` now races `conn.end()` against a 5s timer (`CLOSE_TIMEOUT_MS`) and force-`destroy()`s the connection on timeout or on an `end()` rejection, mirroring the postgres bound.
  - `[low]` `[patch]` `CONNECT_TIMEOUT` in `NETWORK_CODES` (`driver.ts`) was commented "mysql2 connect-timeout code", but it is postgres.js's connect-timeout code (mysql2 surfaces `ETIMEDOUT`). Corrected the comment so the engine attribution no longer misleads a maintainer reasoning about which code serves which engine.
- notes: Follow-up independent pass over the diff since baseline; 16 distinct findings after dedup (17 raw, one cross-reviewer dup merged). Deferred (3 NEW `deferred-work.md` entries): (a) post-handshake `listSchema` errors escape classification → `internal_error` (adapters wrap only `connect()`; golden shape re-throws — taxonomy decision, not a trivial wrap); (b) a hung introspection query can block shutdown (`close()` awaits inflight `open()` with no per-statement timeout); (c) malformed-but-supported URL (bad/out-of-range port) reported as `unsupported_scheme` — `new URL` throws in `schemeOf`, verified at runtime. Rejected (11): connect-path bug → `network` (spec-prescribed default); stale cached `connected` (reuse is spec-prescribed, liveness re-check out of scope); close-vs-inflight returning a valid-but-torn schema (near-unreachable shutdown race, caller already has the data); `null`→`unsupported_scheme` (spec-prescribed no-target bucket, prior-rejected); post-shutdown connect → `network` (near-unreachable lifecycle edge); raw `err.message` to stderr (terse DB text, not credential-bearing, prior-rejected); no explicit mysql connect timeout (mysql2 default ~10s, prior-rejected); driver↔adapter import-cycle fragility (no current defect); missing credential-in-stderr test (no leak by construction — only the scheme name reaches any message); invalid-catalog `3D000`/`1049`→`network` (ALREADY deferred — not re-added, to avoid a duplicate ledger entry); empty-string `""` databaseUrl → `unsupported_scheme` (near-unreachable given cli-args yields `null`, and no-target bucketing is spec-prescribed).

## Design Notes

- **Domain failure is a payload, not a transport error.** `dispatch` deliberately strips thrown-exception detail from client replies (secrets/driver output). So host/auth/network is modeled as a `ConnectResult` discriminated by `status` inside `RpcReply.result` — the handler returns it normally; only genuine bugs throw → `internal_error`. Discriminant is `status` (not `ok`) to avoid confusion with `RpcReply.ok`.
- **Error classification keys (behind the driver):** PG auth `28P01`/`28000`; MySQL auth `ER_ACCESS_DENIED_ERROR`/errno `1045` (and `ER_DBACCESS_DENIED_ERROR`); host `ENOTFOUND`/`EAI_AGAIN`; network `ECONNREFUSED`/`ETIMEDOUT`/`ECONNRESET`/connect-timeout; anything unmapped defaults to `network`.
- **DI is the testability lever.** `createConnectionManager` and `StartCoreOptions` take an injectable `createDriver`, mirroring `credential-store`/`browser-open`. Every test uses a fake driver — no live Postgres/MySQL and no docker in CI. Real-DB verification is opt-in (see Verification).
- **First async RPC.** `health`/`shutdown` were sync; `connect` forces `dispatch`/`server.ts` to `await`. The existing try/catch in `dispatch` then also catches rejected promises → `internal_error`, preserving the no-leak guarantee.

Golden shape:
```ts
// connection.ts
async connect(): Promise<ConnectResult> {
  if (cached) return cached;
  if (!databaseUrl) return { status: "failed", failure: "unsupported_scheme", message: "no connection target" };
  try {
    const d = createDriver(databaseUrl); await d.connect();
    const schema = await d.listSchema(); driver = d;
    return (cached = { status: "connected", schema });
  } catch (e) {
    if (e instanceof DriverConnectionError) return { status: "failed", failure: e.kind, message: e.message };
    throw e; // real bug → internal_error
  }
}
```

## Verification

**Commands:**
- `bun add postgres mysql2@3.22.5` -- expected: both land in `package.json` dependencies.
- `bun run build` then `bun test` -- expected: all suites pass incl. new `driver`/`connection` tests and the extended `rpc`/`server` tests (build first — `server.test` needs `ui-bundle.generated.ts`).
- `bunx tsc --noEmit` -- expected: clean under strict + `noUncheckedIndexedAccess`.
- `bun run bin/quick-studio.ts "file:///tmp/x" --no-open` then trigger `connect` -- expected: `status:"failed"`, `failure:"unsupported_scheme"`.

**Manual checks (opt-in real DB):**
- With a reachable Postgres and MySQL (e.g. local Docker), run with each URL and issue the `connect` RPC: expect `status:"connected"` and the live tables/columns in the neutral shape. Point the URL at a wrong password → `failure:"auth"`; a closed port → `failure:"network"`; a bogus host → `failure:"host"`. Confirm no URL/credential appears in any stderr line.

## Auto Run Result

Status: done

### Summary
Delivered the epic's "run with a URL → see the schema" loop (UJ-1, AR-10). The Ephemeral `databaseUrl` (parsed but dropped by Story 1.2's `bin/`) is now threaded `bin/` → `startCore` → a Core-owned, memory-only connection manager. One uniform `Driver` interface fronts a postgres.js adapter and a mysql2 adapter, selected by URL scheme (allowlist `postgres`/`postgresql`/`mysql`; anything else — `file:`/`javascript:`/`data:`/Windows-drive — refused as `unsupported_scheme`, the sanctioned rejection point for Story 1.2's shallow URL). A new async `connect` RPC (the first async handler — `dispatch` was made async) opens the connection once, introspects `information_schema.columns` into a single engine-neutral `DatabaseSchema`, and returns a classified `ConnectResult` (`status:"connected"` | `status:"failed"` with `host`/`auth`/`network`/`unsupported_scheme`). Connection failures are modeled as a domain payload, never a thrown/leaked exception; the URL and credentials live only in Core memory and never reach a log or message. The driver is closed on `stop()`.

### Files changed
- `src/shared/contract.ts` — engine-neutral wire types: `DbEngine`, `SchemaColumnInfo`, `SchemaTableInfo`, `DatabaseSchema`, `ConnectionFailureKind`, `ConnectResult`.
- `src/core/driver.ts` (new) — uniform `Driver` interface, `DriverFactory`, `DriverConnectionError`, pure `classifyConnectionError`, `createDriver` (scheme allowlist), `assembleSchema` (NUL-keyed neutral grouping).
- `src/core/driver-postgres.ts` (new) — postgres.js adapter (`max:1`, `connect_timeout:10`, liveness probe, system-schema-excluded introspection).
- `src/core/driver-mysql.ts` (new) — mysql2/promise adapter (eager connect, parameterized introspection scoped to the URL's database).
- `src/core/connection.ts` (new) — memory-only, idempotent, concurrency-safe connection manager; closes the driver on every failure path and on shutdown.
- `src/core/rpc.ts` — async `Handler`/`dispatch`, `RpcContext.connect`, `connect` handler.
- `src/core/server.ts` — `StartCoreOptions.databaseUrl` + injectable `createDriver`, manager wiring, `await dispatch`, driver close in `stop()`.
- `bin/quick-studio.ts` — pass `databaseUrl: cli.databaseUrl` into `startCore`.
- `package.json` — `postgres@^3.4.9`, `mysql2@3.22.5`.
- Tests: `src/core/driver.test.ts` + `src/core/connection.test.ts` (new, fake-driver, no live DB); `src/core/rpc.test.ts` + `src/core/server.test.ts` (extended for async dispatch + the `connect` RPC end-to-end through the gate).

### Review findings breakdown
- Patches applied: 5 (3 medium, 2 low) — all in the connection manager: leak on failed connect, leak on `listSchema`-after-open, concurrent-`connect` race (opened two drivers under async dispatch), shutdown race, and `close()` rejection robustness. See Review Triage Log 2026-07-07. Covered by 5 new tests (concurrency, half-open teardown, shutdown-race, close-throws).
- Deferred: 1 — invalid-catalog (`3D000`/`1049`) misclassified as `network`; needs a new neutral failure kind (recorded in `deferred-work.md`).
- Rejected: 9 — chief among them the `assembleSchema` "key collision" (the separator is a `\0` NUL, not a space — the Read tool's rendering misled the reviewer) and the stderr-leak claim (`dispatch` logs only `err.message`, terse, server-side).

### Verification performed
- `bun run build` → OK. `bun test` → **283 pass / 0 fail** (614 expect calls, 19 files). `bunx tsc --noEmit` → exit 0 (strict + `noUncheckedIndexedAccess`).
- Negative path exercised on the real driver factory: `file:///tmp/x` → `{status:"failed", failure:"unsupported_scheme"}` with no credential in the message.
- Live-DB happy paths are opt-in (no Postgres/MySQL/docker in CI by design — the DI seam drives fakes end-to-end, including through the server's Origin/token gate).

### Residual risks
- `followup_review_recommended: true` — the patches rework the connection manager's concurrency and shutdown ordering (in-flight memoization, `closed` latch, teardown-on-failure). Localized to `src/core/connection.ts` and covered by new tests, but race/lifecycle logic warrants an independent pass.
- The two DB adapters are unit-tested only via fakes; the real postgres.js / mysql2 error-code → `host`/`auth`/`network` mapping is asserted against synthetic error objects, not a live server. The opt-in manual checks and the deferred invalid-catalog item are the known gaps.
- Bun **1.3.x** in use vs the `1.2.x` stack-seed floor — backward-compatible.

### Follow-up review (2026-07-07)
An independent follow-up review pass (the one `followup_review_recommended: true` requested) ran Blind Hunter + Edge Case Hunter in parallel at session capability over the diff since baseline. Outcome: **converging** — no `intent_gap`, no `bad_spec`, no code re-derivation.

- **Patches applied (2):**
  - `[medium]` MySQL teardown was unbounded (`await conn.end()`) where the postgres adapter bounds at 5s — a wedged socket at shutdown could hang `Core.stop()` and never release the port. `driver-mysql.ts` `close()` now races `conn.end()` against a 5s `CLOSE_TIMEOUT_MS` timer and force-`destroy()`s on timeout/rejection, mirroring postgres.
  - `[low]` Corrected a misleading comment: `CONNECT_TIMEOUT` is postgres.js's connect-timeout code, not mysql2's (`driver.ts`).
- **Deferred (3, new `deferred-work.md` entries):** post-handshake `listSchema` errors escape classification as `internal_error`; a hung introspection query can block shutdown (`close()` awaits inflight, no per-statement timeout); a malformed-but-supported URL (bad/out-of-range port) is reported as `unsupported_scheme`. All three need a failure-taxonomy decision beyond the story's 4-kind enum, so they are follow-up work, not in-place fixes.
- **Rejected (11):** spec-prescribed default→network; cached-connected reuse (liveness re-check out of scope); near-unreachable shutdown/lifecycle races; prior-rejected stderr/no-target/connect-timeout items; import-cycle fragility (no current defect); already-deferred invalid-catalog (not re-added); near-unreachable empty-string URL.
- **Verification:** `bun run build` OK; `bunx tsc --noEmit` exit 0; `bun test` → **283 pass / 0 fail** (614 expect calls, 19 files). The mysql `close()` patch is exercised only via the DI fakes (no live-DB test) — same residual gap as the adapters overall.
- `followup_review_recommended` set to **false**: the pass's changes are two localized, low-complexity patches (one mechanically mirroring an already-reviewed postgres pattern, one a comment) with no spec/behavior re-derivation — the substantive open items were deferred, not fixed in place.
