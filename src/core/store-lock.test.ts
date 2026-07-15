/**
 * Covers the DW-14 advisory writer-lock I/O matrix over INJECTED seams — an in-
 * memory fake fs plus stubbed pid/host/isProcessAlive — so no real disk is touched
 * and every arm is deterministic:
 *  - acquire on a fresh path, and the recorded pid/host/token body;
 *  - `held` on a live different PID (same host);
 *  - stale reclaim of a dead PID, and of a malformed/empty lock;
 *  - foreign-host → `held` (conservative refuse);
 *  - reentrant same-PID → reclaim → acquire;
 *  - non-`EEXIST` create error → `unavailable`;
 *  - `release` idempotency + pid/host/token-guard (never removes a reclaimed or
 *    reentrantly-re-created lock a different handle now owns);
 *  - strict PID parse: a non-numeric pid line is malformed, not a live holder;
 *  - the reclaim race: two acquirers over one fs, exactly one wins.
 *
 * One block (`DEFAULT_STORE_LOCK_FS.createExclusive`) touches a self-cleaning temp
 * dir on real disk to prove the atomic, never-empty create (PATCH 1).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireStoreLock,
  DEFAULT_STORE_LOCK_FS,
  type StoreLockDeps,
  type StoreLockFs,
} from "./store-lock.ts";

const LOCK = "/fake/app/credential-store.lock";

/** A POSIX-style error carrying a `.code` (what `node:fs` throws). */
function fsError(code: string, msg: string): NodeJS.ErrnoException {
  const err = new Error(msg) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** An in-memory fake fs implementing the {@link StoreLockFs} contract. */
function makeFakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const fs: StoreLockFs = {
    createExclusive(path, content) {
      if (files.has(path)) throw fsError("EEXIST", `EEXIST: '${path}'`);
      files.set(path, content);
    },
    readText(path) {
      const v = files.get(path);
      if (v === undefined) throw fsError("ENOENT", `ENOENT: '${path}'`);
      return v;
    },
    rename(from, to) {
      const v = files.get(from);
      if (v === undefined) throw fsError("ENOENT", `ENOENT: '${from}'`);
      files.delete(from);
      files.set(to, v);
    },
    remove(path) {
      files.delete(path);
    },
  };
  return { fs, files };
}

/**
 * Build deps with sensible defaults over a fresh fake fs; override any seam. When an
 * `fs` override is passed, the returned `files` map is NOT its backing store — only
 * use `.deps` in that case.
 */
function makeDeps(overrides: Partial<StoreLockDeps> = {}): {
  deps: StoreLockDeps;
  files: Map<string, string>;
} {
  const { fs, files } = makeFakeFs();
  const deps: StoreLockDeps = {
    fs,
    pid: 1000,
    host: "host-a",
    now: () => "2026-07-15T00:00:00.000Z",
    isProcessAlive: () => true,
    ...overrides,
  };
  return { deps, files };
}

/** A lock body as the module writes it: `${pid}\n${host}\n${token}\n${iso}`. */
function body(pid: number, host: string, token = "seed-token"): string {
  return `${pid}\n${host}\n${token}\n2026-07-15T00:00:00.000Z`;
}

describe("store-lock — acquire", () => {
  test("fresh path → acquired, records pid/host, and creates the file", () => {
    const { deps, files } = makeDeps();
    const r = acquireStoreLock(LOCK, deps);
    expect(r.outcome).toBe("acquired");
    expect(files.has(LOCK)).toBe(true);
    const [pidLine, hostLine, tokenLine] = files.get(LOCK)!.split("\n");
    expect(pidLine).toBe("1000");
    expect(hostLine).toBe("host-a");
    // A non-empty per-acquire token line is recorded (line index 2).
    expect(tokenLine).toBeDefined();
    expect(tokenLine!.length).toBeGreaterThan(0);
    // Never records a secret — only pid/host/token/iso.
    expect(files.get(LOCK)).not.toContain("key");
  });
});

describe("store-lock — real createExclusive is atomic + never empty (PATCH 1)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  test("creates the lock file with its FULL body and throws EEXIST on a second create", () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-store-lock-"));
    dirs.push(dir);
    const lockPath = join(dir, "credential-store.lock");
    const content = "1000\nhost-a\ntok-abc\n2026-07-15T00:00:00.000Z";

    DEFAULT_STORE_LOCK_FS.createExclusive(lockPath, content);
    // The visible lock file is never observed empty — it holds the full body.
    expect(readFileSync(lockPath, "utf8")).toBe(content);

    // A second create is the single-winner claim: it must fail with EEXIST.
    let code: unknown;
    try {
      DEFAULT_STORE_LOCK_FS.createExclusive(lockPath, "9999\nother\ntok-xyz\niso");
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe("EEXIST");
    // The original body is untouched by the losing claim.
    expect(readFileSync(lockPath, "utf8")).toBe(content);
    // No leftover `.acquire.<uuid>` temp residue — only the lock file remains.
    expect(readdirSync(dir).filter((n) => n.includes(".acquire."))).toHaveLength(0);
    expect(readdirSync(dir)).toEqual(["credential-store.lock"]);
  });
});

describe("store-lock — held (refuse, non-destructive)", () => {
  test("live different PID on this host → held", () => {
    const { fs, files } = makeFakeFs({ [LOCK]: body(2000, "host-a") });
    const deps: StoreLockDeps = {
      fs,
      pid: 1000,
      host: "host-a",
      now: () => "iso",
      isProcessAlive: (pid) => pid === 2000, // holder is alive
    };
    const r = acquireStoreLock(LOCK, deps);
    expect(r.outcome).toBe("held");
    if (r.outcome === "held") expect(r.detail).toContain("2000");
    // The live holder's lock is untouched.
    expect(files.get(LOCK)).toBe(body(2000, "host-a"));
  });

  test("foreign-host lock → held; detail names the stale-lock path", () => {
    const { fs, files } = makeFakeFs({ [LOCK]: body(2000, "host-b") });
    const deps: StoreLockDeps = {
      fs,
      pid: 1000,
      host: "host-a",
      now: () => "iso",
      isProcessAlive: () => false, // even a "dead" foreign PID must NOT be reclaimed
    };
    const r = acquireStoreLock(LOCK, deps);
    expect(r.outcome).toBe("held");
    if (r.outcome === "held") {
      expect(r.detail).toContain("another host");
      expect(r.detail).toContain(LOCK);
    }
    // Foreign lock left intact (conservative refuse).
    expect(files.get(LOCK)).toBe(body(2000, "host-b"));
  });
});

describe("store-lock — stale reclaim → acquire", () => {
  test("dead PID on this host is reclaimed, then acquired", () => {
    const { fs, files } = makeFakeFs({ [LOCK]: body(2000, "host-a") });
    const deps: StoreLockDeps = {
      fs,
      pid: 1000,
      host: "host-a",
      now: () => "2026-07-15T00:00:00.000Z",
      isProcessAlive: (pid) => pid !== 2000, // 2000 is dead
    };
    const r = acquireStoreLock(LOCK, deps);
    expect(r.outcome).toBe("acquired");
    // Reclaimed: the lock now records US, and no `.stale.*` residue remains.
    expect(files.get(LOCK)?.split("\n")[0]).toBe("1000");
    expect([...files.keys()].some((k) => k.includes(".stale."))).toBe(false);
  });

  test("malformed/empty lock is treated as stale and reclaimed", () => {
    const { deps, files } = makeDeps();
    files.set(LOCK, "garbage-not-our-format");
    const r = acquireStoreLock(LOCK, deps);
    expect(r.outcome).toBe("acquired");
    expect(files.get(LOCK)?.split("\n")[0]).toBe("1000");
  });

  test("reentrant reopen: lock records our OWN live PID → reclaim → acquire", () => {
    const { fs, files } = makeFakeFs({ [LOCK]: body(1000, "host-a") });
    const deps: StoreLockDeps = {
      fs,
      pid: 1000, // same as recorded → it's us
      host: "host-a",
      now: () => "2026-07-15T00:00:00.000Z",
      isProcessAlive: () => true,
    };
    const r = acquireStoreLock(LOCK, deps);
    expect(r.outcome).toBe("acquired");
    expect(files.has(LOCK)).toBe(true);
  });
});

describe("store-lock — unavailable (lock I/O error)", () => {
  test("non-EEXIST create error → unavailable, no held/reclaim", () => {
    const { fs } = makeFakeFs();
    const failing: StoreLockFs = {
      ...fs,
      createExclusive() {
        throw fsError("EACCES", "EACCES: permission denied");
      },
    };
    const deps: StoreLockDeps = {
      fs: failing,
      pid: 1000,
      host: "host-a",
      now: () => "iso",
      isProcessAlive: () => true,
    };
    const r = acquireStoreLock(LOCK, deps);
    expect(r.outcome).toBe("unavailable");
    if (r.outcome === "unavailable") expect(r.detail).toContain("EACCES");
  });
});

describe("store-lock — release", () => {
  test("release removes the lock and is idempotent (double release is a no-op)", () => {
    const { deps, files } = makeDeps();
    const r = acquireStoreLock(LOCK, deps);
    if (r.outcome !== "acquired") throw new Error("expected acquired");
    expect(files.has(LOCK)).toBe(true);
    r.release();
    expect(files.has(LOCK)).toBe(false);
    // A fresh acquire re-uses the path; the second release must NOT clobber it.
    const r2 = acquireStoreLock(LOCK, makeDeps({ fs: deps.fs, pid: 2000 }).deps);
    expect(r2.outcome).toBe("acquired");
    r.release(); // idempotent: does nothing, must not remove r2's lock
    expect(files.has(LOCK)).toBe(true);
    expect(files.get(LOCK)?.split("\n")[0]).toBe("2000");
  });

  test("PID-guard: release never removes a lock reclaimed by a different holder", () => {
    const { deps, files } = makeDeps();
    const r = acquireStoreLock(LOCK, deps);
    if (r.outcome !== "acquired") throw new Error("expected acquired");
    // Simulate another holder reclaiming our path after we acquired.
    files.set(LOCK, body(2000, "host-a"));
    r.release();
    // The other holder's lock is left intact (we only remove one we still own).
    expect(files.get(LOCK)).toBe(body(2000, "host-a"));
  });

  test("token-guard: release is a no-op when the on-disk token no longer matches ours (PATCH 2)", () => {
    const { deps, files } = makeDeps();
    const r = acquireStoreLock(LOCK, deps);
    if (r.outcome !== "acquired") throw new Error("expected acquired");
    // Same pid/host, DIFFERENT token — another handle reclaimed + re-created the lock.
    files.set(LOCK, body(1000, "host-a", "a-different-token"));
    r.release();
    // Token mismatch ⇒ we do NOT own it ⇒ left intact.
    expect(files.get(LOCK)).toBe(body(1000, "host-a", "a-different-token"));
  });

  test("reentrant reclaim: the FIRST handle's release does not delete the SECOND handle's live lock (PATCH 2)", () => {
    const { deps, files } = makeDeps(); // pid 1000, host-a
    const r1 = acquireStoreLock(LOCK, deps);
    if (r1.outcome !== "acquired") throw new Error("expected acquired (r1)");
    const firstBody = files.get(LOCK);

    // A reentrant reopen in the SAME process (same pid/host) finds our own lock,
    // reclaims it, and re-creates it with a fresh per-acquire token (T2).
    const r2 = acquireStoreLock(LOCK, deps);
    if (r2.outcome !== "acquired") throw new Error("expected acquired (r2)");
    const secondBody = files.get(LOCK);
    // The bodies differ ONLY by their per-acquire token.
    expect(secondBody).not.toBe(firstBody);

    // r1's release must NOT delete r2's LIVE lock (same pid/host, T1 ≠ T2).
    r1.release();
    expect(files.has(LOCK)).toBe(true);
    expect(files.get(LOCK)).toBe(secondBody);

    // r2's own release DOES clear its lock.
    r2.release();
    expect(files.has(LOCK)).toBe(false);
  });
});

describe("store-lock — strict PID parse (PATCH 3)", () => {
  test('a non-numeric pid line ("1000-garbage") is malformed → reclaimed, not a live holder', () => {
    const { deps, files } = makeDeps(); // isProcessAlive default → true
    // If "1000-garbage" coerced to pid 1000, an alive probe would falsely report held.
    files.set(LOCK, "1000-garbage\nhost-a\nsome-token\n2026-07-15T00:00:00.000Z");
    const r = acquireStoreLock(LOCK, deps);
    expect(r.outcome).toBe("acquired");
    // Reclaimed + re-created recording US.
    expect(files.get(LOCK)?.split("\n")[0]).toBe("1000");
  });
});

describe("store-lock — reclaim race", () => {
  test("two acquirers over a dead lock: exactly one wins, the other is held", () => {
    // Shared fs seeded with a dead-holder lock (pid 5000, this host).
    const { fs, files } = makeFakeFs({ [LOCK]: body(5000, "host-a") });
    const alive = (pid: number) => pid !== 5000; // only the seeded holder is dead
    const mkDeps = (pid: number): StoreLockDeps => ({
      fs,
      pid,
      host: "host-a",
      now: () => "2026-07-15T00:00:00.000Z",
      isProcessAlive: alive,
    });

    // Sequential over the shared fs models the resolved race: the first reclaims the
    // dead lock and acquires; the second sees the winner's now-LIVE lock → held.
    const first = acquireStoreLock(LOCK, mkDeps(1000));
    const second = acquireStoreLock(LOCK, mkDeps(1001));

    expect(first.outcome).toBe("acquired");
    expect(second.outcome).toBe("held");
    expect(files.get(LOCK)?.split("\n")[0]).toBe("1000");
    expect([...files.keys()].some((k) => k.includes(".stale."))).toBe(false);
  });
});
