---
title: 'Story 1.2 — One-command run with mode selection (Ephemeral vs Persistent) + browser-open'
type: 'feature'
created: '2026-07-07'
status: 'done'
baseline_revision: '4680ea35c42de7d0b37b9aba537b385e370b0808'
final_revision: '4302977858a9dff20623162c301196f8f4ecd0f7'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** quick-studio boots the Core but has no CLI: it can't select Ephemeral vs Persistent from the command line, never opens the Workspace in a browser, and the "Ephemeral writes nothing" guarantee is unenforced at the boot path. Story 1.1 deliberately deferred CLI mode parsing and browser-open to here.

**Approach:** Add a pure CLI arg parser that turns `argv` + `env` into a resolved `{ mode, databaseUrl, openBrowser }`, thread the selected `RunMode` from `bin/` through `startCore`, and after boot launch the OS default browser on a *navigable* Workspace URL (best-effort, never fatal). Reuse the existing `run-mode.ts`, `binding.ts`, `app-dir.ts`, and (already mode-gated) `credential-store.ts` rather than inventing new machinery.

## Boundaries & Constraints

**Always:**
- Selection precedence: a DB-URL positional ⇒ Ephemeral; `--persistent` ⇒ Persistent; a URL together with `--persistent` is contradictory and refused; with neither, fall back to `resolveRunMode(env)` (honors `QS_MODE`, default Persistent). A DB URL overrides `QS_MODE`.
- Ephemeral boot writes NOTHING to disk — no app dir, store, key, or file is created; the DB URL lives only in Core memory and is handed forward for Story 1.3 to consume.
- The browser-open target must be an authority the Origin/Host gate accepts: never `http://0.0.0.0:…` (map wildcard binds to a loopback address) and never `localhost` when the Core bound `127.0.0.1` (they are distinct origins in `validateOrigin`).
- Browser-open is best-effort: any launcher/spawn failure is logged terse to stderr and the Core keeps running — launch failure never aborts the session.
- Server still binds `127.0.0.1` by default; `QS_HOST`/`QS_PORT` semantics from stories 1.1/1.6 are unchanged.
- No new runtime dependency — use Bun stdlib (`util.parseArgs`, `Bun.spawn`). Module files kebab-case.

**Block If:**
- Planning artifacts contradict the "URL ⇒ Ephemeral / no-URL (or `--persistent`) ⇒ Persistent" rule or the `127.0.0.1` default.
- The three-ring model is found to forbid holding the ephemeral DB URL in Core memory across boot.

**Never:**
- No real DB connection, driver use, engine/scheme validation, or schema introspection — that is Story 1.3. This story only parses the URL (shape-checks that it is a URL) and carries it forward.
- No credential-store persistence, keychain, or connection-management wiring — Persistent mode here only *selects* the mode; store wiring is Epic 2.
- No rewrite of the auth model or the wildcard-bind relaxation beyond the bounded scheme-default-port fix below.
- No daemon outliving the process; no persistence of any kind in Ephemeral mode.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ephemeral via URL | `quick-studio postgres://u:p@h/db` | mode `ephemeral`; URL kept in memory; browser opens navigable Workspace URL; no disk write | No error expected |
| Persistent default | `quick-studio` (no args, `QS_MODE` unset) | mode `persistent`; binds `127.0.0.1`; browser opens | No error expected |
| Explicit persistent flag | `quick-studio --persistent` | mode `persistent`; browser opens | No error expected |
| Env-forced ephemeral | `QS_MODE=ephemeral quick-studio` | mode `ephemeral` (no URL yet); no disk write | No error expected |
| Contradictory selection | `quick-studio pg://… --persistent` | Refuse; terse stderr; `exit(1)` | `contradictory mode selection` |
| Malformed URL positional | `quick-studio not a url` | Refuse; terse stderr; `exit(1)` | URL must parse (`new URL`) |
| Unknown flag | `quick-studio --frobnicate` | Refuse; terse stderr; `exit(1)` | unknown option |
| Suppressed open | `--no-open` or `QS_NO_OPEN=1` | No browser spawn; Core runs; URL logged to stderr | No error expected |
| Wildcard bind open URL | `QS_HOST=0.0.0.0 quick-studio` | open target `http://127.0.0.1:<port>` (not `0.0.0.0`); `::` → `http://[::1]:<port>` | No error expected |
| Launcher failure | `Bun.spawn` throws / no launcher | Core keeps running; terse stderr note | Swallow; never throw |
| Pinned default port | `QS_PORT=80 quick-studio` | open target omits `:80`; RPC from that origin passes the gate | No error expected |

</intent-contract>

## Code Map

- `bin/quick-studio.ts` -- CLI entry; wires arg parsing → `startCore(mode,host)` → browser-open. The one integration point.
- `src/core/cli-args.ts` -- NEW pure `parseCliArgs(argv, env)`; the mode+launch decision.
- `src/core/run-mode.ts` -- REUSE `RunMode`, `resolveRunMode(env)`, `RUN_MODE_ENV_VAR` (the env fallback).
- `src/core/binding.ts` -- ADD pure `deriveOpenUrl(bindHost, port)`; reuse `isWildcardHost`/`resolveBindHost`.
- `src/core/browser-open.ts` -- NEW best-effort per-OS launcher.
- `src/core/server.ts` -- `StartCoreOptions.mode`; expose `Core.mode` + `Core.openUrl`.
- `src/core/auth.ts` -- `validateOrigin`: accept the scheme-default port (80) with the port omitted.
- `src/core/app-dir.ts` / `src/core/credential-store.ts` -- the only disk writers; already mode-gated (no change; used to assert the no-write guarantee).

## Tasks & Acceptance

**Execution:**
- [x] `src/core/cli-args.ts` -- pure `parseCliArgs(argv, env)` via `util.parseArgs` → `{ mode: RunMode, databaseUrl: string | null, openBrowser: boolean }`; throws a typed `CliArgsError` (message only, no stack leak). Encodes the precedence, URL-shape check, `--no-open`/`QS_NO_OPEN`, and unknown-flag rejection -- central, testable decision.
- [x] `src/core/cli-args.test.ts` -- table-test every I/O-matrix arg row (URL, no-args, `--persistent`, `QS_MODE` fallback, conflict, malformed URL, unknown flag, `--no-open` + `QS_NO_OPEN`) -- AC testability.
- [x] `src/core/binding.ts` -- add pure `deriveOpenUrl(bindHost, port)`: wildcard `0.0.0.0`→`127.0.0.1`, `::`→`[::1]`; concrete host verbatim (IPv6 bracketed); omit port when it equals the http default 80; return `http://<host>[:<port>]` -- navigable, gate-passing URL.
- [x] `src/core/binding.test.ts` -- add cases: loopback verbatim, wildcard v4/v6 remap, concrete non-loopback verbatim, port-80 omission -- edge coverage.
- [x] `src/core/browser-open.ts` -- `openBrowser(url, { platform, spawn })` best-effort: darwin `open <url>`, linux `xdg-open <url>`, win32 `cmd /c start "" <url>`; swallow spawn errors (terse stderr), never throw, never await the child -- auto-open Workspace.
- [x] `src/core/browser-open.test.ts` -- assert per-platform argv via injected `spawn`; assert a throwing `spawn` is swallowed (call does not throw) -- AC + resilience.
- [x] `src/core/auth.ts` -- in `validateOrigin`, when `boundPort === 80` also accept a `Host` of bare `<host>` and an `Origin` of `http://<host>` (browser omits the default port); keep all other behavior identical -- close the pinned-80 dead-on-open path browser-open activates.
- [x] `src/core/auth.test.ts` -- add accept cases for port-80 authority with omitted port, and confirm non-80 ports still require the explicit port -- gate regression guard.
- [x] `src/core/server.ts` -- add `mode?: RunMode` to `StartCoreOptions`; set `Core.mode` from it; compute `Core.openUrl = deriveOpenUrl(bindHost, boundPort)` alongside the existing `url` -- thread mode + expose navigable URL.
- [x] `src/core/server.test.ts` -- boot with `mode:'ephemeral'` and app-dir env (`APPDATA`/`XDG_DATA_HOME`/`HOME`) pointed at a fresh temp dir; assert no file or directory is created there after boot; assert `core.mode` and `core.openUrl` for a wildcard bind -- Ephemeral no-write + open-URL AC.
- [x] `bin/quick-studio.ts` -- call `parseCliArgs(process.argv.slice(2), process.env)`; on `CliArgsError` write the message to stderr and `exit(1)`; pass `{ mode, host }` into `startCore`; after the `listening` log, if `openBrowser` call `openBrowser(core.openUrl, { platform: process.platform, spawn: Bun.spawn })`; keep the exposure box -- integrate.

**Acceptance Criteria:**
- Given a DB URL on the command line, when I run quick-studio, then `core.mode === 'ephemeral'`, the default browser is launched on `core.openUrl`, and no file or directory is created under the app data dir during or after boot.
- Given no URL and no flag, when I run quick-studio, then a Persistent session is selected (honoring `QS_MODE`, default Persistent) and the server binds `127.0.0.1`.
- Given either mode, when the server starts, then the browser-open target is an authority the Origin/Host gate accepts — never `0.0.0.0`, and (for a `127.0.0.1` bind) never `localhost`.
- Given browser-open fails, when the Core boots, then it keeps running and logs a terse note — launch failure never aborts the session.

## Spec Change Log

## Review Triage Log

### 2026-07-07 — Follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 0
- reject: 18
- addressed_findings:
  - none
- notes: Independent follow-up pass (Blind Hunter + Edge Case Hunter) over the same diff, targeting the security-sensitive `validateOrigin` relaxation that the prior pass flagged for follow-up. No new actionable defects. Every finding was either (a) already triaged in the prior pass — async spawn-failure (Bun.spawn throws ENOENT synchronously; already caught), URL-overrides-`QS_MODE` (URL is the strongest signal by spec), permissive `new URL` shape-check (already deferred to Story 1.3), `QS_NO_OPEN` `NO_*` convention, Windows `cmd` injection (no reachable trigger), `HTTP_DEFAULT_PORT` duplication — or (b) new noise/within-threat-model: the port-80 bare-authority relaxation is not materially weaker than the existing documented wildcard relaxation (token is the boundary; wildcard binds are not rebinding-proof, as the code comments state); `authorityPort` bare-unbracketed-IPv6 mis-parse and the `[::]`-bracketed-wildcard, mixed-case-host, port-0/NaN, and `Host:80`/bare-`Origin` cases are all either fail-safe (clean rejection) or unreachable through the URL `deriveOpenUrl` actually opens (the coherence harness pins the real browser path); `databaseUrl` being inert is a deliberate Story 1.3 boundary. The `validateOrigin` gate was independently re-reviewed here and confirmed sound within its documented threat model.

### 2026-07-07 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 3, low 1)
- defer: 1
- reject: 8
- addressed_findings:
  - `[medium]` `[patch]` Wildcard bind on port 80 (`QS_HOST=0.0.0.0`/`::` + `QS_PORT=80`) was dead-on-open: `deriveOpenUrl` omits `:80` and remaps the wildcard to loopback, but `validateOrigin`'s wildcard branch demanded an explicit port match, 403-ing every RPC. Added a bracket-aware `authorityPort()` and a port-80 relaxation to the wildcard branch so the portless `127.0.0.1` / `[::1]` authority the browser sends is accepted.
  - `[medium]` `[patch]` Concrete IPv6 loopback bind (`QS_HOST=::1`, any port) was dead-on-open: `deriveOpenUrl` brackets the host to `[::1]` but `validateOrigin` built `expectedAuthority` unbracketed (`::1:<port>`), so the bracketed `Host` never matched. Added `bracketIfIpv6()` to the concrete branch (authority + bare-host origin) to mirror `deriveOpenUrl`.
  - `[medium]` `[patch]` The malformed-DB-URL error echoed the raw positional (a connection string can embed a password) to stderr, which may be captured into logs/CI — violating the project's "secrets never logged" invariant. Redacted the message to not echo the URL, matching the other CLI errors.
  - `[low]` `[patch]` `bin/` launched the browser BEFORE printing the Port-Exposure Warning, so on an exposed bind the browser could pop before the operator saw the loud warning. Reordered so the warning always prints first.
  - `[coverage]` `[patch]` Added a `validateOrigin ⇔ deriveOpenUrl` coherence harness (every representative bind host × {ephemeral port, 80}) asserting the exact URL browser-open navigates to is accepted by the gate — the regression guard that would have caught both correctness findings above; plus concrete-`::1` and wildcard-80 unit cases.

## Design Notes

- **Precedence, one place:** all selection lives in `parseCliArgs` so `bin/` stays a thin wire-up. Order: conflict (URL + `--persistent`) → error; URL present → `ephemeral` (+ `databaseUrl`); `--persistent` → `persistent`; else `resolveRunMode(env)`. The DB URL is the *strongest* signal and overrides `QS_MODE`.
- **Why a separate open URL:** `core.url` is the bind host verbatim, so it is `http://0.0.0.0:…` (non-navigable) under a wildcard bind, and `validateOrigin` treats `localhost` and `127.0.0.1` as distinct origins. `deriveOpenUrl` returns an address that both resolves in a browser AND matches the gate: wildcard → loopback (the wildcard-bind auth relaxation then passes it by port-match), concrete host verbatim.
- **No-write guarantee is structural:** boot already touches no disk writer (`openCredentialStore` has no boot call site yet); this story keeps it that way and threads `mode` so the future store call inherits the correct Ephemeral gate. The server.test asserts the app dir stays absent — the concrete, regressible form of "writes nothing".
- **Best-effort launch:** `openBrowser` fire-and-forgets `Bun.spawn` and catches synchronously; a missing `xdg-open` on a headless box must not take down the Core. `--no-open`/`QS_NO_OPEN` exist precisely for CI/headless/dev-loop runs.

Golden shape:
```ts
// parseCliArgs → then in bin/
const cli = parseCliArgs(process.argv.slice(2), process.env);
const core = await startCore(resolvePort(), { host: resolveBindHost(process.env.QS_HOST), mode: cli.mode });
process.stderr.write(`quick-studio Core listening on ${core.url}\n`);
if (cli.openBrowser) openBrowser(core.openUrl, { platform: process.platform, spawn: Bun.spawn });
```

## Verification

**Commands:**
- `bun run build` then `bun test` -- expected: all suites pass incl. new `cli-args`/`browser-open`/`binding`/`auth`/`server` cases.
- `bunx tsc --noEmit` -- expected: clean under strict.
- `bun run bin/quick-studio.ts "postgres://u:p@localhost/db" --no-open` -- expected: stderr notes ephemeral + `listening on http://127.0.0.1:<port>`; no app dir created.
- `QS_HOST=0.0.0.0 bun run bin/quick-studio.ts --no-open` -- expected: derived open URL is `http://127.0.0.1:<port>`, not `0.0.0.0`.
- `bun run bin/quick-studio.ts --persistent --no-open` -- expected: persistent selected; `bun run bin/quick-studio.ts pg://x --persistent` -- expected: refuse + exit 1.

**Manual checks:**
- Run with a DB URL and no `--no-open`: the OS default browser opens the Workspace and the UI completes its authenticated `health` RPC (no `forbidden_origin`).

## Auto Run Result

Status: done

### Summary
Added the quick-studio CLI: a pure `parseCliArgs(argv, env)` resolves Ephemeral vs Persistent (a DB-URL positional ⇒ Ephemeral with the URL carried in memory for Story 1.3; `--persistent` ⇒ Persistent; URL + `--persistent` ⇒ refuse; otherwise `resolveRunMode(env)`, honoring `QS_MODE`, default Persistent) and whether to auto-open the browser (`--no-open`/`QS_NO_OPEN` suppress). The selected `RunMode` is threaded `bin/` → `startCore` → `Core.mode`; boot writes nothing to disk (Ephemeral guarantee kept structural). After boot `bin/` launches the OS default browser on a new navigable `Core.openUrl` (`deriveOpenUrl` maps wildcard binds to loopback, brackets IPv6, and drops `:80`) — best-effort, so a missing launcher never aborts the session. `validateOrigin` was extended to accept the scheme-default port 80 (browser omits it).

### Files changed
- `bin/quick-studio.ts` — parse argv → `startCore(mode,host)` → best-effort browser-open; exposure warning now precedes the open.
- `src/core/cli-args.ts` (new) — pure `parseCliArgs` + typed `CliArgsError`; the mode/launch decision.
- `src/core/cli-args.test.ts` (new) — table tests over the full I/O matrix.
- `src/core/browser-open.ts` (new) — per-OS best-effort launcher (`open`/`xdg-open`/`cmd /c start`), swallow-on-error, never throws.
- `src/core/browser-open.test.ts` (new) — per-platform argv + resilience.
- `src/core/binding.ts` — `deriveOpenUrl(bindHost, port)` navigable-URL derivation.
- `src/core/binding.test.ts` — `deriveOpenUrl` cases.
- `src/core/auth.ts` — `validateOrigin`: port-80 relaxation + bracket-aware IPv6/wildcard authority matching (`bracketIfIpv6`, `authorityPort`).
- `src/core/auth.test.ts` — port-80, concrete-`::1`, and a `validateOrigin ⇔ deriveOpenUrl` coherence harness.
- `src/core/server.ts` — `StartCoreOptions.mode`, `Core.mode`, `Core.openUrl`.
- `src/core/server.test.ts` — Ephemeral no-write boot + `openUrl` assertions.

### Review findings breakdown
- Patches applied: 4 (3 medium, 1 low) + a coherence-test regression guard — see Review Triage Log 2026-07-07. Two were real dead-on-open correctness breaks in the auth gate (wildcard+port-80, concrete IPv6 `::1`) that browser-open activated; one a credential-in-stderr leak; one a warning/open ordering fix.
- Deferred: 1 — DB-URL scheme/shape validation (reject `file:`/`javascript:`/Windows-drive pseudo-URLs) belongs to Story 1.3's real connection path (recorded in `deferred-work.md`).
- Rejected: 8 — shallow URL shape-check (by-design 1.3 deferral), persistent+URL asymmetry (spec: URL overrides `QS_MODE`; flag is a hard assertion), `QS_NO_OPEN` non-empty ⇒ suppress (`NO_*` convention), Windows `cmd` injection (no reachable trigger — URL is fixed-format from a validated host), the Ephemeral no-write test being "vacuous" (it locks the genuine boot-writes-nothing invariant; nothing finer is possible until Epic 2 wires the store), the test's `process.env` mutation (restored in `finally`, safe), `openBrowser` async-failure (Bun.spawn throws synchronously on a missing launcher — already caught; verified e2e), and `HTTP_DEFAULT_PORT` duplication.

### Verification performed
- `bun run build` → OK. `bun test` → **244 pass / 0 fail** (532 expect calls, 17 files). `bunx tsc --noEmit` → exit 0 (strict).
- e2e: wildcard boot (`QS_HOST=0.0.0.0`) → `listening on http://0.0.0.0:<port>`, Port-Exposure Warning printed BEFORE the open attempt, `openUrl` remapped to `http://127.0.0.1:<port>`, and the missing `xdg-open` produced only a terse note (Core kept running). Contradictory `URL + --persistent` → exit 1 with no URL echoed.

### Residual risks
- `followup_review_recommended: true` — the fixes touch the security-sensitive `validateOrigin` predicate (bracket-aware authority matching + port-80 relaxation). Localized and covered by the new coherence harness + unit cases, but an independent pass over the gate is warranted.
- `Core.mode` is threaded but inert this story (no consumer until Epic 2 wires `openCredentialStore`); the Ephemeral "writes nothing" guarantee currently rests on boot touching no disk writer, which the server test locks.
- Bun **1.3.14** in use vs the `1.2.x` floor in the stack seed — backward-compatible; `util.parseArgs` and `Bun.spawn` are stable across 1.2→1.3.

## Auto Run Result — Follow-up Review (2026-07-07)

Status: done

### Summary
Independent follow-up review pass over the same Story 1.2 diff, prompted by the prior pass's `followup_review_recommended: true` (the security-sensitive `validateOrigin` relaxation). Ran Blind Hunter (`bmad-review-adversarial-general`) and Edge Case Hunter (`bmad-review-edge-case-hunter`) in parallel at the session model capability. **No code changes** were made: every finding resolved to `reject`.

### Review findings breakdown
- Patches applied: 0. Bad-spec loopbacks: 0. Intent gaps: 0. New deferrals: 0.
- Rejected: 18 (deduped across both reviewers). Split between findings already triaged in the first pass (async spawn-failure — `Bun.spawn` throws ENOENT synchronously, already caught; URL-overrides-`QS_MODE` — URL is the spec's strongest signal; permissive `new URL` shape-check — already deferred to Story 1.3; `QS_NO_OPEN` `NO_*` convention; Windows `cmd` injection — no reachable trigger) and new noise within the documented threat model (port-80 bare-authority relaxation ≈ the existing wildcard relaxation, token is the boundary; `authorityPort` bare-IPv6 mis-parse, `[::]`-bracketed wildcard, mixed-case host, port-0/NaN, and split `Host:80`/bare-`Origin` are each fail-safe or unreachable via the URL `deriveOpenUrl` actually opens — the coherence harness pins the real path; `databaseUrl` inertness is a deliberate Story 1.3 boundary).

### Verification performed
- `bun run build` → OK. `bun test` → **244 pass / 0 fail** (532 expect calls, 17 files). `bunx tsc --noEmit` → exit 0 (strict). No source changed this pass, so the green suite is the same tree the first pass shipped.

### Residual risks
- The `validateOrigin` gate has now had the independent follow-up pass the first pass asked for and was confirmed sound within its documented (token-is-the-boundary) threat model — `followup_review_recommended` lowered to `false`.
- Unchanged from the initial run: `Core.mode` is threaded but inert until Epic 2 wires `openCredentialStore`; Bun 1.3.14 vs the 1.2.x floor is backward-compatible.
