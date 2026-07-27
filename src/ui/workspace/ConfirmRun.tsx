/**
 * quick-studio UI (Ring 2) — shared destructive-run confirm dialog (Story 3.6,
 * extracted in Story 5.3, redesigned to the neutral look in Story 7.3, hardened to
 * an actually-modal dialog with guarded dormant props in DW-59..DW-63).
 *
 * Purely presentational — a neutral scrim + `alertdialog` card ported from
 * `design-artifacts/confirm-destructive.html`. Destructive red appears ONLY on the
 * functional destructive bits: the danger icon, the affected-rows badge and the
 * statement's left border all take `--err` directly, while the filled Confirm
 * button carries an `--err` rim over an `--err-fill` body (DW-58 — `--err` under
 * white text is 3.04:1, below AA, so the darker fill carries the label at 5.65:1
 * and the lighter rim stays as the button's 1.4.11 boundary against the `--muted`
 * footer: 5.10:1 in the dark theme, which is the only one the app activates today).
 * Everything else is neutral / ink. There is NO top color line — the card reads
 * from its shadow + hairline ring alone.
 *
 * The caller owns ALL state (which SQL is pending, `busy`, re-entrancy) and the
 * gate — this component never calls `execute` itself, it only reports the two
 * intents. Confirming re-issues the IDENTICAL request with `confirmed:true`; the
 * Core guarded executor remains the sole real gate. The `busy` disable and the
 * optional type-to-confirm friction are UX only, never the gate.
 *
 * `sql`/`risk`/`busy`/`onConfirm`/`onCancel` are the base props every caller
 * (`QueryTabView`, `ChatTabView`, `ReportTabView`) passes. The three optional
 * props (`affectedRows`, `dependents`, `objectName`) have NO Core source today —
 * the `confirmation_required` preview carries only `sql` + `risk` — so each is
 * rendered ONLY when a future story supplies it, and all three callers keep
 * rendering the base modal unchanged.
 *
 * Modality (DW-59/DW-60): the scrim + card are owned by the nested `ModalOverlay`,
 * which portals to `document.body` (so a future `transform`/`filter` ancestor on
 * any caller can never mis-anchor it), traps Tab focus over its own focusable
 * descendants, marks the `document.body` children that exist AT MOUNT `inert`
 * (a snapshot, not a live observer — a portal container appended later is not
 * covered), restores focus to whatever held it before the dialog opened, and
 * dismisses on a scrim press. That last one means `onCancel` can now fire from a
 * stray press on the scrim padding, not only from the Cancel button — safe by
 * direction (cancelling executes nothing) but callers should not treat `onCancel`
 * as deliberate. `ConfirmRun` itself passes the card in as `children` and stays
 * hook-free — see the docblock on `ModalOverlay` for why. Under
 * `renderToStaticMarkup` (no jsdom in this repo) `document` is undefined, so the
 * portal guard renders the scrim in-tree instead, keeping every existing structural
 * assertion intact; in the browser the same markup is reparented to `body`.
 * `ModalOverlay` takes the dialog as opaque `children` — extractable to a shared
 * module the day a second modal ships. What it deliberately does NOT do: lock
 * background SCROLLING (`inert` blocks focus and pointer events, not the wheel), so
 * the page still scrolls behind the scrim.
 *
 * The three dormant escalated props are guarded by DOM-free pure helpers so their
 * edge cases are unit-testable without a renderer: `affectedRowsBadge` refuses to
 * paint a red destruction claim for `0`/negative/non-finite/non-integer counts
 * (DW-61), `typeToConfirmTarget`/`typeToConfirmMatches` refuse to mount the gate for
 * a blank/whitespace `objectName` and trim BOTH sides of the comparison (DW-62),
 * and the type-to-confirm `<input>` now disables alongside the footer while `busy`
 * (DW-63).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** One foreign-key dependency line shown under the statement (only when supplied). */
export type ConfirmRunDependent = { from: string; to: string };

type ConfirmRunProps = {
  /** The exact SQL that was sent and is awaiting confirmation (frozen, not the draft). */
  sql: string;
  /** The Core's human-readable risk description from the `confirmation_required` preview. */
  risk: string;
  /** A confirm/cancel round-trip is in flight — both buttons disable to avoid a double-fire. */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional preview: rows the statement destroys — renders a red badge beside "Statement". */
  affectedRows?: number;
  /** Optional preview: FK dependents — renders `from → FK → to` line(s) under the statement. */
  dependents?: readonly ConfirmRunDependent[];
  /** Optional escalated friction: the object name a user must type before Confirm enables. */
  objectName?: string;
};

/**
 * DW-61: the affected-rows badge is a truthful count, not an automatic alarm. A
 * count is only "destructive" red when it is a finite, non-negative INTEGER > 0 —
 * `NaN`/`Infinity`/negatives/fractions are bad upstream data and must not paint a
 * destruction claim at all (dropped silently, no badge), and `0` is valid data but
 * reads as reassurance, not danger, so it gets its own neutral copy instead of a
 * red "0 rows".
 */
export function affectedRowsBadge(
  value?: number,
): { count: string; noun: string; destructive: boolean } | null {
  if (value === undefined) return null;
  // `isSafeInteger` is the whole guard: it is false for `NaN`/`±Infinity` and for
  // fractions, AND it rejects counts past 2^53, where `String(value)` would render
  // exponential notation ("1e+21 rows"). A separate `isFinite` check would be dead.
  if (!Number.isSafeInteger(value) || value < 0) return null;
  if (value === 0) return { count: "0", noun: "No rows", destructive: false };
  return { count: String(value), noun: value === 1 ? "row" : "rows", destructive: true };
}

/**
 * DW-62: the type-to-confirm gate only exists for a real object name. Trims the
 * prop so a blank or whitespace-only `objectName` (falsy intent, likely an unset
 * upstream field) never mounts the gate; returns `null` in that case so callers can
 * gate the footer with a single check.
 */
export function typeToConfirmTarget(objectName?: string): string | null {
  if (objectName === undefined) return null;
  const trimmed = objectName.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * DW-62: the ORIGINAL bug trimmed only the typed side, so a target carrying
 * incidental whitespace (e.g. `"  public.orders  "`) could never be matched by
 * typing its visible text. Both sides are trimmed here — `target` is normally
 * already the trimmed output of `typeToConfirmTarget`, but trimming it again is
 * free and keeps this helper correct standalone.
 */
export function typeToConfirmMatches(typed: string, target: string): boolean {
  const trimmedTarget = target.trim();
  // A blank target carries no friction to satisfy, so matching it would let an EMPTY
  // input pass the gate. `ConfirmRun` can't reach this (the gate only mounts for a
  // `typeToConfirmTarget` result, non-blank by construction), but this is an exported
  // helper and `false` is the safe direction for a confirm predicate.
  if (trimmedTarget === "") return false;
  return typed.trim() === trimmedTarget;
}

/**
 * The pure half of the Tab/Shift+Tab focus trap: given how many focusable
 * descendants the scrim has and which index currently holds focus, returns the
 * index to move to, wrapping at either end. `current === -1` (focus not found
 * among the tracked focusables, e.g. nothing focused yet) treats forward Tab as
 * "start from the top" and Shift+Tab as "start from the bottom". `count <= 0`
 * (every control disabled while `busy`) has no valid index — callers must
 * `preventDefault` and stop without consulting the return value.
 */
export function nextTrapIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (backwards) return current <= 0 ? count - 1 : current - 1;
  return current >= count - 1 ? 0 : current + 1;
}

/**
 * DW-59: the scrim-press dismiss predicate, kept pure so its three cases are
 * unit-testable in a repo with no DOM. Only a press landing on the scrim ITSELF
 * dismisses — a press that bubbled up from the card, the `<pre>` or a button has a
 * different `target` and must not cancel — and never mid-round-trip, matching
 * Esc/Cancel being inert while `busy`.
 */
export function isScrimDismiss(
  e: { target: EventTarget | null; currentTarget: EventTarget | null; button: number },
  busy: boolean,
): boolean {
  // PRIMARY button only. `mousedown` fires for every button, so without this a
  // right-click (opening the context menu over the scrim) or a middle-click (X11
  // paste, auto-scroll) would cancel a pending destructive confirmation.
  if (e.button !== 0) return false;
  // `currentTarget !== null` first: a synthetic/targetless event would otherwise
  // satisfy `null === null` and cancel a pending destructive confirmation.
  return e.currentTarget !== null && e.target === e.currentTarget && !busy;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Owns everything DW-59/DW-60 need: the scrim, the portal, the focus trap and the
 * `inert` background. Deliberately a SEPARATE component from `ConfirmRun` (not
 * hooks inlined into it) because `ConfirmRun.test.tsx` calls `ConfirmRun({...})`
 * directly as a plain function — no renderer, no hook dispatcher — to walk the
 * returned element tree for its buttons. Any hook called directly inside
 * `ConfirmRun` would throw there. Wrapping as `<ModalOverlay>{card}</ModalOverlay>`
 * keeps `ConfirmRun` a pure function: that line is a React element (a description),
 * not a call — `ModalOverlay`'s body, and therefore its hooks, only run when React
 * actually renders it (e.g. via `renderToStaticMarkup` or a browser mount), never
 * during the tree-walk tests. The card stays reachable at `props.children` for the
 * same walk to keep finding both footer buttons.
 */
function ModalOverlay({
  busy,
  onDismiss,
  children,
}: {
  busy: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const capturedRef = useRef(false);
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Capture the outgoing focus owner during RENDER, not in an effect. React applies
  // the footer's `autoFocus` itself during commit (`commitMount`), and a child's
  // commit runs before this parent's layout OR passive effect — so by the time any
  // effect here runs, `document.activeElement` is already the dialog's own Cancel
  // button and the "restore" would target a node that is about to be detached.
  if (!capturedRef.current) {
    capturedRef.current = true;
    previouslyFocusedRef.current =
      typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  }

  // Mark every OTHER `document.body` child inert while the dialog is open, so a
  // background `Tab`/screen-reader traversal can't reach page content behind the
  // scrim even if the visual trap below is somehow bypassed. Undo on unmount,
  // restoring any prior `inert` state rather than assuming there was none. Other
  // overlays are skipped by their `data-modal-overlay` marker: two dialogs open at
  // once must not inert each other into mutual uselessness.
  //
  // NOTE: `focus()` on a node inside an inert subtree is a spec no-op, so the focus
  // restore below MUST NOT run before this cleanup (with `<div id="root">` the app's
  // only body child, it would silently fail for every caller). That is guaranteed by
  // the restore being deferred to a macrotask, not by this hook's declaration order.
  useEffect(() => {
    const overlayNode = scrimRef.current;
    if (overlayNode === null) return;
    const siblings = Array.from(document.body.children).filter(
      (node) => node !== overlayNode && !node.hasAttribute("data-modal-overlay"),
    );
    const wasInert = siblings.map((node) => node.hasAttribute("inert"));
    for (const node of siblings) node.setAttribute("inert", "");
    return () => {
      siblings.forEach((node, i) => {
        if (wasInert[i] !== true) node.removeAttribute("inert");
      });
    };
  }, []);

  // Restore focus to whatever held it before the dialog opened, once it unmounts.
  //
  // SCHEDULED, not run inline, and that is load-bearing. `StrictMode` (active in
  // `src/ui/main.tsx`) simulates an unmount+remount on mount, and React 19 detaches
  // host refs DURING that simulation: `doubleInvokeEffectsOnFiber` runs
  // `disappearLayoutEffects` (which calls `safelyDetachRef` for every host fiber)
  // BEFORE `disconnectPassiveEffect` runs this cleanup. So `scrimRef.current` is
  // already `null` on the simulated pass too, and no ref-based "is this real?" guard
  // can tell the two apart — an inline restore fires on every dev mount, yanks focus
  // off the auto-focused Cancel button onto the background trigger, and then loses it
  // to `<body>` entirely once `reconnectPassiveEffects` re-inerts that subtree.
  //
  // A deferred restore DOES tell them apart: React re-runs the effect synchronously
  // within the same double-invoke, so the pending timer is cancelled before it can
  // fire, while a real unmount leaves nothing to cancel it. It also makes the restore
  // independent of cleanup ORDER — by the time it runs, the `inert` sweep above has
  // finished and the target is focusable again.
  useEffect(() => {
    if (restoreTimerRef.current !== null) {
      clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }
    return () => {
      const previouslyFocused = previouslyFocusedRef.current;
      if (previouslyFocused === null) return;
      restoreTimerRef.current = setTimeout(() => {
        restoreTimerRef.current = null;
        // Re-checked at FIRE time, not at schedule time: the element may have left the
        // DOM while the dialog was open (focusing a detached node silently drops focus
        // to `<body>`). `preventScroll` keeps a dismiss from jumping the viewport.
        if (previouslyFocused.isConnected) previouslyFocused.focus({ preventScroll: true });
      }, 0);
    };
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const root = scrimRef.current;
    if (root === null) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusables.length === 0) return; // busy: nothing to move focus to, stay put
    const active = document.activeElement;
    const current = active === null ? -1 : focusables.indexOf(active as HTMLElement);
    const nextIndex = nextTrapIndex(focusables.length, current, e.shiftKey);
    focusables[nextIndex]?.focus();
  }

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>): void {
    if (isScrimDismiss(e, busy)) onDismiss();
  }

  const scrim = (
    <div
      ref={scrimRef}
      data-modal-overlay=""
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-6"
    >
      {children}
    </div>
  );

  // SSR / `renderToStaticMarkup` (this repo's entire structural-test harness, no
  // jsdom by convention) has no `document.body` to portal into and no meaning for
  // `createPortal` — render the scrim in-tree, keeping the pre-DW-59 SHAPE (same
  // element nesting, same classes, so every existing structural assertion holds).
  // Not byte-identical: the scrim now also serializes `data-modal-overlay=""`. The
  // browser path gets the durable `document.body` anchor.
  return typeof document === "undefined" ? scrim : createPortal(scrim, document.body);
}

/**
 * The footer button row — a plain function (NOT a component) so its `<button>`
 * elements inline directly into the returned tree, keeping the component
 * hook-free in the base case and directly invocable by the presentational tests.
 */
function footerButtons({
  busy,
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  confirmDisabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="mt-4 flex items-center gap-2.5 border-t border-[var(--border)] bg-[var(--muted)] px-5 pt-4 pb-[18px]">
      <button
        type="button"
        autoFocus
        disabled={busy}
        onClick={onCancel}
        aria-label="Cancel"
        className="inline-flex items-center gap-1.5 rounded-[20px] border border-[var(--border)] px-4 py-2 text-[12.5px] font-semibold text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Cancel
        <span className="rounded-[4px] border border-current px-1 font-mono text-[9.5px] opacity-65">Esc</span>
      </button>
      <span className="flex-1" />
      <button
        type="button"
        disabled={confirmDisabled}
        onClick={onConfirm}
        aria-label="Confirm"
        className="inline-flex items-center gap-1.5 rounded-[20px] border border-[var(--err)] bg-[var(--err-fill)] px-4 py-2 text-[12.5px] font-semibold text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Confirm</span>
      </button>
    </div>
  );
}

/**
 * The escalated type-to-confirm gate + footer. Owns its own typed-value state, so
 * it lives in a nested component: `ConfirmRun` itself stays hook-free in the base
 * case (all three callers), and this only mounts when `objectName` is supplied.
 * The match is CLIENT-SIDE friction only — the Core still authorizes execution.
 */
function TypeToConfirmSection({
  objectName,
  busy,
  onConfirm,
  onCancel,
}: {
  objectName: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState("");
  const match = typeToConfirmMatches(typed, objectName);
  return (
    <>
      <div className="mt-3.5 px-5">
        <div className="mb-1.5 text-[12px] text-[var(--muted-foreground)]">
          Type{" "}
          <code className="rounded-[5px] bg-[var(--err-soft)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--err)]">
            {objectName}
          </code>{" "}
          to confirm.
        </div>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="object name"
          aria-label="type the object name to confirm"
          data-testid="confirm-run-ttc"
          disabled={busy}
          className={`w-full rounded-[7px] border bg-[var(--muted)] px-3 py-2 font-mono text-[13px] text-[var(--foreground)] outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
            match ? "border-[var(--ok)]" : "border-[var(--border)] focus:border-[var(--err)]"
          }`}
        />
      </div>
      {footerButtons({ busy, confirmDisabled: busy || !match, onConfirm, onCancel })}
    </>
  );
}

export function ConfirmRun({
  sql,
  risk,
  busy,
  onConfirm,
  onCancel,
  affectedRows,
  dependents,
  objectName,
}: ConfirmRunProps): React.JSX.Element {
  const badge = affectedRowsBadge(affectedRows);
  const ttcTarget = typeToConfirmTarget(objectName);

  const card = (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-run-title"
      aria-describedby="confirm-run-sub"
      onKeyDown={(e) => {
        // Esc cancels from anywhere in the dialog (Cancel, Confirm, or the
        // type-to-confirm input) — but not mid-round-trip, matching the
        // `busy`-disables-Cancel behavior. Cancel executes nothing.
        if (e.key === "Escape" && !busy) onCancel();
      }}
      className="w-full max-w-[480px] overflow-hidden rounded-[12px] bg-[var(--card)] shadow-[0_24px_70px_-14px_rgba(0,0,0,0.55)] ring-1 ring-[var(--border)]"
    >
      {/* head: red danger icon + generic title + one-line risk description */}
      <div className="flex items-start gap-3 px-5 pt-[18px] pb-3.5">
        <div
          className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] bg-[var(--err-soft)] text-[var(--err)]"
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className="h-[19px] w-[19px]">
            <path d="M12 3.2 1.8 20.4h20.4z" />
            <path d="M12 9.5v5" strokeLinecap="round" />
            <circle cx="12" cy="17.7" r=".2" strokeWidth={2.2} />
          </svg>
        </div>
        <div className="min-w-0">
          <div id="confirm-run-title" className="mt-px mb-1 text-[16px] font-semibold text-[var(--foreground)]">
            Confirm destructive statement
          </div>
          <div id="confirm-run-sub" className="text-[12.5px] leading-snug text-[var(--muted-foreground)]">
            {risk}
          </div>
        </div>
      </div>

      {/* body: statement label (+ optional affected badge), verbatim SQL, optional deps */}
      <div className="px-5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.11em] text-[var(--muted-foreground)]">
            Statement
          </span>
          {badge !== null ? (
            <span
              data-testid="confirm-run-affected"
              className={
                badge.destructive
                  ? "inline-flex items-baseline gap-1.5 rounded-[6px] bg-[var(--err-soft)] px-2 py-0.5 font-mono text-[var(--err)]"
                  : "inline-flex items-baseline gap-1.5 rounded-[6px] bg-[var(--muted)] px-2 py-0.5 font-mono text-[var(--muted-foreground)]"
              }
            >
              {badge.destructive ? (
                <>
                  <span className="text-[14px] font-bold tabular-nums">{badge.count}</span>
                  <span className="text-[10.5px] opacity-85">{badge.noun}</span>
                </>
              ) : (
                <span className="text-[10.5px] opacity-85">{badge.noun}</span>
              )}
            </span>
          ) : null}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[8px] border border-[var(--border)] border-l-2 border-l-[var(--err)] bg-[var(--background)] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--foreground)]">
          {sql}
        </pre>

        {dependents !== undefined && dependents.length > 0 ? (
          <div className="mt-2.5" data-testid="confirm-run-deps">
            {dependents.map((dep, i) => (
              <div
                key={`${dep.from}→${dep.to}#${i}`}
                className="flex items-baseline gap-1.5 border-t border-[var(--border)] py-1 font-mono text-[12px] text-[var(--muted-foreground)] first:border-t-0"
              >
                <span>{dep.from}</span>
                <span className="text-[var(--muted-foreground)]">→ FK →</span>
                <span className="text-[var(--t-int)]">{dep.to}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* footer: quiet Cancel (autofocus, Esc) + filled-red Confirm. The optional
          type-to-confirm variant owns the Confirm-disabled-until-typed friction. */}
      {ttcTarget !== null
        ? <TypeToConfirmSection objectName={ttcTarget} busy={busy} onConfirm={onConfirm} onCancel={onCancel} />
        : footerButtons({ busy, confirmDisabled: busy, onConfirm, onCancel })}
    </div>
  );

  // `ModalOverlay` owns the scrim, the portal and modality (DW-59/DW-60); `card` is
  // passed as `children` so `ConfirmRun` stays hook-free and `findButton` in the
  // tests keeps reaching both footer buttons via `props.children` recursion.
  return (
    <ModalOverlay busy={busy} onDismiss={onCancel}>
      {card}
    </ModalOverlay>
  );
}
