---
title: 'Align Postgres index introspection with information_schema privilege visibility (no phantom tables/columns for restricted roles)'
type: 'refactor'
created: '2026-07-21'
status: 'done'
baseline_revision: '293b91260230e5d1d701c2bbd6b004c2bbcbe178'
final_revision: '1a53af07376dc0b0c4bc98cab64bb86330327be0'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 10 / Story 10.3
  - '{project-root}/_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html'
warnings: ['oversized']
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

## Code Map

> Line references verified against `HEAD` = `293b912` (Story 10.2 already landed — see Design Notes).

- `src/core/driver-postgres.ts:289-305` — the index query. Its `WHERE` is `${idxScope} AND a.attnum > 0` today; it already binds `pg_class t` (`t.oid`, `t.relowner`) and `pg_attribute a` (`a.attnum`), so the visibility predicate needs NO new join. This is the only production change.
- `src/core/driver-postgres.ts:114-134` — `pgSchemaScope`, the exported-pure fragment-builder precedent (Story 10.2). The new visibility fragment builder sits beside it and is spliced the same way.
- `src/core/driver-postgres.ts:82-94` — `PgFragment` / `PgScopeFragments` types; `PgFragment` is the return type for the new builder.
- `src/core/driver-postgres.ts:260-270` (PK, DW-31) and `:348-368` (FK, DW-42) — read-only reference points. DO NOT modify. The FK query's unfiltered `pg_constraint`/`pg_attribute` read is the analogous gap recorded as a follow-up, not fixed here.
- `src/core/driver-postgres.ts:389-396` — the DW-19 wrap (`withTimeout` + classify-or-rethrow). Verify-only.
- `src/core/driver-mysql.ts:219-320` — `listSchema`; all four queries read `information_schema.{columns,key_column_usage,statistics}`. Verify-only, NO change (see Design Notes).
- `src/core/driver.test.ts:581-660` — the `pgSchemaScope` describe block; its local `textOf`/`argsOf`/`withSql` helpers are the pattern the new assertions reuse (never-connected client, no live DB).
- `src/core/driver.test.ts:140-146` — existing DW-19 classification cases (`42501`, `ER_TABLEACCESS_DENIED_ERROR`, errno `1142`, `ER_COLUMNACCESS_DENIED_ERROR`, `ER_SPECIFIC_ACCESS_DENIED_ERROR` → `auth`). Already covers the AC; verify green, do not duplicate.
- `src/core/connection.test.ts:234` — existing end-to-end DW-19 test (a `DriverConnectionError` from `listSchema` becomes `{status:"failed"}`, not a throw). Already covers the AC; verify green, do not duplicate.
- `_bmad-output/implementation-artifacts/deferred-work.md` — NOT edited by this story; the two follow-up candidates below are reported in the run summary for the orchestrator to record.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/driver-postgres.ts` -- add an exported pure `pgIndexColumnVisibility(sql: postgres.Sql): PgFragment` beside `pgSchemaScope` returning the single parenthesized fragment `(pg_has_role(t.relowner, 'USAGE') OR has_column_privilege(t.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES'))` -- exported-pure so it is assertable against a never-connected client, mirroring the `pgSchemaScope`/`pgSupportsConparentid` precedent.
- [x] `src/core/driver-postgres.ts` -- splice that fragment into the index query as a third conjunct (`WHERE ${idxScope} AND a.attnum > 0 AND ${idxVisibility}`), leaving the SELECT list, joins, `idxScope`, `a.attnum > 0` and the `array_position(...)` `ORDER BY` byte-for-byte unchanged -- the invisible row is never fetched, and no other predicate drifts.
- [x] `src/core/driver-postgres.ts` -- document at the index query why the predicate is Postgres's OWN `information_schema.columns` visibility check (aliases `t`/`a` already bound, no new join, no version-gated column) and why it is in-query rather than a post-`assembleSchema` trim -- the file's existing comment discipline (see `pgSchemaScope`, `partitionFilter`) is the standard.
- [x] `src/core/driver.test.ts` -- add a `pgIndexColumnVisibility` describe beside the `pgSchemaScope` one, reusing its `textOf`/`argsOf`/`withSql` helpers: assert the fragment's text equals the expected predicate character-for-character, that it binds NOTHING (`args` empty — it is a pure literal predicate), and that it references the `t.`/`a.` aliases the index query binds -- locks the predicate against silent drift with no live DB.
- [x] `src/core/driver.test.ts` + `src/core/connection.test.ts` -- VERIFY-ONLY: confirm the existing DW-19 cases (`driver.test.ts:140-146`, `connection.test.ts:234`) still pass and already lock "insufficient privileges to introspect at all → classified `auth` → `{status:"failed"}`"; add nothing if they do -- the spec requires a regression test only if coverage is missing, and it is not.
- [x] `src/core/driver-mysql.ts` -- VERIFY-ONLY: re-read `listSchema` and confirm all four queries read `information_schema.*` (privilege-filtered server-side) so no phantom risk exists; make NO change, and report immediately if this turns out false (Block-If #2).

**Acceptance Criteria:**
- Given a Postgres role with column-level-only grants, when the index query is composed, then the visibility predicate is part of its `WHERE` text — so a (table, column) pair `information_schema.columns` hides is never fetched, not fetched-then-dropped.
- Given the predicate, when compared to Postgres's own `information_schema.columns` definition, then it is the same check (`pg_has_role(relowner,'USAGE') OR has_column_privilege(oid, attnum, 'SELECT, INSERT, UPDATE, REFERENCES')`) with no invented approximation and no bound parameters.
- Given a fully-privileged role or superuser, when introspection runs, then behavior is identical to before this story — the predicate short-circuits true.
- Given credentials insufficient to introspect at all, when a root is expanded, then the failure exits as a classified, credential-free `auth` outcome via the existing DW-19 wrap, with no new `ConnectionFailureKind` added.
- Given DW-31, DW-42 and Story 10.2's scope fragments, when this story lands, then their queries and tests are untouched and green.
- Given the suite, when run, then `bunx tsc --noEmit`, `bun test` and `bun run build` are all clean and no test requires a live database.

## Design Notes

**Story 10.2 landed since this spec was drafted (commit `293b912`).** The Intent's "Story 10.2 has not landed" statement is stale but the resulting scope decision stands, for a different reason:

- `Driver.listSchema(schema?: string)` now exists and the pinned schema reaches it (`connection.test.ts:397`). So the "requested schema does not exist / isn't visible" AC sub-case is now *technically* reachable — this story still does NOT implement it, because 10.2 deliberately decided a nonexistent pin "simply yields zero tables — not an error", and turning that into a surfaced failure needs a taxonomy addition (`ConnectionFailureKind` has no schema-scope member), which this spec's Block-If #1 and its `Never` list forbid outright. **Decision: out of scope, recorded as follow-up candidate #1** — a schema-visibility probe + its failure kind belong to their own story, gated on a human taxonomy decision.
- 10.2 also rewrote the index query's `WHERE` from a literal predicate to `${idxScope}`. The new conjunct is additive and orthogonal: scope answers *which schema*, visibility answers *which (table, column) the role may see*.

**Follow-up candidate #2 — the FK query's analogous gap (confirmed).** `driver-postgres.ts:348-368` reads `pg_constraint`/`pg_attribute` with no privilege filter, exactly like the index query did. Confirmed real, explicitly out of scope per the `Never` list; report it for the deferred-work ledger.

**Not a leak, deliberately unfiltered:** rows for relkinds `information_schema.columns` omits (matviews, `'m'`) still survive the predicate when the role owns them. They cannot materialize a phantom tree node — `assembleSchema` only decorates tables the *columns* query produced — and adding a `relkind` filter would widen this story past the privilege framing of the epic AC.

**Why an exported fragment builder rather than an inline literal:** the composed query is only reachable through a live connection, so the sole no-live-DB way to lock the predicate against drift is the `pgSchemaScope` precedent — an exported pure builder taking the `sql` tag, asserted via its `strings`/`args`. Accepted limitation (identical to `pgSchemaScope`'s own tests): the assertion proves the fragment's text, not that it is spliced; the splice is guarded by review plus the fact that the builder has exactly one call site.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no diagnostics.
- `bun test` -- expected: full suite green, including the new `pgIndexColumnVisibility` assertions and the untouched DW-19/DW-31/DW-42/10.2 cases. No test opens a database.
- `bun run build` -- expected: all four build scripts complete without error.

**Manual checks (if no CLI):**
- Read the composed index query in `driver-postgres.ts` and confirm the visibility fragment is spliced into its `WHERE` (not applied after the fetch), and that `idxScope`, `a.attnum > 0` and the `array_position(...)` `ORDER BY` are unchanged.

## Spec Change Log

## Review Triage Log

### 2026-07-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 1, low 6)
- defer: 4: (high 0, medium 4, low 0)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[medium]` `[patch]` Nothing locked the SPLICE — deleting `AND ${idxVisibility}` from the index query would compile clean (an unused local) and pass every fragment assertion, silently removing the privilege filter. Added a source-text test that slices the index query out of `driver-postgres.ts` and asserts its `WHERE` carries `${idxScope}`, `a.attnum > 0` and `AND ${idxVisibility}`; verified non-vacuous by mutating the source in memory and confirming the assertion flips.
  - `[low]` `[patch]` The new JSDoc claimed "whatever `information_schema.columns` hides, the index query hides too", which is false — that view also filters `NOT attisdropped`, `relkind IN ('r','v','f','p')` and `NOT pg_is_other_temp_schema(...)`. Rewrote it to claim the PRIVILEGE axis only and to state why the other three are deliberately not mirrored (dropped columns cannot appear in `ix.indkey`; a surviving non-table relkind still cannot spawn a phantom node because `assembleSchema` only decorates tables the columns query produced).
  - `[low]` `[patch]` The FK query's analogous privilege gap lived only in the spec, which gets archived. Added a `KNOWN GAP, deliberate` comment at that query pointing at the ledger, so the asymmetry does not read as an oversight in six months.
  - `[low]` `[patch]` `textOf`/`argsOf`/`withSql` were COPIED verbatim from the `pgSchemaScope` block instead of reused, against this spec's own task text. Hoisted them to module scope, shared by both describes, with the postgres.js private-internals coupling (`.strings`/`.args`) documented once.
  - `[low]` `[patch]` `withSql`'s callback was typed `void`, so a future async assertion would run after teardown or be skipped. Widened to `void | Promise<void>` and awaited before `sql.end`.
  - `[low]` `[patch]` The third test's title claimed it verified the predicate references "only" the `t.`/`a.` aliases while asserting no absence, and its `startsWith("(")`/`endsWith(")")` pair does not prove single-unit parenthesization (`(a) OR (b)` satisfies both). Retitled honestly and replaced with a paren-depth check that fails if depth returns to 0 before the final character.
  - `[low]` `[patch]` `EXPECTED` is a literal copy of the source, i.e. a pure change-detector, with no pointer to ground truth. Documented that the predicate's authority is `information_schema.columns` in the server's own `information_schema.sql`, that a deliberate two-sided edit passes green, and that a future PG adding a privilege to the list would diverge unnoticed. Also trimmed the triple-repeated rationale (JSDoc + call site + test comment) down to one home and noted the `pg_has_role` short-circuit as the real per-row cost mitigation.

## Auto Run Result

Status: done

**Implemented change.** Postgres index introspection is now privilege-aligned with `information_schema.columns`. The index query's `WHERE` gained a third conjunct carrying that view's own privilege clause (`pg_has_role(t.relowner,'USAGE') OR has_column_privilege(t.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES')`), re-aliased to the `t`/`a` aliases the query already binds. A restricted role's out-of-grant (table, column) pairs are therefore never FETCHED — no index name, uniqueness flag or column name crosses the wire before being dropped. MySQL needed no change (all four of its introspection queries read `information_schema.*`, which the server privilege-filters). The "insufficient privileges to introspect at all" AC was already satisfied by DW-19's classification wrap and its existing tests; nothing was duplicated.

**Files changed.**
- `src/core/driver-postgres.ts` — new exported pure `pgIndexColumnVisibility(sql)` returning the privilege fragment; spliced into the index query's `WHERE` as `AND ${idxVisibility}`; a `KNOWN GAP, deliberate` marker on the FK query recording its unfixed analogous gap. No other query's structure, predicates or `ORDER BY` touched (DW-31, DW-42 and Story 10.2's scope fragments intact).
- `src/core/driver.test.ts` — `pgIndexColumnVisibility` describe locking the predicate text, its zero binds, and its single-unit parenthesization; a source-text test locking the SPLICE itself; `textOf`/`argsOf`/`withSql` hoisted to module scope and shared with the 10.2 block.
- `_bmad-output/implementation-artifacts/deferred-work.md` — four deferred entries (below).

**Review findings breakdown.** 7 patches applied (1 medium, 6 low — all comment/test hardening, no runtime behavior change), 4 deferred, 9 rejected, 0 intent gaps, 0 spec defects, 0 loopbacks.

Deferred: (1) the `unique` flag's semantics on a partially-visible composite index — needs a product call, the contract explicitly blessed the partial row; (2) the FK query's analogous privilege gap, out of scope by the contract's Never list; (3) no restricted-role fixture anywhere (`docker/seed.sql` has no roles/grants), so the behavior cannot be exercised by hand; (4) the tree cannot distinguish "no indexes" from "indexes hidden by privileges" — belongs to Story 10.5's per-root rendering.

**Verification performed.** `bunx tsc --noEmit` clean; `bun test` 1403 pass / 0 fail across 73 files (up from 1402 at baseline — the four new tests replace three, the fourth being the splice lock); `bun run build` exit 0, all four bundles written. The splice test was proved non-vacuous by mutating the adapter source in memory and confirming the assertion flips to false. No test opens a database.

**Residual risks.** The predicate lock is a change-detector: a deliberate edit made in both the source and `EXPECTED` passes green, and a future PostgreSQL release adding a privilege to `information_schema.columns`'s list would diverge unnoticed. The runtime effect itself has never been executed against a real restricted role (deferred entry 3) — correctness rests on the predicate being character-identical to the engine's own. Per-row `has_column_privilege` cost is unmeasured against the shared 30s introspection budget, mitigated in the common case by `pg_has_role` short-circuiting for owners.
