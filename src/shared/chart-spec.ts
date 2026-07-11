/**
 * quick-studio — declarative chart spec (Ring-neutral, dependency-free) — Story 5.6.
 *
 * A whitelisted, fully-validated description of a chart the trusted Ring 3 guest bundle
 * draws with Observable Plot. NOTHING here imports Plot, micromark, or the DOM: this is
 * the pure parse/validate layer shared by Ring 1 (schema-context / prompt), Ring 2 (the
 * chat surface that composes the render doc), and the contract guard (`isSandboxInbound`).
 *
 * The security posture (Story 5.5, unchanged): the model's answer is untrusted text. We
 * NEVER `eval` it — we extract a single ` ```chart ` fenced JSON block and validate it
 * against a closed whitelist (`mark` ∈ {line, bar, dot, area}; `x`/`y`/optional `series`
 * must name a real result column; `title` bounded). Anything that fails validation
 * coerces to `null` and is ignored — the guest draws Markdown only, never a bogus chart.
 */

/** The closed whitelist of chart marks the guest can draw (AD-10: Observable Plot only). */
export const MARK_KINDS = ["line", "bar", "dot", "area"] as const;

/** One whitelisted mark kind, derived from {@link MARK_KINDS} (not hand-duplicated). */
export type MarkKind = (typeof MARK_KINDS)[number];

/**
 * A validated, declarative chart description. `x`/`y`/`series` are result-column NAMES
 * (never values, never expressions); `title` is bounded, optional prose. This is the
 * ONLY chart shape that ever reaches the guest — there is no field that can carry code.
 */
export type ChartSpec = {
  readonly mark: MarkKind;
  readonly x: string;
  readonly y: string;
  readonly series?: string;
  readonly title?: string;
};

/** Upper bound on the (untrusted, model-authored) chart title. */
const MAX_TITLE_LENGTH = 200;

/**
 * The first ` ```chart ` fenced block. Case-insensitive tag; tolerant of CRLF. The
 * CLOSING fence MUST be `` ``` `` on its OWN line (preceded by a newline, followed by a
 * newline or end-of-text) — NOT merely the next ` ``` ` anywhere. That line-anchored
 * close is what makes the extraction leak-proof: a ` ``` ` sequence sitting INSIDE a
 * JSON string value (e.g. in `title`) is mid-line, so it can never be mistaken for the
 * terminator and truncate the JSON mid-value. An opener with no line-anchored close is
 * simply not a match (an unterminated fence → treated as "no chart", prose left intact).
 */
const CHART_FENCE_RE = /```chart[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/i;

/**
 * Split the model's answer into its Markdown prose and the raw parsed contents of its
 * first ` ```chart ` fenced block. Pure and total:
 *  - No ` ```chart ` fence (or an UNTERMINATED one, whose close is not on its own line)
 *    → `{ markdown: text (unchanged), rawChart: null }` — never a partial/truncated JSON
 *    leak into the prose.
 *  - A well-formed fence present → the fence block is REMOVED from `markdown` (prose stays
 *    intact), and `rawChart` is `JSON.parse` of the block body, or `null` when that JSON is
 *    malformed (a broken spec never throws and never corrupts the prose).
 * Only the FIRST fence is consulted; any later fence stays verbatim in the prose.
 */
export function extractChartFence(text: string): { readonly markdown: string; readonly rawChart: unknown | null } {
  const match = CHART_FENCE_RE.exec(text);
  if (match === null) return { markdown: text, rawChart: null };
  const markdown = text.slice(0, match.index) + text.slice(match.index + match[0].length);
  let rawChart: unknown | null = null;
  try {
    rawChart = JSON.parse(match[1] ?? "");
  } catch {
    rawChart = null;
  }
  return { markdown, rawChart };
}

/**
 * Validate an untrusted, already-JSON-parsed value into a {@link ChartSpec}, or `null`
 * when it fails any rule. Pure and total — never throws. Rules (all must hold):
 *  - `mark` is a string in {@link MARK_KINDS};
 *  - `x` and `y` are strings that each name a column in `columnNames`;
 *  - `series`, when present (non-null), is a string naming a column in `columnNames`;
 *  - `title`, when present (non-null), is a string of length ≤ {@link MAX_TITLE_LENGTH}.
 * A channel that names a column absent from the pushed data is rejected — a chart can
 * never reference a column the guest was not given.
 */
export function parseChartSpec(raw: unknown, columnNames: readonly string[]): ChartSpec | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const mark = r.mark;
  if (typeof mark !== "string" || !(MARK_KINDS as readonly string[]).includes(mark)) return null;

  const x = r.x;
  const y = r.y;
  if (typeof x !== "string" || typeof y !== "string") return null;
  if (!columnNames.includes(x) || !columnNames.includes(y)) return null;

  let series: string | undefined;
  if (r.series !== undefined && r.series !== null) {
    if (typeof r.series !== "string" || !columnNames.includes(r.series)) return null;
    series = r.series;
  }

  let title: string | undefined;
  if (r.title !== undefined && r.title !== null) {
    if (typeof r.title !== "string" || r.title.length > MAX_TITLE_LENGTH) return null;
    title = r.title;
  }

  return {
    mark: mark as MarkKind,
    x,
    y,
    ...(series !== undefined ? { series } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}
