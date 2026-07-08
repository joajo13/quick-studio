/**
 * Covers the workspace-store I/O matrix (Story 2.5, FR-24 restore half, AR-9):
 * persistent roundtrip survival, atomic write leaves no `.tmp` residue, ephemeral
 * writes nothing (file never created, load never reads disk), absent file → null,
 * corrupt JSON → null, version-mismatch → null, malformed shape → null, and a
 * forced write failure. Self-cleaning per the project's temp-dir convention.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSnapshot } from "../shared/contract.ts";
import {
  openWorkspaceStore,
  WORKSPACE_STORE_FILE_NAME,
} from "./workspace-store.ts";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = join(tmpdir(), `qs-workspace-store-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

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

describe("workspace-store — persistent behaviour", () => {
  test("relaunch survival: save, reopen fresh instance over same dir → round-trips the snapshot", () => {
    const dir = makeTempDir();
    const open1 = openWorkspaceStore({ mode: "persistent", dir });
    expect(open1.outcome).toBe("opened");
    if (open1.outcome !== "opened") return;

    const saved = open1.store.save(SAMPLE);
    expect(saved).toEqual({ outcome: "ok", saved: true });

    // Fresh instance = simulated relaunch.
    const open2 = openWorkspaceStore({ mode: "persistent", dir });
    expect(open2.outcome).toBe("opened");
    if (open2.outcome !== "opened") return;
    expect(open2.store.load()).toEqual(SAMPLE);
  });

  test("atomic write leaves no .tmp residue", () => {
    const dir = makeTempDir();
    const open = openWorkspaceStore({ mode: "persistent", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");
    open.store.save(SAMPLE);

    expect(existsSync(join(dir, WORKSPACE_STORE_FILE_NAME))).toBe(true);
    const residue = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(residue).toEqual([]);
  });

  test("first launch: no store file yet → load returns null, no file created by load itself", () => {
    const dir = makeTempDir();
    const open = openWorkspaceStore({ mode: "persistent", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(open.store.load()).toBeNull();
    expect(existsSync(join(dir, WORKSPACE_STORE_FILE_NAME))).toBe(false);
  });

  test("upsert: saving twice overwrites, second load reflects only the latest snapshot", () => {
    const dir = makeTempDir();
    const open = openWorkspaceStore({ mode: "persistent", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");
    open.store.save(SAMPLE);
    const second: WorkspaceSnapshot = { ...SAMPLE, panelSizes: [30, 70], nextId: 4 };
    open.store.save(second);
    expect(open.store.load()).toEqual(second);
  });

  test("forced write failure (nonexistent dir) → write-failed, nothing left on disk", () => {
    const dir = join(makeTempDir(), "missing-subdir");
    const open = openWorkspaceStore({ mode: "persistent", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");

    const result = open.store.save(SAMPLE);
    expect(result.outcome).toBe("write-failed");
    expect(existsSync(join(dir, WORKSPACE_STORE_FILE_NAME))).toBe(false);
  });
});

describe("workspace-store — ephemeral mode writes nothing", () => {
  test("save is a no-op (saved:false) and creates no file", () => {
    const dir = makeTempDir();
    const open = openWorkspaceStore({ mode: "ephemeral", dir });
    expect(open.outcome).toBe("opened");
    if (open.outcome !== "opened") return;
    expect(open.store.mode).toBe("ephemeral");

    const result = open.store.save(SAMPLE);
    expect(result).toEqual({ outcome: "ok", saved: false });
    expect(existsSync(join(dir, WORKSPACE_STORE_FILE_NAME))).toBe(false);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("load never reads disk — returns null even when a file happens to exist at that path", () => {
    const dir = makeTempDir();
    // Seed a file at the path a persistent store WOULD use, to prove ephemeral
    // load doesn't even look.
    writeFileSync(join(dir, WORKSPACE_STORE_FILE_NAME), JSON.stringify(SAMPLE));

    const open = openWorkspaceStore({ mode: "ephemeral", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(open.store.load()).toBeNull();
  });
});

describe("workspace-store — degrade to null on malformed disk content, never a throw", () => {
  test("corrupt (unparseable) JSON → null", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, WORKSPACE_STORE_FILE_NAME), "not json at all");
    const open = openWorkspaceStore({ mode: "persistent", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(open.store.load()).toBeNull();
  });

  test("version mismatch → null", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, WORKSPACE_STORE_FILE_NAME), JSON.stringify({ ...SAMPLE, version: 2 }));
    const open = openWorkspaceStore({ mode: "persistent", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(open.store.load()).toBeNull();
  });

  test("valid JSON that is not an object (null/array/number/string) → null, never throws", () => {
    for (const literal of ["null", "[]", "42", '"a string"']) {
      const dir = makeTempDir();
      writeFileSync(join(dir, WORKSPACE_STORE_FILE_NAME), literal);
      const open = openWorkspaceStore({ mode: "persistent", dir });
      if (open.outcome !== "opened") throw new Error("expected opened");
      expect(open.store.load()).toBeNull();
    }
  });

  test("malformed shape: non-array panelSizes → null", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, WORKSPACE_STORE_FILE_NAME),
      JSON.stringify({ ...SAMPLE, panelSizes: "not-an-array" }),
    );
    const open = openWorkspaceStore({ mode: "persistent", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(open.store.load()).toBeNull();
  });

  test("malformed shape: unknown tab kind → null", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, WORKSPACE_STORE_FILE_NAME),
      JSON.stringify({ ...SAMPLE, tabs: [{ id: 1, kind: "not-a-kind", title: "x" }] }),
    );
    const open = openWorkspaceStore({ mode: "persistent", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(open.store.load()).toBeNull();
  });

  test("malformed shape: non-finite panelSizes entry (NaN via JSON round-trip) → null", () => {
    const dir = makeTempDir();
    // JSON has no NaN literal; simulate a malformed number field a hand-edited
    // file could carry via a string masquerading as a size.
    writeFileSync(
      join(dir, WORKSPACE_STORE_FILE_NAME),
      JSON.stringify({ ...SAMPLE, panelSizes: [20, "eighty"] }),
    );
    const open = openWorkspaceStore({ mode: "persistent", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(open.store.load()).toBeNull();
  });

  test("I/O read error (store path is a directory) → null, not a throw", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, WORKSPACE_STORE_FILE_NAME));
    const open = openWorkspaceStore({ mode: "persistent", dir });
    if (open.outcome !== "opened") throw new Error("expected opened");
    expect(open.store.load()).toBeNull();
  });
});
