/**
 * quick-studio UI (Ring 2) — ConfirmRun tests (Story 5.3).
 *
 * Following the repo convention (no jsdom/testing-library): `renderToStaticMarkup`
 * checks the static structure (risk + sql rendered, busy disables both buttons) and
 * direct calls to the `onConfirm`/`onCancel` props (bypassing a simulated click,
 * since there is no live DOM) confirm the callbacks fire.
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
    expect(html).toContain(">confirm<");
    expect(html).toContain(">cancel<");
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

/**
 * No jsdom/testing-library in this repo, so a simulated click isn't available.
 * `ConfirmRun` is a plain function component with no hooks, so it can be invoked
 * directly (not via JSX) to get its returned element TREE and walk it for the real
 * `onClick` handlers React wired up — this exercises the actual wiring rather than
 * re-invoking the caller's own prop functions.
 */
function findButton(node: React.ReactNode, text: string): { onClick?: () => void } | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, text);
      if (found !== null) return found;
    }
    return null;
  }
  const element = node as React.ReactElement<{ children?: React.ReactNode; onClick?: () => void }>;
  if (element.type === "button" && element.props.children === text) {
    return { onClick: element.props.onClick };
  }
  return findButton(element.props?.children ?? null, text);
}

describe("ConfirmRun — callbacks", () => {
  test("clicking confirm invokes onConfirm and NOT onCancel", () => {
    const onConfirm = mock(() => {});
    const onCancel = mock(() => {});
    const tree = ConfirmRun({ sql: "DROP TABLE users", risk: "drops the table", busy: false, onConfirm, onCancel });
    const button = findButton(tree, "confirm");
    expect(button?.onClick).toBeDefined();
    button?.onClick?.();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test("clicking cancel invokes onCancel and NOT onConfirm", () => {
    const onConfirm = mock(() => {});
    const onCancel = mock(() => {});
    const tree = ConfirmRun({ sql: "DROP TABLE users", risk: "drops the table", busy: false, onConfirm, onCancel });
    const button = findButton(tree, "cancel");
    expect(button?.onClick).toBeDefined();
    button?.onClick?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
