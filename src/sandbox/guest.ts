/**
 * quick-studio Sandbox (Ring 3) — the untrusted guest runtime.
 *
 * This is the ONLY code that runs inside the cross-origin `sandbox="allow-scripts"`
 * iframe. It receives a validated {@link SandboxRenderDoc} pushed in by Ring 2, draws
 * escaped Markdown + an optional Observable Plot chart, and emits back ONLY render-
 * lifecycle signals ({@link SandboxOutbound}). It has no expressible way to request data
 * or trigger a query — the inbound union carries a single `render` frame and nothing else.
 *
 * Ring discipline (sacred): this module imports ONLY from `src/shared/` + the render libs
 * (`@observablehq/plot`, `micromark`, via `./render.ts`) — never `src/core`, `src/ui`,
 * `ai`, `@ai-sdk/*`, or anything holding a secret. Data flows outward only; capability
 * never flows inward.
 *
 * House testing style (no DOM at test runtime): all real logic lives in the pure,
 * exported, injectable `createGuestRouter` / `composeRender`; `document`/`window` are
 * touched only in the thin {@link bootstrap} seam, which runs exclusively inside a real
 * browser (guarded by a `typeof document` check).
 */

import {
  SANDBOX_PROTOCOL_VERSION,
  isSandboxInbound,
  type SandboxOutbound,
  type SandboxRenderDoc,
} from "../shared/contract.ts";
import type { PlotOptions } from "@observablehq/plot";
import { buildPlotOptions, renderMarkdownToHtml } from "./render.ts";
import * as Plot from "@observablehq/plot";

/* ------------------------------------------------------------------ *
 * Pure guest router — handshake, guard, render, signal-out
 * ------------------------------------------------------------------ */

/** The minimal `MessageEvent` shape the guest reads: the sender window + origin + payload. */
export type GuestMessageEvent = {
  /** The posting window (`event.source`) — checked against the real parent window. */
  readonly source?: unknown;
  readonly origin: string;
  readonly data: unknown;
};

/** The seams the pure router needs from its host environment. */
export type GuestRouterDeps = {
  /**
   * Post a signal back to the pinned parent. `targetOrigin` is the REAL parent
   * origin the guest pinned from the first inbound frame — guest -> parent signals
   * are always origin-pinned (never `"*"`).
   */
  readonly postToParent: (frame: SandboxOutbound, targetOrigin: string) => void;
  /**
   * Draw the render doc (escaped Markdown + optional validated chart + its data) and
   * return the measured content height in CSS px. Pure in tests (a stub); in the real
   * bootstrap it composes the DOM (clear -> markdown -> chart) and reads `scrollHeight`.
   */
  readonly render: (doc: SandboxRenderDoc) => number;
  /**
   * True iff `source` (a message's `event.source`) is the guest's real parent window.
   * Threaded in so the parent identity is checkable without touching `window` in the
   * pure router — the real bootstrap passes `(src) => src === win.parent`, so a message
   * from any OTHER window (never the embedder) cannot perform the handshake.
   */
  readonly isParentSource: (source: unknown) => boolean;
};

export type GuestRouter = {
  /** Handle one inbound `postMessage`: handshake-pin, guard, render, emit signals. */
  handleMessage: (event: GuestMessageEvent) => void;
  /** The pinned parent origin, or `null` before the first valid handshake frame. */
  pinnedOrigin: () => string | null;
};

/**
 * Build the pure Ring 3 router. It pins the parent origin from the FIRST inbound
 * frame that both comes from the real parent window (`isParentSource`) and passes
 * {@link isSandboxInbound} (the handshake), and thereafter drops any frame from a
 * different origin. A non-parent sender, or a malformed / wrong-tag / wrong-version
 * frame, is dropped WITHOUT pinning and WITHOUT any outbound — so a `run-query`/
 * `data-request`/garbage message from any window can neither corrupt the pin nor draw
 * a reply. On a valid `render` it draws via `render` and emits `ready` then `height`;
 * a render throw becomes a terse `error` signal (never data). Total: no path throws.
 */
export function createGuestRouter(deps: GuestRouterDeps): GuestRouter {
  let pinned: string | null = null;

  function handleMessage(event: GuestMessageEvent): void {
    // Sender gate FIRST: only the real parent window may talk to the guest, so a
    // non-parent window can never perform the handshake (defense beyond origin-pin).
    if (!deps.isParentSource(event.source)) return;
    // Guard: a malformed frame never pins the origin and never renders.
    if (!isSandboxInbound(event.data)) return;
    // Handshake: the first valid inbound frame pins the parent origin; a later
    // valid frame from any other origin is dropped (wrong-origin inbound).
    if (pinned === null) {
      pinned = event.origin;
    } else if (event.origin !== pinned) {
      return;
    }
    const target = pinned;
    try {
      const px = deps.render({
        markdown: event.data.markdown,
        chart: event.data.chart,
        data: event.data.data,
      });
      deps.postToParent({ type: "ready", protocolVersion: SANDBOX_PROTOCOL_VERSION }, target);
      deps.postToParent({ type: "height", protocolVersion: SANDBOX_PROTOCOL_VERSION, px }, target);
    } catch (err) {
      deps.postToParent(
        {
          type: "error",
          protocolVersion: SANDBOX_PROTOCOL_VERSION,
          message: err instanceof Error ? err.message : "render failed",
        },
        target,
      );
    }
  }

  return { handleMessage, pinnedOrigin: () => pinned };
}

/* ------------------------------------------------------------------ *
 * Pure render compose — clear → prose → chart(-or-error) → measure
 * ------------------------------------------------------------------ */

/**
 * The minimal DOM surface {@link composeRender} needs, injected so the compose ORDER +
 * error handling are unit-testable with a fake host (no real DOM). The real bootstrap
 * wires these to `document`; a test wires them to spies (incl. a THROWING
 * `appendChartNode`, to prove a Plot throw still yields a measured height).
 */
export type RenderHost = {
  /** Clear the prior draw (`document.body.replaceChildren()` in the real seam). */
  readonly reset: () => void;
  /** Append the escaped-Markdown prose node (its `innerHTML` set from `html`). */
  readonly appendProse: (html: string) => void;
  /** Build + append the Observable Plot node from `options` (MAY throw on a bad channel). */
  readonly appendChartNode: (options: PlotOptions) => void;
  /** Append a small inline note when the chart failed to render (never data). */
  readonly appendErrorNote: (message: string) => void;
  /** Measure the composed content height in CSS px (`scrollHeight` in the real seam). */
  readonly measure: () => number;
};

/**
 * Compose one render into `host`: clear the prior draw, append the escaped-Markdown prose,
 * then (when a validated chart is present) append the Plot node. RESILIENT to a `Plot.plot`
 * throw (Story 5.6, P4): a type-mismatched channel makes Plot throw, but instead of bubbling
 * out — which would skip the height signal and freeze the frame at its old size — we append a
 * small inline error note and STILL return the measured height. So `ready`+`height` are always
 * emitted once prose rendered. Returns the measured content height. Pure over its injected host.
 */
export function composeRender(renderDoc: SandboxRenderDoc, host: RenderHost): number {
  host.reset();
  host.appendProse(renderMarkdownToHtml(renderDoc.markdown));
  if (renderDoc.chart !== null) {
    try {
      host.appendChartNode(buildPlotOptions(renderDoc.chart, renderDoc.data));
    } catch (err) {
      // A Plot throw must NOT skip the height measurement — render prose + a note instead.
      host.appendErrorNote(err instanceof Error ? err.message : "chart failed to render");
    }
  }
  return host.measure();
}

/* ------------------------------------------------------------------ *
 * Thin browser bootstrap — the only DOM-touching seam
 * ------------------------------------------------------------------ */

/**
 * Wire the pure router to a real browser window/document: install the `message`
 * listener and draw into `document.body`, measuring `scrollHeight`. Exported for
 * symmetry, but never invoked under `bun test` (no DOM) — the module-level guard below
 * runs it exclusively inside the guest iframe.
 */
export function bootstrap(win: Window, doc: Document): void {
  const router = createGuestRouter({
    postToParent: (frame, targetOrigin) => win.parent.postMessage(frame, targetOrigin),
    // Compose the draw from validated declarative inputs (Story 5.6) via the pure
    // {@link composeRender}: clear the prior draw, append the escaped-Markdown prose node,
    // then (if a validated chart is present) append the Observable Plot node — falling back
    // to a small inline note if Plot throws — and finally measure `scrollHeight`.
    // `replaceChildren()` is what clears a stale draw when an empty frame is pushed.
    render: (renderDoc) =>
      composeRender(renderDoc, {
        reset: () => doc.body.replaceChildren(),
        appendProse: (html) => {
          const prose = doc.createElement("div");
          prose.className = "qs-prose";
          // micromark output is HTML-escaped (raw HTML disabled) and the CSP blocks inline
          // handlers, so writing it to innerHTML cannot execute model-authored markup.
          prose.innerHTML = html;
          doc.body.appendChild(prose);
        },
        appendChartNode: (options) => {
          const chartNode = Plot.plot(options);
          doc.body.appendChild(chartNode as unknown as Node);
        },
        appendErrorNote: (message) => {
          const note = doc.createElement("p");
          note.className = "qs-chart-error";
          note.textContent = `chart failed to render: ${message}`;
          doc.body.appendChild(note);
        },
        measure: () => doc.body.scrollHeight,
      }),
    // Only the real embedder (`win.parent`) may drive the guest — a message from any
    // other window (e.g. an `opener` or a sibling frame) is not the parent and drops.
    isParentSource: (source) => source === win.parent,
  });
  win.addEventListener("message", (event: MessageEvent) => router.handleMessage(event));
}

// Browser-only seam: run the bootstrap when a real DOM is present (inside the guest
// iframe). Under `bun test` `document` is undefined, so importing this module for the
// pure unit tests never touches the DOM.
if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootstrap(window, document);
}
