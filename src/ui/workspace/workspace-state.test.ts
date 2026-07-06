/**
 * Unit tests for the pure Workspace Tab model (FR-23). No DOM / React harness —
 * the model is exercised as pure functions, one test per I/O-matrix row plus the
 * close-active sibling heuristic and immutability guarantees.
 */

import { describe, expect, test } from "bun:test";
import {
  activateTab,
  closeTab,
  emptyWorkspace,
  openTab,
  type WorkspaceState,
} from "./workspace-state.ts";

/** Open a sequence of kinds onto an empty workspace. */
function openMany(...kinds: Parameters<typeof openTab>[1][]): WorkspaceState {
  return kinds.reduce<WorkspaceState>((s, k) => openTab(s, k), emptyWorkspace());
}

describe("emptyWorkspace", () => {
  test("has no tabs, nothing active, ids start at 1", () => {
    const s = emptyWorkspace();
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
    expect(s.nextId).toBe(1);
  });
});

describe("openTab", () => {
  test("appends a tab with a unique id + kind and makes it active", () => {
    const s = openTab(emptyWorkspace(), "table");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]?.kind).toBe("table");
    expect(s.tabs[0]?.id).toBe(1);
    expect(s.activeTabId).toBe(1);
    expect(s.nextId).toBe(2);
  });

  test("opening several same-kind tabs yields distinct tabs that coexist", () => {
    const s = openMany("table", "table", "table");
    expect(s.tabs).toHaveLength(3);
    const ids = s.tabs.map((t) => t.id);
    expect(new Set(ids).size).toBe(3); // all distinct
    expect(s.tabs.every((t) => t.kind === "table")).toBe(true);
    // The most-recently opened tab is active.
    expect(s.activeTabId).toBe(s.tabs[2]!.id);
  });

  test("supports all five kinds coexisting", () => {
    const s = openMany("table", "query", "erd", "chat", "report");
    expect(s.tabs.map((t) => t.kind)).toEqual(["table", "query", "erd", "chat", "report"]);
    expect(s.tabs).toHaveLength(5);
  });

  test("titles stay unique after a same-kind tab is closed and reopened", () => {
    let s = openMany("table", "table"); // "Table 1", "Table 2"
    s = closeTab(s, 1); // close "Table 1"
    s = openTab(s, "table"); // must NOT reuse "Table 2"
    const titles = s.tabs.map((t) => t.title);
    expect(new Set(titles).size).toBe(titles.length); // all distinct
  });

  test("does not mutate the input state", () => {
    const a = emptyWorkspace();
    const b = openTab(a, "table");
    expect(a.tabs).toHaveLength(0);
    expect(a.activeTabId).toBeNull();
    expect(b).not.toBe(a);
  });
});

describe("closeTab — non-active tab", () => {
  test("removes that tab, keeps activeTabId, leaves others intact", () => {
    const s = openMany("table", "query", "erd"); // active = erd (id 3)
    const before = s.tabs.map((t) => ({ ...t }));
    const next = closeTab(s, 1); // close the non-active table
    expect(next.tabs.map((t) => t.id)).toEqual([2, 3]);
    expect(next.activeTabId).toBe(3); // unchanged
    // The surviving tabs are byte-for-byte the same objects/content.
    expect(next.tabs[0]).toEqual(before[1]!);
    expect(next.tabs[1]).toEqual(before[2]!);
  });
});

describe("closeTab — unknown id", () => {
  test("returns the state unchanged", () => {
    const s = openMany("table", "query");
    const next = closeTab(s, 999);
    expect(next).toBe(s); // identical reference — true no-op
  });

  test("unknown id on empty workspace is a no-op", () => {
    const s = emptyWorkspace();
    expect(closeTab(s, 1)).toBe(s);
  });
});

describe("closeTab — active tab with siblings", () => {
  test("activates the sibling at the same index when one remains", () => {
    // tabs: [1,2,3], activate the middle one (id 2)
    let s = openMany("table", "query", "erd");
    s = activateTab(s, 2);
    const next = closeTab(s, 2);
    expect(next.tabs.map((t) => t.id)).toEqual([1, 3]);
    // Same index (1) now holds id 3 → it becomes active.
    expect(next.activeTabId).toBe(3);
  });

  test("activates the new last tab when the closed active was last", () => {
    const s = openMany("table", "query", "erd"); // active = last (id 3)
    const next = closeTab(s, 3);
    expect(next.tabs.map((t) => t.id)).toEqual([1, 2]);
    // Same index (2) no longer exists → fall back to new last (id 2).
    expect(next.activeTabId).toBe(2);
  });
});

describe("closeTab — last remaining tab", () => {
  test("empties the tab set and clears activeTabId", () => {
    const s = openTab(emptyWorkspace(), "report"); // one tab, active
    const next = closeTab(s, s.activeTabId!);
    expect(next.tabs).toEqual([]);
    expect(next.activeTabId).toBeNull();
  });
});

describe("activateTab", () => {
  test("switches the active tab to an existing id", () => {
    const s = openMany("table", "query"); // active = query (id 2)
    const next = activateTab(s, 1);
    expect(next.activeTabId).toBe(1);
    expect(next.tabs).toBe(s.tabs); // tabs untouched
  });

  test("is a no-op for an unknown id", () => {
    const s = openMany("table");
    expect(activateTab(s, 42)).toBe(s);
  });

  test("is a no-op when the id is already active", () => {
    const s = openMany("table", "query");
    expect(activateTab(s, 2)).toBe(s);
  });
});
