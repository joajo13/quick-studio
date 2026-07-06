---
title: 'Story 1.5 — Clean, instant shutdown'
type: 'feature'
created: '2026-07-06'
status: 'done'
baseline_revision: 'ab58281fe85d7d19f563fc5258fa47cfe97240c4'
review_loop_iteration: 0
followup_review_recommended: false
final_revision: '2a6c203f1f9e8b74b085555638fd722449957985'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The Core boots a `Bun.serve` server that holds the event loop open, but nothing ever stops it cleanly: `bin/quick-studio.ts` discards the returned `core` handle (whose `stop()` already exists), registers no signal handlers, and the UI has no stop control. On Ctrl-C the default SIGINT handler kills the process abruptly — `server.stop()` is never called — and there is no user-facing way to end a session (NFR-3: terminate ≤2s, no orphan, never stall OS shutdown).

**Approach:** Wire an idempotent shutdown path shared by two triggers: (1) SIGINT/SIGTERM handlers in the CLI that call `core.stop()` then exit; (2) an authenticated `shutdown` RPC behind a UI stop control that acks first, then tears the server down after the reply flushes. Extract the stop-then-exit sequence into a small testable controller so both triggers converge and fire at most once.

## Boundaries & Constraints

**Always:**
- Shutdown is idempotent: the stop+exit sequence runs at most once even if SIGINT fires twice, or a signal and the UI stop race. A second trigger is a safe no-op.
- The `shutdown` RPC handler returns its ack reply BEFORE the server socket closes; the actual teardown is scheduled on a macrotask (e.g. `setTimeout(fn, 0)`) so the UI receives `{ stopping: true }`, never a dropped connection mid-reply.
- The `shutdown` RPC sits behind the existing gates unchanged (POST-only, Origin/Host, token) — an unauthenticated or foreign-origin caller can never stop the server.
- `startCore` and `dispatch` stay import-safe for `bun test`: neither reaches `process.exit` on its own. The exit lives only in the CLI wiring; `startCore`'s default teardown is `server.stop(true)` (release the port), and the process-exit hook is injected by `bin/`.
- Teardown must be synchronous and prompt (no awaited long work in the signal handler) so it never stalls OS shutdown and terminates well within ≤2s. Ephemeral: nothing is written or cleaned on disk — "clean" means socket release + process exit.
- Module files kebab-case; React components PascalCase; explicit `.ts`/`.tsx` import extensions; `import type` for type-only imports (verbatimModuleSyntax); respect `noUncheckedIndexedAccess`.

**Block If:**
- Registering `process.on('SIGINT' | 'SIGTERM', …)` in this Bun environment does not override the default terminate behavior (i.e. the handler cannot run before the process dies) — the signal-driven clean stop is a mandated guarantee, not one to silently drop.

**Never:**
- No DB pool / driver teardown (none exists yet — stories 1.2/1.3 are backlog). Design the controller so an `await pool.end()` can slot in later, but do not add pool logic now.
- No persistence, pid files, unix sockets, or temp-file cleanup (Ephemeral; nothing is on disk).
- No new gates, auth changes, or Origin/Host relaxation; no widening of the UI ring's powers beyond adding one stop control that calls one new RPC.
- No forced `kill -9`-style teardown or `process.exit(non-zero)` on a normal stop.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ctrl-C once | SIGINT while running | `core.stop()` called once; process exits `0` within ≤2s; port released; no orphan | No error expected |
| Ctrl-C mashed / signal race | second SIGINT (or SIGTERM) during teardown | idempotent: no second stop/exit; process still exits cleanly | No error expected |
| OS shutdown | SIGTERM | same teardown as SIGINT; exits promptly, never stalls | No error expected |
| UI stop control | authenticated `POST /rpc {method:"shutdown"}` | reply `{ok:true, result:{stopping:true}}` flushed to UI, THEN server stops + process exits | n/a |
| Unauthenticated shutdown | `shutdown` RPC with missing/invalid token or foreign Origin/Host | `403` (`unauthorized`/`forbidden_origin`); server keeps running, no teardown | gated before dispatch |

</intent-contract>

## Code Map

- `src/core/lifecycle.ts` (new) -- `createShutdownController({ stop, exit })` returning `{ initiate() }` that runs `stop()` then `exit()` at most once (a `hasRun` guard). Dependency-free, unit-testable with injected spies.
- `bin/quick-studio.ts` -- retain the `core` handle; build a controller over `core.stop` + `() => process.exit(0)`; register SIGINT + SIGTERM → `controller.initiate`; pass `onShutdownRequested: () => controller.initiate()` into `startCore` so the UI path converges on the same teardown.
- `src/core/server.ts` -- add `StartCoreOptions { onShutdownRequested?: () => void }` (default `() => server.stop(true)`); build an `RpcContext { requestShutdown }` where `requestShutdown` schedules `onShutdownRequested` on a post-flush macrotask; pass the context to `dispatch`.
- `src/core/rpc.ts` -- add `RpcContext` type + a `shutdown` handler; change `Handler` to `(params, ctx) => unknown` and `dispatch(request, ctx)`; the `shutdown` handler calls `ctx.requestShutdown()` and returns `{ stopping: true }`.
- `src/shared/contract.ts` -- add `ShutdownResult = { readonly stopping: true }` alongside `HealthResult`.
- `src/ui/App.tsx` -- add `callShutdown()` mirroring `callHealth()` (token-gated POST); wire an `onStop` handler passed to `Workspace`; on ack or dropped connection show a "stopped" state (reuse the network-error catch shape).
- `src/ui/workspace/Workspace.tsx` -- add a stop control (button) in the header next to `connectionIndicator`, invoking the injected `onStop`.
- `src/core/rpc.test.ts` -- extend: `dispatch({method:"shutdown"}, ctx)` returns ok `{stopping:true}` and calls `ctx.requestShutdown` exactly once.
- `src/core/lifecycle.test.ts` (new) -- unit-test the controller: `initiate()` runs stop→exit once; a second `initiate()` is a no-op.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `ShutdownResult` type -- typed result for the new RPC
- [x] `src/core/lifecycle.ts` -- idempotent `createShutdownController({stop, exit})` -- single convergence point for both triggers
- [x] `src/core/rpc.ts` -- `RpcContext` + `shutdown` handler; thread `ctx` through `dispatch`/`Handler` -- UI-triggered stop, ack-before-teardown
- [x] `src/core/server.ts` -- `StartCoreOptions.onShutdownRequested` (default `server.stop(true)`); build `RpcContext.requestShutdown` deferring teardown to a post-flush macrotask; pass ctx to `dispatch` -- reply flushes before the socket closes
- [x] `bin/quick-studio.ts` -- retain `core`; controller over `core.stop`+`process.exit(0)`; SIGINT/SIGTERM handlers; pass `onShutdownRequested` into `startCore` -- Ctrl-C + OS-shutdown + UI paths converge
- [x] `src/ui/App.tsx` -- `callShutdown()` + `onStop` handler + stopped state -- UI stop control behavior
- [x] `src/ui/workspace/Workspace.tsx` -- header stop button wired to `onStop` -- the UI stop control (NFR-3)
- [x] `src/core/lifecycle.test.ts` -- unit-test idempotency (stop→exit once; second call no-op) -- locks the once-only guarantee
- [x] `src/core/rpc.test.ts` -- unit-test `shutdown` dispatch returns `{stopping:true}` and calls `requestShutdown` once -- locks the RPC contract

**Acceptance Criteria:**
- Given a running session, when I press Ctrl-C, then `core.stop()` is invoked once, the process exits `0` within ≤2s, the port is released, and no orphaned process remains (NFR-3).
- Given a running session, when the OS sends SIGTERM (shutdown), then the same teardown runs promptly without stalling and no daemon outlives the session.
- Given the browser UI, when I use the stop control, then the `shutdown` RPC returns `{stopping:true}` to the UI first and the server then stops and the process exits — the UI reflects a stopped/disconnected state.
- Given the `shutdown` RPC is called without a valid token or from a foreign Origin/Host, then it is rejected `403` and the server keeps running.
- Given `bun test`, when it runs, then the lifecycle idempotency and shutdown-dispatch tests pass with no browser in the loop, importing `startCore`/`dispatch` never exits the runner, and `bun x tsc --noEmit` is clean under strict.

## Spec Change Log

## Review Triage Log

### 2026-07-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 3, low 3)
- defer: 0
- reject: 4
- addressed_findings:
  - `[medium]` `[patch]` Shutdown controller could wedge the process and its async-teardown seam was a lie: `initiate()` set `done=true` then ran `io.stop(); io.exit()` synchronously with no `await`, so (a) a throwing `stop()` skipped `exit()` and every later trigger no-op'd → permanent hang (the exact failure the story prevents), and (b) the header-promised `await pool.end()` future seam would never actually await. Made `initiate` async: `try { await io.stop() } catch {} io.exit()`, widened `ShutdownIo.stop`/`Core.stop` to `void | Promise<void>`; exit now always runs and async teardown genuinely completes first. Added lifecycle tests for the throw and async-stop cases.
  - `[medium]` `[patch]` The mount `health` probe could clobber the `stopped` state: its `.then` set `{phase:"error"}` even after the user hit Stop, flipping the indicator from "Stopped" back to a scary "Disconnected · network_error". Made `stopped` terminal via a functional `setStatus((prev) => prev.phase === "stopped" ? prev : s)`.
  - `[medium]` `[patch]` The story's central wiring (shutdown RPC → `onShutdownRequested` deferred to a macrotask; gates still enforced; no `process.exit` reachable from `startCore`) had zero automated coverage — only pure `dispatch` was tested. Added `src/core/server.test.ts`: authenticated shutdown acks `{stopping:true}` and fires the injected hook only on the next macrotask; unauthenticated shutdown is `403` and never triggers teardown; the runner surviving proves no `process.exit`.
  - `[low]` `[patch]` The destructive Stop button had no pending/disabled state, so a double-click fired two `shutdown` RPCs. Added a `stopping` guard: ignore repeat clicks, disable the button and show "Stopping…".
  - `[low]` `[patch]` `bin`'s forward-referenced `controller` was `undefined` until reassigned, so a broken timing invariant would deref `undefined`. Initialized it to a safe `{ initiate: async () => {} }` no-op.
  - `[low]` `[patch]` The default `onShutdownRequested`'s `server.stop(true)` Promise was dropped inside `setTimeout` (potential unhandled rejection). Wrapped as `() => { void server.stop(true); }`.
- rejected (noise / by-design): switching to `server.stop(false)` for the ack (force-close is correct for the prompt/never-stall guarantee; the macrotask flush is empirically verified via e2e — ack arrives before teardown); `callShutdown`'s catch treating a dropped connection as `stopped` (correct on loopback — a thrown fetch during shutdown means the server died; non-ok error envelopes are already surfaced as errors); SIGINT during the boot-time UI build bypassing the controller (default terminate is the desired outcome — nothing is bound/to clean, and registering handlers earlier would point them at a no-op and suppress exit); a confirmation dialog on Stop (not in the spec's scope; Ephemeral, nothing to lose).

## Design Notes

- **Why a controller, not inline exit.** The stop+exit sequence must (a) be idempotent across SIGINT/SIGTERM/UI races and (b) be unit-testable without killing the test runner. Extracting `createShutdownController({stop, exit})` with a `hasRun` boolean gives both — `bin/` injects the real `core.stop` and `process.exit`; tests inject spies. Golden shape:
  ```ts
  export function createShutdownController(io: { stop: () => void; exit: () => void }) {
    let done = false;
    return { initiate() { if (done) return; done = true; io.stop(); io.exit(); } };
  }
  ```
- **Ack-before-teardown.** A handler that stopped the server synchronously would close the socket carrying its own reply. So `dispatch` returns `{stopping:true}` normally, and `requestShutdown` defers the real teardown: `() => setTimeout(onShutdownRequested, 0)` — a macrotask that runs after Bun flushes the `/rpc` Response. `onShutdownRequested` defaults to `server.stop(true)` (force-close + release port) so `startCore` is self-contained and test-safe; `bin/` overrides it with `controller.initiate` so the UI path also exits the process.
- **Signal handlers override the default.** Registering a `SIGINT` listener in Bun/Node suppresses the default terminate, so the handler MUST exit itself (`process.exit(0)`); that is exactly what the controller does. Keep the handler body synchronous — no awaited work — so OS shutdown is never stalled.
- **Forward-compatible teardown.** When the 1.3 driver lands, its pool handle lives alongside `Core` and `core.stop()` grows an `await pool.end()`; the controller/`onShutdownRequested` seam is where that async teardown slots in. Do not build it now.

## Verification

**Commands:**
- `bun x tsc --noEmit` -- expected: clean under strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
- `bun test` -- expected: new lifecycle + shutdown-dispatch tests pass alongside the existing suite (0 fail); importing `startCore`/`dispatch` never exits the runner

**Manual checks:**
- `bun run bin/quick-studio.ts`, then press Ctrl-C in the terminal: the process exits promptly (≤2s), the shell prompt returns, and `ps`/`jobs` shows no lingering quick-studio process; re-running on the same fixed `QS_PORT` binds without an "address in use" error (port released).
- Boot again and open `http://127.0.0.1:<port>`: click the header stop control → the UI shows a stopped/disconnected state and the terminal process exits with no orphan.
- Boot again and `kill -TERM <pid>`: the process exits promptly (simulating OS shutdown), never hanging.

## Auto Run Result

Status: done

### Summary
Wired a clean, instant shutdown path shared by two triggers. (1) `bin/quick-studio.ts` now retains the `core` handle and registers `SIGINT`/`SIGTERM` handlers that converge on an idempotent `ShutdownController` (`src/core/lifecycle.ts`) running `stop()` then `process.exit(0)` at most once. (2) An authenticated `shutdown` RPC (`src/core/rpc.ts` + `src/core/server.ts`) acks `{stopping:true}` and defers the real teardown to a macrotask (`setTimeout(fn,0)`) so the reply flushes before the socket closes; the UI's `shutdown` RPC routes to the same controller, so Ctrl-C, OS shutdown (SIGTERM), and the header "Stop" button all end the session identically. Teardown is synchronous/prompt (no orphan, never stalls OS shutdown), and Ephemeral — nothing on disk to clean. The `shutdown` RPC sits behind the existing POST/Origin-Host/token gates unchanged; `process.exit` lives only in `bin/` so importing `startCore`/`dispatch` in tests never kills the runner.

### Files changed
- `src/shared/contract.ts` — added `ShutdownResult = { readonly stopping: true }`.
- `src/core/lifecycle.ts` (new) — idempotent `createShutdownController({stop, exit})`; `initiate` awaits a (possibly async) `stop` then always `exit`s, even if `stop` throws.
- `src/core/lifecycle.test.ts` (new) — order, async-stop-awaited, exit-on-throw, and idempotency cases.
- `src/core/rpc.ts` — `RpcContext { requestShutdown }`, ctx-threaded `Handler`/`dispatch`, `shutdown` handler returning `{stopping:true}`.
- `src/core/rpc.test.ts` — stub ctx across call sites + shutdown-dispatch test + `methodNames` update.
- `src/core/server.ts` — `StartCoreOptions.onShutdownRequested` (default `() => { void server.stop(true); }`); per-request `rpcContext.requestShutdown` deferring teardown to a macrotask; `Core.stop` widened to `void | Promise<void>`.
- `src/core/server.test.ts` (new) — server-level wiring: authenticated shutdown acks + macrotask-deferred hook; unauthenticated `403` with no teardown.
- `bin/quick-studio.ts` — retained `core`; forward-referenced controller (safe no-op default) over `core.stop` + `process.exit(0)`; SIGINT/SIGTERM handlers; `onShutdownRequested` wiring.
- `src/ui/App.tsx` — `callShutdown()`, terminal `stopped` status phase (health probe can't clobber it), `stopping` guard against double-fire.
- `src/ui/workspace/Workspace.tsx` — header "Stop" button wired to `onStop`, disabled + "Stopping…" while pending.

### Review findings breakdown
- Patches applied: 6 (3 medium, 3 low) — see Review Triage Log 2026-07-06. Medium: idempotent-controller wedge-on-throw + real async-teardown seam; `stopped` made terminal so the mount health probe can't overwrite it; added server-level coverage of the shutdown wiring. Low: Stop-button pending/disable; `bin` no-op controller default; wrapped the dropped `server.stop(true)` Promise.
- Deferred: 0.
- Rejected: 4 — `server.stop(false)` for the ack (force-close is correct for prompt/never-stall; flush verified by e2e), `callShutdown` drop-as-success (correct on loopback; error envelopes already surfaced), boot-time SIGINT bypassing the controller (default terminate is desired; nothing bound), Stop confirmation dialog (out of scope, Ephemeral).
- intent_gap: 0, bad_spec: 0 (no spec loopback; `review_loop_iteration` stayed 0).

### Verification performed
- `bun x tsc --noEmit` → clean under strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- `bun test` → 58 pass / 0 fail (121 expect calls) across 6 files (~8.4s; the single server-level boot runs the Tailwind UI build).
- e2e (real signals + authenticated RPC on ephemeral ports): Ctrl-C → process exits in ~0.10s, port released, no orphan; UI `shutdown` RPC → ack `{"ok":true,"result":{"stopping":true}}` received first, then server stops (~0.1s), process exits `0` (no orphan), port released; unauthenticated `shutdown` → `403 unauthorized`, server stays up.

### Residual risks
- `startCore` still runs `buildUiBundle` on every boot (~7s Tailwind build), so the one server-level test that boots a real Core dominates suite time — carried by the pre-existing 1.1 deferred item about decoupling the UI build / cold start (stories 1.2 / 1.7); not introduced here.
- The ack-before-teardown flush relies on the standard macrotask window (`setTimeout(fn,0)` after the Response returns); empirically reliable on loopback (verified) and the UI treats a dropped connection as `stopped` regardless, so a missed ack is still surfaced correctly.
- Async teardown seam (`await pool.end()`) is wired but unexercised until the 1.3 driver lands a pool.
