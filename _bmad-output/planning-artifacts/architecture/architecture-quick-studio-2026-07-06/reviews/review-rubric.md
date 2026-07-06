# Rubric Review — Architecture Spine: quick-studio

**Reviewed:** `ARCHITECTURE-SPINE.md` (initiative altitude, greenfield)
**Date:** 2026-07-06
**Verdict:** **NEEDS WORK**

The trust/security core of this spine is genuinely strong: the three-ring model is a crisp, load-bearing paradigm and AD-1 through AD-9 are mostly enforceable and prevent the divergences they name. The problems are concentrated in the **operational/environmental envelope** (checklist item 7) — a whole structural dimension (on-disk data locations) is silent, one Deferred reference dangles, and there are freshness/traceability inconsistencies. None are fatal, but several are load-bearing enough to fix before this spine drives epics.

---

## Findings by checklist item

### 1. Fixes the real divergence points for the level below

Mostly yes. The security/trust divergences (rings, secrets, SQL execution, sandbox, network exposure, AI privacy, persistence footprint, report export, charting, streaming) are each nailed by a dedicated AD. Two gaps:

- **[HIGH] On-disk data-location divergence is not fixed.** See item 7 — this is the biggest hole.
- **[MEDIUM] Two-dialect (Postgres/MySQL) abstraction boundary is not an invariant.** The stack lists `postgres.js` and `mysql2` as separate drivers, but no AD or convention states that dialect-specific SQL/introspection stays *inside* the Core behind a uniform interface, and that Ring 2/features remain dialect-agnostic. AD-2 fixes "all SQL executes in Core" and the conventions fix "identifiers verbatim," but neither prevents dialect assumptions (e.g. `information_schema` quirks, `LIMIT` vs `TOP`, type-name differences) from leaking into UI/feature code. Two features could each hard-code a different engine's assumptions. For a product whose scope is explicitly "Postgres + MySQL," the dialect-isolation boundary is a real divergence point and deserves an invariant.

### 2. Every AD's Rule is enforceable and prevents its divergence

Strong overall. AD-2/3/4/5/6/8/9 are objectively checkable (a builder can verify: secrets only in Core; iframe has `sandbox="allow-scripts"` without `allow-same-origin` under `default-src 'none'`; destructive statements enumerated and gated; no plaintext; `127.0.0.1` bind + watcher; nothing written in ephemeral mode; no credential/DB-runtime in an exported report). Minor soft spots, none load-bearing:

- **[LOW] AD-11** "reasoning is a channel *visually distinct* from the answer" — the transport-channel separation is enforceable, but "visually distinct" is a subjective UI judgment that belongs closer to UX spec than to an invariant. The enforceable half (separate SSE channel) is fine; the visual half is soft.
- **[LOW] AD-1** "no unit may widen its own ring's powers" is abstract, but the concrete ring-membership + defined-channel rules make it checkable in practice. Acceptable.

### 3. Nothing load-bearing under Deferred

Mostly clean. Deferred items (NoSQL, deep ERD editing, auto-update, macOS, keychain runtime validation, data-volume ceilings, MDX runtime, stack pins) are each either a genuine v2 scope cut or contained by an existing AD (MDX runtime sits inside AD-3; keychain has the passphrase net from AD-5). One concern:

- **[MEDIUM] "Distribution/packaging" is not actually deferred anywhere** — see item 7. The Capability map *cites* "distribution (Deferred)" but no Deferred bullet covers it, so it is neither decided nor deferred — it's silent with a dangling pointer.
- Data-volume ceilings deferred is acceptable because the *behavior* (paginate/virtualize, never send whole) is already an invariant in the conventions; only the numeric limits are deferred to code.

### 4. Named tech carries versions and reads verified-current

**[MEDIUM] Partly asserted, not uniformly verified — and self-contradicting.** The Stack header claims "verified current at authoring (2026-07-06)," but the Deferred section admits: *"Unverified stack pins — React/TypeScript/shadcn majors are cold-start seed; confirm exact versions at scaffold."* Those two statements contradict each other. The table also mixes precision inconsistently: some entries are exact patches (`mysql2 3.22.5`, `ai 7.0.15`, `@napi-rs/keyring 1.3.0`, `Recharts 3.9.2`, `Observable Plot 0.6.17`) while others are vague majors (`Bun 1.2.x`, `TypeScript 5.x`, `React 19.x`, `postgres.js 3.x`). The precise-looking pins read as verified; the majors read as asserted. Recommend: either mark the unverified entries explicitly in the table (not just buried in Deferred), or verify them so the "verified current" header is honest for the whole table.

### 5. Greenfield — brownfield contradiction check

Skipped per instructions. No existing codebase to contradict.

### 6. Covers the driving spec's capabilities (glaring holes only)

FR coverage looks complete: the Capability→Architecture map walks FR-1 through FR-24 and each lands in a ring with a governing AD. Two traceability holes worth flagging for the reconcile reviewer:

- **[MEDIUM] R6 is declared bound but no AD addresses it.** Frontmatter `binds: [... R1..R6]`. R1→AD-3, R2→AD-5, R3→AD-6, R4→AD-4, R5→AD-7 all appear in AD Binds lines — but **R6** appears in no AD's Binds. Either R6 is genuinely uncovered, or the mapping is incomplete.
- **[MEDIUM] NFR-1 is declared bound but never referenced.** Frontmatter `binds: [... NFR-1..NFR-6]`. NFR-2/3 (footprint/perf) and NFR-4/5 (data volume) and NFR-6 (streaming, AD-11) all surface somewhere; **NFR-1** appears in no AD, convention, or map row. Flag for the reconcile pass to confirm it isn't a silent capability drop.

### 7. Every dimension decided, deferred, or an open question — operational envelope

This is the weakest area. Two structural dimensions are effectively silent:

- **[HIGH] On-disk data locations are undefined.** For a cross-platform (Windows + Linux) local-first app, *where* Persistent-mode artifacts live is a genuine product-wide invariant. AD-5 says the credential store is an AES-256-GCM *file* and AD-8 says ephemeral writes nothing — but nothing states the on-disk location/layout for: the credential store file, the optional config file (mentioned in conventions), persisted ERD layouts and panel/tab state, generated reports, and logs. Without an invariant (e.g. platform-appropriate app-data dirs — `%APPDATA%`/`%LOCALAPPDATA%` on Windows, XDG `$XDG_DATA_HOME`/`$XDG_CONFIG_HOME` on Linux), different features will each pick their own paths and the "footprint is the identity" promise becomes unenforceable. The checklist explicitly names "on-disk data locations" as a dimension to watch — it is absent here.

- **[MEDIUM] Distribution/packaging is silent with a dangling reference.** The scope promises "one-command install/run" and the stack lists `bun build --compile` (implying a single self-contained binary), but no AD, convention, or Deferred bullet actually *fixes* the packaging/distribution decision. The Capability map row for FR-1–3 points at "distribution (Deferred)" — but there is no such Deferred entry. So this dimension is neither decided nor formally deferred; it's an implicit assumption riding on the stack table plus a broken pointer. Either add an AD/convention ("v1 ships as a `bun --compile` single binary per OS") or add the missing Deferred bullet the map already references.

- **Update mechanism:** adequately handled — auto-update is explicitly Deferred with a re-install/re-download fallback stated. OK.
- **Runtime footprint:** partially covered — NFR-2/3, minimal-stderr logging, and "no daemon outlives the process" (AD-8) speak to it. Acceptable at initiative altitude; concrete ceilings are legitimately deferred.

### 8. Altitude discipline

Good overall — the spine stays at product-wide invariants and does not drip into per-story detail. Two borderline notes, neither disqualifying:

- **[LOW] AD-10** names specific libraries (Recharts, Observable Plot) and includes a rationale for *excluding* TradingView. The invariant ("charting is split by ring because Ring 3 has no React host") is correctly initiative-altitude; the specific library picks are really Stack-table calls and the TradingView exclusion rationale drifts slightly toward feature-level reasoning. Consider moving the exact library names to the Stack table and keeping AD-10 as the ring-split rule only.
- **[LOW] AD-11's** "visually distinct" (see item 2) leans toward UX-spec altitude.

---

## Priority fixes before this spine drives epics

1. **[HIGH]** Add an invariant fixing **on-disk data locations** for Persistent mode (platform-appropriate app-data/config dirs), covering store, config, persisted UI state, reports, and logs.
2. **[MEDIUM]** Resolve **distribution/packaging**: add an AD/convention (`bun --compile` single-binary per OS) or add the Deferred bullet the Capability map already references.
3. **[MEDIUM]** Fix the **stack-freshness contradiction**: don't claim "verified current" for the whole table while Deferred admits React/TS/shadcn are unverified — mark the unverified pins inline or verify them.
4. **[MEDIUM]** Close the **R6 and NFR-1 traceability holes** — either bind them to an AD or confirm they're intentionally out of scope.
5. **[MEDIUM]** Consider a **Postgres/MySQL dialect-isolation invariant** so dialect-specific SQL/introspection can't leak out of the Core.

## What's already solid (keep)

- Three-ring paradigm with the single "data flows outward, capability never inward" rule — clear, memorable, load-bearing.
- AD-2/3/5 are model-grade enforceable security invariants (cross-origin process boundary as *the* trust boundary, explicitly refusing in-process isolation; secrets only in Core; no-plaintext-ever).
- AD-4's enumerated destructive-statement gate and AD-7's schema-by-default / rows-opt-in privacy rule are precise and checkable.
- Consistency conventions and the Capability→Architecture map give builders a real routing table.
