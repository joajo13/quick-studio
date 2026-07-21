---
title: 'Story 10.5: Multi-root schema tree — one collapsible root per saved connection, lazy introspection'
type: 'feature'
created: '2026-07-21'
status: 'draft'
depends_on:
  - '10-4-core-resolve-by-connection-id'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 10 / Story 10.5
  - '{project-root}/_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html'
  - '{project-root}/src/ui/schema/SchemaTree.tsx'
---

<intent-contract>

## Intent

**Problem:** `SchemaTree` (`src/ui/schema/SchemaTree.tsx`) is single-connection: on mount it fires exactly ONE bare `rpc("connect")` (no id) and renders one flat table list for whatever the Core's boot manager is bound to. In Persistent mode with no boot URL, that call fails with `unsupported_scheme: "no connection target configured"`, string-matched by `isNoConnectionTarget` into a calm "Sin conexión activa" empty-state (**32-52, 217-235**) — the interim fix. But there is no way to actually BROWSE a saved connection (`connections.list`) from the tree at all: you can save N connections in Settings and still see nothing. This story makes the tree genuinely multi-connection: N saved connections ⇒ N collapsible root nodes, DBeaver-style, each introspecting only when the user asks for it — not 20 handshakes at boot for 20 saved connections.

**Approach:** Fetch `connections.list` once on mount to get the credential-free `ConnectionSummary[]`. Render one collapsible ROOT per summary (name + engine badge + host + status dot + chevron, mirroring the mockup's `.root-head`), rendered INSTANTLY and UNINTROSPECTED. Each root owns its own `idle | loading | ready | error` state, keyed by `connectionId`, independent of every other root — expanding a root that is `idle` triggers `connect{connectionId}` (Story 10.4) exactly once; expanding a root that is already `ready`/`error` (cached) does NOT re-fetch; collapsing never discards the cached state, only visibility. A root's `error` (classified, engine-neutral `ConnectResult.failed`) renders inline with a "Reintentar" retry affordance and never affects any other root — one bad connection cannot tank the tree. Inside a `ready` root, everything the current single-root tree does today is preserved verbatim and simply re-scoped per root: schema grouping, the table-activation callback (click + Enter/Space keyboard), and column disclosure with type-dot + PK coloring (`typeDotClass`, `mergeTables`, `Chevron`, `TableIcon` are all reused as-is).

AR-12 hard invariant (stated in the mockup): the boot manager stays the DEFAULT target (`connectionId = null`/omitted), so Ephemeral mode (and any Persistent boot with a positional URL) stays byte-for-byte browsable exactly as today — it is NOT one of the `connections.list` entries. This story must surface that boot target too (when one is configured, per `connection.active()`) as its own root using the existing id-less `connect()` call, alongside the saved-connection roots — see the Block-If below; exact placement/labeling is confirmed in step-02. Zero-connections empty-state now means "no boot target AND zero saved connections" — the `isNoConnectionTarget` string-match hack is retired by this story (no bare speculative `connect()` is ever issued just to probe emptiness).

## Boundaries & Constraints

**Always:**
- Fetch `connections.list` (and `connection.active` for the boot-target check) once on mount; render one root per `ConnectionSummary` PLUS, if `connection.active().connection !== null`, one additional root for the boot target — all roots render immediately, collapsed, with an `idle` status dot. No RPC beyond these two fires at mount.
- Each root's introspection is LAZY: a saved-connection root's first expand fires `rpc("connect", { connectionId })` (Story 10.4); the boot root's first expand fires the existing id-less `rpc("connect")`. Re-expanding a root already `ready` or `error` reuses the cached state — no second `connect` call.
- Per-root state (`idle | loading | ready | error`) is independent per root. A `loading`/`error` root never blocks, dims, or delays any other root's own state or interaction.
- An `error` root renders the classified, engine-neutral `ConnectResult.failed` message (via the existing `envelopeText`-style terse formatting) inline with a "Reintentar" control that re-issues `connect` for that root only.
- Inside a `ready` root, preserve verbatim: schema-grouped table listing, `mergeTables` (introspected + `extraTables`), the table row's `role="button"`/`tabIndex=0`/Enter+Space activation calling `onActivate(table)` with the EXACT `SchemaTableInfo` shape, and column disclosure (`Chevron`, `TableIcon`, `typeDotClass`, PK → `text-t-key`/`bg-t-key`). Table/column disclosure keys are namespaced per root (e.g. `${connectionId ?? "boot"}::${schema}.${table}`) so two roots never collide in the `expanded` Set.
- `onSchemaLoaded` fires once PER ROOT, the first time that root reaches `ready` (not on cache-hit re-expand), passing that root's `DatabaseSchema.tables` — same payload shape as today, just potentially called more than once now.
- Zero-connections empty-state (`Sin conexión activa`, `SchemaTree.tsx:217-235`) renders only when there is NO boot target and `connections.list` is empty — never as a side effect of any individual root failing to connect.
- Match the mockup's (`epic-10-multi-connection-tree.mockup.html`) layout, spacing, and states exactly: `.root-head` (chevron + status-dot + name + engine-badge + host), `.status-dot` ok/err/loading (pulsing, `prefers-reduced-motion` respected), `introspecting…` inline loading text, `<schema> · N tables` caption, `.retry` button.
- Use the neutral theme tokens: `--ok`/`--ok-soft` for a connected dot, `--err`/`--err-soft` (Tailwind `bg-err`/`text-err`, NOT raw `red-500`/`red-400` — the current file's error styling at **190-193, 237** is off-token and must be corrected as part of this story) for an error dot/message, `--muted-foreground` for idle/loading.
- All existing keyboard operability (root header AND table row both `role="button"`/`tabIndex=0`/Enter+Space) is preserved — no mouse-only path anywhere in the tree.

**Block If:**
- If reconciling the boot manager's default target (`connectionId` omitted) with the `connections.list` roots cannot be done from the RPCs this story has available (`connections.list`, `connection.active`, id-optional `connect`/`table.rows` from 10.4) without inventing a NEW RPC or new contract field — HALT `blocked`, condition `boot-target root cannot be reconciled with the saved-connections list without a new RPC`. (Expected safe: `connection.active()` already tells the UI whether a boot target exists and its engine/host; render it as one extra root, pinned first, using the id-less `connect()` call — no new RPC needed. Confirm exact placement/label in step-02.)
- If per-root state cannot be kept structurally independent (e.g. a shared `LoadState` union forces one root's error to blank another's data) without a real per-`connectionId` map/store — HALT `blocked`, condition `per-root state cannot be isolated without a keyed store`. (Expected safe: `ReadonlyMap<string, RootState>` keyed by `connectionId` — or a reserved sentinel key for the boot root — mirrors the existing `expanded: ReadonlySet<string>` pattern already in the file.)

**Never:**
- Never introspect any root at mount — no `connect` call fires until a user expands that specific root (no handshake storm; 20 saved connections ⇒ 0 handshakes at boot).
- Never let one root's `loading`/`error` state read from, write to, or delay another root's state — the whole point of per-root isolation (epics.md Story 10.5 AC3 / Story 10.3 AC2).
- Never render raw driver text in a root's error — only the engine-neutral `ConnectResult.failed.message` the Core already classifies (AR-10/AR-6 posture, same as today's single-root error path).
- Never re-introspect a root on collapse→re-expand while its cached state is `ready` or `error` — collapsing is purely a visibility toggle.
- Never change the `onActivate(table: SchemaTableInfo)` callback's signature, the column type-dot classification (`typeDotClass`), or the PK coloring — Story 10.5 is additive multi-root plumbing around unchanged per-table/per-column rendering.
- Never regress the neutral Epic 7 theme — no coral, no raw Tailwind `red-*`/`green-*` utility in place of the `--ok`/`--err`/`--t-*` tokens.
- Never touch `src/shared/contract.ts`'s RPC method names/params beyond what Story 10.4 already adds (optional `connectionId` on `connect`/`table.rows`) — this story is a pure UI consumer of 10.4's contract, it does not extend it further.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|-----------------|
| Zero connections, no boot target | `connections.list` = `[]`, `connection.active().connection === null` | Empty-state renders (`Sin conexión activa` + CTA copy) — no roots, no RPC beyond the two mount calls | No error |
| N saved connections, no boot target | `connections.list` = N summaries | N collapsed roots render immediately, each `idle`, no `connect` fired yet | No error |
| Boot target configured (ephemeral, or persistent w/ boot URL) + M saved connections | `connection.active().connection !== null`, `connections.list` = M summaries | Boot root (pinned first) + M saved-connection roots all render collapsed/`idle` — matches today's ephemeral behavior for the boot root, byte-for-byte (AR-12) | No error |
| Expand a healthy idle root | user clicks/Enter/Space on a `.root-head` | Status dot → `loading` (pulsing), `introspecting…` inline text; on reply, dot → `ok`, tables grouped by schema render | `connect` transport failure → root goes to `error` with the mapped envelope text, not a crash |
| Expand a failing root (bad creds / unreachable / missing schema) | `connect{connectionId}` resolves `{ status: "failed", failure, message }` | That root shows the classified error inline + "Reintentar"; ALL other roots remain exactly as they were (untouched idle/loading/ready) | Root-scoped only, engine-neutral message |
| Collapse then re-expand a `ready` root | root already introspected once | Instantly re-shows the cached schema — NO second `connect` call | No error |
| Collapse then re-expand an `error` root | root already failed once | Instantly re-shows the cached error + Reintentar — NO automatic re-attempt (only the explicit Reintentar click re-fetches) | No error |
| Retry a failing root | click "Reintentar" | That root re-enters `loading`, re-issues `connect{connectionId}`, resolves to `ready` or a (possibly different) `error` — other roots unaffected | Same per-root isolation as first attempt |
| Table activation inside a `ready` root | click or Enter/Space on a table row | `onActivate(table)` fires with the table's `SchemaTableInfo`; row gets the `.on` highlight; first activation also expands its column list (existing expand-on-select semantics preserved) | No error |
| Column disclosure inside a `ready` root | click/Enter/Space on the already-active table row again | Toggles that table's column list (type-dot + PK coloring, `${root}::${schema}.${table}` keyed so it can't collide with a same-named table in a different root) | No error |
| Same table name active in two different roots | e.g. `public.orders` exists under both `demo-postgres` and `analytics` | KNOWN LIMITATION (deferred to Story 10.6): `activeTable: TableRef` carries only `schema`/`name`, no `connectionId`, so the `.on` highlight may highlight the same-named row in BOTH roots until 10.6 adds `connectionId` to `TableRef` — acceptable for this story, not a regression of anything shipped today (today there is only ever one root) | Documented, not fixed here |
| `connections.list` itself fails (transport/RPC error) | the mount-time `connections.list` call returns `ok: false` | Whole-tree top-level error state (mirrors today's single top-level error phase) — since without the list, no roots can be constructed at all | Terse mono error text, matches existing error-phase styling |
| Keyboard-only operation | Tab to a root header, Enter/Space to expand; Tab into its tables, Enter/Space to activate/disclose | Fully keyboard-operable end to end — no mouse-only path anywhere in the tree (root headers AND table rows both `role="button"`/`tabIndex=0`) | No error |

</intent-contract>

## Acceptance Criteria

- **Given** N saved connections, **when** the workspace opens, **then** the schema sidebar renders N collapsible root nodes — one per connection, each showing name + engine badge + host + a status dot — and every root renders immediately WITHOUT introspecting (zero `connect` calls fire at mount regardless of N).
- **Given** a collapsed, `idle` connection root, **when** I expand it, **then** it introspects lazily at that moment via `connect{connectionId}` (Story 10.4), visibly progressing `idle → loading (introspecting…) → ready`; once ready, it lists tables grouped by schema, and each table expands to its columns with type-dots + PK coloring, exactly as the single-root tree does today.
- **Given** one connection root fails to introspect (bad creds, unreachable, missing/invisible schema), **when** it is expanded, **then** that root shows the classified, engine-neutral error inline with a Reintentar affordance, and every OTHER root — including the boot target's root, if present — stays fully usable; a single failing connection never tanks the whole tree.
- **Given** a root that has already reached `ready` or `error` once, **when** I collapse and re-expand it, **then** it shows the cached state instantly with no second `connect` call.
- **Given** zero saved connections and no configured boot target, **when** the workspace opens, **then** the tree shows the existing calm "Sin conexión activa" empty-state, never a red error.

## Code Map

<!-- Light — step-02 reconciles exact line numbers against the current tree. -->

- `src/ui/schema/SchemaTree.tsx` — the primary rewrite: replace the single `LoadState` + one mount-effect with (a) a `connections.list` + `connection.active` mount fetch producing the root list, (b) a per-root `RootState` (`idle|loading|ready|error`) keyed by `connectionId` (boot root uses a reserved sentinel key), (c) an `expandedRoots: ReadonlySet<string>` toggle set (mirrors the existing `expanded` Set pattern for column disclosure — same technique, new axis), (d) root-scoped rendering of the EXISTING per-table/per-column JSX (`Chevron`, `TableIcon`, `typeDotClass`, `mergeTables`) with expanded-key namespaced by root. `isNoConnectionTarget` and the old single `connect()`-drives-emptiness logic are retired (emptiness is now `connections.list.length === 0 && no boot target`, never inferred from a failed `connect`).
- `src/ui/workspace/Workspace.tsx` — likely NO prop-shape change (`activeTable`/`onActivate`/`onSchemaLoaded`/`extraTables` stay as-is); confirm in step-02 whether `onSchemaLoaded` firing more than once needs any caller-side change (App.tsx's `setSchemaTables`).
- `src/shared/contract.ts` — NO change beyond what Story 10.4 lands (`connectionId` optional on `connect`/`table.rows`); `ConnectionSummary`, `ActiveConnectionInfo`, `ListConnectionsResult` already exist and are reused as-is.
- `_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html` — visual + interaction source of truth for the root layout, status-dot states, and the empty-state; reference only, not shipped code.

## Tasks & Acceptance

> Light on purpose — the loop's dev planner (step-02) enriches this.

**Execution:**
- [ ] Fetch `connections.list` + `connection.active` on mount; build the root list (boot root, if present, pinned first).
- [ ] Implement per-root `idle|loading|ready|error` state keyed by `connectionId`/boot sentinel; wire lazy `connect{connectionId}` (or id-less for boot) on first expand only, with a cache-hit no-refetch on re-expand.
- [ ] Render root header (chevron + status dot + name + engine badge + host) matching the mockup; wire keyboard (Enter/Space) + click expand/collapse.
- [ ] Render error root inline (classified message + Reintentar) without touching other roots' state.
- [ ] Re-scope the existing ready-root body (schema grouping, table activation, column disclosure) per root with namespaced expansion keys; verify `onActivate`/`onSchemaLoaded` contracts unchanged in shape.
- [ ] Fold the zero-connections-and-no-boot-target case into the existing empty-state render; retire `isNoConnectionTarget`.
- [ ] Swap raw `red-500`/`red-400` error styling for the `--err`/`--err-soft` tokens (`bg-err`/`text-err`).

**Acceptance Criteria:**
- Given N saved connections (+ optional boot target), when the tree mounts, then N(+1) roots render collapsed/idle with zero `connect` calls fired.
- Given any one root's expand/error/retry cycle, when observed, then every other root's state is provably untouched (no shared mutable state crossing roots).
- Given the full suite, when run, then `bunx tsc --noEmit`, `bun test`, and `bun run build` all pass with new coverage for the multi-root state machine and no weakened existing SchemaTree assertion.

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Empty until the first bad_spec loopback. -->

## Review Triage Log

<!-- Append-only. Populated by step-04 on every review pass. Empty until the first review pass. -->
