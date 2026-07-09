# Epic 3 Context: Data & Schema Workspace

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic delivers the daily database work that defines whether a developer will actually switch to this tool: browse table rows with pagination, edit cell values, insert and delete rows, create tables, inspect indexes, and run ad-hoc SQL against a connected PostgreSQL or MySQL database. Every one of these mutations routes through a single guarded Core executor that is the sole system-wide classifier of statement risk and blocks raw destructive statements by default — so that no query, hand-written or later AI-generated, can silently mutate or drop data, while routine inline grid edits stay fast and dialog-free. It builds directly on the connection and workspace shell established earlier and the saved connections from Persistent mode, and it stands up the executor that AI Chat and Reports later reuse.

## Stories

- Story 3.1: Single guarded Core executor — two request shapes, confirmation by shape, adversarial guard
- Story 3.2: Browse table rows with pagination
- Story 3.3: Edit, insert, and delete rows
- Story 3.4: Create tables
- Story 3.5: Inspect indexes
- Story 3.6: Run ad-hoc SQL in a query Tab

## Requirements & Constraints

- Browse and edit data: view table rows paginated, edit cell values, insert and delete rows, committed to the database. An edited cell must persist on reload; a newly inserted row must appear on reload; deletion must require confirmation.
- Create tables: define columns, types, a primary key, and basic constraints; the created table must appear in the schema without a manual refresh (and in the ERD once that epic exists).
- Inspect indexes: view a table's indexes, each listing its columns and its uniqueness.
- Run ad-hoc SQL: write and run arbitrary SQL in a query Tab; a SELECT returns a paginated result grid; a destructive statement requires explicit confirmation before executing.
- Large-result responsiveness: result grids must stay responsive under large tables/result sets through Core-owned pagination/virtualization, never by degrading. The Core never ships a whole live result set.
- Interaction latency: common actions (open table, switch tab, first result paint) should feel instant — UI response under ~100ms; first result paint is bounded by the database, not the tool.

## Technical Decisions

- Single guarded executor (the linchpin): every mutation passes through exactly one Core executor, which is the sole risk classifier. A UI confirmation dialog is UX only — it is never the security gate. All mutation is always parameterized. Build this executor first, before any row-editing UI, and ship it with its adversarial test battery.
- Two request shapes, confirmation policy set by shape:
  - Path (a) structured operations: typed, parameterized UI-builder requests carrying only table + primary key + column/value fields (single-row grid DML) or a create-table spec. The Core composes the SQL. This path can express only a single-row INSERT/UPDATE/DELETE or a CREATE TABLE — never DROP/TRUNCATE/ALTER, never raw SQL, multi-row, or multi-statement. INSERT, single-row UPDATE, and CREATE TABLE auto-commit with no dialog; row DELETE always confirms.
  - Path (b) raw SQL text: opaque text from the query Tab (and later AI). UPDATE/DELETE/DROP/TRUNCATE/ALTER are default-deny and always confirmed. Multi-statement input (e.g. `SELECT 1; DROP TABLE users`) is rejected or split so no destructive statement rides behind a safe one. DROP/TRUNCATE/ALTER can arrive only on this path.
- Adversarial guard is part of shipping the executor: test bypass attempts on both paths — statement smuggling, casing tricks, comment tricks on path (b); structured-field injection, primary-key tampering, DDL/multi-row escalation on path (a). The invariant to prove: path (a) can never widen into a destructive statement.
- Trust-model boundary: the Core is the sole secret-holder, SQL executor, and connection owner. Ring 2 (UI) issues typed requests and receives results; it never composes or holds raw SQL for structured operations. Data flows outward only; capability never flows inward.
- Engine-dialect isolation: all engine-specific SQL, introspection, and pagination live only in the Core behind one uniform driver interface. Rings above see a single engine-neutral shape for both PostgreSQL and MySQL. Database identifiers mirror the live database verbatim.
- Wire convention: every Core RPC reply is a typed result or a single error envelope (`code` / `message` / `detail`). Secrets are never logged.

## UX & Interaction Patterns

- Dark-first, restrained shadcn aesthetic; monospace is the voice of the interface — result-grid cells, table/column names, schema tree, tabs, and the SQL editor all render in mono. Numeric columns use tabular-nums so digits align.
- Schema-tree table click loads that table's grid into the active data tab and names the tab; one active table at a time; keyboard-operable.
- Result grid: single-select rows with an inset coral left-marker on the selected row; hover tint; sticky headers; columns colored by SQL type so the shape of a result reads before the words do; PK marked with a key icon.
- Inline edit fast-path: editing a single cell or inserting a single row is structured single-row DML — it auto-commits with NO dialog (the fast-path exemption that keeps daily editing fluid).
- Destructive-action surface: a clear confirmation appears before executing a row delete, or any raw/AI-generated mutating or DDL statement (DELETE/DROP/TRUNCATE/UPDATE/ALTER) from the query Tab. The dialog is UX only; the Core executor is the real gate. Esc closes the topmost confirmation dialog. The exact dialog anatomy (copy, button order) is left to this epic's visual pass — specified behaviorally only.
- States: an empty result renders headers with 0 rows and reads "0 rows" (no decorative empty art); large results stay fluid via pagination/virtualization.

## Cross-Story Dependencies

- Story 3.1 (the guarded executor) is the foundation for the whole epic: Stories 3.3 (edit/insert/delete), 3.4 (create table), and 3.6 (ad-hoc SQL) all route their mutations through it and depend on it existing first.
- The epic depends on the earlier connection + engine-neutral driver and the workspace Tabs/Panels shell, and on saved connections from Persistent mode.
- Downstream: the same guarded executor is reused by AI Chat (natural-language query execution and its destructive-statement confirmation) and by Report query re-targeting — so its interface and guarantees are consumed beyond this epic.
