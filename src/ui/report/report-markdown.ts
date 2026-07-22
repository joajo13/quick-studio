/**
 * quick-studio UI (Ring 2) — Report Markdown renderer (Story 6.1).
 *
 * Renders a Report prose block's narrative Markdown to SANITIZED HTML with raw HTML
 * DISABLED — the SAME trust model as the Ring 3 sandbox guest's Markdown pass
 * (`src/sandbox/render.ts`): `micromark` with `allowDangerousHtml: false`, then a
 * post-process that neutralizes any link/image whose scheme is not http(s)/mailto/relative.
 *
 * The micromark config is deliberately DUPLICATED here rather than lifted to
 * `src/shared/`: `shared/` is dependency-free by contract, and `micromark` is a Ring
 * dependency (Design Note). A Ring-2 module must NOT import Ring-3 code, so the config
 * is repeated — a few lines is the correct trade to keep the ring boundaries clean.
 *
 * Security posture (R5 / no-code-execution): a `<script>` / `<img onerror>` in the prose
 * is ESCAPED, never live markup; a `javascript:`/`data:`/protocol-relative destination is
 * rewritten to a harmless `#`. Pure and total.
 */

import { micromark } from "micromark";

/** The URL schemes a rendered Markdown link/image may carry live. */
const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto"]);

/** Matches a `href="…"` / `src="…"` attribute pair in the (well-formed) micromark output. */
const URL_ATTR_RE = /\b(href|src)="([^"]*)"/gi;

/**
 * Whether a link/image destination is safe to emit live. A scheme-less URL (relative
 * path, fragment, query) is permitted; a PROTOCOL-RELATIVE `//host/…` is NOT (it inherits
 * the page's scheme and points off-origin). An explicit scheme must be in
 * {@link SAFE_URL_SCHEMES}. Leading/embedded control chars + whitespace are stripped
 * BEFORE scheme detection, so an obfuscated `java\tscript:` / ` javascript:` can never
 * smuggle a dangerous scheme past the check. Pure and total.
 */
function isSafeUrl(rawUrl: string, isImageSrc = false): boolean {
  const url = rawUrl.replace(/[\u0000-\u0020]+/g, "");
  // Protocol-relative guard. Browsers read leading `/\`, `\/`, `\\` (any slash/backslash
  // mix) as protocol-relative off-origin. micromark percent-encodes a backslash to `%5c`,
  // so decode it back, fold every backslash to `/`, and reject a leading `//` — plus any
  // leading backslash, which a browser normalizes toward `//host` (off-origin), never a
  // true relative path. A literal `\` alone would otherwise slip past `startsWith("//")`.
  const slashes = url.replace(/%5c/gi, "\\").replace(/\\/g, "/");
  if (slashes.startsWith("//")) return false;
  if (url.startsWith("\\") || /^%5c/i.test(url)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (scheme === null) return true; // relative / fragment / no scheme
  // An IMAGE `src` fetches on render with NO user gesture, so a remote `src` would send a
  // request off the machine on preview (R5: no data leaves the machine; no arbitrary embeds).
  // As of DW-2 Ring 2 DOES carry a CSP whose `img-src 'self' data:` refuses a remote image
  // origin outright, so this rewrite is now defense-in-depth rather than the sole barrier.
  // It stays anyway because it is a DIFFERENT kind of guard: it NEUTRALIZES the URL at
  // render time (the attribute never holds a remote origin) instead of relying on the
  // browser to refuse the fetch — so it holds even where a policy is missing, mis-delivered,
  // or unsupported. (It is not that the exported documents lack a policy: `SNAPSHOT_CSP` and
  // `LIVE_REPORT_CSP` both open with `default-src 'none'` and declare no `img-src`, so images
  // are blocked there MORE strictly than in the shell.) A scheme-less relative `src` is fine;
  // any explicit scheme (http/https/…) on an image is neutralized to `#`.
  if (isImageSrc) return false;
  return SAFE_URL_SCHEMES.has((scheme[1] as string).toLowerCase());
}

/**
 * Render prose Markdown to sanitized HTML with raw HTML DISABLED
 * (`allowDangerousHtml: false`, the micromark default — set explicitly to make the
 * security intent non-accidental). A `<script>` or `<img onerror>` in the source is
 * emitted ESCAPED (`&lt;script&gt;`), never as live markup; any `href`/`src` whose scheme
 * is not http(s)/mailto/relative (and any protocol-relative `//host`) is rewritten to a
 * harmless `#`. Pure and total.
 */
export function renderReportMarkdown(md: string): string {
  const html = micromark(md, { allowDangerousHtml: false });
  return html.replace(URL_ATTR_RE, (whole, attr: string, value: string) =>
    isSafeUrl(value, attr.toLowerCase() === "src") ? whole : `${attr}="#"`,
  );
}
