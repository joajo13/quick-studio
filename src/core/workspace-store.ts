/**
 * quick-studio Core — mode-aware plain-JSON Workspace-state store (Story 2.5).
 *
 * This is the restore half of FR-24 (AR-9): it saves Panel sizes + open Tabs so a
 * developer's Workspace looks the same on the next launch, in Persistent mode
 * only. It CONSUMES the same substrate the credential store (Story 2.2) built —
 * `ensureAppDir` for the OS-convention home and `resolveRunMode` for the
 * Persistent/Ephemeral gate — but, unlike the credential store, the payload here
 * is non-secret (Panel sizes + Tab `kind`/`title`/ids, never a url or row data),
 * so there is no crypto, no keychain, and no passphrase: this is deliberately
 * PLAIN JSON at rest.
 *
 * Guarantees, mirroring `credential-store.ts`'s shape exactly:
 *  - Persistent mode: `save` atomically writes `workspace-state.json` under the
 *    app dir via a sibling temp-write-then-`rename` (never a truncated file on a
 *    crash mid-write).
 *  - Ephemeral mode: `save` is a no-op that touches no disk (`filePath === null`,
 *    mirroring the credential store's `key === null` ephemeral gate) and `load`
 *    never reads disk either.
 *  - `load` is TOTAL and never throws: an absent file, an I/O error, unparseable
 *    JSON, a `version` mismatch, or any structurally malformed content all
 *    degrade to `null` (a fresh Workspace) — the same malformed-record degrade
 *    posture as `connection-registry`'s `list`. Deeper SEMANTIC checks (does
 *    `activeTabId` point at a real tab? is `nextId` past every tab id?) are
 *    deliberately NOT enforced here — `workspace-state.ts`'s `restoreWorkspace`
 *    recomputes those safely on the UI side, so a shape-valid-but-semantically-
 *    stale snapshot still restores rather than degrading unnecessarily.
 *  - `openWorkspaceStore` is total: an unresolvable/uncreatable app directory
 *    (e.g. `ensureAppDir()` throwing on a permission error) is a typed
 *    `unavailable` — never a throw that could crash boot.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  WORKSPACE_SNAPSHOT_VERSION,
  WORKSPACE_TAB_KINDS,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotTab,
  type WorkspaceTabKind,
} from "../shared/contract.ts";
import { ensureAppDir } from "./app-dir.ts";
import { resolveRunMode, type RunMode } from "./run-mode.ts";

/** Plain-JSON store filename under the app dir. */
export const WORKSPACE_STORE_FILE_NAME = "workspace-state.json";

/** Result of {@link WorkspaceStore.save}. */
export type SaveResult =
  | { readonly outcome: "ok"; readonly saved: boolean }
  | { readonly outcome: "write-failed"; readonly detail: string };

/** The live store handle returned by a successful {@link openWorkspaceStore}. */
export type WorkspaceStore = {
  /** The mode this store opened in. */
  readonly mode: RunMode;
  /**
   * Read the persisted snapshot. Total: absent file / I/O error / corrupt JSON /
   * version mismatch / malformed shape all degrade to `null`. Ephemeral mode
   * never reads disk and always returns `null`.
   */
  readonly load: () => WorkspaceSnapshot | null;
  /**
   * Persist `snapshot`. Persistent mode writes atomically and returns
   * `{ outcome: "ok", saved: true }`; Ephemeral mode no-ops and returns
   * `{ outcome: "ok", saved: false }` without touching disk. A write failure is
   * the distinct `write-failed` outcome (never a throw).
   */
  readonly save: (snapshot: WorkspaceSnapshot) => SaveResult;
};

/** Outcome of {@link openWorkspaceStore}. */
export type OpenResult =
  | { readonly outcome: "opened"; readonly store: WorkspaceStore }
  /** The app-data directory could not be resolved/created (see `ensureAppDir`). */
  | { readonly outcome: "unavailable"; readonly detail: string };

/**
 * Injectable dependencies so the store is unit-testable without touching the
 * user's real app dir. Every field defaults to the real implementation.
 */
export type WorkspaceStoreDeps = {
  /** Persistent/Ephemeral gate. Defaults to `resolveRunMode(process.env)`. */
  readonly mode?: RunMode;
  /** App-data directory (persistent mode only). Defaults to `ensureAppDir()`. */
  readonly dir?: string;
};

/** Type guard: `value` is a recognized {@link WorkspaceTabKind}. */
function isTabKind(value: unknown): value is WorkspaceTabKind {
  return (
    typeof value === "string" &&
    (WORKSPACE_TAB_KINDS as readonly string[]).includes(value)
  );
}

/** A finite number (rejects NaN/±Infinity and non-numbers). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Type guard: `value` is a well-formed optional `erdLayouts` map (Story 4.2) — a plain
 * object of per-tab layouts, each with a `positions` object of `{x,y}` FINITE coords and
 * an optional `viewport` of finite `{x,y,zoom}`. ABSENT `erdLayouts` is handled by the
 * caller (old v1 files validate without it); this only shape-checks a PRESENT value.
 */
function isErdLayouts(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const layout of Object.values(value as Record<string, unknown>)) {
    if (typeof layout !== "object" || layout === null || Array.isArray(layout)) return false;
    const l = layout as Record<string, unknown>;
    if (typeof l.positions !== "object" || l.positions === null || Array.isArray(l.positions)) {
      return false;
    }
    for (const pos of Object.values(l.positions as Record<string, unknown>)) {
      if (typeof pos !== "object" || pos === null) return false;
      const p = pos as Record<string, unknown>;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return false;
    }
    if (l.viewport !== undefined) {
      if (typeof l.viewport !== "object" || l.viewport === null) return false;
      const vp = l.viewport as Record<string, unknown>;
      // `zoom` must be a positive scale — 0 or negative yields a degenerate transform
      // (blank canvas) on restore, and fitView is disabled whenever a viewport exists.
      if (!isFiniteNumber(vp.x) || !isFiniteNumber(vp.y) || !isFiniteNumber(vp.zoom) || vp.zoom <= 0) {
        return false;
      }
    }
  }
  return true;
}

/** Type guard: `value` is a well-formed {@link WorkspaceSnapshotTab}. */
function isSnapshotTab(value: unknown): value is WorkspaceSnapshotTab {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "number" &&
    Number.isFinite(v.id) &&
    isTabKind(v.kind) &&
    typeof v.title === "string"
  );
}

/**
 * Type guard: `value` is a well-formed, current-version {@link WorkspaceSnapshot}.
 * SHAPE-level only (types + the version gate) — semantic cross-field invariants
 * (dangling `activeTabId`, a stale `nextId`) are the UI's `restoreWorkspace`
 * concern, not this total disk-read boundary's.
 */
function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== WORKSPACE_SNAPSHOT_VERSION) return false;
  if (
    !Array.isArray(v.panelSizes) ||
    !v.panelSizes.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return false;
  }
  if (!Array.isArray(v.tabs) || !v.tabs.every(isSnapshotTab)) return false;
  if (v.activeTabId !== null && !(typeof v.activeTabId === "number" && Number.isFinite(v.activeTabId))) {
    return false;
  }
  if (typeof v.nextId !== "number" || !Number.isFinite(v.nextId)) return false;
  // `erdLayouts` is ADDITIVE + optional (Story 4.2): an old v1 file with no such field
  // still validates (falls back to dagre); a PRESENT value is shape-checked here.
  if (v.erdLayouts !== undefined && !isErdLayouts(v.erdLayouts)) return false;
  // `lastProvider` is ADDITIVE + optional (Story 8.5): a FIELD-DROP field, deliberately NOT
  // gated here. It is a single lightweight enum default hint — an unrecognized value (a future
  // provider kind on downgrade, or a hand-edit) must never discard the whole workspace, so the
  // sanitizing lives UI-side in `restoreLastProvider` (unknown → null). Rejecting the snapshot
  // over one bad hint would nuke every tab/panel/ERD layout, which is exactly what we avoid.
  return true;
}

/**
 * Construct the live store. `filePath === null` means Ephemeral (or otherwise
 * disk-less) — `load`/`save` never touch the filesystem. Not exported — the only
 * way to a store is `openWorkspaceStore`.
 */
function buildStore(mode: RunMode, filePath: string | null): WorkspaceStore {
  return {
    mode,
    load(): WorkspaceSnapshot | null {
      if (filePath === null) return null;
      if (!existsSync(filePath)) return null;

      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch {
        // Any read failure (permission, TOCTOU vanish, EISDIR, …) degrades to a
        // fresh Workspace rather than crashing boot — non-destructive: nothing
        // here overwrites the file.
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null; // corrupt JSON
      }

      if (!isWorkspaceSnapshot(parsed)) return null; // malformed shape or version mismatch
      return parsed;
    },

    save(snapshot: WorkspaceSnapshot): SaveResult {
      if (filePath === null) {
        // Ephemeral (or disk-less) no-op — NOTHING is written.
        return { outcome: "ok", saved: false };
      }
      const tmpPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmpPath, JSON.stringify(snapshot), {
          encoding: "utf8",
          mode: 0o600,
        });
        // `rename` moves the 0o600 temp inode over the target atomically, so a
        // crash mid-write can never leave a truncated live file.
        renameSync(tmpPath, filePath);
        return { outcome: "ok", saved: true };
      } catch (err) {
        try {
          rmSync(tmpPath, { force: true });
        } catch {
          /* ignore cleanup failure */
        }
        return {
          outcome: "write-failed",
          detail: err instanceof Error ? err.message : "workspace store write failed",
        };
      }
    },
  };
}

/**
 * Open the Workspace store. Total — returns a typed {@link OpenResult}; never
 * throws. In Ephemeral mode nothing is read or written and the app dir is never
 * even resolved.
 */
export function openWorkspaceStore(deps: WorkspaceStoreDeps = {}): OpenResult {
  const mode = deps.mode ?? resolveRunMode(process.env);

  if (mode === "ephemeral") {
    return { outcome: "opened", store: buildStore(mode, null) };
  }

  // Resolving/creating the app dir (mkdir) can throw on EACCES/EROFS/read-only
  // home, or when no absolute home can be resolved (see `ensureAppDir`). Keep the
  // boundary total by surfacing a typed `unavailable` instead of the throw.
  let dir: string;
  try {
    dir = deps.dir ?? ensureAppDir();
  } catch (err) {
    return {
      outcome: "unavailable",
      detail: err instanceof Error ? err.message : "app-data directory unavailable",
    };
  }

  const filePath = join(dir, WORKSPACE_STORE_FILE_NAME);
  return { outcome: "opened", store: buildStore(mode, filePath) };
}
