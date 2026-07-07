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

import type { ExposureInfo } from "../shared/contract.ts";
import { errorReply } from "../shared/contract.ts";
import { mintSessionToken, validateOrigin, validateToken } from "./auth.ts";
import { deriveOpenUrl, isExposed, resolveBindHost } from "./binding.ts";
import { DEFAULT_RUN_MODE, type RunMode } from "./run-mode.ts";
import { dispatch, type RpcContext } from "./rpc.ts";
import { uiBundle } from "./ui-bundle.generated.ts";

const TOKEN_HEADER = "x-qs-token";

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
  /** Stop the server and release the port. May be awaited (async teardown). */
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
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
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
 * `window.__QS_TOKEN__` and sends it on every `/rpc` call, and reads
 * `window.__QS_EXPOSURE__` (known at boot, static) to render the Port-Exposure
 * Warning banner. The token is hex-filtered belt-and-suspenders; the exposure
 * payload (arbitrary `host`) leans on `scriptJson`'s `<script>`-safe escaping.
 * Exported for unit-testing the injection without booting a real server.
 */
export function renderIndexHtml(token: string, exposure: ExposureInfo): string {
  const safeToken = token.replace(/[^0-9a-fA-F]/g, "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>quick-studio</title>
    <link rel="stylesheet" href="/app.css" />
    <script>window.__QS_TOKEN__ = ${scriptJson(safeToken)};</script>
    <script>window.__QS_EXPOSURE__ = ${scriptJson(exposure)};</script>
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
  // Single normalization path shared with `bin/` (trim + lower-case + loopback
  // default), so classification, the bound hostname, and the `validateOrigin`
  // authority all agree — a direct `startCore({ host })` caller cannot bind a
  // padded/mixed-case host that would silently 403 every RPC.
  const bindHost = resolveBindHost(options.host);
  const exposed = isExposed(bindHost);
  const mode = options.mode ?? DEFAULT_RUN_MODE;
  const { js: appJs, css: appCss } = uiBundle;

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
      };

      // --- Static UI assets ---------------------------------------------
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(indexHtmlTemplate, { status: 200, headers: htmlHeaders });
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
      if (req.method === "GET" && url.pathname === "/app.css") {
        return new Response(appCss, {
          status: 200,
          headers: {
            "content-type": "text/css; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
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

        const reply = dispatch(parsed as { method: string; params?: unknown }, rpcContext);
        if (reply.ok) {
          return jsonResponse(reply, 200);
        }
        // Map error codes to HTTP status: unknown_method/bad_request → 400,
        // internal_error → 500 (unauthorized/forbidden_origin handled above).
        const status = reply.error.code === "internal_error" ? 500 : 400;
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

  // Rendered after `server` so the exposure payload can carry the real bound
  // port. Bun only invokes `fetch` once this synchronous setup completes, so
  // the closure's reference is always resolved by request time.
  const indexHtmlTemplate = renderIndexHtml(token, {
    exposed,
    host: bindHost,
    port: boundPort,
  });

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
    stop: () => server.stop(true),
  };
}
