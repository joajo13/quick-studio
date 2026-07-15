/**
 * Unit tests for the pure single-flight-with-trailing save scheduler (DW-27).
 *
 * The scheduler is the ONE serialization primitive every async `workspace.save`
 * goes through; these tests are the whole reason it was extracted from `App.tsx`
 * — the concurrency lives HERE and is now exercisable with a fake, manually-
 * resolvable `save` (no React, no real RPC). Each test drives the fake's deferred
 * promises by hand to reproduce a specific interleaving: single-flight, trailing/
 * latest-wins, ordering, failure-retry, drain, isBusy, and a rejected-save wedge.
 */

import { describe, expect, test } from "bun:test";
import type { WorkspaceSnapshot } from "../../shared/contract.ts";
import { createSaveScheduler } from "./save-scheduler.ts";

/** A distinct snapshot tagged by `nextId` so calls can be told apart by identity. */
function snap(tag: number): WorkspaceSnapshot {
  return { version: 1, panelSizes: [20, 80], tabs: [], activeTabId: null, nextId: tag };
}

/** Flush the microtask + macrotask queues so settled promises' `.then`s run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type Deferred = { resolve: (v: { ok: boolean }) => void; reject: (e?: unknown) => void };

/**
 * Build a scheduler over a fake `save` whose every call parks a deferred promise —
 * the test resolves/rejects them explicitly to control the interleaving. Records
 * every snapshot passed to `save`, plus the `onPersisted`/`onError`/`onSuccess` fan.
 */
function setup() {
  const calls: WorkspaceSnapshot[] = [];
  const deferreds: Deferred[] = [];
  const persisted: string[] = [];
  const stats = { error: 0, success: 0 };
  const scheduler = createSaveScheduler({
    save: (s) => {
      calls.push(s);
      return new Promise<{ ok: boolean }>((resolve, reject) => {
        deferreds.push({ resolve, reject });
      });
    },
    onPersisted: (serialized) => persisted.push(serialized),
    onError: () => {
      stats.error++;
    },
    onSuccess: () => {
      stats.success++;
    },
  });
  return { scheduler, calls, deferreds, persisted, stats };
}

describe("save-scheduler — single-flight", () => {
  test("a second schedule during an unsettled save does NOT start a concurrent save", async () => {
    const { scheduler, calls, deferreds } = setup();
    scheduler.schedule("s1", snap(1));
    scheduler.schedule("s2", snap(2)); // arrives while s1 is in flight
    expect(calls).toHaveLength(1); // only one save outstanding

    deferreds[0]!.resolve({ ok: true });
    await tick();
    expect(calls).toHaveLength(2); // the trailing save runs only after s1 settled
    expect(calls[1]).toEqual(snap(2));
  });
});

describe("save-scheduler — trailing / latest-wins", () => {
  test("several schedules during one in-flight save collapse to ONE follow-up with the LAST snapshot", async () => {
    const { scheduler, calls, deferreds } = setup();
    scheduler.schedule("s1", snap(1));
    scheduler.schedule("s2", snap(2));
    scheduler.schedule("s3", snap(3));
    scheduler.schedule("s4", snap(4)); // last wins
    expect(calls).toHaveLength(1);

    deferreds[0]!.resolve({ ok: true });
    await tick();
    // Exactly one trailing save, carrying the LAST snapshot (2 and 3 collapsed away).
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(snap(4));

    // Settling the trailing save leaves nothing more queued.
    deferreds[1]!.resolve({ ok: true });
    await tick();
    expect(calls).toHaveLength(2);
  });
});

describe("save-scheduler — ordering", () => {
  test("an older snapshot never lands after a newer one", async () => {
    const { scheduler, calls, deferreds } = setup();
    scheduler.schedule("s1", snap(1));
    scheduler.schedule("s2", snap(2)); // trailing
    deferreds[0]!.resolve({ ok: true });
    await tick();
    deferreds[1]!.resolve({ ok: true });
    await tick();

    const order = calls.map((c) => c.nextId);
    expect(order).toEqual([1, 2]);
    // Strictly increasing — an older tag never follows a newer one.
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    }
  });
});

describe("save-scheduler — failure / retry invariant", () => {
  test("an ok:false save calls onError, never onPersisted, and a later schedule still runs", async () => {
    const { scheduler, calls, deferreds, persisted, stats } = setup();
    scheduler.schedule("s1", snap(1));
    deferreds[0]!.resolve({ ok: false });
    await tick();
    expect(stats.error).toBe(1);
    expect(persisted).toEqual([]); // marker NOT advanced on failure

    // A subsequent change still runs (retry) — the scheduler did not wedge.
    scheduler.schedule("s2", snap(2));
    expect(calls).toHaveLength(2);
    deferreds[1]!.resolve({ ok: true });
    await tick();
    expect(persisted).toEqual(["s2"]);
    expect(stats.success).toBe(1);
  });

  test("a rejected save promise triggers onError, never onPersisted", async () => {
    const { scheduler, deferreds, persisted, stats } = setup();
    scheduler.schedule("s1", snap(1));
    deferreds[0]!.reject(new Error("network"));
    await tick();
    expect(stats.error).toBe(1);
    expect(persisted).toEqual([]);
  });
});

describe("save-scheduler — drain", () => {
  test("resolves immediately when already idle", async () => {
    const { scheduler } = setup();
    let resolved = false;
    void scheduler.drain().then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(true);
  });

  test("resolves only after the in-flight save AND its trailing save both settle", async () => {
    const { scheduler, deferreds } = setup();
    scheduler.schedule("s1", snap(1));
    scheduler.schedule("s2", snap(2)); // trailing
    let drained = false;
    void scheduler.drain().then(() => {
      drained = true;
    });

    deferreds[0]!.resolve({ ok: true });
    await tick();
    expect(drained).toBe(false); // trailing save still to run

    deferreds[1]!.resolve({ ok: true });
    await tick();
    expect(drained).toBe(true);
  });
});

describe("save-scheduler — isBusy", () => {
  test("true while running or pending, false when idle", async () => {
    const { scheduler, deferreds } = setup();
    expect(scheduler.isBusy()).toBe(false);

    scheduler.schedule("s1", snap(1));
    expect(scheduler.isBusy()).toBe(true); // running

    scheduler.schedule("s2", snap(2));
    expect(scheduler.isBusy()).toBe(true); // running + pending

    deferreds[0]!.resolve({ ok: true });
    await tick();
    expect(scheduler.isBusy()).toBe(true); // trailing save now running

    deferreds[1]!.resolve({ ok: true });
    await tick();
    expect(scheduler.isBusy()).toBe(false); // idle
  });
});

describe("save-scheduler — a rejected save does not wedge the scheduler", () => {
  test("a later schedule still runs after a rejection", async () => {
    const { scheduler, calls, deferreds, persisted } = setup();
    scheduler.schedule("s1", snap(1));
    deferreds[0]!.reject(new Error("boom"));
    await tick();

    scheduler.schedule("s2", snap(2)); // must still run — running was cleared
    expect(calls).toHaveLength(2);
    deferreds[1]!.resolve({ ok: true });
    await tick();
    expect(persisted).toEqual(["s2"]);
    expect(scheduler.isBusy()).toBe(false);
  });
});

describe("save-scheduler — totality of the run() settle path", () => {
  test("a synchronously-throwing save is a failure, not a wedge; drain still resolves and a later schedule runs", async () => {
    let firstCall = true;
    const persisted: string[] = [];
    let errors = 0;
    const scheduler = createSaveScheduler({
      save: (_s) => {
        if (firstCall) {
          firstCall = false;
          throw new Error("sync throw"); // save throws instead of returning a promise
        }
        return Promise.resolve({ ok: true });
      },
      onPersisted: (serialized) => persisted.push(serialized),
      onError: () => {
        errors++;
      },
    });

    scheduler.schedule("s1", snap(1));
    await tick();
    expect(errors).toBe(1); // treated as a failure
    expect(persisted).toEqual([]); // marker not advanced
    // Not wedged: drain resolves and a fresh schedule runs to completion.
    let drained = false;
    void scheduler.drain().then(() => {
      drained = true;
    });
    await tick();
    expect(drained).toBe(true);
    scheduler.schedule("s2", snap(2));
    await tick();
    expect(persisted).toEqual(["s2"]);
    expect(scheduler.isBusy()).toBe(false);
  });

  test("a non-object resolution is treated as a failure, not a thrown TypeError that wedges the gate", async () => {
    const persisted: string[] = [];
    let errors = 0;
    const scheduler = createSaveScheduler({
      // Deliberately resolves a non-object (an alternate/buggy `save` injection).
      save: (_s) => Promise.resolve(undefined as unknown as { ok: boolean }),
      onPersisted: (serialized) => persisted.push(serialized),
      onError: () => {
        errors++;
      },
    });

    scheduler.schedule("s1", snap(1));
    await tick();
    expect(errors).toBe(1);
    expect(persisted).toEqual([]);
    expect(scheduler.isBusy()).toBe(false); // gate cleared — not wedged
  });
});
