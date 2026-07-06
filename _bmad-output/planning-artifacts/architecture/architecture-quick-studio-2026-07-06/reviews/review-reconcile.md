# Reconciliation Review — ARCHITECTURE-SPINE vs PRD

- **Spine:** `architecture-quick-studio-2026-07-06/ARCHITECTURE-SPINE.md`
- **PRD:** `prd-quick-studio-2026-07-06/prd.md`
- **Reviewer role:** reconciliation — report only what did not land.
- **Date:** 2026-07-06

## Verdict

**GAPS FOUND (low severity).** Every PRD feature group and every FR (FR-1..FR-24) has a home in the Capability→Architecture map, and all three architecture-gating items are resolved. No contradictions with PRD-confirmed assumptions. The gaps are at the NFR/constraint/aesthetic layer, not the FR layer: **NFR-1 (idle footprint)** and **R6 (user-funded AI)** are bound in the frontmatter but have no AD, convention, capability-map row, or Deferred entry that actually addresses them; **dark-first** was dropped; and the PRD's "perf budgets = acceptance criteria" stance was deferred to code rather than set.

---

## 1. FR coverage (§4, FR-1..FR-24)

Every FR appears in the Capability→Architecture map. None falls through silently. Detail:

| FR | Covered by | Status |
| --- | --- | --- |
| FR-1 one-command install | Cap-map (distribution Deferred) + Stack `bun build --compile` (single binary) | Covered. Packaging answer is implicit in `bun build --compile`; per-platform *delivery* (Open Q4) explicitly Deferred. |
| FR-2 one-command run + mode | AD-8, cap-map, Config convention | Covered |
| FR-3 clean shutdown | AD-8 ("no daemon outlives the process"), cap-map NFR-3 | Covered |
| FR-4 encrypted store | AD-2, AD-5 | Covered |
| FR-5 keychain fallback | AD-5 (passphrase fallback) | Covered |
| FR-6 manage connections | AD-2, AD-5 | Covered |
| FR-7 connect PG/MySQL | AD-2, Stack (postgres.js, mysql2) | Covered |
| FR-8 browse/edit data | AD-2, AD-4 | Covered (row-delete confirm via AD-4) |
| FR-9 create tables | AD-2, AD-4 | Covered |
| FR-10 inspect indexes | AD-2 | Covered |
| FR-11 ad-hoc SQL | AD-2, AD-4 | Covered |
| FR-12 render ERD | Cap-map (ui/) | Covered; 60–70-table responsiveness → Deferred (data-volume ceilings) |
| FR-13 persist ERD layout | AD-8 (persist only in Persistent) | Covered |
| FR-14 configure providers | AD-2, AD-5 | Covered |
| FR-15 NL→query + exec | AD-2, AD-4, AD-7 | Covered |
| FR-16 streaming + reasoning | AD-11 | Covered |
| FR-17 rich MDX | AD-3, AD-7, AD-10 | Covered (sandbox) |
| FR-18 build report | AD-10, cap-map | Covered |
| FR-19 test→prod targeting | AD-9 | Covered |
| FR-20 export Snapshot/Live | AD-9 | Covered |
| FR-21 localhost binding | AD-6 | Covered |
| FR-22 port-exposure warning | AD-6 | Covered |
| FR-23 Tabs | Cap-map (ui/), State convention | Covered |
| FR-24 resizable Panels | Cap-map, State convention (persist in Persistent) | Covered |

**FR-layer conclusion:** no FR fell through. Good.

---

## 2. NFR coverage (§10, NFR-1..NFR-6)

| NFR | Covered by | Status |
| --- | --- | --- |
| NFR-1 idle footprint | Only the "footprint is the identity" logging convention — **no AD, no cap-map row, no Deferred entry, no budget** | **GAP.** PRD §10 + Assumptions Index explicitly assign "idle RAM budget to set at architecture." The spine neither sets it nor lists it under Deferred. It is thematically present but structurally unassigned. |
| NFR-2 startup ≤2s | Cap-map (NFR-2/3) | Referenced, but the ≤2s number is not carried — deferred to code alongside other perf numbers |
| NFR-3 shutdown | Cap-map + AD-8 | Covered |
| NFR-4 interaction latency | Deferred (data-volume ceilings, "against NFR-4/5") | Referenced; concrete <100ms number deferred to code |
| NFR-5 large results | Wire-formats + State conventions (pagination/virtualization) + Deferred | Covered |
| NFR-6 streaming smoothness | AD-11 | Covered |

**NFR note — perf-as-acceptance-criteria tension.** PRD §10 states budgets "should be treated as acceptance criteria, not aspirations," and the Assumptions Index routes the idle-RAM budget and ≤2s startup to *architecture*. The spine instead pushes all concrete numbers to "owned by the code" (Deferred: data-volume ceilings). This is defensible at spine altitude but is a soft divergence from the PRD's explicit instruction to set them here — worth surfacing to the builder rather than letting it pass silently.

---

## 3. Constraint coverage (§11, R1..R6)

| R | Covered by | Status |
| --- | --- | --- |
| R1 executable-JS sandbox | AD-3 | **Resolved** (see §5) |
| R2 credential store model | AD-5 | Covered (AES-256-GCM, keychain, passphrase fallback, never plaintext) |
| R3 network exposure | AD-6 | Covered |
| R4 destructive-statement guardrail | AD-4 | Covered |
| R5 local-first privacy | AD-7 | Covered (schema-only default, per-query row opt-in) |
| R6 user-funded AI / no backend account / no hosted cost | frontmatter `binds` claims R6, but **no AD, no convention, no cap-map row, no Deferred entry** names it | **GAP (weak).** Architecturally implied by the paradigm (Auth convention = "none," provider keys are user-supplied via AD-5/FR-14, only outbound edge is the user's Provider), but never explicitly reconciled. The "no hosted/inference cost, no backend account" promise is asserted nowhere as an invariant. |

---

## 4. Quiet / non-functional requirements the AD structure may have dropped

- **"Lightweight/fast is the IDENTITY" tone** — *Partially retained.* Present in the scope line ("lightweight local-first DB manager") and the "footprint is the identity" logging convention. But no AD elevates performance to an invariant, and the concrete budgets are deferred (see §2). The security model is the spine's spine; the performance identity rides along thinly. Not lost, but under-weighted relative to how load-bearing the PRD makes it.
- **SM-C1 intentional-leanness / "more features is NOT the goal"** — *Retained indirectly.* The Deferred section and the "kept intentionally lean" framing carry the stance; it is not stated as an explicit counter-invariant, which is acceptable at spine altitude.
- **shadcn dark-first aesthetic** — **DROPPED.** The spine references React/shadcn and shadcn charts but says nothing about **dark-first**, which the PRD calls out in both §12 and the §9 Assumptions Index. Minor and arguably below spine altitude, but it is a named PRD assumption with zero echo in the spine.
- **"No data leaves the machine" privacy promise** — *Strongly retained.* AD-7, R5 mapping, and the "only outbound edge" framing in the structural seed. Best-covered of the quiet requirements.
- **Portfolio-grade / open-source door** — **Dropped from the spine.** Not mentioned. The clean ring/`shared/` structure supports open-sourcing, but the framing is absent. Below spine altitude; noted for completeness, not a defect.

---

## 5. The three architecture-gating items

1. **§11-R1 — executable-JS sandbox.** **RESOLVED.** AD-3 defines the mechanism concretely: cross-origin iframe, `sandbox="allow-scripts"` **without** `allow-same-origin`, CSP `default-src 'none'` + `connect-src 'none'`, `postMessage` RPC as the only channel, receives frozen data, render-only, and explicitly refuses in-process isolation (SES/QuickJS/ShadowRealm) as the trust boundary. This is the strongest of the three resolutions.
2. **Open Q1 — charting fit (TradingView).** **RESOLVED.** AD-10 splits charting by ring: Recharts/shadcn charts in-app (Ring 2), Observable Plot in the React-less sandbox (Ring 3), and explicitly rejects TradingView lightweight-charts as wrong-fit for generic DB data — exactly the direction the PRD open question suspected.
3. **Open Q3 — Live Report data path.** **RESOLVED at decision altitude.** AD-9 makes the architectural call: a Live Report carries no credential and no DB runtime; it re-queries only by targeting a running quick-studio Core on `127.0.0.1`, which supplies a viewer-supplied connection; re-targeting re-runs queries without rebuilding layout. *Softest of the three:* the low-level mechanism for how an exported HTML file (opened from `file://` or elsewhere) actually reaches and is allowed to call `127.0.0.1` (fetch/CORS, and what "authenticates" means when the Core has no auth) is left to code. The PRD's Open Q3 asked specifically "how a Live Report authenticates and reaches that target when viewed *outside* quick-studio" — the *policy* is answered (only via a running local Core, viewer supplies the connection), the *transport/CORS* detail is deferred. Acceptable at spine altitude; flagged so it is not mistaken for fully specified.

**All three gating items are resolved.**

---

## 6. Contradictions with PRD-confirmed assumptions

None found. The spine is consistent with every assumption the PRD marked confirmed in §9:

- **Platforms Windows + Linux** — spine scope and Deferred (macOS out) agree.
- **ERD fluid to 60–70 tables** — spine Deferred names "fluid target 60–70 tables," matching PRD FR-12.
- **Live Reports use a viewer-supplied connection** — AD-9 states "viewer-supplied, per the PRD," matching FR-20.
- **Ephemeral writes nothing to disk** — AD-8 matches FR-2/§3.
- **Row deletes require confirmation** — AD-4 matches FR-8/FR-11/FR-15.

The one place the spine *changes* a PRD position is charting (drops TradingView), but that resolves an open question in the direction the PRD anticipated — a resolution, not a contradiction.

---

## 7. Summary of findings (severity-ranked)

| # | Finding | Id | Severity |
| --- | --- | --- | --- |
| 1 | Idle-footprint budget unassigned — no AD/convention/cap-map/Deferred home; PRD routed the RAM budget to architecture, spine deferred all perf numbers to code | NFR-1 | Medium |
| 2 | User-funded-AI / no-backend-account promise bound in frontmatter but never addressed by any AD, convention, or Deferred entry | R6 | Low–Medium |
| 3 | Dark-first aesthetic (PRD §12 + §9 Assumptions Index) dropped from the spine entirely | §12 aesthetic | Low |
| 4 | Perf budgets that PRD calls "acceptance criteria, to set at architecture" (idle RAM, ≤2s startup, <100ms latency) deferred to code rather than set | NFR-1/2/4 | Low |
| 5 | Live Report transport/CORS/auth mechanism (`file://`→`127.0.0.1`) left to code; policy resolved, mechanism not | FR-20 / Open Q3 | Low (informational) |

No FR-level gaps. No contradictions. All three gating items resolved.
