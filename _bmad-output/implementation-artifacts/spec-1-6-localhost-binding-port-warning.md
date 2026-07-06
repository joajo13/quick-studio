---
title: 'Story 1.6 — Localhost-by-default binding + Port-Exposure Warning'
type: 'feature'
created: '2026-07-06'
status: 'done'
baseline_revision: 'c610ffa7d70611a85458d3fb1c9c0c5076aa1c2f'
review_loop_iteration: 0
followup_review_recommended: false
final_revision: 'deeeb7a0b7071aa49525554eab073c09bdb80f88'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The Core hardcodes `BIND_HOST = "127.0.0.1"` (`src/core/server.ts:19`) with no override, and that literal is also fed to `validateOrigin` as the accepted authority (`server.ts:189`). The epic requires loopback-by-default *with an explicit override*, and a prominent, unmistakable Port-Exposure Warning whenever the server is bound to a non-loopback address (FR-21, FR-22, UX-DR5). Today there is no override, no exposure detection, and — critically — naively widening the bind would leave `validateOrigin` pinned to the bind literal, 403-ing every RPC and shipping a dead-on-arrival "exposed" mode.

**Approach:** Add a `QS_HOST` override (default `127.0.0.1`) resolved through a small pure `binding` module that classifies loopback vs. exposed. Thread the resolved host into `Bun.serve` and into `startCore`'s returned `Core` as an `exposed` flag. On exposure, surface the warning on two prominent surfaces: a loud multi-line stderr banner at boot (in `bin/`) and a persistent, unmistakable in-UI banner (fed by a boot-time `window.__QS_EXPOSURE__` global) — each stating the risk and the exact steps to revert to localhost-only. Preserve the DNS-rebinding gate: when the bind host is a wildcard (`0.0.0.0`/`::`) the exact authority is unknowable, so accept any Host with the correct port **only when Origin (if present) matches that Host** — foreign-Origin requests stay rejected. The token remains the sole auth boundary (AD-12).

## Boundaries & Constraints

**Always:**
- Default with no `QS_HOST` (unset/empty/whitespace) binds `127.0.0.1`: `exposed=false`, no stderr warning, no UI banner, and `validateOrigin` behavior byte-for-byte unchanged from today.
- Loopback classification (no warning): `localhost`, `::1`, or any IPv4 in `127.0.0.0/8`. Everything else is exposed.
- On exposure, BOTH surfaces fire and BOTH name the risk and the exact revert steps ("stop quick-studio, unset `QS_HOST` (or set `QS_HOST=127.0.0.1`), start again").
- Exposed mode stays functional: a browser reaching an exposed instance can complete RPCs. Binding a concrete non-loopback IP keeps `validateOrigin` working unchanged (authority == that IP); binding a wildcard takes the port-match + Origin-must-match-Host branch.
- The token is never logged and never widened; the Origin/Host gate is never dropped, only made host-agnostic (still Origin==Host) for the explicitly opted-in wildcard case. No new powers for the UI ring beyond rendering one banner.
- Pure binding/classification logic lives in a dependency-free, unit-testable Core module (mirrors `lifecycle.ts`); `process.exit`/stderr side effects stay in `bin/`.
- Module files kebab-case; React components PascalCase; explicit `.ts`/`.tsx` import extensions; `import type` for type-only imports (verbatimModuleSyntax); respect `noUncheckedIndexedAccess`.

**Block If:**
- Preserving the DNS-rebinding defense for a wildcard bind would require accepting a request whose `Origin` differs from its `Host` authority (i.e. the only way to make exposed mode work is to drop the Origin==Host check). It must not — if the reachable-host model appears to demand a foreign Origin, HALT rather than silently weaken the gate.

**Never:**
- No continuous network-interface poller / OS-level "watcher" thread: exposure is classified from the resolved bind host at boot (static for the session). No runtime re-scan.
- No new RPC method and no change to the `health`/`shutdown` contracts — exposure state ships via the existing boot-global handoff, not a round-trip.
- No TLS, no auth changes, no reverse-proxy or port-forward detection, no persistence (Ephemeral).
- No blocking or refusing an exposed bind — the user explicitly opted in; we warn loudly, we do not veto.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Default | `QS_HOST` unset/empty/whitespace | bind `127.0.0.1`; `exposed=false`; no stderr warning; no UI banner; RPC works as today | No error expected |
| Explicit loopback | `QS_HOST=localhost` / `::1` / `127.0.0.2` | classified loopback; `exposed=false`; no warning/banner | No error expected |
| Wildcard exposure | `QS_HOST=0.0.0.0` | bind all interfaces; `exposed=true`; loud stderr warning + UI banner (risk + revert steps); RPC via any Host with matching port succeeds when Origin==Host or Origin absent | n/a |
| Concrete non-loopback | `QS_HOST=192.168.1.10` | bind that IP; `exposed=true`; warning + banner; RPC at `192.168.1.10:<port>` works unchanged (authority match) | n/a |
| Foreign Origin while exposed | wildcard bind; request with `Origin: http://evil.com`, `Host: <lan-ip>:<port>` | `403 forbidden_origin`; gate still defends | rejected before dispatch |
| Wrong-port Host while exposed | wildcard bind; `Host: <lan-ip>:<other-port>` | `403 forbidden_origin` | rejected before dispatch |

</intent-contract>

## Code Map

- `src/core/binding.ts` (new) -- pure module: `resolveBindHost(raw: string | undefined): string` (trim; default `127.0.0.1` when empty/whitespace), `isLoopbackHost(host)`, `isWildcardHost(host)`, `isExposed(host) = !isLoopbackHost(host)`. Dependency-free, unit-testable.
- `src/core/binding.test.ts` (new) -- classification tests: default/empty/whitespace → `127.0.0.1`; loopback set (`localhost`, `::1`, `127.0.0.1`, `127.0.0.2`) → not exposed; wildcard (`0.0.0.0`, `::`) → exposed + wildcard; concrete IP → exposed + not wildcard.
- `src/shared/contract.ts` -- add `ExposureInfo = { readonly exposed: boolean; readonly host: string; readonly port: number }` (the boot-global payload shape), alongside `HealthResult`/`ShutdownResult`.
- `src/core/auth.ts` -- `validateOrigin`: when `isWildcardHost(boundHost)`, accept any `Host` whose port === `boundPort` provided `Origin` is absent OR `Origin === http://<Host authority>`; otherwise unchanged (`${boundHost}:${boundPort}` match). Import `isWildcardHost` from `./binding.ts`.
- `src/core/auth.test.ts` -- extend: wildcard bind accepts `localhost:<port>` and `<lan-ip>:<port>` Host; rejects foreign Origin, mismatched Origin/Host, and wrong port; non-wildcard behavior regression-checked.
- `src/core/server.ts` -- `StartCoreOptions.host?: string` (default `127.0.0.1`); bind `hostname: bindHost`; compute `exposed = isExposed(bindHost)`; add `exposed` to the `Core` return; feed `bindHost` to `validateOrigin`; inject `window.__QS_EXPOSURE__` (JSON, `<`-escaped like the token) in `renderIndexHtml` next to the token.
- `src/core/server.test.ts` -- extend: boot `startCore(0, { host: "0.0.0.0" })` → `core.exposed === true` and the served HTML contains the exposure global with `exposed:true`; default boot → `exposed === false`.
- `bin/quick-studio.ts` -- `resolveBindHost(process.env.QS_HOST)`; pass `host` into `startCore`; after boot, if `core.exposed`, `process.stderr.write` a prominent multi-line Port-Exposure Warning (host:port, off-machine reach, DB-access risk, exact revert steps).
- `src/ui/App.tsx` -- type `window.__QS_EXPOSURE__: ExposureInfo | undefined`; read it at boot; pass exposure down to `Workspace`.
- `src/ui/workspace/Workspace.tsx` -- accept an `exposure?: ExposureInfo` prop; when `exposure?.exposed`, render a prominent full-width warning banner directly under `</header>` (amber/red Tailwind tokens) stating risk + revert steps.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/binding.ts` -- pure `resolveBindHost` / `isLoopbackHost` / `isWildcardHost` / `isExposed` -- single source of truth for host resolution + classification
- [x] `src/shared/contract.ts` -- add `ExposureInfo` type -- typed boot-global payload shared by Core + UI
- [x] `src/core/auth.ts` -- wildcard branch in `validateOrigin` (port match + Origin==Host) -- keep exposed mode functional without dropping the DNS-rebinding gate
- [x] `src/core/server.ts` -- `StartCoreOptions.host`, bind it, `Core.exposed`, inject `window.__QS_EXPOSURE__` -- wire binding + exposure handoff
- [x] `bin/quick-studio.ts` -- parse `QS_HOST`, pass host, loud stderr warning on exposure -- CLI surface + terminal warning
- [x] `src/ui/App.tsx` -- read/type `window.__QS_EXPOSURE__`, thread to Workspace -- UI receives exposure state at boot
- [x] `src/ui/workspace/Workspace.tsx` -- prominent Port-Exposure Warning banner when exposed -- the UI surface (FR-22, UX-DR5)
- [x] `src/core/binding.test.ts` -- unit-test classification + default resolution -- lock the loopback/exposed/wildcard boundaries
- [x] `src/core/auth.test.ts` -- unit-test wildcard `validateOrigin` cases + non-wildcard regression -- lock the gate contract under exposure
- [x] `src/core/server.test.ts` -- unit-test `core.exposed` + exposure-global injection for default vs. wildcard boot -- lock the wiring

**Acceptance Criteria:**
- Given no `QS_HOST` override, when the server runs, then it binds `127.0.0.1`, is unreachable from any other host, and shows no warning on either surface (FR-21).
- Given `QS_HOST` is set to a non-loopback address, when the Core boots, then `bin/` writes a prominent stderr Port-Exposure Warning naming the bound `host:port`, the off-machine risk, and the exact revert steps (FR-22).
- Given an exposed instance, when the browser UI loads, then a prominent, unmistakable in-UI banner is shown stating the risk and the exact steps to revert to localhost-only (UX-DR5).
- Given an exposed instance, when a legitimate same-origin browser issues an RPC, then it succeeds (exposed mode is not dead-on-arrival); and when a request carries a foreign `Origin`, it is still rejected `403 forbidden_origin`.
- Given `bun test`, when it runs, then binding/auth/server tests pass, `bun x tsc --noEmit` is clean under strict, and importing `startCore`/`dispatch` never exits the runner.

## Spec Change Log

## Review Triage Log

### 2026-07-06 — Follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 1
- reject: 8
- addressed_findings:
  - `[medium]` `[patch]` **Case-normalization gap**: `resolveBindHost` trimmed but did not lower-case, while `isLoopbackHost`/`isWildcardHost` classify case-insensitively. `QS_HOST=LocalHost` therefore classified loopback (no warning — correct) yet bound the verbatim host `LocalHost`, so `validateOrigin` built `expectedAuthority = "LocalHost:<port>"` and 403'd every RPC (browsers send a lower-cased `Host`). A supported loopback spelling silently bricked the app. Fixed by lower-casing in `resolveBindHost` (single source of truth); added `binding.test.ts` cases (`LocalHost`/`LOCALHOST` → `localhost`).
  - `[low]` `[patch]` **`startCore` bypassed normalization**: it used `options.host ?? DEFAULT_HOST`, so any non-`bin/` caller (tests, future embedders) could bind a padded/mixed-case host (`" 127.0.0.1 "`) that classifies fine but 403s on the verbatim authority. Routed the default through `resolveBindHost(options.host)` so `bin/`, `startCore`, classification, and the authority match all share one normalized path.
  - `[low]` `[patch]` **Duplicated `DEFAULT_HOST`**: the loopback default `"127.0.0.1"` was declared independently in `binding.ts` and `server.ts`, contradicting `binding.ts`'s "single source of truth" claim. Removed the `server.ts` copy; the default now flows from `resolveBindHost(undefined)`.
- deferred: 1 (appended to `deferred-work.md` as a NEW entry): the wildcard bind's `core.url` (`http://0.0.0.0:<port>`) is a non-routable sentinel — story 1.2's browser-open must substitute a navigable `http://localhost:<port>` display URL rather than open `core.url` verbatim.
- rejected (noise / by-design / already-tracked): scheme-default ports (80/443) omitted from the `Host` match 403-ing RPC on `QS_PORT=80` (**already tracked in `deferred-work.md` from 1.1** — not re-filed); `LOOPBACK_V4_RE` accepting out-of-range octets like `127.999.999.999` (whole `127.0.0.0/8` is loopback regardless, and an invalid address won't bind — comment nitpick); hardcoded `http://` Origin prefix rejecting a `https://` TLS front (no TLS in scope, prior-rejected); `resolveBindHost` not allowlisting `QS_HOST` shape (user-supplied; Bun surfaces bind errors via the `bin/` catch, prior-rejected); IPv4-mapped/expanded loopback (`::ffff:127.0.0.1`, expanded `::1`) over-warning (safe direction — over-warns, never under-warns; outside the intent contract's explicit loopback set); distinct `forbidden_origin` vs `unauthorized` 403 codes forming a gate oracle (pre-existing from 1.1, granular diagnostics by-design; token is still the boundary); exposure `host` being attacker-influenced text in the banner (defended today by `scriptJson` `<script>`-escaping + React JSX auto-escaping — no live vuln); banner copy not stating exposure is "fixed until restart" (the stop/unset/restart steps already imply it — cosmetic).

### 2026-07-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 3, low 2)
- defer: 0
- reject: 7
- addressed_findings:
  - `[medium]` `[patch]` The wildcard `validateOrigin` branch **overclaimed** DNS-rebinding protection: the spec Design Note, the `auth.ts` comment, and a test all asserted "a foreign Origin stays rejected." False for a true rebind — the attacker controls both headers, so `Origin == Host == attacker-authority` satisfies the `Origin==Host` check and Gate 1 passes. No real vuln (the session token, Gate 2, still blocks it, consistent with AD-12 "the token, not loopback, is the boundary"), but the claim was wrong. Corrected the `auth.ts` comment and the spec Design Note to state the honest model (wildcard gate blocks only *plain* cross-origin; the token is the sole boundary in exposed mode); renamed the misleading test and added an explicit test documenting that a same-value rebind passes this predicate and is stopped by the token.
  - `[medium]` `[patch]` `isLoopbackHost` used `startsWith("127.")`, so a non-IP hostname like `127.evil.com` / `127.0.0.1.evil.com` was misclassified as loopback → its Port-Exposure Warning was suppressed. Replaced with a validated `127.0.0.0/8` dotted-quad regex; added `binding.test.ts` cases for the lookalikes.
  - `[medium]` `[patch]` The wildcard port extraction `hostHeader.split(":")[1]` mis-parsed bracketed IPv6 authorities (`[::1]:<port>` → `portStr===""`), 403-ing every legitimate IPv6 request under a `QS_HOST=::` bind. Switched to `lastIndexOf(":")`; added a `[::1]:<port>` accept test.
  - `[low]` `[patch]` `scriptJson` escaped `<` but not the U+2028/U+2029 JS line separators, and the exposure `host` (unlike the hex-filtered token) is the arbitrary `QS_HOST` value. Widened the escape to a `[<  ]` char class and corrected the parity comment; added a `renderIndexHtml` `</script>`-breakout test.
  - `[low]` `[patch]` `server.test.ts` booted a real `startCore({ host: "0.0.0.0" })` listener, opening a token-bearing endpoint to the whole LAN for the run — an unacceptable smell in a security-first story. Exported `renderIndexHtml` and unit-tested the exposure injection without booting; the `startCore`→`core.exposed` plumbing stays covered by the default boot. (Also cut suite time ~14.7s→7.3s.)
- rejected (noise / by-design): `resolveBindHost` not allowlisting `QS_HOST` (user-supplied; Bun surfaces bind errors via the generic `bin/` catch); scheme-default port (80/443) stripping in the Host match (already tracked in `deferred-work.md` from 1.1; ports aren't user-pinnable until 1.2); hardcoded `http://` Origin prefix rejecting `https://` (no TLS in scope; concrete path identical); warning printing `0.0.0.0` rather than enumerating live interface IPs (the copy is truthful and the revert steps are the actionable part; interface enumeration is an enhancement, not a defect); wildcard gate accepting an arbitrary Host when Origin is absent (inherent to the degraded gate; the token is the boundary — now documented honestly); `core.exposed` being a string classification not a live reachability check (explicitly by-design per the intent contract's "no watcher"); concrete-IPv6 bind authority mismatch (niche, unlisted in the IPv4-centric matrix — noted as a residual limitation).

## Design Notes

- **Why classify from the bind host, not a live watcher.** The AC's "exposure watcher detects it" is satisfied by evaluating the resolved bind host at boot: the binding is fixed for a session, so exposure is a pure function of `QS_HOST`. A polling network thread would be Ephemeral-hostile over-engineering (epic scope) and buys nothing. Keep it a boot-time classification.
- **The `validateOrigin` landmine.** `validateOrigin(origin, host, boundHost, boundPort)` computes `expectedAuthority = ${boundHost}:${boundPort}`. For a concrete IP bind this is correct (the browser's `Host` equals that IP) and it fully pins the authority, so DNS-rebinding is blocked. For a wildcard bind (`0.0.0.0`/`::`) the reachable host is `localhost`/LAN-IP, never `0.0.0.0`, so an unmodified gate 403s everything → exposed mode ships broken. The wildcard branch relaxes the pinned *hostname* to a port-match plus an `Origin`==`Host` same-origin check. **Correction (review 2026-07-06):** this degraded gate blocks *plain* cross-origin (`Origin` ≠ `Host`, e.g. a page at evil.com fetching the LAN IP) but does NOT stop a true DNS-rebind — there the attacker controls both headers so `Origin == Host == attacker-authority` and the check passes. In wildcard/exposed mode the **session token is the sole real boundary** (AD-12: the token, not loopback, is the auth boundary); the user opted into exposure with a loud warning. Do not document or rely on the wildcard gate as rebinding protection. Parse the `Host` port as the segment after the LAST colon so bracketed IPv6 (`[::1]:<port>`) authorities parse correctly.
  ```ts
  // in validateOrigin, before the exact-authority path:
  if (isWildcardHost(boundHost)) {
    if (typeof hostHeader !== "string") return false;
    const lastColon = hostHeader.lastIndexOf(":");
    const portStr = lastColon === -1 ? "" : hostHeader.slice(lastColon + 1);
    if (portStr !== String(boundPort)) return false;
    if (originHeader === null || originHeader === undefined || originHeader === "") return true;
    return originHeader === `http://${hostHeader}`; // same-origin sanity only; token is the boundary
  }
  ```
- **Exposure via boot global, not RPC.** Exposure is known at boot and static, so injecting `window.__QS_EXPOSURE__` alongside `window.__QS_TOKEN__` in `renderIndexHtml` lets the banner render on first paint (more "unmistakable" than an async-loaded bar) with zero new RPC surface. Serialize with `JSON.stringify` and the same `<`-escaping the token injection uses to avoid `</script>` breakout. Revert-step *copy* lives in the UI (composed from `host`), so the wire payload stays `{ exposed, host, port }`.
- **Loopback set.** `localhost`, `::1`, and all of `127.0.0.0/8` (a validated dotted-quad match — NOT a bare `127.` prefix, so `127.evil.com` is treated as exposed) are loopback → no warning. Everything else, including `0.0.0.0`/`::`, is exposed.

## Verification

**Commands:**
- `bun x tsc --noEmit` -- expected: clean under strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
- `bun test` -- expected: new binding + extended auth/server tests pass alongside the existing suite (0 fail); importing `startCore`/`dispatch` never exits the runner

**Manual checks:**
- `bun run bin/quick-studio.ts` (no `QS_HOST`): stderr shows only "listening on `http://127.0.0.1:<port>`", no exposure warning; open the URL → no UI banner.
- `QS_HOST=0.0.0.0 bun run bin/quick-studio.ts`: stderr shows the loud multi-line Port-Exposure Warning with revert steps; open `http://localhost:<port>` (or the LAN IP) → prominent warning banner is visible and RPCs (health/stop) work; the app is not 403-dead.
- Confirm a cross-origin `fetch` (forged `Origin`) against the exposed instance is rejected `403 forbidden_origin`.

## Auto Run Result

Status: done

### Summary
Added a `QS_HOST` bind override (default loopback `127.0.0.1`) resolved through a new pure, unit-tested `src/core/binding.ts` (`resolveBindHost`/`isLoopbackHost`/`isWildcardHost`/`isExposed`). `startCore` threads the resolved host into `Bun.serve`, computes `exposed = isExposed(host)`, exposes it on the `Core` handle, and injects a boot-time `window.__QS_EXPOSURE__` global (next to the token, via a `<script>`-safe `scriptJson`). On exposure the Port-Exposure Warning fires on both surfaces: a loud multi-line stderr banner in `bin/quick-studio.ts` and a prominent in-UI banner in `Workspace.tsx` (threaded from `App.tsx`), each naming the risk and the exact revert steps. The DNS-rebinding gate is preserved for concrete binds (authority still pinned) and, for wildcard binds where the authority is unknowable, degraded to a port-match + `Origin==Host` same-origin check — with the honest position that in exposed mode the **session token is the sole boundary** (AD-12). Default (loopback) behavior is byte-for-byte unchanged.

### Files changed
- `src/core/binding.ts` (new) — pure host resolution + loopback/wildcard/exposed classification; `127.0.0.0/8` matched as a validated dotted quad.
- `src/shared/contract.ts` — added `ExposureInfo = { exposed, host, port }` (the boot-global payload).
- `src/core/auth.ts` — `validateOrigin` wildcard branch (port via `lastIndexOf(":")` for IPv6, `Origin==Host`); comment corrected to state the token is the boundary in wildcard mode.
- `src/core/server.ts` — `StartCoreOptions.host`, bind it, `Core.exposed`, `window.__QS_EXPOSURE__` injection; `scriptJson` escapes `<`/U+2028/U+2029; `renderIndexHtml` exported for unit testing.
- `bin/quick-studio.ts` — `resolveBindHost(process.env.QS_HOST)`, loud stderr Port-Exposure Warning on `core.exposed`.
- `src/ui/App.tsx` — typed/read `window.__QS_EXPOSURE__`, threads `exposure` to `Workspace`.
- `src/ui/workspace/Workspace.tsx` — prominent `ExposureBanner` under the header when exposed.
- Tests: `src/core/binding.test.ts` (new, incl. `127.`-lookalikes); `src/core/auth.test.ts` (wildcard cases: IPv6 accept, plain cross-origin reject, honest same-value-rebind, wrong/absent port/Host); `src/core/server.test.ts` (default-boot `exposed:false` + `renderIndexHtml` injection/`</script>`-escape units, no real wildcard listener).

### Review findings breakdown
- Patches applied: 5 (3 medium, 2 low) — see Review Triage Log 2026-07-06. Medium: corrected an over-claimed DNS-rebinding guarantee (docs/tests; no real vuln, token blocks); `isLoopbackHost` dotted-quad validation (was a `127.` prefix that suppressed the warning for `127.evil.com`); IPv6 wildcard port parse (`[::1]:<port>` was 403-ing). Low: `scriptJson` U+2028/U+2029 escaping for the arbitrary `host`; removed a real `0.0.0.0` LAN-reachable test listener.
- Deferred: 0.
- Rejected: 7 (by-design / noise / already-tracked) — see triage log.
- intent_gap: 0, bad_spec: 0 (`review_loop_iteration` stayed 0; the intent contract's security invariant — reject `Origin != Host` — was upheld, so no loopback).

### Verification performed
- `bun x tsc --noEmit` → clean under strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- `bun test` → 91 pass / 0 fail (204 expect calls) across 7 files (~7.3s; down from ~14.7s after dropping the second real boot).
- Manual reasoning per the I/O matrix; the wildcard exposure path is covered by unit tests (classification, gate behavior, injection) rather than an actual off-machine bind.

### Residual risks
- **Concrete IPv6 binds** (`QS_HOST=fe80::1`): the non-wildcard authority is built unbracketed (`${host}:${port}`) while a browser sends `[fe80::1]:port`, so RPC would 403. Niche and outside the IPv4-centric AC matrix; the wildcard IPv6 path (`::`) is fixed. Left as a known limitation, not implemented.
- **Follow-up review recommended (`true`):** the medium fixes reframed a security-gate guarantee and its tests; an independent pass over `auth.ts`/`binding.ts` is worthwhile.
- The Port-Exposure Warning names the bound host (`0.0.0.0`) rather than enumerating live interface IPs; truthful and actionable via the revert steps, but a future enhancement could list the reachable addresses.

## Auto Run Result — Follow-up review pass (2026-07-06)

Status: done

### Summary
Fresh independent review pass over the story-1.6 diff (baseline `c610ffa`) via two adversarial reviewers (Blind Hunter + Edge Case Hunter). Both independently converged on the same functional defect: **host case-normalization**. `resolveBindHost` trimmed but did not lower-case, while classification (`isLoopbackHost`/`isWildcardHost`) is case-insensitive — so `QS_HOST=LocalHost` classified loopback (correctly suppressing the warning) yet bound the verbatim host, making `validateOrigin`'s `${boundHost}:${port}` authority match fail against the browser's lower-cased `Host` and 403 every RPC. Fixed at the single source of truth (`resolveBindHost` now lower-cases), and routed `startCore`'s default through `resolveBindHost` so `bin/`, `startCore`, classification, and the authority match all share one normalized path (this also removed the duplicated `server.ts` `DEFAULT_HOST`).

### Files changed (this pass)
- `src/core/binding.ts` — `resolveBindHost` now lower-cases the trimmed host (docstring updated to explain the classification/authority consistency requirement).
- `src/core/server.ts` — `startCore` uses `resolveBindHost(options.host)` instead of `options.host ?? DEFAULT_HOST`; removed the duplicated `DEFAULT_HOST` const; imports `resolveBindHost`.
- `src/core/binding.test.ts` — added `resolveBindHost` lower-casing cases (`LocalHost`/`  LOCALHOST  ` → `localhost`; `::1` preserved).

### Review findings breakdown
- Patches applied: 3 (1 medium, 2 low) — see Review Triage Log "Follow-up review pass". Medium: case-normalization 403 (above). Low: `startCore` bypassed normalization (padded/mixed-case host from direct callers); duplicated `DEFAULT_HOST`. All three closed by one coherent single-normalization-path change.
- Deferred: 1 — wildcard `core.url` (`http://0.0.0.0:<port>`) is a non-routable sentinel; story 1.2 browser-open must substitute `http://localhost:<port>` (new `deferred-work.md` entry).
- Rejected: 8 (noise / by-design / already-tracked) — notably the scheme-default-port (80/443) `Host`-match 403, which is **already tracked in `deferred-work.md` from 1.1** and was not re-filed. See triage log for the full list.
- intent_gap: 0, bad_spec: 0 (`review_loop_iteration` stayed 0; the fix is a normalization patch, no intent contract or spec-section change).

### Verification performed (this pass)
- `bun x tsc --noEmit` → clean under strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- `bun test` → 92 pass / 0 fail (207 expect calls) across 7 files (~6.8s) — up from 91 with the new case-normalization test.

### Residual risks (this pass)
- Concrete IPv6 binds (`QS_HOST=fe80::1`) still 403 (unbracketed authority vs bracketed browser `Host`) — unchanged known limitation, outside the IPv4-centric AC matrix.
- Scheme-default-port (80/443) `Host` mismatch remains deferred (from 1.1) and now reachable via `QS_PORT=80` in exposed mode; still latent for the default (ephemeral) port and left to the tracked 1.2 follow-up.
- `followup_review_recommended` set to `false`: this pass's fixes are localized to host resolution (one medium + two low), fully covered by a new unit test, with no change to the auth gate's security semantics — no further independent pass warranted.
