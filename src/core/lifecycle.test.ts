import { describe, expect, test } from "bun:test";
import { createShutdownController } from "./lifecycle.ts";

describe("createShutdownController", () => {
  test("initiate() calls stop then exit, in order", async () => {
    const calls: string[] = [];
    const controller = createShutdownController({
      stop: () => {
        calls.push("stop");
      },
      exit: () => calls.push("exit"),
    });

    await controller.initiate();

    expect(calls).toEqual(["stop", "exit"]);
  });

  test("awaits an async stop before exit", async () => {
    const calls: string[] = [];
    const controller = createShutdownController({
      stop: async () => {
        await Promise.resolve();
        calls.push("stop");
      },
      exit: () => calls.push("exit"),
    });

    await controller.initiate();

    expect(calls).toEqual(["stop", "exit"]);
  });

  test("exit still runs when stop throws (never wedges)", async () => {
    let exited = false;
    const controller = createShutdownController({
      stop: () => {
        throw new Error("teardown boom");
      },
      exit: () => {
        exited = true;
      },
    });

    await controller.initiate();

    expect(exited).toBe(true);
  });

  test("a second initiate() is a no-op (idempotent)", async () => {
    let stopCalls = 0;
    let exitCalls = 0;
    const controller = createShutdownController({
      stop: () => {
        stopCalls++;
      },
      exit: () => {
        exitCalls++;
      },
    });

    await controller.initiate();
    await controller.initiate();
    await controller.initiate();

    expect(stopCalls).toBe(1);
    expect(exitCalls).toBe(1);
  });
});
