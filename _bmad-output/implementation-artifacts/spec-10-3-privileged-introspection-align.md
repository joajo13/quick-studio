---
title: 'Align Postgres index introspection with information_schema privilege visibility (no phantom tables/columns for restricted roles)'
type: 'refactor'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 10 / Story 10.3
  - '{project-root}/_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html'
---

<intent-contract>

## Intent

**Problem:** Epic 10's authoritative solution point #6 splits "credentials with limited permissions" into two cases. **Case (a) — partial introspection:** in Postgres, `information_schema.columns` already filters per-column visibility (`pg_has_role(c.relowner,'USAGE') OR has_column_privilege(c.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES')` — the engine's own predicate), so a restricted role correctly sees fewer columns/tables there. But `driver-postgres.ts`'s index query (`listSchema`, ~L222-238) reads `pg_index`/`pg_class`/`pg_namespace`/`pg_attribute` directly — catalog tables with NO privilege filter — so it can return index metadata (index names, uniqueness, column names) for tables or columns the same role cannot see via `information_schema`. `assembleSchema` (`driver.ts`) only *decorates* tables the columns query already produced, so today this cannot spawn a wholly new tree node from an index-only row for a zero-visibility table — but it CAN leak: (1) index metadata for a table with column-level-only grants where the index touches a column outside that grant, and (2) unnecessary catalog rows crossing the wire before being silently dropped, which is itself a privilege-boundary crossing worth closing at the source. **Case (b) — hard failure on expand:** already substantially handled — DW-19 (`spec-dw-19-20-connection-introspection-robustness.md`, done) wraps each adapter's `listSchema` introspection in a try/catch that turns ANY failure into a classified `DriverConnectionError` (permission-denied codes → `auth`, everything else → `network`/existing kinds), so "insufficient privileges to introspect at all" already exits engine-neutral today. What is NOT yet buildable: "the requested schema does not exist / isn't visible" — `Driver.listSchema()` takes no schema parameter today (Story 10.2's per-connection schema scope has not landed; confirmed by grep — no `schema`/`schemaScope` param anywhere in `connection.ts`/the adapters), so Core cannot currently distinguish "schema absent" from "no tables in any visible schema."

**Approach:** (a) Add the IDENTICAL column-visibility predicate Postgres's own `information_schema.columns` view uses to the index query's `WHERE` clause — `AND (pg_has_role(t.relowner, 'USAGE') OR has_column_privilege(t.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES'))` — joined against the SAME `t`/`a` aliases the query already binds (`pg_class t`, `pg_attribute a`), so no new join is needed and the filter is provably identical to what `information_schema.columns` already computes for that same (table, column) pair. This is an IN-QUERY fix, not a post-`assembleSchema` trim: the invisible row is never fetched. (b) VERIFY (add a regression test if none exists) that the existing DW-19 classification wrap already covers "insufficient privileges to introspect at all" for both engines; leave the "requested schema does not exist" sub-case explicitly OUT of this story's buildable scope pending Story 10.2, recorded as an open question for step-02 rather than inventing a schema-scope param here. MySQL is verify-only: all four of its introspection queries (columns/PK/index/FK) already read from `information_schema.*`, which MySQL privilege-filters consistently — no phantom risk identified, flagged for step-02 to confirm rather than assumed silently.

## Boundaries & Constraints

**Always:**
- Express the alignment fix IN the SQL text of the index query (`driver-postgres.ts` ~L222-238) — never as a post-fetch/`assembleSchema` trim. The composed query itself must never retrieve a row `information_schema.columns` would hide.
- Mirror Postgres's OWN `information_schema.columns` visibility predicate verbatim (`pg_has_role(t.relowner,'USAGE') OR has_column_privilege(t.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES')`) rather than inventing a new one — provable identity with the columns query's own visibility, not an approximation.
- Preserve every other predicate/order-by in that query byte-for-byte: the `n.nspname !~ '^pg_'` system-schema exclusion, `a.attnum > 0` expression-column exclusion, and the `array_position(...)` column-order `ORDER BY`.
- Treat DW-31 (PK ordinal ordering, `driver-postgres.ts` PK query) and DW-42 (`conparentid` partition-FK exclusion, FK query + `pgSupportsConparentid`) as DONE, verified invariants — both `status: done` in the deferred-work ledger. This story must not touch either query's structure and must keep their existing tests green.
- Verify the existing DW-19 wrap (`driver-postgres.ts` L318-325, `driver-mysql.ts` L322-329 — `introspect()` wrapped in `withTimeout` + a catch that rethrows a `DriverConnectionError` as-is else `toDriverConnectionError(err)`) already classifies a post-handshake "insufficient privileges to introspect at all" failure as `auth` for both engines; add the regression test if the current suite does not already lock it.
- `bunx tsc --noEmit`, `bun test`, and `bun run build` clean; no live-DB dependency in the automated suite (mirrors DW-19/20's own constraint) — verify the added predicate via a lightweight text-presence assertion on the composed query (or equivalent), not a live Postgres integration test. The new `docker-compose.yml`/`docker/` stack is a manual dev-eyeball convenience only (per `docs/docker-development.md`), not CI infra — optional for manual confirmation, never a test dependency.

**Block If:**
- If expressing the alignment would require adding a NEW `ConnectionFailureKind` or changing the existing taxonomy — HALT `blocked` (mirrors DW-19/20's own Block-If; the taxonomy is a preserved invariant).
- If step-02 investigation finds MySQL DOES have a real analogous phantom-metadata risk (contradicting this draft's "information_schema.statistics is already privilege-filtered" assumption) — that is a scope change, not a silent addition; confirm and re-scope rather than patching MySQL unannounced.

**Never:**
- Never filter phantom index/column visibility POST-fetch (in `assembleSchema` or the adapter's row-mapping step) — the whole point is the SQL text itself must never retrieve the invisible row.
- Never touch the PK query's `ORDER BY … kcu.ordinal_position` (DW-31) or the FK query's `partitionFilter`/`conparentid` exclusion (DW-42) structurally.
- Never widen the FK query's (`pg_constraint`/`pg_attribute`) exposure as part of THIS story even though it has an analogous privilege gap (it also reads `pg_attribute` unfiltered) — the epic AC scopes case (a) to the index queries only. Record the FK gap as a follow-up candidate (deferred-work entry), do not silently fix it here.
- Never add a `permission`/`forbidden` bucket to `ConnectionFailureKind` — permission-denied continues mapping to the existing `auth` kind.
- Never invent a schema-scope parameter on `Driver.listSchema()` to satisfy the "requested schema does not exist" AC sub-case in this story — that belongs to Story 10.2; note it as blocked-on/deferred instead.
- Never change MySQL's introspection queries in this pass without an explicit step-02 finding of a real risk.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Restricted PG role, zero privilege on table T | `listSchema()` on a role with no SELECT/INSERT/UPDATE/REFERENCES on any column of T | Index query returns ZERO rows for T (enforced in-query, not just dropped later by `assembleSchema`) — no index metadata for T crosses the wire | No error; T simply absent from the tree, matching `information_schema.columns` |
| Restricted PG role, column-level-only grant on T | Role has `SELECT` on column `a` only (no table-level privilege); T has an index on `(a, b)` | Index row surfaces with ONLY the visible column(s) (`a`); `b` is excluded per-column, matching what `information_schema.columns` would show for T | No error; partial index metadata, never the invisible column name |
| Restricted PG role, table-level grant on T | Role has table-level `SELECT` (or is owner) on T | Full index visibility unchanged — predicate is true for every column via `has_column_privilege` | No error; behavior identical to today for a fully-privileged role |
| Owner / superuser | Unrestricted role | No behavior change — `pg_has_role(t.relowner,'USAGE')` short-circuits true | No error |
| PG server version | Any supported PG version | Predicate uses no version-gated catalog column (unlike `conparentid`/DW-42) — no version branching needed | No error |
| MySQL, restricted role | Any MySQL role | No change — `information_schema.statistics`/`columns`/`key_column_usage` already privilege-filter consistently; verify-only, flag if step-02 finds otherwise | No error |
| Insufficient privileges to introspect at all (PG `42501` / MySQL `1142`/`1143`/`1227`) | `listSchema` throws at the columns/PK/index/FK query itself | Existing DW-19 wrap classifies `DriverConnectionError("auth", …)` → `connection.ts` returns `{status:"failed", failure:"auth"}`; other roots unaffected | Classified, neutral, credential-free (verify existing coverage; add test if missing) |
| Requested schema does not exist / isn't visible | No `schema` param exists on `Driver.listSchema()` today (Story 10.2 not landed) | OUT OF THIS STORY'S BUILDABLE SCOPE — flagged as an open question/blocked-on for step-02, not silently stubbed | N/A — do not invent a param |
| Regression: DW-31 composite PK order | Composite PK `(b, a)` | PK query/`ORDER BY` untouched; existing tests stay green | No error |
| Regression: DW-42 partitioned FK | Partitioned parent + partitions | FK query/`partitionFilter` untouched; existing tests stay green | No error |
| Full suite | `bunx tsc --noEmit` + `bun test` + `bun run build` | tsc clean; suite green (incl. new privilege-alignment assertion + DW-19 regression test if added); build OK; no live-DB dependency | No error |

</intent-contract>

## Acceptance Criteria

- Given a Postgres connection whose credentials have limited privileges, when the schema is introspected, then the index query's `WHERE` clause itself excludes any (table, column) pair `information_schema.columns` would hide — verified by the SAME predicate Postgres's own `columns` view uses, not a post-fetch trim.
- Given a role with column-level-only grants on a table whose index spans both a visible and an invisible column, when introspected, then the index metadata surfaces only the visible column — never the invisible one.
- Given credentials insufficient to introspect at all, when the connection's root is expanded, then that root shows a classified, engine-neutral `auth` failure (no raw driver text) and the other roots keep working — verified against the existing DW-19 wrap, with a regression test added if coverage is currently missing.
- Given the existing DW-31/DW-42 fixes, when this story lands, then the PK-ordinal-order and partitioned-FK-exclusion behaviors are unchanged and their existing tests stay green.
- Given the suite, when run, then `bunx tsc --noEmit`, `bun test`, and `bun run build` are all clean, with no new live-DB test dependency.

## Code Map

- `src/core/driver-postgres.ts` — the index query (~L222-238, `listSchema`) gets the added privilege predicate. PK query (~L193-203) and FK query (~L277-297) are read-only reference points — DO NOT modify structurally (DW-31/DW-42 invariants).
- `src/core/driver.ts` — `DriverConnectionError`, `classifyConnectionError`, `AUTH_CODES`/`AUTH_ERRNO`, the DW-19 introspection wrap pattern — verify-only, taxonomy is a preserved invariant.
- `src/core/driver-mysql.ts` — verify-only; no expected change pending step-02 confirmation.
- `src/core/driver.test.ts` — extend with the privilege-predicate presence assertion (text-based, no live DB) and, if missing, a DW-19-style "insufficient privileges to introspect at all" classification regression case.
- `_bmad-output/implementation-artifacts/deferred-work.md` — NOT edited by this story (orchestrator records resolution); the FK-query analogous gap, if confirmed, becomes a NEW deferred-work candidate rather than being fixed here.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] `src/core/driver-postgres.ts` — add the column-visibility predicate to the index query's `WHERE` clause, aligned verbatim with `information_schema.columns`'s own visibility check.
- [ ] `src/core/driver.test.ts` — add a lightweight, non-live-DB regression assertion for the new predicate, plus a DW-19 "insufficient privileges to introspect at all" classification test if not already covered.
- [ ] Confirm (step-02) whether MySQL needs any change; confirm whether the FK query's analogous gap should become a new deferred-work entry.
- [ ] Confirm (step-02) sequencing against Story 10.2 for the "requested schema does not exist" sub-case — this story does not implement it.

## Spec Change Log

<!-- populated by step-02 / review loop -->

## Review Triage Log

<!-- populated by the review loop -->
