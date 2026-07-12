/**
 * quick-studio UI (Ring 2) — Live Report export orchestration (Story 6.4).
 *
 * The UI→shared mapping + the local export action for a LIVE report. Unlike the 6.3 Snapshot,
 * the exported artifact carries only layout + SQL (no `FrozenData`, no credential, no token):
 * `toLiveReportBlock` maps the live {@link ReportBlock} list to the token/data-free
 * {@link LiveReportDoc}; `buildLiveReportHtml` assembles the portable secret-free copy
 * (`token = null`); `publishAndOpen` ships the doc to the LOCAL Core (`livereport.publish`) and
 * NAVIGATES the pre-reserved window to the loopback `/live/<id>` view; and `runExport` is the
 * injectable orchestrator (reserve-window → publish → portable copy) so the publish/fetch/error
 * paths are unit-testable with no DOM. The window is a two-phase seam — `reserveWindow` runs
 * synchronously in the click gesture (popup-blocker-safe), `navigate`/`closeWindow` after publish.
 * `triggerHtmlDownload` (imported from the Snapshot module) is the shared `typeof document`
 * download seam.
 *
 * The block-mapping matrix (SQL-only, data-free):
 *  - prose                              → `prose`
 *  - query, non-blank `sql`             → `query`  (carries `sql` + `view` + `chart`; NO data)
 *  - query, blank `sql`                 → `empty`  (note = "no query")
 */

import type { LiveReportPublishResult, RpcReply } from "../../shared/contract.ts";
import {
  LIVE_REPORT_SCHEMA_VERSION,
  type LiveReportBlock,
  type LiveReportDoc,
} from "../../shared/live-report.ts";
import { assembleLiveReportHtml } from "../../shared/live-report-html.ts";
import { triggerHtmlDownload } from "./export-snapshot.ts";
import type { ReportBlock } from "./report-state.ts";

/**
 * Map one {@link ReportBlock} to its {@link LiveReportBlock}. A query block carries only its
 * `sql` + `view` + `chart` spec — NEVER its `result` data (a Live Report re-queries on view).
 * A query with blank SQL degrades to an `empty` "no query" note (nothing to re-query).
 */
export function toLiveReportBlock(block: ReportBlock): LiveReportBlock {
  if (block.kind === "prose") {
    return { kind: "prose", markdown: block.markdown };
  }
  if (block.sql.trim() === "") {
    return { kind: "empty", note: "no query" };
  }
  return { kind: "query", sql: block.sql, view: block.view, chart: block.chart };
}

/** Map the ordered {@link ReportBlock} list to the schema-stamped embedded {@link LiveReportDoc}. */
export function toLiveReportDoc(blocks: readonly ReportBlock[]): LiveReportDoc {
  return { schemaVersion: LIVE_REPORT_SCHEMA_VERSION, blocks: blocks.map(toLiveReportBlock) };
}

/**
 * Assemble the self-contained, PORTABLE Live Report HTML from the live blocks + the fetched
 * runtime JS. `token = null` — the downloaded copy carries no secret (the running Core injects
 * a token only into its own served `/live/<id>` page). Pure.
 */
export function buildLiveReportHtml(blocks: readonly ReportBlock[], runtimeJs: string): string {
  return assembleLiveReportHtml(toLiveReportDoc(blocks), runtimeJs, null);
}

/** Two-digit zero-pad. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A deterministic, filesystem-safe download filename (UTC-stamped). `clock` is injected so
 * tests are stable; it defaults to the wall clock.
 */
export function liveReportFilename(clock: () => Date = () => new Date()): string {
  const d = clock();
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `quick-studio-live-report-${stamp}.html`;
}

/**
 * The two-phase window seam (Patch A — popup-blocker fix). A browser only honours `window.open`
 * inside the synchronous user-gesture stack, so the tab must be RESERVED before any `await`, then
 * NAVIGATED once publish resolves. `H` is the opaque window handle (a real `Window` in the app;
 * a fake in tests). `reserveWindow` returns `null` when the popup was blocked.
 */
export type PublishAndOpenDeps<H> = {
  readonly blocks: readonly ReportBlock[];
  /** Ship the doc to the local Core; resolves to the typed reply (never a throw). */
  readonly rpc: (method: string, params: unknown) => Promise<RpcReply<LiveReportPublishResult>>;
  /** The window RESERVED synchronously in the gesture (before the publish await), or `null` (blocked). */
  readonly handle: H | null;
  /** Navigate the reserved window to the returned loopback live-view path. */
  readonly navigate: (handle: H, path: string) => void;
  /** Tear down the reserved window (a failed publish leaves no orphan blank tab). */
  readonly closeWindow: (handle: H) => void;
};

/**
 * Publish the layout+SQL {@link LiveReportDoc} to the LOCAL Core, then NAVIGATE the pre-reserved
 * window to the loopback live view. A failed publish CLOSES the reserved window and THROWS (so the
 * caller surfaces it — never a false success, never an orphan blank tab). Returns whether the
 * popup was blocked (`handle` was `null`) so the caller can surface a "allow popups" note while
 * still delivering the portable copy.
 */
export async function publishAndOpen<H>(deps: PublishAndOpenDeps<H>): Promise<{ readonly popupBlocked: boolean }> {
  let path: string;
  try {
    const reply = await deps.rpc("livereport.publish", toLiveReportDoc(deps.blocks));
    if (!reply.ok) {
      throw new Error(reply.error.message || "could not publish live report");
    }
    path = reply.result.path;
  } catch (err) {
    if (deps.handle !== null) deps.closeWindow(deps.handle);
    throw err;
  }
  if (deps.handle === null) return { popupBlocked: true };
  deps.navigate(deps.handle, path);
  return { popupBlocked: false };
}

/** The injectable seams `runExport` depends on — so its publish/fetch/error paths need no DOM. */
export type RunExportDeps<H> = {
  readonly blocks: readonly ReportBlock[];
  /** Fetch the runtime JS; MUST throw on a non-OK / empty response (checked at the call site). */
  readonly fetchRuntime: () => Promise<string>;
  /** Deliver the portable, secret-free file (the real seam is {@link triggerHtmlDownload}). */
  readonly download: (html: string, filename: string) => void;
  /** Ship the doc to the local Core; resolves to the typed reply (never a throw). */
  readonly rpc: (method: string, params: unknown) => Promise<RpcReply<LiveReportPublishResult>>;
  /**
   * Reserve the live-view window SYNCHRONOUSLY inside the click gesture (called before any await,
   * so the popup blocker sees a user-initiated open). Returns `null` when the popup was blocked.
   */
  readonly reserveWindow: () => H | null;
  /** Navigate the reserved window to the returned `/live/<id>` path (after publish resolves). */
  readonly navigate: (handle: H, path: string) => void;
  /** Tear down the reserved window (used only on a failed publish). */
  readonly closeWindow: (handle: H) => void;
  readonly clock?: () => Date;
};

/**
 * Orchestrate one live export: reserve + publish + open the live view, AND hand the author a
 * portable, secret-free `.html` copy. The window is RESERVED synchronously (first line, before any
 * await) so the browser's popup blocker honours it. Publish runs next — a failed publish closes the
 * reserved window and throws before any download, so a broken export never silently "succeeds".
 * The portable copy is then assembled + downloaded; a fetch/assembly failure here is NON-FATAL to
 * the already-open live view (it is surfaced but never closes the view). If the popup was blocked,
 * the portable download STILL happens, then a "allow popups" error is surfaced. The UI wraps this
 * in try/catch and guards concurrency.
 */
export async function runExport<H>(deps: RunExportDeps<H>): Promise<void> {
  // Phase 1 (synchronous, inside the gesture): reserve the live-view window BEFORE any await.
  const handle = deps.reserveWindow();

  // Phase 2: publish, then navigate the reserved window (or note that the popup was blocked). A
  // failed publish closes the reserved window and throws here — nothing is downloaded.
  const { popupBlocked } = await publishAndOpen({
    blocks: deps.blocks,
    rpc: deps.rpc,
    handle,
    navigate: deps.navigate,
    closeWindow: deps.closeWindow,
  });

  // Phase 3: the portable, secret-free copy. A non-OK / empty runtime throws BEFORE any download,
  // but AFTER the live view has already opened — a non-fatal failure that never tears the view down.
  const runtimeJs = await deps.fetchRuntime();
  if (typeof runtimeJs !== "string" || runtimeJs.length === 0) {
    throw new Error("live report runtime is empty");
  }
  const html = buildLiveReportHtml(deps.blocks, runtimeJs);
  deps.download(html, liveReportFilename(deps.clock));

  // The portable copy shipped, but the headline "open live view" was blocked — surface it last so
  // the download still happened and the author knows to allow popups.
  if (popupBlocked) {
    throw new Error("allow popups to open the live view");
  }
}
