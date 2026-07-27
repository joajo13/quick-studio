/**
 * quick-studio Core — presence-only store probe (Story 11.6, reused by Story 11.7).
 *
 * A PURE, injectable-`fs` probe over the app-data directory that answers ONE
 * narrow question — "does this store already have a passphrase descriptor, an
 * `.enc` with no descriptor, or neither?" — from `existsSync` alone. It NEVER
 * decrypts, never loads a key, never acquires the writer lock, and never calls
 * `ensureAppDir` (it takes a directory path and looks; it does not create one).
 *
 * This is deliberately NOT a re-implementation of `openPersistent`'s branch logic
 * (`credential-store.ts:522-668`) — that logic is inseparable from its side effects
 * (salt generation, descriptor/`.enc` writes, rollback) and runs under the DW-14
 * writer lock, so re-deriving it here would be a second copy that could drift. This
 * module answers only the plain `existsSync` fact both store-open paths already
 * branch on (`credential-store.ts:551` vs `:617`, and the mirrored provider-key
 * path) — the create-vs-unlock discriminator, nothing more. The Story 11.6
 * pre-flight (`first-run-setup.ts`) instead asks the REAL open path whether a
 * passphrase is needed at all (see that module's decline-probe); this probe only
 * disambiguates create vs unlock ONCE a passphrase is already known to be required.
 */

import { existsSync as realExistsSync } from "node:fs";
import { join } from "node:path";
import { STORE_FILE_NAME, STORE_META_FILE_NAME } from "./credential-store.ts";
import {
  PROVIDER_STORE_FILE_NAME,
  PROVIDER_STORE_META_FILE_NAME,
} from "./provider-key-store.ts";

/**
 * Per-store, presence-only classification:
 *  - `passphrase-mode` — the non-secret key descriptor exists (an existing
 *    passphrase-mode store; unlock, no confirmation).
 *  - `keychain-mode` — the descriptor is absent but the encrypted file exists
 *    (Story 2.2 back-compat keychain layout; never prompted).
 *  - `first-run` — neither exists (a brand-new store; create, with confirmation,
 *    IF a passphrase turns out to be needed at all).
 */
export type StorePresence = "passphrase-mode" | "keychain-mode" | "first-run";

/** Presence classification for both persistent stores under one app dir. */
export type StorePresenceResult = {
  readonly credential: StorePresence;
  readonly providerKeys: StorePresence;
};

/** Injectable filesystem seam so the probe is unit-testable without real disk. */
export type StorePresenceDeps = {
  readonly existsSync: (path: string) => boolean;
};

/** The real filesystem seam, used when no deps are injected. */
export const DEFAULT_STORE_PRESENCE_DEPS: StorePresenceDeps = {
  existsSync: realExistsSync,
};

/** Classify one store's presence from its descriptor and encrypted-file paths. */
function classifyOne(
  descriptorPath: string,
  encPath: string,
  deps: StorePresenceDeps,
): StorePresence {
  if (deps.existsSync(descriptorPath)) return "passphrase-mode";
  if (deps.existsSync(encPath)) return "keychain-mode";
  return "first-run";
}

/**
 * Classify BOTH persistent stores' on-disk presence under `dir`, mirroring the
 * descriptor-then-`.enc` precedence both `openPersistent` implementations already
 * branch on — WITHOUT opening, decrypting, locking, or creating anything. `dir`
 * must already exist (or simply not, in which case every `existsSync` call is
 * `false` and both stores classify `first-run`); this never calls `ensureAppDir`.
 */
export function classifyStorePresence(
  dir: string,
  deps: StorePresenceDeps = DEFAULT_STORE_PRESENCE_DEPS,
): StorePresenceResult {
  return {
    credential: classifyOne(
      join(dir, STORE_META_FILE_NAME),
      join(dir, STORE_FILE_NAME),
      deps,
    ),
    providerKeys: classifyOne(
      join(dir, PROVIDER_STORE_META_FILE_NAME),
      join(dir, PROVIDER_STORE_FILE_NAME),
      deps,
    ),
  };
}

/**
 * True when EITHER store already has a passphrase descriptor on disk — the
 * create-vs-unlock discriminator. A passphrase is shared by both stores (see
 * `first-run-setup.ts`'s Design Notes companion, "Two descriptors, one
 * passphrase"): minting a brand-NEW passphrase while the OTHER store already has a
 * descriptor would derive a different key than the one that already unlocks it,
 * permanently orphaning it. `keychain-mode`/`first-run` never count — only an
 * existing descriptor means "this passphrase must already be known", i.e. unlock.
 */
export function anyDescriptorPresent(p: StorePresenceResult): boolean {
  return p.credential === "passphrase-mode" || p.providerKeys === "passphrase-mode";
}
