---
title: 'Component tests for the workspace shell — TabBar, Workspace rail, connection indicator'
type: 'chore'
created: '2026-07-27'
status: 'done'
baseline_revision: 'ef970d3ea3a8e64f95ee863e3dcb591659d7c542'
baseline_test_counts: '1934 pass / 1 skip / 0 fail — 1935 tests across 88 files'
final_revision: 'f3a0d36cd05736343a03ee3e186c8c7fff15eff7'
final_test_counts: '1976 pass / 1 skip / 0 fail — 1977 tests across 91 files'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** DW-53 — the workspace shell's a11y contract (`role="tab"`/`aria-selected` on tabs, `aria-pressed` toggles, and the `health` / `settings-toggle` / `create-table-toggle` / `exposure-banner` testids, plus the connection-status dot) was preserved as a hard constraint through the Epic-7 restyle but is asserted by **no** render test. `src/ui/workspace/TabBar.tsx`, `src/ui/workspace/Workspace.tsx` and `src/ui/App.tsx` have zero `*.test.tsx` coverage, so any of those hooks can be renamed or styled away unnoticed. (`src/ui/schema/SchemaTree.tsx` is the exception — `src/ui/schema/SchemaTree.test.tsx` already covers its `role="button"`/`tabIndex`/`aria-pressed`/`aria-expanded`/`role="alert"` and per-root status-dot tokens.)

**Approach:** Add render tests using the repo's established harness — `renderToStaticMarkup` from `react-dom/server` under `bun test`, with `mock.module("../rpc/client.ts", …)` before a dynamic `await import(…)`, co-located as `<Component>.test.tsx`. Cover `TabBar` and `Workspace` directly with explicit prop fixtures. `App` cannot be rendered statically (it reads `window.__QS_FIRST_RUN__`/`window.__QS_EXPOSURE__` during render and its `LayoutGate` early-returns until an effect flips `workspaceReady`), so export its private `ConnectionIndicator` — the exact pattern already sanctioned for `ConnectionRoot` (`SchemaTree.tsx`) and `ConnectionUnavailable` (`TabContent.tsx`) — and assert the `health` testid and status dot through it.

## Boundaries & Constraints

**Always:**
- Follow the repo test convention verbatim: `import { describe, expect, test } from "bun:test"`, `import { renderToStaticMarkup } from "react-dom/server"`, `.ts`/`.tsx` import extensions, assertions via `expect(html).toContain(...)` / `.toMatch(/…/)`. No jsdom, no testing-library, no new devDependency, no `bunfig.toml`.
- Where a component's module graph reaches `src/ui/rpc/client.ts`, install `mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }))` **before** the dynamic `await import(...)` of the module under test, as `SchemaTree.test.tsx` / `TabContent.test.tsx` do.
- Assert the CURRENT strings, not the ledger's stale ones: the schema panel's landmark is `aria-label="Connections"` (Story 10.5 renamed it away from `"Schema tables"`). A test asserting `"Schema tables"` must not be written.
- Each new test file opens with a docblock stating which DW-53 hook it pins and why static rendering suffices.
- Assert both polarities where a hook is stateful (`aria-selected` true *and* false, `aria-pressed` true *and* false, dot class per status phase) — a one-sided assertion is not a regression net.

**Block If:**
- Pinning any DW-53 hook would require changing a component's rendered markup, props, handlers, or behavior — HALT `blocked`, condition `shell test requires a behavior change`. (Adding an `export` keyword to an existing private component is explicitly NOT such a change and is permitted.)

**Never:**
- No production behavior changes: no markup, class, prop, handler, RPC, or state-shape edits to the four shell components. The only permitted production edit is widening `ConnectionIndicator` from module-private to a named export in `src/ui/App.tsx`.
- No test that renders `<App />` itself, and no global `window`/`fetch` stubbing to force it — it yields only the empty `LayoutGate` div and would assert nothing.
- No light/dark theme-flip assertion — the flip is CSS-token-level and produces identical static class markup, so it is unobservable in this harness.
- No new tests for `SchemaTree` beyond confirming its existing coverage; do not duplicate `SchemaTree.test.tsx`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tab strip with an active tab | `WorkspaceState` with 2+ tabs, `activeTabId` set | Container has `role="tablist"` + `aria-label="Open tabs"`; each tab has `role="tab"` and `tabindex="0"`; exactly one `aria-selected="true"` (with `data-active="true"`), the rest `aria-selected="false"` | No error expected |
| Tab close control | any tab titled `T` | A `<button>` per tab with `aria-label="Close T"` | No error expected |
| Empty tab strip | `state.tabs` is `[]` | `TabBar` renders `null` → empty markup string; no `role="tablist"` | No error expected |
| Rail toggles idle | active tab kind is neither `settings` nor `create-table` | `data-testid="settings-toggle"` and `data-testid="create-table-toggle"` present, both `aria-pressed="false"` | No error expected |
| Rail toggle pressed | active tab kind `settings` (then `create-table`) | The matching testid carries `aria-pressed="true"`, the other stays `"false"` | No error expected |
| Port exposed | `exposure={{exposed:true, host, port}}` | `data-testid="exposure-banner"` with `role="alert"` and the host:port text renders | No error expected |
| Port not exposed | `exposure` omitted or `exposed:false` | No `exposure-banner` in the markup | No error expected |
| Health indicator — connected | `status.phase === "ok"` | `data-testid="health"` present; dot span carries `bg-ok`; label shows the connected text | No error expected |
| Health indicator — error | `status.phase === "error"` with a code | Dot carries `bg-err`; text surfaces the error code; `title` carries `code: message` | Envelope text preserved |
| Health indicator — loading / stopped | `status.phase` `"loading"` / `"stopped"` | Dot carries `bg-muted-foreground` (neither `bg-ok` nor `bg-err`) | No error expected |

</intent-contract>

## Code Map

- `src/ui/workspace/TabBar.tsx` -- under test; pure presentational, named export `TabBar`, props `{state, onActivate, onClose}`; owns `role="tablist"`/`aria-label="Open tabs"`/`role="tab"`/`aria-selected`/`data-active`/close-button `aria-label`. Returns `null` on 0 tabs.
- `src/ui/workspace/Workspace.tsx` -- under test; named export `Workspace`; the rail owns `data-testid="settings-toggle"` and `"create-table-toggle"` (both with `aria-pressed`), and private `ExposureBanner` owns `data-testid="exposure-banner"` + `role="alert"`, rendered only when `exposure?.exposed`. Renders statically without mocks, but its graph imports `../rpc/client.ts`.
- `src/ui/App.tsx` -- production edit: add `export` to the private `ConnectionIndicator` (owns `data-testid="health"` and the status dot whose class is `bg-ok`/`bg-err`/`bg-muted-foreground` per `Status.phase`). `Status` union is declared in this file.
- `src/ui/workspace/workspace-state.ts` -- `WorkspaceState`/`TabKind` types plus `emptyWorkspace`/`openTab`/`activateTab`/`openOrFocusSettings`/`openOrFocusCreateTable` for building fixtures instead of hand-rolled literals.
- `src/ui/schema/SchemaTree.test.tsx` -- existing precedent AND the existing SchemaTree coverage; the `mock.module` + `await import` + `renderToStaticMarkup` shape to copy.
- `src/ui/workspace/TabContent.test.tsx` -- second precedent for the same shape in the same directory.
- `src/shared/contract.ts` -- `SchemaTableInfo`, `ExposureInfo`, `HealthResult`, `RpcReply`, `errorReply` for fixtures and the rpc mock.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/workspace/TabBar.test.tsx` -- NEW. Build `WorkspaceState` fixtures via `workspace-state.ts` helpers and assert every tab-strip row of the I/O matrix (tablist landmark, per-tab `role`/`tabindex`, both `aria-selected` polarities + single active, close-button `aria-label`, and the null-render on an empty strip). No rpc mock needed — `TabBar` imports types only. -- pins the `role="tab"`/`aria-selected` half of DW-53.
- [x] `src/ui/App.tsx` -- add the `export` keyword to `ConnectionIndicator` and a one-line comment noting it is exported for render-testing (mirroring the `ConnectionRoot` note in `SchemaTree.tsx`). Change nothing else. -- makes the `health` testid and status dot reachable without mounting `App`.
- [x] `src/ui/App.test.tsx` -- NEW. `mock.module("./rpc/client.ts", …)` then `await import("./App.tsx")`; render `ConnectionIndicator` once per `Status.phase` and assert the `health` testid, the per-phase dot class, the label text, and the error `title`. -- pins the `health` testid and connection-status dot.
- [x] `src/ui/workspace/Workspace.test.tsx` -- NEW. `mock.module("../rpc/client.ts", …)` then `await import("./Workspace.tsx")`; render with a minimal explicit prop set (fixture `WorkspaceState`, empty collections, `panelSizes`, noop callbacks, a plain `connectionIndicator` node) and assert the rail-toggle and exposure-banner rows of the I/O matrix in both polarities. -- pins the `settings-toggle` / `create-table-toggle` / `exposure-banner` testids.

**Acceptance Criteria:**
- Given the full suite before the change, when `bun test` runs after it, then the pre-existing pass/fail counts are unchanged apart from the newly added passing tests — no existing test is modified, skipped, or broken.
- Given each new test file, when the corresponding DW-53 hook is deliberately renamed or removed in the component, then at least one new test fails — i.e. every assertion is load-bearing, none is a tautology over unrelated markup.
- Given `src/ui/App.tsx`, when the diff is inspected, then the only change is the `export` keyword plus its explanatory comment — no JSX, prop, hook, or logic line is touched.
- Given `src/ui/schema/SchemaTree.test.tsx`, when the run finishes, then it is unchanged and still green, and the spec's Design Notes record that SchemaTree's DW-53 hooks were already covered there.

## Spec Change Log

## Review Triage Log

### 2026-07-27 — Review pass (second follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 3: (high 0, medium 0, low 3)
- reject: 22: (high 0, medium 0, low 22)
- addressed_findings:
  - `[medium]` `[patch]` `App.test.tsx`'s `PHASES` fixture was keyed `as const satisfies Record<string, Status>`, which does not require every union member — so the comment above it ("a fifth phase cannot be half-added") was prose with nothing enforcing it. Re-keyed to `Record<Status["phase"], Status>`; mutation-verified by deleting the `stopped` entry, which now fails `tsc` with TS1360 instead of compiling clean.
  - `[medium]` `[patch]` The `health` testid and all four `title` tooltips were asserted document-wide, in the one file whose docblock spends a paragraph condemning exactly that. Both attributes live on the indicator's ROOT `<div>` and nowhere else, so pushing either down onto the dot or the label span kept every assertion green. Added a `healthTag()` slicer, scoped all five assertions to that node, and pinned the testid to the outermost element; mutation-verified red when `title` moves to the label (3 fail) and when the testid moves to the dot (4 fail).
  - `[low]` `[patch]` `Workspace.test.tsx`'s zero-rpc proof hardcoded `["table","query","erd","chat","report"]` while `LAUNCHER_KINDS` — that exact list, derived from `WORKSPACE_TAB_KINDS` — is exported from `workspace-state.ts`. Now iterates the constant, so a sixth document kind is rendered here automatically rather than escaping a proof whose comment claims "every tab kind".
  - `[low]` `[patch]` `tagWith()` returned its FIRST match, so a duplicated `exposure-banner` or `Open tabs` landmark would have been asserted against silently — the duplicate itself being the bug. Now matches globally and requires exactly one; mutation-verified red by rendering `<ExposureBanner>` twice.
  - `[low]` `[patch]` `spyOn(globalThis, "fetch")` calls through, so a transport call sneaking into the render body would have fired a real request before the zero-call assertion reported it. Replaced with a throwing `mockImplementation`.

### 2026-07-27 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 0, medium 5, low 8)
- defer: 4: (high 0, medium 2, low 2)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` `App.test.tsx`'s zero-transport test mocked a seam this component's own family never reaches: `callHealth()`/`callShutdown()` in `App.tsx` bypass the rpc client and POST `/rpc` with a bare `fetch`, so the named regression ("re-probing health on `error`") would have left `rpcMock` at zero and the test green. Now spies `globalThis.fetch` as well, restoring it in a `finally`.
  - `[medium]` `[patch]` Every dot-token assertion was document-wide, and `bg-err` is a strict prefix of `bg-err-soft`/`bg-err-fill`/`bg-err/20` — all live in this shell. Added span-scoped slicing plus exact class-TOKEN membership; mutation-verified red when the dot emits `bg-err-soft` and when the token moves to the wrapper `<div>`.
  - `[medium]` `[patch]` `expect(OK).toContain("aria-hidden")` could not fail for the inversion its own comment described. Now asserts `aria-hidden` on the DOT and its absence on the LABEL, plus each node's text; mutation-verified red when the attribute is moved.
  - `[medium]` `[patch]` `Workspace.test.tsx`'s `mock.module` comment was load-bearing misinformation — it claimed the FIRST registration wins and that a partial factory resolves other exports to `undefined`. Reproduced the real behavior on bun 1.3.14 with a two-file harness: LAST wins and a partial factory MERGES. Comment corrected, and it now states that the six pre-existing `{ rpc }`-only files need no matching stub.
  - `[medium]` `[patch]` The shell was never rendered with an empty workspace — the actual boot and last-tab-closed state, where `activeTab` is null and `TabBar` returns null (so the existing `tagWith(…, 'aria-label="Open tabs"')` would throw). Added a dedicated case asserting the rail, status bar and schema panel survive the empty strip.
  - `[low]` `[patch]` The three negative keydown tests called `row.props.onKeyDown?.(…)`, so dropping the handler made every "not called" assertion pass vacuously. Added a `keyDownOf()` accessor that requires it; mutation-verified (removing `onKeyDown` now fails 4 tests instead of 2).
  - `[low]` `[patch]` The four `Status` fixtures were duplicated verbatim between module scope and the transport test, so a fifth phase could be half-added and silently gut the test whose comment insists on covering every phase. Both now iterate one `PHASES` object.
  - `[low]` `[patch]` Close-label assertions hardcoded `Close Table 1`/`Query 2`/`ERD 3`, coupling an a11y test to the reducer's id counter and `KIND_LABEL`. Now derived from each tab's own `title`, pinning the relation `aria-label === "Close " + title`, with a distinctness check so three assertions remain three.
  - `[low]` `[patch]` `tagWith()` interpolated its `attr` argument into a `RegExp` unescaped, guarded only by a comment; a future Tailwind-valued attribute (`bg-err/20`, `h-1.5`) would silently become a wildcard. Escaped.
  - `[low]` `[patch]` The zero-rpc-in-render proof only ever rendered the `query` tab body; now loops every tab kind plus both singletons and the empty workspace, since each kind mounts a different component.
  - `[low]` `[patch]` The `stopping={true}` branch (disabled Stop + `Stopping…`) was unrendered. Added, asserting the copy and the `disabled` attribute on the SAME button plus the idle negative — matched as `disabled=""` because the button's own class list carries `disabled:cursor-not-allowed`.
  - `[low]` `[patch]` The optional `saveIndicator` status-bar slot was never passed, so it could be deleted from the JSX unnoticed; added present/absent cases and an ordering check. Mutation-verified.
  - `[low]` `[patch]` The exposure banner's presence, role and address were asserted but not its POSITION, so nesting it inside a scrollable `Panel` kept every assertion green while the "unmissable" warning scrolled out of view. Now pins that it precedes `data-panel-group`; mutation-verified.

### 2026-07-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 14: (high 0, medium 6, low 8)
- defer: 2: (high 0, medium 1, low 1)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` `TabBar.test.tsx` asserted the selected title with a document-spanning `[\s\S]*?` gap, so it passed even under an inverted selection — added `tabRows()`/`selectedRow()` slicers and now assert the title inside the selected row's own slice, plus its negative. Mutation-verified.
  - `[medium]` `[patch]` The `tabindex="0"` × 3 count cemented an ARIA anti-pattern: the correct roving-tabindex fix (`tabIndex={active ? 0 : -1}`) turned the test red. Now asserts every tab row carries a `tabindex` and the SELECTED row carries `"0"` — verified green under the APG fix and red when `tabIndex` is removed.
  - `[medium]` `[patch]` Six `aria-pressed` regexes in `Workspace.test.tsx` were coupled to JSX attribute ORDER; replaced with a `tag(html, testid)` helper that extracts the button's whole opening tag and asserts on it, order-independent.
  - `[medium]` `[patch]` `App.test.tsx` dot-token negatives were one-sided (`ok`/`error` never excluded `bg-muted-foreground`), so a dot emitting two tokens stayed green — all three phases now assert their own token present and the other two absent.
  - `[medium]` `[patch]` No handler was covered anywhere, leaving DW-53's "activation semantics" half unguarded; added six tests using `ConfirmRun.test.tsx`'s function-call + tree-walk pattern covering `onActivate`, `onClose`, `stopPropagation`, and the `e.target !== e.currentTarget` keydown guard. All three named regressions mutation-verified red.
  - `[medium]` `[patch]` Every singleton fixture also activated the tab, so `aria-pressed` switching from "is active" to "exists" would pass; added a settings-open-but-not-active case (and the create-table twin) asserting `aria-pressed="false"`.
  - `[low]` `[patch]` Document-wide `not.toContain('role="alert"')` in the banner-absent tests could be tripped by five unrelated components; scoped to the `exposure-banner` testid and its copy.
  - `[low]` `[patch]` `role="tablist"` did not discriminate the tab strip from `TabContent`/`ReportTabView` sub-view tablists; now anchored on `aria-label="Open tabs"`.
  - `[low]` `[patch]` Shell-global `aria-pressed="true"` counts would break on any future pressed control in a tab body; scoped to the two rail toggles and the misleading "whole shell" comment corrected.
  - `[low]` `[patch]` `expect(saveWorkspaceSyncMock).toHaveBeenCalledTimes(0)` was structurally un-failable — removed (the factory keeps the key so the mocked module shape stays complete), and the rpc zero-call test now clears the mock and renders all four phases.
  - `[low]` `[patch]` `schema v1` was hardcoded while the fixture passed `FROZEN_SCHEMA_VERSION`; both now derive from the constant.
  - `[low]` `[patch]` `not.toContain('role="tablist"')` after `toBe("")` was dead; removed and folded into the comment.
  - `[low]` `[patch]` The host:port regex carried `(?:<!-- -->)?` branches `renderToStaticMarkup` never emits; simplified to the plain match.
  - `[low]` `[patch]` `App.test.tsx` and `Workspace.test.tsx` registered divergent shapes for the same module in bun's process-global `mock.module` registry; both now register `{ rpc, saveWorkspaceSync }`.

## Design Notes

`SchemaTree` needs no new file: `SchemaTree.test.tsx` already asserts `role="button"`, `tabindex="0"`, `aria-expanded` both ways, `aria-pressed` both ways (including the cross-root negative), `role="alert"`, and the `bg-ok`/`bg-err`/`bg-muted-foreground` status-dot tokens, and it pins the landmark as `aria-label="Connections"` — the Story-10.5 rename that makes the ledger's `"Schema tables"` wording stale.

Shape to follow (from `SchemaTree.test.tsx`), for the two files that need the rpc seam:

```tsx
const rpcMock = mock(async (): Promise<RpcReply<unknown>> => errorReply("internal_error", "unset"));
mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }));
const { Workspace } = await import("./Workspace.tsx");
```

Prefer matching on markup-shaped fragments (`'aria-pressed="true"'`, `'>Run<'`, `/>default<\/span>/`) over bare substrings — `SchemaTree.test.tsx` documents how a loose `"default"` silently also matched the `cursor-default` utility. Use `out.match(/…/g)?.length` when the assertion is about *how many* nodes carry a hook (e.g. exactly one `aria-selected="true"`).

## Verification

**Commands:**
- `export PATH="$HOME/.bun/bin:$PATH" && bun test 2>&1 | tail -20` -- expected: the full suite reports 0 failures, and the total test count is higher than the pre-change baseline by exactly the number of new tests.
- `export PATH="$HOME/.bun/bin:$PATH" && bun test src/ui/workspace/TabBar.test.tsx src/ui/workspace/Workspace.test.tsx src/ui/App.test.tsx 2>&1 | tail -20` -- expected: all three files pass, 0 failures.
- `git diff --stat src/ui/App.tsx` -- expected: a 1-3 line change touching only the `ConnectionIndicator` declaration line and its comment.

## Auto Run Result

Status: done
Blocking condition: none
Follow-up review recommended: **false** — the second follow-up pass applied 5 fixes (2 medium, 3 low), all of them assertion-scoping or type-level inside the three test files: no new test, no new helper strategy, no production line touched, and every one individually mutation-verified. The yield curve has flattened — 14 patches, then 13, now 5 — and of this pass's 30 findings, five were verbatim duplicates of ledger entries the previous pass had already filed (DW-107 through DW-110) and most of the rest were style preferences on comment density. The artifact is done yielding at this altitude; what remains open is recorded in the ledger, not fixable by another review of this diff.

### Summary

Closed DW-53 by giving the workspace shell the regression net its a11y/testid contract never had. Three new render-test files pin the hooks the Epic-7 restyle preserved as a hard constraint but nothing asserted: the tab strip's `role="tablist"`/`aria-label="Open tabs"`/`role="tab"`/`aria-selected`/close-button `aria-label`, the rail's `settings-toggle` and `create-table-toggle` with both `aria-pressed` polarities, the `exposure-banner` `role="alert"`, and the `health` testid with its per-phase connection-status dot token. The only production change is one `export` keyword. `SchemaTree` needed no new file — `SchemaTree.test.tsx` already covers its half and is untouched.

### Files changed

- `src/ui/workspace/TabBar.test.tsx` -- NEW. 14 tests: tablist landmark, per-tab role/tabindex, single-active `aria-selected`/`data-active` invariant that tracks `activeTabId`, per-tab close `aria-label`, the empty-strip null render, and six handler tests (`onActivate`, `onClose`, `stopPropagation`, the `e.target !== e.currentTarget` keydown guard) via the function-call + tree-walk pattern from `ConfirmRun.test.tsx`.
- `src/ui/workspace/Workspace.test.tsx` -- NEW. 17 tests: both rail toggles in all three activation states plus the open-but-not-active polarity; the exposure banner present/absent across omitted and `exposed:false` AND its position above the `PanelGroup`; the injected indicator slot and the optional `saveIndicator` slot both ways; the `aria-label="Connections"` landmark; the `stopping` in-flight state; the empty-workspace shell; and a zero-rpc-in-render proof across every tab kind.
- `src/ui/App.test.tsx` -- NEW. 11 tests over the exported `ConnectionIndicator`. Every structural assertion is scoped to the dot's or the label's own node — the render is three elements deep, so a document-wide `toContain` cannot tell "the dot is green" from "something here is green" — and class checks use exact TOKEN membership because `bg-err` is a strict prefix of `bg-err-soft`/`bg-err-fill`, both live in this shell. Covers: the `health` testid in every phase, the per-phase dot token with all cross-negatives, `aria-hidden` on the dot and NOT on the label, the per-phase label copy, the `code: message` error tooltip, and a no-transport proof spying BOTH the rpc client and `globalThis.fetch` (this component's own family reaches the network through the latter).
- `src/ui/App.tsx` -- MODIFIED, 3 insertions / 1 deletion. `ConnectionIndicator` widened from module-private to a named export plus a two-line comment stating it is exported for render-testing. No JSX, prop, hook, or logic line touched.

### Review findings breakdown — second follow-up pass (2026-07-27)

- **Patches applied: 5** (2 medium, 3 low) — full detail in the Review Triage Log's second-follow-up entry. Both mediums were self-contradictions: a `satisfies Record<string, Status>` whose comment claimed exhaustiveness it did not enforce, and document-wide `health`/`title` assertions in the one file whose docblock argues at length that document-wide assertions are inadequate here. Both mutation-verified (TS1360 on a deleted phase; 3 and 4 failures respectively when `title` and the testid are moved off the root node). No new test was added and no production line was touched — the suite total is unchanged at 1976.
- **Deferred: 3**, appended to `deferred-work.md` as new entries only (DW-111 … DW-113); no existing entry was read back, re-opened or rewritten.
  1. `[low]` DW-111 — the exposure banner and three sibling alert surfaces (`TabContent`, `CreateTablePanel`, `DataGrid`) paint raw Tailwind red while DW-58's `--err-fill` / `--err-soft` tokens, which carry light-theme overrides, sit unused. The reviewer framed it as one component; grep proves it is four, which makes it a token-adoption sweep, not a one-liner.
  2. `[low]` DW-112 — the rest of the launcher rail (the `nav` landmark, the `role="img"` brand mark, five launcher buttons, and the `+` button's singleton-fallback branch) is untested. The markup half is cheap; the `+` branch is not reachable in this harness at all, since `Workspace` uses hooks and so cannot be invoked as a plain function the way `TabBar` is.
  3. `[low]` DW-113 — an IPv6 bind renders `:::4123` instead of `[::]:4123`. `QS_HOST` is user-settable and is the very variable the banner's remediation copy names, so this is ordinary configuration; fixing it is a production render change this spec's `Never` clause forbids.
- **Rejected: 22.** Five were verbatim re-reports of ledger entries the previous pass already filed — the orphaned `role="tab"` / missing `aria-controls` / absent roving tabindex (DW-107, reported three separate ways), the close button as an interactive descendant of `role="tab"` (DW-108), duplicate table-tab titles colliding on close labels (DW-109), and `SaveIndicator`'s missing coverage (DW-110); re-deferring them would duplicate open entries the orchestrator owns. The rest: "extract `ConnectionIndicator` to its own module instead of exporting it" (the spec's Approach names the export explicitly and it is the repo's sanctioned precedent — `ConnectionRoot`, `ConnectionUnavailable`); the `mock.module` `saveWorkspaceSync` stub leaking process-globally (the six pre-existing files leak an `rpc` stub identically — it is the repo convention, not a regression); the purity test being "tautological because the component cannot call `fetch` today" (that is what the guard is for); positional `dot()` / `label()` span indices (a nested span breaks the `text` equality assertions first, so it fails loudly); `expect()` inside `selectedRow()`, the subsumed `not.toBe(after)`, redundant `mockClear()`s, and the `data-panel-group` coupling (cosmetic); `not.toContain("Schema tables")` being unfailable today (it is a deliberate regression guard the spec's `Always` clause mandates); HTML-escaping cases for `title` and host:port (tests React, not this code — rejected in both prior passes); `panelSizes` shorter than two entries (cosmetic `?? 20`/`?? 80` fallbacks — rejected in the prior pass); `chat`/`report` TabKind coverage in `TabBar` (exhaustive by `Record<TabKind, …>` typing — rejected in both prior passes); a null `activeTabId` with tabs present (verified unreachable: `closeTab` falls back to `tabs[tabs.length - 1]` and `restoreWorkspace` to `tabs[0]?.id`, so null occurs only when the strip is empty); populated `chatStates`/`reportStates`/`allTables` fixtures and the optional `onOpenReport`/`onReassignConnection` forwards (downstream components' own tests, not the shell's); `tabRows()`'s last slice absorbing the strip's trailing `</div>`; and "40% of the added lines are comments" (the two comments that were load-bearing AND wrong are the two mediums patched above).

### Review findings breakdown — follow-up pass (2026-07-27)

- **Patches applied: 13** (5 medium, 8 low) — full detail in the Review Triage Log's follow-up entry. The five mediums were real holes in the FIRST pass's own tests, not stylistic: the purity test watched the rpc client while this component's family reaches the network through a bare `fetch`; all dot-token and `aria-hidden` checks were document-wide over a three-element render (and `bg-err` is a prefix of `bg-err-soft`, live in the same shell); the `mock.module` ordering comment asserted the opposite of bun's real behavior, which I reproduced in an isolated harness; and the shell's empty-workspace branch — the actual boot state — was never rendered.
- **Deferred: 4**, appended to `deferred-work.md` as new entries only (DW-107 … DW-110); no existing entry was read back, re-opened or rewritten.
  1. `[medium]` DW-107 — the tab strip is not a conformant ARIA tabs pattern: zero `aria-controls`/`role="tabpanel"` anywhere in `src/ui`, every row hardcoded `tabIndex={0}`, no Arrow/Home/End. Pre-existing; fixing it is behavior change this spec's `Block If` excludes. `TabBar.test.tsx` was written to stay green under the correct fix — re-verified this pass.
  2. `[low]` DW-108 — the close `<button>` is an interactive descendant of `role="tab"`, whose children ARIA may flatten, so the `Close <title>` label is in the markup but not provably in the accessibility tree. Same root cause as DW-107; decide together.
  3. `[medium]` DW-109 — `openTableTab` sets `title = ref.name` unsuffixed, contradicting the reducer's own "two coexisting tabs can never share a title" comment: two same-named tables on different connections yield identical titles AND identical close labels. Reducer behavior change, needs a disambiguation policy.
  4. `[low]` DW-110 — `SaveIndicator` (`data-testid="save-status"` + `bg-err` dot) is untested for exactly the reason `ConnectionIndicator` was, but covering it needs a second `export`, which this spec's `Never` clause forbids. The `Workspace`-side slot IS now covered.
- **Rejected: 10.** Adding `saveWorkspaceSync` stubs to the six other test files (premise disproven by the bun harness — partial factories merge); HTML-escaping and empty-message cases for `title`/host:port (tests React, not this code — consistent with the prior pass); asserting a `schemaVersion` other than `FROZEN_SCHEMA_VERSION` (the shared constant is deliberate, and documented as such); TAB_ICON coverage for `chat`/`report` (exhaustive by `Record<TabKind, …>` typing — rejected in the prior pass too); "`collect()` returning empty makes assertions vacuous" (it throws on `rows[0]!.props` instead, so it fails loudly); a Space-key twin of the bubbled-keydown guard test (one `e.target !== e.currentTarget` check serves both keys); a stale `activeTabId` matching no tab (unreachable — the reducer only ever sets ids it owns); `panelSizes` shorter than two entries (`?? 20`/`?? 80` fallbacks, cosmetic); and the absence of `typecheck`/`lint` scripts in `package.json` (repo infra, unrelated to DW-53; `tsc --noEmit` is run by this workflow's own verification).

### Review findings breakdown — first pass (2026-07-27)

- **Patches applied: 14** (6 medium, 8 low) — full detail in the Review Triage Log. Five were genuine coverage holes provable by mutation (a document-spanning regex that survived an inverted selection, one-sided dot-token negatives, an un-failable mock assertion, an `aria-pressed` polarity gap, and the complete absence of handler coverage); one removed a test that would have blocked the correct roving-tabindex a11y fix; the rest de-brittled order- and scope-dependent matches.
- **Deferred: 2.** NOT written to `deferred-work.md` at the time — that invocation instructed the run not to edit the ledger. **Both were carried into the follow-up pass:** (1) is now ledger entry DW-107; (2) was patched outright except for the exposure banner's `QS_HOST` remediation copy, which stays uncovered. Transcribed for the record:
  1. `[medium]` `src/ui/workspace/TabBar.tsx` — the tab strip does not implement the ARIA APG tabs pattern: every tab row is `tabIndex={0}` (no roving tabindex, so Tab steps through every tab instead of escaping the strip) and there is no ArrowLeft/ArrowRight handler. Pre-existing, not caused by this change; `TabBar.test.tsx` was deliberately written to stay green under the fix.
  2. `[low]` shell interaction states still unrendered by any test: `Workspace`'s `stopping={true}` branch (the `disabled` + `Stopping…` Stop button), the optional `saveIndicator` slot, the exposure banner's `QS_HOST` remediation copy, and the render-body rpc zero-call proof for tab kinds other than `query`.
- **Rejected: 6.** DW-53's own ledger status (the orchestrator records resolution); the absence of a lint rule policing the test-only `ConnectionIndicator` export (no lint infra exists in the repo and the comment marks intent); TAB_ICON coverage for `chat`/`report` (already exhaustive by `Record<TabKind, …>` typing); and three findings about HTML-escaping quote-bearing titles and error messages (that tests React, not this code).

### Verification performed

- **Second-follow-up-pass mutation checks** (each reverted from a scratchpad copy; `git diff --quiet -- src/ui/App.tsx src/ui/workspace/Workspace.tsx` confirmed both production files back at HEAD afterwards): deleting the `stopped` entry from `PHASES` (now `tsc` TS1360 — "Property 'stopped' is missing"; previously it compiled clean), moving `title` from the `health` div onto the label span (3 fail), moving `data-testid="health"` from the root div onto the dot span (4 fail), and rendering `<ExposureBanner>` twice (1 fail — `tagWith` now reports "expected exactly one … found 2"). All four were GREEN under the previous pass's assertions.
- `bunx tsc --noEmit` -- exit 0 after the patches.
- `bun test src/ui/App.test.tsx src/ui/workspace/Workspace.test.tsx src/ui/workspace/TabBar.test.tsx` -- 42 pass / 0 fail, unchanged count (this pass tightened assertions rather than adding tests).
- `git diff --stat ef970d3 -- src/ui/App.tsx src/ui/workspace/Workspace.tsx src/ui/workspace/TabBar.tsx src/ui/schema/SchemaTree.tsx` -- `App.tsx` only, 3 insertions / 1 deletion. The production surface is byte-identical to what the previous pass left.
- `bun test` -- **1976 pass / 1 skip / 0 fail**, 1977 tests across 91 files. Baseline before the change was 1934 pass / 1 skip / 0 fail across 88 files: +42 tests, +3 files, no pre-existing test modified, skipped, or broken. (The first pass ended at 1970/1971; the follow-up pass added 6 more tests and rewrote `App.test.tsx`'s assertion strategy without changing its production surface.)
- `bun test src/ui/workspace/TabBar.test.tsx src/ui/workspace/Workspace.test.tsx src/ui/App.test.tsx` -- 42 pass / 0 fail (14 TabBar, 17 Workspace, 11 App).
- `bunx tsc --noEmit` -- exit 0.
- **Follow-up-pass mutation checks** (each reverted exactly; `git diff --quiet` confirmed clean after every one): moving the dot's colour token onto the wrapper `<div>` (4 fail), emitting `bg-err-soft` instead of `bg-err` for the error dot (2 fail), moving `aria-hidden` from the dot onto the label (1 fail), nesting `ExposureBanner` inside the `PanelGroup` (1 fail), deleting `{saveIndicator}` from the status bar (1 fail), dropping `disabled={stopping}` from the Stop button (1 fail), removing `TabBar`'s `onKeyDown` entirely (4 fail — previously only the two positive tests would have caught it, the negatives passed vacuously), and replacing the title-derived close label with a constant (3 fail). Every one of these was GREEN under the first pass's assertions.
- **bun `mock.module` behavior**, reproduced in an isolated two-file harness to settle a review claim: file 1 registers `{a: "A1", b: "B1"}`, file 2 registers the partial `{a: "A2"}`; file 2 observes `A2 B1`. Last registration wins and partial factories merge — the opposite of what `Workspace.test.tsx`'s comment claimed. Comment corrected.
- `git diff --stat -- src/` -- `src/ui/App.tsx` only, 3 insertions / 1 deletion. `TabBar.tsx`, `Workspace.tsx`, `SchemaTree.tsx` and `SchemaTree.test.tsx` are byte-identical to baseline.
- **Mutation checks** (each reverted exactly): renaming `role="tablist"`, swapping `aria-selected`→`aria-current`, inverting the tab-selection index, renaming `data-testid="health"`, swapping the `bg-ok` token for a raw Tailwind red, renaming `data-testid="settings-toggle"`, deleting the banner's `role="alert"`, deleting `tabIndex`, pointing the close button at `onActivate`, deleting `e.stopPropagation()`, and deleting the keydown `e.target !== e.currentTarget` guard — every one turned at least one new test red. Applying the correct `tabIndex={active ? 0 : -1}` APG fix kept all 14 TabBar tests green, confirming the suite does not cement the anti-pattern.

### Residual risks

- **The a11y contract now pinned is itself incomplete ARIA.** These tests freeze the hooks that exist; they do not certify the tab strip as conformant. DW-107 and DW-108 record the two structural gaps (orphaned `role="tab"`, close button as an interactive descendant) so "the shell has render tests" is not mistaken for "the shell is accessible". `TabBar.test.tsx` was deliberately built to stay green under the APG fix, re-verified this pass.
- **The exposure banner's `QS_HOST` remediation copy is still unasserted** — only the banner's presence, `role="alert"`, address and DOM position are pinned. Low consequence: the copy is static text with no branch behind it.
- **DW-53 is not closed wholesale.** Its ledger `reason` names the light-theme flip as part of the gap; this spec excluded it because the flip is CSS-token-level and produces byte-identical static class markup, so it is unobservable in a `renderToStaticMarkup` harness. Closing DW-53 needs a `residual` note to that effect, or the theme half should stay open.
- The ledger's `aria-label="Schema tables"` wording is stale — Story 10.5 renamed that landmark to `"Connections"`. The tests assert the current string and explicitly guard against the old one reappearing.
- **The rail is pinned only where DW-53 named a hook.** The three testids in the I/O matrix are covered; the `nav` landmark, the brand mark, the five launcher buttons and the `+` button's singleton-fallback branch are not (DW-112). The `+` branch in particular is beyond this harness — `Workspace` uses hooks, so the function-call + tree-walk trick that reaches `TabBar`'s handlers cannot be applied to it.
- **The exposure banner's rendered address is pinned for IPv4 only** (DW-113): an IPv6 bind prints `:::4123`. The test asserts what the component currently emits, so it does not flag the ambiguity — it freezes it until the production fix lands.
- Coverage is static-markup + direct-handler-invocation only. Anything that requires a live DOM (focus movement, real event bubbling through React's synthetic system, effect-driven state) remains outside this net by harness design; the repo has no jsdom and none was added.
