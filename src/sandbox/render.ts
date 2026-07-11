/**
 * quick-studio Sandbox (Ring 3) — the render helpers (Story 5.6).
 *
 * The trusted guest bundle draws rich content ONLY from validated, declarative inputs:
 *  - `renderMarkdownToHtml` turns untrusted Markdown into HTML via `micromark` with raw
 *    HTML DISABLED, so a `<script>` / `<img onerror>` in the text is ESCAPED, never live
 *    (and the guest CSP `script-src 'self'` would block an inline handler anyway).
 *  - `buildPlotOptions` maps a whitelisted {@link ChartSpec} + canonical {@link FrozenData}
 *    to an Observable Plot options object (marks + channels). No model-authored string is
 *    ever `eval`/`new Function` — the mark is chosen from a closed switch, and channels are
 *    column NAMES already validated by `parseChartSpec`.
 *  - `frozenToRecords` flattens tagged {@link FrozenData} rows to plain records Plot reads.
 *
 * Ring discipline (sacred): this module imports ONLY `src/shared/` + the render libraries
 * (`@observablehq/plot`, `micromark`) — never `src/core`, `src/ui`, `ai`, or `@ai-sdk/*`.
 *
 * House testing style: these are pure, exported functions asserted directly (the escaped
 * HTML string, the options object). The actual `Plot.plot(...)` DOM write stays in the
 * thin guest bootstrap seam, never under `bun test`.
 */

import * as Plot from "@observablehq/plot";
import type { Markish, PlotOptions } from "@observablehq/plot";
import { micromark } from "micromark";
import type { ChartSpec } from "../shared/chart-spec.ts";
import type { FrozenCell, FrozenData } from "../shared/contract.ts";

/**
 * The URL schemes a rendered Markdown link/image may carry live. (Note: `micromark`'s own
 * upstream sanitizer already blanks a non-http(s) IMAGE `src` — e.g. a `data:` image — to
 * empty before this pass, so `img-src data:` in the CSP is a permission the Markdown path
 * does not exercise; this allowlist is the narrower belt-and-suspenders over what survives.)
 */
const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto"]);

/** Matches a `href="…"` / `src="…"` attribute pair in the (well-formed) micromark output. */
const URL_ATTR_RE = /\b(href|src)="([^"]*)"/gi;

/**
 * Whether a link/image destination is safe to emit live against the `allowed` scheme set. A
 * scheme-less URL (relative path, fragment, query) is permitted; a PROTOCOL-RELATIVE `//host/…`
 * is NOT — it carries no explicit scheme yet silently inherits the page's and points off-origin,
 * so it is rejected despite looking "relative". An explicit scheme must be in {@link SAFE_URL_SCHEMES}.
 * Leading/embedded control chars + whitespace are stripped BEFORE scheme detection, so an
 * obfuscated `java\tscript:` / ` javascript:` can never smuggle a dangerous scheme past
 * the check. Pure and total.
 */
function isSafeUrl(rawUrl: string): boolean {
  const url = rawUrl.replace(/[\u0000-\u0020]+/g, "");
  if (url.startsWith("//")) return false; // protocol-relative → off-origin, not truly relative
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (scheme === null) return true; // relative / fragment / no scheme
  return SAFE_URL_SCHEMES.has((scheme[1] as string).toLowerCase());
}

/**
 * Render untrusted Markdown to HTML with raw HTML DISABLED (`allowDangerousHtml: false`,
 * the micromark default — set explicitly to make the security intent non-accidental). A
 * `<script>` or an `<img onerror>` in the source is emitted ESCAPED (`&lt;script&gt;`),
 * never as live markup.
 *
 * Defense-in-depth (Story 5.6): micromark does NOT sanitize link/image DESTINATIONS, so a
 * `[x](javascript:alert(1))` would otherwise emit a live `javascript:` URL. We post-process
 * the output to NEUTRALIZE any `href`/`src` whose scheme is not http(s)/mailto/relative, and
 * any protocol-relative `//host` (replaced with a harmless `#`). This is belt-and-suspenders:
 * the LOAD-BEARING backstop is
 * the guest CSP served by `src/core/sandbox-server.ts` (`script-src 'self'` blocks inline
 * handlers, `img-src data:` blocks off-origin images, `connect-src 'none'` blocks egress) —
 * this pass just closes the click-through `javascript:` vector before the CSP ever matters.
 * Pure and total.
 */
export function renderMarkdownToHtml(md: string): string {
  const html = micromark(md, { allowDangerousHtml: false });
  return html.replace(URL_ATTR_RE, (whole, attr: string, value: string) =>
    isSafeUrl(value) ? whole : `${attr}="#"`,
  );
}

/** Flatten one tagged {@link FrozenCell} to the plain JS value Plot reads (dates stay ISO strings). */
function cellValue(cell: FrozenCell): unknown {
  switch (cell.kind) {
    case "null":
      return null;
    case "string":
      return cell.value;
    case "number":
      return cell.value;
    case "boolean":
      return cell.value;
    case "date":
      return cell.iso;
    default: {
      const _exhaustive: never = cell;
      return String(_exhaustive);
    }
  }
}

/**
 * Convert canonical {@link FrozenData} to an array of plain `{ [columnName]: value }`
 * records — the row shape Observable Plot consumes. Pure and total; column order is the
 * schema's order, and a `null` cell becomes JS `null` (Plot treats it as missing).
 */
export function frozenToRecords(data: FrozenData): Record<string, unknown>[] {
  const names = data.columns.map((c) => c.name);
  return data.rows.map((row) => {
    const record: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) {
      record[names[i] as string] = cellValue(row[i] as FrozenCell);
    }
    return record;
  });
}

/**
 * Build one Observable Plot mark from a validated {@link ChartSpec}. The mark kind is
 * chosen from a CLOSED switch (never a dynamic constructor); `series`, when present,
 * groups by `stroke` (line/dot) or `fill` (bar/area). `x`/`y`/`series` are already-
 * validated column names. Total — an impossible mark is an exhaustiveness error.
 */
function buildMark(chart: ChartSpec, records: Record<string, unknown>[]): Markish {
  const base = { x: chart.x, y: chart.y };
  // Guard with `!= null` (not `!== undefined`): the guest forwards the RAW inbound chart, and a
  // `{series:null}` frame passes `isSandboxInbound` (parseChartSpec treats null as "absent"), so
  // a bare `!== undefined` would hand Plot a `{stroke:null}` channel. `!= null` matches the spec's
  // normalization — no null channel ever reaches Plot.
  switch (chart.mark) {
    case "line":
      return Plot.line(records, { ...base, ...(chart.series != null ? { stroke: chart.series } : {}) });
    case "bar":
      return Plot.barY(records, { ...base, ...(chart.series != null ? { fill: chart.series } : {}) });
    case "dot":
      return Plot.dot(records, { ...base, ...(chart.series != null ? { stroke: chart.series } : {}) });
    case "area":
      return Plot.areaY(records, { ...base, ...(chart.series != null ? { fill: chart.series } : {}) });
    default: {
      const _exhaustive: never = chart.mark;
      throw new Error(`unknown chart mark: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Map a validated {@link ChartSpec} + canonical {@link FrozenData} to the Observable Plot
 * options object (`{ title?, marks: [mark] }`). Pure — it constructs marks/channels and
 * converts rows to records but does NOT touch the DOM (the guest bootstrap calls
 * `Plot.plot(...)` on the result). Deterministic: the same spec + data yield the same options.
 */
export function buildPlotOptions(chart: ChartSpec, data: FrozenData): PlotOptions {
  const records = frozenToRecords(data);
  const options: PlotOptions = { marks: [buildMark(chart, records)] };
  // `!= null`: a raw `{title:null}` frame is accepted by the guard (parseChartSpec drops null);
  // don't forward a null title through to Plot.
  if (chart.title != null) options.title = chart.title;
  return options;
}
