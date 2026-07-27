/**
 * quick-studio UI (Ring 2) — TabBar render tests (DW-53).
 *
 * Pins the tab-strip half of the DW-53 a11y contract: the `role="tablist"` /
 * `aria-label="Open tabs"` landmark, the per-tab `role="tab"` + keyboard reachability, the
 * `aria-selected` / `data-active` single-active invariant, and the per-tab close
 * button's `aria-label`. Those hooks survived the Epic-7 restyle as a hard constraint
 * but no render test asserted them, so any of them could be renamed or styled away
 * unnoticed.
 *
 * Static rendering suffices for the markup half (and no rpc mock is needed): `TabBar` is
 * pure and presentational — it takes `{state, onActivate, onClose}`, imports types only,
 * runs no effect and makes no rpc call, so `renderToStaticMarkup` produces its COMPLETE
 * markup. Which tab a click ends up SELECTING is the pure reducer in `workspace-state.ts`,
 * unit-tested in `workspace-state.test.ts`.
 *
 * `renderToStaticMarkup` does, however, drop every handler, so the ACTIVATION SEMANTICS
 * (close fires `onClose` and not `onActivate`, the close click stops propagating, the
 * keydown guard) are pinned in the last describe by invoking `TabBar` as a plain function
 * and calling the real handlers off its element tree — the same pattern
 * `ConfirmRun.test.tsx` uses, and safe here because `TabBar` uses no hooks.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TabBar } from "./TabBar.tsx";
import {
  activateTab,
  emptyWorkspace,
  openOrFocusCreateTable,
  openOrFocusSettings,
  openTab,
  type WorkspaceState,
} from "./workspace-state.ts";

const noop = (): void => {};

function render(state: WorkspaceState): string {
  return renderToStaticMarkup(<TabBar state={state} onActivate={noop} onClose={noop} />);
}

/** Three tabs (`Table 1`, `Query 2`, `ERD 3`); the LAST one is active. */
function threeTabs(): WorkspaceState {
  return openTab(openTab(openTab(emptyWorkspace(), "table"), "query"), "erd");
}

/**
 * Every `role="tab"` row, each sliced from its own opening tag up to where the NEXT tab row
 * begins (the last one runs to the end of the strip). Splitting at the element boundary is
 * what makes a per-tab assertion load-bearing: a document-wide
 * `/aria-selected="true"[\s\S]*?>Title</` matches even when the WRONG tab is selected,
 * because the lazy gap happily spans every tab in between. Matching the row by
 * `<div … role="tab"` (rather than by a fixed attribute sequence) also keeps these slices
 * independent of the order attributes happen to be authored in.
 */
function tabRows(html: string): ReadonlyArray<string> {
  return html
    .split(/(?=<div[^>]*\srole="tab")/)
    .filter((part) => /^<div[^>]*\srole="tab"/.test(part));
}

/** The one row whose OWN opening tag carries `aria-selected="true"`. */
function selectedRow(html: string): string {
  const selected = tabRows(html).filter((row) => /^<div[^>]*\saria-selected="true"/.test(row));
  expect(selected.length).toBe(1);
  return selected[0] ?? "";
}

describe("TabBar — tablist landmark (DW-53)", () => {
  test("wraps the strip in a labelled tablist", () => {
    const out = render(threeTabs());
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-label="Open tabs"');
    // Exactly ONE tablist — the strip is a single landmark, not one per tab.
    expect(out.match(/role="tablist"/g)?.length).toBe(1);
  });

  test("gives every tab role=tab and keyboard focus", () => {
    const out = render(threeTabs());
    expect(out.match(/role="tab"/g)?.length).toBe(3);
    // Every tab row is reachable by keyboard, not just clickable: each one declares a
    // `tabindex`, and the SELECTED tab is the one in the natural tab order (`0`).
    // The NUMBER of `tabindex="0"` rows is deliberately NOT pinned: the APG-correct
    // roving-tabindex fix (`tabIndex={active ? 0 : -1}`, arrows moving between tabs) must
    // stay adoptable without this test going red for doing the right thing.
    const rows = tabRows(out);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row).toMatch(/^<div[^>]*\stabindex="(?:0|-1)"/);
    }
    expect(selectedRow(out)).toMatch(/^<div[^>]*\stabindex="0"/);
  });
});

describe("TabBar — active selection (DW-53)", () => {
  test("marks exactly one tab selected and the rest unselected", () => {
    const out = render(threeTabs());
    // Both polarities: a one-sided assertion would still pass if every tab were
    // hard-coded selected (or none of them were).
    expect(out.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(out.match(/aria-selected="false"/g)?.length).toBe(2);
    // `data-active` is the styling hook and is emitted ONLY for the active tab.
    expect(out.match(/data-active="true"/g)?.length).toBe(1);
    expect(out).not.toContain('data-active="false"');
  });

  test("moves the selection when a different tab is activated", () => {
    const state = threeTabs();
    const first = state.tabs[0]!;
    const before = render(state);
    const after = render(activateTab(state, first.id));

    // The selected tab actually TRACKS `activeTabId` — the strip is not rendering a
    // fixed "first/last tab is selected" that would survive any state change.
    expect(before).not.toBe(after);
    expect(after.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(after.match(/aria-selected="false"/g)?.length).toBe(2);
    // WHICH tab carries the selection, asserted INSIDE the selected row's own slice: the
    // title must belong to the selected tab, not merely appear somewhere after it in the
    // document (which is true of every later tab, and of the last tab always).
    expect(selectedRow(after)).toContain(">Table 1<");
    expect(selectedRow(after)).not.toContain(">ERD 3<");
    expect(selectedRow(before)).toContain(">ERD 3<");
    expect(selectedRow(before)).not.toContain(">Table 1<");
  });

  test("a single-tab strip still marks that tab selected", () => {
    const out = render(openTab(emptyWorkspace(), "query"));
    expect(out.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(out).not.toContain('aria-selected="false"');
  });
});

describe("TabBar — close control (DW-53)", () => {
  test("renders one close button per tab, labelled with that tab's title", () => {
    const state = threeTabs();
    const out = render(state);
    expect(out.match(/<button/g)?.length).toBe(3);
    // Labels are derived from the STATE's own titles, not from hardcoded `Table 1` /
    // `Query 2` / `ERD 3` strings: those come from the reducer's monotonic id counter
    // (`workspace-state.ts`'s `nextId`) and its `KIND_LABEL` map, so hardcoding them turns
    // this a11y test red for reducer changes that have nothing to do with a11y. What is
    // actually being pinned is the RELATION `aria-label === "Close " + title`.
    expect(state.tabs.length).toBe(3);
    for (const tab of state.tabs) {
      expect(out).toContain(`aria-label="Close ${tab.title}"`);
    }
    // …and the titles really are distinct, so those three labels are three different
    // strings rather than one repeated assertion passing three times.
    expect(new Set(state.tabs.map((t) => t.title)).size).toBe(3);
  });

  test("labels the singleton tabs by their real titles too", () => {
    // The two singletons carry no numeric suffix, so their close labels are the one
    // place a title-derived label could silently drift.
    const out = render(openOrFocusCreateTable(openOrFocusSettings(emptyWorkspace())));
    expect(out).toContain('aria-label="Close Settings"');
    expect(out).toContain('aria-label="Close New Table"');
  });
});

describe("TabBar — empty strip (DW-53)", () => {
  test("renders nothing at all when no tab is open", () => {
    // Empty markup, so no landmark either: an empty `role="tablist"` would be an
    // announced-but-empty region for a screen reader.
    const out = render(emptyWorkspace());
    expect(out).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * Activation semantics (DW-53) — the half `renderToStaticMarkup` cannot see
 * ------------------------------------------------------------------ */

/** The subset of props these tests read off the returned element tree. */
type NodeProps = {
  children?: React.ReactNode;
  role?: string;
  "aria-label"?: string;
  onClick?: (event: unknown) => void;
  onKeyDown?: (event: unknown) => void;
};

/** Depth-first walk of the element tree, collecting every node matching `pick`. */
function collect(
  node: React.ReactNode,
  pick: (element: React.ReactElement<NodeProps>) => boolean,
  out: Array<React.ReactElement<NodeProps>>,
): void {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, pick, out);
    return;
  }
  const element = node as React.ReactElement<NodeProps>;
  if (pick(element)) out.push(element);
  collect(element.props?.children ?? null, pick, out);
}

/**
 * `TabBar` invoked as a plain FUNCTION (not via JSX) so the returned tree still carries the
 * real `onClick`/`onKeyDown` closures React would wire up — `renderToStaticMarkup` drops
 * them, which is why every markup test above stays green if the close button is rewired to
 * `onActivate`. Safe because `TabBar` uses no hooks. Same approach as `ConfirmRun.test.tsx`.
 */
function tabElements(
  state: WorkspaceState,
  onActivate: (id: number) => void,
  onClose: (id: number) => void,
): Array<React.ReactElement<NodeProps>> {
  const out: Array<React.ReactElement<NodeProps>> = [];
  collect(TabBar({ state, onActivate, onClose }), (el) => el.props?.role === "tab", out);
  return out;
}

/**
 * The row's `onKeyDown`, REQUIRED to exist. Calling it as `row.props.onKeyDown?.(…)` would
 * silently no-op if the handler were dropped from `TabBar.tsx`, and every NEGATIVE
 * assertion below (`onActivate` not called, `preventDefault` not called) would then pass
 * vacuously — the guard tests would keep certifying a guard that no longer exists.
 */
function keyDownOf(row: React.ReactElement<NodeProps>): (event: unknown) => void {
  const handler = row.props.onKeyDown;
  expect(handler).toBeDefined();
  if (handler === undefined) throw new Error("tab row has no onKeyDown");
  return handler;
}

/** The close `<button>` nested inside one tab row, found by its stable `aria-label`. */
function closeButtonOf(
  row: React.ReactElement<NodeProps>,
  title: string,
): React.ReactElement<NodeProps> | null {
  const out: Array<React.ReactElement<NodeProps>> = [];
  collect(row.props?.children ?? null, (el) => el.props?.["aria-label"] === `Close ${title}`, out);
  return out[0] ?? null;
}

describe("TabBar — activation semantics (DW-53)", () => {
  test("clicking a tab row activates THAT tab", () => {
    const state = threeTabs();
    const onActivate = mock((_id: number) => {});
    const onClose = mock((_id: number) => {});
    const rows = tabElements(state, onActivate, onClose);
    expect(rows.length).toBe(3);

    rows[1]?.props.onClick?.({});
    // The middle row's handler is bound to the MIDDLE tab's id — not a stale closure over
    // the last tab, and not the active one.
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]?.[0]).toBe(state.tabs[1]!.id);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("clicking close fires onClose for that tab and never onActivate", () => {
    const state = threeTabs();
    const onActivate = mock((_id: number) => {});
    const onClose = mock((_id: number) => {});
    const rows = tabElements(state, onActivate, onClose);
    const button = closeButtonOf(rows[0]!, "Table 1");
    expect(button?.props.onClick).toBeDefined();

    const stopPropagation = mock(() => {});
    button?.props.onClick?.({ stopPropagation });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0]?.[0]).toBe(state.tabs[0]!.id);
    expect(onActivate).not.toHaveBeenCalled();
    // The close button sits INSIDE the clickable row, so the click must be stopped from
    // bubbling to the row's `onActivate`. Without this the real DOM would focus a
    // background tab on its way to closing it — invisible to a handler-level test unless
    // the call to `stopPropagation` is asserted directly.
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  test("Enter on the tab row itself activates it and consumes the key", () => {
    const state = threeTabs();
    const onActivate = mock((_id: number) => {});
    const onClose = mock((_id: number) => {});
    const row = tabElements(state, onActivate, onClose)[2]!;

    const preventDefault = mock(() => {});
    const target = { self: true };
    keyDownOf(row)({ key: "Enter", target, currentTarget: target, preventDefault });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]?.[0]).toBe(state.tabs[2]!.id);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("Space on the tab row itself activates it too", () => {
    const state = threeTabs();
    const onActivate = mock((_id: number) => {});
    const row = tabElements(state, onActivate, () => {})[0]!;

    const preventDefault = mock(() => {});
    const target = { self: true };
    keyDownOf(row)({ key: " ", target, currentTarget: target, preventDefault });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]?.[0]).toBe(state.tabs[0]!.id);
  });

  test("a key that bubbled up from the close button activates NOTHING", () => {
    const state = threeTabs();
    const onActivate = mock((_id: number) => {});
    const onClose = mock((_id: number) => {});
    const row = tabElements(state, onActivate, onClose)[0]!;

    const preventDefault = mock(() => {});
    // `target !== currentTarget`: Enter was pressed while the nested close button had focus.
    // The row must not handle it — the button's own native Enter → click must survive, so
    // neither `onActivate` nor `preventDefault` may run. Dropping that guard turns pressing
    // Enter on Close into "re-activate the tab and swallow the close".
    keyDownOf(row)({
      key: "Enter",
      target: { closeButton: true },
      currentTarget: { row: true },
      preventDefault,
    });
    expect(onActivate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("keys other than Enter/Space are left alone", () => {
    const onActivate = mock((_id: number) => {});
    const row = tabElements(threeTabs(), onActivate, () => {})[0]!;

    const preventDefault = mock(() => {});
    const target = { self: true };
    keyDownOf(row)({ key: "a", target, currentTarget: target, preventDefault });
    expect(onActivate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
