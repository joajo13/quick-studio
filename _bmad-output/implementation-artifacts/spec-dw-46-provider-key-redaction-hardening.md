---
title: 'DW-46: Harden provider-key redaction in the chat error path'
type: 'bugfix'
created: '2026-07-20'
status: 'done'
baseline_revision: '9622473a74161d5d8f2e8f8c1111e75bf1af10e5'
final_revision: '8488eb8d7b945b3f60bd53b1e1d7cb27ab14ec9b'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** The chat provider-key redaction in the streaming error path (`src/core/chat.ts` `answerStream` catch block) is exact-substring only — `rawCause.split(apiKey).join("***")` on `err.message`. A provider auth error that echoes the key in any non-literal form (URL-encoded, base64, truncated/partial, or nested in a structured error object / `.cause`) would slip past the scrub and reach stderr, violating the "key NEVER in any log" invariant.

**Approach:** Stop interpolating the raw provider error into the log at all. Emit a fixed generic cause that is structurally incapable of carrying the key, optionally augmented only by a numeric HTTP status code extracted from the error (a number cannot encode the key). This closes every encoding variant by construction rather than by an inherently incomplete blocklist, and covers both convergent failure paths (mid-stream throw and the SDK-surfaced `error` part) since both land in the same catch.

## Boundaries & Constraints

**Always:** The stderr log line for a failed provider stream must never include any provider-derived string; the only dynamic value permitted is a finite numeric status code. The client-facing error chunk stays generic (`{ type: "error", code: "internal_error", message: "provider call failed" }`) with no cause echoed. The `apiKey` value must not be referenced anywhere in the error/catch path after this change.

**Block If:** The catch block turns out to already forward the error to a channel other than stderr and the client chunk (e.g. a structured logger or telemetry sink) that this spec did not account for — HALT with the discovered sink as blocking condition.

**Never:** Do not add or retain any redaction/blocklist that interpolates the raw error message, `String(err)`, `JSON.stringify(err)`, `err.cause`, or provider error properties into a log. Do not change the client-facing chunk shape or the abort/`signal?.aborted` teardown behavior. Do not touch the keychain redaction (`src/core/keychain.ts`), provider wiring, or any path outside chat error handling. Do not remove diagnostic value beyond what is required to uphold the invariant (keep the numeric status when safely available).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Verbatim key echoed | mid-stream `throw new Error(\`auth failed for ${KEY}\`)` | stderr = `[chat] provider stream failed\n`; chunk = generic error | Key absent from stderr and chunk |
| URL-encoded key echoed | thrown message contains `encodeURIComponent(KEY)` | stderr generic; neither raw nor URL-encoded key present | Key (any form) absent |
| Base64 key echoed | thrown message contains `Buffer.from(KEY).toString("base64")` | stderr generic; base64 form absent | Key (any form) absent |
| Truncated/partial key | thrown message contains a prefix substring of KEY | stderr generic; the partial substring absent | Key (any form) absent |
| Key nested in structure | error object with KEY in `.cause` / custom prop and in `.message` | stderr generic; KEY absent | Key (any form) absent |
| SDK `error`-part path | stream yields `{ type: "error", error: new Error(\`boom ${KEY}\`) }` | re-thrown into catch; stderr generic; chunk generic | Key absent from stderr and chunk |
| Error carries HTTP status | thrown error has `statusCode: 401` (and echoes KEY) | stderr = `[chat] provider stream failed (http 401)\n` | KEY absent; only numeric status shown |
| Client disconnect | `signal.aborted === true` at catch | silent return, no chunk, no log | No error surfaced (deliberate teardown) |

</intent-contract>

## Code Map

- `src/core/chat.ts` -- `createChatResponder(deps).answerStream` (~line 315). Catch block (~360–373) holds the `split(apiKey).join("***")` redaction and the stderr write; the SDK `error`-part branch (~353–357) re-throws into it. This is the single edit site.
- `src/core/chat.test.ts` -- existing redaction tests: `SECRET` fixture (~line 27), mid-stream-throw test (~345, asserts stderr scrubbed), SDK-`error`-part test (~420, asserts chunks only). Extend with encoded/partial/nested/status scenarios.
- `src/core/keychain.ts` -- `formatErrorDetail` (~line 89): reference-only precedent for redaction; NOT modified by this spec.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/chat.ts` -- Replace the substring redaction in the `answerStream` catch block: remove `rawCause`/`cause` and the `apiKey` reference from the error path; emit a fixed log line `[chat] provider stream failed` optionally suffixed with ` (http <status>)`. Add a small local helper `errorStatusCode(err: unknown): number | undefined` that returns a `statusCode`/`status` own-property only when it is a finite number (else `undefined`). Keep the `signal?.aborted` early return and the generic client chunk unchanged.
- [x] `src/core/chat.test.ts` -- Extend redaction coverage with tests asserting the key never reaches stderr for: verbatim, URL-encoded, base64, and truncated/partial echoes, and a key nested in a structured error. Add stderr capture to the SDK `error`-part path. Add a test that a numeric `statusCode` is surfaced as `(http 401)` while the key stays absent. Reuse the existing `process.stderr.write` capture approach.

**Acceptance Criteria:**
- Given a provider stream failure whose message or structure echoes the key in ANY form (verbatim, URL-encoded, base64, truncated, or nested), when the catch block logs, then the stderr output contains neither the raw key nor any of those encodings, and equals `[chat] provider stream failed` (plus an optional ` (http <n>)` numeric suffix) followed by a newline.
- Given the same failure surfaced via the SDK `error` part rather than a throw, when handled, then the same generic stderr line and generic client chunk are produced.
- Given a failure error exposing a finite numeric `statusCode`/`status`, when logged, then the line includes ` (http <status>)` and still contains no key material.
- Given `signal.aborted` is true at the catch, when handled, then nothing is logged and no chunk is yielded.

## Spec Change Log

## Review Triage Log

### 2026-07-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 3, low 1)
- defer: 1: (high 0, medium 1, low 0)
- reject: 7
- addressed_findings:
  - `[medium]` `[patch]` A throwing `statusCode`/`status` getter could escape `errorStatusCode` and break `answerStream`'s never-throws contract — wrapped the property read in try/catch (`continue` on throw).
  - `[medium]` `[patch]` `PreparedRequest.apiKey` was left as a dead, unread plaintext copy of the credential in the responder frame after the destructure change — removed the field and its population (defense-in-depth, reduces key surface).
  - `[medium]` `[patch]` The load-bearing numeric guard had no adversarial test coverage — added tests proving a secret-bearing STRING status, an object with a numeric `valueOf`/secret `toString`, and a throwing getter are all rejected without the key reaching stderr.
  - `[low]` `[patch]` The guard admitted non-HTTP numbers (`0`, `-1`, `401.5`, `1e21`) as `(http N)` — tightened to integer in the 100–599 range; added a coverage test. (Security invariant unaffected either way; keeps the diagnostic honest.)

## Design Notes

The invariant is absolute ("key NEVER in any log"), and substring redaction is a blocklist: it can only cover the exact literal, never every encoding an error body might use. The airtight guarantee is to never place a provider-derived string in the log. So the fix inverts the model — instead of scrubbing the raw cause, we drop it entirely and log a constant, allowing at most a numeric status (which cannot encode a key). This makes the guarantee verifiable by inspection: the `apiKey` variable is no longer touched in the catch, so no leak is possible by construction.

Golden shape:

```ts
} catch (err) {
  if (signal?.aborted) return;
  // Security invariant: the provider key must NEVER reach any log. An auth error
  // can echo the credential in forms substring-redaction can't cover, so we never
  // interpolate the raw provider error — only a numeric status, which cannot carry it.
  const status = errorStatusCode(err);
  process.stderr.write(
    `[chat] provider stream failed${status === undefined ? "" : ` (http ${status})`}\n`,
  );
  yield { type: "error", code: "internal_error", message: "provider call failed" };
  return;
}
```

`errorStatusCode` reads own `statusCode` then `status` (each read guarded against a throwing getter so the catch stays Total), returning the value only when it is a real integer HTTP status (`typeof === "number" && Number.isInteger(v) && 100 <= v <= 599`). The `typeof === "number"` check is the load-bearing security guard — a string/object status (which could carry the key) is rejected; the range check merely keeps the diagnostic honest.

## Verification

**Commands:**
- `bunx tsc --noEmit` -- expected: no type errors.
- `bun test src/core/chat.test.ts` -- expected: all chat tests pass, including the new redaction-hardening cases; no assertion finds the key in stderr or any chunk.

## Auto Run Result

Status: done

**Summary:** Hardened the chat provider-key redaction in the streaming error path. The `answerStream` catch block no longer substring-scrubs and interpolates the raw provider error (`rawCause.split(apiKey).join("***")`) — which only caught the literal key and would have leaked URL-encoded/base64/truncated/nested forms. It now never interpolates any provider-derived string: it logs a fixed generic line plus, at most, a numeric HTTP status extracted by a new `errorStatusCode` helper. A `number` cannot encode the key, so the "key NEVER in any log" invariant now holds by construction (verifiable: `apiKey` is no longer referenced anywhere in the error path). Both convergent failure paths — mid-stream throw and the SDK-surfaced `error` part — go through the same hardened catch.

**Files changed:**
- `src/core/chat.ts` -- Replaced substring redaction with a fixed generic stderr line + optional numeric `(http N)` suffix; added the `errorStatusCode` helper (throwing-getter-safe, integer HTTP-range guarded); dropped the now-unused `apiKey` from the `answerStream` destructure and removed the orphaned `PreparedRequest.apiKey` field (dead plaintext credential copy).
- `src/core/chat.test.ts` -- Added `captureStderr`/`throwingStream` helpers and redaction-hardening tests: verbatim/URL-encoded/base64/truncated/nested key echoes, SDK `error`-part path (now stderr-checked), numeric-status surfacing, and adversarial guard tests (secret-bearing string status, numeric-`valueOf` object, throwing getter, out-of-range/non-integer status).

**Review findings breakdown:** 2 adversarial reviewers (Blind Hunter + Edge Case Hunter), no key-leak regression found (both confirmed the invariant holds). Patches applied: 4 (3 medium, 1 low) — throwing-getter guard, dead-credential-field removal, adversarial guard tests, HTTP-range validation. Deferred: 1 (see below). Rejected: 7 (by-design safety tradeoffs and pre-existing/observability-only nits).

**Deferred (surfaced to orchestrator — NOT written to the ledger per run instruction):**
- summary: Restore safe production diagnosability lost by emitting a fixed generic cause — add an allowlist of non-secret error signals (e.g. Node `err.code` like `ECONNRESET`/`ENOTFOUND`, or `err.name`) to the error-path log so transport/timeout/TLS failures are distinguishable, without ever interpolating the raw message.
  evidence: The hardening (correctly) drops all free-form cause text; failures without a numeric HTTP status now log an information-free line, which the Blind Hunter flagged as an operability regression. A curated allowlist of short, structurally non-secret tokens would recover triage signal while preserving the invariant; it needs its own safety analysis, so it is out of this story's scope.

**Verification performed:**
- `bunx tsc --noEmit` -- exit 0, no type errors.
- `bun test src/core/chat.test.ts` -- 37 pass, 0 fail (was 33; +4 adversarial guard tests).
- `bun test` (full suite) -- 1338 pass, 0 fail across 73 files.

**Residual risks:** Low. The numeric escape hatch is proven closed against string/object/throwing-getter status by adversarial tests. The only accepted cost is reduced free-form diagnostics on the error path (deliberate, per intent; recovery deferred above). String-form HTTP statuses from some clients are intentionally not surfaced (conservative-by-design; accepting them would reopen the leak vector).
