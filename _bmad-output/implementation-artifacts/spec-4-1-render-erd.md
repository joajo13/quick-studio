---
title: 'Story 4.1: Render and navigate the relational ERD'
type: 'feature'
created: '2026-07-11'
status: 'done'
baseline_revision: 'fae2b7f304e9fcf94846c8cfbb566ae02feb8c17'
final_revision: 'ee5fc07af2e5d47d09a4441fdae27ab6fe4a9a60'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** The workspace has an `erd` tab placeholder but no way to see the connected schema visually, and the engine-neutral schema shape carries no foreign-key data — so table relationships cannot be drawn at all.

**Approach:** Extend Core introspection to surface foreign keys through the existing `DatabaseSchema` shape, then render a pannable/zoomable node-edge ERD tab — tables as nodes listing their columns, foreign keys as edges — fed by App's already-lifted `allTables` state. View-only; layout persistence is Story 4.2.

## Boundaries & Constraints

**Always:**
- Foreign-key introspection lives only in the Core drivers (Ring 3). Rings 2/3 consume the uniform engine-neutral `DatabaseSchema`; no engine-specific SQL or dialect branching leaks into the UI.
- Table and column identifiers render **verbatim** — never renamed or normalized.
- Graph derivation (nodes, edges, computed layout) lives in a pure, DOM-free module unit-tested with `bun test`; the React Flow canvas stays a thin wrapper.
- The ERD's data source is App's already-lifted `allTables` (introspected tables + optimistically-created tables) so a table created via Epic 3's builder appears without a manual refresh.
- Pan and zoom must stay fluid on a schema of 60–70 tables.
- The FK field is added **additively** to `SchemaTableInfo` — existing consumers (table/query tabs, SchemaTree) keep working unchanged.

**Block If:**
- The FK field cannot be added to `SchemaTableInfo` additively — i.e., surfacing it would force a breaking change to the wire `DatabaseSchema` shape that other consumers depend on. HALT with status `blocked`.
- Foreign keys cannot be introspected into one uniform `IntrospectedForeignKey` shape across both Postgres and MySQL without pushing engine-specific structure past the driver layer. HALT with status `blocked`.

**Never:**
- Persist or restore ERD layout, or write anything about the ERD to disk in any mode — that is Story 4.2.
- Mutate the schema through the diagram (view-only for v1; editing is v2).
- Add a new Core RPC method — reuse the existing `connect` payload's `DatabaseSchema`.
- Infer edges heuristically from column names or index conventions — edges come only from real introspected foreign keys.
- Add a schema-refresh / re-introspection mechanism.

## I/O & Edge-Case Matrix

Applies to the pure graph-derivation module (`erd-graph.ts`), input = `ReadonlyArray<SchemaTableInfo>`.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tables with FKs | tables each carrying `foreignKeys` | one node per table (name + column rows, PK columns marked); one edge per FK (source table → referenced table) | No error expected |
| No foreign keys | tables with empty `foreignKeys` | nodes only, zero edges | No error expected |
| Self-referential FK | table whose FK references itself | a self-loop edge on that node | No error expected |
| FK to absent table | `referencedTable` not present in the input set | edge is omitted; render does not crash | Skip edge, no throw |
| Composite FK | one FK spanning multiple columns | a single edge (not one edge per column) | No error expected |
| Empty schema | `tables: []` | empty graph → view renders an empty-state message | No error expected |

</intent-contract>

## Code Map

- `src/shared/contract.ts` -- ring-neutral wire types; `DatabaseSchema` / `SchemaTableInfo` (add FK type + field here).
- `src/core/driver.ts` -- `Driver` interface, `IntrospectedColumn/Index`, pure `assembleSchema` fold (add `IntrospectedForeignKey` + FK fold branch).
- `src/core/driver-postgres.ts` -- Postgres introspection SQL (add FK query).
- `src/core/driver-mysql.ts` -- MySQL introspection SQL (add FK query).
- `src/core/driver.test.ts` -- existing pure tests for `assembleSchema` (add FK cases).
- `src/ui/App.tsx` -- owns lifted `allTables` (schema + created tables); ERD data source, passed to `TabContent`.
- `src/ui/schema/CreateTablePanel.tsx` -- builds a `SchemaTableInfo` optimistically; must set the new `foreignKeys` field (empty).
- `src/ui/workspace/TabContent.tsx` -- `tab.kind` body dispatch; `erd` currently falls through to a placeholder (add branch).
- `src/ui/workspace/QueryTabView.tsx` -- template to mirror for a tab body + its `.test.tsx` convention.
- `src/ui/rpc/client.ts` -- `rpc<T>()`; schema arrives via the `connect` reply (no new call needed).
- `package.json` / `scripts/build-ui.ts` -- Bun build; new UI deps must bundle here.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/contract.ts` -- add `SchemaForeignKeyInfo` (`columns`, `referencedSchema`, `referencedTable`, `referencedColumns`) and an additive `foreignKeys: ReadonlyArray<SchemaForeignKeyInfo>` field on `SchemaTableInfo` -- edges need FK data in the engine-neutral shape.
- [x] `src/ui/schema/CreateTablePanel.tsx` -- set `foreignKeys: []` on the optimistic `SchemaTableInfo` it builds -- keep the new required field a non-breaking compile.
- [x] `src/core/driver.ts` -- add an `IntrospectedForeignKey` flat shape and fold FKs by table in `assembleSchema`, mirroring the index fold -- keep grouping pure and dialect-free.
- [x] `src/core/driver-postgres.ts` -- introspect FKs (`pg_constraint contype='f'` joined via `key_column_usage`/`constraint_column_usage`, or `information_schema.referential_constraints`) into `IntrospectedForeignKey`, preserving column order -- Postgres edges.
- [x] `src/core/driver-mysql.ts` -- introspect FKs (`information_schema.key_column_usage` + `referential_constraints`) into `IntrospectedForeignKey`, preserving column order -- MySQL edges.
- [x] `src/core/driver.test.ts` -- add `assembleSchema` cases covering FK grouping, composite FK, and self-referential FK (the I/O-matrix fold behavior).
- [x] `package.json` -- add `@xyflow/react` (React Flow, React 19-compatible) and `@dagrejs/dagre` for deterministic auto-layout -- pannable/zoomable canvas + testable positions.
- [x] `src/ui/erd/erd-graph.ts` -- pure `schemaToGraph(tables)` returning React-Flow nodes/edges with dagre-computed positions; implements every I/O-matrix scenario -- testable graph model, thin canvas.
- [x] `src/ui/erd/erd-graph.test.ts` -- unit tests for all six I/O-matrix scenarios via `bun test`.
- [x] `src/ui/workspace/ErdTabView.tsx` -- React Flow canvas with a custom table node (header = `schema.name`, rows = `name : dataType`, PK columns marked), FK edges, pan/zoom, and an empty-state when there are no tables -- the ERD surface.
- [x] `src/ui/workspace/ErdTabView.test.tsx` -- static `renderToStaticMarkup` tests: empty-state renders, and a sample schema renders table names -- structural coverage.
- [x] `src/ui/workspace/TabContent.tsx` -- add an `erd` branch returning `<ErdTabView tables={...} key={tab.id} />`, replacing the placeholder body -- wire the tab.
- [x] `src/ui/App.tsx` -- pass `allTables` down to `TabContent` so `erd` tabs receive live schema (including Epic-3-created tables) -- ERD data source.

**Acceptance Criteria:**
- Given a connected Postgres or MySQL database with foreign keys, when I open a "New ERD" tab, then each table renders as a node listing its columns (PK columns marked) and each foreign key renders as an edge to the referenced table.
- Given the ERD tab is open on a 60–70 table schema, when I drag the canvas or scroll/pinch to zoom, then the diagram pans and zooms and stays responsive.
- Given I create a table via the create-table builder, when the ERD tab is (or becomes) active, then the new table appears as a node without a manual refresh.
- Given either Ephemeral or Persistent mode, when I use the ERD, then nothing about the ERD or its layout is written to disk.
- Given a schema with zero tables, when I open the ERD tab, then an empty-state message renders and nothing crashes.

## Design Notes

- **Library choice:** React Flow (`@xyflow/react` v12) for the pannable/zoomable node-edge canvas; `@dagrejs/dagre` for deterministic top-down layout, computed inside `erd-graph.ts` so node positions are pure and unit-testable. React Flow ships CSS (`@xyflow/react/dist/style.css`) — confirm it bundles through `bun scripts/build-ui.ts` (Bun bundler + `bun-plugin-tailwind`) as part of verification. If React Flow cannot bundle cleanly under Bun, the fallback is a hand-rolled SVG pan/zoom canvas driven by the same `erd-graph.ts` model — but try React Flow first.
- **Purity boundary:** `erd-graph.ts` is DOM-free — `schemaToGraph(tables) => { nodes, edges }`. `ErdTabView` only feeds that into `<ReactFlow>` and registers the custom node type. This keeps interactive pan/zoom out of the test surface (there is no jsdom) while making the graph model fully testable.
- **Node look:** dark, tool-like table card using existing CSS tokens (`--background`, `--border`, `--muted`) — tonal surface + border, no drop-shadows, per the shadcn-style aesthetic.

## Verification

**Commands:**
- `bun test` -- expected: all tests pass, including new `assembleSchema` FK-fold cases and `erd-graph.test.ts`.
- `bunx tsc --noEmit` -- expected: no type errors (there is no typecheck npm script; run directly).
- `bun run build` -- expected: UI bundles successfully with `@xyflow/react` (and its CSS) via the Bun build.

**Manual checks:**
- `bun run dev`, connect to a database with foreign keys, open "New ERD": tables render as nodes listing columns, FK edges connect the right tables, and the canvas pans and zooms.

## Review Triage Log

### 2026-07-11 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 1, low 0)
- defer: 0
- reject: 13: (high 0, medium 2, low 11)
- addressed_findings:
  - `[medium]` `[patch]` `ErdTabView` (`src/ui/workspace/ErdTabView.tsx`) set `nodesConnectable`/`elementsSelectable` to false but never `nodesDraggable`, which React Flow defaults to `true` — so ERD nodes were draggable despite the story's view-only / no-rearrangement scope (Story 4.2 owns node dragging), and dragging a controlled `nodes` prop with no `onNodesChange` trips React Flow error #015. Added `nodesDraggable={false}` + explanatory comment.
- notes:
  - The "NUL-separator collision" finding was re-raised by both reviewers (they read the `${schema}\0${name}` join as a space) and re-confirmed a **false positive** via hexdump: the separator is a genuine NUL byte (0x00), the comments are accurate, and NUL is never legal in a SQL identifier — no collision is possible. Matches the prior pass's rejection.
  - Two medium-consequence rejects (ERD layout reset / pan-zoom loss on `tables` change; cross-schema referenced-side FK silently dropped) are **already tracked** in `deferred-work.md` from the prior pass — not re-appended to avoid ledger duplicates.

### 2026-07-11 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 1, medium 1, low 1)
- defer: 4: (high 1, medium 1, low 2)
- reject: 6: (medium 2, low 4)
- addressed_findings:
  - `[high]` `[patch]` `schemaToGraph` (`src/ui/erd/erd-graph.ts`) did not dedup its input `tables`; duplicate `schema+name` entries (reachable via `allTables = [...schemaTables, ...createdTables]` after a reconnect) produced duplicate React Flow node/edge ids → key-violation + overlapping nodes. Added a pure `dedupeTables` (first-win, mirroring SchemaTree's `mergeTables`, with an FK-carrying entry replacing an empty-`foreignKeys` duplicate in place) + a regression test.
  - `[medium]` `[patch]` FK edges were built with no `markerEnd`, so the ERD showed no relationship direction. Added `markerEnd: { type: MarkerType.ArrowClosed }` to every edge (incl. self-referential) in the pure module + a test.
  - `[low]` `[patch]` Corrected a misleading comment in `ErdTabView.tsx` that claimed node dragging was enabled (it is not — pan/zoom only; node rearrangement + layout persistence belong to Story 4.2).

## Auto Run Result

Status: done

### Follow-up review pass (2026-07-11)

An independent follow-up review (Blind Hunter + Edge Case Hunter, same model capability) re-examined the committed Story 4.1 change (`fae2b7f..a4f1803`).

- **Patch applied (1):** `ErdTabView` did not disable `nodesDraggable`, so ERD nodes were draggable despite the documented view-only / no-rearrangement scope (React Flow defaults it to `true`; a controlled `nodes` prop with no `onNodesChange` also trips error #015). Added `nodesDraggable={false}`.
- **Rejected (13):** notably the re-raised "NUL-separator collision" — re-confirmed a false positive by hexdump (the `schema`/`name` join is a real 0x00 NUL byte, not a space; NUL is never a legal SQL identifier char, so the comment is correct and no collision exists). The remaining rejects were type-cast-at-seam, dedup-completeness under an invariant that already holds, dagre dimension estimates, SSR test coupling, optional-prop defaults, NaN-coordinate guard (unreachable), and composite-FK differing-target (impossible per constraint semantics).
- **Deferred (0 new):** two real medium-consequence items surfaced (ERD layout reset / pan-zoom loss on `tables` change; cross-schema referenced-side FK silently dropped) are already logged in `deferred-work.md` from the initial pass, so no new ledger entries were added.
- **Verification:** `bunx tsc --noEmit` → exit 0; `bun test` → 599 pass / 0 fail (33 files); `bun run build` → exit 0.
- **Follow-up review recommended:** false — this pass made a single localized, low-complexity fix (one prop) with no behavioral/API/data impact.

### Original run

### Summary
Implemented Story 4.1: added foreign-key introspection to the Core (Postgres + MySQL) surfaced additively on `SchemaTableInfo` and folded by `assembleSchema`, then built an interactive, pannable/zoomable ERD tab (tables as nodes listing columns with PK markers, FKs as directional edges) fed by App's lifted `allTables`. View-only; no layout persistence (Story 4.2); no new RPC (reuses the `connect` payload).

### Files changed
- `src/shared/contract.ts` — added `SchemaForeignKeyInfo` + additive `foreignKeys` field on `SchemaTableInfo`.
- `src/core/driver.ts` — `IntrospectedForeignKey` flat shape + dialect-free FK fold in `assembleSchema` (composite collapse, phantom-table guard).
- `src/core/driver-postgres.ts` — FK introspection via `pg_constraint contype='f'` with `unnest(conkey,confkey) WITH ORDINALITY` (position-aligned composite columns).
- `src/core/driver-mysql.ts` — FK introspection via `information_schema.key_column_usage` + `referential_constraints`.
- `src/core/driver.test.ts` — `assembleSchema` FK cases (grouping, composite, self-ref, phantom).
- `src/ui/schema/create-table.ts` — set `foreignKeys: []` on the optimistic `SchemaTableInfo`.
- `src/ui/erd/erd-graph.ts` (new) — pure `schemaToGraph` (dedup, dagre layout, directional edges).
- `src/ui/erd/erd-graph.test.ts` (new) — all six I/O-matrix scenarios + dedup + arrowhead.
- `src/ui/workspace/ErdTabView.tsx` (new) — React Flow canvas, custom table node, empty-state.
- `src/ui/workspace/ErdTabView.test.tsx` (new) — `renderToStaticMarkup` structural tests.
- `src/ui/workspace/TabContent.tsx`, `src/ui/workspace/Workspace.tsx`, `src/ui/App.tsx` — wire the `erd` tab body and thread `allTables`.
- Test fixtures updated for the new required field: `src/core/{connection,executor,table-rows,server}.test.ts`, `src/ui/schema/create-table.test.ts`.
- `package.json` / `bun.lock` — added `@xyflow/react` + `@dagrejs/dagre`.

### Review findings breakdown
- **Patches applied (3):** ERD input dedup (high); directional edge arrowheads (medium); misleading node-drag comment (low).
- **Deferred (4):** `createdTables` never reset on reconnect (pre-existing Epic-3 lifecycle); PG partition inherited-FK edges (`conparentid`); ERD reshuffle on table creation (→ Story 4.2); cross-DB MySQL FKs silently dropped. All logged in `deferred-work.md`.
- **Rejected (6):** NUL-separator collision (false positive — separator is a real NUL byte, comment is correct); no live-DB FK SQL tests (matches project's synthetic-row convention, no live-DB infra); class-string test brittleness (SSR-only test constraint); dagre height estimate (reasonable approximation); unrendered edge column data (harmless future-use payload); degenerate self-loop visual (renders per spec, cosmetic).

### Verification performed
- `bun test` → 599 pass / 0 fail (33 files).
- `bunx tsc --noEmit` → exit 0.
- `bun run build` → exit 0 (React Flow + its CSS bundle cleanly through the Bun builder; no SVG fallback needed).

### Residual risks
- FK-introspection SQL is exercised only via synthetic rows (project convention; no live-DB test harness) — real-engine composite/cross-schema behavior is unverified by automated tests.
- Follow-up review recommended: the high-severity dedup fix introduced new graph-derivation logic (first-win + in-place FK replacement) whose semantics warrant an independent look.
