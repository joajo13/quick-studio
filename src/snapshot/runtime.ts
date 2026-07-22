/**
 * quick-studio — Snapshot offline runtime (browser, Story 6.3).
 *
 * The renderer bundled INTO the exported Snapshot `.html`. On reopen it reads the inlined
 * `#__qs_snapshot` JSON, validates it with {@link isSnapshotDoc}, and mounts each block into
 * `#__qs_report` — with NO quick-studio, NO database, and NO network (CSP `connect-src
 * 'none'`). It mirrors the Epic 5 sandbox stack: prose via `renderMarkdownToHtml`, charts via
 * Observable Plot from `buildPlotOptions` (reused from `src/sandbox/render.ts`) — no third
 * renderer.
 *
 * Two resilience contracts (a Snapshot outlives the app that made it and may be corrupted,
 * hand-edited, or from a future schema):
 *  - a missing / unparseable / failed-guard payload renders a visible "cannot open snapshot"
 *    fallback — NEVER a blank page;
 *  - each block render is isolated in its own try/catch, so one throwing block renders an
 *    inline error note and the remaining blocks STILL render.
 *
 * House testing style: all logic is pure/injectable ({@link renderTableToHtml},
 * {@link renderBlock}, {@link mountSnapshot} over an injected {@link MountHost}); the DOM is
 * touched only in the thin {@link bootstrap} seam, guarded by `typeof document`.
 */

import * as Plot from "@observablehq/plot";
import type { PlotOptions } from "@observablehq/plot";
import { isSnapshotDoc, normalizeSnapshotDoc, type SnapshotBlock, type SnapshotDoc } from "../shared/snapshot.ts";
import { buildPlotOptions, renderMarkdownToHtml } from "../sandbox/render.ts";
// The pure table renderer now lives in `shared/frozen-table` so the offline Snapshot and the
// live Report draw tables through the SAME code (no third fork). Re-exported here so this
// module's existing consumers/tests keep importing the names from `./runtime`.
import {
  escapeHtml,
  formatCell,
  NULL_PLACEHOLDER,
  renderTableToHtml,
  truncationNote,
} from "../shared/frozen-table.ts";

export { escapeHtml, formatCell, NULL_PLACEHOLDER, renderTableToHtml, truncationNote };

/** The visible message shown for a corrupted / hand-edited / schema-drifted Snapshot. */
export const FALLBACK_HTML =
  '<p class="qs-fallback">cannot open snapshot — the embedded data is missing, corrupted, or from an unsupported version.</p>';

/** The visible affordance for a report exported with zero blocks — never a blank body. */
export const EMPTY_REPORT_HTML = `<p class="qs-empty">${escapeHtml("This report has no blocks.")}</p>`;

/**
 * The normalized render instruction for one block. Prose/table/empty resolve to an HTML
 * string; a chart resolves to Observable Plot options (mounted as a DOM node by the host).
 * `buildPlotOptions` is pure (no DOM), so the whole dispatch is testable without a DOM.
 */
export type BlockRender =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "chart"; readonly options: PlotOptions; readonly truncated: boolean };

/** Pure per-block dispatch. Total — an unknown kind is an exhaustiveness error. */
export function renderBlock(block: SnapshotBlock): BlockRender {
  switch (block.kind) {
    case "prose":
      return { kind: "html", html: `<div class="qs-prose">${renderMarkdownToHtml(block.markdown)}</div>` };
    case "table": {
      const table = renderTableToHtml(block.data);
      return { kind: "html", html: block.truncated ? `${table}${truncationNote()}` : table };
    }
    case "chart":
      return { kind: "chart", options: buildPlotOptions(block.chart, block.data), truncated: block.truncated };
    case "empty":
      return { kind: "html", html: `<p class="qs-empty">${escapeHtml(block.note)}</p>` };
    default: {
      const _exhaustive: never = block;
      throw new Error(`unknown snapshot block kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * The minimal mount surface {@link mountSnapshot} needs, injected so the mount order + the
 * per-block isolation are testable with a fake host (no real DOM). The real {@link bootstrap}
 * wires these to `#__qs_report`; a test wires them to spies (incl. a THROWING `appendChart`).
 */
export type MountHost = {
  /** Append a block of trusted, already-escaped HTML. */
  readonly appendHtml: (html: string) => void;
  /** Build + append the Observable Plot node from `options` (MAY throw on a bad channel). */
  readonly appendChart: (options: PlotOptions) => void;
  /** Append a small inline error note when a block failed to render (never data). */
  readonly appendError: (message: string) => void;
};

/**
 * Mount a validated {@link SnapshotBlock} list into `host`, isolating EACH block in its own
 * try/catch: one throwing block yields an inline error note and the remaining blocks still
 * render (a single bad block never aborts the whole document). A truncated chart also emits
 * the visible {@link truncationNote}. Pure over its injected host.
 */
export function renderDocInto(blocks: ReadonlyArray<SnapshotBlock>, host: MountHost): void {
  if (blocks.length === 0) {
    // An empty report renders a visible "no blocks" affordance, never a blank body.
    host.appendHtml(EMPTY_REPORT_HTML);
    return;
  }
  for (const block of blocks) {
    try {
      const render = renderBlock(block);
      if (render.kind === "html") {
        host.appendHtml(render.html);
      } else {
        if (render.truncated) host.appendHtml(truncationNote());
        host.appendChart(render.options);
      }
    } catch (err) {
      host.appendError(err instanceof Error ? err.message : "block failed to render");
    }
  }
}

/**
 * Validate + mount the embedded payload text. A `null` / unparseable / failed-guard payload
 * renders the visible {@link FALLBACK_HTML} ("cannot open snapshot") — never a blank page.
 * Pure over its injected host; the sole trust gate before rendering is {@link isSnapshotDoc}.
 */
export function mountSnapshot(rawJson: string | null, host: MountHost): void {
  let parsed: unknown = null;
  if (rawJson !== null) {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = null;
    }
  }
  if (!isSnapshotDoc(parsed)) {
    host.appendHtml(FALLBACK_HTML);
    return;
  }
  // Render the CANONICALIZED payload (DW-6): `isSnapshotDoc` proved the doc valid but its
  // guard discards `decode`'s normalized result, so draw `normalizeSnapshotDoc(parsed)` — an
  // over-precise date cell is floored to milliseconds here, not shown verbatim as microseconds.
  // Defense in depth: the guard already decoded every block, and mountSnapshot only ever feeds
  // inert `JSON.parse` output, so this re-`decode` cannot throw on the real path — but keep the
  // "never a blank page" promise (and match `guest.handleMessage`'s guarded re-decode) even if a
  // future caller hands in a doc whose cells could re-read differently.
  let normalized: SnapshotDoc;
  try {
    normalized = normalizeSnapshotDoc(parsed);
  } catch {
    host.appendHtml(FALLBACK_HTML);
    return;
  }
  renderDocInto(normalized.blocks, host);
}

/**
 * Wire the pure mount to a real document: read `#__qs_snapshot`, mount into `#__qs_report`.
 * The only DOM-touching seam; exported for symmetry but never invoked under `bun test`.
 */
export function bootstrap(doc: Document): void {
  const mount = doc.getElementById("__qs_report");
  if (mount === null) return;
  const payloadEl = doc.getElementById("__qs_snapshot");
  const host: MountHost = {
    appendHtml: (html) => {
      const wrapper = doc.createElement("div");
      // Already-escaped/sanitized HTML (per-cell escape + micromark raw-HTML-disabled); the
      // document CSP `connect-src 'none'` still blocks any egress if rendering misbehaves.
      wrapper.innerHTML = html;
      mount.appendChild(wrapper);
    },
    appendChart: (options) => {
      mount.appendChild(Plot.plot(options) as unknown as Node);
    },
    appendError: (message) => {
      const note = doc.createElement("p");
      note.className = "qs-block-error";
      note.textContent = `block failed to render: ${message}`;
      mount.appendChild(note);
    },
  };
  mountSnapshot(payloadEl?.textContent ?? null, host);
}

// Browser-only seam: run the bootstrap when a real DOM is present (inside the reopened
// Snapshot file). Under `bun test` `document` is undefined, so importing this module for the
// pure unit tests never touches the DOM.
if (typeof document !== "undefined") {
  bootstrap(document);
}
