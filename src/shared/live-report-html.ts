/**
 * quick-studio — Live Report HTML assembler (pure, Ring-neutral) — Story 6.4.
 *
 * `assembleLiveReportHtml(doc, runtimeJs, token)` builds the single self-contained `.html`
 * document that IS a Live Report: a hardened CSP whose SOLE egress is `connect-src 'self'`
 * (the load-bearing delta from the 6.3 Snapshot's `connect-src 'none'`), an inline stylesheet,
 * the token-free {@link LiveReportDoc} payload inlined as JSON, and the inlined live runtime.
 * Zero external references (no CDN, font, or remote asset).
 *
 * The session token is injected ONLY when `token` is non-null — the running Core passes its
 * per-boot token at serve time (mirroring the app shell's `window.__QS_TOKEN__`), while the
 * downloaded/portable copy is assembled with `token = null` and so carries NO secret.
 *
 * Injection safety mirrors the Snapshot: TWO independent, both-load-bearing escapes —
 *  1. the JSON payload via {@link embedJson} (`<`/`>`/`&`/U+2028/U+2029 → `\uXXXX`);
 *  2. the inlined `runtimeJs` escaped for `</script` (→ `<\/script`).
 * The injected token is script-json-escaped via the same {@link embedJson}.
 */

import type { LiveReportDoc } from "./live-report.ts";
import { embedJson } from "./snapshot-html.ts";

/**
 * The Live Report document CSP. `connect-src 'self'` is the SOLE egress — it ties every
 * re-query to the origin that served the page (the loopback Core) and blocks all other
 * network access. Everything else is locked to inline (no external references).
 */
export const LIVE_REPORT_CSP =
  "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'";

/** Minimal, inline-only stylesheet for the Live Report (mirrors the Snapshot classes + a picker set). */
const LIVE_REPORT_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px; font: 14px/1.5 system-ui, sans-serif; color: #1a1a1a; background: #ffffff; }
#__qs_report { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.qs-prose :first-child { margin-top: 0; }
table.qs-frozen { border-collapse: collapse; width: 100%; font-size: 13px; }
.qs-frozen th, .qs-frozen td { border: 1px solid #d0d0d0; padding: 3px 8px; text-align: left; }
.qs-frozen th { background: #f4f4f4; font-weight: 600; }
.qs-truncated { margin: 6px 0 0; font-size: 12px; color: #8a6d00; }
.qs-empty { margin: 0; font-size: 13px; color: #666; font-style: italic; }
.qs-block-error, .qs-fallback { margin: 0; font-size: 13px; color: #a11; }
.qs-fallback { padding: 16px; border: 1px solid #a11; border-radius: 6px; }
.qs-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qs-picker { font: 13px system-ui, sans-serif; padding: 3px 6px; }
.qs-refresh { font: 13px system-ui, sans-serif; padding: 3px 10px; cursor: pointer; }
.qs-status { margin: 0; font-size: 12px; color: #666; }
.qs-confirm { margin: 0; font-size: 13px; color: #8a6d00; }
`;

/**
 * Assemble the self-contained Live Report document. Pure and total. Both injection escapes
 * are applied (payload via {@link embedJson}, runtime via the `</script` replace); the token
 * is injected ONLY when non-null (script-json-escaped) so a `token = null` build has no secret.
 */
export function assembleLiveReportHtml(
  doc: LiveReportDoc,
  runtimeJs: string,
  token: string | null,
): string {
  const payload = embedJson(doc);
  // Second, independent escape: the inlined runtime bundle itself may contain a literal
  // `</script>` — neutralize it so it cannot close the <script> element early.
  const safeRuntime = runtimeJs.replace(/<\/script/gi, "<\\/script");
  // The token line is present ONLY at serve time (Core-served page). A null token → no line,
  // so the downloaded/portable copy carries no secret. Script-json-escaped like the app shell.
  const tokenScript =
    token === null ? "" : `\n    <script>window.__QS_TOKEN__ = ${embedJson(token)};</script>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${LIVE_REPORT_CSP}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>quick-studio live report</title>
    <style>${LIVE_REPORT_CSS}</style>
  </head>
  <body>
    <div id="__qs_report"></div>${tokenScript}
    <script type="application/json" id="__qs_livereport">${payload}</script>
    <script>${safeRuntime}</script>
  </body>
</html>
`;
}
