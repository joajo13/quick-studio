/**
 * quick-studio Core — presence-only store probe (Story 11.6, reused by Story 11.7).
 *
 * A PURE, injectable-`fs` probe over the app-data directory that answers ONE
 * narrow question — "does this store already have a passphrase descriptor (with or
 * without its `.enc`), an `.enc` with no descriptor, or neither?" — from
 * `existsSync` alone. It NEVER decrypts, never loads a key, never acquires the
 * writer lock, and never calls `ensureAppDir` (it takes a directory path and looks;
 * it does not create one).
 *
 * DW-84/DW-86: the descriptor-present case is split in TWO. A descriptor is only
 * openable if its `.enc` is also on disk — both stores eagerly seed the `.enc` at
 * creation precisely so a wrong passphrase fails GCM instead of being silently
 * accepted (`credential-store.ts:677-694`). A descriptor WITHOUT its `.enc` (a crash
 * between the two writes, a failed rollback, a deleted file) is a store NO passphrase
 * can ever open, and both stores now report it as `corrupt`
 * (`credential-store.ts:607-609`, `provider-key-store.ts:414-416`). Reporting that
 * layout as its own state is what lets `first-run-setup.ts`'s unlock loop pick a
 * store that IS openable — or decline to prompt at all — instead of burning its
 * three retries against a store that can never open and then blaming the passphrase.
 *
 * This is deliberately NOT a re-implementation of `openPersistent`'s branch logic
 * (`credential-store.ts:522-699`) — that logic is inseparable from its side effects
 * (salt generation, descriptor/`.enc` writes, rollback) and runs under the DW-14
 * writer lock, so re-deriving it here would be a second copy that could drift. This
 * module answers only the plain `existsSync` fact both store-open paths already
 * branch on (`credential-store.ts:551` vs `:614`, and the mirrored provider-key
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
 * Per-store, presence-only classification — four states, from `existsSync` alone:
 *  - `passphrase-mode` — the non-secret key descriptor AND its encrypted file both
 *    exist (an existing, OPENABLE passphrase-mode store; unlock, no confirmation).
 *  - `orphaned-descriptor` — the descriptor exists but its `.enc` does NOT (DW-84/
 *    DW-86). A descriptor is still "present" for create-vs-unlock purposes, but this
 *    store cannot be opened by ANY passphrase: both stores return `corrupt` for it
 *    rather than hand out an empty store that the first save would re-key under an
 *    unverified passphrase. Nothing here repairs it — the state is only reported.
 *  - `keychain-mode` — the descriptor is absent but the encrypted file exists
 *    (Story 2.2 back-compat keychain layout; never prompted).
 *  - `first-run` — neither exists (a brand-new store; create, with confirmation,
 *    IF a passphrase turns out to be needed at all).
 */
export type StorePresence =
  | "passphrase-mode"
  | "orphaned-descriptor"
  | "keychain-mode"
  | "first-run";

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

/**
 * Classify one store's presence from its descriptor and encrypted-file paths. The
 * descriptor still wins the mode decision (it is AUTHORITATIVE in both stores'
 * `openPersistent`), but a descriptor alone is no longer enough to call the store
 * openable: without the eagerly-seeded `.enc` there is no ciphertext to authenticate
 * a passphrase against, which is exactly the layout both stores now reject as
 * `corrupt`. Hence `passphrase-mode` requires BOTH files; descriptor-only is
 * `orphaned-descriptor`.
 */
function classifyOne(
  descriptorPath: string,
  encPath: string,
  deps: StorePresenceDeps,
): StorePresence {
  if (deps.existsSync(descriptorPath)) {
    return deps.existsSync(encPath) ? "passphrase-mode" : "orphaned-descriptor";
  }
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
 *
 * `orphaned-descriptor` DOES count, exactly like `passphrase-mode`: the salt on disk
 * is still a descriptor, so minting a brand-new passphrase here would derive a
 * different key from a different salt and orphan whatever the other store (or a
 * restored backup of this one) already holds. An unopenable store must never
 * silently downgrade the create-vs-unlock discriminator into "create" — that is a
 * data-loss path, not a recovery. Deciding what to DO about the orphan is
 * `first-run-setup.ts`'s job (`unlockTarget`); this predicate only refuses to call
 * the app dir virgin.
 */
export function anyDescriptorPresent(p: StorePresenceResult): boolean {
  return isDescriptorPresent(p.credential) || isDescriptorPresent(p.providerKeys);
}

/**
 * True for the two states that mean "a key descriptor is on disk for this store".
 *
 * Written as an exhaustive `switch` (same discipline as `first-run-setup.ts`'s
 * `UnlockAttemptOutcome`) so adding a FIFTH {@link StorePresence} member is a
 * compile error here rather than a silent default. The `default` arm's fallback is
 * deliberately `true`, the SAFE direction: a `false` here reports the app dir as
 * having no descriptor, which sends `first-run-setup.ts` down `runCreatePath` — and
 * that mints a brand-new salt over whatever descriptor the unknown state actually
 * represents, permanently orphaning it. `true` at worst declines to create; `false`
 * at worst destroys. When the compile error fires, classify the new state
 * explicitly instead of leaning on this fallback.
 */
function isDescriptorPresent(presence: StorePresence): boolean {
  switch (presence) {
    case "passphrase-mode":
    case "orphaned-descriptor":
      return true;
    case "keychain-mode":
    case "first-run":
      return false;
    default: {
      const _never: never = presence;
      void _never;
      return true;
    }
  }
}
