/**
 * quick-studio UI (Ring 2) — QueryTabView tests (Story 3.6).
 *
 * This repo has no jsdom/testing-library (see `IndexList.test.tsx`'s note) — the
 * existing convention is pure, DOM-free `bun:test` units for state/logic modules
 * (`data-grid-state.test.ts`, `row-mutations.test.ts`) plus `react-dom/server`
 * static-markup checks for presentational structure. Following that convention: the
 * Run/confirm ROUND-TRIP logic (Story 5.3: extracted to the shared, DOM-free
 * `run-raw-query.ts` — see `run-raw-query.test.ts` for its full I/O Matrix
 * coverage, exercised there instead of here to avoid duplicating it) is covered
 * once at the seam; this file keeps `isRunnable` plus a handful of
 * `renderToStaticMarkup` checks over the static structure (Run disabled when
 * blank, the draft text bound into the textarea, the initial empty-state prompt)
 * that IS observable without a live DOM.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { isRunnable, QueryTabView } = await import("./QueryTabView.tsx");

describe("isRunnable", () => {
  test("blank and whitespace-only SQL are not runnable", () => {
    expect(isRunnable("")).toBe(false);
    expect(isRunnable("   ")).toBe(false);
    expect(isRunnable("\n\t  \n")).toBe(false);
  });

  test("any non-whitespace SQL is runnable", () => {
    expect(isRunnable("select 1")).toBe(true);
    expect(isRunnable("  select 1  ")).toBe(true);
  });
});

describe("QueryTabView — static structure", () => {
  const noop = (): void => {};

  test("Run is disabled when the draft is blank", () => {
    const html = renderToStaticMarkup(<QueryTabView draft="" onDraftChange={noop} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain(">Run<");
  });

  test("Run is disabled when the draft is whitespace-only", () => {
    const html = renderToStaticMarkup(<QueryTabView draft={"   \n  "} onDraftChange={noop} />);
    expect(html).toContain('disabled=""');
  });

  test("Run is enabled once the draft has real SQL", () => {
    const html = renderToStaticMarkup(<QueryTabView draft="select 1" onDraftChange={noop} />);
    expect(html).not.toContain('disabled=""');
  });

  test("the textarea is seeded with the bound draft text", () => {
    const html = renderToStaticMarkup(<QueryTabView draft="select * from users" onDraftChange={noop} />);
    expect(html).toContain("select * from users");
  });

  test("shows the initial empty-state prompt before any query has run", () => {
    const html = renderToStaticMarkup(<QueryTabView draft="" onDraftChange={noop} />);
    expect(html).toContain("run a query to see results");
  });
});
