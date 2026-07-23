# Epic 9 Context: Polish, Chat-Driven Reports & Workspace Ergonomics

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic is a post-redesign iteration that acts on a fresh round of hands-on feedback from actually running the app. Epics 7–8 moved the UI to the neutral, ChatGPT-style language and restored fidelity to the prototypes; Epic 9 finishes the job with three already-committed visual-polish items plus the remaining feature and structural work: relocating the Create-table surface into a normal tab, making ERD hover genuinely informative, persisting AI provider keys across sessions, and — the marquee item — letting a user drive report generation straight from the chat. The point is to turn a visually-finished tool into an ergonomically-finished one, closing the gap between "looks done" and "feels done" without introducing any new visual language.

## Stories

- Story 9.1: Shell control icons — centered glyphs + a real Settings gear (DONE, verify only)
- Story 9.2: Report view — shadcn controls across toolbar and blocks (DONE, verify only)
- Story 9.3: Borderless SQL console (DONE, verify only)
- Story 9.4: Create Table as a tab
- Story 9.5: ERD hover — column detail, PK/FK, and relationship highlight
- Story 9.6: Persist AI provider API keys across sessions
- Story 9.7: Generate reports from the chat (open, view, and edit)

## Requirements & Constraints

- Stories 9.1–9.3 are already implemented and hand-tuned live; the committed result is the fixed visual direction. The loop only verifies and regression-tests them — no re-implementation.
- Presentation work must preserve all existing logic, RPC contracts, accessibility roles (`role`/`aria-*`, `role="alert"` lines), testids, and passing tests unless a story explicitly changes behavior.
- Every UI change is judged against the neutral prototypes as the visual source of truth. No coral, no new palette; color stays functional only (data-type column colors, ok/warn/err state semantics, a blue chart data-series, red on destructive actions).
- Component baseline is shadcn/ui + Radix (established in Epic 8) on the existing neutral tokens. Radix Select forbids empty item values — sentinel values map to null/empty (as done for the report block pickers).
- Provider-key persistence must never write plaintext and never log the key; the Settings surface indicates a configured provider masked, with an explicit remove/replace affordance.
- Chat-driven report generation must never leak data off the machine and must degrade cleanly on failure (provider error, empty result, malformed spec) — opening nothing half-built rather than a partial/broken Report tab.

## Technical Decisions

- **Three-ring trust model governs everything.** Core (Ring 1) is the sole holder of DB connections, decrypted credentials, and Provider keys; it is the only SQL executor and the only outbound Provider caller. The UI (Ring 2) and sandbox (Ring 3) issue typed requests and receive results; capability never flows inward. Nothing in this epic may widen a ring's powers.
- **Single guarded Core executor.** All mutations pass through one Core executor that classifies risk by request shape and is the real gate (a UI dialog is UX only). This governs any SQL a chat-generated report runs (9.7) — it goes through the guarded executor exactly like query-Tab SQL, destructive statements always confirmed.
- **Provider boundary is schema-only by default.** Chat/report context sent to a Provider carries schema metadata (table/column names, types, foreign keys) as distinct fields; rows leave only via explicit, per-query, visibly-indicated opt-in. Preserve the "schema only — no rows leave the Core" note in the UI (9.6, 9.7).
- **Encrypted credential store.** Persistent-mode secrets (including provider keys, 9.6) live in an AES-256-GCM store under the one OS-convention app directory; the 32-byte key is held in the OS keychain (Windows Credential Manager / Linux Secret Service) with a passphrase-derived fallback. The store file holds no key and no readable credential material. Ephemeral mode writes nothing.
- **Tab model is the routing convention.** Create-table (9.4) is a relocation from overlay to a normal tab routed through the same open/activate/close/persist tab model — mirroring how Settings moved to a singleton tab in Epic 8. It is a relocation, not a rewrite; the panel's pickers, DDL compose, create RPC, and guard/confirm flow are preserved verbatim.
- **Charting split by ring.** In-app charts (report blocks, Ring 2) use Recharts / shadcn charts with the neutral blue data-series; sandbox charts (Ring 3) use Observable Plot. A Report can export as a static Snapshot (frozen data, offline) or a Live Report (no credential, no DB runtime — re-queries only by targeting a running Core that authorizes it as an explicit second caller).
- **Canonical frozen-data shape.** One shared, versioned frozen-data schema in `shared/` (ISO-8601 UTC dates, typed values) is the only shape pushed to the sandbox and embedded in a Snapshot; chat-generated reports reuse the existing snapshot/live-report export paths.

## UX & Interaction Patterns

- shadcn/ui aesthetic: clean, restrained, dark-first. Motion serves feedback only (state changes, streaming), never decoration.
- Overlays are discouraged for primary surfaces — Create-table (9.4), like Settings before it, becomes a first-class tab so the user can move between it and their work without hiding the tab strip.
- ERD hover (9.5) must feel explorable: hovering a table node highlights its connected relationships/edges and shows a tooltip/panel of columns with types and PK/FK badges; the highlight and tooltip clear cleanly on leave with no stale state, and pan/zoom/layout-persist behavior is unchanged.
- Chat streaming keeps the reasoning channel visually distinct from the final answer and never janks the UI thread.
- Chat-driven reports (9.7) open into a Report tab with the same full editing affordances as a hand-built report — re-run queries, edit prose/charts via the shadcn block controls — and export via the existing snapshot/live paths.

## Cross-Story Dependencies

- Builds directly on Epic 8's shadcn/ui + Radix foundation and singleton-tab pattern; 9.4 mirrors the Settings-as-tab relocation from Story 8.6, and 9.2 depends on the shadcn Select/Button controls.
- Story 9.7 (chat-driven reports) is the integration seam across three prior epics: it reuses Epic 3's guarded executor, Epic 5's chat/Provider boundary, and Epic 6's report assembly and snapshot/live export. It also depends on Story 9.2's shadcn report controls for its edit affordances.
- Story 9.6 (persist provider keys) depends on Epic 2's encrypted credential store and keychain/passphrase key management, and on Epic 5's provider configuration surface.
- Story 9.5 (ERD hover) extends Epic 4's ERD without changing its layout-persistence behavior.
