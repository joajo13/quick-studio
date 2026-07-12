/**
 * quick-studio — Snapshot HTML assembler (pure, Ring-neutral) — Story 6.3.
 *
 * `assembleSnapshotHtml(doc, runtimeJs)` builds the single, fully self-contained `.html`
 * document that IS the exported Snapshot: an offline-hardened CSP, an inline stylesheet, the
 * `SnapshotDoc` payload inlined as JSON, and the inlined offline renderer bundle. Zero
 * external references (no CDN, font, or remote asset); `connect-src 'none'` guarantees no
 * egress even if rendering misbehaves.
 *
 * Injection safety is the core risk (frozen values are untrusted DB strings; the runtime is a
 * minified third-party bundle), so there are TWO independent, both-load-bearing escapes:
 *  1. the JSON payload {@link embedJson}s `<`, `>`, `&`, and the U+2028/U+2029 line
 *     separators to `\uXXXX` — neutralizing a `</script>` breakout AND the JS line-terminator
 *     trick — while staying valid JSON that `JSON.parse` restores byte-for-byte;
 *  2. the inlined `runtimeJs` is escaped for `</script` (→ `<\/script`) because the minified
 *     Observable Plot / micromark bundle can contain that literal, and one un-escaped
 *     occurrence would close the `<script>` early and break the whole file.
 */

import type { SnapshotDoc } from "./snapshot.ts";

/** The offline-hardened document CSP. `connect-src 'none'` (mandatory) blocks all egress. */
const SNAPSHOT_CSP =
  "default-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** `<`, `>`, `&`, U+2028, U+2029 — the chars `\u`-escaped in the JSON payload (source escapes). */
const PAYLOAD_ESCAPE_RE = new RegExp("[\\u003c\\u003e\\u0026\\u2028\\u2029]", "g");

/**
 * Serialize a value for safe embedding inside an inline `<script type="application/json">`:
 * JSON, then `\u`-escape `<`, `>`, `&`, and the U+2028/U+2029 line separators. The result is
 * still valid JSON (these chars only ever appear inside string values, and `JSON.parse`
 * restores the escapes), but carries no `</script` sequence and no raw JS line terminator.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(PAYLOAD_ESCAPE_RE, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** Minimal, inline-only stylesheet for the reopened Snapshot (no external font/asset). */
const SNAPSHOT_CSS = `
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
`;

/**
 * Assemble the self-contained Snapshot document. Pure and total. The two escapes above are
 * BOTH applied: the payload via {@link embedJson}, the runtime via the `</script` replace.
 */
export function assembleSnapshotHtml(doc: SnapshotDoc, runtimeJs: string): string {
  const payload = embedJson(doc);
  // Second, independent escape: the inlined runtime bundle itself may contain a literal
  // `</script>` — neutralize it so it cannot close the <script> element early.
  const safeRuntime = runtimeJs.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>quick-studio snapshot</title>
    <style>${SNAPSHOT_CSS}</style>
  </head>
  <body>
    <div id="__qs_report"></div>
    <script type="application/json" id="__qs_snapshot">${payload}</script>
    <script>${safeRuntime}</script>
  </body>
</html>
`;
}
