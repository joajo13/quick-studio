import { describe, expect, test } from "bun:test";
import { dispatch, methodNames } from "./rpc.ts";

describe("rpc dispatch", () => {
  test("health returns a typed ok result with the schema version", () => {
    const reply = dispatch({ method: "health" });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({ status: "ok", schemaVersion: 1 });
    }
  });

  test("an unknown method yields a typed unknown_method envelope", () => {
    const reply = dispatch({ method: "frobnicate" });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("unknown_method");
  });

  test("Object.prototype keys do not resolve to inherited handlers", () => {
    // A plain-object dispatch table would resolve these to truthy prototype
    // members and dispatch them; they must all fall through to unknown_method.
    for (const method of ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__"]) {
      const reply = dispatch({ method });
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("unknown_method");
    }
  });

  test("methodNames lists only own registered methods", () => {
    expect(methodNames()).toEqual(["health"]);
  });
});
