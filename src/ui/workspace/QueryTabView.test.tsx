/**
 * quick-studio UI (Ring 2) — QueryTabView tests (Story 3.6).
 *
 * This repo has no jsdom/testing-library (see `IndexList.test.tsx`'s note) — the
 * existing convention is pure, DOM-free `bun:test` units for state/logic modules
 * (`data-grid-state.test.ts`, `row-mutations.test.ts`) plus `react-dom/server`
 * static-markup checks for presentational structure. Following that convention:
 * the Run/confirm ROUND-TRIP logic lives in the exported, DOM-free `runRawQuery`
 * (mock the `rpc` client via `bun:test`'s `mock.module`, call it directly — no
 * render, no simulated click needed) and every I/O Matrix scenario is exercised
 * there; a handful of `renderToStaticMarkup` checks cover the static structure
 * (Run disabled when blank, the draft text bound into the textarea, the initial
 * empty-state prompt) that IS observable without a live DOM.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  errorReply,
  FROZEN_SCHEMA_VERSION,
  okReply,
  type ExecuteResult,
  type FrozenData,
  type RpcReply,
} from "../../shared/contract.ts";

/** A minimal one-column `FrozenData` with `n` numeric rows (1..n). */
function makeData(n: number): FrozenData {
  return {
    schemaVersion: FROZEN_SCHEMA_VERSION,
    columns: [{ name: "id", type: "number" }],
    rows: Array.from({ length: n }, (_, i) => [{ kind: "number", value: i + 1 }]),
  };
}

// Mock the RPC client BEFORE the module under test is ever imported/evaluated —
// `runRawQuery` calls `rpc` from this module, and the whole point of the test is
// to observe exactly what it sends without a live Core.
const rpcMock = mock(
  async (_method: string, _params?: unknown): Promise<RpcReply<ExecuteResult>> =>
    errorReply("internal_error", "unset"),
);
mock.module("../rpc/client.ts", () => ({ rpc: rpcMock }));

const { isRunnable, runRawQuery, QueryTabView } = await import("./QueryTabView.tsx");

beforeEach(() => {
  rpcMock.mockClear();
});

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

describe("runRawQuery — I/O Matrix", () => {
  test("Run SELECT: rows render with no truncation, sent verbatim with no `confirmed` key", async () => {
    const data = makeData(3);
    rpcMock.mockResolvedValueOnce(okReply<ExecuteResult>({ status: "rows", data, truncated: false }));

    const outcome = await runRawQuery("select * from users");

    expect(outcome).toEqual({ kind: "rows", data, truncated: false });
    expect(rpcMock.mock.calls.length).toBe(1);
    expect(rpcMock.mock.calls[0]?.[0]).toBe("execute");
    expect(rpcMock.mock.calls[0]?.[1]).toEqual({ shape: "raw", sql: "select * from users" });
  });

  test("Large SELECT: the Core's `truncated` flag is surfaced as-is", async () => {
    const data = makeData(1000);
    rpcMock.mockResolvedValueOnce(okReply<ExecuteResult>({ status: "rows", data, truncated: true }));

    const outcome = await runRawQuery("select * from big_table");

    expect(outcome.kind).toBe("rows");
    expect(outcome.kind === "rows" && outcome.truncated).toBe(true);
    expect(outcome.kind === "rows" && outcome.data.rows.length).toBe(1000);
  });

  test("Destructive statement: confirmation_required, then confirming re-issues the IDENTICAL request with confirmed:true", async () => {
    const sql = "DELETE FROM users WHERE id = 1";
    rpcMock.mockResolvedValueOnce(
      okReply<ExecuteResult>({
        status: "confirmation_required",
        preview: { sql, risk: "deletes 1 row" },
      }),
    );
    rpcMock.mockResolvedValueOnce(okReply<ExecuteResult>({ status: "ok", rowsAffected: 1 }));

    const first = await runRawQuery(sql);
    expect(first).toEqual({ kind: "confirm", sql, risk: "deletes 1 row" });

    const second = await runRawQuery(sql, true);
    expect(second).toEqual({ kind: "ok", rowsAffected: 1 });

    expect(rpcMock.mock.calls.length).toBe(2);
    // The re-issued request is IDENTICAL to the original PLUS `confirmed:true` —
    // never a different/composed SQL string (the dialog is UX only, never the gate).
    expect(rpcMock.mock.calls[0]?.[1]).toEqual({ shape: "raw", sql });
    expect(rpcMock.mock.calls[1]?.[1]).toEqual({ shape: "raw", sql, confirmed: true });
  });

  test("Cancel: after a confirmation_required reply, not confirming issues no further request", async () => {
    const sql = "DROP TABLE users";
    rpcMock.mockResolvedValueOnce(
      okReply<ExecuteResult>({ status: "confirmation_required", preview: { sql, risk: "drops the table" } }),
    );

    const outcome = await runRawQuery(sql);
    expect(outcome.kind).toBe("confirm");

    // The UI's cancel affordance simply clears local state — it never calls
    // `runRawQuery` again. Assert that the ONLY request sent stays the original
    // preview request; nothing executed.
    expect(rpcMock.mock.calls.length).toBe(1);
  });

  test("Multi-statement input: the Core's bad_request rejects it inline, nothing executes", async () => {
    rpcMock.mockResolvedValueOnce(errorReply("bad_request", "multiple statements are not allowed"));

    const outcome = await runRawQuery("SELECT 1; DROP TABLE users");

    expect(outcome).toEqual({
      kind: "error",
      message: "bad_request: multiple statements are not allowed",
    });
    expect(rpcMock.mock.calls.length).toBe(1);
  });

  test("Engine/syntax error: the failed envelope surfaces inline, no grid", async () => {
    rpcMock.mockResolvedValueOnce(errorReply("bad_request", 'syntax error at or near "selct"'));

    const outcome = await runRawQuery("selct * from users");

    expect(outcome).toEqual({
      kind: "error",
      message: 'bad_request: syntax error at or near "selct"',
    });
  });

  test("Empty/whitespace SQL: Run stays disabled and no call is ever made", () => {
    // `isRunnable` is the sole gate the Run button and Ctrl/Cmd+Enter check before
    // ever calling `runRawQuery` — assert the gate itself, then that nothing in
    // this test touched the rpc mock.
    expect(isRunnable("   ")).toBe(false);
    expect(rpcMock.mock.calls.length).toBe(0);
  });
});

describe("QueryTabView — static structure", () => {
  const noop = (): void => {};

  test("Run is disabled when the draft is blank", () => {
    const html = renderToStaticMarkup(<QueryTabView draft="" onDraftChange={noop} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain(">run<");
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
