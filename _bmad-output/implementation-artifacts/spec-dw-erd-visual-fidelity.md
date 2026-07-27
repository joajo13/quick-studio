---
title: 'ERD visual fidelity: surface cross-namespace FKs, dual PK+FK column badges, and AA-verified small-label contrast (DW-44, DW-65, DW-67)'
type: 'feature'
created: '2026-07-27'
baseline_revision: 'cb8e2aa4610b6634d025012900b961bed4d51922'
final_revision: 'fb282171fb9961848ba9eff65b1ed07a391f56b4'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/design-artifacts/erd.html'
warnings: ['multiple-goals', 'oversized']
---

<intent-contract>

## Intent

**Problem:** Three user-decided ERD gaps on the same view surface. (DW-44) `schemaToGraph` silently drops any FK whose referenced table is absent from the introspected set — the common MySQL case where a URL/pinned database scopes introspection to one database while `referenced_table_schema` names another (and the Postgres cross-schema equivalent) — so a real relationship vanishes with no user indication. (DW-65) A column that is both PK and FK renders only the PK key badge in the node row, because the row uses a mutually-exclusive `isPrimaryKey ? key : isForeignKey ? link : spacer` chain; join/junction identifying relationships lose their per-column FK cue (the hover panel already shows both). (DW-67) The sub-11px ERD type labels and legend were never contrast-measured in either theme, so nothing proves or enforces WCAG AA.

**Approach:** One cohesive pass over the ERD surface. (DW-44) Instead of dropping an out-of-scope FK, materialize a deduplicated **external reference node** (`type: "erdExternal"`, id = the same `tableId(referencedSchema, referencedTable)`) carrying the verbatim target namespace + table, and draw the edge to it as a **distinct dashed edge** flagged `isExternal`; graph derivation stays pure, layout/persistence keying is unchanged. (DW-65) Replace the node row's badge ternary with a fixed-width badge slot rendering PK and FK independently — the same idiom the hover panel already uses to close this case. (DW-67) Add a pure contrast helper plus a test that parses `globals.css` and asserts every ERD small-label foreground/surface pair reaches >=4.5:1 in **both** themes, then apply the minimal token darkening the measurement demands.

**Measured baseline (this run, sRGB/WCAG 2.x, on `--card`):** dark passes everywhere (`--t-text` 6.68, `--t-int` 7.00, `--t-time` 6.68, `--t-num` 8.25, `--t-enum` 7.97, `--muted-foreground` 5.88). Light **fails** on `--t-enum` `#b3781f` = **3.49** and `--t-int` `#2f6fd6` = **4.49**; light `--t-text` `#5b6472` = 5.58 already passes, so DW-67's assumed `--t-text` change is NOT required and must not be invented.

## Boundaries & Constraints

**Always:**
- External reference nodes are **derived, not introspected**: no new Core RPC, no new query, no driver change, no `contract.ts` change. The only inputs are the already-present `SchemaForeignKeyInfo.referencedSchema` / `referencedTable`.
- Identifiers render VERBATIM (`referencedSchema`, `referencedTable`, column names, data types) — never renamed, normalized, or lowercased.
- One external node per distinct absent target (`tableId(referencedSchema, referencedTable)`), reusing that exact id so a later unpinned introspection materializes the real table under the same id and inherits its persisted position.
- The Story 4.2 layout-persistence contract is preserved: `savedLayout`/`onLayoutChange`, the mount-time `initialLayoutRef` freeze, `positionsRef`/`viewportRef`, drag-stop and programmatic-vs-user move-end handling all behave as before; external nodes simply participate as ordinary positioned nodes.
- Color stays FUNCTIONAL and token-driven: the external node and dashed edge use existing neutral tokens (`--muted-foreground`, `--border`, `--edge`/`--edge-hot`); no new hue, no hardcoded palette, no coral.
- Every surface that can receive a node must tolerate a column-less node: the Story 9.5 hover panel must not render column rows (or crash) for an external node.
- Contrast conformance is asserted by a **test that reads `src/ui/styles/globals.css`** and computes ratios — not by a comment or a manual note. Threshold: WCAG AA normal text, `>= 4.5:1`, for both `:root` (dark) and `:root[data-theme="light"]`.
- `bunx tsc --noEmit` clean and all `bun test` suites green.

**Block If:**
- Surfacing the out-of-scope FK would require changing `src/shared/contract.ts` or any driver/Core introspection to distinguish a cross-database target from a cross-schema one — HALT `blocked`, condition `cross-namespace FK target not derivable from the existing wire schema`.
- The measurement shows an ERD small-label pair that cannot reach 4.5:1 without changing a token shared beyond the ERD's five type colors (e.g. `--card`, `--muted`, `--foreground`, `--muted-foreground`) — HALT `blocked`, condition `AA fix requires an epic-wide surface-token change`.

**Never:**
- Do NOT edit the deferred-work ledger (`deferred-work.md`) — the orchestrator records resolution.
- No engine sniffing in the UI: `schemaToGraph` takes only `ReadonlyArray<SchemaTableInfo>` and stays engine-neutral. Do not add an `engine` parameter to decide "cross-database vs cross-schema".
- Do not re-tune dagre for table nodes, change node/edge id formats, `markerEnd`, `dedupeTables`, `applyLayout`'s overlay semantics, or the edge build order for in-scope FKs.
- Do not touch tokens outside the ERD's own type colors — specifically leave `--err`/`--warn` (DW-58 owns those), `--t-bool`, `--t-json`, and the `--sql-*` palette alone, and do not add a `data-theme` toggle (light theme has no toggle today; that is out of scope).
- No new dependency: no color library, no jsdom/testing-library. Render tests stay `renderToStaticMarkup` string assertions.
- Do not bump the ERD label size beyond 10.5px (the size already used by the legend and hover panel) and do not introduce a size change dressed up as the contrast fix.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FK to absent table | `orders.ghost_id` -> `public.ghost`, `ghost` not in input | 1 table node + 1 `erdExternal` node (id `public\0ghost`, label `public.ghost`) + 1 edge with `data.isExternal === true` | No throw |
| MySQL cross-database FK | pinned db `shop`; `shop.orders.user_id` -> `auth.users` | external node labelled `auth.users`, dashed edge; the target database name is visible on the node | No throw |
| Two FKs, same absent target | two tables both referencing `auth.users` | exactly ONE `erdExternal` node, TWO dashed edges | No throw |
| Absent target equals an in-scope table | FK target IS present | unchanged: solid edge between real nodes, no external node created, `data.isExternal === false` | No throw |
| External node layout | graph with an external node | dagre positions it like any node; `applyLayout` overlay + `positionsOf`/`reconcilePositions` treat its id normally | No throw |
| External node hover | pointer enters an external node | its dashed edges highlight (`--edge-hot`); the column-detail panel does NOT render column rows for it | No crash on absent `data.columns` |
| PK-only column | `isPrimaryKey`, not FK | key badge in the fixed slot, FK glyph absent, name ink+bold | n/a |
| FK-only column | FK, not PK | link badge in the fixed slot, key glyph absent | n/a |
| PK∩FK column | both flags true | BOTH badges render in the slot (key then link), name ink+bold, row alignment preserved | n/a |
| Plain column | neither flag | empty fixed-width slot keeps every row's name aligned | n/a |
| Contrast, dark | `:root` tokens parsed from `globals.css` | every ERD small-label pair >= 4.5:1 (already true; test locks it) | Test fails on regression |
| Contrast, light | `:root[data-theme="light"]` tokens | every pair >= 4.5:1 after darkening `--t-enum` and `--t-int` | Test fails on regression |
| Contrast helper input | `#98a1b0`, `hsl(224 13% 11%)`, `var(--t-int)` alias | hex + space-separated `hsl()` parsed; `var(--x)` resolved against the same theme block; black/white = 21, identical colors = 1 | Throws a clear error on an unparseable value |

</intent-contract>

## Code Map

- `src/ui/erd/erd-graph.ts` — the drop is at L232 (`if (!ids.has(target)) return;`) inside the edge loop (L228-244), with the id set built at L209-210 and `tableId` at L130-132. Widen `ErdNode["type"]` (L87-94) to `"erdTable" | "erdExternal"`, make `ErdNodeData.columns` absent/empty for external nodes, add `isExternal: boolean` to `ErdEdge["data"]` (L102-111), and size external nodes off the existing `NODE_WIDTH`/`HEADER_HEIGHT`/`NODE_PADDING` constants (L120-123, `nodeHeight()` L160-162). `dedupeTables` (L176-193), `connectedNodeIds` (L147-157), `applyLayout` (L300-320), `positionsOf`, `reconcilePositions`, `sanitizeViewport`, and `typeColorClass` (L51-75) keep their contracts.
- `src/ui/workspace/ErdTabView.tsx` — `ErdTableNode` (L90-157): the 240px card (L94-97), the row flex container (L112-115), the PK/FK/spacer ternary to replace (L116-134), the name span (L135-143), the 10px type label (L144-149), `KeyIcon`/`LinkIcon` (L61-78). `ErdHoverPanel` (L271-336) already renders BOTH badges via a fixed `w-[30px]` slot (L299-321) — copy that idiom into the row; its 10.5px type label is at L331-336. `NODE_TYPES` (L160) needs the new `erdExternal` entry; the edge presentation overlay (L430-445) needs the dashed branch; `ErdLegend` is L241-262; hover state / panel gating and the `nodes as unknown as Node[]` casts are around L379-478.
- `src/ui/styles/globals.css` — dark `--t-*` L39-48, `--edge`/`--edge-hot` L50-51; light block opens L123 with `--t-*` at L143-151 and `--edge*` L152-153; surfaces `--card` L19/126, `--muted` L22/129, `--background` L17/124, `--muted-foreground` L23/130. Only two light values change.
- `src/ui/styles/contrast.ts` — NEW pure helper (no such utility exists anywhere in the repo).
- `src/ui/styles/contrast.test.ts` — NEW; reads `globals.css` from disk. Precedent for source-reading tests: `src/core/driver.test.ts:829-839` (`Bun.file(new URL(...).pathname).text()`).
- `src/ui/erd/erd-graph.test.ts` — the absent-table expectation to rewrite is L107-117 (`expect(graph.edges).toEqual([])`); cross-schema-resolves test L199-212; `isForeignKey` suite L425-451; `connectedNodeIds` L343-423.
- `src/ui/workspace/ErdTabView.test.tsx` — badge assertions use `aria-label="primary key"` / `"foreign key"`; the panel's dual-badge count test (fixture with the PK∩FK `order_id`) is at L120-159 and is the model for the new node-row assertion.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/erd/erd-graph.ts` — replace the absent-target `return` with deduplicated external-node creation (`type: "erdExternal"`, id `tableId(referencedSchema, referencedTable)`, verbatim `schema`/`name`/`label`, header-only height) and emit the edge with `data.isExternal`; register external nodes with dagre so they get positions; add `isExternal: false` for in-scope edges. Keep every other derivation byte-identical.
- [x] `src/ui/erd/erd-graph.test.ts` — rewrite the "FK to absent table" test to assert the external node + dashed-flagged edge, and add: two-FKs-one-external-node dedupe, external node carries no columns, in-scope FK still `isExternal: false`, `applyLayout` positions the external node, `connectedNodeIds` includes it. Cover the matrix's derivation rows.
- [x] `src/ui/workspace/ErdTabView.tsx` — add an `ErdExternalNode` (dashed `--border`, muted text, verbatim `schema.name`, an accessible name marking it an external/out-of-scope reference) and register it in `NODE_TYPES`; give `data.isExternal` edges a dashed stroke in the presentation overlay (keeping the `--edge`/`--edge-hot` hover treatment); replace `ErdTableNode`'s badge ternary with a fixed-width slot rendering PK and FK independently; bump the row type label 10px -> 10.5px; gate the hover column panel so a column-less external node renders no column rows.
- [x] `src/ui/styles/contrast.ts` — pure, exported `parseCssColor`, `relativeLuminance`, `contrastRatio` handling 6-digit hex and space-separated `hsl()`; throw a descriptive error on anything else.
- [x] `src/ui/styles/globals.css` — light theme only: `--t-enum: #b3781f` -> `#8f5f14` (5.14 on `--card`) and `--t-int: #2f6fd6` -> `#2c66cd` (5.04). Leave dark values, all other tokens, and `--edge-hot: var(--t-int)` aliasing untouched.
- [x] `src/ui/styles/contrast.test.ts` — unit-test the helper (black/white = 21, self = 1, hex/`hsl()` parity, bad input throws) and, reading `globals.css` for both theme blocks with `var(--x)` aliases resolved, assert every ERD small-label pair (`--t-int`, `--t-time`, `--t-num`, `--t-enum`, `--t-text`, `--muted-foreground` over `--card`) reaches >= 4.5:1 in dark AND light, failing with the measured ratio in the message.
- [x] `src/ui/workspace/ErdTabView.test.tsx` — add: a node row whose column is PK∩FK renders both badge aria-labels (the panel's existing count assertion is the model), an `ErdExternalNode` render assertion (verbatim label + external accessible name), and that a column-less external node renders no column rows in the hover panel. Keep all current assertions green.

**Acceptance Criteria:**
- Given a schema whose FK points at a table outside the introspected set, when the ERD renders, then a distinct dashed edge reaches a visibly external node naming the target namespace and table verbatim — no relationship is silently dropped.
- Given a join table with an identifying PK+FK column, when its node renders, then that row shows both the PK key badge and the FK link badge, and every other row's column name stays aligned with it.
- Given the ERD in either theme, when `bun test` runs, then the contrast test measures each ERD small-label token against its surface from `globals.css` and all pairs are >= 4.5:1; regressing any token value fails the suite with the measured ratio.
- Given a node is dragged or the canvas panned/zoomed, when the layout persists, then behavior matches Stories 4.1/4.2 exactly, external nodes included, with no console warnings (no duplicate node types, no React Flow #015).
- Given `bunx tsc --noEmit` and `bun test`, when they run, then there are no type errors and no failing suites.

## Spec Change Log

## Review Triage Log

### 2026-07-27 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 12: (high 0, medium 1, low 11)
- defer: 2: (high 0, medium 1, low 1)
- reject: 13: (high 0, medium 0, low 13)
- addressed_findings:
  - `[medium]` `[patch]` P1 — the new external node's ONLY marker was a dashed `--border` on `--card`, measured (with the change's own helper) at 1.34:1 dark / 1.19:1 light, far under WCAG 1.4.11's 3:1 for a meaning-bearing graphical object; the word "external" existed only in an `aria-label`, so DW-44's "marked as cross-database" was legible to screen readers and nobody else. Added a visible `external reference` caption row (`--muted-foreground` on `--card` = 5.88 dark / 5.60 light, AA-locked by the new test) and, since the marker is now real text, removed the hand-rolled `role="group"`/`aria-label` that had nested a named-but-unfocusable group inside React Flow's own focusable `role="group"` (`ErdTabView.tsx`).
  - `[low]` `[patch]` P2 — the sole render-level assertion for DW-44 (`toContain("react-flow__edge")`) was vacuously true: React Flow emits `react-flow__edges` unconditionally, so it passes with zero FKs (verified empirically). Replaced with derivation + style assertions that can actually fail (`ErdTabView.test.tsx`).
  - `[low]` `[patch]` P3 — the dashed-edge treatment was inline in a `useMemo`, so a source grep was its only evidence. Extracted the pure exported `erdEdgeStyle({hot, isExternal})` and unit-tested all four hot×external combinations (`ErdTabView.tsx`, `ErdTabView.test.tsx`).
  - `[low]` `[patch]` P4 — `parseCssColor` promised "never guesses, throws loudly" but `[0-9.]+` accepted `hsl(1.2.3 50% 50%)` and returned `{r:191,g:64,b:NaN}` (verified). Tightened the numeric patterns, added an S/L range check and a finite-channel throw (`contrast.ts`).
  - `[low]` `[patch]` P5 — the AA test's `if (ratio < 4.5) throw` was dead on pass, its trailing `expect` dead on failure, and `NaN < 4.5` is `false`, so a non-finite ratio skipped the descriptive message the AC promises. Rewritten to collect failures and assert once with each measured ratio (`contrast.test.ts`).
  - `[low]` `[patch]` P6 — the test locked only `--card` while the Design Notes asserted `--muted`/`--background` also clear AA (prose, unproven, and the node header + canvas really use them). Now asserts all three surfaces × six tokens × both themes; all pass, thinnest margin light `--t-time` on `--muted` = 4.52 (`contrast.test.ts`).
  - `[low]` `[patch]` P7 — the CSS parser was comment-blind with last-match-wins semantics, and this very change added comments naming `--t-bool`/`--t-int`; a future `/* --t-int: was #2f6fd6; */` would have silently shadowed the real token. Comments are now stripped before extraction, with a test proving it (`contrast.test.ts`).
  - `[low]` `[patch]` P8 — `new URL(import.meta.url).pathname` yields `/C:/…` on native Windows (the repo has a `windows-latest` release leg); now passes the `URL` object straight to `Bun.file` (`contrast.test.ts`).
  - `[low]` `[patch]` P9 — an FK with a blank `referencedTable` (which the old `return` incidentally dropped) synthesized a nameless ghost card; `schemaToGraph` is documented pure and total, so it now skips such an FK explicitly, with tests (`erd-graph.ts`, `erd-graph.test.ts`).
  - `[low]` `[patch]` P10 — external nodes declared `nodeHeight(0)` = 42 (padding for a rows container they do not render), offsetting the dagre-centre→top-left conversion, and the push loop duplicated that constant in an unreachable `??` fallback. Replaced with one `EXTERNAL_NODE_HEIGHT = HEADER_HEIGHT + ROW_HEIGHT` (56 — header + caption row) used in both places (`erd-graph.ts`).
  - `[low]` `[patch]` P11 — the hover panel was never actually gated (it relied on `.map` over `[]`), so hovering an external node floated an empty `--card` box duplicating the label with no external cue. Now gated on `type === "erdExternal"` at the call site, while `ErdHoverPanel` stays tolerant of empty columns (`ErdTabView.tsx`).
  - `[low]` `[patch]` P12 — comment accuracy: the always-empty-`columns` invariant moved onto `ErdNodeData` (it had been documented on `ErdNode`, which does not hold columns); dropped an unreachable "self-referential external edge" branch note; corrected `contrast.ts`'s false claim to handle "exactly the two notations globals.css uses" (it also has 8-digit hex and `rgba`, deliberately out of scope); removed `ErdExternalNode`'s dead `source` handle and its wrong comment.

### 2026-07-27 — Follow-up review pass

- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 1, low 8)
- defer: 4: (high 0, medium 3, low 1)
- reject: 13: (high 0, medium 0, low 13)
- addressed_findings:
  - `[medium]` `[patch]` P13 — the P9 blank-`referencedTable` guard ran BEFORE the in-scope check, so it dropped the FK of a table that is actually PRESENT in the introspected set whenever that table's name is whitespace-only. `"   "` is a legal quoted identifier in both Postgres and MySQL, so this silently loses a real in-scope relationship — the exact failure DW-44 exists to prevent, reintroduced by its own hardening patch. The guard is now gated on `isExternal`, so it only suppresses the synthesis of a NAMELESS external card and can never drop an edge to a present table (`erd-graph.ts`, plus a test asserting the whitespace-named table keeps a solid `isExternal: false` edge).
  - `[low]` `[patch]` P14 — `ErdHoverPanel`'s docstring described a design P11 had already removed ("a hovered node with no columns simply renders zero column rows here"), directly contradicting the gate 300 lines below that guarantees an external node never reaches the component. Rewritten to state the real contract: the tolerance is a defensive property, not the canvas's path (`ErdTabView.tsx`).
  - `[low]` `[patch]` P15 — P3 extracted `erdEdgeStyle` and unit-tested all four `hot`×`isExternal` combinations, but the seam that actually decides the DW-44 dashed treatment is the WIRING that feeds it `e.data.isExternal`; replacing that argument with a literal `false` left the entire suite green (verified). The P11 panel gate had the same shape — new production behaviour reachable only through a real pointer hover, which `renderToStaticMarkup` cannot produce, so it had zero coverage while the one related test drove `ErdHoverPanel` with a shape the canvas can no longer hand it. Extracted the pure `erdEdgeOverlay(edges, hoveredNodeId)` and `erdHoverPanelData(nodes, hoveredNodeId)` and covered both (9 tests: hover on source and on external target, dash-iff-external, 1:1 id/data/order pass-through, and all three panel-suppression rules) (`ErdTabView.tsx`, `ErdTabView.test.tsx`).
  - `[low]` `[patch]` P16 — the P8 docstring justified itself with "this repo ships a `windows-latest` CI leg", implying a red build. Verified false: `grep -rn "bun test" .github/workflows/` returns only `keyring-spike.yml`'s single `src/core/keychain.test.ts`, and `release.yml`'s Windows job builds and smoke-tests a binary without running the suite. The fix itself is correct and kept; the comment now states the real stake (a developer on native Windows) and no longer implies the lock is CI-enforced (`contrast.test.ts`).
  - `[low]` `[patch]` P17 — the AA lock omitted `--foreground`, the ERD's most PROMINENT small text: the node header label (12.5px) and every PK column name (12px) render `text-[var(--foreground)]`, on `--muted` and `--card` respectively. Measured before adding (dark 12.94-15.50, light 15.84-18.23), so this locks a margin rather than fixing a failure — but it was the one unguarded gap in a list whose whole purpose is to be exhaustive for the ERD (`contrast.test.ts`).
  - `[low]` `[patch]` P18 — the same docstring framed the node row's 10px -> 10.5px bump as "the node-row's own (post-DW-67) type-label size", dressing a size change as part of the contrast fix, which the intent contract's Never explicitly forbids. The size is within the contract's <=10.5px allowance and stays; the comment now says plainly that WCAG's large-text exception starts at 18.66px bold / 24px, so 10px and 10.5px are held to the identical 4.5:1 and the bump moves nothing about conformance (`ErdTabView.tsx`).
  - `[low]` `[patch]` P19 — the block-extraction test asserted the literals `#e0a458` and `#ef6a63`, so any unrelated palette edit would fail a test whose subject is the dark/light block BOUNDARY, with a misleading "extraction broke" signal. Now asserts the relationships that actually prove no swallowing (both blocks define `--t-enum` to different values; the dark-only `--err` is present in dark and absent from light), leaving value locks to the measurement block where they belong (`contrast.test.ts`).
  - `[low]` `[patch]` P20 — both reviewers independently measured that the ERD's own hover dim (`opacity: 0.4` on every unconnected node) composites the locked tokens down to ~1.6-2.1:1, so the header's claim that "every ERD small-label pair reaches >= 4.5:1" is true only of the at-rest canvas. The dim is Story 7.4's, pre-existing and deferred (DW-98); the lock now carries an explicit SCOPE note pointing at it, rather than reading as a guarantee it cannot make (`contrast.test.ts`).
  - `[low]` `[patch]` P21 — `tableId` still embedded a RAW NUL byte in its template literal, which made git classify `erd-graph.ts` as BINARY (`Bin 16951 -> 21633 bytes` in this story's own diff): no textual diff, no blame ranges, no reviewable PR view of the module. The P2-era work had already converted the two NULs in the edge-id literal to the `\0` escape, so the file was one character away from being text and got none of the benefit. Converted the last one — byte-identical at runtime, so persisted node ids and saved layouts are unaffected — and recorded the convention in the docstring so it is not reintroduced (`erd-graph.ts`).

## Design Notes

**Why external nodes are engine-neutral.** DW-44 is written for MySQL cross-database FKs, but `SchemaForeignKeyInfo` has a single `referencedSchema` field that holds the database on MySQL and the schema on Postgres — there is no third field, and `schemaToGraph` receives no engine. Both drivers deliberately leave the *referenced* side of FK introspection unfiltered while scoping the *owning* side (`driver-mysql.ts:179-191` `mysqlSchemaScope`, `driver-postgres.ts:490-495`), so the exact same "target never materialized" condition produces MySQL cross-database and Postgres cross-schema orphans. Treating any absent target as an external reference implements the decision faithfully (distinct, dashed, labelled with the target namespace, not dropped) without inventing an engine discriminator the contract cannot supply.

**Why a fixed badge slot for DW-65.** `ErdHoverPanel` already closes DW-65 with `<span className="inline-flex w-[30px] shrink-0 items-center gap-1">` plus two independent `&&` renders. Mirroring that in the compact row keeps one idiom for both surfaces, and a fixed slot (rather than a slot that grows only on PK∩FK rows) is what preserves the alignment the current 13px spacer exists to protect — at the cost of ~17px of the name's truncation budget inside the fixed 240px card, which already truncates via `min-w-0 truncate`.

**DW-67 is a measurement task, not a repaint.** The decision assumed `--t-text` was the offender; measuring says otherwise (dark 6.68 / light 5.58 on `--card`). The two real light-theme failures are `--t-enum` (3.49) and `--t-int` (4.49). Both fixes are hue-preserving darkenings that also clear `--muted` (4.78 / 4.69) and `--background` (5.50 / 5.40), so they hold on every ERD surface. Note `--t-enum` currently duplicates `--t-bool`'s light value; after this change they diverge intentionally — `--t-bool` (data grid) stays out of scope. Sketch of the helper's core:

```ts
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseCssColor(a));
  const lb = relativeLuminance(parseCssColor(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
```

## Verification

**Commands:**
- `bunx tsc --noEmit` — expected: exit 0, no errors in `erd-graph.ts`, `ErdTabView.tsx`, `contrast.ts`, or the touched tests.
- `bun test` — expected: all suites pass, including the rewritten absent-target derivation tests, the node-row dual-badge assertion, and the two-theme contrast assertions.
- `bun test src/ui/styles/contrast.test.ts src/ui/erd/erd-graph.test.ts src/ui/workspace/ErdTabView.test.tsx` — expected: focused green run for the three touched areas.

**Manual checks:**
- `rg 'strokeDasharray|erdExternal' src/ui` — the dashed treatment and the external node type exist only in the ERD presentation layer, not in derivation-independent code paths.

## Auto Run Result

Status: done

### Summary
Follow-up review pass over the committed DW-44 / DW-65 / DW-67 change (no re-implementation: the intent contract held, no finding was rooted in it, and no spec amendment was needed). Two adversarial reviewers ran in parallel over the full diff since the baseline; 26 findings deduped to 9 patches, 4 deferrals and 13 rejections.

The one finding with real consequence was **P13**: the previous pass's own hardening patch (P9, the blank-`referencedTable` guard) ran BEFORE the in-scope check, so it dropped the FK of a table that is genuinely PRESENT in the introspected set whenever that table's name is whitespace-only — a legal quoted identifier in both Postgres and MySQL. That is the precise failure DW-44 was written to eliminate, reintroduced on a narrower input by the fix for a different edge case. The guard is now gated on `isExternal`, so it only ever suppresses the synthesis of a nameless external card.

The rest split into two groups. **Test integrity (P15):** the previous pass extracted `erdEdgeStyle` to make the dashed treatment testable, but unit-testing the style function left the seam that actually decides it — the wiring feeding it `e.data.isExternal` — uncovered; replacing that argument with a literal `false` kept the whole suite green (verified empirically). The P11 hover-panel gate had the same shape, with zero coverage, while the only related test drove `ErdHoverPanel` directly with a shape the canvas can no longer produce. Both seams are now pure exported functions (`erdEdgeOverlay`, `erdHoverPanelData`) with 9 tests between them. **Claim accuracy (P14, P16, P18, P20):** four docstrings asserted more than the code delivers — a design P11 had removed, a CI leg that does not run this suite, a size bump framed as part of the contrast fix the intent contract forbids dressing up that way, and an AA guarantee that does not survive the ERD's own hover dim. Each was corrected against verified evidence rather than deleted. **P17** closed the one real gap in the lock's coverage (`--foreground`, the ERD's most prominent small text, measured and passing), **P19** removed palette literals from a test about block boundaries, and **P21** converted the last raw NUL byte in `erd-graph.ts` to the `\0` escape, which is what had been making git classify the module as binary — no textual diff, no blame, no reviewable PR view — throughout this story's own review.

### Files changed (this pass)
- `src/ui/erd/erd-graph.ts` — the blank-target guard gated on `isExternal` (P13); the last raw NUL byte in `tableId` converted to the `\0` escape, with the convention recorded so it is not reintroduced (P21). The file is now text to git for the first time. No change to ids, positions, `markerEnd`, dedupe or layout.
- `src/ui/erd/erd-graph.test.ts` — a test that a whitespace-named table which IS in scope keeps a solid, `isExternal: false` edge (P13).
- `src/ui/workspace/ErdTabView.tsx` — the pure `erdEdgeOverlay` and `erdHoverPanelData` extracted from the `useMemo` and the JSX IIFE, both call sites rewired (P15); `ErdHoverPanel`'s docstring corrected on the P11 contradiction and the 10.5px framing (P14, P18). Rendered output is unchanged by construction.
- `src/ui/workspace/ErdTabView.test.tsx` — 9 tests covering the two extracted seams (P15).
- `src/ui/styles/contrast.test.ts` — `--foreground` added to TOKENS (P17); the CI justification corrected to the verified facts (P16); palette literals replaced with boundary relationships (P19); an explicit SCOPE note that the lock measures the at-rest canvas, not the hover-dimmed state (P20).
- `_bmad-output/implementation-artifacts/deferred-work.md` — four NEW entries appended (DW-97..DW-100). No existing entry was modified, re-opened or rewritten.

### Review findings breakdown
- **Patches applied (9):** one medium (P13, above) and eight low — a contradicted docstring, two untested production seams, a false CI justification, the lock's one uncovered token, a size change framed as conformance work, palette literals in a boundary test, a missing scope caveat, and the raw NUL byte that made the module unreviewable in git.
- **Deferred (4), appended to the ledger as DW-97..DW-100:**
  1. `[medium]` DW-97 — light `--t-bool` `#b3781f` = **3.49:1**, the exact amber `--t-enum` was darkened away from, still rendering the data grid's header type tag as text at `--label-size`. The intent contract forbade touching it. (Scope-checked: the sibling `--t-json` is only a 6px schema-tree dot, so it answers to 1.4.11's 3:1 and clears it except on `--muted` — folded in at lower stakes.)
  2. `[medium]` DW-98 — the ERD dims unconnected nodes to `opacity: 0.4` on hover, compositing every locked token down to ~1.6-2.1:1. Story 7.4's overlay, untouched here; the fix is a design decision (raise the dim floor vs. dim chrome only vs. accept it as transient), not a repair.
  3. `[medium]` DW-99 — no CI workflow runs the test suite. `release.yml` (Windows leg included) builds and smoke-tests a binary; the only `bun test` in `.github/workflows` is `keyring-spike.yml`'s single `keychain.test.ts`. All 1906 tests, including this story's AA lock, are a local convention rather than a gate.
  4. `[low]` DW-100 — `src/core/driver.test.ts:829-839` still uses `new URL(import.meta.url).pathname`, unopenable on native Windows; the identical pattern was fixed here as P8 but the precedent was out of scope.
- **Rejected (13):** `--t-int` being a shared token (disclosed in residual risks; the excluded-token comment never claimed otherwise); the `--muted`/`--background` rows being over-constraining (harmless redundancy, and P17 makes `--muted` genuinely binding); the dashed edge lacking a contrast fallback (every ERD edge shares `--edge`; the meaning is carried by the node's caption); `trim()` deciding while the raw value keys identity (cannot arise — an FK's `referencedTable` and the table's `name` come from the same catalog read, so whitespace matches); the edge-id separator "changing from a space to `\0`" (false premise, re-verified: the baseline carried literal NUL BYTES, so the escape is the same runtime string — the reviewer's tooling rendered them as spaces, exactly as the prior pass found); `EXTERNAL_NODE_HEIGHT` being over-argued (the value is consistent with the file's existing approximation model); the 17px truncation tax and its now-inert spacer (deliberate and disclosed; the explicit spacer documents intent); a cascade-aware fallback in `resolveToken` (throwing loudly is a defensible design, and no token in TOKENS relies on the cascade — already reasoned and rejected in the prior pass); the height test being tautological (true of every constant lock; it pins the intended value); a `typeof` guard for a non-string `referencedTable` (typed same-repo boundary, derived from NOT NULL catalog columns); an FK badge on a column whose blank-target edge was skipped (the badge states the column IS an FK, which is factual, and predates the change); stale hover surviving an external-to-real node swap (a variant of the already-tracked open DW-66, and with the pointer stationary over the same coordinates showing the panel is defensible); and a falsy `data` reaching the panel (the reviewer's own low confidence; React Flow always populates it).

### Verification
- `bunx tsc --noEmit` -> exit 0.
- `bun test` -> **1906 pass, 1 skip, 0 fail** (10282 expect calls, 87 files). 1896 -> 1906 as 10 tests were added; zero regressions. The 9 `bin/quick-studio-shim.test.ts` failures recorded as this box's stale baseline did not occur.
- `bun test src/ui/styles/contrast.test.ts src/ui/erd/erd-graph.test.ts src/ui/workspace/ErdTabView.test.tsx` -> 94 pass, 0 fail.
- Reviewer claims verified rather than accepted: `grep -rn "bun test" .github/workflows/` returns only the two `keychain.test.ts` hits (P16/DW-99 confirmed); light `--t-bool` = 3.49 / 3.25 / 3.73 and `--t-json` = 3.21 / 2.99 / 3.44, and `--foreground` = 12.94-15.50 dark / 15.84-18.23 light, all re-measured with the repo's own helper before adding or deferring; `--t-json`'s only consumer traced to `SchemaTree.tsx:179` -> a 6px `bg-t-json` dot at `:387`, which downgrades it from the AA text failure the reviewer reported to a 1.4.11 near-miss; `--t-bool`'s consumer traced to `DataGrid.tsx:29` -> rendered as `color` at `:402`, confirming it IS text; the "edge id changed to `\0`" claim disproved by byte-inspecting the baseline blob (3 raw NULs) against the current file.
- `git diff --stat` on `erd-graph.ts` still reports `Bin` in this pass only because the OTHER side of the comparison (HEAD) is the binary one; from this commit forward the file diffs as text.

### Follow-up review recommendation
`false` — the pass converged. Half the findings (13 of 26) were noise, and two of them were re-raisals of claims the previous pass had already investigated and rejected with the same verified reasoning, which is the signal that the surface has been exhausted. Nothing reached high severity, the four deferrals are all pre-existing or contract-forbidden and now recorded, and only two of the nine patches touch behaviour at all: a one-line guard reorder covered by a dedicated test, and a mechanical extraction that is output-identical by construction and carries 9 new tests. The rest are comments, test assertions and one runtime-identical byte. That is not the breadth that warrants another independent pass.

### Residual risks (unchanged from the implementation pass, plus)
- The AA lock is a local convention, not a gate (DW-99): nothing in CI runs it, so a future sub-AA token can land with a green checks column.
- The lock measures the at-rest canvas only. The ERD's own hover dim puts every measured label far below AA for as long as the pointer rests on a node (DW-98); the `SURFACES` comment now says so, but the behaviour is unchanged.
- Light `--t-bool` still fails AA as rendered text in the data grid (DW-97) — the same value DW-67 judged a failure for `--t-enum`, deliberately left in place by the intent contract.
- `--t-int` and `--t-enum` remain shared beyond the ERD (`DataGrid.tsx`, `SchemaTree.tsx`, `ConfirmRun.tsx`), so the light-theme darkening repaints those surfaces too; direction is strictly toward higher contrast.
- The light theme still has no toggle in `src/`, so every light-side fix and lock is verified by measurement and test rather than by use.
- P13's fix is exercised only by a synthetic whitespace-named table; no real database in the fixtures has one, so the guarantee rests on the unit test rather than an end-to-end path.
