# Epic 6 Context: Local Report Generation

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn query results into an exportable, self-contained HTML Report — the product's marquee differentiator. A developer assembles a Report from one or more query results, mixing narrative, charts, and tabular data; builds it against a test database and re-targets it at production without rebuilding the layout; and exports it as either a static Snapshot (data frozen at build time, renders fully offline) or a Live Report (re-queries its target on view through a running quick-studio). The whole workflow is local: report building, preview, and export never send data to any external service. This epic reuses the Epic 5 sandbox and the shared frozen-data contract, and it is what makes "can you send me a report on the database?" a quick, private, local job.

## Stories

- Story 6.1: Build a Report from query results
- Story 6.2: Test-to-production Report targeting
- Story 6.3: Export as a static Snapshot
- Story 6.4: Export as a Live Report

## Requirements & Constraints

- A Report can combine results from more than one query, mixing charts, prose, and tabular data as MDX Blocks.
- A Report built against one database can be re-targeted at another; re-targeting re-runs the Report's queries against the new target and must not require rebuilding the layout.
- Export offers two forms: a static Snapshot renders identical, frozen data when reopened later, fully disconnected from any database; a Live Report re-queries its target on view via a connection the viewer supplies.
- Report building, preview, and export must send no data to any external service — the entire workflow is local-first.
- Reports are Persistent-mode artifacts (saved to the app directory); in Ephemeral mode nothing is persisted.

## Technical Decisions

- **Canonical frozen-data shape (AR-11):** a single shared, versioned frozen-data schema defined in `src/shared/` is the only shape embedded in a Snapshot — the same shape the sandbox consumes. Wire conventions bind every boundary: ISO-8601 UTC dates and typed values, never live JS `Date` objects on one path and ISO strings on another. This contract already exists (born in Epic 1); consume it, do not redefine it.
- **All SQL runs in the Core (AR-2):** re-targeting and Live Report re-queries execute through the Core, the sole SQL executor and connection holder. The UI/report never queries a database directly.
- **Live Report carries no credential and no DB runtime (AR-12 / AD-9):** a Live Report holds no secret and no embedded database driver. It re-queries only by targeting a running quick-studio Core on `127.0.0.1`. If opened with no running quick-studio to authorize it, it cannot reach any database on its own.
- **Live Report is an explicit second caller (AR-5 / AD-12):** the Core authorizes a Live Report explicitly as a caller with the session capability token and validates Origin/Host — it is never authorized implicitly just by hitting the loopback port. The viewer supplies the connection.
- **Charting split by ring (AR-14):** in-app report charts (Ring 2, the builder/preview) use Recharts; charts rendered inside the sandbox (Ring 3) use Observable Plot. TradingView lightweight-charts is not used.
- **Sandbox reuse (AR-4):** executable-JS MDX Blocks in a Report render only inside the Epic 5 cross-origin, pure-render sandbox — separate origin, `sandbox="allow-scripts"` without `allow-same-origin`, CSP `default-src 'none'`/`connect-src 'none'`, one-way postMessage. No new escape surface may be introduced.
- **Persistence location (AR-9):** saved Reports live under the one OS-convention app directory (Windows `%APPDATA%\quick-studio`; Linux `$XDG_DATA_HOME/quick-studio`, else `~/.local/share/quick-studio`). Ephemeral mode writes nothing (AR-8).
- **Report code spans rings:** build/compose in `src/ui/`, query in `src/core/`, executable-JS/chart render in `src/sandbox/`.

## UX & Interaction Patterns

- A Report is a Tab in the Workspace, opened from the left rail, freely openable/closable alongside table/query/ERD/chat tabs.
- Aesthetic is the project's custom, monospace-first, dark-first design system (light at full parity) — restrained and precise, the anti-DBeaver "precision instrument that happens to be lightweight."
- Export is a secondary action rendered as a quiet ghost button, not a primary emphasis.

## Cross-Story Dependencies

- **Requires Epic 3** — query results are the raw material for Reports, and re-target/Live re-queries route through the Epic 3 guarded Core executor.
- **Requires Epic 5** — reuses the cross-origin executable-JS sandbox, MDX rendering, and charting established there.
- **Requires Epic 1** — consumes the canonical frozen-data contract in `src/shared/` and the Core session-capability token / Origin-Host validation.
- **Requires Epic 2** — persistent saving of Reports depends on the Persistent-mode app directory (Ephemeral saves nothing).
- Within the epic: Story 6.1 (build) is the foundation; 6.2 (re-target), 6.3 (Snapshot export), and 6.4 (Live Report export) all build on an assembled Report. Snapshot (6.3) and Live Report (6.4) are the two export forms of the same Report.
