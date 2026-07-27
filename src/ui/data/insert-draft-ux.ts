/**
 * Pure UX helpers for the in-grid insert draft (DW-56).
 *
 * The draft renders as the last child of `<tbody>` inside the grid's
 * `overflow-auto` container, so on a full or scrolled page opening it from the
 * result-bar Add-Row button leaves it off-screen and the click looks inert.
 * The decision ("should we reveal?") and the guarded DOM call live here so both
 * are unit-testable in a DOM-less `bun test` harness — no React, no rpc.
 */

/**
 * The minimum an element must look like for {@link revealInsertDraft} to use it.
 * `scrollIntoView` is REQUIRED here — an optional method would make every object
 * structurally assignable, so a ref misattached to an unrelated value would
 * typecheck and then silently no-op at runtime.
 */
export type RevealTarget = Pick<HTMLElement, "scrollIntoView"> | null | undefined;

/**
 * Reveal only on the closed→open edge. A re-render while the draft is already
 * open (busy flag, new `data`, column change) must not scroll again — that
 * would yank the viewport away from wherever the user has scrolled to.
 */
export function shouldRevealInsertDraft(prevOpen: boolean, nextOpen: boolean): boolean {
  return !prevOpen && nextOpen;
}

/**
 * Scroll the draft's trailing row into its nearest scroll container. Guarded:
 * nothing in this repo polyfills `scrollIntoView` and the test harness has no
 * DOM, so a missing element or a missing method is a silent no-op rather than a
 * throw. Returns whether the scroll actually fired.
 */
export function revealInsertDraft(el: RevealTarget): boolean {
  if (el === null || el === undefined) return false;
  if (typeof el.scrollIntoView !== "function") return false;
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}
