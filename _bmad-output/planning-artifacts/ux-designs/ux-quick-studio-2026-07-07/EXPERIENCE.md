---
name: quick-studio
status: draft
updated: 2026-07-07
sources:
  - imports/workspace-prototype.html   # design-artifacts/workspace-prototype.html — the north star
  - {planning_artifacts}/ux-designs/ux-quick-studio-2026-07-07/DESIGN.md   # visual identity
  - {planning_artifacts}/epics.md#ux-design-requirements   # UX-DR1..UX-DR7
---

# quick-studio — Experience Spine

> **SUPERSEDED (2026-07-13) — Neutral pivot (Epic 7).** The visual identity has pivoted from the coral/monospace spine to a **neutral, ChatGPT-style** language (ink accent, no coral; color only where functional). The interaction model and IA below still hold; only the visual skin changed. The prototypes in `design-artifacts/*.html` are the current **visual source of truth**, and `DESIGN.md`'s coral rules are historical.

> This EXPERIENCE.md and its paired `DESIGN.md` are the identity. **Both spines win over any mock on conflict**, including the prototype's incidental choices. The prototype `design-artifacts/workspace-prototype.html` is the north star for intent; where a literal mock detail contradicts a rule here, this spec governs. Epic 3 stories (3-1..3-6) and Epic 4 (ERD) reference these behaviors so the React 19 implementation respects the interaction model. Visual tokens are cross-referenced as `{path.to.token}` into DESIGN.md.

## Foundation

quick-studio is a **local desktop-class app that runs in the browser**: a Bun Core binds `127.0.0.1`, serves a React 19 UI, and hands it a session capability token (AR-17, Story 1.1). It is not a web SaaS — there is no remote server, no multi-tenant, no login; the machine is the boundary and localhost is not an auth boundary (the token is).

The UI system is a **custom, monospace-first design system** expressed as CSS tokens in `src/ui/styles/globals.css` and applied with **Tailwind v4 config-less**. Where UX-DR1 says "shadcn/ui aesthetic," read it as *restraint and dark-first polish* — the taste target, not a literal shadcn brand-layer; quick-studio owns its tokens outright (unlike the Drift reference, this is not a shadcn delta). shadcn/ui primitives (Dialog, DropdownMenu, etc.) may back interaction plumbing, but the visual identity is `DESIGN.md`. **Dark-first**; light is full parity.

`DESIGN.md` is the visual identity; this spine is the behavior.

## Information Architecture

Five surfaces on the launcher rail, plus Settings pinned at the bottom (from the prototype rail + epics):

| Surface | Reached from | Purpose | Epic |
|---|---|---|---|
| Tables | Rail (default) / schema-tree table click | Browse & edit rows, create tables, inspect indexes | Epic 3 (FR-8/9/10) |
| Query | Rail / new tab | Ad-hoc SQL editor with type-colored syntax + Run | Epic 3 (FR-11) |
| ERD | Rail | Pan/zoom relational diagram; layout persists in Persistent mode | Epic 4 (FR-12/13) |
| AI Chat | Rail | Natural-language → query, streaming reasoning + answer | Epic 5 (FR-15/16) |
| Report | Rail | Build exportable Report from query results | Epic 6 (FR-18/20) |
| Settings | Rail (bottom, pinned) | Connections, Providers, theme, exposure controls | Epic 2 / Epic 5 |

Left of the surfaces sits the **schema tree** (232px): connection header (status dot, db name, `host · engine`, run-mode chip) over a scrollable table list with row counts. The main column holds **Tabs** — freely openable/closable, each tab a table view, a query, an ERD, a chat, or a report (UX-DR7, FR-23). Below 720px the tree hides and the rail + main remain.

→ Composition reference: `design-artifacts/workspace-prototype.html`. **Spine wins on conflict.** Do not invent surfaces beyond these six — they are the full set in epics.md and the prototype.

## Voice and Tone

Microcopy is **mono, technical, lowercase, terse** — it reads like a status line, not marketing. Visual/aesthetic posture lives in `DESIGN.md`.

| Do | Don't |
|---|---|
| "127.0.0.1 only" | "Your data is safe and secure! 🔒" |
| "encrypted store · OS keychain" | "Credentials protected" |
| "142 rows · 11 ms" | "Loaded 142 records successfully" |
| "query on shop_prod" | "Query Editor — Untitled" |
| "public · 6 tables" | "Public Schema (6 Tables)" |
| lowercase technical identifiers, verbatim db names | Title-Cased Chrome Labels |
| "■ Stop" (stop the local server and exit) | "Quit Application?" |

DB identifiers (`public.orders`, `timestamptz`, column names) are rendered **verbatim from the live database** (AR-19) — never re-cased or prettified. Numbers carry their unit inline and in mono (`11 ms`, `1.2k`).

## Component Patterns

Behavioral rules; visual specs live in `DESIGN.md`.

| Component | Behavioral rules |
|---|---|
| Rail surface button | Single click switches surface; active gets `.on` (coral). One active at a time. |
| Schema tree table | Click (or Enter/Space when focused) selects the table, loads its grid into the active data tab, and reflects the name in the tab. One `.on` table at a time. Keyboard-operable (`role="button"`, `tabindex="0"`). |
| Tab | Click switches; the × closes without switching (stopPropagation). `+` opens a new tab. Closing one leaves others intact (FR-23). Tabs restore in Persistent mode (FR-24). |
| SQL editor | Type-colored syntax highlighting (keywords coral, functions violet, strings green, numbers blue). `⌘↵` / `Ctrl+↵` runs. |
| Run button | Fires the query; on completion updates latency, row count, and grid together. The one sans-labelled control. |
| Result grid — row select | Click a row selects it (single-select; inset coral left-marker). Hover tints the row in accent-soft. |
| Result grid — inline edit | Editing a single cell / inserting a single row is **structured single-row DML (AD-4 path a): auto-commit, NO dialog** (UX-DR4 fast-path exemption) — daily editing stays fluid. |
| Destructive action | **Row delete**, and **any raw or AI-generated mutating/DDL** (DELETE/DROP/TRUNCATE/UPDATE/ALTER) from the Query tab or Chat → a clear **confirmation surface** before execution (UX-DR4, see State/UX-DR map). The dialog is UX only; the Core executor is the real gate (AR-3). |
| Filter | Live client-side row filter as you type (`filter rows…`), instant show/hide. |
| Ghost buttons | Add Row / Export — secondary, quiet mono. |
| Pills | status/bool cells render as pills (paid/pending/refunded; true/false). |

## State Patterns

| State | Surface | Treatment |
|---|---|---|
| Connected | tree header + status bar | ok dot with soft halo; "shop_prod connected"; run-mode chip (persistent/ephemeral). |
| Loading / running | editor bar | Run in-flight; results resolve. Streaming (Chat) never janks the UI thread (UX-DR3/NFR-6). |
| Query complete — **the signature** | latency readout | The coral latency number swaps to the new value and plays the `pop` keyframe ({components.latency}) — "done, and here's how fast, 11 ms." Row count + status-bar ms update in lockstep. This is the product's core feedback gesture (UX-DR2: motion serves feedback only). |
| Empty result | grid | Grid renders headers with 0 rows; count reads "0 rows". No decorative empty art. |
| Error | error envelope | Core returns `code / message / detail` (AR-19); connection errors distinguish host vs auth vs network (Story 1.3). Surface terse and mono. |
| Large result | grid | Paginated / virtualized, stays fluid at large row counts (UX-DR6/NFR-5). |
| NULL / FK | cells | NULL faint italic; FK underlined and clickable to follow the relation. |
| Port exposed | global | Prominent, unmistakable alert explaining the risk + exact steps back to localhost-only (UX-DR5/FR-22). Not in the prototype — implement as a loud banner, not a quiet status. |

## Interaction Primitives

- **`⌘↵` / `Ctrl+↵`** — Run the current query (global; the primary verb).
- **Live filter** — typing in the filter input immediately narrows visible rows.
- **Theme toggle** — the topbar sun/moon flips `data-theme` between dark/light; respects `prefers-color-scheme` on first load.
- **Tree keyboard nav** — tables are focusable; Enter/Space activates. Tab order matches reading order.
- **Row select** — click; single-select with coral marker.
- **Stop** — `■ Stop` stops the local server and exits (also Ctrl-C from terminal; ≤2s, Story 1.5).
- **`:focus-visible`** — every interactive element shows the 2px coral focus ring ({components.focus-ring}).
- Interactions tuned to feel instant — <100ms (NFR-4, UX-DR7).

## Accessibility Floor

- Roles/labels from the prototype: rail is `<nav aria-label="Workspace tools">`, each rail button has `aria-label`; tree tables are `role="button" tabindex="0"` with Enter/Space activation; filter input has `aria-label`; tab close has `aria-label="Close"`.
- **Keyboard nav of the schema tree** is first-class — no mouse-only paths to select a table.
- **`prefers-reduced-motion: reduce`** disables all animation and transition (the latency `pop` included) — motion is never load-bearing information; the number still updates.
- **Contrast**: dark-first neutrals + accent verified for legibility; type-color coding must not be the *only* signal (the type label text carries the SQL type name too, so color is redundant reinforcement, not sole meaning) — protects color-vision-deficient users.
- Focus rings visible at AA contrast against every surface via the coral `{components.focus-ring}`.
- Tab order matches reading order; Esc closes the topmost confirmation dialog.

## UX-DR Coverage Map

| UX-DR | Where honored |
|---|---|
| **UX-DR1** dark-first, shadcn-grade restraint, anti-DBeaver | Foundation; DESIGN.md Brand & Style + mono-first discipline. |
| **UX-DR2** fast/fluid, motion=feedback only | State Patterns (latency `pop` is the only motion); DESIGN.md Do's/Don'ts. |
| **UX-DR3** streaming reasoning as a distinct channel, no jank | Chat surface; State Patterns (streaming never janks — NFR-6). *[ASSUMPTION] visual treatment of the reasoning channel is not in the prototype; Epic 5 owns it — flagged for a UX pass.* |
| **UX-DR4** destructive-action confirmation | Component Patterns (Destructive action + inline-edit auto-commit). **CRITICAL:** row deletes and raw/AI DDL → confirm; structured single-row inline edits/inserts → auto-commit, no dialog. Dialog is UX; Core executor (AR-3) is the real gate. |
| **UX-DR5** Port-Exposure Warning | State Patterns (Port exposed) — loud banner, exact revert steps. *[ASSUMPTION] not in the prototype; specified here as a prominent alert.* |
| **UX-DR6** result-grid + ERD responsiveness | State Patterns (Large result → paginated/virtualized); ERD pan/zoom to 60–70 tables (Epic 4). |
| **UX-DR7** freely open/close Tabs + resizable Panels, restore in Persistent, <100ms | IA (Tabs), Interaction Primitives, Component Patterns (Tab). |

## Key Flows

### Flow 1 — Run a query and fix a row (Mara, backend dev, checking the day's orders)

1. Mara has quick-studio open on `shop_prod` (Postgres, `127.0.0.1:5432`), run-mode chip reading **persistent**. The `orders` table is loaded in the active tab — 142 rows.
2. She switches to the `revenue.sql` tab, edits the SQL (keywords glow coral, the `'paid'` string green), and hits **`⌘↵`**.
3. **Climax:** the coral latency number *pops* to **11 ms**, the count updates to "142 rows · 11 ms", the status bar ms matches, and the grid repaints — columns typed by color (int blue, timestamptz violet, numeric teal, status pills). She read the speed and the shape of the result in one glance, without moving her eyes off the data.
4. She spots order 1041 with a NULL email (faint italic) that should be filled. She jumps to the `orders` tab, clicks the cell, types the address, and Tab commits — **no dialog** (structured single-row edit auto-commits, UX-DR4 fast-path). The edit lands instantly.
5. Now she needs to remove a bad test row: she selects row 1039 (coral left-marker) and deletes it. **This is destructive → a confirmation surface appears** (UX-DR4). She confirms; the Core executor gates and executes (AR-3). Row gone, count decrements.

Failure: her SQL had a typo → Core returns `code/message/detail`; the surface shows the terse error distinguishing syntax from connection, editor retained, another `⌘↵` retries.

*[ASSUMPTION] the exact confirmation-dialog anatomy (copy, button order) is not in the prototype; specified behaviorally here, visual pass owed in Epic 3 story 3-1/3-2.*
