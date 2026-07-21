---
title: 'Add optional per-connection schema scope, applied in-query at introspection'
type: 'feature'
created: '2026-07-21'
status: 'done'
baseline_revision: '6fb93dfa5efdbb617afb41f28401bd5ee46ec73b'
final_revision: '20a7556bf7e9cb8844f6ef0dbaaacd28ca97f392'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 10 / Story 10.2
  - '{project-root}/_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html'
warnings: ['oversized']
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

## Resolved Decisions (step-02)

The intent-contract above flags four items for step-02. All are resolved here; the resolutions are binding and supersede the "flagged" wording in the contract.

- **R1 — Blank on edit means CLEAR.** `edit({id, schema: ""})` (or whitespace-only) clears the pinned schema; key absent/`undefined` still means "keep existing". This departs from `name`/`url` (where blank is a `bad_request`) and is justified: unlike the credential-bearing `url`, `schema` IS returned on `ConnectionSummary`, so the edit form can pre-fill it — blank is therefore an unambiguous user intent to empty the field, not the url's "the UI never held it" sentinel.
- **R2 — MySQL precedence: the pinned param wins.** `targetSchema = schema ?? database`. When neither is present, today's `SYSTEM_SCHEMAS` exclusion. A blank/whitespace `schema` is treated as unset at the driver boundary (defensive; the registry already trims).
- **R3 — No `STORE_SCHEMA_VERSION` bump.** Verified: `isStoredConnection` (`credential-store.ts:230-238`) is a pure positive `id`/`name`/`url` string check with no unknown-key rejection; write is a shallow array copy + `JSON.stringify`; read feeds decrypted objects straight into the map; accessors spread `{ ...rec }`. Nothing strips unknown fields. A bump would turn every existing v1 store into `schema-unknown` → `internal_error` and lose the user's saved connections. Block-If #1 does NOT trigger.
- **R4 — Wiring scope: per-target IN, boot manager OUT.** Block-If #2 does NOT trigger: the per-target thread is a small additive parameter thread (`getStoredUrl` already reads the full record and narrows it to the url). The boot manager is built from a CLI `--url` and has no saved-connection record in scope at all (`server.ts:254`), so there is nothing to pass; a CLI `--schema` flag is explicitly out of scope for this story.

## Code Map

**Contract + RPC boundary**
- `src/shared/contract.ts` — `ConnectionSummary` (376-381): add `readonly schema?: string` + a doc line distinguishing it from `TableRowsRequest.schema` (345, "qualify this table") and `ConnectResult.schema` (325, the introspected catalog). `AddConnectionParams` (410-414) and `EditConnectionParams` (416-424): add `readonly schema?: string`.
- `src/core/rpc.ts` — both `connections.*` handlers **whitelist fields key by key**, so `schema` is silently dropped unless forwarded. `connections.add` (165-171): accept and pass `schema` when it is a string; reject a non-string non-undefined `schema` with `bad_request`. `connections.edit` (172-192): same shape check, forwarded via the existing `...(p.schema === undefined ? {} : { schema: p.schema })` conditional-spread idiom.

**Persistence + registry**
- `src/core/credential-store.ts` — `StoredConnection` (104-108): add `readonly schema?: string`. `isStoredConnection` (230-238): add `(v.schema === undefined || typeof v.schema === "string")`. This is additive-safe (no legacy record has the key) and stops a corrupt/hand-edited store from binding a non-string into introspection SQL. **Do NOT touch `STORE_SCHEMA_VERSION`** (R3).
- `src/core/connection-registry.ts` —
  - New `checkSchema(schema: unknown): { ok: true; value: string | undefined } | FieldCheck-failure`: non-string → `bad_request` "schema must be a string"; trimmed empty → `undefined` (unset/clear); else the trimmed value. Mirrors `checkName`'s trim discipline but is never required.
  - `toSummary` (152-160) and `safeSummary` (172-178, **including the hand-built `catch` fallback literal**): emit `schema` by **conditional spread** — `...(record.schema === undefined ? {} : { schema: record.schema })`. Conditional (not `schema: undefined`) so the two `Object.keys(...).sort()).toEqual(["engine","host","id","name"])` assertions at `connection-registry.test.ts:158` and `:253` stay green for unpinned connections.
  - `add` (258-276): validate via `checkSchema`, build the record literal with the same conditional spread.
  - `edit` (278-325): extend the empty-patch fast path at the `params.name === undefined && params.url === undefined` line to also require `params.schema === undefined` — **without this, a schema-only edit silently no-ops and never writes**. Then `let nextSchema = existing.schema; if (params.schema !== undefined) { …checkSchema… }`, and build the new record with the conditional spread so a cleared schema drops the key entirely.
  - `StoredUrlLookup` (60-63): add `readonly schema?: string` to the `found` arm. `getStoredUrl` (342-357): return `{ kind: "found", url: record.url, ...(record.schema === undefined ? {} : { schema: record.schema }) }`.

**Wiring (per-target only — R4)**
- `src/core/connection-targets.ts` — `StoredUrlLookup` is **declared a second time here** (52-55), structurally duck-typed against the registry's; widen it too or the field never arrives. `ConnectionTargetsDeps.createManager` (69): `(url: string, schema?: string) => ConnectionManager`. `Cached` (103): add `readonly schema: string | undefined`. Cache-invalidation predicate (~140): `existing.url === lookup.url && existing.schema === lookup.schema` — **required**; url-only equality leaves a live manager serving stale introspection after a Settings schema edit. Construction site (~148-149): `createManager(lookup.url, lookup.schema)` and store `schema` in the cache entry.
- `src/core/server.ts` — the `createManager` factory literal (~338-339): `(url, schema) => createConnectionManager({ databaseUrl: url, schema, createDriver: options.createDriver })`. **Leave the boot manager at ~254 untouched** (R4).
- `src/core/connection.ts` — `ConnectionManagerDeps` (85-91): add `readonly schema?: string | undefined`. Capture it next to `databaseUrl` (~102). Pass it at the two `listSchema` call sites: `open()`'s `await d.listSchema()` (141) and `getSchema()`'s defensive re-introspection (220). The memoized `cached` schema is unaffected — a pinned-schema change is handled by the resolver's evict+recreate, never by mutating a live manager.

**Drivers**
- `src/core/driver.ts` — `Driver.listSchema` (37-38): widen to `listSchema(schema?: string): Promise<DatabaseSchema>` + doc the scope semantics. TS accepts every existing zero-arg implementation, so the 9 test fakes need no edits.
- `src/core/driver-postgres.ts` — `listSchema(schema?: string)` (173). Build four conditional `sql` fragments once, above the queries, using the existing `partitionFilter` pattern (260-262), and substitute them for the four hardcoded scope predicates: columns (183, `table_schema`), PK (201, `tc.table_schema`), index (234, `n.nspname`), FK (295, `con_ns.nspname`). **The server-version probe (252-254) stays unfiltered**, and the FK query's *referenced* side (`ref_ns.nspname`) stays unfiltered so cross-schema FK edges still resolve.
- `src/core/driver-mysql.ts` — `listSchema(schema?: string)` (192). The identical `where`/`params` ternary is copy-pasted four times (207-211, 226-230, 254-259, 286-290). Extract it into an exported pure helper `mysqlSchemaScope(schema, database)` (R2 precedence, fresh arrays per call) and call it at all four sites. `databaseOf`/`database` (157-165, 173) are unchanged.

**UI**
- `src/ui/settings/connections-model.ts` — `Draft` (30-38) and `emptyDraft` (35-38): add `schema: string`. `validateDraft` (73-93) needs **no new branch** (schema is free text, always optional); leave `DraftValidation`'s `"name" | "url"` field union alone.
- `src/ui/settings/SettingsPanel.tsx` — add one `<Field label="schema (optional)" placeholder="public">` to the add form (after the url field, ~391-404) and one to `EditRow` (~112-118); seed `EditRow`'s draft (98) with `schema: summary.schema ?? ""`. Both RPC param assemblies must carry it: `onAdd` (~269) sends `schema` only when non-blank (so an unpinned add stays byte-identical); `onSaveEdit` (~288-289) sends `schema: draft.schema.trim()` **only when it differs from the pin the row was rendered from** — blank is still the clear signal per R1, and the field is pre-filled so blank is unambiguous, but an untouched field must stay out of the patch so a save cannot clobber a pin changed out-of-band (amended by the 2026-07-21 review pass; the original "always send" wording is superseded). Labels stay lowercase English, matching the file.

**Tests**
- `src/core/driver.test.ts` — new pure unit coverage for `mysqlSchemaScope` (and the postgres scope decision if it is extracted as a pure helper). No existing test in this file changes.
- `src/core/connection.test.ts`, `src/core/connection-targets.test.ts`, `src/core/connection-registry.test.ts`, `src/core/credential-store.test.ts`, `src/core/rpc.test.ts` (its `fakeRegistry` at 23-60 must learn `schema` in lockstep), `src/ui/settings/connections-model.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` — add optional `schema?: string` to `ConnectionSummary`, `AddConnectionParams`, `EditConnectionParams`, with a doc line disambiguating it from the two other `schema` meanings in the file.
- [x] `src/core/credential-store.ts` — add `schema?: string` to `StoredConnection` and the optional-string clause to `isStoredConnection`. No `STORE_SCHEMA_VERSION` change.
- [x] `src/core/connection-registry.ts` — add `checkSchema`; thread `schema` through `add`, `edit` (incl. the empty-patch fast path and the clear-on-blank rule R1), `toSummary`, `safeSummary` (both arms) via conditional spread; widen `StoredUrlLookup.found` and `getStoredUrl`.
- [x] `src/core/rpc.ts` — forward `schema` in both `connections.add` and `connections.edit` with `typeof`-style shape checks matching the existing handler style.
- [x] `src/core/driver.ts` — widen `Driver.listSchema` to `listSchema(schema?: string)` and document that omitting it preserves the pre-story engine-default scope.
- [x] `src/core/driver-postgres.ts` — apply the pinned schema in-query at the four scope predicates via conditional `sql` fragments; leave the version probe and the FK referenced side unfiltered.
- [x] `src/core/driver-mysql.ts` — extract and export `mysqlSchemaScope(schema, database)` implementing R2, and use it at all four query sites.
- [x] `src/core/connection.ts` — add `schema` to `ConnectionManagerDeps` and pass it at both `listSchema` call sites.
- [x] `src/core/connection-targets.ts` + `src/core/server.ts` — widen the duplicated `StoredUrlLookup`, `createManager`, and `Cached`; include `schema` in the cache-invalidation predicate; pass `schema` from the server's manager factory. Boot manager untouched.
- [x] `src/ui/settings/connections-model.ts` + `src/ui/settings/SettingsPanel.tsx` — add the optional `schema` draft field, one input per form, `EditRow` pre-fill from the summary, and both RPC param assemblies per R1.
- [x] `src/core/driver.test.ts` — unit-test the schema-scope helper(s) across the I/O matrix rows: pinned + URL database, pinned only, URL database only, neither, and blank/whitespace pinned (treated as unset).
- [x] `src/core/connection-registry.test.ts` — cover add-with-schema, add-without-schema (summary key set stays `["engine","host","id","name"]`), edit-sets, edit-clears-on-blank, schema-only edit actually writes, non-string schema → `bad_request`, and `getStoredUrl` carrying `schema`.
- [x] `src/core/connection.test.ts` + `src/core/connection-targets.test.ts` — fake drivers that record the `listSchema` argument: assert the pinned schema reaches the driver, that omitting it passes `undefined`, and that editing ONLY the schema evicts and re-creates the cached target manager.
- [x] `src/core/rpc.test.ts` + `src/core/credential-store.test.ts` + `src/ui/settings/connections-model.test.ts` — extend the `fakeRegistry` in lockstep, assert dispatch forwards/rejects `schema`, assert a legacy record with no `schema` still loads, and cover the new draft field.
- [x] Run `bunx tsc --noEmit`, `bun test`, `bun run build` — all green, zero regressions on the omitted-schema path.

**Acceptance Criteria:**
- Given a saved connection with no pinned schema, when it is introspected through any path (boot manager or per-target resolver), then the SQL executed and the resulting `DatabaseSchema` are identical to pre-story behavior, and its `ConnectionSummary` carries no `schema` key at all.
- Given a connection saved with `schema: "reporting"`, when the per-target resolver introspects it, then the pinned value reaches `Driver.listSchema("reporting")` and every introspection query restricts its scope predicate to that one schema with the value bound as a query parameter — no query text contains a concatenated schema name, and no metadata for any other schema is fetched.
- Given a connection whose pinned schema is edited in Settings while a target manager for it is already cached and live, when the next read resolves that connection, then the stale manager is evicted and re-created, so the new scope takes effect within the same session.
- Given a credential store written before this story, when it is opened by this build, then every record loads with `schema === undefined` and no `schema-unknown` / `internal_error` is produced.

## Spec Change Log

## Review Triage Log

### 2026-07-21 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 3
- reject: 12
- addressed_findings:
  - `[medium]` `[patch]` The four Postgres scope fragments shipped inline and untested while MySQL got a pure exported helper with 7 tests — nothing proved the UNPINNED arms reproduced the pre-10.2 predicates verbatim (a one-character drift in `n.nspname !~ '^pg_'` would silently resurface `pg_toast` indexes) or that the pinned arms bound a parameter instead of splicing text. Extracted `pgSchemaScope(sql, schema)` in `driver-postgres.ts` and locked all four branches with DB-less tests that inspect each fragment's `strings`/`args` (verbatim unpinned text with empty args; pinned text carries `$n` and never the schema name).
  - `[medium]` `[patch]` `onSaveEdit` always sent `schema`, so a stale `EditRow` pre-fill could silently clobber a pin changed out-of-band (second window / second Studio on the same app dir) — including overwriting a real pin with `""` — and every save wrote, defeating the registry's empty-patch fast path. Now sent only when it differs from the stored value, via a new pure exported `editConnectionParams(id, draft, storedSchema)` in `connections-model.ts` (covered by the existing DOM-less test file) that also absorbs the url omit-when-blank rule; R1 semantics unchanged.
  - `[low]` `[patch]` Both drivers trimmed only to TEST emptiness and then bound the untrimmed string, so a stored `"  reporting  "` would match zero tables despite the comment calling the trim defensive. Both now bind `schema.trim()`, with unit coverage on each engine.
  - `[low]` `[patch]` The Postgres FK comment justified leaving `ref_ns.nspname` unfiltered so "a cross-schema FK edge still resolves its target" — it cannot, since under a pin the referenced table is never in the column result set and the ERD drops the edge. Comment corrected to the true rationale (the FK stays visible as metadata on its owning table); code unchanged.
  - `[low]` `[patch]` `connections.list` — the sole feeder of `summary.schema`, and therefore the entire justification for the blank-clears asymmetry — had no test carrying the pin; if it ever dropped the key every edit save would silently clear every pin with no failure. Added registry- and dispatch-level coverage, plus the unpinned key-set assertion.
  - `[low]` `[patch]` The add form's error line was gated on name/url length only, so typing solely into the new schema field left the Add button disabled with no explanation. Gate now includes the schema field.
  - `[low]` `[patch]` `ConnectionSummary.schema`'s doc claimed the pin is "the ONE schema this saved connection introspects", overstating today's reach — the boot manager (and so the schema tree, table browser, and chat) does not consult it yet. Reworded to say the pin applies where the connection is resolved as a target, with generalizing the read paths named as Story 10.4's job.
  - Deferred (3): silent empty catalog on a nonexistent/mis-cased/unreadable pin with no classified signal (contract-mandated here, lands with Epic 10's per-root error rendering); no `SettingsPanel.test.tsx` exists at all (pre-existing since Story 2.4); the pin scopes introspection only, so unqualified hand-written editor SQL still resolves against the session default (`search_path`/`USE` untouched — a materially larger semantic change).
  - Rejected (12, noise or out of scope): the pin not reaching the boot manager (Story 10.4 is the epic's designated backbone for resolving read paths by connection id; R4 scoped it out deliberately); the widened `isStoredConnection` "bricking" the store on a hypothetical `schema: null` (the guard clause is spec-mandated and no supported writer emits it); blank meaning "unpinned" on add vs "clear" on edit (R1, and add has nothing to clear); the schema input's unreachable `invalid` state (`checkSchema` only rejects non-strings, which a text input cannot produce); no length/charset cap on the pin (the contract declares it opaque, trim-only); MySQL cross-database grants unverified (folded into the deferred silent-empty entry); `mysqlSchemaScope`'s belt-and-braces readonly + fresh-array guarantees; the `schema` name being triple-booked in the contract and `createManager(url, schema?)` being positionally transposable; cache identity comparing the raw stored string (dissolved by the trim patch — the registry trims on write); pinning a system schema loading the whole catalog (the contract mandates REPLACING the exclusion, so a deliberate `pg_catalog` pin doing what it says is not a defect); eviction closing a manager with queries in flight (pre-existing repoint/removal behavior, unchanged); a pre-10.2 downgrade dropping the pin on edit (the accepted cost of additive-optional).

### 2026-07-21 — Review pass (follow-up, second pass)
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 3
- reject: 19
- addressed_findings:
  - `[low]` `[patch]` The Code Map still specified that `onSaveEdit` **always** sends `schema`, contradicting the `editConnectionParams` omit-when-unchanged rule that the FIRST review pass introduced — a reader reconciling spec against code would have read the shipped behavior as an undocumented deviation. Code Map amended to the shipped rule, with the superseded wording called out.
  - `[low]` `[patch]` `editConnectionParams`'s JSDoc justified omitting `schema` partly by "defeat the registry's empty-patch fast path" — false, since `name` is always sent, so a save from this form ALWAYS writes and the fast path is unreachable from the UI. The other half of the rationale (not clobbering an out-of-band pin) was verified true and the reason why was made explicit: the panel lists once on mount, so `storedSchema` is exactly the seed of the field and an untouched field therefore compares equal and drops out of the patch.
  - `[low]` `[patch]` `edit({id, schema: ""})` against an ALREADY-unpinned record skipped the empty-patch fast path (which tested only `params.schema === undefined`) and re-encrypted + flushed the whole store to rebuild a byte-identical record. The fast path now also treats a blank schema on an unpinned record as nothing-to-change, with non-strings still falling through to `checkSchema` so `bad_request` is unaffected; covered by a new no-write assertion.
  - Deferred (3): narrowed introspection will make row update/delete fail with a misleading PK error for out-of-pin tables once Story 10.4 routes the executor through the per-target manager (unreachable today — the executor reads the unpinned boot manager); `StoredUrlLookup` declared twice and coupled only by duck-typing (pre-existing, widened by hand in both files here); the edit form always sends `name`, leaving open for `name` the same stale-snapshot lost update this story closed for `schema` (pre-existing).
  - Rejected (19, noise, out of scope, or already-ledgered): re-raised silent-empty-on-bad-pin, `search_path`/`USE` untouched, and the MySQL pin-vs-URL-database divergence (all three already deferred by the first pass); the pin being invisible on the main surfaces and the boot manager staying unpinned (R4, rejected in pass 1); pinning a system schema on either engine (contract mandates REPLACING the exclusion, rejected in pass 1); no length/charset cap on the pin (contract declares it opaque); a non-string `schema` making the whole store `corrupt` (pre-existing all-or-nothing guard); `isStoredConnection` accepting `schema: ""` (unreachable — `checkSchema` turns blank into an absent key, so only a hand-edited store could produce it); `pgSchemaScope`'s tests reaching postgres.js `strings`/`args` and `PgFragment` being awaitable (the only DB-less way to lock the four predicates, which is precisely what pass 1 required; the accidental-`await` risk is speculative); `withSql` constructing a real postgres client per pure test (postgres.js is lazy and never connects to `127.0.0.1:1`); `edit` rebuilding the record literal instead of spreading `existing` (currently lossless, and a blind spread would break the conditional-clear semantics); MySQL's `[...params]` copy at each call site (the helper's JSDoc documents both halves — there is no contradiction); "blank" being re-derived in four places with two meanings (registry = clear, drivers = unset — deliberate and documented at both boundaries); the orphan FK marker on an ERD column whose edge is dropped under a pin (cosmetic, pin-only); the edit label reading `schema (optional, blank to clear)` where the Code Map said `schema (optional)` (the shipped label is strictly more informative); eviction closing a manager with queries in flight (pre-existing, rejected in pass 1); the `server.ts` `createManager` factory line being untested (both halves are covered and the transposition it would catch is type-identical, so the test would assert the wiring against itself); and the claim that the omit-when-unchanged rule gives NO lost-update protection (verified false — see the second patch above).

## Design Notes

**Postgres — scope as a replaceable conditional fragment.** Mirrors the existing `partitionFilter` idiom exactly: a `sql` fragment interpolated into the query text, with its value bound as a parameter by postgres.js. The unpinned branch reproduces today's predicate verbatim, so the omitted path is byte-identical.

```ts
const pin = schema === undefined || schema.trim().length === 0 ? undefined : schema;
const colScope = pin === undefined
  ? sql`table_schema NOT IN ('pg_catalog', 'information_schema')`
  : sql`table_schema = ${pin}`;
const idxScope = pin === undefined
  ? sql`n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`
  : sql`n.nspname = ${pin}`;
// ...WHERE ${colScope} ORDER BY ...   /   ...WHERE ${idxScope} AND a.attnum > 0 ...
```

`${pin}` is a plain JS value, so postgres.js binds it as `$n` — never spliced. Do **not** reach for `quoteIdent`: this is a value comparison against a catalog column, not an identifier position.

**MySQL — one exported pure helper, four call sites.**

```ts
export function mysqlSchemaScope(schema: string | undefined, database: string | null): {
  readonly where: string; readonly params: readonly string[];
} {
  const pin = schema === undefined || schema.trim().length === 0 ? null : schema;
  const target = pin ?? database;                                  // R2: the pin wins
  return target !== null
    ? { where: "table_schema = ?", params: [target] }
    : { where: `table_schema NOT IN (${SYSTEM_SCHEMAS.map(() => "?").join(", ")})`, params: [...SYSTEM_SCHEMAS] };
}
```

Fresh arrays per call (mysql2 consumes them positionally). This follows the file's own precedent of exporting internals purely for DB-less unit testing (`buildMysqlConfig`, `pgSupportsConparentid`, `createMutex`).

**Why the column query is the authority.** `assembleSchema` (`driver.ts:175-286`) only *decorates* tables the column query already produced (`if (entry === undefined) continue;`). Filtering the columns query alone would already be correct output; filtering the decorator queries too is what actually saves the fetch. Filtering the decorators but NOT the columns would silently lose PKs/indexes/FKs — so the four predicates must move together.

**Why blank-means-clear is safe here but not for `url`.** The url is credential-bearing and never returned to the UI, so a blank url input is genuinely ambiguous and the UI omits the key. `schema` rides on `ConnectionSummary`, so `EditRow` pre-fills it; a user who blanks a pre-filled field is unambiguously asking to unpin. The registry accordingly treats `schema: ""` as clear and `schema` absent as keep.

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: no type errors; the widened `listSchema` signature must not break any of the 9 zero-arg test fakes.
- `bun test` — expected: all green. In particular `connection-registry.test.ts:158` / `:253` (`Object.keys(...).toEqual(["engine","host","id","name"])`) must still pass for unpinned connections, and `driver.test.ts`'s pure helpers must be untouched apart from the new scope-helper block.
- `bun run build` — expected: production build succeeds.

**Manual checks:**
- Add a connection in Settings with the schema field blank → the tree behaves exactly as before. Edit it, set a schema, reopen the tree → only that schema's tables appear. Blank the field again and save → the pin is gone and all schemas return, within the same session (no restart).

## Auto Run Result

Status: done

**Summary:** Saved connections can now pin ONE schema, and that pin narrows introspection inside the SQL rather than after it. The optional `schema` rides from the Settings form through `AddConnectionParams`/`EditConnectionParams`, the RPC handlers, `StoredConnection` in the encrypted store, `ConnectionSummary`, and `getStoredUrl` into the per-target resolver, which hands it to `Driver.listSchema(schema?)`. Both adapters replace their system-schema exclusion with an exact-match predicate on all four introspection queries — Postgres via conditional `sql` fragments built like the existing `partitionFilter`, MySQL via a new pure `mysqlSchemaScope` where the pin outranks the URL's database — always as a bound parameter, never spliced. Omitting the pin reproduces pre-story behavior exactly, and no store version bump was needed.

**Files changed:**
- `src/shared/contract.ts` — optional `schema` on `ConnectionSummary`, `AddConnectionParams`, `EditConnectionParams`, documented against the two other `schema` meanings in the file.
- `src/core/rpc.ts` — both `connections.*` handlers shape-check and forward `schema`; `edit` forwards a blank value deliberately (it is the clear signal).
- `src/core/credential-store.ts` — `StoredConnection.schema?`; `isStoredConnection` accepts absent-or-string. No `STORE_SCHEMA_VERSION` bump.
- `src/core/connection-registry.ts` — new `checkSchema` (trim; blank ⇒ unset); threaded through `add`, `edit` (empty-patch fast path included, blank clears), `toSummary`, both `safeSummary` arms, `StoredUrlLookup`, `getStoredUrl` — all by conditional spread, so an unpinned record emits no `schema` key anywhere.
- `src/core/driver.ts` — `Driver.listSchema(schema?: string)`.
- `src/core/driver-postgres.ts` — new exported `pgSchemaScope(sql, schema)` returning the four conditional fragments; `listSchema` consumes them. Version probe and the FK referenced side stay unfiltered.
- `src/core/driver-mysql.ts` — new exported pure `mysqlSchemaScope(schema, database)` (pin wins over the URL database), used at all four query sites.
- `src/core/connection.ts` — `ConnectionManagerDeps.schema`, passed at both `listSchema` call sites.
- `src/core/connection-targets.ts` + `src/core/server.ts` — `createManager(url, schema?)`, `Cached.schema`, and schema included in the cache-invalidation predicate so a Settings re-scope evicts the live manager. Boot manager untouched.
- `src/ui/settings/connections-model.ts` — `Draft.schema` + new pure exported `editConnectionParams(id, draft, storedSchema)` holding both edit-patch rules.
- `src/ui/settings/SettingsPanel.tsx` — one schema input per form, edit pre-filled from the summary, add omits a blank pin, edit sends it only when changed.
- Tests — `driver.test.ts`, `connection.test.ts`, `connection-targets.test.ts`, `connection-registry.test.ts`, `credential-store.test.ts`, `rpc.test.ts`, `connections-model.test.ts`.

**Review findings breakdown (pass 2 — follow-up review):** 3 patches applied, all low and all documentation/no-op-write hygiene: the Code Map's stale "always sends `schema`" line was reconciled with the omit-when-unchanged rule pass 1 shipped; `editConnectionParams`'s JSDoc dropped a false claim about the registry's empty-patch fast path (unreachable from this form, since `name` is always sent) and now states WHY the lost-update protection actually holds (the panel lists once on mount, so `storedSchema` is the field's own seed); and `edit({id, schema: ""})` on an already-unpinned record no longer re-encrypts and flushes the store to rewrite an identical record. No production behavior changed beyond that one avoided write. 3 deferred (executor PK-resolution breakage that Story 10.4 will unmask; the hand-duplicated `StoredUrlLookup`; the still-open `name` lost update). 19 rejected. No intent_gap, no bad_spec, no review-loop iterations.

**Review findings breakdown (pass 1):** 7 patches applied (medium: locked the Postgres scope predicates with DB-less fragment tests after extracting `pgSchemaScope`; made the edit form send `schema` only when it changed, via a pure exported helper, closing a lost-update window and restoring the empty-patch fast path. low: bind the trimmed pin on both engines; correct the FK referenced-side comment; test that `connections.list` carries the pin; include the schema field in the add-form error gate; tighten the `ConnectionSummary.schema` doc to today's actual reach). 3 deferred (silent empty catalog on a bad pin; no `SettingsPanel.test.tsx` at all; the pin does not touch `search_path`/`USE`). 12 rejected. No intent_gap, no bad_spec, no review-loop iterations.

**Follow-up review recommended:** false — pass 2 (the follow-up pass 1 asked for) found nothing wrong with the two medium restructurings it was called to re-examine: `pgSchemaScope` and `editConnectionParams` both held up, and the only substantive claim against the latter was verified false. All three of its patches are low, localized, and non-behavioral except for skipping one redundant store write. A third pass has nothing left to converge on.

**Verification (pass 2):**
- `bunx tsc --noEmit` — green (0 errors).
- `bun test` — green, 1399 pass / 0 fail (73 files, 3497 expects). +1 test over pass 1 (the no-write blank-clear assertion), zero regressions.
- `bun run build` — green (4 bundles regenerated).

**Verification (pass 1):**
- `bunx tsc --noEmit` — green (0 errors).
- `bun test` — green, 1398 pass / 0 fail (73 files, 3494 expects). Baseline before the story was 1345; +53 tests, zero regressions. The `Object.keys(summary)` assertions at `connection-registry.test.ts:158`/`:253` still hold for unpinned connections.
- `bun run build` — green (4 bundles regenerated).

**Residual risks:**
- **No live-database verification.** The repo has no live-DB suite. The pinned Postgres and MySQL paths are proven by types, the fragment/`where`-params unit tests, and the wiring tests — but neither has executed against a real server. The spec's manual checks are still worth running.
- **The pin is not visible on the surfaces the user looks at yet.** Only the per-target resolver consults it; the schema tree, table browser, and chat still read through the boot manager, so a pinned connection looks unchanged there until Story 10.4 generalizes those read paths. The contract doc now says so explicitly.
- **A wrong pin is silent.** A typo, a case mismatch (Postgres folds unquoted identifiers, the predicate does not), or a schema the role cannot read yields an empty catalog indistinguishable from an empty database. Contract-mandated for this story; deferred for the epic's per-root error rendering.
- **Introspection-only scoping.** Unqualified hand-written SQL in the editor still resolves against the connection's default schema, so a pinned connection can show `reporting.users` in the tree while `SELECT * FROM users` reads `public.users`. Executor-generated DML is unaffected (it schema-qualifies). Deferred.
