import { describe, expect, test } from "bun:test";
import type { ConnectResult } from "../shared/contract.ts";
import { dispatch, methodNames, type RpcContext } from "./rpc.ts";

/**
 * Stub context for dispatch tests. Counts `requestShutdown` calls and records the
 * `ConnectResult` a `connect` handler should resolve to (Story 1.3 threaded a
 * `connect` capability onto every context).
 */
function stubCtx(
  connectResult: ConnectResult = {
    status: "failed",
    failure: "unsupported_scheme",
    message: "no connection target configured",
  },
): RpcContext & { calls: number; connectCalls: number } {
  const ctx = {
    calls: 0,
    connectCalls: 0,
    requestShutdown() {
      ctx.calls++;
    },
    async connect(): Promise<ConnectResult> {
      ctx.connectCalls++;
      return connectResult;
    },
  };
  return ctx;
}

describe("rpc dispatch", () => {
  test("health returns a typed ok result with the schema version", async () => {
    const reply = await dispatch({ method: "health" }, stubCtx());
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({ status: "ok", schemaVersion: 1 });
    }
  });

  test("an unknown method yields a typed unknown_method envelope", async () => {
    const reply = await dispatch({ method: "frobnicate" }, stubCtx());
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("unknown_method");
  });

  test("Object.prototype keys do not resolve to inherited handlers", async () => {
    // A plain-object dispatch table would resolve these to truthy prototype
    // members and dispatch them; they must all fall through to unknown_method.
    for (const method of ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__"]) {
      const reply = await dispatch({ method }, stubCtx());
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("unknown_method");
    }
  });

  test("methodNames lists only own registered methods", () => {
    expect(methodNames()).toEqual(["health", "shutdown", "connect"]);
  });

  test("shutdown returns {stopping:true} and calls ctx.requestShutdown exactly once", async () => {
    const ctx = stubCtx();
    const reply = await dispatch({ method: "shutdown" }, ctx);
    expect(reply).toEqual({ ok: true, result: { stopping: true } });
    expect(ctx.calls).toBe(1);
  });

  test("connect dispatches to ctx.connect and resolves a concrete RpcReply (not a Promise in result)", async () => {
    const schema = { engine: "postgres", tables: [] } as const;
    const ctx = stubCtx({ status: "connected", schema });
    const reply = await dispatch({ method: "connect" }, ctx);

    expect(ctx.connectCalls).toBe(1);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      // The async handler's promise is fully resolved by `dispatch`, so `result`
      // is the concrete ConnectResult — never a live Promise.
      expect(reply.result).not.toBeInstanceOf(Promise);
      expect(reply.result).toEqual({ status: "connected", schema });
    }
  });

  test("connect carries a domain failure through as an OK reply (payload, not transport error)", async () => {
    const ctx = stubCtx({ status: "failed", failure: "auth", message: "the database rejected the provided credentials" });
    const reply = await dispatch({ method: "connect" }, ctx);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({
        status: "failed",
        failure: "auth",
        message: "the database rejected the provided credentials",
      });
    }
  });
});
