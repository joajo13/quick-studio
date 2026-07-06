# Adversarial Architecture Review — quick-studio Spine

**Target:** `ARCHITECTURE-SPINE.md` (2026-07-06, draft)
**Method:** Adversary. For each finding I name two units one level down (two features / two devs) that each obey EVERY AD *to the letter*, yet still build something incompatible or insecure. Cosmetic nits are excluded.

**Verdict: HOLES FOUND.** Six seams, two of them security-critical. The spine's trust story is coherent as prose but leans on two words — "loopback" and "the postMessage RPC" — as if they were boundaries, when neither is enforced by any AD. The destructive-statement and privacy gates are each specified in the wrong ring to be enforceable.

---

## H1 — The Core authenticates no caller; loopback is treated as a trust boundary but is not one (CRITICAL)

**ADs in play:** AD-1 (ring boundary *is* the security model), AD-6 (bind 127.0.0.1 + exposure watcher), AD-9 (Live Report re-queries a running Core on 127.0.0.1), Conventions/Auth ("none — single operator on loopback; the ring boundary is the security model, not user accounts").

**The two units.**
- Unit A — **Core HTTP server** (dev builds per AD-6): binds `127.0.0.1`, runs the exposure watcher, exposes the query/RPC endpoints that Ring 2 calls. It authenticates nobody because "the ring boundary is the security model" and "single operator on loopback."
- Unit B — **Live Report viewer** (dev builds per AD-9): an exported HTML file that "re-queries only by targeting a running quick-studio Core on 127.0.0.1." This file is opened from `file://` or from wherever the operator saved it — a **foreign origin** hitting the Core's HTTP API directly, *bypassing Ring 2 entirely.*

**How both satisfy the ADs.** Unit A binds loopback (AD-6 ✓), has no auth (Auth convention ✓), trusts its caller because the caller is on 127.0.0.1 (AD-1 ✓). Unit B carries no credential and only targets a running Core on 127.0.0.1 (AD-9 ✓). Every rule is obeyed.

**How it breaks.** AD-1 defines Ring 2 by *origin* ("main browser origin"), but the Core never checks origin — it checks nothing. The moment AD-9 legitimizes a *second class of caller* (exported artifacts from arbitrary origins) hitting the Core, the "ring boundary = origin" model collapses, because the Core cannot tell Ring 2 from a Live Report from **any web page the operator happens to be visiting.** Browsers freely issue requests to `127.0.0.1` cross-origin; `<form>`/`fetch` POSTs and, fatally, **DNS rebinding** (which defeats any naive Host-header or Origin check) let a malicious site reach the Core and run SQL. Loopback binding stops *off-machine* attackers (AD-6's actual scope) but does nothing against a browser on the same machine executing a foreign page's JS. The whole trust model rests on "only Ring 2 can call the Core," and no AD enforces that.

**Fix — NEW AD-12 (Core authenticates every caller; loopback is not the boundary):** The Core mints a per-session capability token at boot, hands it to Ring 2 through the launch channel (not over an open HTTP endpoint), and **requires it on every RPC**; unauthenticated calls are rejected. The Core validates `Origin`/`Host` and pins an anti-DNS-rebinding check (reject Host values that aren't the exact bound loopback authority). A Live Report re-query is an *explicitly authorized* second caller: it must present a token the operator deliberately grants (paste/confirm in the running app), never an ambient one. State plainly: **loopback limits reachability, not authorization; the authorization boundary is the token, and it must exist because AD-9 opens the Core to non-Ring-2 callers.**

---

## H2 — "The postMessage RPC" launders an inward query path; AD-3's "cannot initiate a query" is unenforceable for any interactive MDX block

**ADs in play:** AD-1 (capability crosses only to the immediately-inner ring, via that boundary's channel), AD-3 (Sandbox is pure-render, receives already-frozen data, "cannot initiate a query," its only channel is "a `postMessage` RPC to Ring 2").

**The two units.**
- Unit A — **Static MDX chart block** (dev 1): renders a chart from the frozen data it was handed. Never talks back. Assumes the sandbox contract is a one-way data push.
- Unit B — **Interactive MDX block** (dev 2): a chart with a date-range dropdown or a "load more rows" control. On interaction it does exactly what AD-3 blesses — `postMessage`s a request to Ring 2: `{type:"needData", params}`. Ring 2 (which *may* request from Core) runs the query via Core, freezes the result, pushes it back.

**How both satisfy the ADs.** AD-3 says the sandbox's channel *is* an "RPC to Ring 2" — RPC means request/response, so Unit B is using the sanctioned channel. The sandbox never opened a connection, never ran SQL, never made a network call (AD-2/AD-3 ✓). It asked its immediately-inner ring, exactly as AD-1 permits. Ring 2 did the Core call. Letter-perfect.

**How it breaks.** AD-3's Rule also says the sandbox "cannot initiate a query." Unit B **initiates a query** — it just launders the initiation through a Ring-2 round-trip. "Receives already-frozen data" and "its channel is an RPC" are contradictory the instant a block needs *fresh* data: either the channel is one-way (then it's not an RPC and Unit B is illegal) or it's a request/response RPC (then Unit A and Unit B are building against two different contracts, and untrusted LLM-generated code can drive Core queries on a loop). No AD decides which. Two devs ship two incompatible sandbox contracts; worse, the permissive reading hands the *least-trusted* ring a pull on the *most-trusted* ring's executor.

**Fix — TIGHTEN AD-3:** State that the Sandbox channel is **one-way inbound data + outbound render-lifecycle/error signals only** — it is *not* a data-request RPC. Any "interactive" MDX re-query is owned by **Ring 2**: the control's parameters are surfaced to Ring 2, Ring 2 (not the sandbox) decides whether to re-query, subject to the same guard/privacy gates, and re-pushes frozen data. The sandbox may signal "user clicked X"; it may never name a query, table, or parameters that reach the executor unmediated. Enumerate the allowed outbound message types in `shared/` so Unit A and Unit B build the same contract.

---

## H3 — Destructive classification is split across two rings against two different lists, and the list itself omits UPDATE and multi-statement

**ADs in play:** AD-4 (single Core executor classifies each statement; DELETE, DROP, TRUNCATE, ALTER, row deletes never auto-run; require confirmation).

**The two units.**
- Unit A — **Chat confirm-dialog** (Ring 2, per "chat orchestration"): to show the user a "confirm destructive?" prompt *before* sending, it classifies the AI-proposed SQL client-side using AD-4's enumerated list.
- Unit B — **Core executor guard** (Ring 1, per AD-4): classifies at execution time using AD-4's enumerated list.

**How both satisfy the ADs.** Both implement AD-4's list verbatim: DELETE, DROP, TRUNCATE, ALTER, row deletes. Both obey.

**How it breaks — three ways, all inside the letter.**
1. **The list omits `UPDATE`.** `UPDATE accounts SET balance = 0` (no WHERE) is not DELETE/DROP/TRUNCATE/ALTER and is not a "row delete" — it is a mass mutation, and by AD-4's exact enumeration it **auto-runs.** Both units let it through. The single most common data-destroying statement isn't guarded. "row deletes" is listed; "row updates" is conspicuously not.
2. **Two classifiers drift.** Nothing says Ring 2's pre-classification and Core's guard share one implementation. The second Ring 2 forgets `ALTER`, or normalizes SQL differently, they disagree — and a user who sees "non-destructive" in the dialog gets a destructive run, or vice-versa. Two owners of one responsibility.
3. **Multi-statement.** AD-4 classifies "each statement," but `SELECT 1; DROP TABLE users;` is one string. postgres.js and mysql2 handle multi-statement execution differently; a classifier that inspects "the statement" (singular) can pass the benign head while the driver executes the whole batch. DROP auto-runs.

**Fix — TIGHTEN AD-4:** (a) The guard is **sole owner** of classification — Ring 2 may *display* the Core's verdict but must never be the gate; the confirmation requirement is enforced in Core, and Core returns the classification so the UI stays in sync from one source of truth. (b) Replace the closed enumeration with a **default-deny posture for mutations**: any statement that is not a pure read requires confirmation unless explicitly whitelisted; explicitly name `UPDATE` and row-level updates as destructive. (c) Require the executor to **reject or explicitly split multi-statement input** and classify every sub-statement; no batch runs on the strength of its first token.

---

## H4 — The AI privacy gate lives in the Core, but Ring 2 assembles the prompt and legitimately holds row data — so the gate is unenforceable

**ADs in play:** AD-7 (only outbound channel is the Provider; schema-only by default; rows only via explicit per-query visible opt-in), AD-2 (Core is sole holder of Provider keys and the proxy).

**The two units.**
- Unit A — **Result grid** (Ring 2): fetches and displays real rows. It *legitimately* holds row data — that's its job (FR-8..11).
- Unit B — **AI prompt builder** (Ring 2 chat orchestration): assembles the message array (system + user + context) and hands it to the Core provider proxy to forward.

**How both satisfy the ADs.** Core attaches schema-only context by default and forwards (AD-7 ✓). Core holds the key and is the sole outbound channel (AD-2 ✓). Neither unit "sends rows without opt-in" as a named action.

**How it breaks.** Row data can ride *inside the free-text prompt* that Unit B assembles from data Unit A already has ("here's what the table looks like: [pastes 20 rows]", or the user pastes a result they copied). To the Core proxy the prompt is an opaque string; it cannot distinguish schema from rows once Ring 2 has flattened everything into message text. AD-7's gate is specified as if the Core composes the outbound payload, but the ring model puts prompt assembly in Ring 2 — so **the gate is in the wrong ring to see what it's gating.** "The only outbound channel is the Provider" is true and useless here: the leak goes *through* that sanctioned channel, in-band. Two Ring-2 features, both compliant, jointly exfiltrate rows with no opt-in ever triggered.

**Fix — TIGHTEN AD-7 (+ ownership):** The privacy gate must sit where schema and rows are *structurally distinguishable*. Mandate that outbound AI context is assembled as **typed, Core-inspectable parts** (a schema part, an optional rows part), never as pre-flattened free text — the Core, not Ring 2, renders parts into the final prompt and is the single owner of the schema/rows boundary. Any rows part is refused unless the per-query opt-in flag is set and surfaced. Free-form user text is still allowed but must be tagged distinctly so the "no rows by default" guarantee is about *structured* data egress and the opt-in is enforced at the one point that can see the row part.

---

## H5 — "Frozen data" and "the postMessage payload" have no canonical shape; live-render and Snapshot-export diverge; wire date-format doesn't reach the sandbox

**ADs in play:** AD-3 (sandbox receives "already-frozen data"), AD-9 (Snapshot "embeds frozen data"), AD-10 (charts split by ring: Recharts in Ring 2 vs Observable Plot in Ring 3), Conventions/Wire-formats ("dates ISO-8601 UTC **on the wire**"; "every **Core RPC** reply..."). Conventions/Ring-naming (`shared/` "holds only types and the RPC contract").

**The two units.**
- Unit A — **Live sandbox render path**: UI freezes a query result and `postMessage`s it to the iframe for Observable Plot.
- Unit B — **Snapshot export path** (AD-9): UI freezes the same result and *embeds* it in the exported HTML, which bundles the same sandbox for offline render.

**How both satisfy the ADs.** Both say "frozen data." Both obey AD-3/AD-9.

**How it breaks.**
- **No pinned shape.** "Frozen data" is never defined: columnar vs row-oriented, where column types live, how NULL is encoded. The wire-format convention that pins ISO-8601 dates and the `code/message/detail` envelope is scoped to "**Core RPC** replies" — the **UI→Sandbox postMessage is not a Core RPC**, so *none* of it applies there. Unit A can hand the sandbox JS `Date` objects (structured-clone survives them) while Unit B, serializing into static HTML, emits ISO strings — Observable Plot code generated by the LLM then behaves differently live vs. exported. Same chart, two render results.
- **Two "frozen" formats.** Nothing forces Unit A's postMessage schema and Unit B's embed schema to be the same. A chart that renders live silently breaks in the Snapshot, or vice-versa. Two owners of one format.
- **Cross-ring type clash.** AD-10 splits chart *libraries* by ring but says nothing about the *data* both consume; Recharts (Ring 2 preview) and Observable Plot (Ring 3 render) can be fed differently-shaped frozen data for the same result.

**Fix — NEW AD (Canonical frozen-data contract):** Define **one** frozen-data schema in `shared/` — columnar, self-describing (column name + type + null encoding), dates as ISO-8601 UTC strings — and make it the *single* payload type for **both** the live UI→Sandbox postMessage **and** the Snapshot embed. Extend the wire-format convention explicitly to the UI↔Sandbox boundary (it currently stops at "Core RPC"). The sandbox render code must be identical whether fed live or from a Snapshot, which is only possible if the two paths share the byte-level shape.

---

## H6 — "Never send whole results" (paginate/virtualize) collides with "sandbox gets already-frozen data and cannot re-query"

**ADs in play:** Conventions/Wire ("large results are paginated/virtualized, **never sent whole**"), AD-11 (SSE streams "large result pages"), AD-3 (sandbox receives *already-frozen* data, cannot initiate a query), AD-9 (Snapshot renders **fully offline**).

**The two units.**
- Unit A — **Grid virtualizer** (Ring 2): pulls result pages by range (offset/limit), never holds the whole set — obeys "never whole."
- Unit B — **Sandbox/Report render of a large result** (Ring 3): AD-3 says it gets frozen data up front and cannot re-query; AD-9 says a Snapshot renders fully offline.

**How it breaks.** A large table rendered in the sandbox or embedded in a Snapshot must be **fully materialized up front** — there is no re-query channel (H2), and offline Snapshots have no Core at all. That directly violates "never sent whole." Two units, both compliant with their own AD, jointly force a contradiction: the pagination convention and AD-3/AD-9 cannot both hold for one large dataset. Also unowned: **who decides page size / boundary** — Ring 2 pull (virtualizer) vs Core push (AD-11 SSE "pages")? If the virtualizer assumes offset/limit and the SSE streamer pushes at its own cadence, they clash on the same result.

**Fix — TIGHTEN the pagination convention + AD-3/AD-9:** State a **row-count ceiling** for sandbox/Snapshot render (tie it to the deferred data-volume ceilings), above which the product truncates-with-notice or refuses rather than silently sending whole; sandbox/Snapshot renders are *bounded frozen sets by definition.* Assign one owner for pagination boundaries (Core defines page size; Ring 2 requests by page token) so pull and push agree on one scheme.

---

## Summary of proposed spine changes

| # | Severity | Seam | Fix |
|---|----------|------|-----|
| H1 | CRITICAL | Core authenticates no caller; AD-9 opens it to foreign origins; loopback ≠ boundary | **NEW AD-12**: per-session capability token on every RPC + Origin/Host anti-rebinding; Live Report is an explicitly-authorized second caller |
| H2 | CRITICAL | "postMessage RPC" launders an inward query for interactive MDX | **TIGHTEN AD-3**: sandbox channel is one-way data + render signals; Ring 2 owns any re-query; enumerate outbound message types |
| H3 | HIGH | Destructive classification split across two rings; list omits UPDATE + multi-statement | **TIGHTEN AD-4**: Core is sole classifier; default-deny for mutations (name UPDATE); reject/split multi-statement |
| H4 | HIGH | Privacy gate in Core, but Ring 2 assembles prompt & holds rows → gate can't see rows | **TIGHTEN AD-7**: typed Core-inspectable schema/rows parts; Core owns the boundary, not Ring 2 free-text |
| H5 | MED | No canonical frozen-data/postMessage shape; live vs Snapshot diverge; wire date-format stops at "Core RPC" | **NEW AD**: one shared frozen-data schema for both postMessage and Snapshot; extend wire rules to UI↔Sandbox |
| H6 | MED | "Never send whole" vs "sandbox frozen, no re-query" / offline Snapshot | **TIGHTEN convention + AD-3/9**: bounded frozen sets with a ceiling; single owner for pagination scheme |

The two criticals (H1, H2) share one root: the spine names its boundaries by *origin/ring* but enforces them by *loopback/"it's an RPC"* — neither of which a browser respects. Close those two and the model actually matches its own prose.
