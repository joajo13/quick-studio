/**
 * quick-studio UI (Ring 2) — the sandbox iframe component (Story 5.5; hardened in 5.6).
 *
 * A thin React seam over the pure {@link createSandboxHost} controller. It renders the
 * untrusted guest in a cross-origin `sandbox="allow-scripts"` iframe (NEVER
 * `allow-same-origin`) pointed at the injected Ring 3 origin, wires the window `message`
 * listener to the controller, pushes the current render `doc` (escaped Markdown + optional
 * validated chart + canonical frozen data) into the guest, applies the guest's `height`
 * signal to size the frame, and forwards `datum-clicked` / `error` to its callbacks.
 *
 * Story-5.6 hardening (folded 5.5 deferrals):
 *  1. **Rebind on `load`.** The host is (re)built from the iframe's LIVE `contentWindow`
 *     on every iframe `load` event (not once at mount), then the current doc is re-pushed
 *     — a reloaded / late-window guest gets a live channel and its draw, never a silently
 *     dead channel.
 *  2. **Clear on `doc:null`.** A `null` doc pushes an EMPTY frame ({@link EMPTY_RENDER_DOC})
 *     so the guest `replaceChildren` clears the prior draw (no stale chart/prose).
 *  3. **Coalesce `height`.** A flood of `height` signals collapses to ONE applied height
 *     per animation frame ({@link createHeightCoalescer}) — no layout thrash.
 *
 * The static structure is asserted via `react-dom/server` `renderToStaticMarkup` (no DOM
 * at test runtime); the hardening logic lives in the pure, exported `pushRenderDoc` /
 * `createHeightCoalescer` / `EMPTY_RENDER_DOC` seams, tested directly with stubs.
 */

import { useEffect, useRef, useState } from "react";
import { FROZEN_SCHEMA_VERSION, type SandboxRenderDoc } from "../../shared/contract.ts";
import { buildSandboxIframeAttrs, createSandboxHost, type SandboxHost } from "./sandbox-host.ts";

declare global {
  interface Window {
    __QS_SANDBOX_ORIGIN__?: string;
  }
}

/**
 * The injected Ring 3 origin (`window.__QS_SANDBOX_ORIGIN__`, set by Core in the served
 * HTML). Read via `globalThis` so it is safe to evaluate without a DOM (returns "").
 */
export function resolveSandboxOrigin(): string {
  return (globalThis as { __QS_SANDBOX_ORIGIN__?: string }).__QS_SANDBOX_ORIGIN__ ?? "";
}

/**
 * The empty render doc pushed when `doc` is `null`: empty Markdown, no chart, and an
 * empty (but well-formed) {@link SandboxRenderDoc}`.data`. The guest's `replaceChildren`
 * then clears the prior draw — clearing a message/tab leaves no stale chart or prose.
 */
export const EMPTY_RENDER_DOC: SandboxRenderDoc = {
  markdown: "",
  chart: null,
  data: { schemaVersion: FROZEN_SCHEMA_VERSION, columns: [], rows: [] },
};

/** Push `doc` into the guest via `host`, or the empty clearing frame when `doc` is `null`. */
export function pushRenderDoc(host: Pick<SandboxHost, "pushDoc"> | null, doc: SandboxRenderDoc | null): void {
  host?.pushDoc(doc ?? EMPTY_RENDER_DOC);
}

/**
 * Bind the host to the iframe's LIVE window, RETRYING when the window is not yet available
 * (hardening / Story-5.6 P10). The iframe `load` event can fire while `contentWindow` is
 * still `null` (a late window); the old code bailed once and never rebuilt, permanently
 * dead-ending the channel. This instead re-checks on each scheduled tick (default `rAF`)
 * up to `maxAttempts` times, so a window that becomes available a frame later still rebinds
 * — while a genuinely window-less frame gives up after a bounded number of tries rather than
 * spinning forever. `build` runs exactly once, on the first tick a window exists. Returns a
 * canceller (call on teardown) that stops any pending retry. Pure over its injected seams.
 */
export function rebindHost<W>(
  getWindow: () => W | null | undefined,
  build: (win: W) => void,
  schedule: (cb: () => void) => number = (cb) => globalThis.requestAnimationFrame(cb),
  cancel: (handle: number) => void = (handle) => globalThis.cancelAnimationFrame(handle),
  maxAttempts = 60,
): () => void {
  let cancelled = false;
  let handle: number | null = null;
  let attempts = 0;
  const attempt = (): void => {
    if (cancelled) return;
    handle = null;
    const win = getWindow();
    if (win) {
      build(win);
      return;
    }
    // Window not ready yet — retry next tick rather than dead-ending, bounded so a
    // genuinely window-less frame cannot spin forever.
    if (attempts++ < maxAttempts) handle = schedule(attempt);
  };
  attempt();
  return () => {
    cancelled = true;
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
  };
}

/**
 * A height coalescer: a flood of `push(px)` calls collapses to ONE `apply(px)` (the LAST
 * value) per scheduled tick. `schedule`/`cancel` default to `requestAnimationFrame`/
 * `cancelAnimationFrame` (referenced lazily via `globalThis`, so creating a coalescer is
 * DOM-free — the default is only *called* inside a browser effect); tests inject a manual
 * scheduler to drive the tick deterministically.
 */
export function createHeightCoalescer(
  apply: (px: number) => void,
  schedule: (cb: () => void) => number = (cb) => globalThis.requestAnimationFrame(cb),
  cancel: (handle: number) => void = (handle) => globalThis.cancelAnimationFrame(handle),
): { push: (px: number) => void; cancel: () => void; pending: () => boolean } {
  let pending: number | null = null;
  let handle: number | null = null;
  return {
    push(px: number): void {
      pending = px;
      if (handle !== null) return;
      handle = schedule(() => {
        handle = null;
        if (pending !== null) apply(pending);
      });
    },
    cancel(): void {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
    },
    pending: () => handle !== null,
  };
}

export type SandboxFrameProps = {
  /** The render doc to draw in the guest; `null` pushes an empty frame that clears it. */
  readonly doc: SandboxRenderDoc | null;
  /** Called with the grid coordinates when the user clicks a rendered cell. */
  readonly onDatumClicked?: (row: number, col: number) => void;
  /** Called with a terse message if the guest reports a render failure. */
  readonly onError?: (message: string) => void;
  /** Override the injected origin (tests). Defaults to `window.__QS_SANDBOX_ORIGIN__`. */
  readonly sandboxOrigin?: string;
};

/** A sane upper bound on the guest-reported height, clamped before it sizes the frame. */
const MAX_FRAME_HEIGHT = 20000;

export function SandboxFrame({ doc, onDatumClicked, onError, sandboxOrigin }: SandboxFrameProps): React.JSX.Element {
  const origin = sandboxOrigin ?? resolveSandboxOrigin();
  const attrs = buildSandboxIframeAttrs(origin);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<SandboxHost | null>(null);
  // Bumped on every iframe `load` so the host-build effect re-runs against the LIVE
  // contentWindow (hardening #1). Starts 0; the first `load` bumps it to 1.
  const [loadNonce, setLoadNonce] = useState(0);
  const [height, setHeight] = useState<number | undefined>(undefined);

  // Latest-value refs so an inline callback / new doc identity never tears down the host
  // (it is rebuilt only on iframe `load`). Updated on each render.
  const onDatumClickedRef = useRef(onDatumClicked);
  const onErrorRef = useRef(onError);
  const docRef = useRef(doc);
  onDatumClickedRef.current = onDatumClicked;
  onErrorRef.current = onError;
  docRef.current = doc;

  // One height coalescer for the component's lifetime (hardening #3). Created lazily in a
  // ref so it survives re-renders; DOM-free to construct (the rAF default is only called
  // from within the browser effect).
  const coalescerRef = useRef<ReturnType<typeof createHeightCoalescer> | null>(null);
  if (coalescerRef.current === null) {
    coalescerRef.current = createHeightCoalescer((px) => setHeight(px));
  }

  // (Re)build the host from the iframe's live contentWindow on every `load` (hardening #1),
  // install the single window `message` listener, and re-push the current doc. Resilient to
  // a null `contentWindow` at load: `rebindHost` retries until the window exists (P10), so a
  // late/reloaded window still gets a live channel, never a silently dead one. Torn down
  // (listener removed + controller disposed + pending retry cancelled) on unmount / rebuild.
  useEffect(() => {
    let host: SandboxHost | null = null;
    const listener = (event: MessageEvent): void => host?.handleMessage(event);
    window.addEventListener("message", listener);
    const cancelRebind = rebindHost(
      () => iframeRef.current?.contentWindow,
      (win) => {
        host = createSandboxHost({
          iframeWindow: win,
          onSignal: (signal) => {
            switch (signal.type) {
              case "ready":
                break; // draw acknowledged; height follows immediately
              case "height":
                coalescerRef.current?.push(signal.px); // coalesced apply (hardening #3)
                break;
              case "datum-clicked":
                onDatumClickedRef.current?.(signal.row, signal.col);
                break;
              case "error":
                onErrorRef.current?.(signal.message);
                break;
              default: {
                const _exhaustive: never = signal;
                void _exhaustive;
              }
            }
          },
        });
        hostRef.current = host;
        // Re-push the current doc so a reloaded guest immediately re-draws its content.
        pushRenderDoc(host, docRef.current);
      },
    );
    return () => {
      cancelRebind();
      window.removeEventListener("message", listener);
      host?.dispose();
      hostRef.current = null;
    };
  }, [loadNonce]);

  // Push the current doc (or the empty clearing frame on `null`, hardening #2) on every
  // change, once a host exists. The load effect owns the initial/post-reload push.
  useEffect(() => {
    pushRenderDoc(hostRef.current, doc);
  }, [doc]);

  // Cancel any pending height frame on unmount (no post-unmount setState).
  useEffect(() => () => coalescerRef.current?.cancel(), []);

  // Clamp the guest-reported height to a sane max so a hostile/oversized signal cannot
  // blow the frame up to an absurd size (the guard already floors it at >= 0).
  const appliedHeight = height === undefined ? 120 : Math.min(height, MAX_FRAME_HEIGHT);

  return (
    <iframe
      ref={iframeRef}
      src={attrs.src}
      sandbox={attrs.sandbox}
      title="quick-studio sandbox"
      onLoad={() => setLoadNonce((n) => n + 1)}
      style={{ width: "100%", height: appliedHeight, border: 0 }}
    />
  );
}
