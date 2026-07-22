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
  isTabConnectionMissing,
  openOrFocusCreateTable,
  openOrFocusSettings,
  openTab,
  restoreErdLayouts,
  restoreLastProvider,
  restoreWorkspace,
  sanitizePanelSizes,
  setTabConnection,
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

  test("opening a report mints exactly state.nextId and activates it — the App open seam invariant", () => {
    // App.onOpenReport reads `id = workspace.nextId` to predict the tab openTab will mint,
    // then seeds reportStates[id]. This test PINS that coupling: for the non-singleton
    // `report` kind, the opened tab's id === the prior nextId and becomes active. If this
    // ever breaks (e.g. report becomes a singleton or id logic changes), the App seed would
    // land on the wrong id and the report tab would mount empty — so keep this green.
    const before = openMany("table", "chat"); // arbitrary non-empty state; nextId === 3
    const predicted = before.nextId;
    const after = openTab(before, "report");
    const opened = after.tabs.find((t) => t.kind === "report");
    expect(opened?.id).toBe(predicted);
    expect(after.activeTabId).toBe(predicted);
    expect(after.nextId).toBe(predicted + 1);
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

describe("openOrFocusSettings (Story 8.6 — singleton)", () => {
  test("opens a single active Settings tab when none exists (title 'Settings', no suffix)", () => {
    const s = openOrFocusSettings(openMany("table", "query")); // ids 1,2 → settings id 3
    expect(s.tabs).toHaveLength(3);
    const settings = s.tabs[2]!;
    expect(settings).toEqual({ id: 3, kind: "settings", title: "Settings" });
    expect(s.activeTabId).toBe(3);
    expect(s.nextId).toBe(4);
  });

  test("focuses the existing Settings tab instead of opening a second (no duplicate)", () => {
    let s = openOrFocusSettings(openMany("table", "query")); // settings id 3, active
    s = activateTab(s, 1); // switch away from settings
    const before = s;
    s = openOrFocusSettings(s); // click Settings again
    expect(s.tabs.filter((t) => t.kind === "settings")).toHaveLength(1);
    expect(s.tabs).toHaveLength(before.tabs.length); // no new tab
    expect(s.activeTabId).toBe(3); // the existing settings tab is focused
    expect(s.nextId).toBe(before.nextId); // nextId unchanged
  });

  test("is a no-op when the Settings tab is already active", () => {
    const s = openOrFocusSettings(openMany("table")); // settings active
    expect(openOrFocusSettings(s)).toBe(s); // identical reference — true no-op
  });

  test("does not mutate the input state", () => {
    const a = openMany("table");
    const b = openOrFocusSettings(a);
    expect(a.tabs).toHaveLength(1);
    expect(b).not.toBe(a);
  });

  test("openTab('settings') routes through the singleton seam (no duplicate 'Settings 2')", () => {
    // The widened enum type-accepts "settings"; openTab must not mint a numeric-suffixed
    // duplicate — it delegates to openOrFocusSettings (open-then-focus, never two).
    let s = openTab(openMany("table"), "settings"); // opens the one settings tab (id 2)
    const settingsTabs = () => s.tabs.filter((t) => t.kind === "settings");
    expect(settingsTabs()).toHaveLength(1);
    expect(settingsTabs()[0]?.title).toBe("Settings");
    const nextIdAfterOpen = s.nextId;
    s = openTab(s, "settings"); // second call focuses, does not append
    expect(settingsTabs()).toHaveLength(1);
    expect(s.nextId).toBe(nextIdAfterOpen); // no id burned on the focus path
  });
});

describe("openOrFocusCreateTable (Story 9.4 — singleton)", () => {
  test("opens a single active create-table tab when none exists (title 'New Table', no suffix)", () => {
    const s = openOrFocusCreateTable(openMany("table", "query")); // ids 1,2 → create-table id 3
    expect(s.tabs).toHaveLength(3);
    const created = s.tabs[2]!;
    expect(created).toEqual({ id: 3, kind: "create-table", title: "New Table" });
    expect(s.activeTabId).toBe(3);
    expect(s.nextId).toBe(4);
  });

  test("focuses the existing create-table tab instead of opening a second (no duplicate)", () => {
    let s = openOrFocusCreateTable(openMany("table", "query")); // create-table id 3, active
    s = activateTab(s, 1); // switch away from create-table
    const before = s;
    s = openOrFocusCreateTable(s); // click create again
    expect(s.tabs.filter((t) => t.kind === "create-table")).toHaveLength(1);
    expect(s.tabs).toHaveLength(before.tabs.length); // no new tab
    expect(s.activeTabId).toBe(3); // the existing create-table tab is focused
    expect(s.nextId).toBe(before.nextId); // no id burned on the focus path (draft is NOT preserved here — the switch-away unmounted the panel)
  });

  test("is a no-op when the create-table tab is already active", () => {
    const s = openOrFocusCreateTable(openMany("table")); // create-table active
    expect(openOrFocusCreateTable(s)).toBe(s); // identical reference — true no-op
  });

  test("does not mutate the input state", () => {
    const a = openMany("table");
    const b = openOrFocusCreateTable(a);
    expect(a.tabs).toHaveLength(1);
    expect(b).not.toBe(a);
  });

  test("openTab('create-table') routes through the singleton seam (no duplicate 'New Table 2')", () => {
    // The widened UI enum type-accepts "create-table"; openTab must not mint a numeric-suffixed
    // duplicate — it delegates to openOrFocusCreateTable (open-then-focus, never two).
    let s = openTab(openMany("table"), "create-table"); // opens the one create-table tab (id 2)
    const createTabs = () => s.tabs.filter((t) => t.kind === "create-table");
    expect(createTabs()).toHaveLength(1);
    expect(createTabs()[0]?.title).toBe("New Table");
    const nextIdAfterOpen = s.nextId;
    s = openTab(s, "create-table"); // second call focuses, does not append
    expect(createTabs()).toHaveLength(1);
    expect(s.nextId).toBe(nextIdAfterOpen); // no id burned on the focus path
  });
});

describe("create-table tab NON-persistence (Story 9.4)", () => {
  test("toWorkspaceSnapshot DROPS a create-table tab (never reaches disk)", () => {
    let state = openMany("table"); // id 1
    state = openOrFocusCreateTable(state); // create-table id 2, active
    const snapshot = toWorkspaceSnapshot(state, [30, 70]);
    // The create-table tab is filtered out; only the persisted document tab survives.
    // (`snapshot.tabs.kind` is typed `WorkspaceTabKind`, which cannot even be compared to
    // "create-table" — tsc itself proves the drop; the `toEqual` confirms it at runtime.)
    expect(snapshot.tabs).toEqual([{ id: 1, kind: "table", title: "Table 1" }]);
    // The active tab WAS the (now-dropped) create-table tab, so toWorkspaceSnapshot
    // reconciles activeTabId to the first surviving tab — it must never emit a dangling id.
    expect(snapshot.activeTabId).toBe(1);
    expect(restoreWorkspace(snapshot).activeTabId).toBe(1);
  });

  test("toWorkspaceSnapshot reconciles activeTabId when create-table is active (no dangling id → Core save accepts)", () => {
    // Regression (Story 9.4): dropping the active create-table tab must not leave
    // activeTabId pointing at an id that is absent from snapshot.tabs. Core's save
    // validator rejects such a snapshot (activeTabId must be a present tab id), which
    // would fail workspace.save for as long as create-table is the active tab.
    let state = openMany("table", "query"); // ids 1, 2
    state = openOrFocusCreateTable(state); // create-table id 3, active
    const snapshot = toWorkspaceSnapshot(state, [30, 70]);
    const ids = snapshot.tabs.map((t) => t.id);
    expect(ids).toEqual([1, 2]); // create-table dropped
    // The reconciled activeTabId is one of the surviving ids (Core's "present tab id" rule).
    expect(snapshot.activeTabId).toBe(1);
  });

  test("toWorkspaceSnapshot emits activeTabId:null when create-table is the only tab (Core's empty-tabs rule)", () => {
    // The empty-workspace variant: with create-table as the sole tab, the filtered tabs
    // are empty, so activeTabId MUST be null — Core rejects a non-null activeTabId with
    // no tabs.
    const state = openOrFocusCreateTable(emptyWorkspace()); // create-table is the only tab, active
    const snapshot = toWorkspaceSnapshot(state, [30, 70]);
    expect(snapshot.tabs).toEqual([]);
    expect(snapshot.activeTabId).toBeNull();
  });
});

describe("TableRef NON-persistence stands, tab-level connectionId now persists (Story 10.6)", () => {
  test("toWorkspaceSnapshot emits the TAB's connectionId but still never the table ref", () => {
    // Story 10.5 pinned that NOTHING connection-shaped reached disk, because the id lived
    // only on the (never-persisted) `table` ref. Story 10.6 LANDED the persistence — but
    // only for the tab-level mirror: `table` (schema/name) is still dropped verbatim, so
    // Story 3.2's "the open-table binding does not survive a restart" is untouched. This
    // test now pins BOTH halves so neither can regress into the other.
    const CONNECTION_ID = "b7e6f1c2-0000-4aaa-9bbb-deadbeefcafe";
    let state = openMany("table"); // table tab id 1, active
    state = bindTableToActiveTab(state, {
      schema: "public",
      name: "orders",
      connectionId: CONNECTION_ID,
    });
    // The binding really is on the in-memory state — otherwise the assertions below
    // would pass vacuously.
    expect(state.tabs[0]?.table?.connectionId).toBe(CONNECTION_ID);
    // …and the tab-level mirror was written alongside it.
    expect(state.tabs[0]?.connectionId).toBe(CONNECTION_ID);

    const snapshot = toWorkspaceSnapshot(state, [30, 70]);
    // The persisted tab carries id/kind/title + the connection id — and NO `table` key,
    // so schema/name never reach disk (the field-by-field map is what guarantees it).
    expect(snapshot.tabs).toEqual([
      { id: 1, kind: "table", title: "orders", connectionId: CONNECTION_ID },
    ]);
    expect(snapshot.tabs[0]).not.toHaveProperty("table");
    // The claim is about the emitted tab's SHAPE, so assert the key set itself: a
    // "the serialized JSON does not contain 'public'" check would pass or fail on the
    // fixture's schema NAME, not on whether the ref was dropped.
    expect(Object.keys(snapshot.tabs[0]!).sort()).toEqual([
      "connectionId",
      "id",
      "kind",
      "title",
    ]);
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

describe("restoreWorkspace — settings-singleton defense (Story 8.6)", () => {
  test("collapses two settings tabs (distinct ids) to the FIRST occurrence", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [20, 80],
      tabs: [
        { id: 1, kind: "table", title: "Table 1" },
        { id: 2, kind: "settings", title: "Settings" }, // first settings — kept
        { id: 3, kind: "settings", title: "Settings" }, // second settings — dropped
      ],
      activeTabId: 1,
      nextId: 4,
    };
    const state = restoreWorkspace(snapshot);
    expect(state.tabs).toEqual([
      { id: 1, kind: "table", title: "Table 1" },
      { id: 2, kind: "settings", title: "Settings" },
    ]);
    expect(state.tabs.filter((t) => t.kind === "settings")).toHaveLength(1);
  });

  test("recomputes activeTabId when it pointed at a dropped settings tab (falls back to first)", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [20, 80],
      tabs: [
        { id: 1, kind: "table", title: "Table 1" },
        { id: 2, kind: "settings", title: "Settings" },
        { id: 3, kind: "settings", title: "Settings" }, // dropped
      ],
      activeTabId: 3, // pointed at the dropped tab
      nextId: 4,
    };
    const state = restoreWorkspace(snapshot);
    expect(state.tabs.some((t) => t.id === 3)).toBe(false);
    expect(state.activeTabId).toBe(1); // dangling → first restored tab
  });
});

describe("settings tab persistence (Story 8.6)", () => {
  test("a settings tab round-trips through toWorkspaceSnapshot → restoreWorkspace", () => {
    let state = openMany("table"); // id 1
    state = openOrFocusSettings(state); // settings id 2, active
    const snapshot = toWorkspaceSnapshot(state, [30, 70]);
    expect(snapshot.tabs).toEqual([
      { id: 1, kind: "table", title: "Table 1" },
      { id: 2, kind: "settings", title: "Settings" },
    ]);
    expect(restoreWorkspace(snapshot)).toEqual(state);
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

describe("lastProvider bridge (Story 8.5)", () => {
  const BASE_SNAPSHOT: WorkspaceSnapshot = {
    version: 1,
    panelSizes: [20, 80],
    tabs: [{ id: 1, kind: "chat", title: "Chat 1" }],
    activeTabId: 1,
    nextId: 2,
  };

  test("toWorkspaceSnapshot carries lastProvider only when a provider is set", () => {
    const state = openMany("chat"); // tab id 1
    const snapshot = toWorkspaceSnapshot(state, [20, 80], undefined, "openai");
    expect(snapshot.lastProvider).toBe("openai");
  });

  test("toWorkspaceSnapshot omits lastProvider when null/undefined (no-resave invariant)", () => {
    const state = openMany("chat");
    expect("lastProvider" in toWorkspaceSnapshot(state, [20, 80], undefined, null)).toBe(false);
    expect("lastProvider" in toWorkspaceSnapshot(state, [20, 80])).toBe(false);
    // Byte-identical to a snapshot with no provider AND no erd layouts.
    expect(toWorkspaceSnapshot(state, [20, 80], undefined, null)).toEqual(
      toWorkspaceSnapshot(state, [20, 80]),
    );
  });

  test("lastProvider coexists with erdLayouts when both are supplied", () => {
    const state = openMany("erd"); // tab id 1
    const layout = { positions: { "public orders": { x: 1, y: 2 } } };
    const snapshot = toWorkspaceSnapshot(state, [20, 80], { "1": layout }, "google");
    expect(snapshot.erdLayouts).toEqual({ "1": layout });
    expect(snapshot.lastProvider).toBe("google");
  });

  test("restoreLastProvider returns a known kind and drops an unknown/absent one", () => {
    expect(restoreLastProvider({ ...BASE_SNAPSHOT, lastProvider: "anthropic" })).toBe("anthropic");
    // Unknown / hand-edited garbage -> null (field-drop posture).
    expect(restoreLastProvider({ ...BASE_SNAPSHOT, lastProvider: "bogus" as never })).toBeNull();
    // Absent (pre-8.5 file) -> null.
    expect(restoreLastProvider(BASE_SNAPSHOT)).toBeNull();
  });
});

describe("bindTableToActiveTab (Story 3.2)", () => {
  const REF = { schema: "public", name: "orders" };

  test("opens a new active table tab when no tab is active", () => {
    const s = bindTableToActiveTab(emptyWorkspace(), REF);
    expect(s.tabs).toHaveLength(1);
    // `connectionId: null` is the tab-level mirror of `ref.connectionId` (Story 10.6);
    // REF carries none, so this bind targets the boot/default connection.
    expect(s.tabs[0]).toEqual({ id: 1, kind: "table", title: "orders", table: REF, connectionId: null });
    expect(s.activeTabId).toBe(1);
    expect(s.nextId).toBe(2);
  });

  test("reuses the active table tab: rebinds ref + renames to the table name", () => {
    let s = openTab(emptyWorkspace(), "table"); // "Table 1", active, unbound
    s = bindTableToActiveTab(s, REF);
    expect(s.tabs).toHaveLength(1); // reused, not appended
    expect(s.tabs[0]).toEqual({ id: 1, kind: "table", title: "orders", table: REF, connectionId: null });
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
    expect(s.tabs[1]).toEqual({ id: 2, kind: "table", title: "orders", table: REF, connectionId: null });
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

describe("sanitizePanelSizes (DW-23)", () => {
  const DEFAULTS = [20, 80];

  test("a valid same-length split that sums to 100 is used verbatim", () => {
    expect(sanitizePanelSizes([25, 75], DEFAULTS)).toEqual([25, 75]);
  });

  test("a wrong-length split falls back to defaults", () => {
    expect(sanitizePanelSizes([42], DEFAULTS)).toEqual([20, 80]);
    expect(sanitizePanelSizes([10, 20, 30], DEFAULTS)).toEqual([20, 80]);
  });

  test("out-of-range entries clamp to [0,100] when they still sum to 100", () => {
    expect(sanitizePanelSizes([-5, 105], DEFAULTS)).toEqual([0, 100]);
  });

  test("a same-length split whose clamped values do not sum to ~100 falls back to defaults", () => {
    expect(sanitizePanelSizes([10, 20], DEFAULTS)).toEqual([20, 80]);
  });

  test("an empty split falls back to defaults", () => {
    expect(sanitizePanelSizes([], DEFAULTS)).toEqual([20, 80]);
  });
});

/* ------------------------------------------------------------------ *
 * Story 10.6 — the tab-level connectionId: bind, persist, restore, reassign
 * ------------------------------------------------------------------ */

const CONN = "conn-2";

describe("bindTableToActiveTab mirrors ref.connectionId onto the tab (Story 10.6)", () => {
  test("the NEW-tab branch records the saved connection id", () => {
    const s = bindTableToActiveTab(emptyWorkspace(), {
      schema: "public",
      name: "orders",
      connectionId: CONN,
    });
    expect(s.tabs[0]?.connectionId).toBe(CONN);
    expect(s.tabs[0]?.table?.connectionId).toBe(CONN);
  });

  test("the REBIND branch overwrites a previous id (never drifts from the live ref)", () => {
    let s = bindTableToActiveTab(emptyWorkspace(), {
      schema: "public",
      name: "orders",
      connectionId: CONN,
    });
    expect(s.tabs[0]?.connectionId).toBe(CONN);
    // Rebinding the SAME (active) table tab to a boot-root table must not leave `conn-2`
    // behind — otherwise the tab would persist an id it no longer reads from.
    s = bindTableToActiveTab(s, { schema: "public", name: "users", connectionId: null });
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]?.connectionId).toBeNull();
  });

  test("an absent ref.connectionId is recorded as null (the boot/default target)", () => {
    const fromNewTab = bindTableToActiveTab(emptyWorkspace(), { schema: "public", name: "orders" });
    expect(fromNewTab.tabs[0]?.connectionId).toBeNull();
    // …and the same on the rebind branch.
    const rebound = bindTableToActiveTab(openTab(emptyWorkspace(), "table"), {
      schema: "public",
      name: "orders",
    });
    expect(rebound.tabs[0]?.connectionId).toBeNull();
  });

  test("a BLANK ref.connectionId is normalised to null, never persisted as-is", () => {
    // This is the PRIMARY writer of the field (a click in the tree), so it needs the same
    // guard as the reassign seam: `ConnectionSummary.id` is only `typeof`-checked on the way
    // in, and Core's save boundary rejects a present-but-blank `connectionId` outright — one
    // blank id reaching a tab would fail EVERY subsequent autosave, silently.
    for (const blank of ["", "   ", "\t\n"]) {
      const fromNewTab = bindTableToActiveTab(emptyWorkspace(), {
        schema: "public",
        name: "orders",
        connectionId: blank,
      });
      expect(fromNewTab.tabs[0]?.connectionId).toBeNull();
      // …and on the rebind branch, where a stale good id would otherwise be replaced by junk.
      const rebound = bindTableToActiveTab(
        bindTableToActiveTab(emptyWorkspace(), {
          schema: "public",
          name: "orders",
          connectionId: CONN,
        }),
        { schema: "public", name: "users", connectionId: blank },
      );
      expect(rebound.tabs[0]?.connectionId).toBeNull();
    }
  });
});

describe("toWorkspaceSnapshot — connectionId is emitted only when a saved connection is targeted", () => {
  test("a saved-connection table tab persists its id", () => {
    const s = bindTableToActiveTab(emptyWorkspace(), {
      schema: "public",
      name: "orders",
      connectionId: CONN,
    });
    expect(toWorkspaceSnapshot(s, [20, 80]).tabs[0]).toEqual({
      id: 1,
      kind: "table",
      title: "orders",
      connectionId: CONN,
    });
  });

  test("a boot-bound (null) and a never-bound tab emit NO connectionId key at all", () => {
    // Boot-bound: the tab-level value is `null`, which must not reach disk — `null` and
    // absent are read identically, so writing it would only break the byte-identical
    // guarantee for the ephemeral single-connection case.
    const bootBound = bindTableToActiveTab(emptyWorkspace(), { schema: "public", name: "orders" });
    const bootTab = toWorkspaceSnapshot(bootBound, [20, 80]).tabs[0]!;
    expect("connectionId" in bootTab).toBe(false);

    // Never bound: a plain `openTab` table + a query tab, neither of which has the field.
    const neverBound = openMany("table", "query");
    for (const t of toWorkspaceSnapshot(neverBound, [20, 80]).tabs) {
      expect("connectionId" in t).toBe(false);
    }
    // Byte-identical to a pre-10.6 snapshot.
    expect(JSON.stringify(toWorkspaceSnapshot(neverBound, [20, 80]))).not.toContain("connectionId");
  });

  test("the table ref itself is still never emitted, id or no id", () => {
    const s = bindTableToActiveTab(emptyWorkspace(), {
      schema: "public",
      name: "orders",
      connectionId: CONN,
    });
    expect(toWorkspaceSnapshot(s, [20, 80]).tabs[0]).not.toHaveProperty("table");
  });
});

describe("connectionId round-trip: bind → toWorkspaceSnapshot → restoreWorkspace", () => {
  test("the id survives a relaunch while the table binding does not (Story 3.2 stands)", () => {
    const bound = bindTableToActiveTab(emptyWorkspace(), {
      schema: "public",
      name: "orders",
      connectionId: CONN,
    });
    const restored = restoreWorkspace(toWorkspaceSnapshot(bound, [20, 80]));
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]?.id).toBe(1);
    expect(restored.tabs[0]?.kind).toBe("table");
    expect(restored.tabs[0]?.title).toBe("orders");
    expect(restored.tabs[0]?.connectionId).toBe(CONN);
    expect(restored.tabs[0]?.table).toBeUndefined();
    expect(restored.activeTabId).toBe(1);
  });
});

describe("restoreWorkspace — connectionId (Story 10.6)", () => {
  test("a pre-10.6 snapshot restores every tab with connectionId undefined and nothing else changed", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [25, 75],
      tabs: [
        { id: 1, kind: "table", title: "Table 1" },
        { id: 2, kind: "query", title: "Query 2" },
        { id: 3, kind: "erd", title: "ERD 3" },
      ],
      activeTabId: 2,
      nextId: 4,
    };
    const state = restoreWorkspace(snapshot);
    expect(state.tabs).toHaveLength(3);
    expect(state.tabs.map((t) => t.kind)).toEqual(["table", "query", "erd"]);
    expect(state.tabs.map((t) => t.title)).toEqual(["Table 1", "Query 2", "ERD 3"]);
    expect(state.tabs.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(state.activeTabId).toBe(2);
    expect(state.nextId).toBe(4);
    for (const t of state.tabs) {
      expect(t.connectionId).toBeUndefined();
      expect("connectionId" in t).toBe(false); // the key is OMITTED, not set to null
    }
  });

  test("a hand-edited connectionId is sanitized to an absent key without dropping the tab", () => {
    // The store deliberately does not gate this field (gating there is all-or-nothing over
    // `tabs`), so `restoreWorkspace` is the sanitizer of record. Every bad value below must
    // yield a tab that still restores, minus the field.
    for (const bad of [42, "", "   ", "\t\n", {}, null, true, []]) {
      const snapshot = {
        version: 1,
        panelSizes: [20, 80],
        tabs: [{ id: 1, kind: "table", title: "orders", connectionId: bad }],
        activeTabId: 1,
        nextId: 2,
      } as unknown as WorkspaceSnapshot;
      const state = restoreWorkspace(snapshot);
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0]).toEqual({ id: 1, kind: "table", title: "orders" });
      expect("connectionId" in state.tabs[0]!).toBe(false);
      expect(state.activeTabId).toBe(1);
    }
  });

  test("a well-formed id is carried verbatim, alongside tabs that have none", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      panelSizes: [20, 80],
      tabs: [
        { id: 1, kind: "table", title: "orders", connectionId: CONN },
        { id: 2, kind: "query", title: "Query 2" },
      ],
      activeTabId: 1,
      nextId: 3,
    };
    const state = restoreWorkspace(snapshot);
    expect(state.tabs[0]?.connectionId).toBe(CONN);
    expect(state.tabs[1]?.connectionId).toBeUndefined();
  });
});

describe("setTabConnection (Story 10.6 reassign)", () => {
  const bound = (): WorkspaceState => {
    let s = bindTableToActiveTab(emptyWorkspace(), {
      schema: "public",
      name: "orders",
      connectionId: CONN,
    });
    s = openTab(s, "query"); // a sibling that must be untouched
    return s;
  };

  test("sets the id and CLEARS the stale table binding", () => {
    const s = setTabConnection(bound(), 1, "conn-9");
    expect(s.tabs[0]?.connectionId).toBe("conn-9");
    // The old ref pointed at a table in a DIFFERENT database — reusing it would browse
    // (and potentially write to) rows the user never picked.
    expect(s.tabs[0]?.table).toBeUndefined();
    expect("table" in s.tabs[0]!).toBe(false);
    expect(s.tabs[0]?.title).toBe("orders"); // title/kind/id/position are preserved
    expect(s.tabs[0]?.kind).toBe("table");
  });

  test("accepts null (back to the boot/default target)", () => {
    const s = setTabConnection(bound(), 1, null);
    expect(s.tabs[0]?.connectionId).toBeNull();
  });

  test("leaves every sibling tab reference-identical", () => {
    const before = bound();
    const after = setTabConnection(before, 1, "conn-9");
    expect(after.tabs[1]).toBe(before.tabs[1]!);
    expect(after.activeTabId).toBe(before.activeTabId);
    expect(after.nextId).toBe(before.nextId);
  });

  test("normalises a blank id to null so it can never poison a later save", () => {
    // `ConnectionSummary.id` is only `typeof`-checked where it enters the UI, so a
    // hand-edited registry can produce `id: ""`. Core's save boundary rejects a PRESENT
    // but empty `connectionId`, which would make EVERY subsequent `workspace.save` fail
    // with `bad_request` — silently, since a failed save has no UI surface.
    expect(setTabConnection(bound(), 1, "").tabs[0]?.connectionId).toBeNull();
    expect(setTabConnection(bound(), 1, "   ").tabs[0]?.connectionId).toBeNull();
    // …and the normalised value is what reaches the snapshot: `null` is dropped entirely,
    // which is exactly how a boot-bound tab serializes.
    const snapshot = toWorkspaceSnapshot(setTabConnection(bound(), 1, ""), [20, 80]);
    expect(snapshot.tabs[0]).not.toHaveProperty("connectionId");
  });

  test("an unknown tab id returns the SAME state reference (no re-render churn)", () => {
    const before = bound();
    expect(setTabConnection(before, 999, "conn-9")).toBe(before);
  });

  test("the reassigned id is what the next save persists", () => {
    const s = setTabConnection(bound(), 1, "conn-9");
    expect(toWorkspaceSnapshot(s, [20, 80]).tabs[0]).toEqual({
      id: 1,
      kind: "table",
      title: "orders",
      connectionId: "conn-9",
    });
  });
});

describe("isTabConnectionMissing (Story 10.6)", () => {
  const tab = (connectionId?: string | null) =>
    ({ id: 1, kind: "table" as const, title: "orders", connectionId });

  test("an unknown live set (null) NEVER flags a tab", () => {
    // The `connections.list` read is in flight or failed — a read that never answered
    // must not accuse a tab of pointing at a deleted connection.
    expect(isTabConnectionMissing(tab(CONN), null)).toBe(false);
    expect(isTabConnectionMissing(tab(null), null)).toBe(false);
    expect(isTabConnectionMissing(tab(undefined), null)).toBe(false);
  });

  test("a boot/default tab (null or undefined) is never missing, even against an empty set", () => {
    expect(isTabConnectionMissing(tab(null), new Set())).toBe(false);
    expect(isTabConnectionMissing(tab(undefined), new Set())).toBe(false);
  });

  test("a present id is not missing; an absent one is", () => {
    expect(isTabConnectionMissing(tab(CONN), new Set([CONN, "conn-1"]))).toBe(false);
    expect(isTabConnectionMissing(tab(CONN), new Set(["conn-1"]))).toBe(true);
    expect(isTabConnectionMissing(tab(CONN), new Set())).toBe(true);
  });
});
