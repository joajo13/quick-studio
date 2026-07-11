# Epic 4 Context: Interactive ERD

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic lets a developer read a connected database's structure visually instead of table-by-table: tables render as nodes showing their columns, foreign-key relationships render as edges, and the diagram pans and zooms fluidly up to schemas of 60–70 tables. In Persistent mode the developer's rearranged layout is saved and restored on the next launch, so the diagram reopens the way they left it. It builds directly on the live schema and shell delivered earlier and rounds out the visual-inspection half of the daily-driver experience. v1 is view/navigate only — editing the schema *through* the diagram is explicitly out of scope (v2).

## Stories

- Story 4.1: Render and navigate the relational ERD
- Story 4.2: Persist and restore ERD layout

## Requirements & Constraints

- Render an interactive ERD of the connected schema: tables as nodes listing their columns, foreign keys as edges between them.
- The diagram must be navigable (pan/zoom) and stay responsive on schemas of at least 60–70 tables — fluidity is a hard requirement, not degrading under size.
- In Persistent mode, a rearranged layout is saved and restored on relaunch. In Ephemeral mode nothing about the ERD (or any layout) is ever written to disk.
- A table created via the create-table builder (Epic 3) must appear in the ERD without a manual refresh.
- View-only for v1: no schema mutation through the diagram.
- Interactions should feel instant (<100ms UI response) in keeping with the tool's lightweight identity.

## Technical Decisions

- The ERD consumes a single **engine-neutral schema shape** produced by the Core — the same uniform shape for PostgreSQL and MySQL. Rings 2/3 never see engine-specific SQL or introspection; all dialect handling stays in the Core behind one driver interface.
- Database identifiers (table and column names) mirror the live database **verbatim** — never renamed or normalized in the schema/ERD layer.
- The ERD is **Ring-2 UI state** and its rendering lives in the UI ring (`src/ui/`). The three-ring trust model governs: data flows outward from the Core; the ERD only receives schema data, it holds no DB access or credentials.
- Layout persistence is Ring-2 state saved **via the Core** only in Persistent mode, written under the single OS-convention app directory (Windows `%APPDATA%\quick-studio`; Linux `$XDG_DATA_HOME/quick-studio` else `~/.local/share/quick-studio`), alongside panel/session state and Reports. Ephemeral mode writes nothing.
- In-app diagram rendering belongs to Ring 2 (the in-app charting rule places Recharts/shadcn charts in Ring 2 vs Observable Plot in the sandbox; the ERD is an in-app Ring-2 surface). The specific graph/diagram library is a code-level choice, not fixed by planning.
- Large-schema responsiveness is a UI concern here; the Core owns pagination/virtualization for large *result sets*, but the ERD's fluidity at 60–70 tables is achieved in the rendering layer.

## UX & Interaction Patterns

- The ERD is one of the openable/closable **Tabs** in the Workspace, reachable from the left launcher rail; multiple Tabs (table, query, ERD, chat, report) coexist and closing one leaves the others intact.
- Dark-first shadcn/ui aesthetic — clean, restrained, tool-like; depth from tonal surface layering and borders, not drop-shadows. Motion serves feedback only, never decoration.
- Pan/zoom must stay fluid on large schemas (the ERD half of the result-grid + ERD responsiveness UX requirement).

## Cross-Story Dependencies

- Depends on **Epic 1** for the live connection, the Core's engine-neutral schema introspection, and the Tabs/Panels shell the ERD renders inside.
- Story 4.2 (persist layout, FR-13) depends on **Epic 2**'s persistence substrate (the app directory and Persistent mode); without it the ERD still renders (4.1) but nothing is saved.
- Tables created by **Epic 3**'s create-table builder must surface in the ERD live.
