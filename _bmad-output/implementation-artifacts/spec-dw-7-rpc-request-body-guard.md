---
title: 'DW-7: Max request-body guard on POST /rpc and /chat/stream'
type: 'chore'
created: '2026-07-15'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '3397c314ead86404850fa4f139b7242f15b19736'
final_revision: '057541bc4d55084087415f528947921af1534c43'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** `POST /rpc` (`src/core/server.ts:541`) and `POST /chat/stream` (`src/core/server.ts:498`) both `await req.json()` on an unbounded body — a large POST is buffered fully into memory before any size check. Low risk for a single-user localhost tool, but cheap hardening now that multi-caller scenarios (Live Reports, Epic 6) exist.

**Approach:** Add a shared Content-Length guard that rejects an over-limit body as a typed `bad_request` error envelope (HTTP 413) **before** `await req.json()` buffers it. Applied identically at both endpoints, after the existing Origin and token gates.

## Boundaries & Constraints

**Always:**
- The guard runs AFTER the Origin gate and token gate at each endpoint, and BEFORE `await req.json()` — an unauthenticated/foreign caller is still rejected on the cheaper checks first, and an over-limit body is never buffered.
- Over-limit rejection uses the existing `errorReply("bad_request", …)` envelope (no new `RpcErrorCode`) with HTTP status `413`.
- Both endpoints share ONE limit constant and ONE guard helper — no divergence between `/rpc` and `/chat/stream`.
- Existing behavior is unchanged for within-limit and Content-Length-absent requests (they proceed to `await req.json()` exactly as today).

**Block If:**
- (none — intent is fully specified; the limit value is chosen below, not a human decision.)

**Never:**
- Do not add a new `RpcErrorCode` value or change the error-envelope shape.
- Do not stream-count body bytes or otherwise re-architect body reading — a Content-Length header check is the agreed scope (a caller that omits/undercounts Content-Length is out of scope for this hardening; documented, not solved).
- Do not change the Origin/token gate logic or their ordering.
- Do not apply the guard to GET routes or the served-HTML/asset routes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Within limit | Valid token, `Content-Length` ≤ limit | Proceeds to `req.json()` and normal dispatch/stream | No error expected |
| Over limit | Valid token, `Content-Length` > limit | `413` + `{ok:false,error:{code:"bad_request",…}}`; body never buffered | Rejected before `req.json()` |
| No Content-Length | Valid token, header absent/non-numeric | Proceeds to `req.json()` (guard cannot size it; unchanged behavior) | No error at guard |
| Over limit, bad token | Wrong/absent token, `Content-Length` > limit | `403` at token gate (guard never reached) | Rejected at token gate |

</intent-contract>

## Code Map

- `src/core/server.ts` — the two POST endpoints (`/chat/stream` ~L480–506, `/rpc` ~L509–566); each has `await req.json()` in a try/catch. Add the shared guard + constant here. `jsonResponse(body, status)` (L149) and `errorReply` (imported from `../shared/contract.ts`) are the existing helpers to reuse.
- `src/shared/contract.ts` — `RpcErrorCode` (L846) and `errorReply` (L919); read-only reference, NOT modified (`bad_request` already exists).
- `src/core/server.test.ts` — server-level endpoint tests booting a real `Core` and `fetch`-ing `/rpc`; add the guard's tests here (mirror `callRpc` helper, L45).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/server.ts` -- Add a module-level `MAX_REQUEST_BODY_BYTES` constant (8 MiB = `8 * 1024 * 1024`) and a pure helper `overBodyLimit(req: Request): boolean` that reads the `content-length` header, parses it with `Number(...)`, and returns `true` only when the parsed value is a finite number strictly greater than the limit (absent/`NaN`/≤limit → `false`). -- single source of truth for the limit.
- [x] `src/core/server.ts` -- In BOTH the `/chat/stream` and `/rpc` branches, immediately before `await req.json()` (i.e. after the token gate), add: `if (overBodyLimit(req)) return jsonResponse(errorReply("bad_request", "Request body exceeds the <N>-byte limit"), 413);`. -- reject before buffering, identically at both endpoints.
- [x] `src/core/server.test.ts` -- Add tests covering the I/O matrix rows: over-limit `/rpc` and over-limit `/chat/stream` (both with a valid token) return `413` with `error.code === "bad_request"`; a within-limit request still succeeds; an over-limit request with a bad token still returns `403` (guard not reached). Use a `content-length` header set above the limit with a small actual body so the assertion does not depend on sending 8 MiB. -- lock the guard and its ordering.

<!-- Impl note: Bun's `fetch` recomputes `content-length` from the actual body (a manually
     set header is ignored), so the over-limit tests send a genuinely >8 MiB body (cheap over
     loopback) plus `connection: close` so the unconsumed body doesn't pollute a reused keep-alive
     connection. Test-only artifact; production behavior (413 + connection close) is unchanged. -->

**Design decision (status codes):** The intent's "typed `bad_request`" refers to the error-envelope CODE (reusing the existing `RpcErrorCode`, no new value). The HTTP status is `413 Payload Too Large` — the semantically correct code for this HTTP-layer resource guard, matching how the other pre-dispatch guards pick their own status (`method_not_allowed`→405, `forbidden_origin`→403). Clients read `reply.error.code`, which is unaffected by the status.

**Acceptance Criteria:**
- Given a valid token and a `Content-Length` above the limit, when POSTing to `/rpc` or `/chat/stream`, then the response is `413`, the JSON body is `{ok:false,error:{code:"bad_request",…}}`, and `req.json()` is never reached.
- Given a valid token and a within-limit (or absent) `Content-Length`, when POSTing to either endpoint, then behavior is byte-for-byte identical to before this change.
- Given a wrong/absent token and an over-limit `Content-Length`, when POSTing to `/rpc`, then the response is `403` (the token gate still fires first and the body guard is never consulted).

## Spec Change Log

<!-- No bad_spec loopback occurred; the review-pass correctness fix was handled as a patch (see Review Triage Log). -->

## Review Triage Log

### 2026-07-15 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 1, low 6)
- defer: 0
- reject: 3: (high 0, medium 0, low 3)
- addressed_findings:
  - `[medium]` `[patch]` `content-length` overflow bypass — a huge all-digit value coerced to `Infinity` and `Number.isFinite` let it slip past the guard's own upper bound. Hardened `overBodyLimit` to `!Number.isNaN(len) && len > MAX` (only NaN excused); added predicate unit tests covering Infinity, exact-limit, over-limit, absent/empty/zero/non-numeric/negative.
  - `[low]` `[patch]` Doc comment misstated the absent-header path as `NaN` — `Number(null)` is `0`, not `NaN`. Rewrote the comment to describe the real coercion corners.
  - `[low]` `[patch]` The "8 MiB" string was a hardcoded literal decoupled from `MAX_REQUEST_BODY_BYTES`, and the 3-line reject was copy-pasted at both call sites. Extracted `bodyLimitResponse(req)` that derives the MiB figure from the constant, so limit + message live once; both endpoints now call it.
  - `[low]` `[patch]` Missing coverage for the "must-not-false-reject" and exact-boundary branches. Covered by the new predicate unit tests (exact-limit passes; NaN/absent/zero proceed).
  - `[low]` `[patch]` Bad-token ordering test under-asserted (only `status === 403`). Tightened to assert `error.code === "unauthorized"`, proving the TOKEN gate fires before the guard.
  - Rejected (dropped): 413 reusing the `bad_request` code is an explicit intent decision (no new `RpcErrorCode`); duplicate `Content-Length` → `NaN` bypass is the accepted undercount class, mitigated by Bun/RFC upstream rejection; test `connection: close` reliance is a documented, harmless test artifact.

### 2026-07-15 — Follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 1
- reject: 12
- addressed_findings:
  - none
- notes: Independent follow-up review (Blind Hunter + Edge Case Hunter) on the frozen diff. Edge Case Hunter found 0 unhandled branches (every boundary is guarded or explicitly out-of-scope). Blind Hunter raised 12 items, all routed to reject except one defer: (a) explicit, already-adjudicated intent decisions — `413`+`bad_request` code reuse, guard placement after the token gate, the chosen `8 MiB` value; (b) verified false positives — the real `server.test.ts` DOES cast the header stub `as unknown as Request` (typechecks), the `/chat/stream` over-limit test DOES assert `error.code === "bad_request"`, and the predicate test DOES cover `""`/`"0"`; (c) cosmetic/speculative noise — comment DRY, `Math.floor` message drift (constant is an exact MiB), hex/negative coercion (all err toward rejection), export-for-test surface (justified: it enables the Infinity-overflow predicate test integration can't reach). The single defer (unset `Bun.serve` `maxRequestBodySize`) is pre-existing and out of DW-7's Content-Length-only scope — recorded to the ledger as a NEW entry. No code changed this pass.

## Design Notes

Guard placement is deliberately AFTER the token gate: it is a resource-exhaustion guard, not an auth boundary, so it must not let an unauthenticated caller probe the limit or short-circuit the 403. `req.json()` in Bun buffers the whole body, so the check must precede it to have any value.

The `content-length` header is trusted only as a cheap self-declared size. A client that omits it or lies low still reaches `req.json()` — acceptable and in-scope-limited by design for a localhost single-user tool (a true streaming byte-cap is explicitly out of scope per the ledger entry). The header key is lowercase (`content-length`) to match Fetch's normalized header casing.

Example helper (predicate hardened during review — see Review Triage Log): only a
`NaN` coercion (absent/non-numeric header) is excused; a huge all-digit value that
overflows `Number()` to `Infinity` is `> MAX` and IS rejected, so the guard has no
hole at the very top of its range.
```ts
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB
export function overBodyLimit(req: Request): boolean {
  const len = Number(req.headers.get("content-length"));
  return !Number.isNaN(len) && len > MAX_REQUEST_BODY_BYTES;
}
```

## Verification

**Commands:**
- `bun run build` -- expected: succeeds (generated bundles exist so `server.test.ts` can import them).
- `bun test src/core/server.test.ts` -- expected: all tests pass, including the new over-limit/within-limit/bad-token cases.
- `bunx tsc --noEmit` -- expected: no new type errors from the edited files.

## Auto Run Result

Status: done

**Change:** Added a shared max-request-body guard to the two POST endpoints in `src/core/server.ts` (`/rpc` and `/chat/stream`). A `content-length` over `MAX_REQUEST_BODY_BYTES` (8 MiB) is rejected as a typed `bad_request` envelope with HTTP `413`, evaluated after the Origin+token gates and before `await req.json()` buffers the body. The limit + message live in one place via `bodyLimitResponse(req)`; the predicate `overBodyLimit(req)` rejects over-limit and `Infinity`-overflow sizes while excusing only `NaN` (absent/non-numeric/undercount — the accepted, out-of-scope class).

**Files changed:**
- `src/core/server.ts` — new `MAX_REQUEST_BODY_BYTES` constant, exported `overBodyLimit` predicate, `bodyLimitResponse` helper, and one guard call at each POST endpoint.
- `src/core/server.test.ts` — integration tests (over-limit → 413 at both endpoints, within-limit success, bad-token → 403 asserting `unauthorized`) plus a predicate unit-test suite covering exact-limit, over-limit, Infinity-overflow, and absent/empty/zero/non-numeric/negative.

**Review findings:** 7 patches applied (1 medium: `Infinity`-overflow bypass hardened; 6 low: wrong doc comment, hardcoded "8 MiB" literal + duplicated reject block folded into `bodyLimitResponse`, false-reject/exact-boundary coverage, bad-token assertion tightened). 0 deferred. 3 rejected (413-reuses-`bad_request` is an explicit intent decision; duplicate-`Content-Length`→`NaN` is the accepted undercount class mitigated upstream by Bun/RFC; test `connection: close` is a harmless documented artifact). No intent_gap, no bad_spec loopback.

**Follow-up review recommended:** true — the medium fix changed security-relevant guard behavior and, because Bun's `fetch` recomputes `content-length`, the `Infinity`-overflow case is only exercised by a stubbed unit test (not end-to-end), which is worth an independent second look.

**Verification:** `bun test` → 1073 pass / 0 fail; `bun test src/core/server.test.ts` → 31 pass / 0 fail; `bunx tsc --noEmit` → clean.

**Residual risks:** The guard trusts a self-declared `content-length`; a caller that omits or undercounts it still reaches `req.json()` (explicit ledger scope — Bun's own `maxRequestBodySize` ~128 MB is the real backstop). Duplicate `Content-Length` headers, if Bun ever stopped rejecting them upstream, would coerce to `NaN` and bypass — theoretical for a localhost single-user tool.

### Follow-up review — 2026-07-15

An independent follow-up review pass (Blind Hunter + Edge Case Hunter, no prior context) ran on the frozen diff. **No code changed.** Edge Case Hunter found 0 unhandled branches. Blind Hunter's 12 items triaged to 12 reject + 1 defer:
- **Reject (12):** explicit/already-adjudicated intent decisions (`413`+`bad_request` reuse, placement after the token gate, the chosen `8 MiB`); verified false positives (the real test stub IS cast `as unknown as Request`, the `/chat/stream` over-limit test DOES assert `error.code`, the predicate test DOES cover `""`/`"0"`); and cosmetic/speculative noise (comment DRY, `Math.floor` message drift on an exact-MiB constant, hex/negative coercion that all err toward rejection, the test-only export that justifiably enables the Infinity-overflow predicate test).
- **Defer (1):** `Bun.serve` does not set `maxRequestBodySize`, so the ~128 MB backstop this spec leans on is Bun's default, not an explicit value — pre-existing and out of DW-7's Content-Length-only scope. Recorded as a NEW ledger entry.

**Verification (follow-up):** `bunx tsc --noEmit` → clean (exit 0); `bun test src/core/server.test.ts` → 31 pass / 0 fail. `followup_review_recommended` set to `false` — this pass made no review-driven code changes.
