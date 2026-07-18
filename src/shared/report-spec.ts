/**
 * quick-studio — declarative report spec (Ring-neutral, dependency-light) — Story 9.7.
 *
 * A whitelisted, fully-validated description of a chat-generated Report the Core hands
 * back on the terminal `done` chunk. Mirrors `chart-spec.ts` exactly: the model's answer
 * is untrusted text. We NEVER `eval` it — we extract a single ` ```report ` fenced JSON
 * block and validate it against a closed whitelist (an ordered, non-empty list of
 * `prose`/`query` blocks; an optional shape-only chart intent on a query block).
 * Anything that fails validation coerces to `null` and opens nothing — the chat degrades
 * to its normal answer, never a half-built Report tab.
 *
 * Ring-neutral: imports ONLY `type ChartSpec` + `MARK_KINDS` from `./chart-spec.ts` —
 * nothing else. No column check here (columns are unknown pre-run; the render-time
 * `mapChart` guard in `ReportTabView` re-validates a chart's channels once a block runs).
 */

import { MARK_KINDS, type ChartSpec } from "./chart-spec.ts";

/** Upper bound on the (untrusted, model-authored) report title. */
const MAX_TITLE_LENGTH = 200;

/** Upper bound on one prose block's (untrusted, model-authored) Markdown. */
const MAX_MARKDOWN_LENGTH = 20000;

/** Upper bound on one query block's (untrusted, model-authored) SQL text. */
const MAX_SQL_LENGTH = 20000;

/** Upper bound on the number of blocks in one report — magnitude guard on untrusted
 *  model output so an over-long `blocks` list can't fold into a giant, event-loop-
 *  freezing `ReportState`. */
const MAX_BLOCKS = 100;

/** Upper bound on the raw ` ```report ` fence body handed to `JSON.parse` — a magnitude
 *  guard so a giant fence body can't block the Core event loop before validation runs. */
const MAX_REPORT_BODY_LENGTH = 200000;

/** One block of a chat-generated Report, discriminated by `kind`. */
export type ReportSpecBlock =
  | { readonly kind: "prose"; readonly markdown: string }
  | { readonly kind: "query"; readonly sql: string; readonly chart?: ChartSpec };

/**
 * A validated, declarative Report description: an optional bounded `title` plus a
 * NON-EMPTY ordered list of blocks. This is the ONLY shape `reportStateFromSpec`
 * (`report-state.ts`) ever folds into a real `ReportState`.
 */
export type ReportSpec = {
  readonly title?: string;
  readonly blocks: ReadonlyArray<ReportSpecBlock>;
};

/**
 * The first ` ```report ` fenced block. Copies {@link CHART_FENCE_RE} (`chart-spec.ts:47`)
 * VERBATIM, retagged `report`. See that module's doc comment for the line-anchored-close
 * rationale (a ` ``` ` sequence inside a JSON string value can never be mistaken for the
 * terminator).
 */
const REPORT_FENCE_RE = /```report[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/i;

/**
 * The OPENER of a ` ```report ` fence (tag + newline), regardless of whether the block
 * is well-formed or ever closes. Used by the Core to detect that an answer ATTEMPTED a
 * report so it can suppress the standalone "run query" affordance on that message — a
 * report answer is its own answer type and never doubles as a runnable single query,
 * even when the ` ```report ` block is malformed/unterminated (and so left in the text).
 */
const REPORT_FENCE_OPEN_RE = /```report[ \t]*\r?\n/i;

/** True when `text` contains a ` ```report ` fence opener (well-formed or not). */
export function hasReportFence(text: string): boolean {
  return REPORT_FENCE_OPEN_RE.test(text);
}

/**
 * Split the model's answer into its Markdown prose and the raw parsed contents of its
 * first ` ```report ` fenced block. Pure and total — mirrors `extractChartFence`:
 *  - No ` ```report ` fence (or an unterminated one) -> `{ markdown: text (unchanged),
 *    rawReport: null }`.
 *  - A well-formed fence present -> the fence block is REMOVED from `markdown` (prose
 *    stays intact), and `rawReport` is `JSON.parse` of the block body, or `null` when
 *    that JSON is malformed.
 * Only the FIRST fence is consulted.
 */
export function extractReport(text: string): { readonly markdown: string; readonly rawReport: unknown | null } {
  const match = REPORT_FENCE_RE.exec(text);
  if (match === null) return { markdown: text, rawReport: null };
  const markdown = text.slice(0, match.index) + text.slice(match.index + match[0].length);
  const body = match[1] ?? "";
  // Magnitude guard: never hand an oversized body to `JSON.parse` (event-loop safety).
  // The fence is still removed from `markdown`; only the parse is skipped.
  if (body.length > MAX_REPORT_BODY_LENGTH) return { markdown, rawReport: null };
  let rawReport: unknown | null = null;
  try {
    rawReport = JSON.parse(body);
  } catch {
    rawReport = null;
  }
  return { markdown, rawReport };
}

/**
 * Validate an untrusted, already-JSON-parsed value into a shape-only {@link ChartSpec},
 * or `null` when it fails any rule. UNLIKE `parseChartSpec`, this performs NO column
 * check — a chat-generated report's chart intent names columns that don't exist yet
 * (no result until the block runs); the render-time `mapChart` guard is the real gate.
 * Rules: `mark` in {@link MARK_KINDS}; `x`/`y` non-empty strings; optional `series`/
 * `title`, when present (non-null), non-null strings (title bounded).
 */
function parseChartIntent(raw: unknown): ChartSpec | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const mark = r.mark;
  if (typeof mark !== "string" || !(MARK_KINDS as readonly string[]).includes(mark)) return null;

  const x = r.x;
  const y = r.y;
  if (typeof x !== "string" || x.trim() === "") return null;
  if (typeof y !== "string" || y.trim() === "") return null;

  let series: string | undefined;
  if (r.series !== undefined && r.series !== null) {
    if (typeof r.series !== "string") return null;
    series = r.series;
  }

  let title: string | undefined;
  if (r.title !== undefined && r.title !== null) {
    if (typeof r.title !== "string" || r.title.length > MAX_TITLE_LENGTH) return null;
    title = r.title;
  }

  return {
    mark: mark as ChartSpec["mark"],
    x,
    y,
    ...(series !== undefined ? { series } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

/** Validate one untrusted block into a {@link ReportSpecBlock}, or `null` on any failure. */
function parseBlock(raw: unknown): ReportSpecBlock | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  if (r.kind === "prose") {
    if (typeof r.markdown !== "string" || r.markdown.trim() === "") return null;
    if (r.markdown.length > MAX_MARKDOWN_LENGTH) return null;
    return { kind: "prose", markdown: r.markdown };
  }

  if (r.kind === "query") {
    if (typeof r.sql !== "string" || r.sql.trim() === "") return null;
    if (r.sql.length > MAX_SQL_LENGTH) return null;
    // `chart` absent OR an explicit `null` both mean "no chart" — a plausible model
    // output — and yield a plain query block, NOT a rejection.
    if (r.chart === undefined || r.chart === null) {
      return { kind: "query", sql: r.sql };
    }
    // A present, non-null `chart` that fails shape validation drops the WHOLE block
    // (rather than silently dropping only the chart) — a malformed chart intent is
    // treated as a malformed block, per the whitelist-everything-or-reject-it rule.
    const chart = parseChartIntent(r.chart);
    if (chart === null) return null;
    return { kind: "query", sql: r.sql, chart };
  }

  return null;
}

/**
 * Validate an untrusted, already-JSON-parsed value into a {@link ReportSpec}, or `null`
 * when it fails any rule. Pure and total — never throws. Rules (all must hold):
 *  - `blocks` is a NON-EMPTY array;
 *  - every element parses as a valid prose or query block ({@link parseBlock});
 *  - optional `title`, when present (non-null), is a non-null string bounded to
 *    {@link MAX_TITLE_LENGTH}.
 * This is the Core-side gate: only a fully-validated spec reaches the chat's "open in
 * report tab" affordance.
 */
export function parseReportSpec(raw: unknown): ReportSpec | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.blocks) || r.blocks.length === 0 || r.blocks.length > MAX_BLOCKS) return null;
  const blocks: ReportSpecBlock[] = [];
  for (const rawBlock of r.blocks) {
    const block = parseBlock(rawBlock);
    if (block === null) return null;
    blocks.push(block);
  }

  // Title is normalized in the validator so the validated spec is the single source of
  // truth: reject oversized, collapse internal whitespace (incl. newlines) to single
  // spaces and trim, and treat a whitespace-only title as ABSENT (rather than accepting
  // it and silently discarding it downstream, or folding it into multiple headings).
  let title: string | undefined;
  if (r.title !== undefined && r.title !== null) {
    if (typeof r.title !== "string" || r.title.length > MAX_TITLE_LENGTH) return null;
    const normalized = r.title.replace(/\s+/g, " ").trim();
    if (normalized !== "") title = normalized;
  }

  return { ...(title !== undefined ? { title } : {}), blocks };
}
