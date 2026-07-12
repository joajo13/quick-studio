/**
 * quick-studio UI (Ring 2) — Snapshot export orchestration (Story 6.3).
 *
 * The UI→shared mapping + the local export action. Assembly is PURE and stays in Ring 2 +
 * `shared/`: the frozen report data NEVER leaves the browser (no `report.export*` RPC ships
 * block data to the Core — the Core's only role is serving the data-free `/snapshot-runtime.js`
 * bundle). `toSnapshotDoc` maps the live {@link ReportBlock} list to the embedded
 * {@link SnapshotDoc}; `buildSnapshotHtml` assembles the self-contained file; `runExport` is
 * the injectable orchestrator (so the fetch/error paths are unit-testable with no DOM); and
 * `triggerHtmlDownload` is the thin `typeof document` download seam.
 *
 * The block-mapping matrix (AR-11-exact, truncation-preserving):
 *  - prose                                            → `prose`
 *  - query + result, table view (or invalid chart)    → `table`  (carries `truncated`)
 *  - query + result, chart view + valid spec          → `chart`  (carries `truncated`)
 *  - query, no result, `info` set (non-SELECT `ok`)   → `empty`  (note = the info text)
 *  - query, no result / errored                       → `empty`  (note = "no data")
 *  - query whose `encode(result)` throws              → `empty`  (note = "could not freeze")
 */

import { encode, type FrozenData } from "../../shared/contract.ts";
import { parseChartSpec } from "../../shared/chart-spec.ts";
import { SNAPSHOT_SCHEMA_VERSION, type SnapshotBlock, type SnapshotDoc } from "../../shared/snapshot.ts";
import { assembleSnapshotHtml } from "../../shared/snapshot-html.ts";
import type { ReportBlock } from "./report-state.ts";

/**
 * Map one {@link ReportBlock} to its {@link SnapshotBlock}. `encode()` is GUARDED per block:
 * a non-canonical/ragged/non-finite cell that makes `encode` throw degrades THAT block to an
 * `empty` "could not freeze" note — one malformed block must not abort the whole export.
 */
export function toSnapshotBlock(block: ReportBlock): SnapshotBlock {
  if (block.kind === "prose") {
    return { kind: "prose", markdown: block.markdown };
  }
  // Query block with no result: a successful non-SELECT (`info` set) carries its info text;
  // an unrun / errored block is a neutral "no data" (a Snapshot freezes data, not error state).
  if (block.result === null) {
    return { kind: "empty", note: block.info ?? "no data" };
  }
  let data: FrozenData;
  try {
    data = encode(block.result);
  } catch {
    return { kind: "empty", note: "could not freeze this block" };
  }
  const truncated = block.truncated ?? false;
  // Chart view only when a spec is present AND still validates against the frozen columns —
  // a null OR now-invalid spec falls back to a table view of the same data.
  if (block.view === "chart" && block.chart !== null) {
    const spec = parseChartSpec(block.chart, data.columns.map((c) => c.name));
    if (spec !== null) {
      return { kind: "chart", chart: spec, data, truncated };
    }
  }
  return { kind: "table", data, truncated };
}

/** Map the ordered {@link ReportBlock} list to the schema-stamped embedded {@link SnapshotDoc}. */
export function toSnapshotDoc(blocks: readonly ReportBlock[]): SnapshotDoc {
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, blocks: blocks.map(toSnapshotBlock) };
}

/** Assemble the self-contained Snapshot HTML from the live blocks + the fetched runtime JS. Pure. */
export function buildSnapshotHtml(blocks: readonly ReportBlock[], runtimeJs: string): string {
  return assembleSnapshotHtml(toSnapshotDoc(blocks), runtimeJs);
}

/** Two-digit zero-pad. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A deterministic, filesystem-safe download filename (UTC-stamped). `clock` is injected so
 * tests are stable; it defaults to the wall clock.
 */
export function snapshotFilename(clock: () => Date = () => new Date()): string {
  const d = clock();
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `quick-studio-snapshot-${stamp}.html`;
}

/** The injectable seams `runExport` depends on — so its fetch/error paths need no DOM to test. */
export type RunExportDeps = {
  readonly blocks: readonly ReportBlock[];
  /** Fetch the runtime JS; MUST throw on a non-OK / empty response (checked at the call site). */
  readonly fetchRuntime: () => Promise<string>;
  /** Deliver the assembled file (the real seam is {@link triggerHtmlDownload}). */
  readonly download: (html: string, filename: string) => void;
  readonly clock?: () => Date;
};

/**
 * Orchestrate one export: await the runtime, then assemble + download. Throws BEFORE any
 * download when the runtime is empty (belt-and-suspenders with `fetchRuntime`'s own `res.ok`
 * check) — so a failed fetch never welds an error body into the file and never silently
 * "succeeds". The UI wraps this in try/catch and guards concurrency.
 */
export async function runExport(deps: RunExportDeps): Promise<void> {
  const runtimeJs = await deps.fetchRuntime();
  if (typeof runtimeJs !== "string" || runtimeJs.length === 0) {
    throw new Error("snapshot runtime is empty");
  }
  const html = buildSnapshotHtml(deps.blocks, runtimeJs);
  deps.download(html, snapshotFilename(deps.clock));
}

/**
 * The DOM download seam: a `text/html` Blob + an object-URL anchor click. The object URL is
 * revoked on a LATER tick (`setTimeout(…, 0)`) — some browsers (Safari) cancel the download
 * when the URL is revoked in the same tick as `click()`. The deferred revoke is scheduled in a
 * `finally` so a throwing click still eventually frees the URL. Guarded by `typeof document`,
 * so it is a safe no-op under `bun test` (no DOM).
 */
export function triggerHtmlDownload(html: string, filename: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
