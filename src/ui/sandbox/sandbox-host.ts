/**
 * quick-studio UI (Ring 2) — the sandbox host controller (Story 5.5).
 *
 * The Ring 2 side of the one-way `postMessage` channel to the Ring 3 guest. It pushes
 * already-public {@link FrozenData} INTO the guest and routes the guest's outbound
 * SIGNALS ({@link SandboxOutbound}) to `onSignal`. It never returns data in response to
 * a guest message — there is no data-reply path here at all.
 *
 * The cross-origin `targetOrigin` nuance (get this wrong and containment leaks): the
 * guest runs under `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so its origin
 * is OPAQUE ("null"). Therefore (1) `pushData` posts with `targetOrigin: "*"` — you
 * cannot target an opaque origin, and `"*"` is safe because delivery is confined to
 * that ONE iframe window and the payload is only already-public frozen data (never a
 * secret); and (2) inbound is validated by window IDENTITY (`event.source ===
 * iframeWindow`) plus the opaque `"null"` origin — never by an origin string.
 *
 * Pure + injectable (no `document`): the React `SandboxFrame` seam owns the real
 * `window` listener and hands events to `handleMessage`. No `ai`/`@ai-sdk` import.
 */

import {
  SANDBOX_PROTOCOL_VERSION,
  isSandboxOutbound,
  type FrozenData,
  type SandboxInbound,
  type SandboxOutbound,
} from "../../shared/contract.ts";

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
  /** Push a `render` frame carrying canonical frozen data INTO the guest window. */
  pushData: (frozenData: FrozenData) => void;
  /** Route one inbound message to `onSignal` iff it is a real guest signal (else drop). */
  handleMessage: (event: HostMessageEvent) => void;
  /** Detach: after this, `pushData`/`handleMessage` are inert (unmount safety). */
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
 * `src` is the injected Ring 3 origin — but when that origin is empty or not an
 * `http(s)` URL, `src` falls back to `about:blank`. It is NEVER `""`: an empty `src`
 * resolves to the PARENT Core document, which would load the token-bearing page into
 * the `allow-scripts` frame — the opposite of containment. Pure.
 */
export function buildSandboxIframeAttrs(sandboxOrigin: string): SandboxIframeAttrs {
  const isHttpOrigin = /^https?:\/\//.test(sandboxOrigin);
  return { src: isHttpOrigin ? sandboxOrigin : "about:blank", sandbox: "allow-scripts" };
}

/**
 * Create the host controller. `pushData` posts a `render` frame to the iframe window
 * with `targetOrigin: "*"` (mandatory against an opaque-origin guest). `handleMessage`
 * accepts a message ONLY when it comes from the exact iframe window (`event.source ===
 * iframeWindow`), from the opaque `"null"` origin, AND passes `isSandboxOutbound`;
 * anything else is silently dropped. There is deliberately no branch that replies with
 * data. `dispose` flips the controller inert so a late message after unmount is a no-op.
 */
export function createSandboxHost(deps: SandboxHostDeps): SandboxHost {
  const { iframeWindow, onSignal } = deps;
  let disposed = false;

  function pushData(frozenData: FrozenData): void {
    if (disposed) return;
    const frame: SandboxInbound = {
      type: "render",
      protocolVersion: SANDBOX_PROTOCOL_VERSION,
      data: frozenData,
    };
    // `"*"` is required: an opaque-origin guest cannot be addressed by origin string.
    // Delivery is still confined to this one iframe window; the payload is public data.
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

  return { pushData, handleMessage, dispose };
}
