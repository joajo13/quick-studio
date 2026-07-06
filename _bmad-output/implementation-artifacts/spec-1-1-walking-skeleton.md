---
title: 'Story 1.1 — Walking Skeleton: authenticated Core↔UI channel + shared contract'
type: 'feature'
created: '2026-07-06'
status: 'done'
baseline_revision: '0b69971318d3cbdf907da5263d20a6156188735b'
final_revision: 'b97914ce3696daddfe102f8b7ca39b85aa1458fc'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-quick-studio-2026-07-06/ARCHITECTURE-SPINE.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** quick-studio has no code yet, and every later feature depends on a secure, authenticated Core↔UI channel plus a canonical shared data contract that does not exist.

**Approach:** Scaffold the three-ring skeleton (`core`/`ui`/`shared`/`bin`) on the Bun/TS/React stack; the Core boots on `127.0.0.1`, mints a per-boot session token handed to the UI, authenticates every RPC (token + Origin/Host), and answers with a typed result or a single error envelope; define the dependency-free typed RPC + versioned frozen-data contract in `src/shared`, unit-tested against fixtures.

## Boundaries & Constraints

**Always:**
- Core binds `127.0.0.1` only in this story; never `0.0.0.0` or a public interface.
- `src/shared/` is dependency-free — only types, the RPC + frozen-data contract, and pure encode/decode; imported by all rings. Data flows outward only.
- Every RPC reply is either a typed result or a single error envelope `{ code, message, detail }` — never a naked/untyped error.
- Core rejects (HTTP 403) any RPC lacking the current boot's token or carrying a foreign `Origin`/`Host`. Token is minted fresh each boot, held in Core memory only, never logged, never persisted.
- Dates on every wire boundary are ISO-8601 UTC strings; typed values only.
- Module files kebab-case; React components PascalCase.

**Block If:**
- Bun 1.2.x cannot be obtained or installed in this environment (the skeleton fundamentally targets the Bun runtime; node alone is insufficient).
- Planning artifacts are discovered to mandate a token/transport mechanism that contradicts the header-based handoff in Design Notes.

**Never:**
- No real DB drivers/connections (1.3), CLI mode parsing or browser-open (1.2), Tabs/Panels shell or shadcn/Tailwind theming (1.4), shutdown handling (1.5), port-exposure watcher (1.6), packaging/distribution (1.7), or sandbox-ring wiring (Epic 5).
- No persistence of any kind (no store, layout, token, or session written to disk).
- Do not treat loopback as the auth boundary — the token is the gate; Origin/Host is defense-in-depth.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Authenticated RPC | `POST /rpc` valid boot token + same-origin, `{"method":"health"}` | Typed result `{ status:"ok", schemaVersion }` | No error expected |
| Missing token | `POST /rpc` with no/blank `X-QS-Token` | HTTP 403, envelope `{ code:"unauthorized", ... }` | Reject before dispatch |
| Foreign Origin/Host | Valid token but `Origin`/`Host` not the bound `127.0.0.1:<port>` | HTTP 403, envelope `{ code:"forbidden_origin", ... }` | Reject (DNS-rebind defense) |
| Unknown method | Valid token, unrecognised method name | HTTP 400, envelope `{ code:"unknown_method", ... }` | Typed error envelope |
| Frozen-data round-trip | Fixture with dates + typed values | `decode(encode(x))` deep-equals `x`; dates ISO-8601 UTC | Throw on non-UTC/invalid date |

</intent-contract>

## Code Map

- `package.json` -- Bun/TS/React 19 deps + `dev`/`build`/`test` scripts
- `tsconfig.json` -- TS 5.x strict, Bun-compatible module resolution
- `bin/quick-studio.ts` -- CLI entry: boot the Core, log bound URL to stderr (mode parsing deferred to 1.2)
- `src/shared/contract.ts` -- RPC request/reply types, error envelope, versioned frozen-data schema, ISO-8601 UTC encode/decode; dependency-free
- `src/shared/contract.test.ts` -- fixture round-trip + envelope-shape unit tests
- `src/core/auth.ts` -- mint per-boot token; `validateToken()` / `validateOrigin()` pure predicates
- `src/core/auth.test.ts` -- accept/reject unit tests for token + origin
- `src/core/rpc.ts` -- dispatch table (`health`); wrap replies as typed result or error envelope
- `src/core/server.ts` -- `Bun.serve` on `127.0.0.1`; inject token into served HTML; `/rpc` gated by auth then dispatch
- `src/ui/index.html`, `src/ui/main.tsx`, `src/ui/App.tsx` -- React 19 app: read injected token, call `health`, render result
- `src/sandbox/.gitkeep` -- placeholder ring (wired in Epic 5)
- `.gitignore` -- ignore `node_modules`, build output

## Tasks & Acceptance

**Execution:**
- [x] `package.json` + `tsconfig.json` -- scaffold Bun/TS/React 19 project with `dev`/`build`/`test` scripts; install Bun 1.2.x if absent -- foundation for all rings
- [x] `src/shared/contract.ts` -- define typed RPC request/reply, error envelope `{code,message,detail}`, versioned frozen-data schema, pure ISO-8601 UTC encode/decode; no runtime deps -- canonical contract born here
- [x] `src/shared/contract.test.ts` -- unit-test frozen-data round-trip, ISO-8601 UTC enforcement, and error-envelope shape against fixtures (no browser/LLM) -- AC-1 testability
- [x] `src/core/auth.ts` -- mint per-boot crypto-random token (in-memory); `validateToken()` and `validateOrigin(host, port)` as pure predicates -- AC-2
- [x] `src/core/auth.test.ts` -- unit-test accept/reject for present/absent/foreign token and same/foreign origin -- AC-2
- [x] `src/core/rpc.ts` -- dispatch table with `health`; wrap every reply as typed result or error envelope; unknown method → typed error -- AC-3
- [x] `src/core/server.ts` -- `Bun.serve` bound to `127.0.0.1`; inject token into served HTML; `/rpc` POST gated by auth, then dispatched -- AC-1/AC-2
- [x] `bin/quick-studio.ts` -- entry that boots the Core and logs the bound URL to stderr -- boot path
- [x] `src/ui/{index.html,main.tsx,App.tsx}` -- React 19 app that reads the injected token, calls `health` over `/rpc` with the token header, renders status + schema version -- proves the channel end-to-end
- [x] `src/sandbox/.gitkeep` + `.gitignore` -- create placeholder ring dir and ignore `node_modules`/build output -- topology + hygiene

**Acceptance Criteria:**
- Given the skeleton exists, when I boot via `bin/quick-studio.ts`, then the Core binds `127.0.0.1`, serves the React UI, and the UI completes an authenticated `health` RPC showing status ok plus the frozen-data schema version.
- Given the Core is running, when an RPC arrives with no token or a foreign `Origin`/`Host`, then the Core responds HTTP 403 with an error envelope and does not process it.
- Given a valid authenticated RPC, when it reaches the Core, then the reply is a typed result or a single `{code,message,detail}` envelope — never an untyped error.
- Given the shared contract, when `bun test` runs, then frozen-data fixtures round-trip with ISO-8601 UTC dates and all error paths yield the envelope shape, with no browser or LLM in the loop.

## Spec Change Log

## Review Triage Log

### 2026-07-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 2, low 7)
- defer: 6
- reject: 6
- addressed_findings:
  - `[low]` `[patch]` Reordered `/rpc` gates so Origin/Host is validated BEFORE the token — a cross-origin/rebound caller is rejected on the cheap check and never learns whether a supplied token was valid (removed token-validity oracle).
  - `[low]` `[patch]` Token-bearing HTML now sent with `Cache-Control: no-store` (keeps the per-boot token out of the browser disk cache, honoring "never persisted") plus `X-Content-Type-Options: nosniff` on HTML/JS/JSON responses.
  - `[low]` `[patch]` UI bundle entry path resolved via `import.meta.dir` instead of `new URL(...).pathname` (the latter yields `/C:/...` on Windows, a target platform).
  - `[low]` `[patch]` Distinct wire error codes `not_found` (404) and `method_not_allowed` (405) instead of overloading `bad_request`, so clients can switch on `error.code`.
  - `[low]` `[patch]` Corrected `safeEqual` comment to stop overstating its timing guarantee (it does return early on length mismatch; safe here only because the token is fixed-length).
  - `[medium]` `[patch]` RPC dispatch no longer echoes the raw internal exception message into the client `error.detail`; it logs terse to stderr and returns a generic `internal_error` (prevents path/driver/query leakage in later stories).
  - `[low]` `[patch]` `toIsoUtc` guards an invalid `Date` and throws `TypeError` rather than surfacing a raw `RangeError`, restoring the module's totality claim.
  - `[medium]` `[patch]` `encode`/`decode` now assert the canonical rectangularity invariant (array-ness + one cell per column); ragged/malformed tables no longer round-trip clean. Added unit tests.
  - `[low]` `[patch]` `bin/quick-studio.ts` validates `QS_PORT` (0–65535) and wraps boot in try/catch → terse stderr + `exit(1)` on port-in-use/build failure instead of an unhandled rejection.

### 2026-07-06 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 2, low 2)
- defer: 1
- reject: 11
- addressed_findings:
  - `[medium]` `[patch]` RPC dispatch resolved `HANDLERS[method]` on a plain object literal, so `Object.prototype` keys (`toString`, `valueOf`, `constructor`, `hasOwnProperty`, `__proto__`) matched inherited members and were dispatched — yielding a bogus `ok` result or a 500 instead of `unknown_method`, violating the "unknown method → typed error" contract. Guarded the lookup with `Object.hasOwn`; added `src/core/rpc.test.ts` locking the prototype-key → `unknown_method` behavior. Verified e2e (`method:"toString"` → `unknown_method`).
  - `[medium]` `[patch]` Frozen-data `encode`/`decode` never checked a cell's `kind` against its column's declared `type`, so a type-inconsistent table round-tripped clean and `column.type` was decorative in the canonical schema module. Extended the well-formedness invariant (renamed `assertRectangular` → `assertWellFormed`) to reject any cell whose kind mismatches its column type, admitting `null` in any column. Added unit tests.
  - `[low]` `[patch]` `encode` now canonicalizes `-0` → `0` (since `JSON.stringify(-0)` is `"0"`) and a new JSON-boundary round-trip test exercises the real `JSON.stringify` wire hop the RPC path uses — the prior round-trip test only copied objects in memory, so the "canonical wire form" claim was unverified at the serialization boundary.
  - `[low]` `[patch]` `resolvePort` parsed `QS_PORT` via bare `Number()`, silently coercing whitespace (`"  "` → `0` → ephemeral), hex (`"0x1F"` → 31), and exponent (`"1e3"` → 1000) forms; now requires a plain decimal-digit string and rejects the rest with a clear error + `exit(1)`. Verified e2e.

## Design Notes

- **Token handoff:** the Core injects the per-boot token into the served HTML (e.g. `<script>window.__QS_TOKEN__="…"</script>`); the UI reads it and sends it on every `/rpc` call as an `X-QS-Token` header. Token = 256-bit crypto-random hex, Core-memory only, regenerated each boot, never logged or persisted.
- **Origin/Host gate (defense-in-depth, not the primary boundary):** accept only requests whose `Origin` is absent or exactly `http://127.0.0.1:<port>` and whose `Host` is `127.0.0.1:<port>`; reject `localhost` or foreign values (`localhost` and `127.0.0.1` are distinct origins). The token stays the real gate.
- **Frozen-data contract:** a small versioned schema (`FROZEN_SCHEMA_VERSION`) with typed cell values; dates serialize as a typed value carrying an ISO-8601 UTC string, never a native `Date` on the wire. `encode`/`decode` are pure and total.
- **UI stays minimal:** React 19 only, no Tailwind/shadcn theming yet (that lands with the Workspace shell in 1.4). The goal is a proven, authenticated channel — not a styled shell.

## Verification

**Commands:**
- `bun install` -- expected: dependencies resolve with no errors
- `bun test` -- expected: shared-contract and auth-predicate unit tests pass
- `bun run bin/quick-studio.ts` (then in another shell `curl -s -X POST http://127.0.0.1:<port>/rpc -H 'X-QS-Token: <token>' -d '{"method":"health"}'`) -- expected: typed health result; the same call without the header returns HTTP 403 with an error envelope

**Manual checks:**
- Open the served URL in a browser: the page loads and shows health status ok plus the schema version, confirming the UI completed an authenticated RPC over the channel.

## Auto Run Result

Status: done

### Summary
Scaffolded the greenfield three-ring skeleton (`src/core` / `src/ui` / `src/shared` / `bin`, plus a `src/sandbox` placeholder) on Bun + TypeScript 5 (strict) + React 19. The Core boots on `127.0.0.1`, mints a per-boot 256-bit session token, injects it into the served HTML, and gates `POST /rpc` behind an Origin/Host check and the token. Replies are always a typed result or the single `{ code, message, detail }` envelope. The dependency-free `src/shared` contract defines the versioned frozen-data schema and pure ISO-8601-UTC `encode`/`decode`, unit-tested against fixtures. A minimal React UI reads the token and completes a `health` RPC end-to-end.

### Files changed
- `package.json`, `tsconfig.json`, `bun.lock` — Bun/TS/React 19 project, strict, `dev`/`build`/`test` scripts.
- `.gitignore` — ignore `node_modules`, `dist`, tsbuildinfo, logs, OS/editor cruft.
- `bin/quick-studio.ts` — CLI entry; validates `QS_PORT`, boots the Core, logs the URL to stderr, exits cleanly on failure.
- `src/shared/contract.ts` — RPC types, error envelope, versioned frozen-data schema, rectangularity + ISO-UTC invariants, pure `encode`/`decode`.
- `src/shared/contract.test.ts` — 18 unit tests (round-trip, UTC enforcement, rectangularity, invalid-Date, envelope shape).
- `src/core/auth.ts` — token mint + `validateToken`/`validateOrigin` pure predicates.
- `src/core/auth.test.ts` — token + origin accept/reject unit tests.
- `src/core/rpc.ts` — dispatch table (`health`); typed result / envelope; internal errors logged, not leaked.
- `src/core/server.ts` — `Bun.serve` on `127.0.0.1`; token-injected HTML with `no-store`/`nosniff`; Origin-then-token gated `/rpc`; distinct 400/403/404/405 codes.
- `src/ui/{index.html,main.tsx,App.tsx}` — minimal React 19 app proving the authenticated channel.
- `src/sandbox/.gitkeep` — placeholder ring (Epic 5).

### Review findings breakdown
- Patches applied: 9 (2 medium, 7 low) — see Review Triage Log 2026-07-06.
- Deferred: 6 (recorded in `deferred-work.md`) — token/CSP hardening for data-rendering stories, untrusted-decode → `bad_request` mapping, `127.0.0.1` (not `localhost`) launch URL for 1.2, UI-build/Core decoupling + cold-start, frozen-date sub-ms precision policy, optional `/rpc` body cap.
- Rejected: 6 — by-design token exposure framing (captured as deferred hardening), benign `OPTIONS`→404, empty-method already handled, duplicate-header fail-closed, `server.port` set synchronously, UI reply-shape guarded by the controlled server contract.
- intent_gap: 0, bad_spec: 0 (no spec loopback; `review_loop_iteration` stayed 0).

### Verification performed
- `bun test` → 28 pass / 0 fail (51 expect calls), no browser/LLM.
- `bunx tsc --noEmit` → clean (strict).
- e2e (boot + curl): binds `127.0.0.1` only; authenticated `health` → 200 typed result; missing token → 403 `unauthorized`; foreign Origin (valid OR invalid token) → 403 `forbidden_origin` (no token oracle after gate reorder); unknown method → 400 `unknown_method`; `GET /rpc` → 405 `method_not_allowed`; unknown path → 404 `not_found`; `GET /` → `text/html` + `Cache-Control: no-store` + `nosniff`; `GET /app.js` → `nosniff`; invalid `QS_PORT` → clean error + exit 1. Server stopped cleanly, no orphaned process.

### Residual risks
- Deviation: Bun **1.3.14** installed (official installer ships latest) vs the `1.2.x` floor named in the stack seed — backward-compatible; all APIs used are stable across 1.2→1.3.
- The deferred items above are real and scoped to later stories; none block story 1.1's acceptance.

### Follow-up review (2026-07-06)
Independent adversarial + edge-case pass over the story-1.1 diff (baseline `0b69971`). Triage: 0 intent_gap, 0 bad_spec, 4 patches (2 medium, 2 low), 1 new deferred entry, 11 rejected.

- **Patches applied (2 medium, 2 low):**
  - `[medium]` RPC dispatch resolved `Object.prototype` keys (`toString`, `valueOf`, `constructor`, `__proto__`, …) to inherited members instead of returning `unknown_method` — guarded with `Object.hasOwn`; added `src/core/rpc.test.ts`.
  - `[medium]` Frozen-data `encode`/`decode` did not enforce cell `kind` against column `type` (schema was decorative) — extended the well-formedness invariant (`assertRectangular` → `assertWellFormed`), `null` admissible in any column; added tests.
  - `[low]` `encode` canonicalizes `-0` → `0`; added a real JSON-boundary round-trip test (prior test only copied objects in memory).
  - `[low]` `resolvePort` now rejects `Number()`-coercible garbage (`"  "`, `"0x1F"`, `"1e3"`) instead of silently binding an ephemeral/wrong port.
- **Deferred (1 new):** `validateOrigin` exact `host:port` match will reject every RPC on scheme-default ports (80/443) once 1.2 makes the port user-configurable (browsers omit the default port). Latent under 1.1's ephemeral-port default. Recorded in `deferred-work.md`.
- **Rejected (11):** ungated `GET /` token read, missing CSP/frame headers, `/rpc` body cap, untrusted-`decode` typing, multi-chunk UI bundle (all already captured as deferred-by-design in the ledger); plus UI `network_error` client code (by-design transport rep), `405` `Allow` header / `HEAD`→404 (single known client), `stop()` return type (1.5 owns shutdown), token→hex sanitize divergence (mint already emits hex; verified token is 64 hex chars), and speculative column name/dup validation (no consumer).
- **Verification:** `bun test` → 36 pass / 0 fail (73 expect calls); `bun x tsc --noEmit` → clean (strict). E2E: `QS_PORT="  "`/`"0x1F"` → clean error + exit 1; `method:"toString"` over the wire → `unknown_method` envelope; `health` control → typed ok.
- **Follow-up review not recommended** (`followup_review_recommended: false`): this pass converged — fixes are localized to small pure functions + one dispatch guard, all covered by new unit tests and e2e-verified; residual concerns are deferred-by-design.
