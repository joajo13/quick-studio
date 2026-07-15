/**
 * Unit tests for the pure Workspace Tab model (FR-23). No DOM / React harness —
 * the model is exercised as pure functions, one test per I/O-matrix row plus the
 * close-active sibling heuristic and immutability guarantees.
 */

import { describe, expect, test } from "bun:test";
import type { WorkspaceSnapshot } from "../../shared/contract.ts";
import {
  activateTab,
  bindTableToActiveTab,
  closeTab,
  emptyWorkspace,
  openTab,
  restoreErdLayouts,
  restoreWorkspace,
  toWorkspaceSnapshot,
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

describe("restoreWorkspace", () => {
  test("rebuilds tabs/activeTabId/nextId verbatim from a well-formed snapshot", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [25, 75],
      tabs: [
        { id: 1, kind: "table", title: "Table 1" },
        { id: 2, kind: "query", title: "Query 2" },
      ],
      activeTabId: 2,
      nextId: 3,
    };
    const state = restoreWorkspace(snapshot);
    expect(state.tabs).toEqual([
      { id: 1, kind: "table", title: "Table 1" },
      { id: 2, kind: "query", title: "Query 2" },
    ]);
    expect(state.activeTabId).toBe(2);
    expect(state.nextId).toBe(3);
  });

  test("an empty snapshot restores to an empty (but not necessarily identical) workspace", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [20, 80],
      tabs: [],
      activeTabId: null,
      nextId: 1,
    };
    const state = restoreWorkspace(snapshot);
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.nextId).toBe(1);
  });

  test("recomputes nextId when the stored value doesn't clear max(tab ids)+1", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [20, 80],
      tabs: [{ id: 5, kind: "table", title: "Table 5" }],
      activeTabId: 5,
      // Stale/malicious nextId that would collide with the existing tab id 5.
      nextId: 1,
    };
    const state = restoreWorkspace(snapshot);
    expect(state.nextId).toBe(6);
    // The next openTab must never reuse an existing id.
    const next = openTab(state, "query");
    expect(next.tabs.some((t) => t.id === 5)).toBe(true);
    expect(next.tabs.find((t) => t.kind === "query")?.id).toBe(6);
  });

  test("keeps a nextId that already clears max(tab ids)+1 untouched", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [20, 80],
      tabs: [{ id: 5, kind: "table", title: "Table 5" }],
      activeTabId: 5,
      nextId: 10,
    };
    expect(restoreWorkspace(snapshot).nextId).toBe(10);
  });

  test("a dangling activeTabId (not among the restored tabs) falls back to the first tab", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [20, 80],
      tabs: [
        { id: 1, kind: "table", title: "Table 1" },
        { id: 2, kind: "query", title: "Query 2" },
      ],
      activeTabId: 999,
      nextId: 3,
    };
    const state = restoreWorkspace(snapshot);
    expect(state.activeTabId).toBe(1);
  });

  test("a dangling activeTabId with no tabs at all falls back to null", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [20, 80],
      tabs: [],
      activeTabId: 999,
      nextId: 1,
    };
    expect(restoreWorkspace(snapshot).activeTabId).toBeNull();
  });
});

describe("restoreWorkspace — duplicate tab ids (DW-26)", () => {
  const DUP: WorkspaceSnapshot = {
    version: 1,
    panelSizes: [20, 80],
    tabs: [
      { id: 1, kind: "table", title: "first" },
      { id: 1, kind: "query", title: "second" }, // dup id — must be dropped
      { id: 2, kind: "erd", title: "third" },
    ],
    activeTabId: 1,
    nextId: 3,
  };

  test("keeps only the first tab per id (a hand-edited dup file still opens, deduped)", () => {
    const state = restoreWorkspace(DUP);
    expect(state.tabs).toEqual([
      { id: 1, kind: "table", title: "first" },
      { id: 2, kind: "erd", title: "third" },
    ]);
  });

  test("a subsequent closeTab(id) removes exactly one tab (never two)", () => {
    const state = restoreWorkspace(DUP);
    expect(state.tabs).toHaveLength(2); // three entries deduped to two
    const closed = closeTab(state, 1);
    expect(closed.tabs).toHaveLength(1);
    expect(closed.tabs.map((t) => t.id)).toEqual([2]);
  });
});

describe("toWorkspaceSnapshot", () => {
  test("captures tabs/activeTabId/nextId plus the supplied panelSizes", () => {
    const state = openMany("table", "query");
    const snapshot = toWorkspaceSnapshot(state, [30, 70]);
    expect(snapshot).toEqual({
      version: 1,
      panelSizes: [30, 70],
      tabs: [
        { id: 1, kind: "table", title: "Table 1" },
        { id: 2, kind: "query", title: "Query 2" },
      ],
      activeTabId: 2,
      nextId: 3,
    });
  });

  test("round-trips through restoreWorkspace back to an equivalent WorkspaceState", () => {
    let state: WorkspaceState = openMany("table", "query", "erd");
    state = activateTab(state, 2);
    const snapshot = toWorkspaceSnapshot(state, [25, 75]);
    const restored = restoreWorkspace(snapshot);
    expect(restored).toEqual(state);
  });

  test("does not mutate the input panelSizes array (defensive copy)", () => {
    const state = openTab(emptyWorkspace(), "table");
    const sizes = [20, 80];
    const snapshot = toWorkspaceSnapshot(state, sizes);
    expect(snapshot.panelSizes).not.toBe(sizes);
    expect(snapshot.panelSizes).toEqual(sizes);
  });

  test("omits erdLayouts entirely when none is supplied (byte-identical to a pre-4.2 snapshot)", () => {
    const state = openMany("erd");
    const snapshot = toWorkspaceSnapshot(state, [20, 80]);
    expect("erdLayouts" in snapshot).toBe(false);
  });
});

describe("erdLayouts bridge (Story 4.2)", () => {
  const LAYOUT = { positions: { "public orders": { x: 10, y: 20 } }, viewport: { x: 0, y: 0, zoom: 1 } };

  test("toWorkspaceSnapshot carries an erdLayouts entry for an open (erd) tab", () => {
    const state = openMany("erd"); // tab id 1
    const snapshot = toWorkspaceSnapshot(state, [20, 80], { "1": LAYOUT });
    expect(snapshot.erdLayouts).toEqual({ "1": LAYOUT });
  });

  test("toWorkspaceSnapshot prunes a layout whose tab id is not in the tab set", () => {
    const state = openMany("erd"); // tab id 1
    const snapshot = toWorkspaceSnapshot(state, [20, 80], { "1": LAYOUT, "999": LAYOUT });
    expect(snapshot.erdLayouts).toEqual({ "1": LAYOUT });
  });

  test("restoreErdLayouts drops layouts for tab ids absent from the restored set", () => {
    const snapshot = {
      version: 1 as const,
      panelSizes: [20, 80],
      tabs: [{ id: 1, kind: "erd" as const, title: "ERD 1" }],
      activeTabId: 1,
      nextId: 2,
      erdLayouts: { "1": LAYOUT, "5": LAYOUT },
    };
    const state = restoreWorkspace(snapshot);
    expect(restoreErdLayouts(snapshot, state.tabs)).toEqual({ "1": LAYOUT });
  });

  test("restoreErdLayouts returns {} for a pre-4.2 snapshot with no erdLayouts", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [20, 80],
      tabs: [{ id: 1, kind: "erd", title: "ERD 1" }],
      activeTabId: 1,
      nextId: 2,
    };
    expect(restoreErdLayouts(snapshot, restoreWorkspace(snapshot).tabs)).toEqual({});
  });
});

describe("bindTableToActiveTab (Story 3.2)", () => {
  const REF = { schema: "public", name: "orders" };

  test("opens a new active table tab when no tab is active", () => {
    const s = bindTableToActiveTab(emptyWorkspace(), REF);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toEqual({ id: 1, kind: "table", title: "orders", table: REF });
    expect(s.activeTabId).toBe(1);
    expect(s.nextId).toBe(2);
  });

  test("reuses the active table tab: rebinds ref + renames to the table name", () => {
    let s = openTab(emptyWorkspace(), "table"); // "Table 1", active, unbound
    s = bindTableToActiveTab(s, REF);
    expect(s.tabs).toHaveLength(1); // reused, not appended
    expect(s.tabs[0]).toEqual({ id: 1, kind: "table", title: "orders", table: REF });
    // Rebind to another table reuses the same tab and renames again.
    const REF2 = { schema: "public", name: "users" };
    s = bindTableToActiveTab(s, REF2);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]?.title).toBe("users");
    expect(s.tabs[0]?.table).toEqual(REF2);
  });

  test("opens a new table tab when the active tab is a non-table kind", () => {
    let s = openTab(emptyWorkspace(), "query"); // active is a query tab
    s = bindTableToActiveTab(s, REF);
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[1]).toEqual({ id: 2, kind: "table", title: "orders", table: REF });
    expect(s.activeTabId).toBe(2);
  });

  test("does not mutate the input state (immutability)", () => {
    const before = openTab(emptyWorkspace(), "table");
    const snapshotBefore = JSON.stringify(before);
    bindTableToActiveTab(before, REF);
    expect(JSON.stringify(before)).toBe(snapshotBefore);
  });

  test("the table binding is NOT persisted in a snapshot (drops on restore)", () => {
    const s = bindTableToActiveTab(emptyWorkspace(), REF);
    const snap = toWorkspaceSnapshot(s, [20, 80]);
    expect(snap.tabs[0]).toEqual({ id: 1, kind: "table", title: "orders" });
    const restored = restoreWorkspace(snap);
    expect(restored.tabs[0]?.table).toBeUndefined();
  });
});
