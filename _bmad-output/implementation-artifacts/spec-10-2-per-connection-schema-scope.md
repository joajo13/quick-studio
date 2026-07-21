---
title: 'Add optional per-connection schema scope, applied in-query at introspection'
type: 'feature'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 10 / Story 10.2
  - '{project-root}/_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html'
---

<intent-contract>

## Intent

**Problem:** Today a saved connection always introspects every non-system-catalog schema. `Driver.listSchema()` (`src/core/driver.ts`) takes no arguments; `driver-postgres.ts` excludes only `pg_catalog`/`information_schema` (and, for the system-catalog index/FK queries, anything matching `^pg_`); `driver-mysql.ts` scopes to the URL's own database path segment when present, else excludes `information_schema`/`performance_schema`/`mysql`/`sys`. Neither driver — nor `ConnectionSummary`, the credential store's `StoredConnection`, or the Settings connection form — has any notion of a user-pinned single schema. On a database with thousands of tables spread across many schemas, this means the tree, PK, index, and FK metadata is always fetched for every schema the account can see, even when the user only cares about one.

**Approach:** Add an optional `schema?: string` all the way from the persisted connection record to the introspection SQL:
1. `ConnectionSummary` (`src/shared/contract.ts`) gains an optional `schema?: string` — additive, credential-free, mirrors the existing `host`/`engine` derivation pattern.
2. `StoredConnection` (`src/core/credential-store.ts`) gains the same optional field so it round-trips through the encrypted store; `AddConnectionParams`/`EditConnectionParams` gain an optional `schema?: string` so the UI can set/clear it on add and edit.
3. `connection-registry.ts` validates it (optional, trimmed; blank → omitted, mirroring `checkName`'s trim discipline but never required) and threads it through `add`/`edit`/`toSummary`/`safeSummary`.
4. The Settings connection form (`src/ui/settings/connections-model.ts` `Draft` + `SettingsPanel.tsx` add/edit rows) gains a `schema` text input, optional, no shape validation beyond trim (a schema name is an opaque server-side identifier — this story does not validate it against the live database).
5. `Driver.listSchema()` (`src/core/driver.ts`) widens to `listSchema(schema?: string): Promise<DatabaseSchema>`.
6. `driver-postgres.ts` and `driver-mysql.ts` apply `schema` **in the WHERE clause of each of the four introspection queries** (columns, PKs, indexes, FKs) — replacing the current system-schema exclusion with an exact-match filter when `schema` is provided, using the SAME parameterized/conditional-fragment mechanism the postgres adapter already uses for `partitionFilter` (an empty-vs-populated `sql` fragment, never string-interpolated). Omitting `schema` preserves EXACT current behavior byte-for-byte (regression-critical — see Boundaries).

## Boundaries & Constraints

**Always:**
- Filter IN THE QUERY (an added `WHERE`/`AND table_schema = $n` / `= ?` predicate on all four Postgres queries and all four+ MySQL queries), never by fetching everything and trimming client-side — the whole point is to avoid pulling metadata for thousands of out-of-scope tables.
- Bind `schema` as a real query parameter (postgres.js `sql` template interpolation / mysql2 `?` placeholder) — never string-concatenated into SQL text, consistent with every other identifier/value in these two files.
- Preserve the omitted-schema path as EXACTLY today's behavior: Postgres excludes `pg_catalog`/`information_schema` (and `^pg_*`/`information_schema` for the catalog-based index/FK queries); MySQL scopes to the URL's own database when present, else excludes `information_schema`/`performance_schema`/`mysql`/`sys`. No behavior change for any connection that does not set `schema`.
- Keep `ConnectionSummary.schema` and `StoredConnection.schema` additive-optional, mirroring the precedent in `WorkspaceSnapshot.erdLayouts`/`lastProvider` (contract.ts:756-772) — added without a version bump because a pre-existing consumer that does not know the field still round-trips correctly.
- Keep the field name `schema` consistent across all four layers (`ConnectionSummary`, `StoredConnection`, `AddConnectionParams`/`EditConnectionParams`, `Driver.listSchema(schema?)`) so no translation/renaming layer is needed.

**Block If:**
- If `isStoredConnection`'s type guard (`credential-store.ts:230-238`) or any other structural guard in that file would need to become STRICTER (reject unknown-shape) in a way that makes an optional `schema` unsafe to add without a store schema-version bump — re-verify against the actual guard body before implementing; if it turns out additive is unsafe, HALT and flag for a version-bump decision instead of guessing.
- If threading the pinned `schema` from a saved connection through to an ACTUAL `listSchema()` call (i.e., `connection.ts`'s `ConnectionManager` / `connection-targets.ts`'s per-target manager, which today call `d.listSchema()` with zero arguments and have no notion of a stored `schema`) turns out to require more than a small additive parameter thread — STOP and flag it for step-02 rather than improvising a wiring design; see the open question below.

**Never:**
- Never widen `schema` into anything that accepts raw SQL or an identifier list — it is a single scalar string value, always bound as a parameter, never quoted/interpolated into the query text.
- Never change the four queries' SELECT column lists, join shape, or ordering — only the WHERE-clause schema predicate changes.
- Never break the `omitted schema = current behavior` invariant — this is the back-compat contract for every already-saved connection (none of which have ever had a `schema` field) and for the existing (pure, DB-less) test suite in `driver.test.ts` (`mapUnsafeResult`, `pgSupportsConparentid`, `buildMysqlConfig`, `assembleSchema`, etc.), none of which may regress.
- Never require a `StoredConnection`/`StorePayload.schemaVersion` bump unless Block-If #1 above proves it's actually needed — additive-optional is the default assumption per the existing guard shape.

## I/O & Edge-Case Matrix

| Scenario | Input/State | Expected Output | Error Handling |
|----------|-------------|------------------|-----------------|
| Add connection, no schema set | `connections.add {name, url}` (no `schema`) | `ConnectionSummary` with `schema` absent/undefined; stored record has no `schema`; introspection behaves exactly as today | none |
| Add connection, schema set | `connections.add {name, url, schema: "public"}` | Stored + returned summary carry `schema: "public"` | Trim-only validation, mirrors `checkName`; no live-DB existence check in this story |
| Edit: set schema on existing connection | `connections.edit {id, schema: "reporting"}` | Record updated, no url/name change required | Same `not_found`/`bad_request` mapping as existing edit fields |
| Edit: clear a previously-set schema | `connections.edit {id, schema: ""}` (blank) | Clarify in step-02 whether blank means "clear" (→ `undefined`) vs "no-op" (undefined param already means no-op per existing `edit` convention) — flagged, see open questions | n/a — needs an explicit decision, not silently guessed |
| Postgres `listSchema()`, no schema | `d.listSchema()` | Identical SQL/behavior to pre-story: `table_schema NOT IN ('pg_catalog','information_schema')` (columns/PK), `nspname !~ '^pg_' AND nspname <> 'information_schema'` (index/FK) | none |
| Postgres `listSchema("public")` | `d.listSchema("public")` | All four queries add `AND table_schema = $n` (columns/PK) / `AND nspname = $n` (index/FK), parameterized, replacing the exclusion list | An unknown/nonexistent schema simply yields zero tables (same as today's behavior for an empty result) — not an error |
| MySQL `listSchema()`, no schema, URL has a database path | `d.listSchema()` | Identical to today: scoped to the URL's database via `table_schema = ?` | none |
| MySQL `listSchema()`, no schema, URL has no database path | `d.listSchema()` | Identical to today: `table_schema NOT IN (information_schema, performance_schema, mysql, sys)` | none |
| MySQL `listSchema("reporting")` | `d.listSchema("reporting")`, regardless of the URL's own database segment | Precedence between the pinned `schema` param and the URL-derived `database` needs an explicit rule — recommended: `schema` param wins when provided (single `targetSchema = schema ?? database` fold), falling back to today's URL/system-schema logic when absent — flagged for step-02 confirmation | n/a — needs an explicit decision |
| Existing pure driver tests | `bun test src/core/driver.test.ts` | All existing `assembleSchema`/`mapUnsafeResult`/`pgSupportsConparentid`/`buildMysqlConfig`/`classifyConnectionError` tests stay green — none of them exercise `listSchema()` against a live DB, so none should need edits for the added optional param | Any test needing an edit signals the interface change leaked beyond the intended additive-only surface |
| Store round-trip | A `StoredConnection` written before this story (no `schema` field) is read after this story's `isStoredConnection` guard | Loads cleanly, `record.schema === undefined` | Guard must NOT start rejecting pre-existing records lacking `schema` |

</intent-contract>

## Acceptance Criteria

**AC1 — form + record + summary carry the optional schema**
- Given the saved-connection record and the Settings connection form
- When I add or edit a connection and set (or leave blank) a `schema` field
- Then the value is persisted on the stored record and returned on `ConnectionSummary.schema`; omitting it keeps today's behavior exactly (no `schema` field ever appears on an untouched connection).

**AC2 — pinned schema narrows introspection, in-query**
- Given a connection whose stored/pinned `schema` is passed to `listSchema(schema)`
- When it is introspected
- Then all four Postgres introspection queries (columns, PKs, indexes, FKs) and their MySQL equivalents filter to that one schema via a bound query parameter in the WHERE clause — never by fetching every schema and discarding rows client-side — so metadata for out-of-scope tables/schemas is never fetched.

## Code Map

- `src/shared/contract.ts` — `ConnectionSummary` (~line 372-377): add optional `readonly schema?: string`. `AddConnectionParams` (~406-410) and `EditConnectionParams` (~412-420): add optional `readonly schema?: string`.
- `src/core/credential-store.ts` — `StoredConnection` (~line 104-108): add optional `readonly schema?: string`. `isStoredConnection` (~230-238): verify whether an added `typeof v.schema === "string" || v.schema === undefined` check is warranted (defensive) or unnecessary (guard already ignores extra/absent fields) — confirm in step-02, do not assume.
- `src/core/connection-registry.ts` — add a `checkSchema` (optional, trim-only, mirrors `checkName`'s shape but never required) alongside `checkName`/`checkUrl`; thread `schema` through `add`, `edit`, `toSummary`, `safeSummary`.
- `src/ui/settings/connections-model.ts` — `Draft` (~line 30-33): add `schema: string` (empty string = unset, consistent with how `url` already uses `""` as a sentinel for "no change"/"unset" in this file). `validateDraft` needs no new validation branch (schema is free text, always optional).
- `src/ui/settings/SettingsPanel.tsx` — add a `schema` labeled input to both the inline edit row (~line 86-117) and the add-connection form (~line 217, ~393-405), wired the same way the existing `name`/`url` fields are, and include `schema` in the `connections.add`/`connections.edit` RPC param objects (~269, ~283-289).
- `src/core/driver.ts` — `Driver.listSchema` (~line 37-38): widen signature to `listSchema(schema?: string): Promise<DatabaseSchema>`.
- `src/core/driver-postgres.ts` — `listSchema(schema?: string)` (currently ~line 173): apply `schema` to the columns query (~180-185), the PK query (~193-203), the index query (~222-238), and the FK query (~277-297). Recommended mechanism: mirror the existing `partitionFilter` conditional-`sql`-fragment pattern (~260-262) — an empty fragment when `schema` is undefined, `AND table_schema = ${schema}` / `AND nspname = ${schema}` when provided — rather than duplicating whole query strings.
- `src/core/driver-mysql.ts` — `listSchema(schema?: string)` (currently ~line 192): the columns/PK/index/FK queries (~207-298) each independently recompute a `where`/`params` pair from `database` (the URL-derived database). Fold `schema` into a single `targetSchema = schema ?? database` and reuse it across all four — recommended, confirm precedence rule in step-02 (see open question).
- `src/core/driver.test.ts` — no expected changes (it tests pure helpers only); re-run to confirm no regression.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] Add `schema?: string` to `ConnectionSummary`, `AddConnectionParams`, `EditConnectionParams` (`src/shared/contract.ts`).
- [ ] Add `schema?: string` to `StoredConnection` (`src/core/credential-store.ts`); confirm `isStoredConnection` needs no change (or add the defensive check if step-02 decides otherwise).
- [ ] Thread `schema` through `connection-registry.ts` (`checkSchema`, `add`, `edit`, `toSummary`, `safeSummary`).
- [ ] Add a `schema` field to the Settings connections `Draft` + add/edit form UI (`connections-model.ts`, `SettingsPanel.tsx`).
- [ ] Widen `Driver.listSchema` to accept `schema?: string` (`driver.ts`).
- [ ] Apply `schema` in-query to all four Postgres introspection queries (`driver-postgres.ts`), preserving omitted-schema behavior exactly.
- [ ] Apply `schema` in-query to all four MySQL introspection queries (`driver-mysql.ts`), resolving the `schema` vs URL-`database` precedence per step-02's decision.
- [ ] Resolve the wiring open question (does this story also thread the stored `schema` from `connection.ts`/`connection-targets.ts` into the actual `d.listSchema(schema)` call, or is that deferred to a later story) and update the Code Map accordingly before implementation starts.
- [ ] Run `bunx tsc --noEmit`, `bun test` (full suite, especially `driver.test.ts` and `connection-registry.test.ts`), `bun run build` — all green, no regression on the omitted-schema path.

## Spec Change Log

<!-- populated by step-02+ as the spec is refined -->

## Review Triage Log

<!-- populated by the review loop -->
