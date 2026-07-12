/**
 * quick-studio Core — Live Report registry (Ring 1, in-memory, session-only) — Story 6.4.
 *
 * Holds published {@link LiveReportDoc}s (layout + SQL only — never data, never a credential)
 * so the Core can serve them same-origin at `/live/<id>`. This is transient SERVING state, not
 * a persisted report: nothing is written to disk (AR-8-safe, Persistent/Ephemeral-agnostic),
 * and the whole registry dies with the process.
 *
 * `publish` validates the doc via {@link isLiveReportDoc} (an invalid doc is a typed error, so
 * a malformed layout can never be stored), stores it under an OPAQUE unguessable id (crypto
 * random hex, mirroring `mintSessionToken`), and returns the id. `get` returns the doc or
 * `null`. The registry is bounded (evicts the oldest published doc) so a long-running session
 * cannot grow it without limit.
 */

import { isLiveReportDoc, type LiveReportDoc } from "../shared/live-report.ts";

/** Number of random bytes in an opaque live-report id (128 bits — unguessable, like the token). */
const ID_BYTES = 16;

/** Default upper bound on concurrently-held live reports (oldest evicted past this). */
export const DEFAULT_MAX_LIVE_REPORTS = 64;

/** Thrown by `publish` when the doc fails the {@link isLiveReportDoc} guard. */
export class InvalidLiveReportError extends Error {
  constructor(message = "invalid live report document") {
    super(message);
    this.name = "InvalidLiveReportError";
  }
}

/** The registry surface threaded into the RPC dispatch + the `/live/<id>` serve path. */
export type LiveReportRegistry = {
  /** Validate + store a doc under a fresh opaque id; returns the id. Throws on an invalid doc. */
  readonly publish: (doc: LiveReportDoc) => string;
  /** Look up a published doc by id, or `null` when unknown/evicted. */
  readonly get: (id: string) => LiveReportDoc | null;
};

/** Mint a fresh opaque, unguessable live-report id: 128 bits of CSPRNG output as lowercase hex. */
function mintId(): string {
  const bytes = new Uint8Array(ID_BYTES);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Construct an in-memory, session-only Live Report registry. `maxEntries` bounds the number of
 * concurrently-held docs; when a `publish` would exceed it, the OLDEST published doc is evicted
 * (a `Map` preserves insertion order, so the first key is the oldest). Nothing touches disk.
 */
export function createLiveReportRegistry(maxEntries = DEFAULT_MAX_LIVE_REPORTS): LiveReportRegistry {
  const store = new Map<string, LiveReportDoc>();
  return {
    publish: (doc) => {
      if (!isLiveReportDoc(doc)) {
        throw new InvalidLiveReportError();
      }
      // Evict the oldest until there is room for the new entry.
      while (store.size >= maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
      const id = mintId();
      store.set(id, doc);
      return id;
    },
    get: (id) => store.get(id) ?? null,
  };
}
