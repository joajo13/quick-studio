---
title: 'DW-37: Engine-aware createTable type allowlist'
type: 'bugfix'
created: '2026-07-20'
status: 'done'
baseline_revision: '49a71519e944a69ef3de7722a6504a9834586674'
final_revision: '5a3098e572dd2d264827d4c10c173cb2ab2d7278'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** The structured `createTable` composer in `src/core/executor.ts` uses one engine-blind allowlist (`CREATE_TABLE_TYPES`) and emits each validated token verbatim into DDL. On MySQL, a shape-valid request carrying `UUID` (no native MySQL type) or bare `VARCHAR` (MySQL requires a length) composes DDL the engine rejects, surfacing as an opaque `internal_error` instead of a clear contract error.

**Approach:** Split validation into two tiers. Keep the engine-blind shape gate (the union of all engine-supported tokens) applied before any connection round-trip. Add an engine-aware DDL map applied at compose time (once the target engine is known) that renders the engine-correct fragment per token — or, for a token with no valid representation on the target engine, returns a clear `bad_request` before any DDL runs. Net effect: a shape-valid `createTable` either produces valid DDL for the target engine or is rejected with a contract-level error, never an engine `internal_error`.

## Boundaries & Constraints

**Always:**
- `CREATE_TABLE_TYPES` (the shape allowlist) MUST be the union of the per-engine DDL map keys — single source of truth, no hand-maintained drift.
- Engine-unsupported-but-shape-valid tokens reject via the existing `bad()` helper (`bad_request`) BEFORE `runQuery`, naming the column, token, and engine.
- Values stay parameterized and identifiers stay `quoteIdent`-escaped exactly as today — this changes only the rendered type fragment.
- The compose-time invariant guard (token not in `CREATE_TABLE_TYPES` → thrown invariant violation) stays: it distinguishes a Core bug from an engine-capability rejection.
- Postgres rendering is unchanged for every currently-accepted token (no Postgres regression).

**Block If:**
- The set of `DbEngine` values is anything other than `"postgres" | "mysql"` (would make `Record<DbEngine, …>` non-exhaustive) — HALT.

**Never:**
- No raw-text type fallback — tokens remain a fixed allowlist.
- Do NOT plumb engine into the Ring 2 UI (`CreateTablePanel` / `create-table.ts`). The documented architecture makes the Core the single source of truth and the UI surfaces a `bad_request` inline ("drift fails closed"); engine-aware dropdown filtering is out of scope.
- Do NOT add new column-def input fields (e.g. VARCHAR length) — the column-def shape is unchanged.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Portable token, postgres | `{name:"id",type:"INTEGER"}`, engine postgres | `"id" INTEGER` (unchanged) | No error expected |
| Portable token, mysql | `{name:"id",type:"BIGINT"}`, engine mysql | `` `id` BIGINT `` (unchanged) | No error expected |
| Bare VARCHAR, postgres | `{name:"s",type:"VARCHAR"}`, engine postgres | `"s" VARCHAR` (unchanged, unbounded) | No error expected |
| Bare VARCHAR, mysql | `{name:"s",type:"VARCHAR"}`, engine mysql | `` `s` VARCHAR(255) `` (default length so DDL is valid) | No error expected |
| UUID, postgres | `{name:"id",type:"UUID"}`, engine postgres | `"id" UUID` (unchanged) | No error expected |
| UUID, mysql | `{name:"id",type:"UUID"}`, engine mysql | Rejected, nothing runs | `bad_request`: `column 'id' type 'UUID' is not supported on mysql` |
| Out-of-allowlist token | `{name:"c",type:"int; DROP…"}` | Rejected at shape validation | `bad_request` (unchanged, before engine round-trip) |

</intent-contract>

## Code Map

- `src/core/executor.ts` -- `CREATE_TABLE_TYPES` (line ~40) and `executeCreateTable` (line ~537): the shape allowlist and the composer emitting the verbatim token. Primary change site.
- `src/core/executor.test.ts` -- `describe("structured createTable …")` (line ~685): existing composer tests; extend with per-engine cases.
- `src/shared/contract.ts` -- `DbEngine = "postgres" | "mysql"` (line ~218): confirms two-engine exhaustiveness.
- `src/ui/schema/create-table.ts` -- UI mirror of `CREATE_TABLE_TYPES`; NOT modified (see Never). Its header already documents the fail-closed inline-surfacing contract this fix relies on.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/executor.ts` -- Introduce `CREATE_TABLE_TYPE_DDL: Record<DbEngine, Record<string, string>>` mapping each canonical token to its engine-correct DDL fragment (mysql `VARCHAR`→`VARCHAR(255)`, mysql omits `UUID`; all other tokens identical on both engines; postgres unchanged). Derive `CREATE_TABLE_TYPES` as the union of both maps' keys. In `executeCreateTable`, after `getEngine()`, look up the engine's map per column: render `quoteIdent(name) <ddl>[ NOT NULL]`; if the token is absent from that engine's map, `return bad(\`column '<name>' type '<TOKEN>' is not supported on <engine>\`)` before `runQuery`. Keep the compose-time invariant throw for tokens outside `CREATE_TABLE_TYPES`. Remove the now-obsolete `void engine;` no-op. -- Makes the composer engine-aware so MySQL never composes invalid DDL.
- [x] `src/core/executor.test.ts` -- Add cases to the createTable describe covering the I/O matrix: mysql bare `VARCHAR` → `VARCHAR(255)`; mysql `UUID` → `bad_request` with no `runQuery`; postgres `VARCHAR` and `UUID` unchanged; a portable token identical on both engines. -- Locks the per-engine contract and guards against drift.

**Acceptance Criteria:**
- Given a shape-valid `createTable` with a token unsupported on the target engine, when executed, then the reply is `bad_request` naming the column/token/engine and `runQuery` is never called.
- Given a `createTable` on MySQL with a `VARCHAR` column, when executed, then the composed DDL renders `VARCHAR(255)` (valid MySQL) rather than bare `VARCHAR`.
- Given any `createTable` on Postgres that succeeded before this change, when executed, then the composed DDL is byte-identical to before (no regression).

## Design Notes

Single source of truth prevents allowlist drift:

```ts
const CREATE_TABLE_TYPE_DDL: Record<DbEngine, Record<string, string>> = {
  postgres: { INTEGER:"INTEGER", …, VARCHAR:"VARCHAR", UUID:"UUID", JSON:"JSON" },
  mysql:    { INTEGER:"INTEGER", …, VARCHAR:"VARCHAR(255)", /* no UUID */ JSON:"JSON" },
};
const CREATE_TABLE_TYPES: ReadonlySet<string> = new Set([
  ...Object.keys(CREATE_TABLE_TYPE_DDL.postgres),
  ...Object.keys(CREATE_TABLE_TYPE_DDL.mysql),
]);
```

Rationale for the two per-engine differences: MySQL rejects a length-less `VARCHAR` (Postgres treats bare `VARCHAR` as unbounded), so MySQL gets a default `VARCHAR(255)` while Postgres stays bare — no Postgres behavior change. MySQL has no native `UUID` type; rather than silently remap to `CHAR(36)` (a storage-semantics surprise), `UUID` is postgres-only and rejected on MySQL with an honest contract error, matching this executor's fail-closed, no-silent-surprise philosophy. All other canonical tokens (`INTEGER`/`BIGINT`/`SMALLINT`/`TEXT`/`BOOLEAN`/`DATE`/`TIMESTAMP`/`NUMERIC`/`REAL`/`DOUBLE PRECISION`/`JSON`) are valid DDL on both engines and render identically.

## Verification

**Commands:**
- `bun test src/core/executor.test.ts` -- expected: all createTable cases pass, including the new per-engine ones.
- `bunx tsc --noEmit` -- expected: no type errors (the `Record<DbEngine, …>` stays exhaustive).

## Review Triage Log

### 2026-07-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 2: (high 0, medium 2, low 0)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[low]` `[patch]` Edge-completeness of the in-scope reject contract: added a test proving an engine-unsupported token in a NON-first column position still short-circuits to `bad_request` before any DDL runs (`src/core/executor.test.ts`).

Deferred (NOT written to the ledger per orchestrator directive — recorded here for the orchestrator):
- `[medium]` Cross-engine semantic divergence of allowlisted types emitted verbatim on BOTH engines — all pre-existing, unchanged by this story, outside DW-37's "valid-DDL-or-clear-error" scope (they produce VALID DDL, no engine error): MySQL bare `NUMERIC`→`DECIMAL(10,0)` silently drops decimal scale; `REAL` = float4 on PG vs double on MySQL; `TIMESTAMP` range/timezone/implicit-default differences; `BOOLEAN`→`TINYINT(1)` so create-then-introspect type differs.
- `[medium]` A `TEXT`/`BLOB` column placed in `PRIMARY KEY` composes `PRIMARY KEY (text_col)`, which MySQL rejects with an opaque `internal_error` ("BLOB/TEXT column used in key specification without a key length"). Same family as DW-37 but a PK-eligibility constraint (distinct mechanism from the type-token map), pre-existing and untouched by this change.

Rejected (noise / by-design / false-positive): `VARCHAR(255)` default is a deliberate spec choice (no length field by design; MySQL requires a length); `bad()` short-circuiting on the first bad column matches the executor's first-error-wins convention (`readColumnDefs`); the compose-time invariant `throw` is intentionally unreachable defensive code; two "empty `defs`" edge cases are already guarded upstream by `readColumnDefs` rejecting an empty `columns` array.

## Auto Run Result

Status: done

**Implemented change:** Split the structured `createTable` type validation into two tiers so a shape-valid request either composes valid DDL for the target engine or is rejected with a contract-level `bad_request` — never an opaque engine `internal_error`. `CREATE_TABLE_TYPE_DDL: Record<DbEngine, Record<string,string>>` renders the engine-correct DDL fragment per token; `CREATE_TABLE_TYPES` (the engine-blind shape gate) is now derived as the union of both maps' keys (single source of truth). MySQL renders bare `VARCHAR` as `VARCHAR(255)` (length required) and rejects `UUID` (no native type); Postgres rendering is byte-identical to before.

**Files changed:**
- `src/core/executor.ts` — engine-aware DDL map + union-derived shape allowlist; `executeCreateTable` compose loop now does a per-engine lookup and short-circuits to `bad_request` for a token unsupported on the target engine before `runQuery`; removed the obsolete `void engine;`.
- `src/core/executor.test.ts` — 5 new createTable cases (mysql VARCHAR→`VARCHAR(255)`, mysql UUID→`bad_request`/no-DDL, postgres VARCHAR unchanged, postgres UUID valid, and unsupported-token-in-non-first-position→`bad_request`/no-DDL).

**Review findings breakdown:** 1 patch applied (non-first-position reject test); 2 deferred (recorded above for the orchestrator, ledger untouched per directive); 7 rejected as by-design/pre-existing-out-of-scope/false-positive.

**Verification:** `bun test src/core/executor.test.ts` → 97 pass / 0 fail (262 expect calls). `bunx tsc --noEmit` → no type errors. Postgres DDL confirmed byte-identical for all previously-accepted tokens (existing composer tests unchanged and green).

**Follow-up review recommended:** false — the only review-driven change was one localized low-consequence test addition; the implementation itself was unchanged during review.

**Residual risks:** The two deferred items (cross-engine semantic type parity; `TEXT`/`BLOB`-in-PK opaque MySQL error) remain as pre-existing gaps outside this story's scope.
