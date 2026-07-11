/**
 * quick-studio Core — workspace-registry tests (Story 2.5).
 *
 * Drives the registry over an INJECTED `openStore` seam (a fake in-memory store,
 * or a failing open) so every I/O matrix row is deterministic without touching a
 * real app dir: valid save → ok, bad_request on every malformed-params shape,
 * ephemeral no-op (saved:false, no underlying write), load happy path + degrade
 * (store returns null → snapshot:null, no error), and store-open failure →
 * internal_error. Self-contained — no filesystem I/O in this file at all (that
 * is `workspace-store.test.ts`'s job).
 */

import { describe, expect, test } from "bun:test";
import type { WorkspaceSnapshot } from "../shared/contract.ts";
import type { RunMode } from "./run-mode.ts";
import { createWorkspaceRegistry } from "./workspace-registry.ts";
import type { OpenResult, SaveResult, WorkspaceStore } from "./workspace-store.ts";

const SAMPLE: WorkspaceSnapshot = {
  version: 1,
  panelSizes: [25, 75],
  tabs: [
    { id: 1, kind: "table", title: "Table 1" },
    { id: 2, kind: "query", title: "Query 2" },
  ],
  activeTabId: 2,
  nextId: 3,
};

/**
 * A minimal in-memory fake store, injected via `openStore`, so the registry's
 * validation/mapping logic is exercised without real disk I/O. Tracks `save`
 * calls and can be told to force a `write-failed` outcome.
 */
function fakeStore(mode: RunMode, initial: WorkspaceSnapshot | null = null) {
  let snapshot: WorkspaceSnapshot | null = initial;
  let saveCalls = 0;
  let forcedFailure: string | null = null;
  const store: WorkspaceStore = {
    mode,
    load: () => snapshot,
    save: (s): SaveResult => {
      saveCalls++;
      if (forcedFailure !== null) return { outcome: "write-failed", detail: forcedFailure };
      if (mode === "ephemeral") return { outcome: "ok", saved: false };
      snapshot = s;
      return { outcome: "ok", saved: true };
    },
  };
  return {
    store,
    saveCalls: () => saveCalls,
    forceWriteFailure: (detail: string) => {
      forcedFailure = detail;
    },
  };
}

function registryOver(store: WorkspaceStore) {
  return createWorkspaceRegistry({ openStore: (): OpenResult => ({ outcome: "opened", store }) });
}

describe("workspace-registry — save happy path", () => {
  test("valid snapshot (persistent) → ok, saved:true, persisted", () => {
    const fake = fakeStore("persistent");
    const reg = registryOver(fake.store);
    const result = reg.save(SAMPLE);
    expect(result).toEqual({ ok: true, value: { saved: true } });
    expect(fake.saveCalls()).toBe(1);
  });

  test("activeTabId: null is always valid, even with tabs present", () => {
    const fake = fakeStore("persistent");
    const reg = registryOver(fake.store);
    const result = reg.save({ ...SAMPLE, activeTabId: null });
    expect(result.ok).toBe(true);
  });

  test("an empty workspace (no tabs, activeTabId null, nextId 1) is valid", () => {
    const fake = fakeStore("persistent");
    const reg = registryOver(fake.store);
    const result = reg.save({ version: 1, panelSizes: [20, 80], tabs: [], activeTabId: null, nextId: 1 });
    expect(result).toEqual({ ok: true, value: { saved: true } });
  });
});

describe("workspace-registry — erdLayouts validation (Story 4.2)", () => {
  const WITH_LAYOUT: WorkspaceSnapshot = {
    ...SAMPLE,
    erdLayouts: {
      "1": {
        positions: { "public orders": { x: 10, y: 20 } },
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
  };

  test("a valid erdLayouts snapshot saves and is persisted verbatim", () => {
    const fake = fakeStore("persistent");
    const reg = registryOver(fake.store);
    expect(reg.save(WITH_LAYOUT)).toEqual({ ok: true, value: { saved: true } });
    expect(fake.store.load()).toEqual(WITH_LAYOUT);
  });

  test("a snapshot with no erdLayouts saves without adding the field (byte-identical to pre-4.2)", () => {
    const fake = fakeStore("persistent");
    const reg = registryOver(fake.store);
    expect(reg.save(SAMPLE)).toEqual({ ok: true, value: { saved: true } });
    const saved = fake.store.load();
    expect(saved).toEqual(SAMPLE);
    expect(saved?.erdLayouts).toBeUndefined();
  });

  test("a non-finite position coordinate is a bad_request naming erdLayouts (nothing written)", () => {
    const fake = fakeStore("persistent");
    const reg = registryOver(fake.store);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
      const r = reg.save({
        ...SAMPLE,
        erdLayouts: { "1": { positions: { n: { x: bad, y: 0 } } } },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("bad_request");
        expect(r.detail).toContain("erdLayouts");
      }
    }
    expect(fake.saveCalls()).toBe(0);
  });

  test("a non-finite viewport field is a bad_request naming erdLayouts", () => {
    const reg = registryOver(fakeStore("persistent").store);
    const r = reg.save({
      ...SAMPLE,
      erdLayouts: { "1": { positions: {}, viewport: { x: 0, y: 0, zoom: Number.NaN } } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("bad_request");
      expect(r.detail).toContain("erdLayouts");
    }
  });

  test("a non-positive viewport zoom is a bad_request (degenerate restore guard)", () => {
    const reg = registryOver(fakeStore("persistent").store);
    for (const zoom of [0, -1]) {
      const r = reg.save({
        ...SAMPLE,
        erdLayouts: { "1": { positions: {}, viewport: { x: 0, y: 0, zoom } } },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("bad_request");
    }
  });
});

describe("workspace-registry — ephemeral save is a no-op", () => {
  test("ephemeral mode: saved:false in the reply, and the underlying store still gets the (no-op) call", () => {
    const fake = fakeStore("ephemeral");
    const reg = registryOver(fake.store);
    const result = reg.save(SAMPLE);
    expect(result).toEqual({ ok: true, value: { saved: false } });
    // The store itself is the no-write authority (proven in workspace-store.test.ts);
    // here we only assert the registry faithfully relays `saved:false`.
  });
});

describe("workspace-registry — load", () => {
  test("happy path: returns the store's snapshot verbatim", () => {
    const fake = fakeStore("persistent", SAMPLE);
    const reg = registryOver(fake.store);
    const result = reg.load();
    expect(result).toEqual({ ok: true, value: { snapshot: SAMPLE } });
  });

  test("first launch / degrade: store returns null → { snapshot: null }, not an error", () => {
    const fake = fakeStore("persistent", null);
    const reg = registryOver(fake.store);
    const result = reg.load();
    expect(result).toEqual({ ok: true, value: { snapshot: null } });
  });

  test("ephemeral: store returns null → { snapshot: null }", () => {
    const fake = fakeStore("ephemeral", null);
    const reg = registryOver(fake.store);
    const result = reg.load();
    expect(result).toEqual({ ok: true, value: { snapshot: null } });
  });
});

describe("workspace-registry — bad_request on malformed save params", () => {
  test("non-object params", () => {
    for (const params of [undefined, null, "x", 42, [1, 2]]) {
      const reg = registryOver(fakeStore("persistent").store);
      const r = reg.save(params);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("bad_request");
    }
  });

  test("wrong version", () => {
    const reg = registryOver(fakeStore("persistent").store);
    const r = reg.save({ ...SAMPLE, version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("bad_request");
      expect(r.detail).toContain("version");
    }
  });

  test("panelSizes not a finite-number array", () => {
    const reg = registryOver(fakeStore("persistent").store);
    for (const panelSizes of ["nope", [20, "eighty"], [20, Number.NaN], [20, Number.POSITIVE_INFINITY]]) {
      const r = reg.save({ ...SAMPLE, panelSizes });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("bad_request");
        expect(r.detail).toContain("panelSizes");
      }
    }
  });

  test("unknown tab kind", () => {
    const reg = registryOver(fakeStore("persistent").store);
    const r = reg.save({ ...SAMPLE, tabs: [{ id: 1, kind: "not-a-kind", title: "x" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("bad_request");
      expect(r.detail).toContain("tabs");
    }
  });

  test("a tab missing required fields", () => {
    const reg = registryOver(fakeStore("persistent").store);
    for (const tabs of [[{ id: "not-a-number", kind: "table", title: "x" }], [{ kind: "table", title: "x" }], [{ id: 1, kind: "table" }]]) {
      const r = reg.save({ ...SAMPLE, tabs });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("bad_request");
    }
  });

  test("dangling activeTabId (not among tab ids)", () => {
    const reg = registryOver(fakeStore("persistent").store);
    const r = reg.save({ ...SAMPLE, activeTabId: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("bad_request");
      expect(r.detail).toContain("activeTabId");
    }
  });

  test("nextId not greater than every tab id", () => {
    const reg = registryOver(fakeStore("persistent").store);
    for (const nextId of [2, 1, 0, -1, Number.NaN]) {
      const r = reg.save({ ...SAMPLE, nextId });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("bad_request");
        expect(r.detail).toContain("nextId");
      }
    }
  });

  test("nothing is written to the store on a bad_request", () => {
    const fake = fakeStore("persistent");
    const reg = registryOver(fake.store);
    reg.save({ ...SAMPLE, activeTabId: 999 });
    expect(fake.saveCalls()).toBe(0);
  });
});

describe("workspace-registry — store write failure maps to internal_error", () => {
  test("a forced write-failed → internal_error, detail is the safe label (not the raw store detail)", () => {
    const fake = fakeStore("persistent");
    fake.forceWriteFailure("ENOENT: /home/dev/.local/share/quick-studio/workspace-state.json");
    const reg = registryOver(fake.store);
    const r = reg.save(SAMPLE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("internal_error");
      expect(r.detail).toBe("write-failed");
      expect(r.detail).not.toContain("/");
      expect(r.detail).not.toContain("ENOENT");
    }
  });
});

describe("workspace-registry — store-open failure mapping", () => {
  test("open failure → internal_error on both load and save, detail is the safe outcome label", () => {
    const reg = createWorkspaceRegistry({
      openStore: (): OpenResult => ({
        outcome: "unavailable",
        detail: "ENOENT: /home/dev/.local/share/quick-studio",
      }),
    });

    const load = reg.load();
    expect(load.ok).toBe(false);
    if (!load.ok) {
      expect(load.code).toBe("internal_error");
      expect(load.detail).toBe("unavailable");
      expect(load.detail).not.toContain("/");
    }

    const save = reg.save(SAMPLE);
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.code).toBe("internal_error");
  });

  test("a store that fails to open is retried on the next call (failure not memoized)", () => {
    let attempts = 0;
    const failingOpen = (): OpenResult => {
      attempts++;
      return { outcome: "unavailable", detail: "app dir unavailable" };
    };
    const reg = createWorkspaceRegistry({ openStore: failingOpen });

    reg.load();
    reg.load();
    expect(attempts).toBe(2);
  });

  test("a successful open is memoized (openStore called once across load + save)", () => {
    let attempts = 0;
    const fake = fakeStore("persistent");
    const reg = createWorkspaceRegistry({
      openStore: (): OpenResult => {
        attempts++;
        return { outcome: "opened", store: fake.store };
      },
    });
    reg.load();
    reg.save(SAMPLE);
    reg.load();
    expect(attempts).toBe(1);
  });
});
