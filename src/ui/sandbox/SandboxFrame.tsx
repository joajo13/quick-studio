/**
 * quick-studio UI (Ring 2) — the sandbox iframe component (Story 5.5).
 *
 * A thin React seam over the pure {@link createSandboxHost} controller. It renders the
 * untrusted guest in a cross-origin `sandbox="allow-scripts"` iframe (NEVER
 * `allow-same-origin`) pointed at the injected Ring 3 origin, wires the window
 * `message` listener to the controller, pushes the `data` prop into the guest once it
 * has loaded (and on every change), applies the guest's `height` signal to size the
 * frame, and forwards `datum-clicked` / `error` to its callbacks. All real routing
 * lives in the controller; this file only owns the DOM seam (listener + iframe element).
 *
 * The static structure is asserted via `react-dom/server` `renderToStaticMarkup` (no
 * DOM at test runtime): the `sandbox="allow-scripts"` attribute is present, the `src`
 * is the injected origin, and `allow-same-origin` is absent.
 */

import { useEffect, useRef, useState } from "react";
import type { FrozenData } from "../../shared/contract.ts";
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

export type SandboxFrameProps = {
  /** The frozen data to draw in the guest; `null` renders an empty guest. */
  readonly data: FrozenData | null;
  /** Called with the grid coordinates when the user clicks a rendered cell. */
  readonly onDatumClicked?: (row: number, col: number) => void;
  /** Called with a terse message if the guest reports a render failure. */
  readonly onError?: (message: string) => void;
  /** Override the injected origin (tests). Defaults to `window.__QS_SANDBOX_ORIGIN__`. */
  readonly sandboxOrigin?: string;
};

/** A sane upper bound on the guest-reported height, clamped before it sizes the frame. */
const MAX_FRAME_HEIGHT = 20000;

export function SandboxFrame({ data, onDatumClicked, onError, sandboxOrigin }: SandboxFrameProps): React.JSX.Element {
  const origin = sandboxOrigin ?? resolveSandboxOrigin();
  const attrs = buildSandboxIframeAttrs(origin);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<SandboxHost | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [height, setHeight] = useState<number | undefined>(undefined);

  // Latest-callback refs: the parent's `onDatumClicked`/`onError` are read through
  // stable refs so an inline (re-created every render) callback identity NEVER
  // recreates the host or re-installs the listener. Updated on each render.
  const onDatumClickedRef = useRef(onDatumClicked);
  const onErrorRef = useRef(onError);
  onDatumClickedRef.current = onDatumClicked;
  onErrorRef.current = onError;

  // Mount seam: build the controller over the iframe's contentWindow and install the
  // single window `message` listener EXACTLY ONCE per iframe (empty deps + a stable
  // `onSignal` that reads the callback refs), so callback identity changes cannot tear
  // down and rebuild the host. Torn down (listener removed + controller disposed) on
  // unmount so a late guest message after unmount is inert.
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const host = createSandboxHost({
      iframeWindow: win,
      onSignal: (signal) => {
        switch (signal.type) {
          case "ready":
            break; // draw acknowledged; height follows immediately
          case "height":
            setHeight(signal.px);
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
    const listener = (event: MessageEvent): void => host.handleMessage(event);
    window.addEventListener("message", listener);
    return () => {
      window.removeEventListener("message", listener);
      host.dispose();
      hostRef.current = null;
    };
  }, []);

  // Push the current data into the guest once it has loaded, and on every change. The
  // host is built once (above), so it is always present by the time `loaded` flips.
  useEffect(() => {
    if (loaded && data !== null) {
      hostRef.current?.pushData(data);
    }
  }, [loaded, data]);

  // Clamp the guest-reported height to a sane max so a hostile/oversized signal cannot
  // blow the frame up to an absurd size (the guard already floors it at >= 0).
  const appliedHeight = height === undefined ? 120 : Math.min(height, MAX_FRAME_HEIGHT);

  return (
    <iframe
      ref={iframeRef}
      src={attrs.src}
      sandbox={attrs.sandbox}
      title="quick-studio sandbox"
      onLoad={() => setLoaded(true)}
      style={{ width: "100%", height: appliedHeight, border: 0 }}
    />
  );
}
