---
title: 'DW-68 — schema tree draws the mockup view icon for `kind: "view"` relations'
type: 'feature'
created: '2026-07-27'
status: 'done'
baseline_revision: '6e63115'
final_revision: '9cfaf89'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** `epic-10-multi-connection-tree.mockup.html` draws views with their own eye glyph (`.view-ico`, tinted `--t-json`) — its annotations call out that "`reporting`'s items render with the view icon" — but `src/ui/schema/SchemaTree.tsx` renders every relation with the same table glyph, so a view is visually indistinguishable from a physically-stored table in the tree.

**Approach:** The Ring-1 half of DW-68 already shipped: `SchemaTableInfo.kind?: "table" | "view" | "other"` exists in the contract and both drivers surface it (`pg_class.relkind` `v`, `information_schema.tables.table_type` `VIEW`/`SYSTEM VIEW`). Only the UI leaf remains — add a `ViewIcon` beside the existing `TableIcon` in `SchemaTree.tsx` and branch the table row on `table.kind === "view"`, plus fold the distinction into the row's existing `title` tooltip so it is not glyph-only.

## Boundaries & Constraints

**Always:**
- The mockup is the contract. Copy the eye glyph verbatim from `epic-10-multi-connection-tree.mockup.html`'s `viewSvg` (`<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>` + `<circle cx="12" cy="12" r="2.5"/>`), on the same `viewBox="0 0 24 24"`, `strokeWidth={1.8}`, `h-3.5 w-3.5 shrink-0` chrome the existing `TableIcon` uses.
- The view tint is `text-t-json` and is UNCONDITIONAL — the mockup's `.row .view-ico { color: var(--t-json) }` beats `.row.on`, so an ACTIVE view row keeps the teal eye and does not flip to `text-coral`.
- Only `kind === "view"` branches. `"table"`, `"other"` and an ABSENT `kind` all keep today's `TableIcon` with today's `on ? "text-coral" : "text-muted-foreground"` — the contract's own doc comment mandates that consumers treat absent as unknown and take the conservative arm.
- Follow this file's icon a11y convention: the SVG carries `aria-hidden` and carries no `aria-label`/`<title>`. Meaning reaches assistive tech through the row `title` attribute, as `title={\`schema pineado: …\`}` already does.
- `TableIcon` itself is untouched. The change is purely additive at module and call-site level.

**Block If:**
- The eye glyph would require a new CSS token, a `globals.css` edit, or any change to `src/shared/contract.ts` or either driver.
- `table.kind` turns out NOT to reach the row (i.e. some layer rebuilds `SchemaTableInfo` field-by-field and drops it) — that would make this a plumbing story, not a UI leaf.

**Never:**
- Do not touch `src/shared/contract.ts`, `src/core/driver-postgres.ts`, `src/core/driver-mysql.ts`, or `src/ui/styles/globals.css`.
- Do not touch the other three independent copies of the table glyph (`ErdTabView.tsx:51`, `Workspace.tsx:58`, `TabBar.tsx:21`) or factor them into a shared icon module — out of scope.
- Do not invent a glyph for `kind: "other"`; the mockup has none.
- Do not add `--t-json` to `src/ui/styles/contrast.test.ts`'s ERD `TOKENS` list — that list is the ERD's scope and the token's shortfall is already ledgered (see Design Notes).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| View relation | `table.kind === "view"`, row inactive | Eye glyph, `text-t-json`; no table `rect`; row `title` ends `· vista` | No error expected |
| ACTIVE view relation | `table.kind === "view"`, `on === true` | Eye glyph STILL `text-t-json` (not `text-coral`); row keeps `bg-coral-soft text-coral` | No error expected |
| Base table | `table.kind === "table"` | Today's table glyph, `on ? "text-coral" : "text-muted-foreground"`; `title` is the bare `schema.name` | No error expected |
| Unknown kind | `kind` absent (driver supplied no relation metadata) | Table glyph — the conservative arm; bare `title` | No error expected |
| Other relation | `table.kind === "other"` (partitioned parent / foreign table) | Table glyph; bare `title` | No error expected |
| Mixed schema group | One schema holding a view and a table | Both glyphs render side by side in the same `<ul>` | No error expected |

</intent-contract>

## Code Map

- `src/ui/schema/SchemaTree.tsx` -- `TableIcon` (L132-147, module-private, single call site at L369) and the table-row JSX inside `group.tables.map` (L339-374), including the row `title` at L361. The ONLY file to change.
- `src/shared/contract.ts` -- `SchemaRelationKind` (L336) and `SchemaTableInfo.kind?` (L366). Read-only: import the type, change nothing.
- `src/ui/schema/schema-tree-state.ts` -- `connectStateFromReply` (L197) stores the reply verbatim; `mergeTables` (L179) and `groupBySchema` (L156) push whole table references. Verified: `kind` survives to the row untouched. Read-only.
- `_bmad-output/planning-artifacts/epic-10-multi-connection-tree.mockup.html` -- `viewSvg` (L316), `.row .view-ico` (L176). The glyph + tint source of truth.
- `src/ui/schema/SchemaTree.test.tsx` -- `renderToStaticMarkup` over exported `ConnectionRoot`; local `table()` fixture (L34-48) builds a `SchemaTableInfo` with NO `kind`; `renderRoot()` helper (L80-108).
- `src/ui/schema/schema-tree-state.test.ts` -- pure-function tests for `groupBySchema`/`mergeTables`.
- `src/ui/styles/globals.css` -- `--t-json` (L42 dark / L164 light) and its Tailwind registration `--color-t-json` (L220), which is what makes `text-t-json` resolvable. Read-only.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/schema/SchemaTree.tsx` -- add a module-private `ViewIcon()` beside `TableIcon`, taking no props (colour is fixed `text-t-json`, mirroring the prop-less `SchemaIcon`), carrying `aria-hidden` and the mockup's eye paths -- so the view glyph is a verbatim port of the mockup rather than a variant of the table glyph.
- [x] `src/ui/schema/SchemaTree.tsx` -- at the row call site (L369) branch `table.kind === "view" ? <ViewIcon /> : <TableIcon className={on ? "text-coral" : "text-muted-foreground"} />` -- so only `view` diverges and every other kind (including absent) keeps today's exact behaviour.
- [x] `src/ui/schema/SchemaTree.tsx` -- append `· vista` to the row `title` (L361) when `table.kind === "view"` -- so the distinction is not glyph-only for a screen-reader or zoomed user, using the file's established row-`title` convention instead of an icon `aria-label`.
- [x] `src/ui/schema/SchemaTree.test.tsx` -- extend the local `table()` fixture with an optional trailing `kind?: SchemaRelationKind` that is OMITTED (not set to `undefined`) when not supplied, then add a `describe("ConnectionRoot — view icon (DW-68)")` covering every row of the I/O matrix -- so the conservative-arm cases are locked as tightly as the happy path.
- [x] `src/ui/schema/schema-tree-state.test.ts` -- assert `kind` survives `groupBySchema` and `mergeTables` -- so the silent regression class (a future field-by-field rebuild dropping `kind`) fails the suite instead of blanking the feature.

**Acceptance Criteria:**
- Given a `ready` root whose schema holds one `kind: "view"` and one `kind: "table"` relation, when the schema node is expanded, then the rendered markup contains BOTH the eye path and the table `rect` exactly once each.
- Given the change is applied, when `git diff` is inspected, then no file outside `src/ui/schema/` is modified and `TableIcon`'s own body is unchanged.
- Given the full suite, when `bun test` runs, then it is green with the baseline 1976 pass plus exactly the new tests, 0 fail.

## Spec Change Log

## Review Triage Log

### 2026-07-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 0, low 5)
- defer: 4: (high 0, medium 1, low 3)
- reject: 9
- addressed_findings:
  - `[low]` `[patch]` The row `title` is only a LAST-RESORT accessible name — name-from-content wins on this `role="button"` row, so `· vista` never reaches a screen reader and both glyphs are `aria-hidden`; the spec's own a11y justification was therefore false. Added a `<span className="sr-only">vista</span>` marker to the view row so the distinction lands in the accessible NAME (precedent: `src/ui/components/ui/dialog.tsx:63`). The tooltip stays for sighted mouse users.
  - `[low]` `[patch]` The test named "never text-coral" asserted only `toContain("text-t-json")`, so APPENDING `text-coral` to `ViewIcon`'s className left the suite green (mutation-verified, 0 fail) while Tailwind's later-wins order would silently turn the glyph coral. Now pinned to the exact class attribute via `VIEW_ICON_CLASS`.
  - `[low]` `[patch]` The mockup's pupil `<circle cx="12" cy="12" r="2.5">` was asserted nowhere — deleting it kept the suite green (mutation-verified), leaving "copy the glyph verbatim" only half-locked. Added a `VIEW_PUPIL` assertion.
  - `[low]` `[patch]` The mixed-schema test (the one mapping to the primary AC) counted each glyph once and never bound a glyph to a row, so a fully INVERTED branch passed it (mutation-verified). Added a `rowOf()` slicer and per-row positive/negative glyph assertions; inverting the branch now fails 6 tests instead of 5.
  - `[low]` `[patch]` `expect(groups[0]?.tables[0]?.kind).toBeUndefined()` was vacuous — optional chaining satisfies it on an empty result. Added `toHaveLength` guards; `groupBySchema` returning `[]` now fails 17 tests.

## Design Notes

Why the teal is unconditional: the mockup's `tableHtml` emits `${isView ? viewSvg : tblSvg}` regardless of the row's `on` state, and `.row .view-ico { color: var(--t-json) }` and `.row .tbl-ico { color: currentColor }` have equal specificity with `view-ico` declared later — so a selected view row keeps its teal eye in the mockup. The React shell already diverges from the mockup on the row itself (`bg-coral-soft text-coral` where the mockup uses `--ink-soft`/`--ink`), but the glyph rule is exactly what DW-68's ledger entry names, so it is ported literally.

Contrast, measured honestly against the real tokens (icon ⇒ WCAG 1.4.11, 3:1): dark `--t-json` `#3ec6b6` clears comfortably everywhere (6.15–8.80 on `--background`/`--card`/`--muted`/`coral-soft`). Light `--t-json` `#1a9b8c` measures 3.44 on `--background`, 3.22 on `--card`, but **2.99 on `--muted`** (the hover state) and **2.82 on `coral-soft`-over-`--card`** (the selected state) — marginally short. This is NOT a new defect class: `contrast.test.ts:235-240` already records `--t-json` as a known sub-3:1-on-`--muted` token in this exact tree (the `bg-t-json` type dots) and explicitly defers it. The distinction here is also carried by SHAPE (eye vs grid) and by the row `title`, not by colour alone, so no information is lost at low contrast. Fixing `--t-json`'s light value is a `globals.css` change this presentation-only slice is contract-forbidden to make; it belongs with the already-ledgered token work.

Golden shape for the new component:

```tsx
/** Table-row leading icon for a VIEW — the mockup's `.view-ico` eye glyph (DW-68). */
function ViewIcon(): React.JSX.Element {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
         className="h-3.5 w-3.5 shrink-0 text-t-json">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}
```

## Verification

**Commands:**
- `export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit` -- expected: exits 0, no diagnostics.
- `export PATH="$HOME/.bun/bin:$PATH" && bun test src/ui/schema/` -- expected: all pass, including the whole new DW-68 describe.
- `export PATH="$HOME/.bun/bin:$PATH" && bun test` -- expected: full suite green, 0 fail. Baseline at HEAD `6e63115` is 1976 pass / 1 skip / 0 fail across 91 files; the total must be baseline + the number of tests added, with nothing lost.
- `git status --porcelain` -- expected: exactly three modified files, all under `src/ui/schema/` (`SchemaTree.tsx`, `SchemaTree.test.tsx`, `schema-tree-state.test.ts`), plus this spec; nothing under `src/core/`, `src/shared/`, or `src/ui/styles/`.
- `git diff -- src/ui/schema/SchemaTree.tsx | grep -E '^-'` -- expected: only the two lines being replaced (the `<TableIcon .../>` call site and the row `title`); no removal inside `TableIcon`'s body.
- `git grep -n 'M2 12s3.5-7 10-7' -- src ':!*.test.tsx'` -- expected: exactly one hit, in `SchemaTree.tsx` (the test file legitimately spells the same literal to assert on it; excluding tests keeps this a real single-source-of-truth check rather than a reason to obfuscate the test's string).

## Auto Run Result

Status: done

### Implemented change

DW-68's remaining UI half. The schema tree's table row now branches its leading glyph on `SchemaTableInfo.kind`: a relation whose kind is `"view"` renders a new module-private `ViewIcon()` — the mockup's `.view-ico` eye glyph, verbatim, in an unconditional `text-t-json` teal that does not flip to coral when the row is selected — while `"table"`, `"other"` and an ABSENT `kind` all keep today's exact `TableIcon` behaviour (the conservative arm the contract's own doc comment mandates). The distinction also reaches non-visual users: the row `title` gains a ` · vista` suffix for the tooltip, and an `sr-only` marker puts it in the row's accessible NAME (added during review — see the triage log; the tooltip alone does not reach a screen reader).

No contract, driver, or token change: `SchemaTableInfo.kind` and both drivers' introspection already shipped, and `kind` was verified to survive `connectStateFromReply` → `mergeTables` → `groupBySchema` untouched because none of them rebuilds a table object field-by-field.

### Files changed

- `src/ui/schema/SchemaTree.tsx` — added `ViewIcon()`; branched the row glyph and the row `title` on `kind === "view"`; added the `sr-only` "vista" marker. `TableIcon`'s own body is byte-for-byte unchanged.
- `src/ui/schema/SchemaTree.test.tsx` — `table()` fixture gained an optional `kind` (conditionally spread, so an unsupplied kind is genuinely ABSENT); new `ConnectionRoot — view icon (DW-68)` describe with 6 tests covering every I/O-matrix row, plus a `rowOf()` slicer that binds each glyph to its own row.
- `src/ui/schema/schema-tree-state.test.ts` — 2 tests locking that `kind` survives `groupBySchema` and `mergeTables`.
- `_bmad-output/implementation-artifacts/deferred-work.md` — appended DW-114..DW-117 (append-only; the DW-68 entry itself was not touched).

### Review findings breakdown

- **Patches applied: 5** (all low severity) — the `title`-is-not-an-accessible-name a11y gap, and four test-strength defects each proven by a surviving mutation: an appended `text-coral` on the glyph, a deleted pupil `<circle>`, a fully inverted icon branch passing the mixed-schema test, and a vacuous optional-chained assertion. All five now fail the suite. Details in the Review Triage Log.
- **Items deferred: 4** — DW-114 (views distinguishable in the tree but not in the tab bar / ERD / workspace), DW-115 (editing a view surfaces a raw "expected exactly one primary-key column, got 0"), DW-116 (light-theme `--t-json` at 2.82–2.99:1, under the 3:1 icon minimum), DW-117 (blank-schema tooltip renders a leading bare dot).
- **Items rejected: 9** — chiefly: the Postgres matview `relkind 'm' → "table"` mapping (verified deliberate, documented in `driver-postgres.ts:96-101`, and unreachable through `information_schema.columns` today); runtime validation of a non-canonical `kind` string (no contract surface in this same-process app validates at runtime); a relation literally named `… · vista`; `extraTables` never carrying a view (optimistically-created relations are always tables, and `mergeTables` preservation is unit-tested); and assertion brittleness to SVG attribute reordering (the repo-wide tradeoff of `renderToStaticMarkup` string assertions, and the negative guards are already backstopped by positive assertions of the same literal in sibling tests).

### Verification performed

- `bunx tsc --noEmit` — exit 0, no diagnostics.
- `bun test` — **1984 pass / 1 skip / 0 fail**, 91 files, 10503 expect() calls. Baseline at `6e63115` measured directly before any edit: 1976 pass / 1 skip / 0 fail. Baseline + exactly 8 new tests, nothing lost.
- `git status --porcelain` — only the three files under `src/ui/schema/`; nothing under `src/core/`, `src/shared/` or `src/ui/styles/`.
- `git diff -- src/ui/schema/SchemaTree.tsx | grep '^-'` — only the two replaced lines; `TableIcon`'s body untouched.
- `git grep 'M2 12s3.5-7 10-7' -- src ':!*.test.tsx'` — exactly one hit.
- **Mutation-tested, twice.** First pass (4 mutations, all killed): dropping the icon branch, dropping the ` · vista` suffix, widening the branch to `!== "table"`, and recolouring the glyph to `text-coral`. Second pass after the review patches, re-running the five mutations the reviewers proved survivable: appending `text-coral` (2 fail), deleting the pupil circle (1 fail), inverting the branch (6 fail, up from 5 — the mixed test now catches it), dropping the `sr-only` marker (1 fail), and making `groupBySchema` return `[]` (17 fail). No guard in this change is vacuous.
- Contrast figures in the Design Notes were computed independently from the shipped token values, compositing the translucent `--coral-soft` over its base rather than treating it as opaque.

### Residual risks

- **Static-markup only.** The repo has no jsdom, so `renderToStaticMarkup` proves the right classes and paths are emitted, never that the browser composites them. `text-t-json` was confirmed to compile to `.text-t-json{color:var(--t-json)}` in the built bundle, but the hover and selected states are reasoned about, not observed.
- **The accessible-name improvement is untested against a real screen reader.** The `sr-only` marker is the correct mechanism per accessible-name computation and matches the repo's existing `dialog.tsx` precedent, but no AT was driven over it.
- **Light-theme contrast stays marginally under 3:1** on the hover and selected backgrounds (DW-116). Deliberately not fixed — the token is shared and lives in a file this spec is contract-forbidden to edit — and mitigated by shape plus the `sr-only` marker carrying the same information.
- **The visual language is half-applied** (DW-114): the tree distinguishes views, the tab bar and ERD do not.
