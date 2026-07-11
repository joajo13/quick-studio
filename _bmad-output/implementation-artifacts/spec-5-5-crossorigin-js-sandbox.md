---
title: 'Cross-origin executable-JS sandbox with adversarial containment'
type: 'feature'
created: '2026-07-11'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'bd824f06963457aba0c8047669dd1a03a6450b8b'
final_revision: 'dc6423bd1bad06bdb3a5137daabda02419b86c1d'
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Epic 5's marquee capability — rendering LLM-authored executable JS (charts, MDX) inside the chat — is the single highest-risk feature in v1 (R1, AR-4, FR-17). It cannot ship until there is a boundary that guarantees that untrusted, model-generated code can reach the host, filesystem, network, Core backend, provider keys, session token, or database through **no** path at all. Story 5.6 (rich MDX) is hard-gated on this; so is Epic 6.

**Approach:** Stand up Ring 3 — a quarantined cross-origin iframe. The Core serves a guest document from a **second `Bun.serve` on a distinct loopback port** (a separate origin) under CSP `default-src 'none'; connect-src 'none'`; Ring 2 embeds it with `sandbox="allow-scripts"` and **without** `allow-same-origin`. A typed, one-way `postMessage` protocol lives in `src/shared/`: Ring 2 pushes already-frozen `FrozenData` in; the guest emits out only render-lifecycle/interaction signals (`ready`, `height`, `datum-clicked`, `error`) and has no expressible way to request data or trigger a query. The guest renders a minimal deterministic draw of the frozen data (proof the full data-in → draw → signals-out loop closes); real MDX/chart rendering slots into that render step in 5.6. Ships **with** an adversarial containment battery.

## Boundaries & Constraints

**Always:**
- The guest is served from a **separate origin** — a second `Bun.serve` on a distinct loopback port, bound to the same host as Core, torn down by Core's `stop()`.
- The iframe carries `sandbox="allow-scripts"` and **nothing else** — no `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-top-navigation`, or `allow-modals`.
- The guest document is served with CSP `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'` and `x-content-type-options: nosniff`.
- The sandbox origin serves **only** the guest HTML + its own JS bundle. It exposes no `/rpc`, no `/chat/stream`, no session token, no credentials — everything else is 404.
- `postMessage` is one-way for data: Ring 2 → guest carries only canonical `FrozenData` from `src/shared/`; guest → Ring 2 carries only the `SandboxOutbound` signal union.
- The host accepts inbound guest messages only when `event.source` is the exact iframe window (identity check); the guest pins the parent origin from the first handshake and rejects any other origin/source.
- `src/sandbox/` imports **only** `src/shared/` — never `src/core`, `src/ui`, `ai`/`@ai-sdk/*`, or anything holding secrets.
- The protocol union is versioned (`SANDBOX_PROTOCOL_VERSION`), types-only + pure runtime guards, in dependency-free `src/shared/`.

**Block If:**
- The separate origin cannot be provided without exposing the sandbox server beyond loopback / onto the network (widening the exposure model is a human security decision).
- Satisfying the boundary would require pushing anything other than already-public frozen data into the guest (a key, token, live DB handle, or a capability) — never do this unattended.

**Never:**
- Never use in-process isolation (SES / QuickJS / ShadowRealm / `iframe` *with* `allow-same-origin`) as the boundary — the cross-origin iframe IS the boundary.
- Never give the guest the session token, provider keys, live `Date` objects, or any inbound message type that can request data or trigger a query.
- Never let the guest reach `/rpc`, `/chat/stream`, the provider, the DB, the filesystem, or the network.
- Do **not** implement MDX or Observable Plot / chart rendering here — that is Story 5.6. 5.5 renders only a minimal deterministic draw as proof-of-loop.
- Never post data to the guest with a secret payload, and never respond to a guest message with data (data push is caller-initiated only).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Push frozen data | valid `FrozenData` via host `pushData` | guest receives `render` frame, draws it, emits `ready` then `height` | No error expected |
| Interaction out | user clicks a rendered cell | guest emits `datum-clicked{row,col}`; host forwards to `onSignal` | No error expected |
| Inward capability attempt | guest receives `{type:"run-query"}` / `{type:"data-request"}` / unknown tag | router drops it; no outbound emitted; union cannot express a data reply | Silently dropped |
| Wrong-origin inbound | message to guest from origin ≠ pinned parent, or before handshake | dropped | Dropped, no signal |
| Spoofed host inbound | host receives message where `event.source !== iframe window` | dropped; host never returns data | Dropped |
| Egress attempt (server) | GET/POST `/rpc`, `/chat/stream`, or token on the sandbox origin | 404; no dispatch, no token in any response | 404 |
| Guest doc fetch | GET `/` on sandbox origin | 200 guest HTML with the required CSP + nosniff, no token | No error expected |
| Malformed frame | inbound fails `isSandboxInbound` / `isSandboxOutbound` guard | dropped | Dropped |

</intent-contract>

## Code Map

- `src/shared/contract.ts` (+ `.test.ts`) -- add `SANDBOX_PROTOCOL_VERSION`, the one-way `SandboxInbound` (`render{protocolVersion,data:FrozenData}`) and `SandboxOutbound` (`ready` | `height{px}` | `datum-clicked{row,col}` | `error{message}`) unions (tag `type`, all `readonly`, matching `ChatStreamChunk` house style), and pure runtime guards `isSandboxInbound`/`isSandboxOutbound` (validate tag + version; delegate `FrozenData` validity to the existing `decode`). Types-only + pure; dependency-free.
- `src/sandbox/guest.ts` (NEW, + `.test.ts`) -- Ring 3 runtime. Pure, injectable core: `createGuestRouter({postToParent, render})` returns a `handleMessage(event)` that handshake-pins the parent origin, guards inbound, calls `render`, and emits `ready`/`height`/`datum-clicked`/`error` via `postToParent`; `buildFrozenHtml(data): string` (pure minimal-draw string with `data-row`/`data-col` cells); `resolveDatumClick(el): {row,col}|null` (pure). A thin bootstrap installs the real `message` listener, writes the HTML into `document.body`, measures `scrollHeight`, and posts back to the pinned parent — the only DOM-touching seam.
- `src/core/sandbox-server.ts` (NEW, + `.test.ts`) -- `startSandboxServer({host, port=0, bundle})`: a second `Bun.serve` returning `{port, origin, stop}`. Pure `sandboxCspHeaders()` and `renderGuestHtml()` builders. Serves `GET /` (guest HTML) and `GET /guest.js` (the injected `bundle`, default = generated module); everything else 404. No token, no `/rpc`, no `/chat/stream`.
- `scripts/build-sandbox.ts` (NEW) -- `Bun.build` over `src/sandbox/guest.ts` (`target:"browser"`) → `src/core/sandbox-bundle.generated.ts` (`export const sandboxBundle = {js}`, git-ignored), mirroring `scripts/build-ui.ts`. `scripts/build-ui.ts` also invokes it (or `package.json` `build` runs both) so one `bun run build` produces both bundles.
- `src/core/server.ts` (EDIT) -- `startCore` also starts the sandbox server (ephemeral loopback port on the same host), exposes `sandboxOrigin` on the returned `Core`, threads it into `renderIndexHtml` as an injected `window.__QS_SANDBOX_ORIGIN__` (hex/URL-sanitized like the token); `stop()` also stops the sandbox server.
- `src/ui/sandbox/sandbox-host.ts` (NEW, + `.test.ts`) -- Ring 2 pure host controller: `createSandboxHost({iframeWindow, onSignal})` → `{pushData(frozenData), handleMessage(event), dispose()}`. `handleMessage` accepts only `event.source === iframeWindow` + opaque origin + `isSandboxOutbound`, routes signals to `onSignal`; `pushData` posts a `render` frame to `iframeWindow` (see Design Notes on `targetOrigin`). `buildSandboxIframeAttrs(sandboxOrigin): {src, sandbox:"allow-scripts"}` pure builder. No `ai`/`@ai-sdk` import.
- `src/ui/sandbox/SandboxFrame.tsx` (NEW, + `.test.tsx`) -- thin React `<iframe>` from `buildSandboxIframeAttrs` reading `window.__QS_SANDBOX_ORIGIN__`; on mount wires `window.addEventListener("message", host.handleMessage)`, pushes `data` prop via `pushData` on ready/change, applies `height` signal, forwards `datum-clicked`; cleans up on unmount. Structure asserted via `renderToStaticMarkup` (`sandbox="allow-scripts"` present, `allow-same-origin` absent).
- `src/sandbox/containment.test.ts` (NEW) -- the explicit adversarial containment battery (below).

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` (+ `.test.ts`) -- add `SANDBOX_PROTOCOL_VERSION`, `SandboxInbound`/`SandboxOutbound` unions, `isSandboxInbound`/`isSandboxOutbound` guards; test each guard accepts valid frames and rejects wrong tag, wrong version, non-object, and (inbound) invalid `FrozenData`.
- [x] `src/sandbox/guest.ts` (+ `.test.ts`) -- pure `createGuestRouter`, `buildFrozenHtml`, `resolveDatumClick` + thin DOM bootstrap; unit-test (stub `postToParent`/`render`): handshake pins parent origin; valid `render` → `ready`+`height`; wrong-origin/pre-handshake message dropped; unknown/`run-query`/`data-request` inbound dropped with no outbound; `resolveDatumClick` maps a cell to `{row,col}` and returns null off-grid; `buildFrozenHtml` emits `data-row`/`data-col` cells for a `FrozenData` fixture.
- [x] `src/core/sandbox-server.ts` (+ `.test.ts`) -- second `Bun.serve` with injectable `bundle`; unit-test against a real ephemeral server (stub bundle): `GET /` returns the required CSP header + nosniff + guest HTML with no token; `GET /guest.js` returns the bundle as JS; `POST /rpc`, `GET /chat/stream`, and any other path → 404; `stop()` frees the port.
- [x] `scripts/build-sandbox.ts` (NEW) + `scripts/build-ui.ts` (EDIT) -- build the guest bundle into `src/core/sandbox-bundle.generated.ts`; wire it so `bun run build` produces both bundles.
- [x] `src/core/server.ts` (EDIT) -- start/stop the sandbox server inside `startCore`/`stop`; expose `sandboxOrigin`; inject `window.__QS_SANDBOX_ORIGIN__` via `renderIndexHtml`; update/extend the server test for the new injection and teardown of both servers.
- [x] `src/ui/sandbox/sandbox-host.ts` (+ `.test.ts`) -- pure `createSandboxHost` + `buildSandboxIframeAttrs`; unit-test (stub `iframeWindow`/`onSignal`): `pushData` posts a `render` frame to the iframe window; a valid `SandboxOutbound` from the iframe source routes to `onSignal`; a message from a foreign `event.source` is dropped; `buildSandboxIframeAttrs` yields `allow-scripts` and never `allow-same-origin`.
- [x] `src/ui/sandbox/SandboxFrame.tsx` (+ `.test.tsx`) -- iframe component wiring host controller + `data` prop push + height/click forwarding + unmount cleanup; assert markup via `renderToStaticMarkup` (sandbox attr present, `allow-same-origin` absent, `src` = injected origin).
- [x] `src/sandbox/containment.test.ts` (NEW) -- adversarial battery: (a) real sandbox server → CSP `default-src 'none'`/`connect-src 'none'` present, `/rpc` & `/chat/stream` → 404, no token in guest doc; (b) iframe attrs exclude `allow-same-origin`; (c) guest router drops wrong-origin + `run-query`/`data-request`/unknown inbound and emits no data; (d) host router drops non-iframe-source messages and has no data-reply path; (e) type-level `never` assertion that `SandboxOutbound` cannot carry `FrozenData` or a query.

**Acceptance Criteria:**
- Given the sandbox iframe, when it is served, then it comes from a separate origin with `sandbox="allow-scripts"` and without `allow-same-origin`, under CSP `default-src 'none'` and `connect-src 'none'` — verified by the containment battery against a live sandbox `Bun.serve` and the iframe-attr builder.
- Given the `postMessage` channel, when data crosses it, then Ring 2 pushes frozen data in and the guest emits out only `ready`/`height`/`datum-clicked`/`error`; no inbound message type lets the guest request data or trigger a query, and the host never returns data in response to a guest message.
- Given adversarial guest code, when the sandbox ships, then the battery proves containment: cross-origin escape (no `allow-same-origin`, opaque-origin identity checks), `connect-src` egress (CSP + sandbox-origin serves no data endpoints, `/rpc`→404), and inward data/query-request attempts (router drops them; the outbound union structurally cannot express them) all fail.
- Given ring isolation, when the build runs, then `src/sandbox/` imports only `src/shared/` (grep-verified: no `src/core`, `src/ui`, `ai`, `@ai-sdk`, credential/token imports), and `bunx tsc --noEmit` and `bun test` pass.

## Spec Change Log

_No bad_spec loopbacks — the intent contract and spec sections held through review. All review findings triaged to patch._

## Review Triage Log

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 4, low 7)
- defer: 0
- reject: 1
- addressed_findings:
  - `[medium]` `[patch]` Sandbox `origin` was built from the raw `bindHost`, so `QS_HOST=0.0.0.0` produced a non-navigable `http://0.0.0.0:<port>` iframe `src` and IPv6 binds (`::1`/`::`) produced unbracketed malformed URLs — the sandbox iframe would never load in exposed/IPv6 mode. Now derives the origin string via the existing `deriveOpenUrl` (wildcard→loopback + IPv6 bracketing); the server still binds the raw host. (`src/core/sandbox-server.ts`) + wildcard/IPv6 tests.
  - `[medium]` `[patch]` An empty/invalid resolved sandbox origin yielded iframe `src=""`, which resolves to the parent Core document and would load the token-bearing page into the `allow-scripts` frame. `buildSandboxIframeAttrs` now falls back to `about:blank` (never `""`) for any non-`http(s)` origin. (`src/ui/sandbox/sandbox-host.ts`) + tests.
  - `[medium]` `[patch]` `SandboxFrame` recreated the host + `message` listener on every parent-callback identity change, and the data-push effect didn't track the host, so a recreated host could miss the current data (plus a brief listener gap). Host + listener now built once per iframe; `onDatumClicked`/`onError` read via refs from a stable `onSignal`. (`src/ui/sandbox/SandboxFrame.tsx`)
  - `[medium]` `[patch]` `stop()` awaited the sandbox teardown before `server.stop()` with no `finally`, so a rejecting sandbox stop would leak the token-bearing Core port. Wrapped in `try/finally` so both servers always stop; added a DI seam + test injecting a throwing sandbox `stop`. (`src/core/server.ts`)
  - `[low]` `[patch]` Guest CSP omitted `frame-ancestors` (not back-filled by `default-src`); added `frame-ancestors 'self'`. (`src/core/sandbox-server.ts`)
  - `[low]` `[patch]` Guest handshake pinned on `event.origin` only ("first speaker"), not the actual parent window; now also requires `event.source === window.parent` (threaded as an injectable `isParentSource` predicate to keep the router pure). (`src/sandbox/guest.ts`)
  - `[low]` `[patch]` `isSandboxOutbound` accepted negative/huge `datum-clicked` `row`/`col`; now requires `row >= 0 && col >= 0`. (`src/shared/contract.ts`)
  - `[low]` `[patch]` `isSandboxOutbound` accepted negative/non-finite `height.px` applied straight to the iframe; now requires `px >= 0` and the frame clamps to `MAX_FRAME_HEIGHT` (20000). (`src/shared/contract.ts`, `src/ui/sandbox/SandboxFrame.tsx`)
  - `[low]` `[patch]` `error.message` was unbounded untrusted guest text; guard now caps `length <= 1000` with an untrusted-text comment. (`src/shared/contract.ts`)
  - `[low]` `[patch]` `resolveDatumClick` used `Number(...)` coercion (`""`→0, `"0x1F"`→31), so a malformed `data-row`/`data-col` on a hostile guest's own DOM resolved to a bogus cell; now requires a strict `/^\d+$/` before parse. (`src/sandbox/guest.ts`)
  - `[low]` `[patch]` Host identity gate `event.source !== iframeWindow` passed when both were nullish (`null === null`); now also guards `iframeWindow != null`. (`src/ui/sandbox/sandbox-host.ts`)
- rejected (noise/by-design): guest renders the raw pushed `data` rather than the object `decode` returns — benign (decode is validation-only here; `buildFrozenHtml`'s `String()` collapses the only normalization, `-0`→`0`, anyway).
- security spine (re-confirmed by both reviewers): no path lets the guest reach the session token, network, or any secret; `allow-scripts` without `allow-same-origin`, separate origin, `connect-src 'none'`, one-way data, and a structurally data-free outbound union all hold — "capability never flows inward" is enforced structurally and at both gates.

### 2026-07-11 — Follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 1, medium 0, low 0)
- defer: 5
- reject: 15
- addressed_findings:
  - `[high]` `[patch]` The guest CSP carried `frame-ancestors 'self'`, but Core embeds the guest cross-origin (a second `Bun.serve` on a different loopback port). `'self'` is origin-exact, so a spec-compliant browser refuses to render the guest in the Core iframe — the entire Ring 2 → Ring 3 loop was silently broken, and the unit test asserting the CSP *string* passed green over the broken feature. Removed `frame-ancestors` (restoring the intent-contract CSP, which never included it — it was added by a prior review patch), updated the comment to explain the omission, and flipped the test to assert `frame-ancestors` is ABSENT. Clickjacking is a non-threat: the guest holds no token/authority/secret and only talks to its pinned parent. (`src/core/sandbox-server.ts`, `src/core/sandbox-server.test.ts`)
- deferred (new ledger entries, security/robustness — not trivially or safely auto-fixable, or reserved for a human/Story-5.6 decision):
  - Scripted same-frame navigation exfiltrates `FrozenData` past `connect-src 'none'` (the "already-public" framing is inaccurate — it's the user's private query output).
  - Exposed mode (`0.0.0.0`) LAN-exposes the sandbox server and injects a `127.0.0.1` origin unreachable for remote clients (intent-contract Block-If: human exposure decision).
  - Unbounded guest→host signal stream can render-thrash Ring 2.
  - `SandboxFrame` binds `contentWindow` once at mount; a null-at-mount window or a frame reload silently kills the channel.
  - `SandboxFrame` documents `data: null` as "empty guest" but a non-null→null transition never clears the prior draw.
- rejected (noise / by-design / can't-occur-with-internal-inputs): `pushData` `"*"` target (documented, opaque-origin-required); git-ignored generated bundle statically imported (established `ui-bundle.generated.ts` convention); `resolveDatumClick` three-way attribute handling (no 5.5 bug — cells always carry both attrs); `style-src 'unsafe-inline'` (explicit intent-contract choice); `renderIndexHtml` origin filter (server-derived input, no real failure); no browser-level test (spec-accepted residual, "do not add Playwright for this story"); coord upper-bounds (a hostile guest can already emit any valid coord; the 5.6 consumer must bounds-check); cyclic `parentElement` loop (impossible in a real DOM tree); scheme-only / opaque-parent origin and `server.port === 0` (can't arise from `deriveOpenUrl` / `Bun.serve`, which return a real origin/port or throw); `deriveOpenUrl` port-80 omission, hard-coded `"null"` gate, `img-src data:` (harmless/fail-closed).

## Design Notes

- **The `targetOrigin` nuance (get this wrong and containment leaks).** `sandbox="allow-scripts"` **without** `allow-same-origin` gives the guest document an **opaque** origin ("null"). So: (1) the host's push must use `iframeWindow.postMessage(frame, "*")` — targeting the serving origin is impossible against an opaque origin; `"*"` is safe here because delivery is still confined to that one iframe window and the payload is only already-public frozen data (never a secret). (2) The host must therefore validate **inbound** by window **identity** (`event.source === iframeWindow`), expecting `event.origin === "null"` — not by an origin string. (3) The guest learns the real parent origin from the first inbound message's `event.origin` (the parent is a normal origin), pins it, and posts back with that pinned `targetOrigin` — guest→parent signals ARE origin-pinned.
- **The boundary is the browser; the tests prove the configuration + the code-paths.** `bun test` has no DOM/browser runtime and the repo has no headless-browser harness, so the battery proves (a) the exact CSP/sandbox/route **configuration** is served and built, and (b) the message router/union have **no inward capability path** — the two things that are in-repo-verifiable. The browser's live enforcement of `sandbox`/CSP is covered by a documented manual check + noted as residual (same posture as 5.4's no-live-integration note). Do not add Playwright/puppeteer for this story.
- **House testing style (no DOM).** Keep all logic in pure, injectable functions (`createGuestRouter`, `createSandboxHost`, `build*`, guards) driven by stub `postMessage`/`window`; touch `document` only in a thin bootstrap seam; assert React structure with `react-dom/server` `renderToStaticMarkup`. Mirrors `ChatTabView.test.tsx` / `frozen-map.test.ts`.
- **Separate origin = second `Bun.serve`.** A subpath cannot be a distinct origin; a distinct **port** on the same loopback host is. Reuse the `renderIndexHtml`/header pattern. Wire the second server's `stop()` into Core's existing `stop()` teardown. Sandbox port is ephemeral (0) by default.
- **Minimal draw, real loop.** 5.5's guest renders `FrozenData` as a compact HTML table with clickable `data-row`/`data-col` cells — enough to exercise the full data-in → draw → `ready`/`height`/`datum-clicked` loop. 5.6 replaces `render` internals with MDX + Observable Plot; the channel and containment do not change. Do not add `@observablehq/plot` here.

## Verification

**Commands:**
- `bun test` -- expected: all suites pass, incl. new `contract` guard tests, `guest`, `sandbox-server`, `sandbox-host`, `SandboxFrame`, and `containment` battery.
- `bunx tsc --noEmit` -- expected: no type errors (incl. the `SandboxOutbound` `never` assertion).
- `bun run build` -- expected: produces both `ui-bundle.generated.ts` and `sandbox-bundle.generated.ts`.
- `grep -rEn 'from "(\.\./core|\.\./\.\./core|\.\./ui|ai|@ai-sdk/)' src/sandbox` -- expected: no matches (Ring 3 imports only `src/shared`).
- `grep -rn "allow-same-origin" src/ui src/sandbox` -- expected: matches only in negative test assertions, never in iframe construction.
- `grep -rn "connect-src 'none'" src/core/sandbox-server.ts` -- expected: present (egress-blocking CSP).

**Manual checks (browser-level enforcement, not CLI-testable):**
- Boot the app, mount a `SandboxFrame` with a `FrozenData` fixture: the iframe loads from the sandbox origin (distinct port), renders the table, reports its height, and a cell click surfaces as `datum-clicked` in Ring 2.
- In devtools, confirm the guest document's response carries the CSP header; a manual `fetch("http://<core-origin>/rpc")` from inside the guest console is blocked by `connect-src 'none'`, and the guest cannot read `parent.document` (cross-origin).

## Auto Run Result

Status: done

**Summary.** Ring 3 now exists: a quarantined cross-origin executable-JS sandbox. The Core stands up a **second `Bun.serve`** on a distinct loopback port (a separate origin) that serves only the guest document (under CSP `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'` + `nosniff`) and the guest JS bundle — everything else 404s, and it exposes no token, no `/rpc`, no `/chat/stream`. Ring 2 embeds it with `sandbox="allow-scripts"` and **without** `allow-same-origin`. A typed, versioned, one-way `postMessage` protocol lives in dependency-free `src/shared/`: Ring 2 pushes canonical `FrozenData` in (`render`); the guest emits out only `ready`/`height`/`datum-clicked`/`error` and has no expressible way to request data or trigger a query. The guest renders a minimal, HTML-escaped, clickable table of the frozen data (proof the data-in → draw → signals-out loop closes); real MDX/Observable-Plot rendering slots into that render step in Story 5.6. Ships with an adversarial containment battery.

**Files changed:**
- `src/shared/contract.ts` (+ test) -- `SANDBOX_PROTOCOL_VERSION`, `SandboxInbound`/`SandboxOutbound` unions (readonly, `type`-tagged), pure `isSandboxInbound`/`isSandboxOutbound` guards (delegate `FrozenData` validity to `decode`; bounded `row/col >= 0`, `px >= 0`, `message.length <= 1000`).
- `src/sandbox/guest.ts` (+ test) -- Ring 3 guest: pure `createGuestRouter` (parent-source + origin pinned handshake, inbound guard, render, signal emit), `buildFrozenHtml` (escaped, `data-row`/`data-col` cells), strict `resolveDatumClick`, DOM bootstrap seam. Imports only `src/shared/`.
- `src/sandbox/containment.test.ts` (NEW) -- adversarial battery (a–e): live-server CSP/route/no-token assertions, iframe attrs exclude `allow-same-origin`, guest drops wrong-origin/`run-query`/`data-request`/unknown inbound, host drops non-iframe-source messages, type-level `never` that outbound cannot carry data/query.
- `src/core/sandbox-server.ts` (+ test) -- second `Bun.serve`; pure `sandboxCspHeaders()`/`renderGuestHtml()`; navigable origin via `deriveOpenUrl`; injectable bundle.
- `scripts/build-sandbox.ts` (NEW) + `scripts/build-ui.ts`/`package.json` -- build the guest bundle → `src/core/sandbox-bundle.generated.ts`; `bun run build` produces both bundles.
- `src/core/server.ts` (+ test) -- starts/stops the sandbox server in `startCore`/`stop` (`try/finally` so both ports always close), exposes `Core.sandboxOrigin`, injects `window.__QS_SANDBOX_ORIGIN__`.
- `src/ui/sandbox/sandbox-host.ts` (+ test) -- pure `createSandboxHost` (identity+opaque-origin gated inbound, nullish-window guarded, one-way `pushData`) and `buildSandboxIframeAttrs` (`allow-scripts`, `about:blank` fallback, never `src=""`).
- `src/ui/sandbox/SandboxFrame.tsx` (+ test) -- iframe component: host built once per iframe (callbacks via refs), pushes `data`, clamps applied height, forwards signals, unmount cleanup.

**Review findings.** Two adversarial reviewers (Blind Hunter + Edge Case Hunter) at session capability. Both re-confirmed the security spine intact: no guest path to the token, network, or any secret; the cross-origin iframe + `connect-src 'none'` + one-way, structurally data-free channel enforce "capability never flows inward" structurally and at both gates. Triage: **0 intent_gap, 0 bad_spec, 11 patches applied** (4 medium: non-navigable sandbox origin under wildcard/IPv6, empty-origin `src=""` loading the token page, `SandboxFrame` host-recreation churn, `stop()` leaking the Core port on sandbox-teardown error; 7 low: `frame-ancestors`, guest parent-source handshake check, `datum-clicked`/`height`/`error` guard bounds, strict datum-attr parse, nullish-window host gate), **0 deferred**, 1 rejected (benign decode-vs-raw render).

**Verification.** `bunx tsc --noEmit` clean. `bun test` → **796 pass / 0 fail** across 48 files (a single transient failure in the pre-existing shutdown-macrotask timing test did not reproduce across repeated full runs — flaky, unrelated to this story). `bun run build` produces both bundles. `grep -rEn 'from "(\.\./core|\.\./\.\./core|\.\./ui|ai|@ai-sdk/)' src/sandbox` → empty (Ring 3 imports only `src/shared/`). `connect-src 'none'` and `frame-ancestors 'self'` present in the guest CSP; `about:blank` fallback present; no `allow-same-origin` in any iframe construction.

**Residual risks.** The browser's live enforcement of `sandbox`/CSP cannot be exercised in `bun test` (no DOM, no headless-browser harness); the battery proves the served configuration and the router/union code-paths (the in-repo-verifiable halves), with the browser-level enforcement covered by the documented manual devtools check — same posture as Story 5.4. The sandbox is not yet wired into any user-facing surface; Story 5.6 consumes it for rich MDX/chart rendering. A follow-up independent review is recommended given the breadth (contract + guest + host + server + component) and the four medium security-adjacent patches.

### Follow-up review (2026-07-11)

**Finding fixed (1 high patch).** An independent follow-up review caught that the guest CSP shipped `frame-ancestors 'self'` (added by the previous pass as a "low" patch) — a **feature-breaking** directive: because Core embeds the guest from a different loopback port (a different origin), origin-exact `frame-ancestors` makes a spec-compliant browser refuse to render the guest in the Core iframe, silently killing the whole Ring 2 → Ring 3 loop. The unit test asserting the CSP *string* passed green over the broken feature — exactly the class of bug the "config-string only, no browser harness" posture cannot see. Removed `frame-ancestors` (restoring the intent-contract CSP, which never included it), documented why it is omitted, and flipped the test to assert its absence. Clickjacking is a non-threat: the guest holds no token/authority/secret.

**Deferred (5 new ledger entries).** Real security/robustness items reserved for a human or Story-5.6 decision rather than an unattended patch: (1) scripted same-frame navigation exfiltrates `FrozenData` past `connect-src 'none'` (and the "already-public frozen data" comments understate the payload's sensitivity); (2) exposed mode LAN-exposes the sandbox server and injects a loopback origin unreachable for remote clients (intent-contract Block-If); (3) unbounded guest→host signal stream can render-thrash Ring 2; (4) `SandboxFrame` binds `contentWindow` once at mount (null-at-mount / reload silently kills the channel); (5) `data: null` doesn't clear the guest despite the documented "empty guest" contract. 15 findings rejected as noise / by-design / unreachable-with-internal-inputs.

**Verification.** `bunx tsc --noEmit` clean. `bun test` → **796 pass / 0 fail** across 48 files. Ring-isolation grep empty; `allow-same-origin` only in negative test assertions; `connect-src 'none'` present.

**Follow-up recommendation: false.** The only code change this pass is a single, mechanical, verified CSP-directive removal that restores the intent-contract CSP and adds no new attack surface — self-evidently correct and covered by the flipped test. The remaining findings were deferred (no new complex code to re-review). The standing browser-level residual (no headless harness) is unchanged and already documented above.
