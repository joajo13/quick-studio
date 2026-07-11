/**
 * quick-studio Sandbox (Ring 3) — the untrusted guest runtime.
 *
 * This is the ONLY code that runs inside the cross-origin `sandbox="allow-scripts"`
 * iframe. It receives already-public {@link FrozenData} pushed in by Ring 2, draws a
 * minimal deterministic table, and emits back ONLY render-lifecycle / interaction
 * signals ({@link SandboxOutbound}). It has no expressible way to request data or
 * trigger a query — the inbound union carries a single `render` frame and nothing else.
 *
 * Ring discipline (sacred): this module imports ONLY from `src/shared/` — never
 * `src/core`, `src/ui`, `ai`, `@ai-sdk/*`, or anything holding a secret. Data flows
 * outward only; capability never flows inward.
 *
 * House testing style (no DOM at test runtime): all real logic lives in the pure,
 * exported, injectable `createGuestRouter` / `buildFrozenHtml` / `resolveDatumClick`;
 * `document`/`window` are touched only in the thin {@link bootstrap} seam, which runs
 * exclusively inside a real browser (guarded by a `typeof document` check).
 */

import {
  SANDBOX_PROTOCOL_VERSION,
  isSandboxInbound,
  type FrozenCell,
  type FrozenData,
  type SandboxOutbound,
} from "../shared/contract.ts";

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

/** The minimal element shape `resolveDatumClick` walks: attributes + parent chain. */
export type DatumElement = {
  readonly getAttribute: (name: string) => string | null;
  readonly parentElement?: DatumElement | null;
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
   * Draw the frozen data and return the measured content height in CSS px. Pure in
   * tests (a stub); in the real bootstrap it writes the HTML and reads `scrollHeight`.
   */
  readonly render: (data: FrozenData) => number;
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
  /** Handle a click on a rendered element: emit `datum-clicked` when it hits a cell. */
  handleClick: (target: DatumElement | null) => void;
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
      const px = deps.render(event.data.data);
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

  function handleClick(target: DatumElement | null): void {
    if (pinned === null) return; // no parent pinned yet — nothing to signal
    const hit = resolveDatumClick(target);
    if (hit === null) return; // click landed off the grid
    deps.postToParent(
      { type: "datum-clicked", protocolVersion: SANDBOX_PROTOCOL_VERSION, row: hit.row, col: hit.col },
      pinned,
    );
  }

  return { handleMessage, handleClick, pinnedOrigin: () => pinned };
}

/* ------------------------------------------------------------------ *
 * Pure minimal draw — a compact clickable table
 * ------------------------------------------------------------------ */

/** Escape the five HTML-significant characters so a cell value can never inject markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render one tagged {@link FrozenCell} as its display text (never its raw object). */
function cellText(cell: FrozenCell): string {
  switch (cell.kind) {
    case "null":
      return "";
    case "string":
      return cell.value;
    case "number":
      return String(cell.value);
    case "boolean":
      return String(cell.value);
    case "date":
      return cell.iso;
    default: {
      const _exhaustive: never = cell;
      return String(_exhaustive);
    }
  }
}

/**
 * Build the minimal deterministic draw of `data`: a compact HTML table whose body
 * cells carry `data-row`/`data-col` grid coordinates so a click resolves to a datum.
 * Pure and total; every value is HTML-escaped. This is the 5.5 proof-of-loop draw —
 * Story 5.6 replaces the internals with MDX + Observable Plot; the channel is unchanged.
 */
export function buildFrozenHtml(data: FrozenData): string {
  const head = data.columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join("");
  const body = data.rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => `<td data-row="${r}" data-col="${c}">${escapeHtml(cellText(cell))}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table class="qs-frozen"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Resolve a clicked element to its `{row,col}` datum by reading `data-row`/`data-col`,
 * walking up the parent chain (a click can land on a descendant of the cell). Returns
 * `null` when no ancestor carries a well-formed non-negative-integer coordinate pair
 * (a click off the grid). Both attributes are matched against a strict decimal-only
 * pattern BEFORE `Number(...)`, so `""`→`0` or `"0x1f"`→`31` coercions can never forge
 * a bogus cell. Pure and total — never throws.
 */
const DECIMAL_ATTR_RE = /^\d+$/;

export function resolveDatumClick(el: DatumElement | null): { readonly row: number; readonly col: number } | null {
  let node: DatumElement | null | undefined = el;
  while (node) {
    const rowAttr = node.getAttribute("data-row");
    const colAttr = node.getAttribute("data-col");
    if (rowAttr !== null && colAttr !== null) {
      // Reject empty / non-decimal / hex-like attrs before `Number` coerces them.
      if (!DECIMAL_ATTR_RE.test(rowAttr) || !DECIMAL_ATTR_RE.test(colAttr)) {
        return null; // a data-cell with a malformed coordinate is off-grid
      }
      const row = Number(rowAttr);
      const col = Number(colAttr);
      if (Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0) {
        return { row, col };
      }
      return null; // a data-cell with a malformed coordinate is off-grid
    }
    node = node.parentElement ?? null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Thin browser bootstrap — the only DOM-touching seam
 * ------------------------------------------------------------------ */

/**
 * Wire the pure router to a real browser window/document: install the `message`
 * listener, draw into `document.body` and measure `scrollHeight`, and forward body
 * clicks. Exported for symmetry, but never invoked under `bun test` (no DOM) — the
 * module-level guard below runs it exclusively inside the guest iframe.
 */
export function bootstrap(win: Window, doc: Document): void {
  const router = createGuestRouter({
    postToParent: (frame, targetOrigin) => win.parent.postMessage(frame, targetOrigin),
    render: (data) => {
      doc.body.innerHTML = buildFrozenHtml(data);
      return doc.body.scrollHeight;
    },
    // Only the real embedder (`win.parent`) may drive the guest — a message from any
    // other window (e.g. an `opener` or a sibling frame) is not the parent and drops.
    isParentSource: (source) => source === win.parent,
  });
  win.addEventListener("message", (event: MessageEvent) => router.handleMessage(event));
  doc.body.addEventListener("click", (event: MouseEvent) =>
    router.handleClick(event.target as unknown as DatumElement | null),
  );
}

// Browser-only seam: run the bootstrap when a real DOM is present (inside the guest
// iframe). Under `bun test` `document` is undefined, so importing this module for the
// pure unit tests never touches the DOM.
if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootstrap(window, document);
}
