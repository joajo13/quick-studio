/**
 * quick-studio Core — persistent first-run setup pre-flight (Story 11.6).
 *
 * Fills the seam Story 2.3 designed in and Story 2.4 left empty: on a host with no
 * reachable OS keychain, Persistent mode had exactly two ways to supply a
 * passphrase — `QS_PASSPHRASE` and `QS_PASSPHRASE_FD` — and no interactive path.
 * This module is the async pre-flight `bin/` runs BEFORE `startCore`: it classifies
 * whether a passphrase will actually be needed, prompts if so, and hands back a
 * PRE-RESOLVED {@link PassphraseProvider} closure for `startCore` to inject. The
 * synchronous `PassphraseProvider` contract itself is never made async — only
 * `bin/`'s pre-flight is.
 *
 * Orchestration, in this exact order (mirrors the spec's Boundaries & Constraints):
 *  1. Ephemeral mode → `skip` before any probe, prompt, or `ensureAppDir`. No store
 *     is ever opened in Ephemeral mode; this module must not be the exception.
 *  2. An operator already chose a transport (`QS_PASSPHRASE` or a well-formed
 *     `QS_PASSPHRASE_FD`) → `skip`. Env/fd keep ABSOLUTE precedence — byte-for-byte
 *     unchanged behavior when either is set.
 *  3. Decline-probe: ask the REAL `openCredentialStore` (a provider that always
 *     declines) whether a passphrase will be needed at all. `opened` → the store
 *     opens via the keychain, close it, `skip`. Anything other than
 *     `passphrase-declined` (`locked`/`corrupt`/`schema-unknown`/`key-unavailable`/
 *     `key-invalid`/`unavailable`) is a different problem a prompt cannot fix →
 *     `skip`. This is how the pre-flight classification stays in LOCKSTEP with
 *     `openPersistent`'s branch logic — there is exactly one implementation of it,
 *     so drift between "will the store ask for a passphrase" and "did we prompt"
 *     is structurally impossible (see spec-11-6 Design Notes, Block-If #1).
 *  4. A passphrase genuinely IS needed. A non-interactive `stdin` NEVER prompts and
 *     never blocks boot — one stderr pointer at `QS_PASSPHRASE_FD`, then `skip`.
 *  5. {@link classifyStorePresence} + {@link anyDescriptorPresent} decide create vs
 *     unlock — a plain `existsSync` fact, not a re-implementation of branch logic.
 *  6. Run the corresponding loop: bounded-retry unlock, or confirmed create. On the
 *     unlock side the SAME presence facts also pick WHICH store to verify against
 *     ({@link unlockTarget}): a descriptor whose `.enc` is missing
 *     (`orphaned-descriptor`) can never be opened by any passphrase, so the loop
 *     targets the other store if that one is openable, and when NEITHER is it
 *     declines to prompt at all — zero prompts, one notice line naming each orphaned
 *     store plus the shared remedy block, `skip` (DW-86). Prompting three times
 *     against a store no answer can open, then reporting "wrong passphrase", is the
 *     bug this avoids.
 *
 * `bin/` is the ONLY caller entitled to act on `{outcome:"aborted"}` (Ctrl-C) —
 * this module never calls `process.exit`.
 */

import { resolveAppDir } from "./app-dir.ts";
import {
  openCredentialStore,
  STORE_FILE_NAME,
  STORE_META_FILE_NAME,
  type CredentialStoreDeps,
  type OpenResult as CredentialOpenResult,
} from "./credential-store.ts";
import {
  DEFAULT_PROMPT_DEPS,
  isInteractive as defaultIsInteractive,
  MAX_CONFIRM_ATTEMPTS,
  promptNewPassphrase,
  promptPassphrase,
  type PromptDeclineReason,
  type PromptResult,
} from "./passphrase-prompt.ts";
import {
  hasPassphraseTransport,
  staticPassphraseProvider,
  type PassphraseProvider,
} from "./passphrase-provider.ts";
import {
  openProviderKeyStore,
  PROVIDER_STORE_FILE_NAME,
  PROVIDER_STORE_META_FILE_NAME,
  type OpenResult as ProviderOpenResult,
  type ProviderKeyStoreDeps,
} from "./provider-key-store.ts";
import type { RunMode } from "./run-mode.ts";
import { anyDescriptorPresent, classifyStorePresence, type StorePresenceResult } from "./store-presence.ts";

/** Bounded retry budget for unlocking an EXISTING store with a wrong passphrase. */
export const MAX_UNLOCK_ATTEMPTS = 3;

/**
 * Outcome of {@link runFirstRunSetup}.
 *  - `provider` — a passphrase was captured; pass it to `startCore` as
 *    `passphraseProvider` so both persistent stores unlock from the same instance.
 *  - `skip` — change nothing; `startCore` resolves its own provider exactly as
 *    today (env/fd, or a typed `passphrase-declined` on first RPC).
 *  - `aborted` — the user pressed Ctrl-C. Only `bin/` may act on this (exit 130,
 *    never boot the Core); this module never calls `process.exit` itself.
 */
export type FirstRunSetupResult =
  | { readonly outcome: "provider"; readonly provider: PassphraseProvider }
  | { readonly outcome: "skip" }
  | { readonly outcome: "aborted" };

/**
 * Injectable dependencies. Every field defaults to the real module; tests override
 * a `deps` subset to drive every branch deterministically (see
 * `first-run-setup.test.ts`'s spy-deps pattern). `dir` is a TEST-ONLY override: in
 * production it stays `undefined` so each store resolves its own app dir via
 * `ensureAppDir()`, and the presence probe instead uses the PURE, non-creating
 * `resolveAppDir`.
 *
 * Review fix (corrected claim): this module never calls `ensureAppDir` ITSELF, but
 * the decline-probe's `d.openCredential` call at step (3) does — `ensureAppDir()`
 * runs, and can create the app-data directory (plus a transient DW-14 lock file),
 * BEFORE the prompt ever appears, so the directory may exist even if the user then
 * hits `Ctrl-C`. What IS guaranteed, on every decline path, is narrower: no
 * descriptor, ciphertext, or plaintext is ever written unless a passphrase was
 * actually accepted.
 */
export type FirstRunSetupDeps = {
  readonly dir?: string;
  readonly openCredential: (deps: CredentialStoreDeps) => CredentialOpenResult;
  readonly openProviderKeys: (deps: ProviderKeyStoreDeps) => ProviderOpenResult;
  readonly presence: (dir: string) => StorePresenceResult;
  readonly prompt: (label: string) => Promise<PromptResult>;
  readonly promptNew: () => Promise<PromptResult>;
  readonly isInteractive: () => boolean;
  readonly stderr: (line: string) => void;
};

/** Real-module defaults for every seam except `dir` (which has none in production). */
export const DEFAULT_FIRST_RUN_SETUP_DEPS: Omit<FirstRunSetupDeps, "dir"> = {
  openCredential: openCredentialStore,
  openProviderKeys: openProviderKeyStore,
  presence: (dir) => classifyStorePresence(dir),
  prompt: (label) => promptPassphrase(label, DEFAULT_PROMPT_DEPS),
  promptNew: () => promptNewPassphrase(DEFAULT_PROMPT_DEPS),
  isInteractive: () => defaultIsInteractive(DEFAULT_PROMPT_DEPS),
  // Review fix: bare `process.stderr.write` throws on a closed/broken stderr
  // (EPIPE), and since this seam is called from every decline path that throw
  // escaped `runFirstRunSetup` and became `first-run setup failed` + exit 1 in
  // `bin/` — a cosmetic write failure aborting a boot. Same defensive shape the
  // prompt's echo path and spec 11.5's stderr sink already use.
  stderr: (line) => {
    try {
      process.stderr.write(line);
    } catch {
      /* best-effort: a failed advisory write must never abort the boot. */
    }
  },
};

/** The single stderr pointer to the non-interactive transport, used on every decline. */
const FD_TRANSPORT_HINT =
  "quick-studio: set QS_PASSPHRASE_FD to supply a passphrase non-interactively.\n";

/**
 * Why the prompt declined, in the user's terms. Review fix: all four non-abort
 * reasons previously emitted only {@link FD_TRANSPORT_HINT}, so someone who
 * mistyped the confirmation three times and someone on a terminal readline cannot
 * drive were both told, with no other context, to go configure a file descriptor.
 * The reason line is printed FIRST, the transport pointer second.
 */
const DECLINE_EXPLANATION: Readonly<Record<Exclude<PromptDeclineReason, "aborted">, string>> = {
  "non-tty": "quick-studio: stdin is not an interactive terminal, so no passphrase was requested.\n",
  empty: "quick-studio: no passphrase entered — nothing was unlocked or created.\n",
  mismatch: `quick-studio: the passphrase and its confirmation did not match after ${MAX_CONFIRM_ATTEMPTS} attempts — no store was created.\n`,
  unsupported: "quick-studio: this terminal cannot hide typed input, so no passphrase was requested.\n",
};

/**
 * Map every prompt decline reason to a {@link FirstRunSetupResult}. `aborted`
 * (Ctrl-C) is the one reason `bin/` must act on directly; every other reason
 * (`non-tty`, `empty`, `mismatch`, `unsupported`) degrades to today's typed
 * `passphrase-declined` behavior via `skip`, with one line naming the reason and
 * one pointing at the non-interactive transport.
 */
function declineResult(
  d: Pick<FirstRunSetupDeps, "stderr">,
  reason: PromptDeclineReason,
): FirstRunSetupResult {
  if (reason === "aborted") {
    return { outcome: "aborted" };
  }
  d.stderr(DECLINE_EXPLANATION[reason]);
  d.stderr(FD_TRANSPORT_HINT);
  return { outcome: "skip" };
}

/** `{dir}` when a test override is set, else `{}` so the store resolves its own app dir. */
function dirOverride(d: FirstRunSetupDeps): { readonly dir?: string } {
  return d.dir === undefined ? {} : { dir: d.dir };
}

/**
 * The set of outcomes either store's verify-open can return. Review fix: was
 * previously `string` — a new arm added to either `OpenResult` union would
 * silently compile and fall into `skip` below without a type error anywhere.
 * Deriving this from the two real `OpenResult` types keeps it exhaustive: adding
 * an outcome arm to either store now forces this module to account for it.
 */
type UnlockAttemptOutcome = CredentialOpenResult["outcome"] | ProviderOpenResult["outcome"];

/**
 * Classify one verify-open attempt: `opened` (correct passphrase), `retry` (wrong
 * passphrase — `corrupt`, since GCM auth-tag failure is cryptographically
 * indistinguishable from tamper by design (spec-2-3); or a pathologically long
 * `passphrase-invalid`), or `skip` (any other outcome — `locked`/`unavailable`/
 * `key-invalid`/`schema-unknown`/`key-unavailable` — a different problem a retry
 * cannot fix). Shared by both stores' verify branches below.
 */
function classifyUnlockAttempt(outcome: UnlockAttemptOutcome): "opened" | "retry" | "skip" {
  if (outcome === "opened") return "opened";
  if (outcome === "corrupt" || outcome === "passphrase-invalid") return "retry";
  return "skip";
}

/** Which store the unlock loop verifies against, or `none` when none can be opened. */
type UnlockTarget = "credential" | "provider-keys" | "none";

/**
 * Pick the store to verify the typed passphrase against. Only a `passphrase-mode`
 * store is a legitimate target: it is the one layout (descriptor AND `.enc`) where
 * the right passphrase opens and a wrong one fails GCM, which is exactly what makes
 * a retry meaningful. This generalizes the previous credential-first boolean rather
 * than replacing it — with no orphaned stores, the first two arms reproduce the old
 * `targetCredential` behavior exactly.
 *
 * `none` is reachable ONLY when every descriptor on disk is orphaned from its `.enc`
 * (DW-86): `anyDescriptorPresent` gated this call, so at least one descriptor exists,
 * and if none of them is openable there is nothing a prompt could ever unlock. Note
 * this is decided BEFORE any key derivation, from `existsSync` alone — which is why
 * `classifyUnlockAttempt`'s `corrupt` → retry mapping stays untouched: a wrong
 * passphrase and a tampered `.enc` really are indistinguishable AFTER derivation, so
 * the fix is to not enter the loop, not to narrow that mapping.
 *
 * Both arms are exhaustive `switch`es (same discipline as {@link UnlockAttemptOutcome}
 * above) so a FIFTH {@link StorePresence} member is a compile error here rather than
 * a silent fall-through. The `default` fallback deliberately TARGETS the store rather
 * than returning `none`: an unknown presence state must not silently become a
 * no-prompt skip, because that is the one outcome where the user is never asked AND
 * never told why. Prompting against a store that turns out not to open is fully
 * recoverable — it costs at most {@link MAX_UNLOCK_ATTEMPTS} prompts, writes nothing,
 * and ends in the same `skip` — whereas an unexplained silent skip is not. As with
 * `store-presence.ts`'s `isDescriptorPresent`, when that compile error fires the fix
 * is to classify the new state explicitly, not to lean on this fallback.
 */
function unlockTarget(p: StorePresenceResult): UnlockTarget {
  switch (p.credential) {
    case "passphrase-mode":
      return "credential";
    case "orphaned-descriptor":
    case "keychain-mode":
    case "first-run":
      // Not openable (or nothing to unlock) — fall through to the provider-key store.
      break;
    default: {
      const _never: never = p.credential;
      void _never;
      return "credential";
    }
  }
  switch (p.providerKeys) {
    case "passphrase-mode":
      return "provider-keys";
    case "orphaned-descriptor":
    case "keychain-mode":
    case "first-run":
      return "none";
    default: {
      const _never: never = p.providerKeys;
      void _never;
      return "provider-keys";
    }
  }
}

/**
 * One line per store whose descriptor lost its `.enc` — the WHAT, named per store.
 * Naming the specific store matters because a half-broken app dir stays recoverable:
 * the other store may still unlock normally, and the user needs to know which half
 * is broken. Deliberately NON-destructive: this module reports the state, it never
 * repairs, deletes, or re-creates anything (see the spec's Never list).
 *
 * Split from {@link ORPHANED_DESCRIPTOR_REMEDY} so the remedy — which is identical
 * for both stores — is stated ONCE no matter how many stores are orphaned, instead
 * of the same ~200-character sentence being pasted into every line.
 *
 * Each notice names the two FILES by name (from the stores' own exported constants,
 * so a rename cannot desynchronise the advice from the disk). Without them the
 * remedy below is unactionable: "restore the missing file" does not tell anyone
 * WHICH file to restore, and the two stores' files sit side by side in one
 * directory. Bare basenames only — no directory, no absolute path — which keeps the
 * codebase's "never leak a path" boundary (`first-run-signal.ts`'s `FIRST_RUN_HINT`)
 * intact: a basename identifies the file without disclosing the user's home
 * directory or username into stderr that may be pasted into a bug report.
 */
const ORPHANED_DESCRIPTOR_NOTICE: Readonly<Record<"credential" | "providerKeys", string>> = {
  credential:
    `quick-studio: the credential store has a passphrase descriptor (${STORE_META_FILE_NAME}) but its encrypted file (${STORE_FILE_NAME}) is missing — no passphrase can unlock it.\n`,
  providerKeys:
    `quick-studio: the provider-key store has a passphrase descriptor (${PROVIDER_STORE_META_FILE_NAME}) but its encrypted file (${PROVIDER_STORE_FILE_NAME}) is missing — no passphrase can unlock it.\n`,
};

/**
 * The WHAT-TO-DO block, emitted exactly once after the per-store notices and only
 * when at least one store is actually orphaned.
 *
 * Ordering is load-bearing, not stylistic. RESTORE is stated first because it is the
 * only remedy that preserves data, and the reason it works is worth spelling out: the
 * descriptor still sitting on disk holds the salt the missing `.enc` was encrypted
 * under, so a restored file is decryptable by the passphrase the user already knows.
 * DELETION is stated second, explicitly flagged IRREVERSIBLE, because it is a
 * one-way door: removing the descriptor sends that store down {@link runCreatePath},
 * which mints a FRESH salt — after which an `.enc` restored from a backup can never
 * be decrypted by anything, including the correct original passphrase. The previous
 * wording offered the two as co-equal alternatives on one line, which is how a user
 * with a perfectly restorable backup ends up destroying it.
 */
const ORPHANED_DESCRIPTOR_REMEDY =
  "quick-studio: restore each missing file named above from a backup if you have one, next to its descriptor — that descriptor is what decrypts it.\n" +
  "quick-studio: deleting a descriptor starts that store over, but is IRREVERSIBLE: a new store mints a new salt, so an .enc restored afterwards can never be decrypted.\n";

/**
 * Emitted only when BOTH stores are orphaned, immediately after the remedy.
 *
 * Without it the remedy is a trap on exactly this layout. Deleting ONE descriptor
 * leaves the OTHER orphan on disk, {@link anyDescriptorPresent} stays true, and the
 * very next boot prints the identical notice/remedy/blocked block — from which the
 * only available reading is "the deletion did not work", and the natural next move
 * is to delete more, faster, without a backup. With only one store orphaned that
 * same deletion DOES unblock the next boot (the other store is `first-run` or
 * `keychain-mode`, so nothing else holds the create path shut), which is why this
 * line is conditional rather than folded into the remedy.
 */
const ORPHANED_DESCRIPTOR_BOTH =
  "quick-studio: both stores are affected — removing only one descriptor changes nothing here, the next boot is blocked by the other.\n";

/**
 * Why nothing is being created either, emitted last and ONLY when
 * {@link unlockTarget} is `none` — i.e. when there is no openable store left at all.
 *
 * Conditional because it is simply false in the half-broken-but-winnable case: with
 * one store `passphrase-mode` and the other orphaned, the loop DOES prompt and that
 * store DOES unlock, so telling the user "nothing is created here either" would
 * contradict the prompt appearing on the very next line. It is only when every
 * present descriptor is orphaned that the pre-flight declines to prompt at all, and
 * that silence is what needs explaining: a fresh passphrase would derive a different
 * key from a different salt and orphan whatever the existing descriptor still
 * protects, so refusing to create is the data-safe choice, not a failure.
 */
const ORPHANED_DESCRIPTOR_BLOCKED =
  "quick-studio: until then nothing is created here either — a fresh passphrase would orphan whatever the existing descriptor still protects.\n";

/**
 * Unlock an EXISTING store: up to {@link MAX_UNLOCK_ATTEMPTS} prompts, verified by
 * re-opening the store that actually HOLDS an OPENABLE descriptor (credential store
 * when it is `passphrase-mode`, else the provider-key store — see
 * `store-presence.ts`'s "Two descriptors, one passphrase" rationale) with a
 * {@link staticPassphraseProvider} wrapping the captured answer. The two stores are
 * handled in separate branches (not a shared `.store.close()` call) because only the
 * credential store holds the DW-14 writer lock — `ProviderKeyStore` has no `close()`
 * at all. Nothing is ever written by a failed attempt.
 *
 * Before the first prompt, every orphaned descriptor gets one notice line naming it,
 * followed by the shared remedy block (DW-86) — explain, THEN ask. If
 * {@link unlockTarget} finds nothing openable the loop is skipped entirely: zero
 * prompts, nothing written, `{outcome:"skip"}` — never `aborted`, never a throw.
 *
 * What that `skip` guarantees is narrow and worth stating exactly: this pre-flight
 * writes nothing and declines to blame the passphrase for a file that is simply
 * missing. It does NOT promise any particular later verdict from `startCore` — with
 * an orphaned provider-key store and a first-run credential store, for instance, the
 * credential store reports `passphrase-declined` and the orphaned store's own
 * `corrupt` may never be triggered at all.
 */
async function runUnlockLoop(
  d: FirstRunSetupDeps,
  presence: StorePresenceResult,
): Promise<FirstRunSetupResult> {
  // Explain BEFORE asking: notices (credential first, then providerKeys), then the
  // shared remedy once, then — only when BOTH are orphaned — that one deletion will
  // not be enough, then — only when nothing can be unlocked — why we also refuse to
  // create. See the constants above for why each line is conditional the way it is.
  const credentialOrphaned = presence.credential === "orphaned-descriptor";
  const providerKeysOrphaned = presence.providerKeys === "orphaned-descriptor";
  if (credentialOrphaned) {
    d.stderr(ORPHANED_DESCRIPTOR_NOTICE.credential);
  }
  if (providerKeysOrphaned) {
    d.stderr(ORPHANED_DESCRIPTOR_NOTICE.providerKeys);
  }
  if (credentialOrphaned || providerKeysOrphaned) {
    d.stderr(ORPHANED_DESCRIPTOR_REMEDY);
  }
  if (credentialOrphaned && providerKeysOrphaned) {
    d.stderr(ORPHANED_DESCRIPTOR_BOTH);
  }

  const target = unlockTarget(presence);
  if (target === "none") {
    // Every present descriptor is orphaned — the notices above replace the prompt,
    // and this last line explains why no create path runs either.
    d.stderr(ORPHANED_DESCRIPTOR_BLOCKED);
    return { outcome: "skip" };
  }
  const label = "quick-studio passphrase to unlock the store: ";

  for (let attempt = 0; attempt < MAX_UNLOCK_ATTEMPTS; attempt++) {
    const answer = await d.prompt(label);
    if (answer.outcome === "declined") {
      return declineResult(d, answer.reason);
    }
    const provider = staticPassphraseProvider(answer.passphrase);

    // Review fix: both branches now switch on `verify.outcome` directly for the
    // `opened` arm — TypeScript narrows `verify` from that check alone, so the
    // previous `decision === "opened" && verify.outcome === "opened"` double-check
    // in the credential branch was redundant (the provider-key branch never had
    // it). `classifyUnlockAttempt` is still consulted for the `retry`/`skip` split.
    if (target === "credential") {
      const verify = d.openCredential({ mode: "persistent", ...dirOverride(d), passphraseProvider: provider });
      if (verify.outcome === "opened") {
        // Release the DW-14 writer lock this verify-open just acquired — the
        // later lazy open in `startCore` re-acquires it, unaffected.
        verify.store.close();
        return { outcome: "provider", provider };
      }
      if (classifyUnlockAttempt(verify.outcome) === "skip") {
        return { outcome: "skip" };
      }
    } else {
      const verify = d.openProviderKeys({ mode: "persistent", ...dirOverride(d), passphraseProvider: provider });
      if (verify.outcome === "opened") {
        // ProviderKeyStore holds no writer lock — nothing to release.
        return { outcome: "provider", provider };
      }
      if (classifyUnlockAttempt(verify.outcome) === "skip") {
        return { outcome: "skip" };
      }
    }
    // Review fix: `corrupt` is retried because a wrong passphrase is
    // cryptographically indistinguishable from tamper (see `classifyUnlockAttempt`
    // above) — but that means a genuinely damaged `.enc` file previously produced
    // three misleading "wrong passphrase, try again" lines. Reworded to
    // acknowledge both possible causes.
    d.stderr(
      "quick-studio: could not unlock the store — wrong passphrase, or the store file is damaged. Try again.\n",
    );
  }
  d.stderr(
    `quick-studio: giving up after ${MAX_UNLOCK_ATTEMPTS} attempts. If the passphrase is correct, the store file may be damaged.\n`,
  );
  return { outcome: "skip" };
}

/**
 * Create a NEW passphrase-mode store. Explains WHY first (no OS keychain
 * reachable, this passphrase unlocks the store on every future run, there is no
 * recovery if it is lost), then prompts with confirmation, then EAGERLY opens the
 * credential store under the captured passphrase so the descriptor + seeded `.enc`
 * actually exist on disk before this reports success (matches the eager-write
 * behavior `credential-store.ts` already performs at creation — spec-2-3).
 */
async function runCreatePath(d: FirstRunSetupDeps): Promise<FirstRunSetupResult> {
  d.stderr(
    "quick-studio: no OS keychain is reachable on this host.\n" +
      "quick-studio: this passphrase will unlock your local store on every future run.\n" +
      "quick-studio: there is no way to recover it if it is lost.\n",
  );
  const answer = await d.promptNew();
  if (answer.outcome === "declined") {
    return declineResult(d, answer.reason);
  }
  const provider = staticPassphraseProvider(answer.passphrase);
  const opened = d.openCredential({ mode: "persistent", ...dirOverride(d), passphraseProvider: provider });
  if (opened.outcome === "opened") {
    opened.store.close();
    return { outcome: "provider", provider };
  }
  d.stderr(`quick-studio: could not create the passphrase-protected store (${opened.detail}).\n`);
  return { outcome: "skip" };
}

/**
 * Run the first-run setup pre-flight. Total for every condition it MODELS: each
 * `OpenResult` arm, each `PromptResult` arm, and a failed advisory write all
 * resolve to one of the three typed outcomes above rather than throwing. It is
 * NOT unconditionally total — `openCredentialStore`/`openProviderKeyStore`
 * re-throw genuinely unexpected errors by design, and this module deliberately
 * lets those through rather than swallowing them; `bin/` contains them in its own
 * try/catch so they are reported as a pre-flight failure and not as a Core that
 * failed to start. See the module docstring for the exact decision order.
 */
export async function runFirstRunSetup(
  mode: RunMode,
  env: Record<string, string | undefined>,
  deps: Partial<FirstRunSetupDeps> = {},
): Promise<FirstRunSetupResult> {
  const d: FirstRunSetupDeps = { ...DEFAULT_FIRST_RUN_SETUP_DEPS, ...deps };

  // (1) Ephemeral → skip before any probe, prompt, or ensureAppDir.
  if (mode !== "persistent") {
    return { outcome: "skip" };
  }

  // (2) An operator already chose a transport → skip, byte-for-byte unchanged.
  if (hasPassphraseTransport(env)) {
    return { outcome: "skip" };
  }

  // (3) Decline-probe: ask the REAL open path whether a passphrase will be needed.
  // This is what keeps the pre-flight classification in lockstep with
  // `openPersistent`'s branch logic — there is exactly one implementation of it.
  const probe = d.openCredential({
    mode: "persistent",
    ...dirOverride(d),
    passphraseProvider: () => ({ outcome: "declined" }),
  });
  if (probe.outcome === "opened") {
    probe.store.close();
    return { outcome: "skip" };
  }
  if (probe.outcome !== "passphrase-declined") {
    // locked / unavailable / corrupt / schema-unknown / key-unavailable /
    // key-invalid — a different problem a prompt cannot fix.
    return { outcome: "skip" };
  }

  // (4) A passphrase genuinely IS needed. Never prompt a non-interactive stdin,
  // and never block boot waiting for input that can never arrive.
  if (!d.isInteractive()) {
    d.stderr(FD_TRANSPORT_HINT);
    return { outcome: "skip" };
  }

  // (5) Presence decides create vs unlock — a plain existsSync fact. Review fix:
  // reads the INJECTED `env`, not `process.env` — transport precedence at step (2)
  // and the app-dir resolution here must come from one source, or the parameter is
  // a lie (a caller passing a fake `HOME`/`XDG_DATA_HOME`/`APPDATA` got precedence
  // from the fake and the directory from the real process). Identical in
  // production, where `bin/` passes `process.env`.
  const dir = d.dir ?? resolveAppDir(env, process.platform);
  const presence = d.presence(dir);

  // (6) Run the corresponding loop.
  if (anyDescriptorPresent(presence)) {
    return runUnlockLoop(d, presence);
  }
  return runCreatePath(d);
}
