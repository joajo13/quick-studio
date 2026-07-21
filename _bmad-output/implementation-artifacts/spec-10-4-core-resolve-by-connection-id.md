---
title: 'Core resolves every read path (connect, table.rows, chat) by connectionId via connectionTargets'
type: 'feature'
created: '2026-07-21'
status: 'draft'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 10 / Story 10.4
  - '{project-root}/_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html'
---

<intent-contract>

## Intent

**Problem:** quick-studio is clamped to ONE live connection per session. `startCore` builds a single boot `connectionManager` (`src/core/connection.ts`) over a closure-captured URL, and three read paths reach into it DIRECTLY: `tableRows` (`src/core/server.ts`), the `connect`/`connection.active`-adjacent schema path, and the chat responder's `getSchema` seam (`src/core/chat.ts` via `createChatResponder({ getSchema: () => connectionManager.getSchema() })`). Meanwhile a per-target resolver already exists (`src/core/connection-targets.ts`, Story 6.2) — a lazy, cached, registry-self-invalidating manager keyed by an opaque saved-connection `id` — but today ONLY the Reports executor (`src/core/executor.ts`) consumes it. Everything else cannot browse a saved connection other than the boot one, which blocks the multi-root tree (10.5) and connection-aware tabs (10.6).

**Approach:** Propagate the SAME `connectionTargets.resolve(connectionId)` seam the executor already uses to the three remaining read paths, changing NOTHING about the pool itself:
1. **`connection-targets.ts`** — widen `ConnectionSeams` with one more 1:1 delegation, `connect: () => manager.connect()` (mirrors the existing `runQuery`/`runReadOnly`/`getEngine`/`getSchema`/`quoteIdent` pattern in `seamsFor`), so a resolved target exposes the SAME neutral `ConnectResult` (`status: "connected" | "failed"`) the boot manager already returns — no new failure-shape logic.
2. **`server.ts`** — `tableRows(params)` extracts an optional `connectionId` from `params` (mirroring the executor's shape-validate-then-`resolveConnection` block at `executor.ts:680-693`), calls `connectionTargets.resolve(connectionId)` instead of touching `connectionManager` directly, and runs `planTableRows`/`query`/`quoteIdent` against the resolved `ConnectionSeams`. The `connect` RPC context capability becomes `connect(connectionId)`, resolving the target and delegating to `seams.connect()`. The chat responder's `getSchema` dependency becomes `getSchema: (connectionId) => resolve-then-seams.getSchema()`.
3. **`chat.ts`** — `ChatResponderDeps.getSchema` widens to accept the optional `connectionId` already threaded from `answerStream`'s `params`; the existing "no active connection" `bad_request` catch (`prepareRequest`, `chat.ts:276-281`) is reused verbatim for a resolve failure — no new chat-side error code.
4. **`rpc.ts`/`contract.ts`** — `connect` becomes a `preformed` handler (like `connections.*`/`execute`) so it can shape-check `connectionId` (string-or-null) BEFORE any round-trip and map a resolve failure to a typed error envelope, exactly like `executor.ts`'s `targetError`. `TableRowsRequest` gains `connectionId?: string | null`, mirroring `ExecuteRequest`'s existing field.

The untargeted path (`connectionId` omitted or `null`) must stay byte-identical: `connectionTargets.resolve(null)` already returns the boot manager's seams (`connection-targets.ts:119-121`), so every existing call site that never sends an id keeps its current behavior verbatim.

## Boundaries & Constraints

**Always:**
- AR-12: only the opaque `connectionId` crosses the loopback RPC; the URL/user/password are resolved in Core via `connectionTargets.resolve(id)` and NEVER echoed to the client.
- `connectionId` omitted or `null` at every one of the three seams falls back to the BOOT manager (the existing default target), so Ephemeral mode and every currently-green test stay unchanged.
- Reuse the EXISTING `connection-targets.ts` pool as-is (lazy, cached-by-id, self-invalidating against the registry, closed in `closeAll()`); the only change to that file is the additive `connect` seam.
- Mirror the executor's established pattern exactly: shape-validate `connectionId` (string or null) BEFORE any connection round-trip → `bad_request` on a wrong type; map a resolve failure via the same `not-found → not_found` / `unavailable → internal_error` convention (`executor.ts:434-438`).
- `table.rows` and `connect` accept `connectionId` the same way `execute` already does (`ExecuteRequest.connectionId?: string | null`) — same field name, same semantics, for a consistent wire contract across all targeted RPCs.

**Block If:**
- `connect`/`table.rows` cannot accept an optional `connectionId` without changing the reply shape or behavior of the existing no-id call sites — HALT `blocked`, condition `connectionId threading breaks the byte-identical ephemeral/default path`. (Expected FALSE: `connectionTargets.resolve(null)` already returns the boot manager's seams unchanged.)
- The resolved target's neutral `ConnectResult` cannot be produced from `ConnectionSeams` without duplicating `connection.ts`'s driver-open/failure-classification logic outside `connection.ts` — HALT `blocked`, condition `no seam exists to produce a neutral connect result for a resolved target`. (Expected FALSE: every cached/target manager IS a full `ConnectionManager`, so `seamsFor` can delegate `connect` to `manager.connect()` directly, same as every other seam.)

**Never:**
- Never send a URL, username, or password over `/rpc` or `/chat/stream` — only the id.
- Never build a second/parallel connection pool or bypass `connectionTargets` — `tableRows`/`connect`/chat resolve through the SAME `resolve(connectionId)` the executor uses.
- Never change the behavior, reply shape, or test expectations of the untargeted (no `connectionId`) path for `connect`, `table.rows`, or chat.
- Never let a targeted chat request change the outbound provider payload's schema-only invariant (`rowSample: null`, AR-6/R5) — `connectionId` only changes WHICH schema is introspected, never what leaves the machine.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `connect` with no `connectionId` | `params` omits it / `connectionId: null` | Resolves the BOOT manager exactly as today; `ConnectResult` unchanged, byte-identical | none |
| `connect` with a valid saved-connection id | `connectionId: "<id>"` for a saved connection | `connectionTargets.resolve(id)` opens/reuses the cached target manager; `seams.connect()` returns the neutral `ConnectResult` (`connected` or a classified `failed`) for THAT target | domain `failed` status, not a throw |
| `connect`/`table.rows` with an unknown id | `connectionId` no longer in the registry (removed) | `resolve` → `not-found` → `errorReply("not_found", "no connection with that id")` | typed `not_found` envelope |
| `connect`/`table.rows` during a credential-store blip | `resolve` → `unavailable` | `errorReply("internal_error", "credential store is unavailable")` | typed `internal_error` envelope, no store details leaked |
| `connect`/`table.rows` with a malformed `connectionId` | `connectionId` present but not a string/null (e.g. a number) | Rejected BEFORE any round-trip: `bad_request` | typed `bad_request` envelope |
| `table.rows` targeting a saved connection | valid `connectionId`, valid table/page params | Rows composed/paginated against the RESOLVED target's schema (via `seams.getSchema`/`seams.quoteIdent`/`seams.runQuery`), identical shape to the boot-manager path | validation errors unchanged (`bad_request`/`not_found` on bad table/column) |
| Chat with a targeted `connectionId` | valid id, provider configured | `getSchema(connectionId)` resolves the target and introspects THAT schema; outbound payload stays schema-only (`rowSample: null`) exactly as today, just scoped to a different DB | same redacted `error` chunk path on failure |
| Chat with an unresolvable `connectionId` | unknown/unavailable id | Reuses the EXISTING "no active connection" `bad_request` catch (`chat.ts:276-281`) — a resolve failure surfaces the same way a boot-connect failure already does; no new chat error code | `bad_request`, "no active connection" |
| Connection repointed/removed in Settings mid-session | a cached target's stored url changes or the connection is deleted | `connectionTargets`'s existing self-invalidation fires on the NEXT `resolve` (no change needed here — reaffirmed, not re-implemented) | stale manager evicted+closed automatically |
| Shutdown races a targeted resolve | `stop()` in flight when `connect`/`table.rows`/chat resolves | `connectionTargets` is latched closed → `not-found`, never opens a leaked target (existing `connection-targets.ts` behavior, reused as-is) | typed `not_found` |
| Ephemeral boot, no `connectionId` ever sent | positional `databaseUrl` boot, UI never sends an id | Every existing call site and test is UNCHANGED — this story adds a capability, it does not require the UI to use it yet | none |

</intent-contract>

## Acceptance Criteria

- **Given** the read RPCs `connect` and `table.rows`, **when** they are called with an optional `connectionId`, **then** the Core resolves the live manager via `connectionTargets.resolve(connectionId)` — instead of touching the boot `connectionManager` directly — for `tableRows`, `connect`/`getSchema`, and the chat responder; only the opaque id crosses the loopback (AR-12), and the URL is resolved in Core.
- **Given** an RPC or chat request with no `connectionId` (or `connectionId: null`), **when** it resolves, **then** it falls back to the boot manager as the default target, so Ephemeral mode (positional URL) is completely unchanged and every existing test stays green.
- **Given** a `connectionId` that names a saved connection, **when** `connect` or `table.rows` is called with it, **then** the response reflects THAT connection's schema/rows, not the boot connection's — reusing the SAME cached-by-id, self-invalidating pool the Reports executor already relies on.
- **Given** a `connectionId` that is unknown, removed, or hits a store blip, **when** any of the three seams resolves it, **then** the failure is typed and credential-neutral (`not_found` / `internal_error` for RPCs; the existing "no active connection" `bad_request` for chat) — never a raw URL/credential, never an unhandled throw for a malformed id.
- **Given** the full suite, **when** run after this change, **then** `bunx tsc --noEmit` is clean, `bun test` is green with NO existing test needing a behavior change (only new tests for the targeted paths), and `bun run build` succeeds.

## Code Map

- `src/core/connection-targets.ts` — add `connect: () => manager.connect()` to `ConnectionSeams` and its implementation in `seamsFor` (~line 84-92). No other change to this file; the pool, cache, and invalidation logic are untouched.
- `src/core/server.ts` — `tableRows(params)` (~line 302) extracts+validates `connectionId`, resolves via `connectionTargets.resolve`, and runs the read against the resolved seams instead of `connectionManager` directly. The `rpcContext.connect` capability (~line 435) becomes connectionId-aware. `chatResponder`'s `getSchema` dependency (~line 348) is rebuilt to accept an optional `connectionId` and resolve through `connectionTargets`.
- `src/core/rpc.ts` — `connect` handler (~line 149) becomes a shape-checking `preformed` handler (mirroring `connections.edit`/`execute`'s `connectionId` validation), reading an optional `connectionId` from `params` and mapping a resolve failure to `not_found`/`internal_error` before dispatch wraps anything.
- `src/core/chat.ts` — `ChatResponderDeps.getSchema` (~line 192) widens to `(connectionId?: string | null) => Promise<DatabaseSchema>`; `answerStream`'s params parsing (`prepareRequest`, ~line 237) reads the optional `connectionId` and threads it to `deps.getSchema`.
- `src/shared/contract.ts` — `TableRowsRequest` (~line 340) gains `connectionId?: string | null`, mirroring `ExecuteRequest`'s existing field (~line 876-877); the `connect` RPC's (currently paramless) request shape gains an equivalent optional field; chat's wire params gain `connectionId` alongside `provider`/`message`.
- Reference pattern already in the tree: `src/core/executor.ts:680-693` (shape-validate then `resolveConnection`) and `:434-438` (`targetError` mapping) — the new call sites should read as siblings of this code, not a divergent style.
- Tests to extend (existing suites, no new files expected): `src/core/server.test.ts` (or wherever `tableRows`/`connect` RPC dispatch is covered), `src/core/chat.test.ts` (targeted `getSchema` cases), `src/core/connection-targets.test.ts` (the new `connect` seam), `src/core/rpc.test.ts` (the `connect` handler's shape validation + error mapping).

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

- [ ] `src/core/connection-targets.ts` -- add `connect` to `ConnectionSeams` + `seamsFor` -- lets a resolved target produce the same neutral `ConnectResult` the boot manager does.
- [ ] `src/core/server.ts` -- thread `connectionId` through `tableRows`, the `connect` context capability, and the `chatResponder` construction, resolving each via `connectionTargets` instead of `connectionManager` directly -- the three seams named in the story.
- [ ] `src/core/rpc.ts` -- shape-validate `connectionId` on `connect`; make it `preformed` so a resolve failure maps to `not_found`/`internal_error` -- mirrors `execute`'s existing validation.
- [ ] `src/shared/contract.ts` -- add `connectionId?: string | null` to `TableRowsRequest` and the `connect`/chat request shapes -- wire contract parity with `ExecuteRequest`.
- [ ] `src/core/chat.ts` -- widen `getSchema` to accept an optional `connectionId`; reuse the existing "no active connection" catch for a resolve failure -- no new chat error code.
- [ ] Extend `connection-targets.test.ts`, `server`/`rpc` tests, `chat.test.ts` -- cover targeted success, unknown id, malformed id, and the untargeted path staying unchanged -- proves the default path is byte-identical.

## Spec Change Log

<!-- populated by later revisions -->

## Review Triage Log

<!-- populated by the review loop -->
