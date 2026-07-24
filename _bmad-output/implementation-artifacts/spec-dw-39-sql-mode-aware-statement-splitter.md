---
title: 'DW-39: SQL-mode-aware raw statement splitter'
type: 'feature'
created: '2026-07-24'
status: 'done'
baseline_revision: '3b7d38fbfb2b8e8c53d846740c515ef1ccf545b7'
final_revision: '2c44f5f34574e0f345e42979ab62b9e6e3002e4e'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The raw-SQL statement splitter in the guarded core executor hardcodes the assumption that Postgres runs `standard_conforming_strings = on` and MySQL runs a default `sql_mode`. Under non-default session modes the string/identifier boundaries shift: Postgres `standard_conforming_strings = off` makes plain `'…'` backslash-active (splitter over-rejects — fail-safe), and MySQL `NO_BACKSLASH_ESCAPES` / `ANSI_QUOTES` change how `'…'` and `"…"` are escaped/typed (splitter could under-count — backstopped by `multipleStatements:false`).

**Approach:** Detect each session's actual modes on connect (Postgres `standard_conforming_strings`, MySQL `NO_BACKSLASH_ESCAPES` + `ANSI_QUOTES` from `@@session.sql_mode`) and thread them through a new `getSessionModes` seam into the splitter's per-span escape decisions, so the splitter matches the real server instead of assuming defaults. Detection is best-effort: a probe that cannot run falls back to over-reject-safe modes (backslash treated as literal), and `multipleStatements:false` / `simple:false` stay as the always-on backstop.

## Boundaries & Constraints

**Always:**
- An ambiguous/undetectable parse must OVER-REJECT (fail closed), never under-count. Probe failure ⇒ `SAFE_FALLBACK_SESSION_MODES` (backslash-literal everywhere), so a smuggled `;` after `\'` stays a top-level separator and splits → multi-statement rejection.
- Detection is per-connection, fixed at connect, never re-introspected (mirror `getEngine`'s memo posture — modes are a connection property, not catalog state; no DDL changes them, `invalidateSchema` is ignored).
- A mode probe that throws must NEVER fail the connection — it is caught inside the adapter and degrades to safe modes; `connect()` still succeeds.
- Probe queries carry no user text and echo no credentials (they are constant SQL).
- The `multipleStatements:false` (mysql) and `simple:false` (postgres) backstops remain unconditional and untouched.

**Block If:**
- Detection would require adding a live-DB integration test harness that does not already exist (the repo tests drivers as pure units — do not stand one up).

**Never:**
- Do NOT change the always-on driver backstops or the executor's default-deny posture.
- Do NOT `SET` any session variable — detect only, never mutate the server's session.
- Do NOT route modes through the schema memo (`DatabaseSchema`) — they are not catalog data.
- Do NOT make single-quote/double-quote parsing depend on anything other than `engine` + the detected `SessionModes`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PG default | `SELECT 'a\'; SELECT 2` , scs=on | plain `'…'` backslash-LITERAL → 2 statements | n/a |
| PG scs off | `SELECT 'a\'; SELECT 2` , scs=off | `\'` escaped → string swallows `;` → 1 statement (matches server) | n/a |
| MySQL default | `SELECT '\'; SELECT 2` , sql_mode default | `\'` escaped → 1 statement | n/a |
| MySQL NO_BACKSLASH_ESCAPES | `SELECT '\'; SELECT 2` , NBSE on | `\` literal → `'` closes → 2 statements (matches server) | n/a |
| MySQL ANSI_QUOTES | `SELECT "a\"; b"` , ANSI_QUOTES on | `"` = identifier, no backslash → `"a\"` closes → `;` splits → 2 statements | n/a |
| Probe fails | connect ok, mode query throws | connection succeeds with `SAFE_FALLBACK_SESSION_MODES` (backslash-literal) | swallowed → safe modes |
| Unknown probe value | scs=`"garbage"` / sql_mode non-string | over-reject-safe modes | parsed defensively |

</intent-contract>

## Code Map

- `src/core/driver.ts` -- home of the `SessionModes` type, `DEFAULT_SESSION_MODES` + `SAFE_FALLBACK_SESSION_MODES` constants, pure `postgresSessionModes()` / `mysqlSessionModes()` parsers, and the new `Driver.sessionModes?()` seam.
- `src/core/driver-postgres.ts` -- `createPostgresDriver`: probe `standard_conforming_strings` in `connect()` (after `select 1`), store, expose via `sessionModes()`.
- `src/core/driver-mysql.ts` -- `createMysqlDriver`: probe `@@session.sql_mode` in `connect()` (after `createConnection`), store, expose via `sessionModes()`.
- `src/core/connection.ts` -- `ConnectionManager`: add `getSessionModes()` (lazy+once via `ensureDriver`, no stale-flag, mirrors `getEngine`).
- `src/core/connection-targets.ts` -- `ConnectionSeams`: add `getSessionModes` seam + wire in `seamsFor`.
- `src/core/executor.ts` -- thread `SessionModes` through `consumeSpan`/`splitStatements`/`topLevelWords`; `executeRaw` reads `seams.getSessionModes()`.
- `src/core/executor.test.ts` -- mode-aware splitter cases + `makeSeams` `getSessionModes` + end-to-end wiring assertions.
- `src/core/driver.test.ts` -- unit tests for `postgresSessionModes` / `mysqlSessionModes` / the two constants.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/driver.ts` -- add `export type SessionModes = { readonly standardConformingStrings: boolean; readonly noBackslashEscapes: boolean; readonly ansiQuotes: boolean }`; export `DEFAULT_SESSION_MODES` (`{ scs:true, nbse:false, ansi:false }` — documented server defaults, back-compat) and `SAFE_FALLBACK_SESSION_MODES` (`{ scs:true, nbse:true, ansi:false }` — backslash-literal, over-reject-safe); add pure `postgresSessionModes(scs: unknown)` (only explicit `off`/`false` ⇒ scs=false, anything else ⇒ scs=true; mysql fields = defaults) and `mysqlSessionModes(sqlMode: unknown)` (non-string ⇒ SAFE_FALLBACK; else `nbse = /NO_BACKSLASH_ESCAPES/`, `ansi = /ANSI_QUOTES/` on the upper-cased expanded string); add optional `sessionModes?(): SessionModes` to the `Driver` type — documented as always-implemented by real adapters, optional only so pre-DW-39 fakes still type-check (`rowsAffected?` precedent).
- [x] `src/core/driver-postgres.ts` -- init `let modes: SessionModes = SAFE_FALLBACK_SESSION_MODES`; in `connect()` after `select 1`, run `SHOW standard_conforming_strings` in its own try/catch (`catch ⇒ modes = SAFE_FALLBACK_SESSION_MODES`), set `modes = postgresSessionModes(row?.standard_conforming_strings)`; add `sessionModes: () => modes`.
- [x] `src/core/driver-mysql.ts` -- init `let modes: SessionModes = SAFE_FALLBACK_SESSION_MODES`; in `connect()` after `createConnection`, run `SELECT @@session.sql_mode AS sql_mode` in its own try/catch (`catch ⇒ SAFE_FALLBACK`), set `modes = mysqlSessionModes(rows[0]?.sql_mode)`; add `sessionModes: () => modes`.
- [x] `src/core/connection.ts` -- add `getSessionModes(): Promise<SessionModes>` to `ConnectionManager` type + impl: `const d = await ensureDriver(); return d.sessionModes?.() ?? DEFAULT_SESSION_MODES` (no `refreshIfStale`; fake-driver-absent concession only — real adapters always implement it).
- [x] `src/core/connection-targets.ts` -- add `readonly getSessionModes: () => Promise<SessionModes>` to `ConnectionSeams` and `getSessionModes: () => manager.getSessionModes()` to `seamsFor`.
- [x] `src/core/executor.ts` -- add a `modes: SessionModes` param (default `DEFAULT_SESSION_MODES`) to `splitStatements` and `topLevelWords`, and a `modes` arg to `consumeSpan`; in `consumeSpan` compute `sqBackslash = isEString || (isPg && !modes.standardConformingStrings) || (isMysql && !modes.noBackslashEscapes)` for `'…'` and `dqBackslash = isMysql && !modes.ansiQuotes && !modes.noBackslashEscapes` for `"…"` (backtick arm unchanged); in `executeRaw` add `getSessionModes` to the seam destructure, `const modes = await getSessionModes();` and pass it to `splitStatements` + `topLevelWords`.
- [x] `src/core/executor.test.ts` -- add `getSessionModes` to `makeSeams` (default returns `DEFAULT_SESSION_MODES`, overridable via opts); add splitter cases for each I/O-matrix mode row; add an end-to-end case proving a statement that splits to 1 under default but 2 under detected modes is rejected `multiple statements are not allowed` (and the inverse).
- [x] `src/core/driver.test.ts` -- unit-test `postgresSessionModes` (`on`/`off`/`undefined`/garbage), `mysqlSessionModes` (default / `NO_BACKSLASH_ESCAPES` / `ANSI_QUOTES` / composite / non-string), and the two constants' shapes.

**Acceptance Criteria:**
- Given a Postgres connection reporting `standard_conforming_strings = off`, when a raw statement uses a plain `'…\'…'` string, then the splitter treats the backslash as an escape (matching the server) instead of assuming `on`.
- Given a MySQL connection whose `@@session.sql_mode` contains `NO_BACKSLASH_ESCAPES`, when a raw statement uses `'\''`, then the splitter treats the backslash as literal and counts the trailing `;` as a real separator.
- Given a MySQL connection whose `@@session.sql_mode` contains `ANSI_QUOTES`, when a raw statement uses `"…"`, then the splitter treats `"` as an identifier (no backslash escaping) rather than a backslash-escaped string.
- Given any connection whose mode probe throws, when `connect()` runs, then the connection still succeeds and the splitter uses `SAFE_FALLBACK_SESSION_MODES` (over-reject-safe).
- Given no detected modes are supplied, when `splitStatements(sql, engine)` is called with two args, then behavior is byte-identical to pre-DW-39 (`DEFAULT_SESSION_MODES`), so existing splitter tests stay green.
- Given the always-on backstops, when this change lands, then `multipleStatements:false` (mysql) and `simple:false` (postgres) remain unconditional and unmodified.

## Spec Change Log

_No bad_spec loopback — spec unchanged during review._

## Review Triage Log

### 2026-07-24 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 0, low 2)
- defer: 0
- reject: 1
- addressed_findings:
  - `[low]` `[patch]` Stale-modes-after-mid-session-`SET`: modes are captured once at connect (deliberate, per the spec's fixed-at-connect design) so a confirmed `SET standard_conforming_strings`/`sql_mode` that flips backslash-active→literal could make the splitter under-count. Fully backstopped on BOTH engines by the unconditional `simple:false`/`multipleStatements:false` driver guards (the EC2 claim that postgres has no backstop is false). Sniffing the confirmed `SET` would violate DW-45's opaque-statement rule, so — per the reviewer's own recommendation — resolved by DOCUMENTING the limitation and the load-bearing backstop in `executeRaw` (`src/core/executor.ts`).
  - `[low]` `[patch]` `getSessionModes` driver-absent fallback used `?? DEFAULT_SESSION_MODES` (mysql backslash-ACTIVE — the under-count side); switched to `?? SAFE_FALLBACK_SESSION_MODES` so an adapter omitting the method fails closed, matching every other probe-failure path (`src/core/connection.ts`). Unreachable in production (real adapters always implement `sessionModes`).
- rejected: postgres.js pooling divergence between the mode probe and the executing session — false premise: the adapter uses `postgres(url, { max: 1 })`, a single backend session shared by probe and execution.

## Design Notes

Safe-direction proof (why the fallback is backslash-literal): if the splitter assumes backslash-ON but the server has it OFF, the splitter under-counts (string swallows a real `;`) → smuggle. If the splitter assumes backslash-OFF but the server has it ON, it over-counts → false rejection (safe). So the unknown-mode fallback is backslash-LITERAL everywhere: `SAFE_FALLBACK_SESSION_MODES = { scs:true, nbse:true, ansi:false }`. Note `ansi` is a no-op once `nbse:true` (the `dqBackslash` formula already yields `false`).

Detection is best-effort and separate from liveness: Postgres keeps its `select 1` round-trip and adds an independent `SHOW` probe (its own try/catch), so a server that chokes on the probe still connects with safe modes rather than regressing a previously-working `select 1`. `@@session.sql_mode` returns the fully-EXPANDED mode list, so composite modes like `ANSI` (which implies `ANSI_QUOTES`) are covered by the plain substring check.

Combined escape formula (single quote):
```ts
const sqBackslash =
  isEString ||                                  // pg E'…' always escapes
  (isPg && !modes.standardConformingStrings) || // pg scs=off ⇒ plain strings escape
  (isMysql && !modes.noBackslashEscapes);       // mysql default ⇒ escapes; NBSE ⇒ literal
```

## Verification

**Commands:**
- `bun test src/core/executor.test.ts` -- expected: all splitter + wiring cases pass.
- `bun test src/core/driver.test.ts` -- expected: mode-parser unit tests pass.
- `bun test` -- expected: full suite green (no regression in existing splitter/connection tests).
- `bunx tsc --noEmit` -- expected: no type errors from the new `SessionModes` seam threading.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change:** The raw-SQL statement splitter now adapts to each connection's actually-detected SQL session modes instead of assuming server defaults. On connect, each driver runs a best-effort probe (postgres `SHOW standard_conforming_strings`, mysql `SELECT @@session.sql_mode`), parses it into a `SessionModes` value, and exposes it via a new `getSessionModes` seam threaded into the splitter's per-span escape decisions (`consumeSpan`/`splitStatements`/`topLevelWords`). Detection is best-effort and fail-open for the connection / fail-closed for the splitter: a probe failure degrades to `SAFE_FALLBACK_SESSION_MODES` (backslash-literal ⇒ over-reject) and never fails the connection. The always-on `simple:false` (pg) / `multipleStatements:false` (mysql) driver backstops are untouched.

**Files changed:**
- `src/core/driver.ts` -- `SessionModes` type, `DEFAULT_SESSION_MODES` + `SAFE_FALLBACK_SESSION_MODES` constants, pure `postgresSessionModes()` / `mysqlSessionModes()` parsers, optional `Driver.sessionModes?()` seam.
- `src/core/driver-postgres.ts` -- best-effort `SHOW standard_conforming_strings` probe in `connect()` (own try/catch, after the unchanged `select 1`); `sessionModes()` getter.
- `src/core/driver-mysql.ts` -- best-effort `SELECT @@session.sql_mode` probe in `connect()` (own try/catch, after the unchanged `createConnection`); `sessionModes()` getter.
- `src/core/connection.ts` -- `ConnectionManager.getSessionModes()` (lazy+once, no stale-flag, fail-closed `?? SAFE_FALLBACK` fallback).
- `src/core/connection-targets.ts` -- `getSessionModes` added to `ConnectionSeams` + `seamsFor` wiring.
- `src/core/executor.ts` -- `SessionModes` threaded through the splitter; `executeRaw` reads `getSessionModes()`; doc note on connect-time-only modes + load-bearing backstop for mid-session `SET`.
- `src/core/executor.test.ts`, `src/core/driver.test.ts`, `src/core/connection-targets.test.ts` -- mode-matrix splitter cases, end-to-end reject/accept wiring, parser unit tests, fake-manager seam.

**Review findings:** 2 patches applied (both low: documented the connect-time-only / mid-session-`SET` staleness backstopped by the driver guards; switched the driver-absent fallback to `SAFE_FALLBACK_SESSION_MODES`). 0 intent_gap, 0 bad_spec, 0 deferred, 1 rejected (postgres.js pooling — false premise, adapter is `max: 1`).

**Verification:** `bunx tsc --noEmit` → exit 0. `bun test` → 1840 pass, 1 skip, 9 fail — the 9 failures are the pre-existing `quick-studio shim` tests (`node` not on PATH in this WSL env), unrelated to this change and touching none of the changed files.

**Residual risks:** A confirmed `SET` of `standard_conforming_strings`/`sql_mode` mid-session leaves the cached modes stale until reconnect; the resulting worst case is an over-reject (never a smuggle) because the unconditional driver backstops reject any multi-statement regardless of the splitter. Documented in `executeRaw`.
