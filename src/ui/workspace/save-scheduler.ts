/**
 * quick-studio UI (Ring 2) — single-flight-with-trailing save scheduler (DW-27).
 *
 * The ONE serialization primitive every async `workspace.save` goes through. Its
 * whole reason to exist: the store persists each save via a temp-file + `rename`,
 * so two overlapping `workspace.save` calls can land out of order and leave the
 * OLDER snapshot on disk (DW-27). By running saves strictly one-at-a-time in
 * enqueue order — collapsing any changes that arrive mid-flight into a SINGLE
 * trailing save carrying the latest snapshot — the newest snapshot always lands
 * last, with never more than one write outstanding.
 *
 * Framework-free ON PURPOSE: no React, no `rpc` import. The `save` fn is injected
 * (App passes a thin `rpc` wrapper), so the concurrency is unit-testable in
 * isolation with a fake, manually-resolvable `save` — the earlier inline version
 * had zero tests exactly where the races lived. Every method is total (never
 * throws): a rejected `save` is caught defensively so it can never wedge the
 * scheduler with `running` stuck `true`.
 */

import type { WorkspaceSnapshot } from "../../shared/contract.ts";

/**
 * A pending trailing save: the serialized form (compared against the persisted
 * marker by the caller, and passed to `onPersisted` on success) plus the snapshot
 * object handed to `save`. Only ever ONE is held — a later `schedule` overwrites
 * it (latest wins), which is what collapses a burst of changes to one follow-up.
 */
type Pending = {
  readonly serialized: string;
  readonly snapshot: WorkspaceSnapshot;
};

/** Dependencies injected into {@link createSaveScheduler}. */
export type SaveSchedulerDeps = {
  /**
   * The actual persist. Injected (no `rpc`/React here) so it is fully fakeable.
   * Resolves `{ ok }` — `ok:true` means persisted (including the ephemeral
   * `saved:false` success, which is still `reply.ok===true`); `ok:false` OR a
   * rejected promise is a failure.
   */
  readonly save: (snapshot: WorkspaceSnapshot) => Promise<{ ok: boolean }>;
  /**
   * Called with the just-persisted `serialized` ONLY on success — this is where
   * the caller advances its persisted marker. NEVER called on failure, so the
   * next change compares unequal and retries (the DW-22 retry invariant).
   */
  readonly onPersisted: (serialized: string) => void;
  /** Called on every failure (`ok:false` or a rejected `save`) — surfaces it. */
  readonly onError: () => void;
  /** Called after a successful persist — clears any surfaced failure. */
  readonly onSuccess?: () => void;
};

/** The live scheduler handle returned by {@link createSaveScheduler}. */
export type SaveScheduler = {
  /**
   * Enqueue a save of `snapshot`. If a save is in flight, this becomes the single
   * trailing save (overwriting any earlier pending one — latest wins) and returns
   * immediately; otherwise it starts a run right away.
   */
  schedule(serialized: string, snapshot: WorkspaceSnapshot): void;
  /**
   * Resolve when the scheduler reaches idle (no in-flight save AND no pending
   * trailing save). Resolves immediately when already idle; otherwise the caller
   * awaits the whole chain (in-flight + trailing) draining — used by the quit path
   * so the last pre-Stop change is persisted, in order, before shutdown.
   */
  drain(): Promise<void>;
  /** `true` while a save is running OR a trailing save is pending; else `false`. */
  isBusy(): boolean;
};

/**
 * Build a single-flight-with-trailing save scheduler over the injected `save`.
 * Pure of any framework; the returned handle owns all mutable run state in its
 * closure, so there is exactly one serialization point per instance.
 */
export function createSaveScheduler(deps: SaveSchedulerDeps): SaveScheduler {
  const { save, onPersisted, onError, onSuccess } = deps;

  // True from the instant a run begins until its `save` promise settles. The
  // single gate that guarantees at most one write is ever outstanding.
  let running = false;
  // At most one queued trailing save; a later `schedule` overwrites it so a burst
  // of changes collapses to one follow-up carrying the LATEST snapshot.
  let pending: Pending | null = null;
  // Waiters parked by `drain()` while non-idle, resolved as a batch the moment the
  // run chain reaches idle (nothing running, nothing pending).
  let drainWaiters: Array<() => void> = [];

  /** Resolve and clear every parked `drain()` waiter — called only at idle. */
  function resolveDrainWaiters(): void {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * After a run settles, advance the chain: promote any pending trailing save into
   * the next run (clearing `pending` FIRST so a `schedule` during that run queues a
   * fresh follow-up rather than being lost), else notify drain waiters we're idle.
   */
  function advance(): void {
    if (pending !== null) {
      const next = pending;
      pending = null;
      run(next.serialized, next.snapshot);
    } else {
      resolveDrainWaiters();
    }
  }

  /**
   * Execute one save. `Promise.resolve(save(...))` tolerates a `save` that returns
   * a non-thenable, and BOTH settle paths (fulfil and reject) clear `running` and
   * `advance()` — so a thrown/rejected `save` can never wedge `running=true`.
   * `onPersisted` fires ONLY on `ok:true` (the retry invariant).
   */
  function run(serialized: string, snapshot: WorkspaceSnapshot): void {
    running = true;
    // Single settle path: clears the gate FIRST, then reports, then advances — so no
    // failure mode can wedge the scheduler with `running` stuck `true`.
    const settle = (ok: boolean): void => {
      running = false;
      if (ok) {
        onPersisted(serialized);
        onSuccess?.();
      } else {
        onError();
      }
      advance();
    };
    try {
      // `Promise.resolve` tolerates a non-thenable return; the fulfil arm reads `ok`
      // defensively (a non-object resolution is a failure, not a thrown TypeError),
      // and the reject arm treats a rejected `save` as a failure. `save` itself may
      // also throw synchronously instead of returning a promise — the surrounding
      // `try` turns that into a failure too. Every path clears `running`.
      Promise.resolve(save(snapshot)).then(
        (result) => settle(result != null && result.ok === true),
        () => settle(false),
      );
    } catch {
      settle(false);
    }
  }

  return {
    schedule(serialized, snapshot) {
      if (running) {
        pending = { serialized, snapshot };
        return;
      }
      run(serialized, snapshot);
    },

    drain() {
      if (!running && pending === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },

    isBusy() {
      return running || pending !== null;
    },
  };
}
