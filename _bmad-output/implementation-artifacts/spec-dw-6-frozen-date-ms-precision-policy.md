---
title: 'DW-6 — Frozen-date millisecond precision policy'
type: 'chore'
created: '2026-07-22'
status: 'done'
baseline_revision: '3bdfa55'
final_revision: '9ebe296'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** Millisecond precision is an accidental side effect of `ISO_UTC_RE` (`\.\d{1,3}`) plus a JS `Date` round-trip in `assertIsoUtc`, not a stated policy. A sub-second value with more than 3 fractional digits (a Postgres/MySQL microsecond timestamp reaching `decode` from a hand-edited Snapshot file or a Sandbox `postMessage` frame) makes the whole payload fail validation, and nothing documents that milliseconds are the intended limit.

**Approach:** Make milliseconds the explicit, documented canonical precision of the frozen-date model. Add a pure `normalizeIsoUtc` helper that **truncates** (never rounds) more-than-3 fractional digits down to 3, wire it into the contract's date-cell encode/decode path so an over-precise instant is canonicalized instead of rejected, and record the policy where the frozen-date model and the driver mapping boundary are defined.

## Boundaries & Constraints

**Always:**
- Truncate toward zero. `…:59.999999Z` becomes `…:59.999Z`; an instant must never move forward in time.
- Only the fractional-seconds field may change. Timezone (`Z`-only), calendar validity, and every non-date cell kind keep their current behavior — a non-UTC offset, an impossible calendar date, and garbage all still throw.
- Inputs already within policy (0, 1, 2, or 3 fractional digits) come back byte-identical, so `encode`/`decode` stay idempotent and existing round-trip equality holds.
- `contract.ts` stays dependency-free: pure, total, TypeScript-and-plain-data only.
- `assertIsoUtc` keeps rejecting 4+ fractional digits. It remains the strict wire invariant; normalization is a separate, explicit step.

**Block If:**
- Honoring the policy would require changing `FROZEN_SCHEMA_VERSION` or the on-the-wire shape of `FrozenCell`.
- Making `decode` accept over-precise input would require relaxing the `Z`-only rule or the calendar round-trip check.

**Never:**
- Do not widen `ISO_UTC_RE` to accept 4+ fractional digits as canonical.
- Do not round, and do not preserve sub-millisecond digits in any form (no extra field, no string suffix).
- Do not change driver configuration (`driver-postgres.ts`, `driver-mysql.ts`) to request string timestamps, and do not change `naturalKind`/`inferColumnKind` — a driver value that arrives as a string still becomes a `string` cell.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Microsecond truncation | `normalizeIsoUtc("2026-07-06T12:00:00.123456Z")` | `"2026-07-06T12:00:00.123Z"` | No error expected |
| Truncate, never round | `normalizeIsoUtc("2026-07-06T12:00:59.999999Z")` | `"2026-07-06T12:00:59.999Z"` (second unchanged) | No error expected |
| Sub-ms only | `normalizeIsoUtc("2026-07-06T12:00:00.000123Z")` | `"2026-07-06T12:00:00.000Z"` | No error expected |
| In-policy passthrough | `normalizeIsoUtc` of `…:00Z`, `…:00.5Z`, `…:00.50Z`, `…:00.123Z` | Returned byte-identical | No error expected |
| Over-precise date cell decodes | `decode` of a `FrozenData` whose date cell `iso` is `"2026-07-06T12:00:00.123456Z"` | Cell becomes `{ kind: "date", iso: "2026-07-06T12:00:00.123Z" }`; whole payload accepted | No error expected |
| Over-precise non-UTC | `normalizeIsoUtc("2026-07-06T12:00:00.123456+02:00")` | Throws | `TypeError` (offset rejected, as today) |
| Over-precise bad calendar | `normalizeIsoUtc("2026-13-40T12:00:00.123456Z")` | Throws | `TypeError` (calendar round-trip) |
| Empty fractional part | `normalizeIsoUtc("2026-07-06T12:00:00.Z")` | Throws | `TypeError` |
| Non-string input | `normalizeIsoUtc(null as unknown as string)` | Throws | `TypeError` |
| Strict assert unchanged | `assertIsoUtc("2026-07-06T12:00:00.123456Z")` | Throws | `TypeError` (4+ digits still non-canonical) |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- `ISO_UTC_RE` (67), `assertIsoUtc` (75), `toIsoUtc` (100), `encodeCell` date branch (196-198), `decodeCell = encodeCell` (207). The canonical frozen-date model; where `normalizeIsoUtc` lives and where the policy is enforced.
- `src/shared/contract.ts` -- `encode` docstring (~148-151) claims `decode(encode(x))` deep-equals `x`; `decode` docstring (~164-167) claims it "enforces" the ISO invariant. Both become inaccurate once the date branch rewrites `iso`.
- `src/shared/snapshot.ts` -- `isValidFrozen` (56-65) calls `decode(value)` **as a throw/no-throw oracle and discards the return value**; `isSnapshotBlock`/`isSnapshotDoc` are boolean type guards. `SnapshotBlock` (37-42) is a 4-arm union where only `table` and `chart` carry `data: FrozenData`.
- `src/snapshot/runtime.ts` -- `mountSnapshot` (122-136) renders `parsed.blocks` — the **original**, un-normalized object — after the guard passes. Untrusted ingest path #1; this is where the normalized value is currently dropped.
- `src/shared/contract.ts` -- `isSandboxInbound` (782+) decodes `frame.data` into a local `data` used only for the chart column check, then returns `true`; the decoded value never leaves the guard.
- `src/sandbox/guest.ts` -- `handleMessage` (86-105) passes `data: event.data.data` — the **original** object — to `deps.render`. Untrusted ingest path #2; the second place the normalized value is dropped.
- `src/shared/frozen-table.ts` -- `formatCell` (~45) prints `cell.iso` verbatim, so whatever survives the guard is exactly what the reader sees.
- `src/core/frozen-map.ts` -- `cellFor` date branch (73-82). The driver-rows mapping boundary; only ever produces `toIsoUtc(Date)`. Documentation target, no logic change.
- `src/core/driver-mysql.ts` -- `buildMysqlConfig` (151-155) forwards the user's connection URL as `uri` and overrides only `multipleStatements`, so mysql2 still honours URL query params such as `dateStrings=true`. Relevant only to how strongly the `frozen-map.ts` comment may be worded.
- `src/shared/contract.test.ts` -- `describe("ISO-8601 UTC enforcement")` (from 134). Home of the helper tests.
- `src/shared/snapshot.test.ts`, `src/sandbox/guest.test.ts` -- where the per-ingest-path tests belong.
- `_bmad-output/planning-artifacts/architecture/architecture-quick-studio-2026-07-06/ARCHITECTURE-SPINE.md` -- `### AD-13` (122-126). The canonical home of the wire-conventions rule.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- Add a module-private `describeIsoInput(value: unknown): string` used by both `assertIsoUtc` and `normalizeIsoUtc` to build their error messages: never call `JSON.stringify` on a value that may be a BigInt or a cyclic object (it throws, and this path is reachable from a `postMessage` frame), and cap the echoed text at ~80 chars so an unbounded untrusted string cannot be reflected whole. One message shape for the whole defect class.
- [x] `src/shared/contract.ts` -- Add exported `normalizeIsoUtc(iso: string): string`: reject non-strings via `describeIsoInput`; match a lenient `Z`-only `^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$`; when the fractional capture has more than 3 digits keep only the first 3; hand the result to `assertIsoUtc` for the verdict; return it. Truncation stays a `slice(0, 3)` on the digit string.
- [x] `src/shared/contract.ts` -- Use `normalizeIsoUtc(cell.iso)` in the `encodeCell` `"date"` branch and return the normalized string, so `encode` and its `decodeCell` alias canonicalize instead of rejecting.
- [x] `src/shared/contract.ts` -- Correct the now-inaccurate contract prose: `encode`'s round-trip law must be stated as holding for in-policy input (`decode(encode(x))` deep-equals `x` when every date cell is already ≤3 fractional digits; an over-precise cell is canonicalized, so the law holds from `encode(x)` onward), and `decode`'s docstring must say it canonicalizes precision rather than only enforcing.
- [x] `src/shared/snapshot.ts` -- Export `normalizeSnapshotDoc(doc: SnapshotDoc): SnapshotDoc` returning a copy whose every `table`/`chart` block carries `decode(block.data)`. `prose`/`empty` blocks pass through by reference. Pure; it may assume the doc already passed `isSnapshotDoc`.
- [x] `src/snapshot/runtime.ts` -- In `mountSnapshot`, render `normalizeSnapshotDoc(parsed).blocks` instead of `parsed.blocks`, so the offline runtime draws the canonicalized payload. This is the fix that makes AC1 true.
- [x] `src/sandbox/guest.ts` -- After `isSandboxInbound` passes, pass `decode(event.data.data)` to `deps.render` instead of `event.data.data`. The guard already proved the decode succeeds and the call is inside the existing try/catch, so this adds no new failure mode.
- [x] `src/core/frozen-map.ts` -- Comment the `cellFor` `"date"` branch: both drivers return JS `Date` under their **default** configuration, so a Postgres `timestamp(6)` is already truncated by the driver library before `toIsoUtc` runs. Do not claim "by construction" — a connection URL carrying `dateStrings=true` makes mysql2 yield strings, which `naturalKind` routes to a `string` column instead.
- [x] `src/shared/contract.test.ts` -- Cover every row of the I/O matrix, plus: `assertIsoUtc` accepts 1-, 2- and 3-digit fractions and rejects 4+; `.0000Z` (all-zero over-precision truncating to `.000Z`, which only passes via the trailing-zero comparison inside `assertIsoUtc`); a leap-second `…:59:60.999999Z` is rejected; a non-string that would break `JSON.stringify` (a BigInt and a cyclic object) still throws a `TypeError` with a readable message; and a property test asserting every string matching `ISO_UTC_RE` also matches the lenient pattern, so the two regexes cannot drift apart unnoticed.
- [x] `src/shared/snapshot.test.ts` -- Add a test: a `SnapshotDoc` whose `table` block carries `iso: "2026-07-06T12:00:00.123456Z"` passes `isSnapshotDoc`, and `normalizeSnapshotDoc` returns that cell as `.123Z`. Add a `runtime`-level test (in `src/snapshot/runtime.test.ts`) asserting the mounted output contains `.123Z` and not `.123456Z`.
- [x] `src/sandbox/guest.test.ts` -- Add a test: an inbound `render` frame carrying an over-precise date cell is accepted and the `data` handed to `deps.render` has the cell truncated to `.123Z`.
- [x] `_bmad-output/planning-artifacts/architecture/architecture-quick-studio-2026-07-06/ARCHITECTURE-SPINE.md` -- Append a precision-policy sentence to AD-13, additive only. It must scope itself to the frozen-data encode/decode boundary (`assertIsoUtc` stays exported and strict, so an unqualified "never rejected for precision" would be false), and must describe the operation as flooring / never moving the instant forward — **not** "toward zero", which is wrong for pre-epoch instants (`1969-12-31T23:59:59.999999Z` floors to `-1 ms`, away from zero).

**Acceptance Criteria:**
- Given a reopened Snapshot whose embedded `FrozenData` carries a microsecond date cell, when `mountSnapshot` renders it, then the drawn cell text is the millisecond form and the microsecond string appears nowhere in the output.
- Given a sandbox `render` frame carrying a microsecond date cell, when `guest.handleMessage` accepts it, then the `FrozenData` handed to `render` carries the millisecond form.
- Given any `FrozenData` produced by `rowsToFrozenData`, when it is passed through `encode` then `decode`, then the result deep-equals the input (no in-policy date cell is altered).
- Given the repository after this change, when a reader looks up the frozen-date model in `contract.ts` or AD-13, then every stated guarantee is one the code actually provides, at the scope it actually applies.

## Spec Change Log

### 2026-07-22 — Review pass 1 (bad_spec)

- **Triggering finding:** Both reviewers independently proved the feature was undelivered. `normalizeIsoUtc` was wired into `encodeCell`, but the two untrusted-ingest call sites use `decode` purely as a throw/no-throw oracle and discard its return value (`src/shared/snapshot.ts:60`, `src/shared/contract.ts:796`), while their consumers render the original object (`src/snapshot/runtime.ts:135`, `src/sandbox/guest.ts:101-105`). An over-precise cell therefore went from *rejected* to *accepted and rendered verbatim as `.123456Z`* — the change made the documented invariant weaker, not stronger, and the whole test suite stayed green because no test exercised either guard.
- **Amended:** Code Map now names the guards as value-discarding and adds `runtime.ts`, `guest.ts`, `frozen-table.ts` and `driver-mysql.ts`. Tasks now require a `normalizeSnapshotDoc` helper consumed by `mountSnapshot`, a `decode` at the `guest.ts` render call, per-ingest-path tests, corrected `encode`/`decode` docstrings, safe error-message construction, a regex-drift property test, and a scoped + factually correct AD-13 sentence. Acceptance Criteria now assert on what the consumer renders, not on what `decode` returns.
- **Known-bad state avoided:** shipping prose (contract docstrings and a normative AD-13 rule) that promises ingest-time canonicalization the code does not perform, with a green suite as false assurance.
- **KEEP (must survive re-derivation):**
  - The two-function split and its rationale: `assertIsoUtc` answers "is this already canonical?" and stays strict; `normalizeIsoUtc` is the only thing allowed to rewrite the string. Do not merge them.
  - Truncation as `slice(0, 3)` on the captured digit string — no arithmetic, no `Date`, so it cannot round and cannot carry into the seconds field.
  - `ISO_UTC_LENIENT_RE` as a `Z`-only, capture-grouped mirror of the strict pattern; normalization must not admit new timezone forms.
  - The ten `normalizeIsoUtc` unit tests from pass 1 (truncate, never-round at `:59.999999`, sub-ms-only → `.000`, byte-identical in-policy passthrough, idempotence, over-precise non-UTC, over-precise bad calendar, empty fractional part, non-string, in-policy round-trip). They were thorough and honest about the helper.
  - `encodeCell`'s date branch returning `normalizeIsoUtc(cell.iso)`, and the density/tone of the JSDoc written in pass 1 — it explains *why*, which matches the file.
  - Byte-identical passthrough for 0-3 fractional digits. Reviewers flagged that `.5Z`/`.50Z`/`.500Z` stay distinct; that is a locked intent-contract constraint, deliberately not "fixed".

## Review Triage Log

### 2026-07-22 — Review pass 1
- intent_gap: 0
- bad_spec: 5: (high 2, medium 3, low 0)
- patch: 0
- defer: 0
- reject: 8: (high 1, medium 4, low 3)
- addressed_findings:
  - `[high]` `[bad_spec]` Truncation never reaches either ingest path: `isValidFrozen` and `isSandboxInbound` discard `decode`'s return value and their consumers render the original object, so an over-precise cell is now accepted and rendered as `.123456Z`. AC1 unmet. Spec amended to require `normalizeSnapshotDoc` + a `decode` at the `guest.ts` render call; code reverted for re-derivation.
  - `[high]` `[bad_spec]` The `FrozenCell` JSDoc, the `normalizeIsoUtc` JSDoc and the new AD-13 spine sentence all assert ingest-time canonicalization the code did not perform. Spec amended to gate the documentation on the behaviour actually landing, and to scope the spine sentence to the encode/decode boundary since `assertIsoUtc` stays exported and strict.
  - `[medium]` `[bad_spec]` `encode`'s docstring still claimed `decode(encode(x))` deep-equals `x` unqualified, and `decode`'s still claimed it only "enforces" — both false once the date branch rewrites `iso`. Added an explicit task to restate both laws.
  - `[medium]` `[bad_spec]` "Truncated toward zero" is wrong for pre-epoch instants (`1969-12-31T23:59:59.999999Z` floors to `-1 ms`, away from zero) and had been written into the architecture spine. Added a task mandating flooring / never-moves-forward phrasing in the code comments and the spine.
  - `[medium]` `[bad_spec]` No test exercised `isSnapshotDoc` or `isSandboxInbound` with an over-precise cell — the two functions the Code Map itself named — which is why the suite was green while the feature was inert. Added per-ingest-path test tasks plus the missing `assertIsoUtc` boundary, `.0000Z`, leap-second, non-serializable-input and regex-drift cases.

### 2026-07-22 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 0
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[low]` `[patch]` Both reviewers converged on the same point: `mountSnapshot` called `normalizeSnapshotDoc(parsed)` (and its inner `decode`) OUTSIDE any try/catch, while the docstring promises "never a blank page" and the twin `guest.handleMessage` path guards its re-`decode`. Not triggerable on the real path — `mountSnapshot` only feeds inert `JSON.parse` output and the guard already decoded every block — but a genuine structural asymmetry caused by the new code. Wrapped the normalize call in the existing FALLBACK_HTML degrade (`src/snapshot/runtime.ts`), symmetric with `guest.ts`. Full suite stays green (1569 pass), `tsc --noEmit` clean.
  - Rejected as design-accepted by the frozen intent-contract or pre-existing/no-live-bug: `assertIsoUtc`'s strict 4+-digit branch being unreachable from the pipeline (KEEP'd two-function split — strict assert stays exported by design); double-`decode` per frame (Design Notes explicitly chose consumer-side copy over rewriting the boolean guards); unbounded `iso`/FrozenData size in `isSandboxInbound` (pre-existing exposure; lenient regex confirmed linear, no ReDoS); silent truncation without telemetry (the frozen decision is truncate-and-document, no signal required); rendered-vs-embedded-JSON divergence in the snapshot file (normalizing the rendered copy is the chosen non-file-rewriting design); `normalizeSnapshotDoc` public precondition (guarded at its only caller, now also defensively); property test covering only `ISO_UTC_RE ⊆ lenient` (exactly the test the spec mandated; runtime `assertIsoUtc` re-checks the reverse); flooring asymmetry across live/host paths (in-policy guaranteed by `frozen-map`/`toIsoUtc`, no live bug); `dateStrings=true` micro-string bypass (explicitly documented and out-of-scope per the `frozen-map.ts` comment task); surrogate-pair split in `describeIsoInput`'s 80-char cap (cosmetic, `JSON.stringify` tolerates lone surrogates); `-0`+date same-row idempotence test suggestion (scope creep).

## Design Notes

Two functions, two jobs. `assertIsoUtc` answers "is this already canonical?" and must stay strict — it is what makes the wire form unambiguous. `normalizeIsoUtc` answers "make this canonical or fail", and is the only thing allowed to rewrite a string. Putting truncation inside `assertIsoUtc` would have made an assertion silently mutate its argument's meaning.

```ts
const ISO_UTC_LENIENT_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

export function normalizeIsoUtc(iso: string): string {
  if (typeof iso !== "string") throw new TypeError(describeIsoInput(iso));
  const m = ISO_UTC_LENIENT_RE.exec(iso);
  const frac = m?.[2];
  // No match, or already in policy → pass through and let assertIsoUtc render the verdict.
  const out = m && frac !== undefined && frac.length > 3 ? `${m[1]}.${frac.slice(0, 3)}Z` : iso;
  assertIsoUtc(out);
  return out;
}
```

Truncation is `slice(0, 3)` on the digit string rather than arithmetic on a parsed number: it cannot round, cannot overflow into the seconds field, and needs no `Date` to do it.

**Where the normalization has to be consumed.** `decode` returning a canonicalized copy is necessary but not sufficient: both untrusted-ingest guards are boolean type guards that use `decode` only to decide accept/reject, and both consumers then read the *original* object. So the fix has to land at the consumer, not the guard — `mountSnapshot` renders `normalizeSnapshotDoc(parsed).blocks`, and `guest.handleMessage` hands `decode(event.data.data)` to `render`. Rewriting the guards to return a value instead of a boolean would ripple through their `value is T` typing and every other caller; copying at the two consumers is the smaller, reversible change and keeps the guards doing one job.

**What deliberately stays unfixed.** `.5Z`, `.50Z` and `.500Z` remain three distinct spellings of one instant, because the intent contract locks in byte-identical passthrough for anything already within policy. The name `normalizeIsoUtc` therefore means "canonicalize *precision*", not "canonicalize spelling" — say so in its JSDoc so the next caller is not trapped by the name.

## Verification

**Commands:**
- `bun test src/shared/contract.test.ts` -- expected: all tests pass, including the new precision, error-construction and regex-drift cases.
- `bun test src/shared/snapshot.test.ts src/snapshot/runtime.test.ts src/sandbox/guest.test.ts` -- expected: pass, including the new per-ingest-path assertions that the rendered cell is `.123Z`.
- `bun test src/core/frozen-map.test.ts` -- expected: pass; the mapping boundary is comment-only.
- `bun test` -- expected: full suite green, no newly failing test.
- `bunx tsc --noEmit` -- expected: no new type errors (no `typecheck` script exists in `package.json`).

**Manual checks (if no CLI):**
- Grep the diff for the phrase "toward zero" -- expected: zero hits; the flooring wording is used instead.

## Auto Run Result

Status: done

**Implemented change.** Milliseconds are now the explicit, documented canonical precision of the frozen-date model (DW-6). A pure `normalizeIsoUtc` **floors** (never rounds) an ISO-UTC instant's fractional-seconds field to 3 digits via `slice(0, 3)` on the captured digit string, then delegates the verdict to the still-strict `assertIsoUtc`. It is wired into `encodeCell`'s `"date"` branch (so `encode`/`decode` canonicalize instead of rejecting) and — critically, the fix pass 1 missed — landed at both untrusted-ingest **consumers**: `mountSnapshot` renders `normalizeSnapshotDoc(parsed).blocks`, and `guest.handleMessage` hands `decode(event.data.data)` to `render`. An over-precise Postgres/MySQL microsecond timestamp reaching either ingest path is now drawn as `.123Z`, never rejected and never shown verbatim as `.123456Z`.

**Files changed.**
- `src/shared/contract.ts` -- added `normalizeIsoUtc`, `ISO_UTC_LENIENT_RE`, and a shared `describeIsoInput` (safe error messages, no `JSON.stringify` on BigInt/cyclic, 80-char cap); `encodeCell` date branch now returns `normalizeIsoUtc(cell.iso)`; `ISO_UTC_RE`/`ISO_UTC_LENIENT_RE` exported for the drift property test; `encode`/`decode`/`assertIsoUtc` docstrings corrected.
- `src/shared/snapshot.ts` -- added `normalizeSnapshotDoc`, canonicalizing every `table`/`chart` block via `decode`.
- `src/snapshot/runtime.ts` -- `mountSnapshot` renders the canonicalized doc, guarded by the existing FALLBACK_HTML degrade (review pass 2 patch).
- `src/sandbox/guest.ts` -- `handleMessage` hands the decoded (floored) data to `render`.
- `src/core/frozen-map.ts` -- comment documenting the driver default-config flooring and the honest `dateStrings=true` caveat (no logic change).
- `_bmad-output/planning-artifacts/.../ARCHITECTURE-SPINE.md` -- additive AD-13 precision-policy sentence, scoped to the encode/decode boundary and phrased as flooring / never-moves-forward.
- Tests: `contract.test.ts`, `snapshot.test.ts`, `runtime.test.ts`, `guest.test.ts` -- full I/O matrix, per-ingest-path assertions, boundary/error/regex-drift cases.

**Review findings breakdown (pass 2).** 1 patch applied (low: defensive try/catch around `mountSnapshot`'s normalize call, symmetric with `guest.ts`, honoring its "never a blank page" docstring). 0 deferred. 10 rejected as design-accepted by the frozen intent-contract or pre-existing with no live bug (details in the Review Triage Log). 0 intent_gap, 0 bad_spec.

**Verification performed.**
- `bun test` -- 1569 pass / 0 fail (77 files) after the patch.
- `bunx tsc --noEmit` -- exit 0, no type errors.
- `git diff | grep -i "toward zero"` -- 0 hits (flooring / never-moves-forward wording used).

**Residual risks.** All low and design-accepted: the `dateStrings=true` connection-URL path routes timestamps to `string` cells that bypass the ms policy (documented, out of scope); the live-report/host path is not re-`decode`d (in-policy guaranteed by `frozen-map`/`toIsoUtc`); the embedded snapshot JSON keeps original precision while the rendered cell is floored. None affect the frozen acceptance criteria.
