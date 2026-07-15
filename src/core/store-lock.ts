/**
 * quick-studio Core — cross-process advisory writer lock (DW-14).
 *
 * The credential store loads every record into memory and, on each mutation,
 * re-encrypts and atomically renames the WHOLE file — with no read-modify-write
 * reconciliation. Two persistent Core instances over the same app dir would race:
 * last flush wins, silently dropping the other's saved/deleted connections (a lost
 * update). Symmetrically, the first-run master-key mint has a generate-on-`not-found`
 * window where two processes each mint a DIFFERENT key, permanently locking the
 * loser's already-encrypted file out. The atomic rename prevents torn files — NOT
 * lost updates or the key race.
 *
 * This module closes both by giving `openCredentialStore` a single-writer gate: an
 * advisory `credential-store.lock` file, created atomically via `O_EXCL`, acquired
 * ONCE at the start of the persistent path (before the descriptor read, key load,
 * and mint) and held for the store handle's lifetime. A second LIVE writer on this
 * host is refused with a typed `held` instead of opening a writable store; holding
 * the lock across `loadOrCreateStoreKey` closes the key race too.
 *
 * Contract ({@link acquireStoreLock} is total — never throws for expected states):
 *  - No lock file, or a reclaimable one → create it, return `acquired` with a
 *    release fn the caller invokes on `store.close()` / a failed open.
 *  - Lock held by a LIVE PID on THIS host → `held` (refuse; non-destructive).
 *  - Lock recorded on a DIFFERENT host → `held` (liveness is unverifiable across
 *    hosts, so we conservatively refuse rather than clobber a possibly-live holder).
 *  - Lock whose recorded holder is DEAD on this host (`ESRCH`), whose file is
 *    MALFORMED, or whose PID is OUR OWN (reentrant reopen) → reclaimed via atomic
 *    rename-away, then re-attempted.
 *  - A non-`EEXIST` create error (EACCES/EIO/EROFS/…) → `unavailable`
 *    (non-destructive — the store itself may be intact).
 *
 * Reclaim is race-safe: `rename(lockPath, lockPath + ".stale.<uuid>")` is atomic,
 * so under two concurrent reclaimers exactly one wins the rename; the loser gets
 * `ENOENT`/`EEXIST` and re-evaluates, seeing the winner's fresh LIVE lock → `held`.
 * The `.stale.<uuid>` temp is deliberately NOT `.tmp`, so it never trips the store
 * suite's `.tmp`-residue assertion.
 *
 * The lock FILE records only the holder's PID, hostname, a per-acquire token, and an
 * ISO timestamp — never a key, passphrase, or connection data.
 *
 * KNOWN LIMITATION: PID liveness (`process.kill(pid, 0)`) is only meaningful on the
 * host that recorded the lock. A stale lock left by a crashed process on a DIFFERENT
 * host cannot be proven dead and so returns `held`; clear it by deleting
 * `credential-store.lock` manually. This is the conservative, non-destructive choice.
 */

import { openSync, closeSync, writeFileSync, readFileSync, renameSync, rmSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/** Bounded acquire attempts. Reclaim-then-retry needs ≤2; 3 leaves headroom. */
const MAX_ACQUIRE_ATTEMPTS = 3;

/**
 * Outcome of {@link acquireStoreLock}. `acquired` carries an idempotent `release`;
 * `held` is contention (refuse, non-destructive); `unavailable` is a lock I/O error
 * (also non-destructive — the store may be intact). Mirrors the store's
 * discriminated-union-on-`outcome` house idiom.
 */
export type StoreLockResult =
  | { readonly outcome: "acquired"; readonly release: () => void }
  | { readonly outcome: "held"; readonly detail: string }
  | { readonly outcome: "unavailable"; readonly detail: string };

/**
 * The minimal filesystem surface the lock needs, injected so every arm is unit-
 * testable over an in-memory fake with NO real disk. Defaults to `node:fs` sync
 * primitives ({@link DEFAULT_STORE_LOCK_DEPS}).
 */
export type StoreLockFs = {
  /**
   * Atomically create the lock file WITH its full `content`, failing with an `EEXIST`
   * error if it already exists (the single-winner claim). The visible lock file must
   * NEVER be observed empty: the real impl writes the body to a sibling temp first,
   * then `linkSync`s it into place (the linked target already holds the full body).
   */
  readonly createExclusive: (path: string, content: string) => void;
  /** Read the lock file as UTF-8 text. Throws (e.g. `ENOENT`) when absent. */
  readonly readText: (path: string) => string;
  /** Atomically rename `from` → `to` (the reclaim rename-away; single-winner). */
  readonly rename: (from: string, to: string) => void;
  /** Best-effort remove (`rmSync(path, { force: true })` semantics). */
  readonly remove: (path: string) => void;
};

/**
 * Injectable seams for {@link acquireStoreLock}. Every field defaults to the real
 * implementation, so production callers pass nothing while tests drive each row of
 * the I/O matrix deterministically.
 */
export type StoreLockDeps = {
  /** Filesystem surface. Defaults to `node:fs` sync primitives. */
  readonly fs: StoreLockFs;
  /** This process's PID recorded in the lock. Defaults to `process.pid`. */
  readonly pid: number;
  /** This host's name recorded in the lock. Defaults to `os.hostname()`. */
  readonly host: string;
  /** ISO timestamp source. Defaults to `() => new Date().toISOString()`. */
  readonly now: () => string;
  /** Same-host PID liveness. Defaults to a `process.kill(pid, 0)` probe. */
  readonly isProcessAlive: (pid: number) => boolean;
};

/** Extract a POSIX error `code` (e.g. `"EEXIST"`) if present, else `undefined`. */
function codeOf(err: unknown): unknown {
  return err !== null && typeof err === "object" && "code" in err
    ? (err as { readonly code?: unknown }).code
    : undefined;
}

/**
 * Default same-host PID liveness: `process.kill(pid, 0)` sends no signal, it only
 * probes. Alive → true; `ESRCH` (no such process) → false; `EPERM` (exists but not
 * signalable by us) → true. Any other error is treated conservatively as alive, so
 * we refuse rather than clobber a lock we cannot prove is dead.
 */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = codeOf(err);
    if (code === "ESRCH") return false;
    // EPERM ⇒ the process exists; anything unexpected ⇒ assume alive (conservative).
    return true;
  }
}

/** The real filesystem surface, used when no `fs` seam is injected. */
export const DEFAULT_STORE_LOCK_FS: StoreLockFs = {
  createExclusive(path, content) {
    // WHY the temp-then-link dance instead of `openSync(path,"wx")` +
    // `writeFileSync(fd)`: those are TWO syscalls, and between them the lock file
    // exists but is EMPTY. A concurrent acquirer that reads it in that window sees an
    // empty body → `readLockInfo` returns null → it treats a LIVE in-progress lock as
    // reclaimable stale and reclaims it → BOTH processes acquire. To close that
    // window we write the FULL body to a private temp first, then `linkSync` the temp
    // into place: the hard link is atomic and the linked target already holds the
    // complete body, so the visible lock file is never observed empty. `linkSync`
    // throws `EEXIST` when the target exists — that IS the single-winner claim.
    const tmp = `${path}.acquire.${randomUUID()}`;
    // The temp holds the full body BEFORE it is ever linked into place.
    writeFileSync(tmp, content, { mode: 0o600 });
    try {
      linkSync(tmp, path);
    } catch (err) {
      const code = codeOf(err);
      if (code === "EEXIST") {
        // Lock already exists — the acquire loop's contention path handles it.
        throw err;
      }
      // On link-hostile filesystems (no hard links) fall back to the original
      // open-then-write. We accept the tiny empty-file window only here; the app dir
      // is normally local disk where `linkSync` works.
      if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV" || code === "EMLINK") {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeFileSync(fd, content);
        } finally {
          closeSync(fd);
        }
        return;
      }
      throw err;
    } finally {
      // Always drop the temp — success (now hard-linked at `path`) or failure.
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best-effort: an orphaned .acquire.<uuid> temp is harmless. */
      }
    }
  },
  readText(path) {
    return readFileSync(path, "utf8");
  },
  rename(from, to) {
    renameSync(from, to);
  },
  remove(path) {
    rmSync(path, { force: true });
  },
};

/** The real seams, used when {@link acquireStoreLock} is called with no `deps`. */
export const DEFAULT_STORE_LOCK_DEPS: StoreLockDeps = {
  fs: DEFAULT_STORE_LOCK_FS,
  pid: process.pid,
  host: hostname(),
  now: () => new Date().toISOString(),
  isProcessAlive: defaultIsProcessAlive,
};

/** The parsed, non-secret identity recorded in a lock file. */
type LockInfo = { readonly pid: number; readonly host: string; readonly token: string };

/**
 * Parse the lock file's `${pid}\n${host}\n${token}\n${iso}` body. Returns `null`
 * when the file is unreadable (vanished mid-race) OR malformed/empty/wrong-shape —
 * both of which the acquire loop treats as reclaimable stale. Never throws.
 */
function readLockInfo(fs: StoreLockFs, lockPath: string): LockInfo | null {
  let raw: string;
  try {
    raw = fs.readText(lockPath);
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  const pidLine = lines[0] ?? "";
  // Strict PID parse: reject a non-numeric first line so `"1000-garbage"` does not
  // coerce to pid 1000 (a false `held`). Parse only after the shape gate.
  if (!/^\d+$/.test(pidLine)) return null;
  const pid = Number.parseInt(pidLine, 10);
  const host = lines[1];
  const token = lines[2];
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (host === undefined || host.length === 0) return null;
  // A missing/empty token line means a malformed (or legacy) body → reclaimable.
  if (token === undefined || token.length === 0) return null;
  return { pid, host, token };
}

/**
 * Reclaim a stale/own/malformed lock by renaming it away, then removing it. The
 * rename is atomic, so under a reclaim race exactly ONE caller renames the file and
 * the loser's rename throws `ENOENT`/`EEXIST` — the loser simply re-evaluates on the
 * next loop turn (it will find the winner's fresh live lock and return `held`).
 * Best-effort throughout: any failure just means the next `createExclusive` retry
 * re-evaluates the current on-disk state.
 */
function reclaim(fs: StoreLockFs, lockPath: string): void {
  const stalePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    fs.rename(lockPath, stalePath);
  } catch {
    return; // lost the reclaim race (or already gone) — let the loop re-evaluate.
  }
  try {
    fs.remove(stalePath);
  } catch {
    /* best-effort: an orphaned .stale.<uuid> is harmless and never a .tmp file. */
  }
}

/**
 * Build the idempotent, token-guarded release. First call removes the lock file;
 * every later call is a no-op (guarded by `released`). Before removing it re-reads
 * the lock and refuses to delete one that now records a DIFFERENT holder — we only
 * ever remove the exact lock THIS acquire wrote. The `token` (a per-acquire UUID)
 * distinguishes our lock from one another handle in the SAME process reclaimed and
 * re-created (same pid/host, different token): without it, handle A's release would
 * delete handle B's LIVE lock. The remove itself is best-effort (`force`), so a
 * shutdown-time double-remove or an already-gone file is silent.
 */
function makeRelease(
  fs: StoreLockFs,
  lockPath: string,
  pid: number,
  host: string,
  token: string,
): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const info = readLockInfo(fs, lockPath);
    // Only remove the lock we still own. A `null` info (malformed/vanished) is ours
    // to clear; a mismatching pid/host/token means another handle/holder owns it now
    // → leave it untouched.
    if (info !== null && (info.pid !== pid || info.host !== host || info.token !== token)) {
      return;
    }
    try {
      fs.remove(lockPath);
    } catch {
      /* best-effort: releasing an already-removed lock must never throw. */
    }
  };
}

/**
 * Acquire the advisory writer lock at `lockPath`. Total — returns a typed
 * {@link StoreLockResult}, never throwing for expected states. See the module
 * header for the full acquire/reclaim/refuse contract. `deps` defaults to the real
 * `node:fs` + `process.pid` + `os.hostname()` + `process.kill(pid, 0)` seams.
 *
 * The loop is bounded ({@link MAX_ACQUIRE_ATTEMPTS}) and NEVER sleeps/spins: a
 * reclaim consumes one turn, so contention resolves within a couple of turns or
 * returns `held`. There is no busy-wait — refusal is immediate and typed.
 */
export function acquireStoreLock(
  lockPath: string,
  deps: StoreLockDeps = DEFAULT_STORE_LOCK_DEPS,
): StoreLockResult {
  const { fs, pid, host, now, isProcessAlive } = deps;

  // Per-acquire identity: distinguishes THIS handle's lock from one another handle in
  // the same process (same pid/host) reclaimed and re-created — so release only ever
  // removes the exact lock we wrote (see makeRelease).
  const token = randomUUID();

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      fs.createExclusive(lockPath, `${pid}\n${host}\n${token}\n${now()}`);
      return { outcome: "acquired", release: makeRelease(fs, lockPath, pid, host, token) };
    } catch (err) {
      const code = codeOf(err);
      if (code !== "EEXIST") {
        // EACCES/EIO/EROFS/… — a lock I/O error, NOT contention. Non-destructive.
        return {
          outcome: "unavailable",
          detail: err instanceof Error ? err.message : "lock file could not be created",
        };
      }
      // The lock exists — decide whether it is reclaimable stale or a live holder.
      const info = readLockInfo(fs, lockPath);
      if (info === null) {
        // Malformed/empty/vanished → treat as stale, reclaim, and retry.
        reclaim(fs, lockPath);
        continue;
      }
      if (info.host !== host) {
        // Foreign host: liveness is unverifiable → refuse rather than clobber.
        return {
          outcome: "held",
          detail: `credential store lock held by another host; stale-lock path: ${lockPath}`,
        };
      }
      if (info.pid === pid) {
        // Reentrant reopen in THIS process: it is us → reclaim and retry.
        reclaim(fs, lockPath);
        continue;
      }
      if (!isProcessAlive(info.pid)) {
        // Dead holder on this host → stale → reclaim and retry.
        reclaim(fs, lockPath);
        continue;
      }
      // Live holder on this host → refuse; non-destructive.
      return {
        outcome: "held",
        detail: `credential store lock held by a live process (pid ${info.pid})`,
      };
    }
  }
  // Contention exhausted the retry budget (e.g. a fast-cycling reclaim race).
  return {
    outcome: "held",
    detail: `credential store lock is contended; stale-lock path: ${lockPath}`,
  };
}
