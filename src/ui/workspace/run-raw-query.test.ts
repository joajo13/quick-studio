/**
 * quick-studio UI (Ring 2) — `runRawQuery` tests (extracted in Story 5.3).
 *
 * Mirrors the I/O Matrix coverage `QueryTabView.test.tsx` had inline before the
 * extraction: mock the `rpc` client via `bun:test`'s `mock.module`, call
 * `runRawQuery` directly (no render, no DOM needed) and assert the status→outcome
 * mapping plus the exact request shape sent for a fresh run vs. a confirmed re-run.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
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

const { runRawQuery } = await import("./run-raw-query.ts");

beforeEach(() => {
  rpcMock.mockClear();
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
});
