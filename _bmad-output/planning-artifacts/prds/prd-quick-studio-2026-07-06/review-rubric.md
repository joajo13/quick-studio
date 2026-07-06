# PRD Quality Review — quick-studio

*Calibration: personal/portfolio local-first dev tool, solo operator. Enterprise rigor (ROI, SLAs, compliance) is out of scope by design. The bar applied here is: testable FRs, consistent Glossary, traceability, honest scope, no silent gaps, no contradictions.*

## Overall verdict

This is a strong, disciplined PRD — well above the bar for a solo project. It has a real thesis ("lightweight is the identity, fast is the felt promise"), the FRs almost all carry explicit testable consequences, scope honesty is excellent (the §6.3 eyes-open note on the big-bang MVP is exactly the kind of tradeoff most PRDs bury), and the highest-risk item (§11-R1 executable-JS sandbox) is flagged loudly and correctly gated. What's at risk is narrow and fixable: the marquee/highest-risk capability (FR-17 rich MDX) has no success metric, one daily-driver capability (row insert/delete) is a silent gap inside FR-8, and the Assumptions Index doesn't round-trip (§10 and §12 inline `[ASSUMPTION]` tags are unindexed). None of these block building; all are quick fixes.

**Gate: PASS-WITH-FIXES.**

## Decision-readiness — strong

A builder could act on this today. Tradeoffs are stated as decisions, not smoothed to neutral: §6.3 explicitly owns that folding the full AI Chat + Reports into v1 makes v1 "substantially larger and pulls the costliest, riskiest component into the first release." §11-R1 names executable embedded JS as "the single largest security and engineering risk in v1" and makes it a hard prerequisite rather than a vague concern. Open Questions in §8 are genuinely open (charting-library fit, sandbox mechanism, Live Report data path) — not rhetorical. The `[NOTE FOR PM]` callouts land at real tensions (NoSQL deferral being "emotionally load-bearing," the AI-to-Provider data boundary needing an explicit policy), not at safe checkpoints.

No findings.

## Substance over theater — strong

Very little furniture. There are no personas-as-decoration — the single protagonist (Juanelo) is the actual user and each UJ drives FRs. The differentiator claim (local report generation) is earned and specific, not template-filler. NFRs in §10 are product-specific and tied to the "lightweight" identity rather than boilerplate ("system must be scalable"); where numbers aren't set yet they're honestly tagged `[ASSUMPTION]` and deferred to architecture. The Vision (§1) could not be swapped into another PRD — "success is measured by one honest test: the builder stops using DBeaver" is concrete and category-specific.

No findings.

## Strategic coherence — strong

The PRD has a thesis and the features serve it. The "lightweight / fast" bet drives both the In-Scope choices and the Non-Goals (deep DBA tooling excluded *because* breadth is what makes incumbents heavy — the exclusion follows from the thesis, not from convenience). Counter-metrics (SM-C1 feature count, SM-C2 AI reach) are present and correctly point back at the thesis's failure modes. This is the opposite of a backlog with section headings.

### Findings
- **medium** Marquee capability has no success metric (§7 / FR-17) — SM-1 covers FR-1–13/23–24, SM-2 covers reports (FR-18–20), SM-3 covers NL→query (FR-15–16). FR-17 (rich MDX with charts + executable embedded JS) — explicitly called "the single highest-risk capability in v1" — is validated by no SM. Given its cost and risk, there's no stated test for whether it was worth building. *Fix:* add a metric (e.g. "AI-generated charts/MDX blocks render correctly and are actually used in real reports/chats"), or fold FR-17's payoff explicitly into SM-2/SM-3.

## Done-ness clarity — strong

The strongest dimension. Nearly every FR has a **Consequences (testable)** block with verifiable conditions ("no files are written to disk during or after it," "the store file, if opened directly, reveals no readable credential material," "a created table appears in the schema and the ERD without a manual refresh"). Where adjectives appear ("feel instant," "without being noticed"), they're bounded by an `[ASSUMPTION]` numeric budget (NFR-4 `<100ms`, NFR-2 `≤2s`) or explicitly deferred to architecture (NFR-1 idle RAM). The destructive-statement guardrail is specified consistently across FR-11, FR-15, and §11-R4.

### Findings
- **medium** Silent gap: row insert/delete unspecified (FR-8, §4.4) — FR-8 covers "view table rows and edit cell values." Inserting new rows and deleting rows are core daily-driver operations implied by "browse and edit rows" but never specified. An engineer wouldn't know if they're in scope. *Fix:* either extend FR-8's consequences to cover insert/delete of rows, or explicitly park them (a `[NON-GOAL for MVP]` if edit-only is intended).
- **low** "Currently connected database" is ambiguous with multiple connections (FR-15) — the JTBD is "developing across several projects at once" and the Workspace holds multiple Tabs, so multiple Connections can be live. FR-15 targets "the currently connected database's schema" but nothing defines how "current" is resolved (active Tab? a chat-bound Connection?). *Fix:* one sentence stating how the AI Chat binds to a Connection.

## Scope honesty — strong

Omissions are explicit, not inferred. §5 Non-Goals does real work (each exclusion is justified against the thesis). §6.2 Out-of-Scope is crisp and each item has a reason + a v2 landing spot. §6.3 records the biggest scope decision honestly. Open-items density is proportionate — a handful of Open Questions and `[ASSUMPTION]` tags on a solo build is exactly right, not a green-light-with-hidden-holes situation.

### Findings
- **low** Live Report execution model is a real unresolved tension (FR-20, Open Q3) — an exported *static HTML* Live Report that "re-queries its target when viewed, via a connection the viewer supplies" implies an exported artifact that can open DB connections outside quick-studio. This is genuinely hard and is correctly flagged in Open Q3 — so not a defect, but it's the one place where the FR asserts a capability whose feasibility isn't yet established. *Fix:* none required now; just keep FR-20's "Live Report" claim tentative until architecture resolves Q3, so downstream doesn't treat it as settled.

## Downstream usability — adequate

This PRD feeds UX/architecture/epics, so traceability matters. It's mostly clean: Glossary present and used consistently, FR/UJ/SM/NFR IDs contiguous and unique, cross-references resolve (FR-17→§11-R1, FR-4/5→§11-R2, etc.), sections stand alone. The gap is consistency of the "Realizes UJ" traceability convention and the Assumptions Index round-trip (see Mechanical notes).

### Findings
- **low** "Realizes UJ-x" applied inconsistently at FR level (§4) — FR-1–6, 15, 16, 18–20, 22 carry an explicit `Realizes UJ`; FR-7–14, 17, 21, 23, 24 carry it only at the feature-group heading. Traceability still exists (via the group), but a story-creation pass extracting FR-by-FR will see gaps. *Fix:* either push the UJ tag down to every FR, or state once that FRs inherit their feature group's UJ.

## Shape fit — strong

Correctly calibrated. This is a single-operator tool, which the rubric says can lean capability-spec and treat UJs as optional overhead. The PRD keeps UJs but explicitly justifies them as lightweight context carriers (§2.3: "Single-operator tool, so journeys are lightweight but concrete") — a deliberate, defensible choice, not over-formalization. SMs are appropriately personal/qualitative ("the builder stops using DBeaver") rather than forced into DAU/MAU. No enterprise scaffolding was bolted on. Nothing is over- or under-formalized.

No findings.

## Mechanical notes

- **Assumptions Index does not round-trip (§9).** The index lists four inline tags (FR-3, FR-14, FR-24, SM-1) but several inline `[ASSUMPTION]` tags are missing: NFR-1 (idle RAM/CPU), NFR-2 (≤2s cold start), NFR-4 (`<100ms` UI response), and §12 (dark-first). §9's "Confirmed by builder" note partially absorbs the perf budgets ("perf budgets accepted as starting points"), but the inline tags still contradict that by remaining un-promoted. *Fix:* either add the §10/§12 assumptions to the index, or remove the inline `[ASSUMPTION]` tags for anything §9 already confirms.
- **Glossary drift — minor.** "Credentials" is capitalized as if a defined term in FR-6 and FR-14 ("stored under the same protection as Credentials") but isn't a Glossary entry (the entry is "Credential Store"). Harmless but slightly inconsistent. Also "saved artifacts" (Glossary Credential Store) vs "Connections, ERDs, and Reports are saved" (Persistent def) — consistent in meaning, no action needed.
- **ID continuity — clean.** FR-1..24, UJ-1..5, SM-1..4 + SM-C1..2, NFR-1..6, §11-R1..R6 all contiguous and unique. No broken cross-refs found.
- **UJ protagonists — clean.** Every UJ names Juanelo and carries context inline; no floating UJs.
- **Required sections — all present** for this stakes/type (Vision, Users, Glossary, Features/FRs, Non-Goals, MVP Scope, Success Metrics, Open Questions, Assumptions, NFRs, Constraints, Aesthetic).
