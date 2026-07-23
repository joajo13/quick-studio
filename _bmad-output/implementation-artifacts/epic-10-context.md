# Epic 10 Context: Multi-Connection Workspace (DBeaver-style multi-root tree)

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make quick-studio genuinely multi-connection. Today the app is effectively single-connection: the boot connection manager is created once at startup and its URL is immutable for the whole session, so in persistent mode (which boots with no URL) you can save connections but never browse them — the schema tree dies with a misleading "unsupported scheme / no connection target" error. A multi-target, lazily-resolved connection pool already exists and is consumed only by Reports; everything else (table rows, chat, the schema tree) is clamped to the boot manager. This epic propagates an opaque `connectionId` from the UI down through the seams that already exist, classifies "no target" as its own calm outcome rather than a crash, scopes and privilege-aligns introspection, and turns the schema sidebar into a DBeaver-style multi-root tree — one collapsible root per saved connection, introspected lazily on expand, with tabs that remember which connection they belong to.

## Stories

- Story 10.1: Classify "no connection target" as its own failure kind (implemented — verify/regress only)
- Story 10.2: Optional per-connection schema scope
- Story 10.3: Align privileged introspection with visible tables
- Story 10.4: Core resolves every read path by connectionId
- Story 10.5: Multi-root schema tree
- Story 10.6: Tabs carry their connection (and survive its removal)

## Requirements & Constraints

- **Ephemeral mode must be byte-for-byte unchanged.** A missing/null `connectionId` always falls back to the boot manager as the default target. Every existing test must stay green; no story may require a `connectionId` to be supplied.
- **No boot-time handshake storm.** Connection roots render immediately without introspecting; introspection happens lazily on first expand. Twenty saved connections must not mean twenty handshakes at startup.
- **Failure isolation.** One connection failing (bad creds, unreachable host, missing schema) shows its error inline on its own root with a retry affordance and must never degrade the other roots, the tab strip, or workspace restore.
- **Credential neutrality in every message.** No URL, user, password, or raw driver text may appear in any error surfaced to the UI. Connection failures stay engine-neutral and classified (host / auth / network / no-target).
- **Scoped introspection is in-query, not post-fetch.** A connection pinned to a schema must never fetch metadata for out-of-scope tables — the filter belongs inside the introspection queries for both engines.
- **Privilege-honest tree.** A restricted database role must never see phantom tables: index/table metadata visibility must agree with what the privilege-filtered catalog views already expose.
- **Out of scope:** cross-connection joins or queries — each tab runs against exactly one connection.

## Technical Decisions

- **Only the opaque `connectionId` crosses the loopback RPC boundary.** URL, user, and password are resolved inside the Core from the saved-connection record; the UI never holds or transmits connection secrets. This is a hard invariant of the three-ring trust model and cannot be relaxed for convenience.
- **The Core is the sole holder of DB connections and the sole SQL executor.** Adding a target selector changes *which* connection Ring 1 resolves, never *who* holds it. No ring's powers widen in this epic.
- **Resolution goes through the existing multi-target pool** (lazy, cached, registry-invalidated per id) rather than touching the boot manager directly. `id = null` resolves to the boot manager. The read paths to convert are schema fetch/connect, table rows, and the chat responder.
- **Engine-dialect isolation.** All engine-specific introspection, filtering, and pagination stays inside the Core behind the uniform driver interface; Rings 2/3 see one engine-neutral shape. Schema scoping and privilege alignment must be implemented per-driver (Postgres and MySQL) behind that same shape.
- **Typed error envelope.** Every RPC reply is a typed result or a single `code / message / detail` envelope. "No connection target" is a first-class classified failure kind consumed by the UI — not a thrown exception wrapped as a generic internal error, and not a string match on the message text (the interim hack in the schema tree retires with 10.1).
- **Persisted workspace state gains connection identity.** Tab/table references carry a `connectionId` that is written into the persisted workspace snapshot, so restore reopens each tab against the right database. Persistence only exists in persistent mode; ephemeral writes nothing to disk.
- **Saved-connection record gains an optional schema field** (optional everywhere: record, store, and the Settings form). Omitting it preserves today's behavior — all non-system-catalog tables.

## UX & Interaction Patterns

- The approved interactive mockup at `_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html` is the visual and behavioral source of truth for the tree: per-root idle → loading → ready → error progression, lazy-introspect-on-expand, the empty state, and the missing-connection tab state.
- **Tree hierarchy is three levels: connection → schema → tables → columns.** Each root shows a status dot, connection name, engine badge, and host. Schema is its own collapsible level (a Postgres database has many); the default schema is tagged, table counts are shown per schema, views get a distinct icon, and a connection with a single visible schema auto-expands it so the user is not forced to click twice. Tables expand to columns with type-dots and PK marking exactly as the current single-root tree does.
- A connection with a pinned schema shows a pin badge on its root so the scoping is visible, not silent.
- **Empty state is calm, not alarming**: a "Sin conexión activa" placeholder with a hint to add one in Settings and an add-connection affordance — never the red connection-error alert.
- **A restored tab whose connection was removed** lands in a "conexión no disponible" state with a reassign affordance, siblings untouched.
- Keep the existing neutral visual language (no coral, no new palette) and the established tree accessibility contract: rows are keyboard-operable (`role="button"`, `tabindex="0"`, Enter/Space activation) with `aria-expanded` on expandable nodes.

## Cross-Story Dependencies

- **10.4 is the backbone.** 10.5 (multi-root tree) and 10.6 (tabs carry connection) both depend on the Core resolving reads by `connectionId`; 10.5 also depends on 10.1's typed no-target kind for its empty state and on 10.3's classified introspection errors for its per-root error rendering.
- **10.2 feeds 10.5**: the pinned schema comes from the saved-connection record and is what the tree's schema level scopes to; it also touches the Settings connection form from the connection-management epic.
- **10.3 and 10.2 both land in the same driver introspection code** — coordinate them so schema filtering and privilege alignment are applied consistently across the columns, PK, index, and FK queries of both engines.
- Builds on the encrypted credential store and connection-management surfaces (Epic 2), the guarded Core executor and table-rows paths (Epic 3), the persisted workspace/tab model (Epics 2 and 8), and the chat responder's connection binding (Epic 5). The multi-target pool itself arrived with Reports (Epic 6) — this epic generalizes its consumers.
