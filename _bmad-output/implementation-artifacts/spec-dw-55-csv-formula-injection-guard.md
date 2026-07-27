---
title: 'DW-55: CSV formula-injection guard for the client-side grid export'
type: 'bugfix'
created: '2026-07-27'
status: 'done'
baseline_revision: '40b8d06'
final_revision: '479f7e6'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** `rowsToCsv` in `src/ui/data/grid-view.ts` escapes only structural characters (`,`, `"`, newline), so a text cell or column name beginning with `=`, `+`, `-`, `@`, tab, or CR is written verbatim and is evaluated as a live formula when the exported file is opened in Excel / Google Sheets (DW-55, CSV/formula injection).

**Approach:** Apply the standard OWASP mitigation — prepend a single quote (`'`) to any *text-derived* field whose first character is a formula sigil — **before** the existing RFC-4180 escaping runs, so the guard character ends up inside the quoted field.

## Boundaries & Constraints

**Always:**
- Guard runs before `csvField`'s quoting, never after: the emitted field for `=1,2` is `"'=1,2"`, not `'"=1,2"`.
- Guarded set is exactly `=`, `+`, `-`, `@`, `\t`, `\r`, matched only at position 0 of the field.
- The guard applies to **string** cells and to **column names** — both carry user/DB-authored text.
- The guard does **not** apply to `number`, `boolean`, `date`, or `null` cells: those are machine-formatted, so a leading `-` there is a real minus sign and prefixing it would corrupt exported data.
- `grid-view.ts` stays pure, DOM-free, RPC-free and dependency-free (file-level invariant); the new helper is module-private like `csvField`/`cellText`.

**Block If:**
- The intended guard character would have to be something other than `'` (e.g. a tab prefix) to satisfy a stated requirement — that is a recorded user decision, not an unattended call.

**Never:**
- Do not change the download/blob path in `TabContent.tsx`, the filename, or the MIME type.
- Do not add a settings toggle, an "unsafe export" mode, or any UI affordance.
- Do not touch the HTML/JSON report exports (`src/ui/report/*`) — not delimited-text producers.
- Do not strip, reject, or otherwise mutate content beyond the single leading `'`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Formula sigil in string cell | `{ kind: "string", value: "=SUM(A1)" }` | field is `'=SUM(A1)` | No error expected |
| Every guarded sigil | string cells `+cmd`, `-2+3`, `@foo`, `\tx`, `\rx` | each prefixed with `'`; the `\r` one is additionally quoted by `csvField`, the `\t` one is not (tab is not a structural CSV char) | No error expected |
| Guard then structural escape | `{ kind: "string", value: '=a,b' }` | `"'=a,b"` — quote wraps the guard | No error expected |
| Sigil in column name | column named `=1+1` | header field is `'=1+1` | No error expected |
| Negative number cell | `{ kind: "number", value: -5 }` | `-5` — unguarded, unchanged | No error expected |
| Sigil not leading | `{ kind: "string", value: "a=b" }` | `a=b` — unchanged | No error expected |
| Empty / null cell | `{ kind: "null" }` or `""` | empty field, unchanged | No error expected |

</intent-contract>

## Code Map

- `src/ui/data/grid-view.ts` -- owns `cellText` (private), `csvField` (private), `rowsToCsv` (exported); the only place the guard belongs.
- `src/ui/data/grid-view.test.ts` -- `bun:test` suite (`describe`/`test`, shared `columns`/`rows` fixtures, `.ts` import extensions); already has a `rowsToCsv` describe block to extend.
- `src/ui/workspace/TabContent.tsx:291` -- sole production caller (`onExport` → Blob → `<a download>`); read-only reference, must not change.
- `src/shared/contract.ts` -- `FrozenCell` / `FrozenColumn` / `FrozenRow` types (`cell.kind` discriminant drives the string-only rule).

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/data/grid-view.ts` -- add a module-private `formulaGuard(value: string): string` that returns `` `'${value}` `` when `/^[=+\-@\t\r]/` matches and the value verbatim otherwise; JSDoc it with the injection rationale in the file's existing prose-dense style -- neutralizes the sigil without touching the rest of the payload.
- [x] `src/ui/data/grid-view.ts` -- apply it in `rowsToCsv`: wrap column names as `csvField(formulaGuard(c.name))`, and route cells through a private helper that guards only when `cell.kind === "string"` before calling `csvField`; update the `rowsToCsv`/`csvField` JSDoc to state the guard order -- keeps guarding ahead of structural escaping and off machine-formatted cells.
- [x] `src/ui/data/grid-view.test.ts` -- extend the `rowsToCsv` describe block with tests for every row of the I/O matrix, matching the file's existing fixture/naming conventions -- locks the guard set, the guard-then-quote order, and the number/date exemption.

**Acceptance Criteria:**
- Given a loaded result page containing hostile text, when the user clicks Export CSV and opens the file in a spreadsheet app, then no cell is evaluated as a formula because every sigil-leading text field is prefixed with `'`.
- Given the export runs, when `rowsToCsv` produces output, then it remains a pure function with no new imports and no change to `TabContent.tsx`'s blob/download path.
- Given `bun test src/ui/data/grid-view.test.ts` runs, when the suite finishes, then all pre-existing `filterRows` and `rowsToCsv` assertions still pass unchanged.

## Spec Change Log

## Review Triage Log

### 2026-07-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 2: (high 0, medium 1, low 1)
- reject: 15
- addressed_findings:
  - `[low]` `[patch]` The header path re-implemented guard-then-escape by hand (`csvField(formulaGuard(c.name))`) instead of sharing the cell path's composition, so the ordering invariant lived in two places -- extracted `csvText(text)` and routed both column names and `string` cells through it.
  - `[low]` `[patch]` `csvCell` selected the guard with `cell.kind === "string"`, an inverted allow-list: a future `FrozenCell` kind would silently skip the guard -- replaced with an exhaustive `switch`, which fails to compile if a kind is added.
  - `[low]` `[patch]` `formulaGuard`'s JSDoc claimed "nothing else about the payload is stripped or rewritten" while the function is itself a rewrite -- reworded to state plainly that the export trades byte-fidelity for safety and that non-spreadsheet consumers see the `'`.
  - `[low]` `[patch]` The only header test used `=1+1`, which needs no quoting, leaving the header's guard-then-quote order untested -- added a `=a,b` column-name test asserting `"'=a,b"`.
  - `[low]` `[patch]` No test pinned behavior for a value that already begins with `'`, so a future double-prefix regression would go unnoticed -- added an idempotence test.
  - `[low]` `[patch]` The five-sigil matrix ran as a `for` loop inside one `test`, so the first failure aborted the remaining sigils and named none of them -- converted to `test.each` with per-case naming.

**Deferred findings** (recorded here rather than in `deferred-work.md`: this run was invoked with an explicit instruction not to edit the ledger -- the orchestrator owns it):
- `[medium]` The guard anchors strictly at index 0, so a payload prefixed with whitespace, NBSP (` `) or a BOM (`﻿`) — e.g. `" =SUM(A1)"` — slips past it, and Google Sheets trims leading whitespace on import. Pre-existing exposure (before this change every such value fired), and the frozen intent contract pins matching to position 0, so widening the anchor is a policy call for a focused follow-up.
- `[low]` `TabContent.tsx:292` builds the export Blob without a UTF-8 BOM. Excel — the very consumer this guard is written for — mojibakes non-ASCII CSV without one. Pre-existing, untouched by this change, and outside its stated scope.

## Design Notes

Placement matters: putting the prefix inside `csvField` is the shortest diff but would also guard `number`/`date` cells, turning every `-5` into `'-5` and corrupting exported data. So the guard composes *around* `csvField` at the two text-bearing sites instead:

```ts
/** A leading `=`/`+`/`-`/`@`/tab/CR makes a spreadsheet app treat the field as a formula.
 * Prefixing `'` (the OWASP mitigation) forces it back to literal text. */
function formulaGuard(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** The single guard-then-escape composition — both text-bearing sites use it. */
function csvText(text: string): string {
  return csvField(formulaGuard(text));
}

/** Guards only `string` cells: numbers/dates/booleans are machine-formatted, so a leading
 * `-` there is a minus sign, not a formula. Exhaustive switch, so a new `FrozenCell` kind
 * fails to compile rather than skipping the guard. */
function csvCell(cell: FrozenCell): string {
  switch (cell.kind) {
    case "string":
      return csvText(cell.value);
    case "null":
    case "number":
    case "boolean":
    case "date":
      return csvField(cellText(cell));
  }
}
```

The `'` is intentionally *inside* the RFC-4180 quoting, so `=a,b` serializes as `"'=a,b"`.

## Verification

**Commands:**
- `export PATH="$HOME/.bun/bin:$PATH" && bun test src/ui/data/grid-view.test.ts` -- expected: all tests pass, including the new guard cases.
- `export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit` -- expected: no new type errors.

## Auto Run Result

Status: done

**Implemented change.** `rowsToCsv` now applies the OWASP formula-injection guard — a leading `'` on any field whose first character is `=`, `+`, `-`, `@`, tab or CR — to the two text-bearing sites (column names and `string` cells) *before* RFC-4180 escaping, so `=a,b` serializes as `"'=a,b"`. `number`/`boolean`/`date`/`null` cells are deliberately left unguarded so negative numbers and ISO dates export unchanged. Resolves DW-55.

**Files changed**
- `src/ui/data/grid-view.ts` -- added module-private `formulaGuard`, `csvText` (the single guard-then-escape composition) and `csvCell` (exhaustive switch over `FrozenCell.kind`); `rowsToCsv` routes headers and cells through them.
- `src/ui/data/grid-view.test.ts` -- 10 new `rowsToCsv` cases: per-sigil `test.each` coverage, guard-inside-quoting for both cells and column names, the number/non-leading/empty exemptions, and `'`-prefix idempotence.

**Review findings** -- 2 adversarial passes (Blind Hunter, Edge Case Hunter): 0 intent_gap, 0 bad_spec, 6 patches applied (all low severity; see Review Triage Log), 2 deferred (recorded in the triage log, not in the ledger — this run was instructed not to edit `deferred-work.md`), 15 rejected. Notable rejections: the stale `src/core/ui-bundle.generated.ts` is gitignored and rebuilt by `bun run build`, so it is not a shipping gap; LF and `|` are not spreadsheet formula triggers, so the sigil set matches OWASP; guarding numeric-looking *strings* and mutating hostile column names are the accepted cost of the recorded user decision.

**Verification**
- `bun test src/ui/data/grid-view.test.ts` -- 25 pass, 0 fail (12 pre-existing assertions unchanged).
- `bunx tsc --noEmit` -- exit 0, no errors.
- Not verified end-to-end: acceptance criterion 1 (opening the exported file in a real spreadsheet app) is untestable in an unattended run; it is covered indirectly by the serializer-level assertions.

**Residual risks**
- A payload prefixed with whitespace/NBSP/BOM before the sigil still slips through (deferred, medium).
- The export is intentionally no longer byte-faithful: non-spreadsheet consumers see the leading `'` and there is no inverse helper.
