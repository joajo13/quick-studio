---
title: 'Connection-failure taxonomy — database-does-not-exist + malformed-url'
type: 'feature'
created: '2026-07-17'
status: 'done'
baseline_revision: '7b352b190cf24eab4f534899c5ffef5d345d471f'
final_revision: 'f0b7be1010b8da1901a11355ee14c610d98e0d1c'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** The neutral `ConnectionFailureKind` taxonomy has only four buckets, so two truthful outcomes are misreported: a valid host+auth pointed at a **missing catalog** (PG SQLSTATE `3D000`, MySQL errno `1049`/`ER_BAD_DB_ERROR`) is classified as `network` ("could not reach the database"), and a **malformed-but-supported-scheme URL** (bad/out-of-range port or unparseable authority on a `postgres`/`mysql` URL, which makes `new URL()` throw) is rejected as `unsupported_scheme` — a false verdict, since the scheme IS supported.

**Approach:** Additively extend the taxonomy with two new kinds — `database-does-not-exist` and `malformed-url` — wiring `3D000`/`1049`/`ER_BAD_DB_ERROR` into `classifyConnectionError`, and teaching `schemeOf`/`createDriver` to recover the scheme even when `new URL()` throws so a malformed supported-scheme URL yields `malformed-url` instead of `unsupported_scheme`. Consumers render the kind by string interpolation (`SchemaTree.tsx`) and the `NEUTRAL_MESSAGE` record is compiler-enforced-exhaustive, so no consumer rippling is required.

## Boundaries & Constraints

**Always:**
- Keep the change ADDITIVE: existing kinds (`host`/`auth`/`network`/`unsupported_scheme`) and every current classification result stay unchanged. The four `file:`/`javascript:`/`data:`/`C:\…` unsupported-scheme cases MUST still classify as `unsupported_scheme`.
- Messages stay neutral and credential-free — never interpolate the URL, userinfo, host, or raw engine text. The (non-secret) scheme name MAY appear, mirroring the existing `unsupported_scheme` message.
- `classifyConnectionError` stays pure and total, defaults unrecognized errors to `network`, and NEVER returns `malformed-url` or `unsupported_scheme` (both are `createDriver`'s verdict alone).
- `NEUTRAL_MESSAGE` remains an exhaustive `Record<ConnectionFailureKind, string>` (compiler enforces a message per kind).
- A well-formed URL with a supported scheme still builds its driver exactly as today; `malformed-url` is only reached when `new URL()` throws for a recovered supported scheme.

**Block If:**
- The intent demands a taxonomy kind whose neutral wording or classification would collide with an existing kind's meaning such that an existing test would have to change its expected result (would signal a non-additive regression).

**Never:**
- Do NOT add a `permission` bucket or re-map any existing DW-19 auth codes.
- Do NOT echo credentials or raw exception text in any message.
- Do NOT change consumer UI components beyond what the compiler forces (none expected — kinds are interpolated, not switched).
- Do NOT attempt a live-DB connection to detect malformed URLs — the verdict is structural (URL parse), decided before any socket opens.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PG missing catalog | error `{ code: "3D000" }` | `classifyConnectionError` → `"database-does-not-exist"` | Neutral message, no leak |
| MySQL missing catalog (code) | error `{ code: "ER_BAD_DB_ERROR" }` | → `"database-does-not-exist"` | Neutral message |
| MySQL missing catalog (errno) | error `{ errno: 1049 }` | → `"database-does-not-exist"` | Neutral message |
| Out-of-range port, supported scheme | `createDriver("postgres://host:99999/db")` | throws `DriverConnectionError` kind `"malformed-url"` | No socket opened |
| Unparseable authority, supported scheme | `createDriver("postgres://host:5432x/db")`, `mysql://host:99999/db` | throws kind `"malformed-url"` | No socket opened |
| Unsupported scheme (regression guard) | `file:///etc/passwd`, `javascript:alert(1)`, `data:text/plain,hi`, `C:\db\thing` | throws kind `"unsupported_scheme"` (unchanged) | No socket opened; no credential leak |
| Unparseable AND unsupported scheme | `createDriver("://nonsense")` (no extractable scheme) | throws kind `"unsupported_scheme"` | No socket opened |
| classify never yields URL verdicts | any error | result ∈ {host,auth,network,database-does-not-exist} — never `malformed-url`/`unsupported_scheme` | — |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- `ConnectionFailureKind` union; add `"database-does-not-exist"` and `"malformed-url"` members + doc.
- `src/core/driver.ts` -- `classifyConnectionError` (add DB-not-found code/errno sets), `NEUTRAL_MESSAGE` (add two entries), `schemeOf` (recover scheme when `new URL()` throws), `createDriver` (emit `malformed-url` for a malformed supported-scheme URL).
- `src/core/driver.test.ts` -- add classify + createDriver cases for both new kinds; keep the existing unsupported-scheme regression cases green.
- `src/core/driver-postgres.ts` / `src/core/driver-mysql.ts` -- NO change; they already route connect errors through `toDriverConnectionError` → `classifyConnectionError`. (Read-only reference.)
- `src/ui/schema/SchemaTree.tsx` -- NO change; renders `${failure}: ${message}` by interpolation. (Read-only reference.)

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- Add `"database-does-not-exist"` and `"malformed-url"` to the `ConnectionFailureKind` union with a one-line doc each -- gives the taxonomy a truthful bucket for a missing catalog and a malformed supported URL.
- [x] `src/core/driver.ts` -- Add `DB_NOT_FOUND_CODES` (`"3D000"`, `"ER_BAD_DB_ERROR"`) and `DB_NOT_FOUND_ERRNO` (`1049`); classify them to `"database-does-not-exist"` (disjoint from existing sets, so order is immaterial). Add both new `NEUTRAL_MESSAGE` entries. Refactor `schemeOf` to return `{ scheme, wellFormed }`, recovering the scheme via a leading RFC-3986 scheme match when `new URL()` throws. In `createDriver`, when the recovered scheme is supported (`postgres`/`postgresql`/`mysql`) but `wellFormed` is false, throw `DriverConnectionError("malformed-url", …)` (scheme-named, credential-free); otherwise the existing supported→driver and unsupported→`unsupported_scheme` paths are unchanged -- truthful classification without touching adapters or consumers.
- [x] `src/core/driver.test.ts` -- Add unit cases for every I/O Matrix row (three `database-does-not-exist` classify cases, three `malformed-url` createDriver cases, the unsupported-scheme regression guards, the unparseable-and-unsupported case, and an assertion that `classifyConnectionError` never returns `malformed-url`) -- pins the additive taxonomy and guards the regression.

**Acceptance Criteria:**
- Given an authenticated connection whose URL names a nonexistent database, when the engine rejects it (`3D000` / `1049` / `ER_BAD_DB_ERROR`), then `classifyConnectionError` returns `"database-does-not-exist"` and the surfaced message is neutral and credential-free.
- Given a `postgres`/`mysql` URL with a bad or out-of-range port, when `createDriver` is called, then it throws a `DriverConnectionError` of kind `"malformed-url"` before any socket is opened, and the message never echoes credentials.
- Given any of the four previously-`unsupported_scheme` inputs (`file:`, `javascript:`, `data:`, `C:\…`), when `createDriver` is called, then the kind is still `"unsupported_scheme"` (no regression).
- Given the full unit suite, when `bun test src/core/driver.test.ts` runs, then all cases pass and `bunx tsc --noEmit` reports no type error (exhaustive `NEUTRAL_MESSAGE`).

## Review Triage Log

### 2026-07-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 0, low 5)
- defer: 1: (low 1)
- reject: 4
- addressed_findings:
  - `[low]` `[patch]` Leading-whitespace / embedded-tab supported URL was misclassified `unsupported_scheme` (recovery regex anchored at 0 diverged from WHATWG input cleaning) — normalized the URL (strip tab/newline, trim) in `schemeOf`'s catch before the scheme match, and added ` postgres://…:99999/db` test case.
  - `[low]` `[patch]` Malformed-url neutrality test was a denylist (`not.toContain("secret"/"user")`) — strengthened to exact-equality against the neutral literal so any raw-URL splice regresses the test.
  - `[low]` `[patch]` Coverage gaps — added `postgresql://` alias, a non-port unparseable authority (`ho st`), and the load-bearing `redis://host:99999` → still-`unsupported_scheme` regression guard.
  - `[low]` `[patch]` Duplicated inline `malformed-url` throw across the postgres/mysql branches — hoisted a `malformedUrlError(scheme)` helper so wording can't drift.
  - `[low]` `[patch]` Traceability — corrected DW-18 → DW-21 attribution on the malformed-url test comment.
  - Deferred (not written to the ledger per the orchestrator's do-not-edit directive; surfaced here for the orchestrator): `SchemaTree.tsx:138` renders `${failure}: ${message}`, exposing the raw hyphenated kind slug to users — a pre-existing UX papercut, explicitly out of this additive-taxonomy scope.
  - Rejected: `malformed-url` only firing on a `new URL()` throw (that is DW-21's stated scope); the `wellFormed` name (documented, means "did not throw"); the `NEUTRAL_MESSAGE` fallback entries being unused for their code paths (pre-existing pattern identical to `unsupported_scheme`, compiler-mandated by the exhaustive `Record`); unpinned `new URL()` semantics (already pinned by the new `createDriver` throw tests).

## Design Notes

`schemeOf` today returns `string | null` and loses the scheme whenever `new URL()` throws — which is exactly the malformed-URL case. The fix recovers the scheme structurally so a malformed supported URL is distinguishable from an unsupported one:

```ts
function schemeOf(url: string): { scheme: string | null; wellFormed: boolean } {
  try {
    return { scheme: new URL(url).protocol.replace(/:$/, "").toLowerCase(), wellFormed: true };
  } catch {
    // new URL() threw (bad/out-of-range port, unparseable authority): recover the
    // leading RFC-3986 scheme so a malformed-but-supported URL is not misread as
    // an unsupported scheme. `null` when no scheme is extractable at all.
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
    return { scheme: m ? m[1].toLowerCase() : null, wellFormed: false };
  }
}
```

`createDriver` then gates on `wellFormed` only for the supported branches (`postgres`/`postgresql` → pg, `mysql` → mysql): a supported scheme that is not well-formed throws `malformed-url`; everything else keeps the existing unsupported-scheme composition. Verified at runtime: `new URL("postgres://host:99999/db")` and `new URL("postgres://host:5432x/db")` throw, while `file:`/`javascript:`/`data:`/`C:\db\thing` parse fine (so those stay `unsupported_scheme`).

## Verification

**Commands:**
- `bun test src/core/driver.test.ts` -- expected: all cases pass, including the new taxonomy and the unchanged unsupported-scheme regression guards.
- `bunx tsc --noEmit` -- expected: no type error (proves `NEUTRAL_MESSAGE` stays exhaustive over the widened union).
- `bun test` -- expected: full suite green (no consumer regressed by the additive union).

## Auto Run Result

Status: **done**

**Implemented change:** Additively extended the neutral `ConnectionFailureKind` taxonomy with two truthful buckets — `database-does-not-exist` (DW-18: PG SQLSTATE `3D000`, MySQL `ER_BAD_DB_ERROR`/errno `1049`, classified in `classifyConnectionError`) and `malformed-url` (DW-21: a supported-scheme URL that `new URL()` cannot parse, emitted structurally by `createDriver` before any socket opens). No consumer rippling: the sole exhaustive `Record<ConnectionFailureKind, string>` (`NEUTRAL_MESSAGE`) is compiler-enforced, and every other consumer treats the kind opaquely.

**Files changed:**
- `src/shared/contract.ts` -- added the two union members + doc to `ConnectionFailureKind`.
- `src/core/driver.ts` -- `DB_NOT_FOUND_CODES`/`DB_NOT_FOUND_ERRNO` sets + classify branch; two `NEUTRAL_MESSAGE` entries; `schemeOf` now returns `{ scheme, wellFormed }` with WHATWG-aligned scheme recovery (strip tab/newline + trim) on parse failure; `createDriver` throws `malformed-url` for a malformed supported scheme via a hoisted `malformedUrlError` helper.
- `src/core/driver.test.ts` -- classify cases for `database-does-not-exist`; `createDriver` cases for `malformed-url` (out-of-range port, unparseable non-port authority, `postgresql` alias, leading whitespace) with exact-literal neutrality assertions; regression guards for unsupported schemes (`://nonsense`, `redis://host:99999`); never-`malformed-url` classify guard.

**Review findings breakdown:** 5 patches applied (all low — whitespace normalization, exact-equality neutrality assertion, 4 added test cases, throw dedupe, DW-21 traceability fix); 1 deferred (low — pre-existing raw-slug UI display, surfaced to the orchestrator, NOT written to the ledger per the do-not-edit directive); 4 rejected. 0 intent_gap, 0 bad_spec — no loopback.

**Verification performed:**
- `bunx tsc --noEmit` -- no errors.
- `bun test src/core/driver.test.ts` -- 60 pass / 0 fail (99 expect calls).
- `bun test` (full suite) -- 1226 pass / 0 fail across 71 files.

**Residual risks:** Minimal. `malformed-url` intentionally fires only when `new URL()` throws (DW-21's stated scope); structurally-parseable-but-useless URLs (`postgres://`, `postgres://host:0/db`) still surface as `host`/`network` at connect, as before. The pre-existing raw-slug UI display is unchanged (deferred).
