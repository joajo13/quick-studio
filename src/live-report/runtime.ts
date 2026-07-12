/**
 * quick-studio — Live Report browser runtime (Story 6.4).
 *
 * The renderer bundled INTO an exported Live Report `.html`. Unlike the offline Snapshot
 * runtime, a Live Report re-queries its target ON VIEW through a running quick-studio: it
 * reads the inlined token-free `#__qs_livereport` layout+SQL doc, and — ONLY when the Core
 * served the page (so `window.__QS_TOKEN__` is present) — offers a connection picker and
 * re-queries each query block via the same-origin `POST /rpc` `execute` (`connect-src 'self'`).
 *
 * Ring discipline (sacred): this module imports ONLY `shared/` + `sandbox/render` + the render
 * libs (`@observablehq/plot`) + a tiny INLINE same-origin fetch ({@link makeRpc}) — never the
 * Ring-2 `rpc/client`, never Recharts. It also must NOT import `src/snapshot/runtime.ts` (that
 * module has a top-level `bootstrap(document)` side effect) — the shared table helpers live in
 * `shared/frozen-table` for exactly that reason.
 *
 * Resilience contracts (a Live Report may be opened bare, against a stopped Core, or against a
 * target that errors on one block):
 *  - no token → a visible "needs a running quick-studio" state, and NO `/rpc` fetch is attempted;
 *  - a missing / unparseable / failed-guard payload → a visible "cannot open live report" fallback;
 *  - `connections.list` failure → a top-level "cannot reach quick-studio" state;
 *  - each block's fetch/render is isolated in its own try/catch (one failing block never drops
 *    its siblings); a `confirmation_required` reply renders an inert note, never re-issued with
 *    `confirmed:true`.
 *
 * House testing style: all logic is pure/injectable ({@link renderResultBlock},
 * {@link buildExecuteParams}, {@link classifyReply}, {@link runLiveReport} over injected
 * {@link LiveDeps} + {@link LiveHost}); the DOM is touched only in the thin {@link bootstrap}
 * seam, guarded by `typeof document`/`typeof window`.
 */

import * as Plot from "@observablehq/plot";
import type { PlotOptions } from "@observablehq/plot";
import type {
  ConnectionSummary,
  ExecuteRequest,
  ExecuteResult,
  FrozenData,
  RpcReply,
} from "../shared/contract.ts";
import { parseChartSpec } from "../shared/chart-spec.ts";
import { renderTableToHtml, truncationNote } from "../shared/frozen-table.ts";
import { isLiveReportDoc, type LiveReportBlock, type LiveReportDoc } from "../shared/live-report.ts";
import { buildPlotOptions, renderMarkdownToHtml } from "../sandbox/render.ts";

/** One query block of a Live Report (the only kind that re-queries live). */
type LiveQueryBlock = Extract<LiveReportBlock, { kind: "query" }>;

/** The visible state shown when the page was NOT served by a running Core (no token). */
export const NEEDS_QS_HTML =
  '<p class="qs-fallback">This Live Report needs a running quick-studio to load its data.</p>';

/** The visible fallback for a corrupted / hand-edited / schema-drifted Live Report payload. */
export const CANNOT_OPEN_HTML =
  '<p class="qs-fallback">cannot open live report — the embedded layout is missing, corrupted, or from an unsupported version.</p>';

/** The top-level state shown when `connections.list` fails before any block could render. */
export const CANNOT_REACH_HTML =
  '<p class="qs-fallback">cannot reach quick-studio — no connection could be listed.</p>';

/**
 * The inline per-query-block note when `connections.list` failed but the document still renders
 * (prose/empty are NOT hidden behind a whole-page wall). Plain text — surfaced via `appendError`.
 */
export const CANNOT_REACH_BLOCK_NOTE = "cannot reach quick-studio — re-query when it is running";

/** The affordance for a Live Report published with zero blocks — never a blank body. */
export const EMPTY_REPORT_NOTE = "This live report has no blocks.";

/** The inert note rendered for a destructive block the Core flagged `confirmation_required`. */
export const CONFIRM_NOTE = "not run — requires confirmation";

/** The neutral note rendered for a query block whose SQL is blank (no fetch attempted). */
export const NO_QUERY_NOTE = "no query";

/** The neutral note rendered for a successful non-SELECT (`ok`) run — no rows to show. */
export const OK_NOTE = "statement ran — no rows returned";

/* ------------------------------------------------------------------ *
 * Pure cores
 * ------------------------------------------------------------------ */

/** Build the `execute` params for one block: id-only (`null` = the default/boot connection). */
export function buildExecuteParams(block: LiveQueryBlock, connectionId: string | null): ExecuteRequest {
  // Only the connection ID crosses the wire (AR-12) — never a url/credential. `confirmed` is
  // deliberately omitted, so a destructive statement is NEVER auto-run.
  return { shape: "raw", sql: block.sql, connectionId };
}

/** The normalized classification of an `execute` RPC reply. */
export type ReplyClass =
  | { readonly kind: "rows"; readonly data: FrozenData; readonly truncated: boolean }
  | { readonly kind: "confirm" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Classify an `execute` reply into the four render outcomes. Total — an error envelope, a
 * malformed body, or an unexpected status all resolve to a neutral `error` (never a throw).
 */
export function classifyReply(reply: RpcReply<unknown>): ReplyClass {
  if (!reply.ok) return { kind: "error", message: reply.error.message };
  const result = reply.result as ExecuteResult | null | undefined;
  if (typeof result !== "object" || result === null) {
    return { kind: "error", message: "unexpected reply from quick-studio" };
  }
  switch (result.status) {
    case "rows":
      return { kind: "rows", data: result.data, truncated: result.truncated };
    case "confirmation_required":
      return { kind: "confirm" };
    case "ok":
      return { kind: "ok" };
    default:
      return { kind: "error", message: "unexpected reply from quick-studio" };
  }
}

/**
 * The normalized render instruction for one query block's LIVE result. Prose/table resolve to
 * an HTML string; a chart resolves to Observable Plot options. `buildPlotOptions` is pure (no
 * DOM), so the whole dispatch is testable without a DOM.
 */
export type BlockRender =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "chart"; readonly options: PlotOptions; readonly truncated: boolean };

/**
 * Render a query block's live {@link FrozenData}: a chart when `view:"chart"` AND the stored
 * spec still validates against the LIVE columns (`parseChartSpec` non-null), else a table of
 * the same data. A truncated result carries the {@link truncationNote} affordance. Every column
 * name AND cell is HTML-escaped by {@link renderTableToHtml}. Pure and total.
 */
export function renderResultBlock(block: LiveQueryBlock, data: FrozenData, truncated: boolean): BlockRender {
  if (block.view === "chart" && block.chart !== null) {
    const spec = parseChartSpec(block.chart, data.columns.map((c) => c.name));
    if (spec !== null) {
      return { kind: "chart", options: buildPlotOptions(spec, data), truncated };
    }
  }
  const table = renderTableToHtml(data);
  return { kind: "html", html: truncated ? `${table}${truncationNote()}` : table };
}

/* ------------------------------------------------------------------ *
 * Injectable seams (RPC + mount host)
 * ------------------------------------------------------------------ */

/** The RPC + token seam the orchestration runs over — injected so it needs no DOM/network to test. */
export type LiveDeps = {
  /** The per-boot session token injected by the serving Core, or `null` (bare/stopped Core). */
  readonly getToken: () => string | null;
  /** POST an `/rpc` call; always resolves to a typed reply (never throws). */
  readonly rpc: (method: string, params: unknown) => Promise<RpcReply<unknown>>;
};

/** A synthetic `internal_error` envelope for a malformed/non-envelope reply body or a transport failure. */
function transportError<T>(message: string): RpcReply<T> {
  return { ok: false, error: { code: "internal_error", message } };
}

/**
 * Build the same-origin `/rpc` caller — the tiny INLINE fetch (Ring discipline: no Ring-2
 * `rpc/client` import). POSTs `{method, params}` with the `x-qs-token` header; a non-envelope
 * body or a transport throw resolves to an `internal_error` envelope so callers never catch.
 */
export function makeRpc(
  fetchImpl: typeof fetch,
  getToken: () => string | null,
): (method: string, params: unknown) => Promise<RpcReply<unknown>> {
  return async (method, params) => {
    const token = getToken() ?? "";
    try {
      const res = await fetchImpl("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", "x-qs-token": token },
        body: JSON.stringify(params === undefined ? { method } : { method, params }),
      });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return transportError("malformed reply from quick-studio");
      }
      if (typeof body !== "object" || body === null || typeof (body as { ok?: unknown }).ok !== "boolean") {
        return transportError("malformed reply from quick-studio");
      }
      return body as RpcReply<unknown>;
    } catch (err) {
      return transportError(err instanceof Error ? err.message : "request failed");
    }
  };
}

/** One ordered per-block render surface, injected so the mount + isolation are DOM-free-testable. */
export type BlockSlot = {
  /** Reset this block's surface before a (re-)render. */
  readonly clear: () => void;
  /** Append a block of trusted, already-escaped/sanitized HTML. */
  readonly appendHtml: (html: string) => void;
  /** Build + append the Observable Plot node from `options` (MAY throw on a bad channel). */
  readonly appendChart: (options: PlotOptions) => void;
  /** Append a small neutral note (empty / confirm / ok — plain text, never markup). */
  readonly appendNote: (text: string) => void;
  /** Append a small inline error note when a block failed (never data). */
  readonly appendError: (message: string) => void;
};

/** The top-level mount surface the orchestration drives (picker + refresh + status + block slots). */
export type LiveHost = {
  /** Show a top-level status/fallback (trusted constant HTML). */
  readonly setStatus: (html: string) => void;
  /** Render the connection picker; `onPick(id|null)` re-queries all blocks against the pick. */
  readonly renderPicker: (
    connections: ReadonlyArray<ConnectionSummary>,
    onPick: (connectionId: string | null) => void,
  ) => void;
  /** Render the Refresh control; `onRefresh()` re-queries all blocks against the current pick. */
  readonly renderRefresh: (onRefresh: () => void) => void;
  /** Allocate one ordered per-block slot (called once per block, in order). */
  readonly addBlock: () => BlockSlot;
};

/* ------------------------------------------------------------------ *
 * Orchestration (pure over injected deps + host)
 * ------------------------------------------------------------------ */

/** Apply a {@link BlockRender} to a slot: html directly; a chart (with its truncation affordance). */
function applyRender(slot: BlockSlot, render: BlockRender): void {
  if (render.kind === "html") {
    slot.appendHtml(render.html);
    return;
  }
  if (render.truncated) slot.appendHtml(truncationNote());
  slot.appendChart(render.options);
}

/**
 * Re-query ONE query block against `connectionId` and render it into `slot`, isolated in its
 * own try/catch. A blank SQL → an inert "no query" note (no fetch). A network/RPC error → an
 * inline error note; a `confirmation_required` → the inert {@link CONFIRM_NOTE} (never re-issued
 * with `confirmed:true`); an `ok` → a neutral note; `rows` → the rendered result.
 *
 * Concurrency guard (Patch B): `slot.clear()` runs at the top (before the await), but every
 * append after the `await deps.rpc(...)` is gated by `isCurrent()` — so a run superseded by a
 * newer re-query (rapid picker change / Refresh) appends NOTHING and can never double-append or
 * land a connection the picker no longer shows. `isCurrent` defaults to always-current for the
 * un-orchestrated call sites.
 */
export async function runBlock(
  deps: LiveDeps,
  block: LiveQueryBlock,
  connectionId: string | null,
  slot: BlockSlot,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  slot.clear();
  if (block.sql.trim() === "") {
    slot.appendNote(NO_QUERY_NOTE);
    return;
  }
  let reply: RpcReply<unknown>;
  try {
    reply = await deps.rpc("execute", buildExecuteParams(block, connectionId));
  } catch (err) {
    if (isCurrent()) slot.appendError(err instanceof Error ? err.message : "block failed to re-query");
    return;
  }
  // Superseded by a newer run while this fetch was in flight: append nothing (the newer run owns
  // the slot). The clear already ran, and only the latest run reaches its append below.
  if (!isCurrent()) return;
  const classified = classifyReply(reply);
  switch (classified.kind) {
    case "error":
      slot.appendError(classified.message);
      return;
    case "confirm":
      // Read-only by policy: NEVER auto-confirm a destructive statement.
      slot.appendNote(CONFIRM_NOTE);
      return;
    case "ok":
      slot.appendNote(OK_NOTE);
      return;
    case "rows":
      try {
        applyRender(slot, renderResultBlock(block, classified.data, classified.truncated));
      } catch (err) {
        slot.appendError(err instanceof Error ? err.message : "block failed to render");
      }
      return;
  }
}

/**
 * Fetch the viewer-pickable connections via `connections.list`. Returns the summaries, or
 * `null` when the RPC fails (→ the caller shows the top-level "cannot reach" state).
 */
export async function loadConnections(deps: LiveDeps): Promise<ReadonlyArray<ConnectionSummary> | null> {
  const reply = await deps.rpc("connections.list", undefined);
  if (!reply.ok) return null;
  const result = reply.result;
  return Array.isArray(result) ? (result as ReadonlyArray<ConnectionSummary>) : [];
}

/**
 * Drive a validated {@link LiveReportDoc} into `host` over the injected `deps`:
 *  - no token → the inert {@link NEEDS_QS_HTML} state; prose/empty blocks still render (no fetch),
 *    query blocks show the same inert note, and NO `/rpc` fetch is attempted;
 *  - else fetch `connections.list` (failure → {@link CANNOT_REACH_HTML}), render the picker
 *    (default `null` + each summary) + a Refresh control, and run every query block against the
 *    current pick, each block isolated; empty report → an affordance.
 * Pure over its injected host + deps.
 */
export async function runLiveReport(doc: LiveReportDoc, deps: LiveDeps, host: LiveHost): Promise<void> {
  const token = deps.getToken();

  // No running Core authorized this page: render everything inert and NEVER touch `/rpc`.
  if (token === null) {
    host.setStatus(NEEDS_QS_HTML);
    if (doc.blocks.length === 0) {
      host.addBlock().appendNote(EMPTY_REPORT_NOTE);
      return;
    }
    for (const block of doc.blocks) {
      const slot = host.addBlock();
      // Isolation contract: prose/empty rendering is per-block guarded too (not only the
      // query path), so a throw from `renderMarkdownToHtml`/`appendHtml` on one block never
      // aborts the loop and drops its siblings — it surfaces as this block's inline error.
      try {
        if (block.kind === "prose") slot.appendHtml(`<div class="qs-prose">${renderMarkdownToHtml(block.markdown)}</div>`);
        else if (block.kind === "empty") slot.appendNote(block.note);
        else slot.appendNote(NEEDS_QS_HTML.replace(/<[^>]+>/g, "")); // inert query note, no fetch
      } catch (err) {
        slot.appendError(err instanceof Error ? err.message : "block failed to render");
      }
    }
    return;
  }

  // A `connections.list` failure no longer hides the whole document behind a wall (Patch C):
  // prose/empty blocks STILL render, a top-level "cannot reach" note sits above them, and each
  // query block surfaces its own inline error. Fall through with `connections = []` so the
  // picker shows Default only and Refresh can retry once the Core is back.
  const loaded = await loadConnections(deps);
  const connectionsFailed = loaded === null;
  const connections = loaded ?? [];
  if (connectionsFailed) host.setStatus(CANNOT_REACH_HTML);

  if (doc.blocks.length === 0) {
    host.addBlock().appendNote(EMPTY_REPORT_NOTE);
  }

  // Build the ordered block slots once; prose/empty render immediately, query blocks re-query.
  const querySlots: Array<{ readonly block: LiveQueryBlock; readonly slot: BlockSlot }> = [];
  for (const block of doc.blocks) {
    const slot = host.addBlock();
    // Isolation contract: prose/empty rendering is per-block guarded too (mirroring `runBlock`
    // for the query path), so a throw from `renderMarkdownToHtml`/`appendHtml` on one block
    // never aborts the loop — query siblings still get their slots and re-query.
    try {
      if (block.kind === "prose") {
        slot.appendHtml(`<div class="qs-prose">${renderMarkdownToHtml(block.markdown)}</div>`);
      } else if (block.kind === "empty") {
        slot.appendNote(block.note);
      } else {
        querySlots.push({ block, slot });
      }
    } catch (err) {
      slot.appendError(err instanceof Error ? err.message : "block failed to render");
    }
  }

  // The current viewer pick (default `null` = the boot/launch connection).
  let current: string | null = null;

  // Run-generation guard (Patch B): only the LATEST run may render into a slot. Two overlapping
  // re-queries (rapid picker changes / Refresh) each capture a generation; a superseded run's
  // appends are dropped by `runBlock`'s `isCurrent` gate, so blocks never double-append or land a
  // connection the picker no longer shows. Each block stays isolated (a throw in one never drops
  // the others — `runBlock` is internally guarded, and this belt-and-suspenders catch covers any
  // surprise), and the catch is itself gated so a superseded throw appends nothing.
  let latestRun = 0;
  const runAll = async (): Promise<void> => {
    const myRun = ++latestRun;
    const isCurrent = (): boolean => myRun === latestRun;
    await Promise.all(
      querySlots.map(async ({ block, slot }) => {
        try {
          await runBlock(deps, block, current, slot, isCurrent);
        } catch (err) {
          if (isCurrent()) slot.appendError(err instanceof Error ? err.message : "block failed");
        }
      }),
    );
  };

  host.renderPicker(connections, (pick) => {
    current = pick;
    void runAll();
  });
  host.renderRefresh(() => {
    void runAll();
  });

  // Core unreachable (Patch C): the prose/empty blocks above already rendered; give each query
  // block its own inline "cannot reach" error rather than re-querying a Core we know is down.
  // Refresh re-issues `runAll`, which retries `execute` per block once the Core is back.
  if (connectionsFailed) {
    for (const { slot } of querySlots) {
      slot.appendError(CANNOT_REACH_BLOCK_NOTE);
    }
    return;
  }

  await runAll();
}

/**
 * Validate + drive the embedded payload text. A `null` / unparseable / failed-guard payload
 * renders the visible {@link CANNOT_OPEN_HTML} — never a blank page. The sole trust gate before
 * rendering is {@link isLiveReportDoc}. Pure over its injected host + deps.
 */
export async function mountLiveReport(rawJson: string | null, deps: LiveDeps, host: LiveHost): Promise<void> {
  let parsed: unknown = null;
  if (rawJson !== null) {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = null;
    }
  }
  if (!isLiveReportDoc(parsed)) {
    host.setStatus(CANNOT_OPEN_HTML);
    return;
  }
  await runLiveReport(parsed, deps, host);
}

/* ------------------------------------------------------------------ *
 * DOM seam (never run under bun test)
 * ------------------------------------------------------------------ */

/** Wire a real document + `window.__QS_TOKEN__` + same-origin fetch, then mount. */
export function bootstrap(doc: Document, win: Window & typeof globalThis): void {
  const mount = doc.getElementById("__qs_report");
  if (mount === null) return;

  // A top-level controls bar (picker + refresh), prepended so it stays above the block list.
  const controls = doc.createElement("div");
  controls.className = "qs-controls";
  const status = doc.createElement("p");
  status.className = "qs-status";
  mount.appendChild(controls);
  mount.appendChild(status);

  const host: LiveHost = {
    setStatus: (html) => {
      status.innerHTML = html;
    },
    renderPicker: (connections, onPick) => {
      const label = doc.createElement("label");
      label.textContent = "connection ";
      const select = doc.createElement("select");
      select.className = "qs-picker";
      const optDefault = doc.createElement("option");
      optDefault.value = "";
      optDefault.textContent = "Default (launch connection)";
      select.appendChild(optDefault);
      for (const conn of connections) {
        const opt = doc.createElement("option");
        opt.value = conn.id;
        opt.textContent = conn.name;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        onPick(select.value === "" ? null : select.value);
      });
      label.appendChild(select);
      controls.appendChild(label);
    },
    renderRefresh: (onRefresh) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "qs-refresh";
      button.textContent = "refresh";
      button.addEventListener("click", () => onRefresh());
      controls.appendChild(button);
    },
    addBlock: () => {
      const container = doc.createElement("div");
      container.className = "qs-block";
      mount.appendChild(container);
      return {
        clear: () => {
          container.innerHTML = "";
        },
        appendHtml: (html) => {
          const wrapper = doc.createElement("div");
          // Already-escaped/sanitized HTML (per-cell escape + micromark raw-HTML-disabled).
          wrapper.innerHTML = html;
          container.appendChild(wrapper);
        },
        appendChart: (options) => {
          container.appendChild(Plot.plot(options) as unknown as Node);
        },
        appendNote: (text) => {
          const note = doc.createElement("p");
          note.className = "qs-empty";
          note.textContent = text;
          container.appendChild(note);
        },
        appendError: (message) => {
          const note = doc.createElement("p");
          note.className = "qs-block-error";
          note.textContent = `block failed: ${message}`;
          container.appendChild(note);
        },
      };
    },
  };

  const rawJson = doc.getElementById("__qs_livereport")?.textContent ?? null;
  const token = typeof win.__QS_TOKEN__ === "string" ? win.__QS_TOKEN__ : null;
  const deps: LiveDeps = { getToken: () => token, rpc: makeRpc(win.fetch.bind(win), () => token) };
  void mountLiveReport(rawJson, deps, host);
}

// Browser-only seam: run the bootstrap when a real DOM + window are present (inside the served
// Live Report page). Under `bun test` both are undefined, so importing this module for the pure
// unit tests never touches the DOM nor issues a fetch.
declare global {
  interface Window {
    __QS_TOKEN__?: string;
  }
}
if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootstrap(document, window);
}
