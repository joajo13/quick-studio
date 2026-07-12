/**
 * quick-studio — shared frozen-data table renderer (Ring-neutral, dependency-light).
 *
 * The ONE pure renderer that turns canonical {@link FrozenData} into an escaped HTML
 * `<table>` string. Extracted from the 6.3 Snapshot offline runtime so BOTH the offline
 * Snapshot ({@link ../snapshot/runtime.ts}) and the live Report ({@link ../live-report/runtime.ts})
 * draw tables through the same code — never a third fork.
 *
 * Injection safety is load-bearing: frozen values AND column names are untrusted DB
 * strings, so {@link renderTableToHtml} HTML-escapes EVERY column name and EVERY cell
 * (a `</td><script>` in a value renders inert as text). No side effects; imports only
 * the frozen-data types from `./contract`.
 */

import type { FrozenCell, FrozenData } from "./contract.ts";

/** Neutral placeholder rendered for a SQL NULL cell. */
export const NULL_PLACEHOLDER = "—";

/** The 5-char HTML escape (`&`, `<`, `>`, `"`, `'`) applied to every cell + column name. */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** HTML-escape untrusted text so DB strings render inert (`</td><script>` stays visible text). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Format one {@link FrozenCell} as display text (per kind); a null cell → {@link NULL_PLACEHOLDER}. */
export function formatCell(cell: FrozenCell): string {
  switch (cell.kind) {
    case "null":
      return NULL_PLACEHOLDER;
    case "string":
      return cell.value;
    case "number":
      return String(cell.value);
    case "boolean":
      return String(cell.value);
    case "date":
      return cell.iso;
    default: {
      const _exhaustive: never = cell;
      return String(_exhaustive);
    }
  }
}

/**
 * Render canonical {@link FrozenData} to an HTML `<table>` string. HTML-escapes EVERY column
 * name AND every cell value (frozen values are untrusted DB strings) so no markup can break
 * out. Pure and total.
 */
export function renderTableToHtml(data: FrozenData): string {
  const head = data.columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join("");
  const body = data.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(formatCell(cell))}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="qs-frozen"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The visible "results truncated" affordance — so partial data is never shown as complete. */
export function truncationNote(): string {
  return '<p class="qs-truncated">results truncated — showing partial data only.</p>';
}
