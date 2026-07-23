---
title: 'Story 10.5: Multi-root schema tree — one collapsible root per saved connection, lazy introspection'
type: 'feature'
created: '2026-07-21'
status: done
baseline_revision: '6e467dc'
final_revision: '8d3f29f'
review_loop_iteration: 0
followup_review_recommended: true
depends_on:
  - '10-4-core-resolve-by-connection-id'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'  # Epic 10 / Story 10.5
  - '{project-root}/_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html'
  - '{project-root}/src/ui/schema/SchemaTree.tsx'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** `SchemaTree` (`src/ui/schema/SchemaTree.tsx`) is single-connection: on mount it fires exactly ONE bare `rpc("connect")` (no id) and renders one flat table list for whatever the Core's boot manager is bound to. In Persistent mode with no boot URL, that call fails with `unsupported_scheme: "no connection target configured"`, string-matched by `isNoConnectionTarget` into a calm "Sin conexión activa" empty-state (**32-52, 217-235**) — the interim fix. But there is no way to actually BROWSE a saved connection (`connections.list`) from the tree at all: you can save N connections in Settings and still see nothing. This story makes the tree genuinely multi-connection: N saved connections ⇒ N collapsible root nodes, DBeaver-style, each introspecting only when the user asks for it — not 20 handshakes at boot for 20 saved connections.

**Approach:** Fetch `connections.list` on mount — and again on every registry mutation, per the REGISTRY-DRIVEN REFRESH rule (IG-A) — to get the credential-free `ConnectionSummary[]`. Render one collapsible ROOT per summary (name + engine badge + host + status dot + chevron, mirroring the mockup's `.root-head`), rendered INSTANTLY and UNINTROSPECTED. Each root owns its own `idle | loading | ready | error` state, keyed by `connectionId`, independent of every other root — expanding a root that is `idle` triggers `connect{connectionId}` (Story 10.4) exactly once; expanding a root that is already `ready`/`error` (cached) does NOT re-fetch; collapsing never discards the cached state, only visibility. A root's `error` (classified, engine-neutral `ConnectResult.failed`) renders inline with a "Reintentar" retry affordance and never affects any other root — one bad connection cannot tank the tree. Inside a `ready` root, everything the current single-root tree does today is preserved verbatim and simply re-scoped per root: schema grouping, the table-activation callback (click + Enter/Space keyboard), and column disclosure with type-dot + PK coloring (`typeDotClass`, `mergeTables`, `Chevron`, `TableIcon` are all reused as-is).

AR-12 hard invariant (stated in the mockup): the boot manager stays the DEFAULT target (`connectionId = null`/omitted), so Ephemeral mode (and any Persistent boot with a positional URL) stays byte-for-byte browsable exactly as today — it is NOT one of the `connections.list` entries. This story must surface that boot target too (when one is configured, per `connection.active()`) as its own root using the existing id-less `connect()` call, alongside the saved-connection roots — see the Block-If below; exact placement/labeling is confirmed in step-02. Zero-connections empty-state now means "no boot target configured AND zero saved connections" — the `isNoConnectionTarget` string-match hack is retired by this story (no bare `connect()` is ever issued merely to PROBE emptiness; the boot root's mount-time id-less `connect` per the IG-2 ruling is not a probe, it is that root's own introspection, and it only fires when a boot target actually exists).

**Schema is a collapsible LEVEL, not a flat caption (confirmed with the user — DBeaver model).** A Postgres/MySQL database has MANY schemas (`public`, `auth`, `reporting`, `staging`…), so inside a `ready` root the tables are grouped under a collapsible SCHEMA node — one level between the connection root and its tables: `connection → schema → tables`. Each schema node is a chevron + schema-folder icon + schema name + per-schema table count, and owns its OWN `expandedSchemas` visibility state (keyed `${connectionId ?? "boot"}::${schema}`), independent of both the root's expand state and per-table column disclosure. This REPLACES the current flat, non-collapsible `<schema> · N tables` caption. User-confirmed conveniences (see the mockup): (a) a root whose introspection returns exactly ONE schema auto-expands that schema on first `ready`, so the common `public`-only case needs no forced double-click, while a multi-schema root stays collapsed so it scales; (b) the `public` schema is tagged `default`. A connection carrying a Story-10.2 pinned `schema` introspects scoped to that one schema, so only that single schema node appears (auto-expanded per rule a) and the root shows a small pinned badge — the tree code renders whatever schemas the `DatabaseSchema` contains, so pinning is transparent to it.

**Views vs tables — OUT OF SCOPE here (contract gap).** The mockup draws views with a distinct icon, but `SchemaTableInfo` (`contract.ts:275`) carries only `schema`/`name`/`columns`/`primaryKey` — no `kind`/`isView` discriminator, and the introspection queries don't surface one. So a table-vs-view icon is NOT buildable in this story (10.5 is a pure UI consumer of 10.4's contract). Flag as an open question for step-02 → deferred-work candidate: add `kind: "table" | "view"` to `SchemaTableInfo` + the pg/mysql introspection (a small follow-up), THEN the view icon lands. Until then all relations render with the table icon (no regression — today's tree already does).

## Boundaries & Constraints

**Always:**
- Fetch `connections.list` (and `connection.active` for the boot-target check) on mount AND on every registry mutation (see the next rule); render one root per `ConnectionSummary` PLUS, if a boot target exists, one additional root for the boot target. Saved-connection roots render immediately, collapsed, with an `idle` status dot.
- **REGISTRY-DRIVEN REFRESH (resolved 2026-07-22, IG-A — human ruling; SUPERSEDES the original "once on mount").** `SchemaTree` lives permanently in the left panel (`Workspace.tsx:339`) while Settings is a TAB in the same React tree, so a mount-only fetch froze the root list for the whole session: saving a connection added no root until an app restart — verbatim the Intent's opening complaint, and the zero-connections empty-state's CTA invited exactly that dead-end. Therefore: **whenever the connection registry mutates (a connection is saved, edited or removed in `SettingsPanel`), the tree re-reads `connections.list` and reconciles its roots.** Wire it from the mutation itself (the panel already knows when it succeeds) — NOT from a tab-close event, and NOT via a new refresh control in the tree header (the mockup has none and this story adds no chrome). Reconciliation rules: a NEW summary appears as a fresh `idle` collapsed root; a REMOVED summary's root disappears (along with its cached state); a root that is already `loading`/`ready`/`error` and still present KEEPS its cached state and expand state verbatim — a refresh must never re-introspect, collapse, or blank a root the user already opened. The boot root is unaffected (it is not a registry entry). What happens to an OPEN TAB whose connection was removed stays out of scope here — that is Story 10.6.
- **BOOT-ROOT MOUNT EXCEPTION (resolved 2026-07-22, IG-2 — human ruling).** The boot root auto-expands and introspects AT MOUNT via the existing id-less `rpc("connect")`, exactly as today's tree does. This is not an optimisation, it is load-bearing: that call is the ONLY thing that populates `App.tsx`'s `schemaTables`, which the ERD (`no tables to diagram` without it), the create-table schema selector (no options without it), and primary-key resolution for RESTORED table tabs (`row-mutations.ts:132` throws `expected exactly one primary-key column, got 0` without it) all read. AR-12's "byte-for-byte browsable exactly as today" requires it. The lazy rule's stated rationale — 20 saved connections must not mean 20 handshakes — is untouched, because the boot root is exactly ONE. Net RPCs at mount: `connections.list` + `connection.active` + at most one id-less `connect` (only when a boot target exists). Nothing else.
- Each SAVED-CONNECTION root's introspection is LAZY: its first expand fires `rpc("connect", { connectionId })` (Story 10.4). Re-expanding a root already `ready` or `error` reuses the cached state — no second `connect` call. The boot root introspects at mount instead (above); its "Reintentar" re-issues the id-less `rpc("connect")`.
- Per-root state (`idle | loading | ready | error`) is independent per root. A `loading`/`error` root never blocks, dims, or delays any other root's own state or interaction.
- An `error` root renders the classified, engine-neutral `ConnectResult.failed` message (via the existing `envelopeText`-style terse formatting) inline with a "Reintentar" control that re-issues `connect` for that root only.
- Inside a `ready` root, group tables under a COLLAPSIBLE schema level (`connection → schema → tables`): a schema node = chevron + schema-folder icon + name + per-schema table count, with its own visibility keyed `${connectionId ?? "boot"}::${schema}` in an `expandedSchemas` Set (separate from column disclosure). A single-schema root auto-expands its one schema on first `ready`; multi-schema roots stay collapsed. Tag the `public` schema `default`. (A view-vs-table icon is OUT OF SCOPE — the contract carries no view discriminator; see Approach.) This replaces the flat `<schema> · N tables` caption at `SchemaTree.tsx:184-189`.
- **TARGETED ACTIVATION (resolved 2026-07-22, IG-1 — human ruling).** `onActivate` IS widened by this story to carry the owning root's target: `onActivate(table: SchemaTableInfo, connectionId: string | null)`, where `null` means the boot root. The tab bound by that activation RETAINS the `connectionId` and targets **every** Core call it makes with it — **reads AND writes, without exception**: `table.rows` (`TabContent.tsx:144`), `execute` for cell edits / row DML / DDL (`TabContent.tsx:191`, whose `ExecuteRequest.connectionId` Story 10.4 already provides), and any metadata lookup that feeds them — notably `App.tsx:418-436`, which resolves `primaryKeys`/`indexes` out of `allTables` by `schema`+`name` ALONE and must also match the ref's `connectionId`, or a same-named table in another root supplies the primary key for a write. So rows always come from the database the user actually clicked in, and **a write can never land in a different database than the one on screen** — a cross-database WRITE is strictly worse than the cross-database read this ruling exists to kill. Without this, expanding a saved connection and clicking one of ITS tables reads the BOOT database — either an incomprehensible `not_found` or, worse, another database's rows silently rendered under that name. The I/O matrix knowingly accepts a COSMETIC cross-root highlight collision below; it never accepts a wrong-data READ. **Scope of the 10.6 slice pulled forward: exactly this — the callback signature, the tab's in-memory `connectionId`, and the targeted `table.rows` call, including adding `connectionId` to `TableRef` if the implementation needs it. Everything else stays in 10.6: PERSISTING the id in the workspace snapshot, RESTORING it, and surviving the removal of that connection.** A tab's retained `connectionId` is session-only in this story.
- Inside a schema node, preserve verbatim: `mergeTables` (introspected + `extraTables`), the table row's `role="button"`/`tabIndex=0`/Enter+Space activation (now calling `onActivate(table, connectionId)` per the ruling above, with the `SchemaTableInfo` shape itself unchanged), and column disclosure (`Chevron`, `TableIcon`, `typeDotClass`, PK → `text-t-key`/`bg-t-key`). Table/column disclosure keys are namespaced per root (e.g. `${connectionId ?? "boot"}::${schema}.${table}`) so two roots never collide in the `expanded` Set.
- `onSchemaLoaded` fires once PER ROOT, the first time that root reaches `ready` (not on cache-hit re-expand), passing that root's `DatabaseSchema.tables` — same payload shape as today, just potentially called more than once now.
- Zero-connections empty-state (`Sin conexión activa`, `SchemaTree.tsx:217-235`) renders only when there is NO boot target configured AT ALL and `connections.list` is empty — never as a side effect of any individual root failing to connect, and never for a boot target that IS configured but broken (see next).
- **MISCONFIGURED BOOT TARGET IS DISTINGUISHABLE (IG-3, narrowed 2026-07-22 by the IG-B ruling).** `ConnectionManager.describe()` returns `null` both for "no URL configured" and for a configured URL it cannot describe, so the UI could not tell "nothing configured" from "configured but broken" and showed the calm empty-state for both. **Corrected premise (IG-B):** a genuinely unparseable `--url` is NOT reachable — `cli-args.ts:104-114` shape-checks it with `new URL()` and throws `CliArgsError` → `exit(1)` before any UI exists. The one real case is a URL that PARSES but has no host (e.g. `postgres:///shop`, `connection.test.ts:361`). Authorised extension, **narrowed to a BOOLEAN**: a single "a boot target is configured" predicate (e.g. `ConnectionManager.hasTarget()` surfaced on `connection.active`'s reply) — NOT a tri-state. **Required observable behavior:** when a boot target IS configured but cannot be described, the boot root renders in `error` with "Reintentar" instead of the empty-state; only a genuinely absent boot target contributes no root. **The failure classification is whatever the Core already produces for that URL (`host`/`network` for a hostless one) — this story does NOT require, and must not force, `malformed-url`.** Engine-neutral posture unchanged: never raw driver text, never echo credentials from the URL.
- Match the mockup's (`epic-10-multi-connection-tree.mockup.html`) layout, spacing, and states exactly: `.root-head` (chevron + status-dot + name + engine-badge + host), `.status-dot` ok/err/loading (pulsing, `prefers-reduced-motion` respected), `introspecting…` inline loading text, `<schema> · N tables` caption, `.retry` button.
- Use the neutral theme tokens: `--ok`/`--ok-soft` for a connected dot, `--err`/`--err-soft` (Tailwind `bg-err`/`text-err`, NOT raw `red-500`/`red-400` — the current file's error styling at **190-193, 237** is off-token and must be corrected as part of this story) for an error dot/message, `--muted-foreground` for idle/loading.
- All existing keyboard operability (root header AND table row both `role="button"`/`tabIndex=0`/Enter+Space) is preserved — no mouse-only path anywhere in the tree.

**Block If:**
- If reconciling the boot manager's default target (`connectionId` omitted) with the `connections.list` roots cannot be done from the RPCs this story has available (`connections.list`, `connection.active`, id-optional `connect`/`table.rows` from 10.4) without inventing a NEW RPC or new contract field — HALT `blocked`, condition `boot-target root cannot be reconciled with the saved-connections list without a new RPC`. (Expected safe: `connection.active()` already tells the UI whether a boot target exists and its engine/host; render it as one extra root, pinned first, using the id-less `connect()` call. Confirm exact placement/label in step-02.) **This Block-If does NOT fire for the two contract extensions the human rulings already authorised** — `connectionId` on `TableRef` (IG-1) and the misconfigured-boot-target distinction (IG-3); those are approved scope, not a reason to halt.
- If per-root state cannot be kept structurally independent (e.g. a shared `LoadState` union forces one root's error to blank another's data) without a real per-`connectionId` map/store — HALT `blocked`, condition `per-root state cannot be isolated without a keyed store`. (Expected safe: `ReadonlyMap<string, RootState>` keyed by `connectionId` — or a reserved sentinel key for the boot root — mirrors the existing `expanded: ReadonlySet<string>` pattern already in the file.)

**Never:**
- Never introspect any SAVED-CONNECTION root at mount — no `connect{connectionId}` fires until the user expands that specific root (no handshake storm; 20 saved connections ⇒ 0 handshakes at boot). **This rule does NOT cover the boot root** — see the BOOT-ROOT MOUNT EXCEPTION in Always (IG-2 ruling).
- Never let one root's `loading`/`error` state read from, write to, or delay another root's state — the whole point of per-root isolation (epics.md Story 10.5 AC3 / Story 10.3 AC2).
- Never render raw driver text in a root's error — only the engine-neutral `ConnectResult.failed.message` the Core already classifies (AR-10/AR-6 posture, same as today's single-root error path).
- Never re-introspect a root on collapse→re-expand while its cached state is `ready` or `error` — collapsing is purely a visibility toggle.
- Never change the column type-dot classification (`typeDotClass`) or the PK coloring — Story 10.5 is additive multi-root plumbing around unchanged per-table/per-column rendering. (`onActivate` IS widened by this story — see the TARGETED ACTIVATION ruling in Always, IG-1. The `SchemaTableInfo` shape it passes is still unchanged.)
- Never regress the neutral Epic 7 theme — no coral, no raw Tailwind `red-*`/`green-*` utility in place of the `--ok`/`--err`/`--t-*` tokens.
- Never touch `src/shared/contract.ts`'s RPC method names/params beyond Story 10.4's additions (optional `connectionId` on `connect`/`table.rows`) and the TWO extensions this story's human rulings authorise: (1) `connectionId` on `TableRef` if targeted activation needs it (IG-1), and (2) the misconfigured-boot-target distinction (IG-3). Nothing else.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|-----------------|
| Zero connections, no boot target | `connections.list` = `[]`, `connection.active().connection === null` | Empty-state renders (`Sin conexión activa` + CTA copy) — no roots, no RPC beyond the two mount calls | No error |
| N saved connections, no boot target | `connections.list` = N summaries | N collapsed roots render immediately, each `idle`, no `connect` fired yet | No error |
| Boot target configured (ephemeral, or persistent w/ boot URL) + M saved connections | boot target exists, `connections.list` = M summaries | Boot root (pinned first) renders EXPANDED and immediately `loading` → `ready` from its mount-time id-less `connect` (IG-2 ruling); the M saved-connection roots render collapsed/`idle` with no `connect` fired. `onSchemaLoaded` fires for the boot root at mount, so `App.tsx`'s `schemaTables` is populated exactly as today, byte-for-byte (AR-12) | Boot `connect` failure → boot root in `error` + Reintentar; saved roots untouched |
| Boot target configured but not describable (hostless `--url`, e.g. `postgres:///shop`) | boot URL parses, no host ⇒ `describe()` → `null` while the boolean says a target IS configured | Boot root renders in `error` + "Reintentar" — NOT the "Sin conexión activa" empty-state (IG-3, narrowed by IG-B). Saved roots unaffected. **Assert only that it is an error root with the Core's own engine-neutral message — do NOT assert `malformed-url`** (the driver classifies a hostless URL as `host`/`network`) | Classified by the Core, engine-neutral; no raw driver text, no credentials echoed |
| Save / edit / remove a connection in Settings while the tree is mounted | `SettingsPanel` mutation succeeds | Tree re-reads `connections.list` and reconciles: new summary ⇒ fresh `idle` collapsed root; removed summary ⇒ its root and cached state disappear; surviving roots keep their cached state AND expand state untouched — no re-introspection, no collapse, no blanking (IG-A ruling). Boot root unaffected | A failed refetch leaves the current roots standing and surfaces the same non-fatal warning as IG-4 |
| Add the FIRST connection from the empty-state CTA | empty-state visible, user saves a connection in Settings | The empty-state is replaced by that connection's root, without an app restart — the CTA's promise is honored (IG-A ruling) | No error |
| Expand a healthy idle root | user clicks/Enter/Space on a `.root-head` | Status dot → `loading` (pulsing), `introspecting…` inline text; on reply, dot → `ok`, tables grouped under collapsible SCHEMA nodes render | `connect` transport failure → root goes to `error` with the mapped envelope text, not a crash |
| Expand a MULTI-schema root | ready root returns schemas `public`/`auth`/`reporting`/`staging` | Each schema renders as a collapsed node (chevron + folder icon + name + table count); `public` tagged `default`; clicking a schema expands its tables; other schemas stay collapsed | No error |
| Expand a SINGLE-schema root | ready root returns exactly one schema (e.g. `public`) | That one schema auto-expands on first `ready` (no forced double-click); its tables show immediately | No error |
| Pinned-schema root (Story 10.2) | connection has a pinned `schema`; introspection is scoped to it | Only the one pinned schema node appears (auto-expanded), root shows a pinned badge; tree code is unchanged (it renders whatever schemas `DatabaseSchema` contains) | No error |
| Collapse then re-expand a schema node | schema already expanded once | Pure visibility toggle — no re-introspection (introspection is per-ROOT, not per-schema) | No error |
| Views in a schema | schema contains views (e.g. `reporting.revenue_by_country`) | Render with the SAME table icon as tables (contract has no view discriminator — a distinct view icon is deferred, see Approach); activation/column-disclosure identical | No error |
| Expand a failing root (bad creds / unreachable / missing schema) | `connect{connectionId}` resolves `{ status: "failed", failure, message }` | That root shows the classified error inline + "Reintentar"; ALL other roots remain exactly as they were (untouched idle/loading/ready) | Root-scoped only, engine-neutral message |
| Collapse then re-expand a `ready` root | root already introspected once | Instantly re-shows the cached schema — NO second `connect` call | No error |
| Collapse then re-expand an `error` root | root already failed once | Instantly re-shows the cached error + Reintentar — NO automatic re-attempt (only the explicit Reintentar click re-fetches) | No error |
| Retry a failing root | click "Reintentar" | That root re-enters `loading`, re-issues `connect{connectionId}`, resolves to `ready` or a (possibly different) `error` — other roots unaffected | Same per-root isolation as first attempt |
| Table activation inside a `ready` root | click or Enter/Space on a table row | `onActivate(table, connectionId)` fires with the table's `SchemaTableInfo` plus its owning root's target (`null` = boot); the bound tab retains that id and its `table.rows` calls carry it, so the rows come from the clicked database (IG-1 ruling); row gets the `.on` highlight; first activation also expands its column list (existing expand-on-select semantics preserved) | An unresolvable/removed target surfaces 10.4's typed `not_found` in the tab, never another database's rows |
| Column disclosure inside a `ready` root | click/Enter/Space on the already-active table row again | Toggles that table's column list (type-dot + PK coloring, `${root}::${schema}.${table}` keyed so it can't collide with a same-named table in a different root) | No error |
| Same table name active in two different roots | e.g. `public.orders` exists under both `demo-postgres` and `analytics` | COSMETIC-ONLY tolerance: if the IG-1 implementation puts `connectionId` on `TableRef`, the `.on` highlight is exact and this case disappears. If it threads the id without touching `TableRef`, the highlight may still mark the same-named row in BOTH roots — acceptable, not a regression (today there is only ever one root). **The rows themselves are never ambiguous either way** — those come from the tab's retained `connectionId` | Highlight only; a wrong-data READ is never acceptable here |
| `connections.list` itself fails (transport/RPC error) | the mount-time `connections.list` call returns `ok: false` | **NOT a whole-tree error when a boot target exists (IG-4 ruling).** The boot root is built from `connection.active` alone and renders normally (expanded + introspecting per IG-2); the registry failure surfaces as a NON-FATAL warning above the roots, saying the saved-connection list could not be loaded. An ephemeral session never uses the credential registry, so its working tree must not die for it. Only when there is ALSO no boot target does the failure become the whole-tree error state | Terse mono text, existing error-phase styling; warning is dismissible-free and never blocks the boot root |
| Keyboard-only operation | Tab to a root header, Enter/Space to expand; Tab into its tables, Enter/Space to activate/disclose | Fully keyboard-operable end to end — no mouse-only path anywhere in the tree (root headers AND table rows both `role="button"`/`tabIndex=0`) | No error |

</intent-contract>

## Code Map

> Line references verified against `HEAD` = `6e467dc` (Story 10.4 landed). **The intent contract's line numbers predate Story 10.1** — reconciled here: `isNoConnectionTarget` no longer exists anywhere in `src` (10.1 replaced it with the typed `failure === "no-target"` check), so "retiring the string-match hack" is already done; what 10.5 retires is the *speculative bare `connect()` used to probe emptiness*.

> **Post-implementation (2026-07-22):** the bullets below now describe what SHIPPED, not the pre-story baseline. Line numbers are `HEAD` = `6e467dc` + this story's diff.

- `src/ui/schema/SchemaTree.tsx` (rewritten, 313 → 662 lines) — the primary rewrite. GONE: `LoadState` (the 4-phase union, replaced by the tree-level `TreePhase` plus a per-root `RootState` map), `mergeTables` (moved to the state module), the `.conn-row` status header (per-root dots replace it — its `bg-red-500` went with it), and the flat `${engine} · N tables` caption (now the static `connections` label). KEPT verbatim: `Chevron`, `TableIcon`, `typeDotClass`, the `Sin conexión activa` empty-state (new trigger: `roots.length === 0`), the tree-level `role="alert"` error (tokenized `text-red-400` → `text-err`), the table row's `role="button"`/`tabIndex`/`aria-pressed`/Enter+Space activation with expand-on-select + re-click-to-collapse, and the column disclosure with type-dot + PK ink. NEW: `TreePhase` (`loading | error | roots{roots, warning}`); four keyed stores (`states: ReadonlyMap<string, RootState>` + `expandedRoots`/`expandedSchemas`/`expandedTables` as `ReadonlySet<string>`); `activeRef` (the mount-time `ActiveConnectionInfo`, reused by the refresh); `alive` ref (guards click-initiated fetches); `loadRoot` (one-key functional writes, paramless `connect` for the boot root, auto-expand seeding, `onSchemaLoaded` on the `ready` transition only); the mount effect (`Promise.all([connection.active, connections.list])` + the boot root's auto-expand/introspect); the `registryRevision` refresh effect (re-read + `buildRoots` + prune); `toggleRoot`/`toggleSchema`/`activateTable`; `statusDotClass`; `SchemaIcon`; `onRowKeyDown`; and the exported presentational `ConnectionRoot`.
- `src/ui/schema/schema-tree-state.ts` — **NEW** (262 lines). All DOM-free logic so the multi-root state machine is unit-testable: the repo has no jsdom/testing-library and `renderToStaticMarkup` never runs effects, so logic left inside the component is untestable by construction. Exports `BOOT_ROOT_KEY`/`BOOT_ROOT_FALLBACK_NAME`, `rootKey`/`schemaKey`/`tableKey`, `RootDescriptor`/`RootState`/`SchemaGroup`, `bootDescriptor`, `buildRoots`, `groupBySchema`, `mergeTables`, `connectStateFromReply`, `shouldFetchOnExpand`, `autoExpandKeys`, `pruneByRoot`, `pruneSetByRoot`.
- `src/ui/rpc/client.ts:39` — `rpc<T>(method, params?): Promise<RpcReply<T>>`; never throws, always resolves to an envelope (transport failure → `internal_error`/"request failed"; 10s `AbortController` timeout at `:26`). `src/ui/rpc/envelope-text.ts:11-12` — `envelopeText(error)` → `` `${code}: ${message}` `` (+ ` (detail)`), the shared terse formatter.
- `src/shared/contract.ts` — **ONE authorised change** (IG-3, narrowed by IG-B): `ActiveConnectionInfo` (`:434-453`) gains `readonly hasTarget: boolean` — the single "a boot target is configured" predicate, required (not optional) so no call site can silently forget it. Nothing else moves. Unchanged and consumed as-is: `:225-229` `SchemaColumnInfo`; `:275-282` `SchemaTableInfo`; `:288-291` `DatabaseSchema` (`engine` + flat `tables[]`, each table carrying its own `schema` namespace); `:309-316` `ConnectionFailureKind`; `:324-330` `ConnectResult` (`{status:"connected", schema}` | `{status:"failed", failure, message}`); `:338-340` `ConnectRequest` (`connectionId?: string | null`); `:394-415` `ConnectionSummary` (`id`/`name`/`host`/`engine` + **optional `schema` key present only when pinned**); `:434-442` `ActiveConnectionInfo` (`{mode, connection: {engine, host, database?} | null}` — no id/name/schema); `:475` `ListConnectionsResult`; `:1028-1046` `RpcReply`/`okReply`/`errorReply`.
- `src/core/server.ts:388-394` `connect(params)` — validates via `readConnectionId` (`:323-336`) → `bad_request`; resolves via `connectionTargets` → `targetError` (`connection-targets.ts:139-143`: `not_found` / `internal_error`); success rides as `okReply(ConnectResult)`, so a classified driver failure is `{ok:true, result:{status:"failed"}}`, never an envelope error. `:515-522` `activeConnection` now returns `{mode, connection: connectionManager.describe(), hasTarget: connectionManager.hasTarget()}` — still a pure read that opens no driver.
- `src/core/connection.ts` — `ConnectionManager` gains `hasTarget(): boolean` (type at `:112-121`, impl at `:465-469`): `databaseUrl !== null`, nothing parsed, no driver opened. It exists because `describe()` (`:451-464`) answers `null` for BOTH "no url" and "a url it cannot describe" (unparseable, or parseable-but-hostless), which is exactly the distinction IG-3 needs.
- `src/ui/workspace/Workspace.tsx:16` `useState` import; `:19` `SchemaTree` import; `:304-307` `activeTable` derivation; `:313-320` the NEW `registryRevision` counter (state lives here — the nearest common ancestor of the tree and the Settings tab body); `:344-350` the `<SchemaTree>` call site (now also passing `registryRevision`); `:263`/`:265` the widened `onActivateTable`/`onSchemaLoaded` prop types; `:399` `onRegistryChanged` handed to `TabContent`; `:429` the status-bar Stop button, now `text-err`/`hover:bg-err-soft` (DW-54); `:201-210` `ExposureBanner` (DW-54 residual — see Folded Deferred-Work).
- `src/ui/App.tsx:310` `schemaTables`; `:311-317` `createdTables` + `onTableCreated`; `:319-347` the NEW `onSchemaLoaded(tables, connectionId)` handler — accepts the BOOT root only and filters retired optimistic entries out of `createdTables` (both halves of DW-41); `:399-402` `allTables = [...schemaTables, ...createdTables]`; `:405-418`/`:421-434`/`:439-448` the `schemas`/`primaryKeys`/`indexes` lookups — the latter two now bail on a non-null `ref.connectionId` so a saved-connection tab can never borrow the boot catalog's primary key for a WRITE; `:662-670` `onActivateTable` binds `{schema, name, connectionId}`; `:671` `onSchemaLoaded={onSchemaLoaded}`; `:176` ConnectionIndicator and `:216` SaveIndicator, both `bg-red-500` → `bg-err` (DW-54).
- `src/ui/workspace/workspace-state.ts:49-63` — `TableRef` gains `connectionId?: string | null` (IG-1). SESSION-ONLY: `toWorkspaceSnapshot` (`:382-417`) maps persisted tabs field-by-field (`{id, kind, title}`) and never emits `table`, so tsc-provably nothing here can reach disk — persisting/restoring it stays Story 10.6.
- `src/ui/workspace/TabContent.tsx:130-135` — `connectionScope` (`{}` for the boot target, `{connectionId}` otherwise) spread into BOTH `table.rows` (`:147-155`) and the structured-mutation `execute` (`:190-196`), plus `table.connectionId` added to the fetch effect's deps (`:181`) and to the per-table remount `key` (`:549`). `:495`/`:536`/`:624-630` the new `onRegistryChanged` pass-through to `SettingsPanel`.
- `src/ui/settings/SettingsPanel.tsx:222-237` — the new optional `onRegistryChanged` prop, fired at `:310`/`:330`/`:345` on each SUCCESSFUL add/edit/remove (never on a failure — nothing changed to reconcile).
- `src/ui/styles/globals.css` — Tailwind v4, no JS config; `@theme inline` at `:176-229` already exposes `bg-ok`/`bg-ok-soft` (`:212-213`), `text-err`/`bg-err` (`:224`), `bg-err-soft` (`:225`), `border-err-line` (`:226`), `text-t-*` (`:197-206`), `bg-coral-soft`/`text-coral` (`:193-196` — these ARE the neutral ink tokens, `--coral: #ececec`). `--err`/`--err-soft`/`--err-line` are declared dark-only at `:81-83` **by deliberate Story-7.3 decision documented at `:75-80`** — do NOT add light overrides here (DW-54 residual).
- `src/ui/schema/schema-tree-state.test.ts` (294 lines, 24 cases) and `src/ui/schema/SchemaTree.test.tsx` (282 lines, 14 cases) — **NEW**, the story's two test files; see the tasks for what each asserts.
- `src/ui/workspace/ChatTabView.test.tsx:34-38,51-55` — one of the repo's four `mock.module("../rpc/client.ts", …)` precedents (with `ReportTabView.test.tsx:21`, `ProvidersPanel.test.tsx:24`, `run-raw-query.test.ts:36`), and the one this story copied: `mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }))` **before** a dynamic `await import(...)`, `rpcMock.mockClear()` in `beforeEach`. `src/ui/workspace/ErdTabView.test.tsx:20-42,44-77` — the `renderToStaticMarkup` + static-fixture precedent. There is **no existing test** for `SchemaTree`, `Workspace.tsx`, or `App.tsx`.
- `_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html` — visual/interaction source of truth (reference only, not shipped). Indent ladder root `pl-2` → schema `pl-6` → table `pl-11` → columns wrapper `pl-[62px]`; `.row-base` = `flex items-center gap-[7px] mx-1.5 my-px rounded-[var(--radius)] cursor-pointer select-none hover:bg-muted`; status dot 7px with `--ok`/`--ok-soft`, `--err`/`--err-soft`, muted + pulse for loading; `.inline-msg` `pl-11 text-[11px]` (root-level variant `pl-[26px]`), `.retry` `ml-[26px] border border-border rounded-[var(--radius)] px-2.5 py-[3px] text-[11px]`.

## Tasks & Acceptance

> **Post-implementation (2026-07-22).** Ticked as landed. Where a task as WRITTEN contradicted the
> amended `<intent-contract>` (which always wins), the task text was REWRITTEN to describe what was
> actually built, and the IG-A / IG-1 / IG-3 / IG-4 work that had no task at all was added below.
> Every rewrite says so on its own `-- Rationale:` line.

**Execution:**

- [x] `src/ui/schema/schema-tree-state.ts` -- **NEW** DOM-free state module holding every decision the multi-root machine makes, so it is unit-testable without a DOM. Exports: `BOOT_ROOT_KEY = "boot"` (safe sentinel — saved ids are `randomUUID()`, `connection-registry.ts:304`, so collision is impossible); `BOOT_ROOT_FALLBACK_NAME` (the label for a configured-but-undescribable boot target); `rootKey(connectionId: string | null): string` = `connectionId ?? BOOT_ROOT_KEY`; `schemaKey(root, schema)` = `` `${root}::${schema}` ``; `tableKey(root, schema, table)` = `` `${root}::${schema}.${table}` ``; `type RootDescriptor = { connectionId: string | null; key: string; name: string; engine: string; host: string; pinnedSchema?: string }`; `type RootState = {kind:"idle"} | {kind:"loading"} | {kind:"ready"; schema: DatabaseSchema} | {kind:"error"; text: string}`; `bootDescriptor(active: ActiveConnectionInfo | null): RootDescriptor | null` — keyed off `active.hasTarget` (NOT `connection !== null`, per IG-3/IG-B), `name = connection.database ?? connection.host` falling back to the sentinel, `engine`/`host` empty when undescribable; `buildRoots(active, summaries)` — the boot descriptor FIRST, then one per summary carrying `pinnedSchema: summary.schema` only when present; `groupBySchema(tables)` preserving first-seen order; `mergeTables` (moved verbatim from `SchemaTree.tsx:49-57`); `connectStateFromReply(reply)` — `!ok` → `{kind:"error", text: envelopeText(reply.error)}`, `status:"failed"` → an `error` whose text is the `` `${failure}: ${message}` `` template `SchemaTree.tsx:147` used (a root only exists because a target exists, so even `no-target` is a real per-root error, never the calm empty-state), `status:"connected"` → `{kind:"ready", schema}`; `shouldFetchOnExpand(state)` = `state.kind === "idle"`; `autoExpandKeys(root, groups)` = exactly one group → `[schemaKey(root, groups[0].schema)]`, else `[]`; plus `pruneByRoot`/`pruneSetByRoot` for the IG-A reconciliation (drop only the removed roots' entries, return the SAME reference when nothing was pruned). -- Rationale: `renderToStaticMarkup` never runs effects and the repo has no jsdom, so any logic left inside the component is unverifiable; this module is where the AC "every other root's state is provably untouched" becomes assertable. REWRITTEN vs the original task: `bootDescriptor` and the two prune helpers were added — the first because IG-3/IG-B moved boot-root existence onto a boolean predicate, the second because IG-A introduced refresh reconciliation the original task list predates.
- [x] `src/ui/schema/SchemaTree.tsx` -- rewrite the component around the new module while keeping `Chevron`, `TableIcon`, `typeDotClass` and the props signature untouched except `onActivate`/`onSchemaLoaded`, which each gain a `connectionId` argument (see the App/Workspace tasks). (a) Replace `LoadState`/`load` with a tree phase `{kind:"loading"} | {kind:"error"; text} | {kind:"roots"; roots; warning}` plus four keyed stores: `states: ReadonlyMap<string, RootState>`, `expandedRoots`, `expandedSchemas`, `expandedTables` (all `ReadonlySet<string>`). (b) Mount effect (`[]` deps, guarded, same shape as the old `:135-159`) issues exactly `Promise.all([rpc<ActiveConnectionInfo>("connection.active"), rpc<ListConnectionsResult>("connections.list")])`: `connection.active` `!ok` → degrade to "no boot target" and still render the saved roots (a pure read must not tank the tree); `connections.list` `!ok` → tree `error` ONLY when there is also no boot target, otherwise a non-fatal `warning` above the roots (IG-4); both ok → `buildRoots(...)`. It then auto-expands the boot root and calls `loadRoot` on it — the ONE mount-time introspection (IG-2). (c) `toggleRoot(descriptor)` flips membership in `expandedRoots` and, only when `shouldFetchOnExpand(state)`, calls `loadRoot`, which sets that key to `loading` and fires `rpc<ConnectResult>("connect", descriptor.connectionId === null ? undefined : { connectionId: descriptor.connectionId })` — the boot root MUST send the paramless call so its wire bytes stay byte-identical to today. On reply it writes `connectStateFromReply(reply)` into that ONE key via a functional `setStates` update (never a whole-map rebuild from a stale closure), seeds `autoExpandKeys` into `expandedSchemas`, and calls `onSchemaLoaded?.(schema.tables, descriptor.connectionId)` only on the `ready` transition. `retry` is `loadRoot` called directly — the same path forced past `shouldFetchOnExpand`. (d) Render: delete the `.conn-row` header — per-root dots replace it, taking `bg-red-500` with it; the caption becomes the static `connections` label with unchanged classes; the empty-state is kept verbatim and now renders iff `roots.length === 0`; the tree-level error keeps `role="alert"` with `text-red-400` → `text-err`. (e) Add `export function ConnectionRoot({...})` — a PURELY presentational subcomponent taking `descriptor`, `state`, `open`, the two namespaced expansion Sets, `activeTable`, `extraTables` and four callbacks, rendering root header (chevron + status dot + name + engine badge + optional pin badge + host) → schema nodes → the EXISTING table rows and column disclosure verbatim with `tableKey(...)`-namespaced keys. Root header and schema node each get `role="button"`, `tabIndex={0}`, `aria-expanded` and the same `Enter`/`Space` + `preventDefault` handler the table row already uses. Status dot: `idle` → `bg-muted-foreground`; `loading` → `bg-muted-foreground animate-pulse motion-reduce:animate-none`; `ready` → `bg-ok shadow-[0_0_0_3px_var(--ok-soft)]`; `error` → `bg-err shadow-[0_0_0_3px_var(--err-soft)]`. `extraTables` is merged via `mergeTables` **only into the boot root** (`connectionId === null`) — see DW-41. Pin badge uses `bg-coral-soft text-coral`. -- Rationale: exporting `ConnectionRoot` is what makes every rendered state (ready / error+Reintentar / loading) assertable under `renderToStaticMarkup`, which cannot reach state produced by effects. REWRITTEN vs the original task in three places, all contract-driven: (b) "`connections.list` !ok → tree error" was unconditional and is now boot-target-conditional (IG-4); (b) the mount effect now also introspects the boot root (IG-2, which the original "and NOTHING else" predates); (e) `ConnectionRoot` takes TWO expansion Sets, not three — `expandedRoots` membership is already collapsed into the `open` boolean it receives, so passing the Set as well would be a second source of truth.
- [x] `src/ui/schema/SchemaTree.tsx` (IG-A, NEW TASK — no task existed) -- add an optional `registryRevision: number` prop (default `0`) and a second effect keyed on it that re-reads `connections.list`, rebuilds the roots via `buildRoots(activeRef.current, summaries)` and RECONCILES: `pruneByRoot`/`pruneSetByRoot` drop only the removed roots' cached state and expansion entries, so a new summary arrives as a fresh `idle` collapsed root and every survivor keeps its exact cached AND expand state (same value, same key — nothing re-introspects, collapses or blanks). The mount-time `ActiveConnectionInfo` is held in `activeRef` so the refresh never re-asks for the boot target (it cannot change mid-session — it is a CLI/env boot argument, not a registry entry). A failed refetch leaves the roots standing and raises the same non-fatal warning as IG-4. `registryRevision === 0` is the mount value and fetches nothing extra. -- Rationale: REGISTRY-DRIVEN REFRESH (IG-A) superseded "once on mount" after the task list was written; without it, saving a connection adds no root until an app restart — verbatim the complaint this story exists to fix, and the empty-state's CTA promises otherwise.
- [x] `src/ui/settings/SettingsPanel.tsx` + `src/ui/workspace/TabContent.tsx` + `src/ui/workspace/Workspace.tsx` (IG-A, NEW TASK) -- wire the refresh FROM THE MUTATION: `SettingsPanel` gains an optional `onRegistryChanged?: () => void` fired on each SUCCESSFUL `connections.add`/`edit`/`remove` (never on a failure — nothing changed to reconcile); `TabContent` passes it through to the settings tab body; `Workspace` owns the `registryRevision` counter and hands `onRegistryChanged={() => setRegistryRevision((n) => n + 1)}` down while feeding `registryRevision` to `SchemaTree`. -- Rationale: the contract explicitly rejects both alternatives (a tab-close event, and a refresh control in the tree header — the mockup has no such chrome); `Workspace` is the nearest common ancestor of the permanently-mounted tree and the Settings tab body, so the counter lives there instead of threading two more props through `App`.
- [x] `src/shared/contract.ts` + `src/core/connection.ts` + `src/core/server.ts` (IG-3/IG-B, NEW TASK) -- add the single BOOLEAN "a boot target is configured" predicate: `ConnectionManager.hasTarget()` (`databaseUrl !== null` — parses nothing, opens no driver, never throws), surfaced as a REQUIRED `hasTarget: boolean` on `ActiveConnectionInfo` and filled by `server.ts`'s `activeConnection`. The tree keys boot-root existence off it, so a configured-but-undescribable url (a parseable hostless one, e.g. `postgres:///shop`) renders a boot root that goes to `error` + "Reintentar" from its own `connect`, while a genuinely absent target contributes no root and the calm empty-state stands. NOT a tri-state, and NO `malformed-url` classification is forced — the Core's own engine-neutral verdict stands. -- Rationale: `describe()` collapses "nothing configured" and "configured but broken" into the same `null`, so without this bit the UI shows the calm "Sin conexión activa" for a broken boot url; the boolean is the narrowest extension that fixes it (IG-B narrowed IG-3's original tri-state).
- [x] `src/ui/workspace/workspace-state.ts` + `src/ui/workspace/TabContent.tsx` (IG-1, NEW TASK) -- TARGETED ACTIVATION. `TableRef` gains `connectionId?: string | null`; `TabContent`'s `TableTabView` derives a `connectionScope` (`{}` for the boot target, `{connectionId}` otherwise) and spreads it into **every** Core call the bound tab makes — the `table.rows` browse read AND the structured-mutation `execute` (cell edits, row insert/delete) — with `table.connectionId` added to the fetch effect's deps and to the per-table remount `key`, so the same `schema.name` under two roots is two different tables. The retained id is SESSION-ONLY: `toWorkspaceSnapshot` maps persisted tabs field-by-field and never emits `table`, so tsc proves it cannot reach disk; persisting/restoring it and surviving the connection's removal stay Story 10.6. -- Rationale: without it, expanding a saved connection and clicking one of ITS tables reads (and, worse, WRITES to) the boot database; the contract's ruling is explicit that a cross-database write is strictly worse than the cross-database read it exists to kill.
- [x] `src/ui/workspace/Workspace.tsx` -- widen the `onSchemaLoaded` prop type to `(tables: ReadonlyArray<SchemaTableInfo>, connectionId: string | null) => void` AND the `onActivateTable` type to `(table: SchemaTableInfo, connectionId: string | null) => void`, passing both through unchanged; add the `registryRevision` state + `onRegistryChanged` wiring (above). Separately (DW-54) swap the status-bar Stop button `text-red-400` → `text-err` and `hover:bg-red-500/10` → `hover:bg-err-soft`. -- Rationale: `Workspace` is a pure pass-through for these props; the Stop button is one of the two shell reds DW-54 names that can be tokenized without a contrast regression. REWRITTEN: `onActivateTable` also widens (IG-1 landed after this task was written).
- [x] `src/ui/App.tsx` -- (a) replace `onSchemaLoaded={setSchemaTables}` with a handler that **accepts only the boot root**: it returns early on a non-null `connectionId`, then `setSchemaTables(tables)` and filters out of `createdTables` every entry the fresh introspection already contains. Saved-connection roots must NOT feed `schemaTables`, because every consumer of `allTables` (create-table schemas, PKs, indexes, the ERD) runs against the boot target — a saved root's tables would silently poison PK lookups and the ERD. The filter is DW-41's other half. (b) `onActivateTable` binds `{schema, name, connectionId}` into the reducer (IG-1). (c) `primaryKeys`/`indexes` bail on a non-null `ref.connectionId` — `allTables` describes the boot target only, and the PK is what an inline edit or row delete is ADDRESSED BY, so borrowing a same-named boot table's key would aim a write at another database's row; no match ⇒ no key ⇒ the grid stays read-only. (d) DW-54: ConnectionIndicator + SaveIndicator `bg-red-500` → `bg-err`. -- Rationale: this is the caller-side change `onSchemaLoaded`-fires-per-root forces, and it is load-bearing correctness, not cosmetics. REWRITTEN: (b) and (c) are new — the original task predates IG-1, and IG-B's closing note explicitly extended the ruling to the `primaryKeys`/`indexes` lookup because it feeds WRITES.
- [x] `src/ui/schema/schema-tree-state.test.ts` -- **NEW**, DOM-free, 24 cases covering every I/O-matrix row the module owns: `buildRoots` with (no boot + 0 saved) → `[]`, (no boot + N saved) → N in list order, (boot + M saved) → boot FIRST then M, the boot name falling back `database ?? host ?? sentinel`, a configured-but-undescribable boot still producing a root with empty engine/host, `pinnedSchema` carried only when the summary has a `schema` key; `rootKey`/`schemaKey`/`tableKey` namespacing — the SAME `schema.table` under two roots (and the boot root) produces three DIFFERENT keys; `groupBySchema` preserving first-seen order; `mergeTables` regression parity (dedup by `schema.name`, introspected wins, order preserved, `extra: []` returns the same reference, same name in a different schema is not a duplicate); `connectStateFromReply` for `!ok` → `envelopeText` text, `status:"failed"` for each of `host`/`auth`/`network`/`no-target` → `error` (never `ready`, never a calm empty), `status:"connected"` → `ready` carrying that reply's schema; `shouldFetchOnExpand` true only for `idle`; `autoExpandKeys` returning one key for a single-schema (and for a pinned) payload and `[]` for two or more; `pruneByRoot`/`pruneSetByRoot` dropping a removed root's state and namespaced expansion keys while survivors stay reference-identical; plus a per-root-isolation test driving root A `idle → loading → error` and asserting roots B/C are reference-identical throughout. -- Rationale: an I/O matrix exists, so its edge cases get unit tests; this is the only layer where "provably untouched" can be asserted.
- [x] `src/ui/schema/SchemaTree.test.tsx` -- **NEW**, 14 cases, following `ChatTabView.test.tsx:34-55` (`mock.module("../rpc/client.ts", …)` before a dynamic `await import`) and `ErdTabView.test.tsx` (`renderToStaticMarkup` + static fixtures). Asserts on `ConnectionRoot` rendered directly with explicit props: a collapsed `idle` root renders the name/engine badge/host, `aria-expanded="false"`, a muted dot (never `bg-ok`/`bg-err`) and NO table markup; a ready-but-collapsed root shows its ok dot and still no tables; an `open` + `loading` root renders `introspecting…` and the pulsing dot with `motion-reduce:animate-none`; an `open` + `error` root renders the classified text, `role="alert"` and a `Reintentar` button and NO schema/table nodes; an `open` + `ready` multi-schema root renders one collapsed schema node per schema with its table count and `default` on `public` ONLY (asserted by match count); an expanded schema renders its table rows with `role="button"`/`tabindex`/`aria-pressed` while the sibling schema stays collapsed; an expanded table renders its columns with `bg-t-key`/`text-t-key` on the PK and the derived type-dot on the rest; the active-row highlight is EXACT (the same `schema.table` in another root renders `aria-pressed="false"`); a zero-table root renders `no tables`; a root with `pinnedSchema` renders the pin badge; and `extraTables` merge into the boot root but never into a saved one (DW-41). Also asserts `renderToStaticMarkup(<SchemaTree …/>)` contains NO `red-400`/`red-500` substring and that the mocked `rpc` was called ZERO times during render. -- Rationale: locks the mockup-fidelity states and the token swap; the zero-call assertion is the closest render-level proxy for "no handshake storm".
- [x] Core-side test additions (NEW TASK, forced by the IG-3/IG-B contract extension) -- `src/core/connection.test.ts`: `hasTarget()` separates "nothing configured" (`false`) from the three urls `describe()` cannot describe (hostless / unparseable / good — all `true`), opening no driver. `src/core/server.test.ts`: `hasTarget:true` asserted on the ephemeral boot, `false` on a persistent boot with no url, plus a NEW test that a configured-but-undescribable `postgres:///shop` boot answers `{connection: null, hasTarget: true}`. `src/core/rpc.test.ts` + `src/core/connection-targets.test.ts`: their `ActiveConnectionInfo`/`ConnectionManager` stubs gain the new required member (and the `toEqual` gains the new key — a strengthened assertion, not a weakened one). -- Rationale: the contract grew a field with observable behavior behind it; leaving it untested would ship the IG-3 fix on an unproven predicate.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- mark **DW-41** `status: open (partial)` — the scoping half landed (optimistic tables merge into the boot root only) but the clearing half (a fresh boot introspection filters already-introspected entries out of `createdTables`) is written yet unreachable, since nothing re-introspects a `ready` root; *(CORRECTED by the 2026-07-22 review pass — this task originally said `status: done 2026-07-22` "with a resolution naming the two halves", which overstated what shipped)*; mark **DW-54** `status: open (partial)` with the swap recorded and the residual explicitly listed — `ExposureBanner` (white-on-`--err` would drop contrast ~4.8:1 → ~2.9:1), the absence of `:root[data-theme="light"]` values for `--err`/`--err-soft`/`--err-line` (a deliberate Story-7.3 dark-first decision documented at `globals.css:75-80`), and the untouched `red-*`/`amber-*` in `DataGrid.tsx:481`, `CreateTablePanel.tsx:39,71,241`, `TabContent.tsx:388-411`; and ADD **DW-68** for the view-vs-table contract gap (add `kind: "table" | "view"` to `SchemaTableInfo` + both drivers' introspection so the mockup's distinct view icon becomes buildable), origin this story, severity low. -- Rationale: the ledger is the loop's memory; a folded item left unmarked is re-triaged forever, and a silently-dropped residual reads as "covered".

**Acceptance Criteria:**
- Given N saved connections and a boot target, when the tree mounts, then exactly THREE RPCs fire (`connection.active`, `connections.list`, and the boot root's own PARAMLESS `connect`), the N saved roots render collapsed with an idle dot and ZERO `connect` calls of their own, and the boot root renders expanded and introspecting. With no boot target configured, the third call does not happen either. *(AMENDED 2026-07-22: as written this AC said "exactly two RPCs … and ZERO `connect` calls have been issued", which the BOOT-ROOT MOUNT EXCEPTION (IG-2) superseded — the lazy rule covers saved-connection roots only.)*
- Given `onSchemaLoaded` now fires once per root, when a saved-connection root reaches `ready`, then `App.tsx`'s `schemaTables` is unchanged — only the boot root (`connectionId === null`) may write it, so the ERD, PK and index lookups keep describing the boot target.
- Given the boot root, when it introspects (at mount, or again via "Reintentar"), then the `connect` RPC is issued with NO params at all (byte-identical to the pre-10.5 call), and a boot-less workspace with zero saved connections renders the existing calm empty-state rather than any error.
- Given a table activated from a saved-connection root, when its tab reads rows or commits a cell edit / row insert / row delete, then every one of those Core calls carries that root's `connectionId`, and the tab's PK lookup resolves to nothing rather than to a same-named boot table — so no read and, above all, no WRITE can land in a database other than the one on screen.
- Given a connection saved, edited or removed in Settings while the tree is mounted, when the mutation succeeds, then the tree re-reads `connections.list` and reconciles without an app restart: a new summary appears as a fresh `idle` collapsed root, a removed one takes its root and cached state with it, and every surviving root keeps its cached AND expand state untouched.
- Given a boot target that IS configured but cannot be described (a parseable hostless url), when the tree mounts, then a boot root renders and lands in `error` with "Reintentar" carrying the Core's own engine-neutral verdict — not the "Sin conexión activa" empty-state, and with no `malformed-url` classification forced.
- Given `bunx tsc --noEmit`, `bun test`, and `bun run build`, when run, then all three pass and no existing assertion is weakened or deleted. *(AMENDED 2026-07-22: as written this AC said the suite "grows only by the new `schema-tree-state.test.ts` / `SchemaTree.test.tsx` cases". The IG-3/IG-B contract extension made that impossible — `ActiveConnectionInfo.hasTarget` is required, so two Core stubs had to gain the member and two Core suites gained additive coverage for it. Total: 1445 → 1485 passing (+40: 24 in `schema-tree-state.test.ts`, 14 in `SchemaTree.test.tsx`, 2 in the Core suites), all additive.)*
- Given a grep of `src/ui/schema/SchemaTree.tsx`, `src/ui/App.tsx`, and `src/ui/workspace/Workspace.tsx:429`, when run, then no `red-400`/`red-500` utility remains at any of the DW-54 sites this story claims (the `ExposureBanner` residual is the only permitted red in `Workspace.tsx`).

## Design Notes

**Why a separate `schema-tree-state.ts` instead of keeping it in the component.** The repo deliberately has no jsdom/testing-library (`ChatTabView.test.tsx:1-12`); components are asserted with `renderToStaticMarkup`, which never runs `useEffect`. A per-root state machine written inline would therefore be 100% unverifiable — the "one root's failure never touches another" AC could only be eyeballed. Splitting pure decisions out (and exporting `ConnectionRoot` for presentational assertions) is what converts this story's central guarantee into a test.

**The boot root's `connect` call must stay paramless.** `server.ts:388-394` treats absent/`null`/omitted `connectionId` identically, so `{connectionId: null}` would also work — but AR-12's "byte-for-byte unchanged" is about the wire, and Story 10.4's own AC bought "the default path stays byte-identical" with untouched tests. Sending `undefined` params keeps that literally true and costs nothing.

**Why `onSchemaLoaded` gains a `connectionId` rather than firing blindly per root.** `App.tsx:399-448` derives create-table schema options, PK lookups, index lookups, and the ERD's node set from `allTables`, which only the boot root may write. If a saved root's `ready` overwrote `schemaTables`, the ERD would render another database's tables and PK-addressed row edits would resolve against the wrong catalog — a silent data-correctness bug, not a cosmetic one. *(Amended 2026-07-22: this note originally read "those consumers all run against the boot manager — `TabContent.tsx` and the executor still send no id in this story". IG-1 changed that: a TABLE TAB's `table.rows` and `execute` now DO carry the id. What stayed boot-only is the shared `allTables` CATALOG, so the PK/index lookups had to be taught to refuse a saved-connection ref rather than answer from the boot catalog — see the App task. Making those consumers genuinely connection-aware, so a saved-connection tab gets its OWN catalog and regains inline editing, is Story 10.6's job.)*

**Error state is per-root and never auto-retries.** The mockup's `toggleRoot` (lines 424-429) only calls `loadRoot` when the root is not loaded AND not errored, so re-expanding a failed root reveals the cached error instead of hammering an unreachable host. `shouldFetchOnExpand(state) === (state.kind === "idle")` encodes exactly that, and the "Reintentar" button — wired straight to `loadRoot`, the only call site that never consults the guard — is the sole path that bypasses it.

**`no-target` on a root is an error, not the empty-state.** Today's single-root tree maps `failure === "no-target"` to the calm empty-state because that WAS the "nothing configured" signal. In the multi-root world a root only exists because `connection.active()`/`connections.list` already proved a target exists, so a `no-target` reply there means something genuinely broke (the connection was removed mid-session). Emptiness is now decided by `roots.length === 0` alone, which is what retires the speculative probe `connect()`.

**DW-54 stops where contrast would regress.** `--err` (#ef6a63) is tuned as a *foreground/accent* red on dark surfaces; `ExposureBanner` is a filled white-on-red alarm where `red-600` measures ~4.8:1 against white and `--err` only ~2.9:1. Tokenizing it would trade a theming defect for an accessibility one, so it stays listed as an explicit residual rather than being quietly swapped or quietly skipped.

## Verification

**Commands** (all four run 2026-07-22 against the landed diff — green):
- `bunx tsc --noEmit` -- expected: no diagnostics, including the widened `onActivate`/`onSchemaLoaded` signatures threading through `Workspace.tsx` and `App.tsx`, the new `TableRef.connectionId`, and the now-REQUIRED `ActiveConnectionInfo.hasTarget` at every construction site. **Actual: no output, exit 0.**
- `bun test` -- expected: full suite green; additive cases only. No test opens a database or a DOM. **Actual: `1485 pass / 0 fail / 3866 expect() calls across 75 files` (baseline `6e467dc` was 1445 across 73 files; +24 `schema-tree-state.test.ts`, +14 `SchemaTree.test.tsx`, +2 Core cases for `hasTarget`).**
- `bun run build` -- expected: all four build scripts complete without error (the UI bundle picks up the new module). **Actual: build-ui / build-sandbox / build-snapshot / build-live-report all wrote their generated bundles.**
- `grep -rn "red-400\|red-500" src/ui/schema/SchemaTree.tsx src/ui/App.tsx` -- expected: no matches. **Actual: no matches (exit 1).**

**Manual checks (if no CLI):**
- Read the mount effect and confirm it contains exactly two `rpc(` call sites — `connection.active` and `connections.list` — and that the only `connect` it can reach is `loadRoot(boot)`, guarded on a boot descriptor actually existing. *(AMENDED: the original check demanded "no `connect`" at all, which IG-2's BOOT-ROOT MOUNT EXCEPTION superseded. The no-handshake-storm guarantee is still textual: no SAVED root can be introspected from this effect, because the only descriptor it passes to `loadRoot` is the one with `connectionId === null`.)*
- Read `toggleRoot`/`loadRoot` and confirm every write to the per-root map is a functional `setStates((cur) => …)` update that touches exactly one key, and that `expandedSchemas`/`expandedTables` membership is always built from `schemaKey`/`tableKey` (never a bare `schema.table`).
- Read the `registryRevision` effect and confirm it only ever PRUNES (`pruneByRoot`/`pruneSetByRoot`) — it never writes a state for a surviving root, so no refresh can re-introspect, collapse, or blank one.

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Empty until the first bad_spec loopback. -->

### 2026-07-22 — `<intent-contract>` amended by human ruling (escalation resolution)

Run `20260722-141217-22a8` escalated CRITICAL with 4 intent gaps; the code was reverted to
`6e467dc`. Juan ruled on all four in an interactive session and the contract was amended
accordingly. The spec BODY (Code Map / Tasks / Design Notes / Verification) was NOT touched —
the review found it sound; re-drive against it, do not re-plan from scratch.

- **IG-1 → widen the callback.** `onActivate(table, connectionId)`; the bound tab retains the id
  and targets its `table.rows`. Adding `connectionId` to `TableRef` is authorised if needed.
  Persisting/restoring that id and surviving connection removal STAY in 10.6.
  Amended: Always (new TARGETED ACTIVATION rule + the preserve-verbatim bullet), Never
  (`onActivate` removed from the frozen-signature list), matrix rows for activation and for the
  cross-root highlight collision.
- **IG-2 → the lazy rule covers only saved-connection roots.** The boot root auto-expands and
  introspects at mount via the id-less `connect`, as today. Amended: Always (new BOOT-ROOT MOUNT
  EXCEPTION + the mount and lazy bullets), Never (scoped to saved roots), Approach (the
  no-speculative-`connect` sentence), matrix row for a configured boot target.
- **IG-3 → the contract MAY grow to distinguish a broken boot target.** A configured-but-
  unparseable `--url` renders as a boot root in `error` with the `malformed-url` classification,
  never as the "Sin conexión activa" empty-state. Amended: Always (empty-state bullet + new
  MISCONFIGURED BOOT TARGET rule), Never (`contract.ts` bullet), Block-If, new matrix row.
- **IG-4 → a failed `connections.list` no longer kills a working boot root.** It degrades to a
  non-fatal warning above the roots; it is only a whole-tree error when there is no boot target
  either. Amended: that matrix row.

Not addressed here (deliberately out of scope for an escalation resolution): the 4 `bad_spec`
findings and 11 `patch` findings the same review recorded. They live outside `<intent-contract>`,
so a dev/review session can fix them itself on the re-drive.

### 2026-07-22 (second resolution) — `<intent-contract>` amended again after the IG-A/IG-B escalation

The re-drive implemented the amended contract in full (green) and escalated on TWO further gaps.
Juan ruled on both. **Where this entry and the previous one disagree, THIS one wins.**

- **IG-A → REGISTRY-DRIVEN REFRESH replaces "once on mount".** The tree re-reads `connections.list`
  on every registry mutation, wired from the `SettingsPanel` mutation itself — not from a tab-close
  event, not from a new refresh control (rejected: the mockup has no such chrome). Surviving roots
  keep their cached AND expand state; new summaries arrive `idle`; removed ones vanish. An open tab
  whose connection was removed remains 10.6's problem. Amended: Approach, Always (the mount bullet +
  a new REGISTRY-DRIVEN REFRESH rule), two new matrix rows.
  *Why it reached a second escalation:* the FIRST review already flagged the missing refresh path as
  `bad_spec`, and the resolution deliberately left all `bad_spec` findings to the re-drive. That was
  wrong for this one — the remedy contradicted a frozen Always rule, so no dev session could apply it.
- **IG-B → the IG-3 ruling was made on a false premise; narrowed, not dropped.** An unparseable
  `--url` cannot reach the UI at all (`cli-args.ts:104-114` throws `CliArgsError` → `exit(1)` first),
  so the only real case is a URL that parses with no host. The authorised extension shrinks from a
  `bootTarget` tri-state to a single BOOLEAN predicate, and the matrix no longer demands a
  `malformed-url` classification — the Core's own engine-neutral verdict (`host`/`network`) stands.
  Amended: the MISCONFIGURED BOOT TARGET rule and its matrix row. The previous entry's IG-3 wording
  ("renders … with the `malformed-url` classification") is SUPERSEDED.
- **Also closed here, though the review filed it as `bad_spec` rather than an intent gap:** the IG-1
  rule was written for reads only, so `execute` (`TabContent.tsx:191`) and the `primaryKeys`/`indexes`
  lookup (`App.tsx:418-436`) stayed untargeted — a cross-database WRITE. The TARGETED ACTIVATION rule
  now binds EVERY Core call a tab makes, reads and writes alike, to the retained `connectionId`. This
  is a correction to the rule this same document introduced, not new scope.

## Review Triage Log

<!-- Append-only. Populated by step-04 on every review pass. Empty until the first review pass. -->

### 2026-07-22 — Review pass

- intent_gap: 4: (high 2, medium 2)
- bad_spec: 4: (high 0, medium 4, low 0)
- patch: 11: (high 0, medium 3, low 8)
- defer: 2: (high 0, medium 0, low 2)
- reject: 7
- addressed_findings:
  - none

### 2026-07-22 — Review pass

- intent_gap: 2: (high 1, medium 1)
- bad_spec: 5: (high 1, medium 4, low 0)
- patch: 10: (high 0, medium 0, low 10)
- defer: 2: (high 0, medium 0, low 2)
- reject: 0
- addressed_findings:
  - none

### 2026-07-22 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 3, low 7)
- defer: 5: (high 0, medium 4, low 1)
- reject: 20
- addressed_findings:
  - `[medium]` `[patch]` A failed `connection.active` degraded silently to "no boot target", so a transport failure rendered the calm "Sin conexión activa" empty-state and left `schemaTables` empty for the session (dead ERD, empty create-table schema list, PK failures). Now raises the same non-fatal warning IG-4 already mandates for `connections.list`, while still degrading rather than tanking the tree. `SchemaTree.tsx` mount effect + new `bootTargetWarning`/`mountWarning`.
  - `[medium]` `[patch]` The DW-41 ledger entry claimed `done`, but only the scoping half shipped: the `createdTables` clearing filter runs solely on a boot-root `ready` transition, which is reachable once at mount (before any table exists) or via "Reintentar" (error-only), and `SchemaTree` never unmounts. Ledger corrected to `open (partial)` with the residual named; the spec's two stale `done` claims corrected to match.
  - `[medium]` `[patch]` The contract's "session-only `TableRef.connectionId`" guarantee was implied by `tsc` alone. Added a `workspace-state.test.ts` case asserting `toWorkspaceSnapshot` emits no `connectionId` — on the round-tripped object AND on `JSON.stringify`.
  - `[low]` `[patch]` An in-flight `connect` could resurrect a root pruned by a concurrent registry refresh, writing a dead key into `states`/`expandedSchemas` and firing `onSchemaLoaded` for a removed connection. `loadRoot`'s reply now gates all three writes on the root still being present (via a `statesRef` mirror written through a single `updateStates` helper).
  - `[low]` `[patch]` A failed refresh was invisible whenever the root list was empty — the `roots.length === 0` empty-state branch was checked before the warning paragraph, so a user who had just added a connection saw "Agregá una conexión en Ajustes". Warning now renders above both branches.
  - `[low]` `[patch]` The user-facing registry-warning copy was hand-written twice; extracted to a single `registryWarning(error)` helper.
  - `[low]` `[patch]` `TabContent.tsx`'s comment claimed "insert stays available" when PKs are missing — false since this story (a saved-connection tab goes fully read-only). Corrected, with the reason (boot-only `allTables`) and the 10.6 pointer.
  - `[low]` `[patch]` `connection.ts`/`connection.test.ts` motivated `hasTarget` with an "unparseable url" the IG-B ruling had already established is unreachable (`cli-args.ts:104-114` throws `CliArgsError` → `exit(1)` first). Comments now lead with the reachable hostless case; the unparseable assertion is labelled as an unreachable-from-CLI total-function guard. The `contract.ts` sub-part was skipped — verified already correct.
  - `[low]` `[patch]` `connection-targets.test.ts` stubbed `hasTarget: () => url.length > 0`, contradicting the real `databaseUrl !== null` semantics while no assertion read it. Made to mirror the implementation.
  - `[low]` `[patch]` Two stale doc comments in `SchemaTree.tsx`: `onSchemaLoaded` claimed it never re-fires (a successful "Reintentar" does, deliberately), and the `eslint-disable` comment named `onSchemaLoaded` as the excluded dep when the actually-frozen closure is `loadRoot`. Both corrected.

### 2026-07-22 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 3, low 5)
- defer: 3: (high 0, medium 2, low 1)
- reject: 25
- addressed_findings:
  - `[medium]` `[patch]` Neither degraded mount read had a way back. A failed `connection.active` left NO boot root for the whole session — and with it an empty `App.tsx` `schemaTables`, i.e. a dead ERD, an empty create-table schema selector and unresolvable PKs — while a failed `connections.list` next to no boot target left a bare `role="alert"` with no roots, no CTA and no recovery. Neither self-heals: the refresh effect never re-reads `connection.active`, and it only fires on a Settings mutation an empty tree gives no path to. The two mount reads are now the extracted `loadTree()`, wired to a "Reintentar" in BOTH the tree-error branch and beside the warning line. A retry never re-handshakes a boot root that is already `ready` — the boot `loadRoot` is now behind the same `shouldFetchOnExpand` gate every other root obeys.
  - `[medium]` `[patch]` A SUCCESSFUL registry refresh wiped a live boot-target warning (`setPhase({…, warning: null})`), so the first Settings save after a degraded `connection.active` produced a healthy-looking tree sitting on the same dead ERD. The boot-target warning now lives in `bootWarningRef` and survives both refresh branches; a successful refresh clears only the registry warning it actually disproved.
  - `[medium]` `[patch]` A table whose `schema` is blank — the shape an optimistic create-table entry carries for the connection's default namespace, which `App.tsx`'s schema selector already skips for the same reason — rendered as a nameless, tooltip-less clickable schema node. Now labelled `(default)` for both the name and the `title`, with a new `SchemaTree.test.tsx` case pinning it (and asserting it does NOT pick up `public`'s `default` badge).
  - `[low]` `[patch]` `toggleRoot` gated its fetch on the render-closure `states` while `loadRoot` writes the `loading` marker through `statesRef` — the two sources of truth the ref was introduced to collapse. Two activations of one root inside a single frame both read `idle` and issued two `connect`s whose reply order decided the surviving state. Now gated on `statesRef.current`.
  - `[low]` `[patch]` When BOTH mount reads failed, the tree error surfaced only the registry envelope, asserting "there is no boot target" — precisely what a failed `connection.active` means is unknown, and the opposite of the priority `mountWarning`'s own comment documents. Both envelopes now ride that line.
  - `[low]` `[patch]` `aria-label="Schema tables"` described the pre-multi-root flat list and contradicted the panel's own visible `connections` header. Now `Connections`; the assertion in `SchemaTree.test.tsx` tracks it.
  - `[low]` `[patch]` `App.tsx`'s `onSchemaLoaded` doc claimed the DW-41 clearing half retires optimistic entries, while the ledger records it as effectively unreachable. The comment now states the reachability limit (mount from `idle`, or a successful "Reintentar" from `error`) and points at the `open (partial)` status.
  - `[low]` `[patch]` `SchemaTree.test.tsx` asserted the `default` badge with a bare `/default/g` substring match, which also matches the `cursor-default` utility on an expanded table's column rows — correct only by the accident of which fixtures expand. Tightened to the badge's own markup at all three sites.

### 2026-07-22 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 2: (high 0, medium 0, low 2)
- reject: 16
- addressed_findings:
  - `[medium]` `[patch]` `loadTree`'s retry DEMOTED what the tree had already proved. A failed `connection.active` on a retry overwrote `activeRef` with `null`, so a live, already-introspected boot root vanished from the tree along with the default target it browses; a failed `connections.list` on the same path rebuilt the roots from `[]` and wiped every saved root — the exact "a failed refetch leaves the current roots standing" rule the refresh effect obeys and the contract states. Both refs are now written only from an `ok` reply (`summariesRef` added alongside `activeRef`), so a transient failure degrades to the warning line it already renders instead of deleting known state. The whole-tree `error` branch is correspondingly gated on there being nothing known from EITHER side, which reproduces the mount behavior exactly (both refs start empty).
  - `[medium]` `[patch]` The same retention makes root SHRINKAGE authoritative, so `loadTree` now performs the reconciliation only the refresh effect did: `pruneByRoot`/`pruneSetByRoot` over `states` and the three expansion Sets. Without it a root removed while `connections.list` was failing left its cached `ready` catalog and all its `conn::…` expansion keys behind forever, and `loadRoot`'s liveness guard (`statesRef.current.has`) kept accepting replies for a root that no longer existed.
  - `[low]` `[patch]` `loadTree` and the registry-refresh effect raced with no ordering, both ending in an unconditional `setPhase`. A "Reintentar" in flight when a Settings save bumped the revision could land LAST and overwrite the newer root list with its own older one — dropping the just-saved connection with no further bump to recover from. Both readers now take a monotonic `treeSeqRef` token and only the newest issued read commits.
  - `[low]` `[patch]` "Reintentar" bypasses `shouldFetchOnExpand` by design (it must re-fetch an `error`/`ready` root), so the double-fire guard the previous pass gave `toggleRoot` did not cover it: two activations inside one frame issued two concurrent `connect`s whose reply order decided the surviving state, and fired `onSchemaLoaded` twice for the boot root. Guard moved into `loadRoot` itself (`already loading → return`), which is the one point every entry path crosses.
  - `[low]` `[patch]` The tree-level `loading` phase is about the ROOT LIST (per `TreePhase`'s own doc) but still rendered the single-root tree's `loading schema…`. Now `loading connections…`.
  - `[low]` `[patch]` `connection-targets.test.ts` cited `connection.ts:465-469` for `hasTarget()`, a line range already stale in the commit that introduced it (the method landed at `:471`). Citation reduced to the symbol, which cannot drift.

## Folded Deferred-Work

**DW-41 (fold-in): scope optimistic created-tables per connection.** `src/ui/App.tsx:311-317` only ever appends to `createdTables` and never clears it, so an optimistically-created table would leak into every root and survive a re-introspection as a phantom. Resolved here in two halves: (1) `SchemaTree` merges `extraTables` **only into the boot root** (`connectionId === null`) — created tables can only ever belong to the boot target in this story, since create-table still executes id-less, so keying by "boot sentinel for the default" is exactly the scoping DW-41 asks for; (2) each boot-root `ready` transition filters out of `createdTables` every entry the fresh introspection already contains, so a re-introspection (including the DW-45 post-DDL bust landed in 10.4) retires its own phantoms. Connection-removal clearing is moot: the boot target cannot be removed from Settings. Mark DW-41 done when landed.

> **Landed 2026-07-22.** DW-41 is `status: open (partial)` in `deferred-work.md`: the SCOPING half landed (optimistic tables merge into the boot root only), but the CLEARING half — the `createdTables` filter on a boot-root `ready` transition — is written yet effectively unreachable, because `SchemaTree` never unmounts and no path re-introspects a `ready` root (`toggleRoot` fetches only when `idle`; "Reintentar" renders only on `error`). The review pass caught the original `done` claim as an overstatement and corrected it. DW-54 is `status: open (partial)` with the swap recorded and all three residuals listed; DW-68 (the view-vs-table contract gap) was added as a new low-severity entry originating from this story.

**DW-54 (fold-in, PARTIAL): tokenize the shell's error reds.** Swapped here: `SchemaTree.tsx` (the `.conn-row` dot disappears with the header; the tree-level `role="alert"` goes `text-red-400` → `text-err`), `App.tsx:176` and `:216` (`bg-red-500` → `bg-err`), `Workspace.tsx:414` (Stop button → `text-err` / `hover:bg-err-soft`). **Residual left open, with reasons:** `Workspace.tsx:201-210` `ExposureBanner` (white-on-`--err` would drop contrast from ~4.8:1 to ~2.9:1 — a real accessibility regression); no `:root[data-theme="light"]` values for `--err`/`--err-soft`/`--err-line` (deliberate Story-7.3 dark-first decision documented at `globals.css:75-80` — reversing it is a theme decision, not a UI story's call), which means the swap improves consistency but does NOT yet fix light-theme contrast; and the untouched raw reds/ambers in `DataGrid.tsx:481`, `CreateTablePanel.tsx:39,71,241`, `TabContent.tsx:388-411`, which are outside this story's surface. Leave DW-54 `open (partial)` with that residual recorded.



## Auto Run Result

Status: `done` — implemented, reviewed, patched, verified green.

### Implemented change

`SchemaTree` went from a single-connection flat table list to a DBeaver-style multi-root tree:
one collapsible root per saved connection (`connections.list`) plus, when one exists, a root for
the boot target (`connection.active`). Saved roots render instantly, collapsed and uintrospected —
twenty saved connections still mean zero handshakes at boot — and introspect lazily on first
expand via Story 10.4's `connect{connectionId}`. The boot root is the one exception: it
auto-expands and introspects at mount with the PARAMLESS `connect`, byte-identical to the
pre-10.5 wire call, because `App.tsx`'s `schemaTables` (ERD, create-table schema options,
primary-key resolution) depends on it. Each root owns an isolated `idle | loading | ready | error`
state in a keyed map, so one bad connection can never blank, dim or delay another; an `error` root
renders the Core's engine-neutral classification inline with "Reintentar". Inside a `ready` root
tables now group under a collapsible SCHEMA level (`connection → schema → tables`), auto-expanded
when there is exactly one schema. Table activation carries its owning root's target, and the bound
tab threads that `connectionId` through every Core call it makes — reads and writes alike — so a
write can never land in a database other than the one on screen. The registry drives refresh: any
save/edit/remove in Settings reconciles the root list without an app restart, and survivors keep
their cached and expand state untouched.

### Files changed

**New**
- `src/ui/schema/schema-tree-state.ts` — DOM-free multi-root state module (key namespacing, root
  construction, per-root state transitions, schema grouping, auto-expand and prune rules).
- `src/ui/schema/schema-tree-state.test.ts` — 24 cases over that module, including the per-root
  isolation proof (root A `idle → loading → error` leaves B/C reference-identical).
- `src/ui/schema/SchemaTree.test.tsx` — 14 `renderToStaticMarkup` cases over the exported
  `ConnectionRoot`, one per visual state, plus the token and zero-RPC-at-render assertions.

**Modified**
- `src/ui/schema/SchemaTree.tsx` — the rewrite: multi-root tree, collapsible schema level, keyed
  per-root state, mount + registry-refresh effects, exported presentational `ConnectionRoot`.
- `src/shared/contract.ts` — `ActiveConnectionInfo` gains the required `hasTarget: boolean`.
- `src/core/connection.ts` / `src/core/server.ts` — `ConnectionManager.hasTarget()` (existence
  only, parses nothing) surfaced on `connection.active`.
- `src/ui/workspace/workspace-state.ts` — `TableRef.connectionId?: string | null`, session-only.
- `src/ui/workspace/TabContent.tsx` — `connectionScope` spread into `table.rows` and the
  structured-mutation `execute`; remount key and fetch deps include `connectionId`.
- `src/ui/workspace/Workspace.tsx` — owns `registryRevision`; widened callback types; Stop button
  tokenized (DW-54).
- `src/ui/App.tsx` — boot-only `onSchemaLoaded` + the DW-41 `createdTables` filter; activation
  binds `connectionId`; `primaryKeys`/`indexes` refuse a saved-connection ref; two reds tokenized.
- `src/ui/settings/SettingsPanel.tsx` — `onRegistryChanged`, fired only on a successful mutation.
- `src/core/connection.test.ts`, `server.test.ts`, `rpc.test.ts`, `connection-targets.test.ts` —
  additive coverage and stubs for `hasTarget`.
- `src/ui/workspace/workspace-state.test.ts` — the `connectionId`-never-persists case.
- `_bmad-output/implementation-artifacts/deferred-work.md` — DW-41 `open (partial)`, DW-54
  `open (partial)`, new DW-68 (view-vs-table contract gap), plus five new deferred entries.

### Review findings

THREE review passes, each with two adversarial layers (Blind Hunter + Edge Case Hunter) run in
parallel on the full diff against `6e467dc`.

**Pass 1** — 0 intent_gap, 0 bad_spec, 10 patch, 5 defer, 20 reject; all ten patches applied.
**Pass 2 (follow-up)** — 0 intent_gap, 0 bad_spec, 8 patch, 3 defer, 25 reject; all eight applied.
**Pass 3 (follow-up)** — 0 intent_gap, 0 bad_spec, 6 patch, 2 defer, 16 reject; all six applied.
See the Review Triage Log entries above for each finding and the action taken.

Pass 2's centre of gravity was RECOVERY: both mount reads degraded gracefully but neither could
be retried, so a single transient `connection.active` failure silently cost the boot root — and
with it the ERD, the create-table schema selector and PK resolution — for the entire session, and
a failed `connections.list` next to no boot target left a dead tree with no affordance at all. The
two reads are now the extracted `loadTree()`, reachable from a "Reintentar" in both degraded
states, gated so a retry can never re-handshake a root already `ready`. Pass 2 also stopped a
successful registry refresh from wiping a live boot-target warning, collapsed `toggleRoot`'s
fetch gate onto `statesRef` (the same source of truth `loadRoot` uses), and gave a blank schema
name a real `(default)` label instead of a nameless clickable row.

Pass 3 landed entirely on `loadTree` — the retry path pass 2 itself introduced, which had been
given the recovery affordance but not the reconciliation discipline the rest of the component
already obeys. Its retry DEMOTED known state on a transient failure (a failed `connection.active`
deleted a live boot root; a failed `connections.list` wiped every saved root, contradicting the
contract's own "a failed refetch leaves the current roots standing" rule that the refresh effect
follows), it pruned nothing when the root list legitimately shrank, and it raced the refresh
effect with no ordering so an older reply could drop a just-saved connection. Both mount reads are
now retained across failures (`activeRef`/`summariesRef` written only from an `ok` reply), root
shrinkage is authoritative and therefore prunes, and both readers share one monotonic sequence
token. The double-fire guard was also moved from `toggleRoot` into `loadRoot`, which is the one
point the "Reintentar" path — which bypasses `shouldFetchOnExpand` by design — also crosses.

Deferred to the ledger across the three passes: no path re-introspects a `ready` root, so an EDITED
connection keeps a stale catalog (spec-compliant — it follows the frozen IG-A ruling — but the
ruling did not consider an edit repointing the same id); saved-connection tabs are silently
read-only; the effect/wiring layer has no automated coverage because the repo has no DOM harness;
query/chat/create-table still address the boot target; the tree has no ARIA tree semantics or
arrow navigation; the boot root's introspection is gated behind `connections.list`, so a slow
credential store delays the boot catalog by up to the 10s RPC timeout; nothing on a tab says which
connection it reads from, so two same-named tables from two roots are indistinguishable in the tab
bar; DW-41's clearing filter cannot retire a blank-schema optimistic entry; the namespaced tree
keys concatenate `schema.table` without escaping, so a dotted quoted identifier collides with a
different legal pair; and the single-schema auto-expand is computed on the unmerged tables, so it
disagrees with what renders when an optimistic table supplies the only schema group.

Notable rejects: the table row lost its disclosure chevron, but the mockup (line 388, the declared
visual source of truth) deliberately has none and `aria-expanded` is preserved; single-schema
auto-expand is a user-confirmed convenience; StrictMode's double mount fetch is dev-only and
pre-existing; the orphaned tab after a connection removal is explicitly Story 10.6; the DW-54
light-theme contrast residual is already recorded with its reason; and the `connectionScope`
spread into the mutation `execute` is unreachable while saved-connection tabs are read-only, which
is the frozen contract's own deliberate defence-in-depth, not dead code to strip.

### Verification

Re-run after review pass 3's patches landed:
- `bunx tsc --noEmit` — exit 0, no diagnostics.
- `bun test` — **1487 pass / 0 fail**, 3873 expect() calls, 75 files (baseline `6e467dc` was 1445;
  +42, all additive — 24 + 15 + 2 Core + 1 snapshot case). Pass 3 changed no assertion: its patches
  live in `loadTree`/`loadRoot`, which the harness structurally cannot reach (see the residual).
- `bun run build` — all four bundles written, exit 0.
- `grep -rn "red-400\|red-500" src/ui/schema/SchemaTree.tsx src/ui/App.tsx` — exit 1, no matches.
- `<intent-contract>` untouched by all three review passes — every pass-3 edit landed in
  `SchemaTree.tsx`, one comment in `connection-targets.test.ts`, the ledger, and the sections of
  this spec outside the contract.

### Residual risks

- **Stale catalog after an edit** is the sharpest one: it is spec-compliant but user-visible, and
  the fix needs the human who made the IG-A ruling. Ledger entry filed.
- **The laziness promise is unproven by tests.** The implementation is lazy by construction (no
  saved descriptor is reachable from the mount effect), but nothing in CI would catch a regression.
- **P3's `statesRef` mirror** adds a second reader of `states`. It is written through one helper
  and documented, but a future fourth `setStates` call site that bypasses `updateStates` would
  silently drift the ref.
- **Saved-connection tabs are read-only with no on-screen explanation** until Story 10.6 gives each
  root its own catalog.
- **The new `loadTree` retry paths are themselves untestable here** for the same reason everything
  else in the effect layer is: they live in an effect and a click handler, and the repo has no DOM
  harness. The retry's "never re-handshake a `ready` boot root" guard is reasoned, not asserted.
- **The component now leans on six refs** — `alive`, `activeRef`, `statesRef`, `bootWarningRef`,
  and pass 3's `summariesRef` and `treeSeqRef`. Each is written at one site and documented with the
  failure it exists to prevent, but that is six pieces of state living outside React's model in a
  layer with no automated coverage; the ref set is now the component's main structural risk.
- **Pass 3's patches are reasoned, not asserted.** Retention-on-failure, the shrink-only prune, the
  shared sequence token and the `loading` re-entry guard all live in `loadTree`/`loadRoot`, i.e. in
  an effect and a click handler — the same layer the ledger already records as untestable here. The
  concurrency fixes in particular (an older reply losing to a newer one) have no regression net.
- **Each review pass has found its predecessor's new code.** Pass 2 added the retry affordance and
  pass 3 found that affordance's reconciliation holes; pass 3 in turn added retention, pruning and
  sequencing to the same function. That is the argument for the follow-up review flagged above.
