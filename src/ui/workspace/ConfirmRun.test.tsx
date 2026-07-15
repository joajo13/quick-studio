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
import { ConfirmRun } from "./ConfirmRun.tsx";

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
    expect(html).toContain("bg-[var(--err)]"); // filled Confirm button
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
});

describe("ConfirmRun — optional elements render ONLY when supplied", () => {
  const base = { sql: "DROP TABLE users", risk: "drops the table", busy: false, onConfirm: () => {}, onCancel: () => {} };

  test("affectedRows badge is absent by default, present when supplied", () => {
    expect(renderToStaticMarkup(<ConfirmRun {...base} />)).not.toContain("confirm-run-affected");
    const html = renderToStaticMarkup(<ConfirmRun {...base} affectedRows={142} />);
    expect(html).toContain("confirm-run-affected");
    expect(html).toContain("142");
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
