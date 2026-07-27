/**
 * quick-studio UI (Ring 2) — ConfirmRun tests (Story 5.3, updated for the Story 7.3
 * neutral redesign).
 *
 * Following the repo convention (no jsdom/testing-library): `renderToStaticMarkup`
 * checks the static structure (risk + sql rendered, the base modal shape, each
 * optional element gated on its prop, busy disables both buttons) and direct calls
 * to the returned element tree's `onClick` handlers (bypassing a simulated click,
 * since there is no live DOM) confirm the callbacks fire.
 *
 * The redesigned buttons contain an icon + a label (array children) instead of a
 * single string child, so they are matched by their stable `aria-label`
 * ("Confirm" / "Cancel", matching the visible label per WCAG 2.5.3), and the
 * optional elements by a stable `data-testid`.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConfirmRun,
  affectedRowsBadge,
  isScrimDismiss,
  nextTrapIndex,
  typeToConfirmMatches,
  typeToConfirmTarget,
} from "./ConfirmRun.tsx";

/**
 * DW-59..DW-63 hardening: `affectedRowsBadge` (DW-61), `typeToConfirmTarget` /
 * `typeToConfirmMatches` (DW-62) and `nextTrapIndex` (the DW-59 focus-trap math)
 * are exported as DOM-free pure helpers specifically so their edge cases can be
 * unit-tested directly, without a renderer — matching the no-jsdom convention.
 */
describe("affectedRowsBadge", () => {
  test("undefined affectedRows -> no badge", () => {
    expect(affectedRowsBadge(undefined)).toBeNull();
  });

  test("a positive count -> destructive, pluralized", () => {
    expect(affectedRowsBadge(142)).toEqual({ count: "142", noun: "rows", destructive: true });
  });

  test("exactly 1 -> destructive, singular", () => {
    expect(affectedRowsBadge(1)).toEqual({ count: "1", noun: "row", destructive: true });
  });

  test("zero -> neutral, never a red destruction badge", () => {
    expect(affectedRowsBadge(0)).toEqual({ count: "0", noun: "No rows", destructive: false });
  });

  test("NaN, Infinity, negative or fractional counts -> no badge at all", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 2.5]) {
      expect(affectedRowsBadge(bad)).toBeNull();
    }
  });

  test("counts past 2^53 are rejected rather than rendered in exponential notation", () => {
    expect(affectedRowsBadge(1e21)).toBeNull();
    expect(affectedRowsBadge(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
    // the boundary itself is still a legitimate (if absurd) count
    expect(affectedRowsBadge(Number.MAX_SAFE_INTEGER)?.count).toBe(String(Number.MAX_SAFE_INTEGER));
  });
});

describe("typeToConfirmTarget", () => {
  test("undefined objectName -> gate does not mount", () => {
    expect(typeToConfirmTarget(undefined)).toBeNull();
  });

  test("blank or whitespace-only objectName -> gate does not mount", () => {
    expect(typeToConfirmTarget("")).toBeNull();
    expect(typeToConfirmTarget("   ")).toBeNull();
  });

  test("a padded name is trimmed for the hint / comparison target", () => {
    expect(typeToConfirmTarget("  public.orders  ")).toBe("public.orders");
  });
});

describe("typeToConfirmMatches", () => {
  test("matches when both the typed value and the target are trimmed", () => {
    expect(typeToConfirmMatches("public.orders", "public.orders")).toBe(true);
    expect(typeToConfirmMatches("  public.orders  ", "public.orders")).toBe(true);
    expect(typeToConfirmMatches("public.orders", "  public.orders  ")).toBe(true);
  });

  test("does not match a partial or different name", () => {
    expect(typeToConfirmMatches("public.order", "public.orders")).toBe(false);
    expect(typeToConfirmMatches("", "public.orders")).toBe(false);
  });

  test("a blank target never matches — an empty gate must not auto-pass", () => {
    // Unreachable through `ConfirmRun` (the gate only mounts for a non-blank
    // `typeToConfirmTarget`), but this is an exported helper: a future caller wiring
    // it up directly must not get a friction gate that satisfies itself.
    expect(typeToConfirmMatches("", "")).toBe(false);
    expect(typeToConfirmMatches("", "   ")).toBe(false);
    expect(typeToConfirmMatches("   ", "   ")).toBe(false);
    expect(typeToConfirmMatches("anything", "")).toBe(false);
  });
});

describe("nextTrapIndex", () => {
  test("Tab at the last focusable wraps to the first", () => {
    expect(nextTrapIndex(3, 2, false)).toBe(0);
  });

  test("Shift+Tab at the first focusable wraps to the last", () => {
    expect(nextTrapIndex(3, 0, true)).toBe(2);
  });

  test("steps forward / backward normally within bounds", () => {
    expect(nextTrapIndex(3, 0, false)).toBe(1);
    expect(nextTrapIndex(3, 2, true)).toBe(1);
  });

  test("no focusables (everything disabled while busy) -> no valid index", () => {
    expect(nextTrapIndex(0, 0, false)).toBe(-1);
  });

  test("focus not found among the tracked focusables starts from an end", () => {
    expect(nextTrapIndex(3, -1, false)).toBe(0);
    expect(nextTrapIndex(3, -1, true)).toBe(2);
  });
});

describe("isScrimDismiss", () => {
  // Stand-ins for the two DOM nodes the real handler compares — the predicate only
  // ever checks identity, so plain objects exercise it faithfully without a DOM.
  const scrim = { id: "scrim" } as unknown as EventTarget;
  const insideTheCard = { id: "confirm-button" } as unknown as EventTarget;
  /** `MouseEvent.button`: 0 primary, 1 middle (X11 paste / auto-scroll), 2 secondary. */
  const PRIMARY = 0;

  test("a press on the scrim itself dismisses", () => {
    expect(isScrimDismiss({ target: scrim, currentTarget: scrim, button: PRIMARY }, false)).toBe(true);
  });

  test("a press that bubbled from inside the card does NOT dismiss", () => {
    expect(isScrimDismiss({ target: insideTheCard, currentTarget: scrim, button: PRIMARY }, false)).toBe(false);
  });

  test("a scrim press mid-round-trip does NOT dismiss (busy)", () => {
    expect(isScrimDismiss({ target: scrim, currentTarget: scrim, button: PRIMARY }, true)).toBe(false);
  });

  test("a targetless event does NOT dismiss (null === null must not cancel)", () => {
    expect(isScrimDismiss({ target: null, currentTarget: null, button: PRIMARY }, false)).toBe(false);
  });

  test("a non-primary button on the scrim does NOT dismiss", () => {
    // `mousedown` fires for EVERY button: right-clicking the scrim to open the browser
    // context menu, or middle-clicking it, must not cancel a pending destructive
    // confirmation the user is still reading.
    for (const button of [1, 2, 3, 4]) {
      expect(isScrimDismiss({ target: scrim, currentTarget: scrim, button }, false)).toBe(false);
    }
  });
});

describe("ConfirmRun — static structure", () => {
  test("renders the risk text and the exact sql", () => {
    const html = renderToStaticMarkup(
      <ConfirmRun
        sql="DELETE FROM users WHERE id = 1"
        risk="deletes 1 row"
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("deletes 1 row");
    expect(html).toContain("DELETE FROM users WHERE id = 1");
    expect(html).toContain(">Confirm<");
    expect(html).toContain(">Cancel");
    // neutral alertdialog, not the old inline amber panel
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
  });

  test("base modal has NO top color line and spends red only on functional bits", () => {
    const html = renderToStaticMarkup(
      <ConfirmRun sql="DROP TABLE users" risk="drops the table" busy={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    // no err-colored top border anywhere (the forbidden top color line)
    expect(html).not.toMatch(/border-t[^"']*var\(--err/);
    // red IS present on the functional bits: danger icon, statement left border, Confirm button
    expect(html).toContain("text-[var(--err)]"); // danger icon
    expect(html).toContain("border-l-[var(--err)]"); // statement left border
    expect(html).toContain("bg-[var(--err-fill)]"); // filled Confirm button — the AA fill (DW-58)
    // DW-58: the Confirm button is a `--err` RIM over an `--err-fill` body, and the rim is
    // load-bearing — it is the button's WCAG 1.4.11 boundary against the `--muted` footer
    // (5.10:1 dark), where the fill alone would be 2.74:1. Without this assertion the rim
    // could be dropped with every contrast test still green, since those measure the token
    // values and not which element consumes them.
    expect(html).toContain("border-[var(--err)]"); // Confirm button rim — the 1.4.11 boundary
    // DW-58 regression guard: `--err` under white text is 3.04:1, below AA. No element may
    // pair an `--err` FILL with a white label again. Both spellings of the fill are covered
    // (`bg-[var(--err)]` and the bare `bg-err` utility the `--color-err` alias also emits)
    // and both class orders, since utility order is authored and a class sorter could flip
    // it. The negative lookahead keeps `bg-err-soft` / `bg-err-fill` from matching, and the
    // rim (`border-[var(--err)]`) is untouched — this targets background utilities only.
    const errFillSpelling = String.raw`(?:bg-\[var\(--err\)\]|bg-err(?![-\w]))`;
    expect(html).not.toMatch(new RegExp(`${errFillSpelling}[^"']*text-white`));
    expect(html).not.toMatch(new RegExp(`text-white[^"']*${errFillSpelling}`));
    // no hardcoded Tailwind palette utilities survive the retone
    expect(html).not.toMatch(/amber-/);
    expect(html).not.toMatch(/red-[0-9]/);
  });

  test("busy disables both confirm and cancel", () => {
    const html = renderToStaticMarkup(
      <ConfirmRun sql="DROP TABLE users" risk="drops the table" busy={true} onConfirm={() => {}} onCancel={() => {}} />,
    );
    const disabledCount = (html.match(/disabled=""/g) ?? []).length;
    expect(disabledCount).toBe(2);
  });

  test("not busy leaves both buttons enabled", () => {
    const html = renderToStaticMarkup(
      <ConfirmRun sql="DROP TABLE users" risk="drops the table" busy={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(html).not.toContain('disabled=""');
  });

  test("SSR / bun test has no DOM: the scrim still renders in-tree, unchanged", () => {
    expect(typeof document).toBe("undefined");
    const html = renderToStaticMarkup(
      <ConfirmRun sql="DROP TABLE users" risk="drops the table" busy={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    // DW-60: the scrim keeps its `fixed inset-0 z-[60]` anchor even without a portal.
    expect(html).toContain("fixed inset-0 z-[60]");
    expect(html).toContain('role="alertdialog"');
  });
});

describe("ConfirmRun — optional elements render ONLY when supplied", () => {
  const base = { sql: "DROP TABLE users", risk: "drops the table", busy: false, onConfirm: () => {}, onCancel: () => {} };

  test("affectedRows badge is absent by default, present when supplied", () => {
    expect(renderToStaticMarkup(<ConfirmRun {...base} />)).not.toContain("confirm-run-affected");
    const html = renderToStaticMarkup(<ConfirmRun {...base} affectedRows={142} />);
    expect(html).toContain("confirm-run-affected");
    expect(html).toContain("142");
  });

  test("DW-61: affectedRows=0 renders a neutral badge that reads 'No rows', never red", () => {
    const html = renderToStaticMarkup(<ConfirmRun {...base} affectedRows={0} />);
    expect(html).toContain("confirm-run-affected");
    expect(html).toContain("No rows");
    // Match on the testid ANYWHERE in the open tag, not as its first attribute, and
    // assert the match exists — otherwise reordering the JSX props would empty the
    // string and every `not.toContain` below would pass vacuously.
    const badgeOpenTag = html.match(/<span [^>]*data-testid="confirm-run-affected"[^>]*>/)?.[0];
    expect(badgeOpenTag).toBeDefined();
    expect(badgeOpenTag).toContain("bg-[var(--muted)]");
    expect(badgeOpenTag).toContain("text-[var(--muted-foreground)]");
    expect(badgeOpenTag).not.toContain("--err");
  });

  test("DW-61: nonsense affectedRows values (NaN/Infinity/negative/fractional) render no badge", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, 2.5]) {
      const html = renderToStaticMarkup(<ConfirmRun {...base} affectedRows={bad} />);
      expect(html).not.toContain("confirm-run-affected");
    }
  });

  test("dependents FK line is absent by default, present when supplied (blue, not red)", () => {
    expect(renderToStaticMarkup(<ConfirmRun {...base} />)).not.toContain("confirm-run-deps");
    const html = renderToStaticMarkup(
      <ConfirmRun {...base} dependents={[{ from: "order_items.order_id", to: "orders.id" }]} />,
    );
    expect(html).toContain("confirm-run-deps");
    expect(html).toContain("order_items.order_id");
    expect(html).toContain("orders.id");
    expect(html).toContain("→ FK →");
    // the FK reference uses the blue type color, never red
    expect(html).toContain("text-[var(--t-int)]");
  });

  test("type-to-confirm input is absent by default, present when objectName supplied", () => {
    expect(renderToStaticMarkup(<ConfirmRun {...base} />)).not.toContain("confirm-run-ttc");
    const html = renderToStaticMarkup(<ConfirmRun {...base} objectName="public.orders" />);
    expect(html).toContain("confirm-run-ttc");
    expect(html).toContain("public.orders");
    // Confirm stays disabled until the typed value matches (empty at first render)
    const disabledCount = (html.match(/disabled=""/g) ?? []).length;
    expect(disabledCount).toBe(1);
  });

  test("DW-62: blank or whitespace-only objectName does not mount the type-to-confirm gate", () => {
    for (const blank of ["", "   "]) {
      const html = renderToStaticMarkup(<ConfirmRun {...base} objectName={blank} />);
      expect(html).not.toContain("confirm-run-ttc");
    }
  });

  test("DW-63: objectName + busy disables the input alongside both footer buttons (3 total)", () => {
    const html = renderToStaticMarkup(<ConfirmRun {...base} busy={true} objectName="public.orders" />);
    const disabledCount = (html.match(/disabled=""/g) ?? []).length;
    expect(disabledCount).toBe(3);
    // …and the third one is the type-to-confirm input ITSELF, not just some third
    // control: a count alone stays green if `disabled` migrates off the input.
    const inputTag = html.match(/<input [^>]*data-testid="confirm-run-ttc"[^>]*>/)?.[0];
    expect(inputTag).toBeDefined();
    expect(inputTag).toContain('disabled=""');
  });
});

/**
 * No jsdom/testing-library in this repo, so a simulated click isn't available. In
 * the BASE case `ConfirmRun` has no hooks (the stateful type-to-confirm lives in a
 * nested component only mounted when `objectName` is supplied) and the footer
 * buttons inline directly into the returned tree, so it can be invoked directly
 * (not via JSX) to get its returned element TREE and walk it for the real `onClick`
 * handlers React wired up — this exercises the actual wiring. Buttons are matched
 * by their stable `aria-label` since the redesigned children are now an icon+label
 * array rather than a single string child.
 */
function findButton(node: React.ReactNode, ariaLabel: string): { onClick?: () => void } | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, ariaLabel);
      if (found !== null) return found;
    }
    return null;
  }
  const element = node as React.ReactElement<{
    children?: React.ReactNode;
    onClick?: () => void;
    "aria-label"?: string;
  }>;
  if (element.type === "button" && element.props["aria-label"] === ariaLabel) {
    return { onClick: element.props.onClick };
  }
  return findButton(element.props?.children ?? null, ariaLabel);
}

describe("ConfirmRun — callbacks", () => {
  test("clicking confirm invokes onConfirm and NOT onCancel", () => {
    const onConfirm = mock(() => {});
    const onCancel = mock(() => {});
    const tree = ConfirmRun({ sql: "DROP TABLE users", risk: "drops the table", busy: false, onConfirm, onCancel });
    const button = findButton(tree, "Confirm");
    expect(button?.onClick).toBeDefined();
    button?.onClick?.();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test("clicking cancel invokes onCancel and NOT onConfirm", () => {
    const onConfirm = mock(() => {});
    const onCancel = mock(() => {});
    const tree = ConfirmRun({ sql: "DROP TABLE users", risk: "drops the table", busy: false, onConfirm, onCancel });
    const button = findButton(tree, "Cancel");
    expect(button?.onClick).toBeDefined();
    button?.onClick?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

/**
 * DW-59: `ConfirmRun({...})` (the direct-invocation, hook-free path used above)
 * returns `<ModalOverlay busy={busy} onDismiss={onCancel}>{card}</ModalOverlay>` —
 * a React element DESCRIPTION, not a call, so `ModalOverlay`'s own hooks (its
 * `useRef`/`useEffect` calls) never run here and can't throw. That also means its
 * real `onMouseDown` handler (built inside `ModalOverlay`'s body) isn't reachable
 * from this tree. What IS reachable and load-bearing is the wiring that handler
 * closes over: `busy` and `onDismiss` must be exactly the caller's `busy` and
 * `onCancel` (never `onConfirm`), and the card (with both buttons) must still be
 * `props.children` so `findButton` keeps working through the wrapper.
 */
describe("ConfirmRun — ModalOverlay wiring (DW-59/DW-60)", () => {
  test("wraps the card in a ModalOverlay receiving busy + onDismiss===onCancel", () => {
    const onConfirm = mock(() => {});
    const onCancel = mock(() => {});
    const tree = ConfirmRun({
      sql: "DROP TABLE users",
      risk: "drops the table",
      busy: false,
      onConfirm,
      onCancel,
    }) as unknown as React.ReactElement<{ busy: boolean; onDismiss: () => void; children: React.ReactNode }>;

    expect(typeof tree.type).toBe("function");
    expect((tree.type as { name?: string }).name).toBe("ModalOverlay");
    expect(tree.props.busy).toBe(false);

    // the scrim's onMouseDown (untestable directly — it lives behind hooks) is
    // exactly `e.target === e.currentTarget && !busy ? onDismiss() : void 0`; this
    // locks the `onDismiss` identity it dispatches to.
    tree.props.onDismiss();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    // the card — and therefore both footer buttons — is still reachable through
    // the wrapper's `children`, so the tree-walk tests above keep working.
    expect(findButton(tree.props.children, "Confirm")).not.toBeNull();
    expect(findButton(tree.props.children, "Cancel")).not.toBeNull();
  });

  test("busy propagates to ModalOverlay (gates the scrim-press dismiss while mid-round-trip)", () => {
    const tree = ConfirmRun({
      sql: "DROP TABLE users",
      risk: "drops the table",
      busy: true,
      onConfirm: () => {},
      onCancel: () => {},
    }) as unknown as React.ReactElement<{ busy: boolean }>;
    expect(tree.props.busy).toBe(true);
  });
});
