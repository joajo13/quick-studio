# Epic 8 Context: UI Refinements — Artifact Fidelity & Interaction Polish

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This is a refinement pass on top of Epic 7's neutral/ChatGPT-style redesign. Several surfaces drifted from the `design-artifacts/*.html` prototypes during that pass — most visibly the Chrome-style tabs, whose concave "feet" were removed to dodge an `overflow-y` clipping bug and which shipped without ever being visually verified live. This epic restores that fidelity and adds the interaction polish the prototypes imply (markdown chat rendering, provider auto-select, a real SQL editor, a singleton Settings tab, visibility into the active connection). The prototypes remain the visual source of truth. Two build decisions were made up front for this epic: dropdowns move to shadcn/ui + Radix, and the SQL editor moves to CodeMirror 6.

## Stories

- Story 8.1: shadcn/ui + Radix foundation
- Story 8.2: Chrome-tab fidelity + content-panel fusion
- Story 8.3: Custom scrollbars + remove left-panel divider
- Story 8.4: Render Markdown/MDX in chat message bubbles
- Story 8.5: Chat provider auto-select + shadcn dropdown
- Story 8.6: Settings as a singleton tab
- Story 8.7: Surface the active connection in Settings/Connections
- Story 8.8: SQL editor — CodeMirror 6 syntax highlighting + autocomplete

## Requirements & Constraints

- The HTML files in `design-artifacts/` remain the visual source of truth; every story requires a live visual check against its prototype at `http://127.0.0.1:6061` before being considered done — this is the exact gap that let Epic 7 drift undetected.
- Every story must preserve existing logic, RPC contracts, a11y roles (e.g. `role`/`aria-selected`, keyboard operability), and passing tests unless its acceptance criteria explicitly calls for a behavior change.
- Markdown rendering in chat must be XSS-safe (via micromark) — no raw-HTML injection path.
- Custom scrollbars must render correctly in both Chromium and Firefox.
- Surfacing the active connection must never display a secret/credential, and must preserve the schema-only exposure guarantee already established for chat/sandbox.
- The provider picker's schema-only exposure note must remain visible after the dropdown swap.

## Technical Decisions

- The app is Bun + Tailwind v4 with a custom `scripts/build-ui.ts` bundler — not Next.js. Any new component library must work with this custom build pipeline.
- Story 8.1 introduces shadcn/ui + Radix for the first time as actual components (the project previously had only the shadcn CSS-token layer, no component code): the `cn()` util plus `src/ui/components/ui/*` base primitives (button, select, popover, command, dialog), authored against the existing neutral tokens. It is foundation-only — no existing surface's look or behavior should change — and must keep `bunx tsc --noEmit`, `bun test`, and `bun run build` green. Its output is consumed by 8.5 (dropdown) and 8.6 (dialog/tab plumbing).
- Story 8.8 replaces the current SQL editor implementation with CodeMirror 6, themed to the neutral tokens, adding syntax highlighting and schema-aware (schema/table/column) autocomplete on top of the existing guarded-execute RPC path, which stays unchanged.
- Story 8.6 routes Settings through the existing tab model as a normal singleton tab (not an overlay); re-invoking Settings must focus the existing tab rather than opening a duplicate.
- Story 8.7 requires a new Core-side signal to expose the active (ephemeral) connection to the UI, distinct from the persisted-connections store, without leaking credentials.

## UX & Interaction Patterns

- Chrome-style tabs (8.2): concave feet, active tab fuses seamlessly into the content panel (no dividing line), reduced tab height with no spurious vertical scroll, centered close ×; inactive-tab hover renders as a chip/pill, not a tab shape. The active content panel gets rounded top corners only, square/flush bottom (no gap, no rounded bottom).
- Any overflowing container (8.3) shows a custom neutral scrollbar instead of the browser default; the left schema panel loses its divider line entirely — the boundary comes from surface contrast alone — while resizable-panel drag behavior is preserved.
- Chat markdown (8.4): fenced code blocks (e.g. ` ```sql `) render as styled neutral code blocks with no visible fence markers, matching `ai-chat-chatgpt.html`.
- Provider auto-select (8.5): last-used provider preferred, falling back to the sole connected provider; selection persists across reopen; the picker becomes a custom shadcn dropdown (not a native `<select>`), styled per prototype.
- Settings/Connections (8.6, 8.7): Settings opens as a normal tab in the strip; the active ephemeral connection appears in Connections as a distinct read-only "current connection" entry (engine/host/db/mode), styled per `design-artifacts/connect.html`.
- SQL editor (8.8): CodeMirror 6 syntax highlighting themed per `design-artifacts/workspace.html`; Ctrl+Space (or continued typing) surfaces schema/table/column completions from the loaded schema that insert on select; ⌘↵ still runs the query.

## Cross-Story Dependencies

- Story 8.1 is a prerequisite for 8.5 (shadcn dropdown for the provider picker) and 8.6 (dialog/tab plumbing) — both consume the primitives it introduces.
- Stories 8.2, 8.3, 8.4, 8.7, and 8.8 are independent presentation/feature passes over separate surfaces and are not blocked by 8.1.
- All stories share the same prototype-fidelity requirement and the same live-visual-check gate against `http://127.0.0.1:6061`.
