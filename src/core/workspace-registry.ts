/**
 * quick-studio Core — Workspace registry (Story 2.5).
 *
 * The sole Core-side holder of the Workspace-state store for the `workspace.load`/
 * `workspace.save` RPC surface. It CONSUMES the untouched substrate
 * (`workspace-store.ts`) and mirrors `connection-registry.ts`'s lazy-memoized-
 * manager style: the store is opened LAZILY on the first call and memoized on
 * SUCCESS ONLY, so a transient `unavailable` does not permanently poison the
 * surface (the next call retries the open).
 *
 * Validation lives HERE, in one place:
 *  - `save` — full semantic validation of the incoming snapshot (`panelSizes` is
 *    a finite-number array, every `tabs[].kind` is a recognized
 *    {@link WorkspaceTabKind}, `activeTabId` is `null` or one of the tab ids,
 *    `nextId` is greater than every tab id) → `bad_request` naming the offending
 *    field on failure; nothing is written.
 *  - `load` — the store's own `load()` already degrades any malformed/corrupt/
 *    version-mismatched disk content to `null` (see `workspace-store.ts`), so a
 *    registry `load()` failure ONLY happens on a store-open failure.
 * A store-open failure (unresolvable app dir) or a write failure both map to
 * `internal_error`, exactly like `connection-registry`.
 */

import type {
  ErdTabLayout,
  LoadWorkspaceResult,
  SaveWorkspaceResult,
  WorkspaceSnapshot,
  WorkspaceSnapshotTab,
  WorkspaceTabKind,
} from "../shared/contract.ts";
import { WORKSPACE_SNAPSHOT_VERSION, WORKSPACE_TAB_KINDS } from "../shared/contract.ts";
import type { RegistryResult } from "./connection-registry.ts";
import {
  openWorkspaceStore,
  type OpenResult,
  type WorkspaceStore,
  type WorkspaceStoreDeps,
} from "./workspace-store.ts";

// The `workspace.load`/`workspace.save` result shapes have a single source of
// truth in the shared contract (mirroring `WorkspaceTabKind`); re-exported here so
// existing local references keep resolving with no structural-drift risk between
// the wire contract and the registry that produces it.
export type { LoadWorkspaceResult, SaveWorkspaceResult };

/** The live registry handle returned by {@link createWorkspaceRegistry}. */
export type WorkspaceRegistry = {
  /** Read the persisted snapshot (or `null` on first launch / Ephemeral / degrade). */
  load(): RegistryResult<LoadWorkspaceResult>;
  /** Validate + persist a snapshot. Ephemeral mode is a no-op `{ saved: false }`. */
  save(params: unknown): RegistryResult<SaveWorkspaceResult>;
};

/**
 * Dependencies for {@link createWorkspaceRegistry}. Either inject an `openStore`
 * seam directly (tests drive a fixed temp-dir store, or a failing open) OR pass
 * `storeDeps` forwarded to the default `openWorkspaceStore` (e.g. `{ mode }`).
 */
export type WorkspaceRegistryDeps = {
  /** Store-open seam. Defaults to `() => openWorkspaceStore(storeDeps)`. */
  readonly openStore?: () => OpenResult;
  /** Deps for the default store open. Ignored when `openStore` is supplied. */
  readonly storeDeps?: WorkspaceStoreDeps;
};

function badRequest(field: string, reason: string): RegistryResult<never> {
  return { ok: false, code: "bad_request", message: reason, detail: `field=${field}` };
}

/** `panelSizes` must be an array of finite numbers. */
function checkPanelSizes(value: unknown): { ok: true; value: number[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { ok: false, reason: "panelSizes must be an array of finite numbers" };
  }
  return { ok: true, value: value as number[] };
}

/** Type guard mirroring `workspace-store.ts`'s (kept separate: registry owns field-named errors). */
function isTabKind(value: unknown): value is WorkspaceTabKind {
  return typeof value === "string" && (WORKSPACE_TAB_KINDS as readonly string[]).includes(value);
}

/** `tabs` must be an array of `{ id: finite number; kind: WorkspaceTabKind; title: string }`. */
function checkTabs(
  value: unknown,
): { ok: true; value: WorkspaceSnapshotTab[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "tabs must be an array" };
  }
  // Tab ids must be UNIQUE at this trusted save boundary (DW-26): a hand-edited
  // snapshot with two tabs sharing an id would make `closeTab` remove both at once
  // (the reducer filters by id). Reject strictly here — the RESTORE path is
  // deliberately more tolerant (it dedupes) so a bad file still opens; this write
  // boundary owns correctness. The `Set` is populated only AFTER the per-element
  // validation below proves each `id` is already a finite number.
  const seenIds = new Set<number>();
  for (const t of value) {
    if (typeof t !== "object" || t === null) {
      return { ok: false, reason: "each tab must be an object" };
    }
    const tab = t as Record<string, unknown>;
    if (typeof tab.id !== "number" || !Number.isFinite(tab.id)) {
      return { ok: false, reason: "each tab.id must be a finite number" };
    }
    if (!isTabKind(tab.kind)) {
      return { ok: false, reason: `each tab.kind must be one of ${WORKSPACE_TAB_KINDS.join(", ")}` };
    }
    if (typeof tab.title !== "string") {
      return { ok: false, reason: "each tab.title must be a string" };
    }
    // `id` is now proven a finite number — safe to key the uniqueness Set on it.
    if (seenIds.has(tab.id)) {
      return { ok: false, reason: "tab ids must be unique" };
    }
    seenIds.add(tab.id);
  }
  return { ok: true, value: value as WorkspaceSnapshotTab[] };
}

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Optional `erdLayouts` (Story 4.2): a map keyed by stringified tab id, each layout a
 * `positions` object of `{x,y}` FINITE coords and an optional finite `{x,y,zoom}`
 * viewport. An entry with a non-finite coordinate is a `bad_request` (nothing written);
 * an ABSENT field is valid (additive — old callers omit it). Returns a normalized value
 * (or `undefined` when absent) so the saved snapshot only carries the field when present.
 */
function checkErdLayouts(
  value: unknown,
): { ok: true; value: Record<string, ErdTabLayout> | undefined } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "erdLayouts must be an object keyed by tab id" };
  }
  const out: Record<string, ErdTabLayout> = {};
  for (const [tabKey, layout] of Object.entries(value)) {
    if (typeof layout !== "object" || layout === null || Array.isArray(layout)) {
      return { ok: false, reason: "each erd layout must be an object" };
    }
    const l = layout as Record<string, unknown>;
    if (typeof l.positions !== "object" || l.positions === null || Array.isArray(l.positions)) {
      return { ok: false, reason: "each erd layout.positions must be an object" };
    }
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [nodeId, pos] of Object.entries(l.positions)) {
      if (typeof pos !== "object" || pos === null) {
        return { ok: false, reason: "each erd position must have finite numeric x and y" };
      }
      const p = pos as Record<string, unknown>;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) {
        return { ok: false, reason: "each erd position must have finite numeric x and y" };
      }
      positions[nodeId] = { x: p.x, y: p.y };
    }
    const built: { positions: Record<string, { x: number; y: number }>; viewport?: { x: number; y: number; zoom: number } } = {
      positions,
    };
    if (l.viewport !== undefined) {
      if (typeof l.viewport !== "object" || l.viewport === null) {
        return { ok: false, reason: "erd layout.viewport must have finite numeric x, y, zoom" };
      }
      const vp = l.viewport as Record<string, unknown>;
      // `zoom` must be positive — 0/negative restores a degenerate (blank) canvas.
      if (!isFiniteNumber(vp.x) || !isFiniteNumber(vp.y) || !isFiniteNumber(vp.zoom) || vp.zoom <= 0) {
        return { ok: false, reason: "erd layout.viewport must have finite numeric x, y, and positive zoom" };
      }
      built.viewport = { x: vp.x, y: vp.y, zoom: vp.zoom };
    }
    out[tabKey] = built;
  }
  return { ok: true, value: out };
}

/**
 * Full semantic validation of `workspace.save` params, producing a well-formed
 * {@link WorkspaceSnapshot} on success or a field-named `bad_request` on failure.
 * Nothing is written by this function — it is pure.
 */
function validateSnapshotParams(params: unknown): RegistryResult<WorkspaceSnapshot> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return badRequest("params", "workspace.save requires a snapshot object");
  }
  const p = params as Record<string, unknown>;

  if (p.version !== WORKSPACE_SNAPSHOT_VERSION) {
    return badRequest("version", `version must be ${WORKSPACE_SNAPSHOT_VERSION}`);
  }

  const panelSizes = checkPanelSizes(p.panelSizes);
  if (!panelSizes.ok) return badRequest("panelSizes", panelSizes.reason);

  const tabs = checkTabs(p.tabs);
  if (!tabs.ok) return badRequest("tabs", tabs.reason);

  const ids = new Set(tabs.value.map((t) => t.id));
  // Align the validator with `restoreWorkspace` (DW-25): with NO tabs, `activeTabId`
  // must be `null`; with tabs present, it must be one of the tab ids (null-with-tabs
  // is rejected here rather than being silently rewritten to the first tab on restore).
  if (tabs.value.length === 0) {
    if (p.activeTabId !== null) {
      return badRequest("activeTabId", "activeTabId must be null when there are no tabs");
    }
  } else if (!(typeof p.activeTabId === "number" && ids.has(p.activeTabId))) {
    return badRequest("activeTabId", "activeTabId must be one of the tab ids when tabs are present");
  }

  const maxId = tabs.value.reduce((max, t) => Math.max(max, t.id), 0);
  if (typeof p.nextId !== "number" || !Number.isFinite(p.nextId) || p.nextId <= maxId) {
    return badRequest("nextId", "nextId must be a finite number greater than every tab id");
  }

  const erdLayouts = checkErdLayouts(p.erdLayouts);
  if (!erdLayouts.ok) return badRequest("erdLayouts", erdLayouts.reason);

  return {
    ok: true,
    value: {
      version: WORKSPACE_SNAPSHOT_VERSION,
      panelSizes: panelSizes.value,
      tabs: tabs.value,
      activeTabId: (p.activeTabId as number | null) ?? null,
      nextId: p.nextId,
      // Only carry `erdLayouts` when actually present, so a snapshot with no ERD layout
      // stays byte-identical to a pre-4.2 one (no gratuitous empty field on the wire).
      ...(erdLayouts.value !== undefined ? { erdLayouts: erdLayouts.value } : {}),
    },
  };
}

/**
 * Build the Workspace registry. The store is NOT opened here — it opens lazily on
 * the first load/save and is memoized only on success (failures stay retryable).
 */
export function createWorkspaceRegistry(deps: WorkspaceRegistryDeps = {}): WorkspaceRegistry {
  const openStore = deps.openStore ?? (() => openWorkspaceStore(deps.storeDeps));

  // Memoize SUCCESS only — a transient open failure must not poison the surface.
  let cached: WorkspaceStore | null = null;

  /** Obtain (open once, then reuse) the store, or map an open failure to internal_error. */
  function obtain(): RegistryResult<WorkspaceStore> {
    if (cached !== null) return { ok: true, value: cached };
    const opened = openStore();
    if (opened.outcome === "opened") {
      cached = opened.store;
      return { ok: true, value: cached };
    }
    // `detail` is the safe outcome LABEL — never `opened.detail`, whose raw
    // `err.message` text may embed absolute app-dir paths / errno strings (same
    // convention as `connection-registry.ts`: never echo raw exception text).
    return {
      ok: false,
      code: "internal_error",
      message: "workspace store is unavailable",
      detail: opened.outcome,
    };
  }

  return {
    load() {
      const store = obtain();
      if (!store.ok) return store;
      // `store.load()` is total — absent/corrupt/version-mismatched disk content
      // already degrades to `null` inside the store; nothing further to validate.
      return { ok: true, value: { snapshot: store.value.load() } };
    },

    save(params) {
      const validated = validateSnapshotParams(params);
      if (!validated.ok) return validated;

      const store = obtain();
      if (!store.ok) return store;

      const mutation = store.value.save(validated.value);
      if (mutation.outcome === "write-failed") {
        return {
          ok: false,
          code: "internal_error",
          message: "failed to persist workspace state",
          detail: "write-failed",
        };
      }
      return { ok: true, value: { saved: mutation.saved } };
    },
  };
}
