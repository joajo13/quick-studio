/**
 * quick-studio UI (Ring 2) — connections view-model (pure, dependency-free).
 *
 * The manage-connections list + form logic, kept OUT of React so it is unit-testable
 * with no DOM and no RPC harness (per the story: keep UI logic in pure modules and
 * test those). It holds only credential-free {@link ConnectionSummary} values — the
 * url a user types lives transiently in a {@link Draft} and is never retained here.
 *
 * Everything is pure and total: the reducers return new state; `validateDraft` is a
 * total classifier. No I/O, no React, no `window`.
 */

import type { ConnectionSummary, EditConnectionParams } from "../../shared/contract.ts";

/** The list state the Settings panel renders. Immutable — reducers return new values. */
export type ConnectionsState = {
  readonly connections: ReadonlyArray<ConnectionSummary>;
};

/** An empty list — the initial state before `connections.list` resolves. */
export function emptyConnections(): ConnectionsState {
  return { connections: [] };
}

/**
 * A transient form draft. `url` carries credentials while typing and is sent to Core
 * on submit only; the model never stores it beyond the draft. For an edit, an empty
 * `url` means "rename only — keep the stored url" (the UI never held it).
 */
export type Draft = {
  readonly name: string;
  readonly url: string;
  /**
   * The optional pinned introspection scope (Story 10.2). Free text — a schema name
   * is an opaque server-side identifier, so it has no shape validation here (or in
   * Core). Blank means unpinned on an add; on an edit, blanking a PRE-FILLED value
   * clears the pin — unlike the url, this field IS seeded from the summary, so emptying
   * it is deliberate. Which keys a save actually patches lives in
   * {@link editConnectionParams}.
   */
  readonly schema: string;
};

/** An empty draft (all fields blank). */
export function emptyDraft(): Draft {
  return { name: "", url: "", schema: "" };
}

/** Which flow a draft is validated for: an add requires a url; an edit may omit it. */
export type DraftKind = "add" | "edit";

/** The outcome of {@link validateDraft}: ok, or the first offending field + message. */
export type DraftValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly field: "name" | "url"; readonly message: string };

/**
 * A url shape check mirroring the Core registry's `checkUrl`: it must parse AND have
 * a host. Returns a terse lowercase reason, or `null` when the url is well-shaped.
 * Shape only — scheme is NOT judged here (scheme belongs to the connect flow).
 */
function urlShapeError(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "url not parseable";
  }
  // Reject a hostless url (e.g. `foo:bar`, `mailto:x`) so the UI pre-validates
  // consistently with Core, whose `host`/`engine` derivation needs a real host.
  if (parsed.host.length === 0) {
    return "url has no host";
  }
  return null;
}

/**
 * Validate a draft. name is always required (non-empty trimmed). For an `add` the
 * url is required and must be well-shaped; for an `edit` the url is optional (blank ⇒
 * rename-only) but, when present, must be well-shaped. Terse lowercase messages.
 */
export function validateDraft(draft: Draft, kind: DraftKind): DraftValidation {
  if (draft.name.trim().length === 0) {
    return { ok: false, field: "name", message: "name required" };
  }
  const url = draft.url.trim();
  if (kind === "add") {
    if (url.length === 0) {
      return { ok: false, field: "url", message: "url required" };
    }
    const shapeError = urlShapeError(url);
    if (shapeError !== null) {
      return { ok: false, field: "url", message: shapeError };
    }
  } else if (url.length > 0) {
    const shapeError = urlShapeError(url);
    if (shapeError !== null) {
      return { ok: false, field: "url", message: shapeError };
    }
  }
  return { ok: true };
}

/**
 * Build the `connections.edit` patch from a submitted {@link Draft} (Story 10.2).
 * Both optional fields are OMITTED unless they carry intent, because `edit` is a
 * partial patch and an absent key means "keep":
 *
 * - `url` — omitted when blank. The UI never held the stored (credential-bearing) url,
 *   so a blank input is "keep the stored one", never "clear it".
 * - `schema` — omitted unless it DIFFERS from the pin the row was rendered from
 *   (`storedSchema`). The field IS pre-filled from {@link ConnectionSummary}, so a
 *   changed value is deliberate: blanking a pre-filled pin sends `""` (Core's clear
 *   signal, R1), setting/changing sends the new value, and an untouched field — pinned
 *   or not — sends nothing. Sending it unconditionally would let a draft snapshotted
 *   before another window re-pinned the connection silently overwrite that newer pin:
 *   the panel lists once on mount, so `storedSchema` is exactly the value the field was
 *   seeded from, and an untouched field therefore compares equal and stays out of the
 *   patch. (This does NOT reach the registry's empty-patch fast path — `name` is always
 *   sent, so a save always writes; the win is confined to not clobbering the pin.)
 *
 * `name` is always sent (trimmed) — `validateDraft` guarantees it is non-empty.
 * Pure and total, so both patch rules are unit-testable with no DOM and no RPC.
 */
export function editConnectionParams(
  id: string,
  draft: Draft,
  storedSchema: string | undefined,
): EditConnectionParams {
  const url = draft.url.trim();
  const schema = draft.schema.trim();
  return {
    id,
    name: draft.name.trim(),
    ...(url.length > 0 ? { url } : {}),
    ...(schema !== (storedSchema ?? "") ? { schema } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Reducers — load / add / edit / remove, all pure & total
 * ------------------------------------------------------------------ */

/** Replace the whole list (from a `connections.list` reply). */
export function loadConnections(
  _state: ConnectionsState,
  connections: ReadonlyArray<ConnectionSummary>,
): ConnectionsState {
  return { connections: [...connections] };
}

/** Append a newly-added summary (from a `connections.add` reply). */
export function applyAdded(
  state: ConnectionsState,
  added: ConnectionSummary,
): ConnectionsState {
  return { connections: [...state.connections, added] };
}

/**
 * Replace a summary in place by id (from a `connections.edit` reply), preserving
 * order. An id not present is a no-op (returns the same list content).
 */
export function applyEdited(
  state: ConnectionsState,
  edited: ConnectionSummary,
): ConnectionsState {
  return {
    connections: state.connections.map((c) => (c.id === edited.id ? edited : c)),
  };
}

/** Drop a summary by id (from a successful `connections.remove`). */
export function applyRemoved(
  state: ConnectionsState,
  id: string,
): ConnectionsState {
  return { connections: state.connections.filter((c) => c.id !== id) };
}
