/**
 * quick-studio Core — the Ring 3 sandbox origin (Story 5.5).
 *
 * A SECOND `Bun.serve` on a distinct loopback port — a genuinely separate origin
 * from the Core (a subpath cannot be a distinct origin; a distinct port is). It
 * serves ONLY the untrusted guest document + its own JS bundle, under a locked-down
 * CSP (`default-src 'none'; connect-src 'none'`). It exposes NO session token, NO
 * `/rpc`, NO `/chat/stream`, and no credentials — everything else is a bare 404.
 *
 * The guest served here is embedded by Ring 2 in a `sandbox="allow-scripts"` iframe
 * WITHOUT `allow-same-origin`, so the browser gives it an opaque origin and the two
 * layers of the boundary compose: cross-origin isolation + `connect-src 'none'` egress
 * block + a data-endpoint-free origin. Core's `stop()` tears this server down too.
 */

import { deriveOpenUrl } from "./binding.ts";

/** The injected guest bundle (defaults to the build-time generated module). */
export type SandboxBundle = {
  readonly js: string;
};

export type StartSandboxServerOptions = {
  /** Bind host — the SAME host Core binds (loopback by default). */
  readonly host: string;
  /** Port; `0` (default) picks an ephemeral port. */
  readonly port?: number;
  /** The guest JS bundle to serve at `/guest.js`. Injected so tests need no build. */
  readonly bundle: SandboxBundle;
};

export type SandboxServer = {
  /** The actual bound port (resolved even when `0` was requested). */
  readonly port: number;
  /**
   * The NAVIGABLE origin (`http://<host>:<port>`) Ring 2 points the iframe `src` at.
   * Derived via {@link deriveOpenUrl} so a wildcard/IPv6/exposed bind maps to a host a
   * browser can actually reach: `0.0.0.0`→`127.0.0.1`, `::`/`::1`→`[::1]`, bare IPv6
   * bracketed. The server still BINDS the raw `host`; only this string is normalized.
   */
  readonly origin: string;
  /** Stop the server and release the port. May be awaited. */
  stop(): void | Promise<void>;
};

/**
 * The exact guest-document CSP (Story 5.5 contract). `default-src 'none'` denies
 * everything not explicitly re-allowed; `script-src 'self'` permits only the same-
 * origin `/guest.js` (never inline script); `style-src 'unsafe-inline'` allows the
 * doc's own `<style>`; `img-src data:` permits inline data-URI images; `connect-src
 * 'none'` is the egress block (no fetch/XHR/WebSocket/EventSource can leave); and
 * `base-uri 'none'` / `form-action 'none'` close the remaining exfil vectors.
 *
 * `frame-ancestors` is intentionally NOT set: the guest is embedded by the Core
 * document, which lives on a DIFFERENT loopback port (a different origin), so any
 * origin-exact `frame-ancestors` value (`'self'`, or the guest's own origin) would
 * make a spec-compliant browser REFUSE to render the guest in the Core iframe and
 * break the entire Ring 2 -> Ring 3 loop. Clickjacking is a non-threat here: the
 * guest holds no session token, no ambient authority, and no secret to steal, and it
 * only ever accepts data from — and emits signals to — its pinned parent window.
 */
const GUEST_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Headers for the guest HTML document: the locked-down CSP + `nosniff` + `no-store`.
 * Pure builder, exported for unit-testing the exact header set without a live server.
 */
export function sandboxCspHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": GUEST_CSP,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
}

/** Headers for the guest JS bundle: same-origin script, `nosniff`, `no-store`. */
function guestJsHeaders(): Record<string, string> {
  return {
    "content-type": "text/javascript; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
}

/**
 * Render the guest HTML document. Pure and static: it carries NO token and NO inline
 * data — it only loads the same-origin `/guest.js` module (the sole script the CSP
 * admits) and its own inline `<style>`. Ring 2 pushes the frozen data in over
 * `postMessage` after load; nothing sensitive is ever baked into this markup.
 * Exported for unit-testing the served body without booting a server.
 */
export function renderGuestHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>quick-studio sandbox</title>
    <style>
      body { margin: 0; font: 13px/1.45 system-ui, sans-serif; color: #1a1a1a; }
      table.qs-frozen { border-collapse: collapse; width: 100%; }
      .qs-frozen th, .qs-frozen td { border: 1px solid #d0d0d0; padding: 2px 6px; text-align: left; }
      .qs-frozen th { background: #f4f4f4; font-weight: 600; }
      .qs-frozen td { cursor: pointer; }
      .qs-frozen td:hover { background: #eef4ff; }
    </style>
  </head>
  <body>
    <script type="module" src="/guest.js"></script>
  </body>
</html>
`;
}

/**
 * Boot the sandbox origin. Serves `GET /` (+ `/index.html`) as the guest document
 * and `GET /guest.js` as the injected bundle; EVERYTHING else — including `/rpc`,
 * `/chat/stream`, and any other path or method — is a bare 404 with no dispatch and
 * no token in any response. Resolves once listening; wired into Core's `stop()`.
 */
export function startSandboxServer(options: StartSandboxServerOptions): SandboxServer {
  const { host, port = 0, bundle } = options;
  const guestHtml = renderGuestHtml();

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(req): Response {
      const url = new URL(req.url);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(guestHtml, { status: 200, headers: sandboxCspHeaders() });
      }
      if (req.method === "GET" && url.pathname === "/guest.js") {
        return new Response(bundle.js, { status: 200, headers: guestJsHeaders() });
      }
      // No data endpoints exist on this origin — /rpc, /chat/stream, and everything
      // else is a bare 404. No token, no credentials, no dispatch.
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
      });
    },
  });

  const boundPort = server.port ?? 0;
  return {
    port: boundPort,
    // Navigable form (wildcard/IPv6 remapped + bracketed) — the raw `host` is what the
    // server BINDS above, but the iframe `src` / injected origin must be reachable.
    origin: deriveOpenUrl(host, boundPort),
    stop: () => server.stop(true),
  };
}
