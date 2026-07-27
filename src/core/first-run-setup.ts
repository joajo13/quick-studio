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
 *  6. Run the corresponding loop: bounded-retry unlock, or confirmed create.
 *
 * `bin/` is the ONLY caller entitled to act on `{outcome:"aborted"}` (Ctrl-C) —
 * this module never calls `process.exit`.
 */

import { resolveAppDir } from "./app-dir.ts";
import {
  openCredentialStore,
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

/**
 * Unlock an EXISTING store: up to {@link MAX_UNLOCK_ATTEMPTS} prompts, verified by
 * re-opening the store that actually HOLDS the descriptor (credential store when
 * its descriptor exists, else the provider-key store — see `store-presence.ts`'s
 * "Two descriptors, one passphrase" rationale) with a {@link staticPassphraseProvider}
 * wrapping the captured answer. The two stores are handled in separate branches
 * (not a shared `.store.close()` call) because only the credential store holds the
 * DW-14 writer lock — `ProviderKeyStore` has no `close()` at all. Nothing is ever
 * written by a failed attempt.
 */
async function runUnlockLoop(
  d: FirstRunSetupDeps,
  presence: StorePresenceResult,
): Promise<FirstRunSetupResult> {
  const targetCredential = presence.credential === "passphrase-mode";
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
    if (targetCredential) {
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
