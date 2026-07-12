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

import type { ChatStreamChunk, ExposureInfo, RpcReply, TableRowsResult } from "../shared/contract.ts";
import { errorReply, okReply } from "../shared/contract.ts";
import { assembleLiveReportHtml } from "../shared/live-report-html.ts";
import { resolveModel } from "./ai-provider.ts";
import { mintSessionToken, validateOrigin, validateToken } from "./auth.ts";
import { deriveOpenUrl, isExposed, resolveBindHost } from "./binding.ts";
import { createChatResponder } from "./chat.ts";
import { createConnectionManager } from "./connection.ts";
import { createConnectionRegistry } from "./connection-registry.ts";
import { createConnectionTargets } from "./connection-targets.ts";
import type { DriverFactory } from "./driver.ts";
import { createExecutor } from "./executor.ts";
import { rowsToFrozenData } from "./frozen-map.ts";
import { createLiveReportRegistry } from "./live-report-registry.ts";
import { liveReportBundle } from "./live-report-bundle.generated.ts";
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
   * loopback port bound to the same host as Core. Ring 2 points the untrusted
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
 * `window.__QS_TOKEN__` and sends it on every `/rpc` call, reads
 * `window.__QS_EXPOSURE__` (known at boot, static) to render the Port-Exposure
 * Warning banner, and reads `window.__QS_SANDBOX_ORIGIN__` (Story 5.5) to point the
 * untrusted iframe `src` at the Ring 3 origin. The token is hex-filtered
 * belt-and-suspenders; the sandbox origin is URL-charset-filtered the same way; the
 * exposure payload (arbitrary `host`) leans on `scriptJson`'s `<script>`-safe
 * escaping. Exported for unit-testing the injection without booting a real server.
 */
export function renderIndexHtml(token: string, exposure: ExposureInfo, sandboxOrigin: string): string {
  const safeToken = token.replace(/[^0-9a-fA-F]/g, "");
  // Keep only characters valid in an `http://host:port` origin (scheme, host,
  // IPv6 brackets, port) — a belt-and-suspenders filter before `scriptJson` escapes
  // for the `<script>` context, mirroring the token's hex filter.
  const safeSandboxOrigin = sandboxOrigin.replace(/[^a-zA-Z0-9:/._[\]-]/g, "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>quick-studio</title>
    <link rel="stylesheet" href="/app.css" />
    <script>window.__QS_TOKEN__ = ${scriptJson(safeToken)};</script>
    <script>window.__QS_EXPOSURE__ = ${scriptJson(exposure)};</script>
    <script>window.__QS_SANDBOX_ORIGIN__ = ${scriptJson(safeSandboxOrigin)};</script>
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
  const connectionRegistry = createConnectionRegistry({ storeDeps: { mode } });

  // Workspace-state registry (Story 2.5): the sole Workspace-store holder for
  // `workspace.load`/`workspace.save`. Same lazy-open, mode-gated posture as
  // `connectionRegistry` — Ephemeral stays a hard no-write (the store's open is a
  // pure in-memory no-op, never touching the app dir).
  const workspaceRegistry = createWorkspaceRegistry({ storeDeps: { mode } });

  // AI provider-key registry (Story 5.1): the sole provider-key-store holder for
  // the AI-providers Settings surface. Same lazy-open, mode-gated posture as the
  // connection registry — Ephemeral stays a hard no-write (its store open is a pure
  // in-memory no-op), and the raw key never leaves Ring 1 (summaries are secret-free).
  const providerRegistry = createProviderRegistry({ storeDeps: { mode } });

  // Live Report registry (Story 6.4): holds published layout+SQL docs (never data, never a
  // credential, never a token) so the Core can serve them same-origin at `/live/<id>`. In-memory
  // + session-only — nothing touches disk (Persistent/Ephemeral-agnostic), and it dies with boot.
  const liveReportRegistry = createLiveReportRegistry();

  /**
   * Browse-rows capability (Story 3.2): validate the request against the live
   * introspected schema, compose the Core-owned read-only SELECT/COUNT (identifiers
   * schema-validated + `quoteIdent`-quoted, LIMIT/OFFSET integer literals), run both
   * on the live connection, and map the page to `FrozenData`. A validation failure
   * is a formed `bad_request`/`not_found` reply; a driver/connection throw is left
   * to propagate → `internal_error` (engine-neutral, credentials never echoed).
   */
  async function tableRows(params: unknown): Promise<RpcReply<TableRowsResult>> {
    const schema = await connectionManager.getSchema();
    const planned = planTableRows(schema, params, (ident) => connectionManager.quoteIdent(ident));
    if (!planned.ok) {
      return errorReply(planned.error.code, planned.error.message);
    }
    const { plan } = planned;
    const countResult = await connectionManager.query(plan.countSql);
    const total = readTotal(countResult.rows);
    const dataResult = await connectionManager.query(plan.selectSql);
    const data = rowsToFrozenData(
      plan.columns.map((c) => c.name),
      dataResult.rows,
    );
    return okReply({ data, page: plan.page, pageSize: plan.pageSize, total });
  }

  // Per-target connection resolver (Story 6.2): turns an optional saved-connection id
  // into the seams the executor runs over. The default (id null/absent) is the boot
  // manager, so the untargeted path is byte-identical. A target manager is created
  // lazily via the SAME driver factory, cached by id, self-invalidated against the
  // registry's `getStoredUrl` on every resolve (repoint/removal), and closed on
  // shutdown. Only the id crosses the loopback — the url is resolved in-Core here.
  const connectionTargets = createConnectionTargets({
    bootManager: connectionManager,
    getStoredUrl: (id) => connectionRegistry.getStoredUrl(id),
    createManager: (url) =>
      createConnectionManager({ databaseUrl: url, createDriver: options.createDriver }),
  });

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
  // caller. Closes over the single live schema source, the Core-internal `getKey`, and
  // the unified model resolver; the streaming call defaults to `streamText`, so every
  // `ai`/`@ai-sdk/*` touch stays in Ring 1 (chat.ts). Schema-only, zero rows leave.
  const chatResponder = createChatResponder({
    getSchema: () => connectionManager.getSchema(),
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
        // Idempotent open+introspect; a live connection is reused across calls.
        connect: () => connectionManager.connect(),
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
  // port bound to the SAME host — a genuinely separate origin serving only the
  // untrusted guest doc + its bundle under a locked-down CSP. Started synchronously
  // (Bun.serve binds before returning) so its origin is known before the HTML shell
  // is rendered. Torn down alongside the Core in `stop()`.
  const startSandbox = options.startSandboxServer ?? startSandboxServer;
  const sandboxServer = startSandbox({ host: bindHost, port: 0, bundle: sandboxBundle });
  const sandboxOrigin = sandboxServer.origin;

  // Rendered after `server` so the exposure payload can carry the real bound
  // port. Bun only invokes `fetch` once this synchronous setup completes, so
  // the closure's reference is always resolved by request time.
  const indexHtmlTemplate = renderIndexHtml(
    token,
    { exposed, host: bindHost, port: boundPort },
    sandboxOrigin,
  );

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
      try {
        await sandboxServer.stop();
      } finally {
        await server.stop(true);
      }
    },
  };
}
