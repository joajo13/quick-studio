import { describe, expect, test } from "bun:test";
import { dispatch, methodNames, type RpcContext } from "./rpc.ts";

/** Stub context for tests that don't care about shutdown; counts calls too. */
function stubCtx(): RpcContext & { calls: number } {
  const ctx = {
    calls: 0,
    requestShutdown() {
      ctx.calls++;
    },
  };
  return ctx;
}

describe("rpc dispatch", () => {
  test("health returns a typed ok result with the schema version", () => {
    const reply = dispatch({ method: "health" }, stubCtx());
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({ status: "ok", schemaVersion: 1 });
    }
  });

  test("an unknown method yields a typed unknown_method envelope", () => {
    const reply = dispatch({ method: "frobnicate" }, stubCtx());
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("unknown_method");
  });

  test("Object.prototype keys do not resolve to inherited handlers", () => {
    // A plain-object dispatch table would resolve these to truthy prototype
    // members and dispatch them; they must all fall through to unknown_method.
    for (const method of ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__"]) {
      const reply = dispatch({ method }, stubCtx());
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("unknown_method");
    }
  });

  test("methodNames lists only own registered methods", () => {
    expect(methodNames()).toEqual(["health", "shutdown"]);
  });

  test("shutdown returns {stopping:true} and calls ctx.requestShutdown exactly once", () => {
    const ctx = stubCtx();
    const reply = dispatch({ method: "shutdown" }, ctx);
    expect(reply).toEqual({ ok: true, result: { stopping: true } });
    expect(ctx.calls).toBe(1);
  });
});
