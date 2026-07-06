/**
 * quick-studio Core — passphrase provider seam (FR-5, AR-7, AD-5, UJ-2).
 *
 * The "offer / decline" boundary the credential store consults when the OS
 * keychain is unavailable. Story 2.3 ships only the headless default —
 * {@link envPassphraseProvider}, reading `QS_PASSPHRASE` — so the fallback works on
 * a keychain-less box today; Story 2.4 injects an interactive prompt later through
 * this same seam. The context carries NO secret; the passphrase flows out only via
 * a `provided` response.
 */

/** Environment variable the default provider reads the passphrase from. */
export const PASSPHRASE_ENV_VAR = "QS_PASSPHRASE";

/**
 * Context passed to a {@link PassphraseProvider}. Non-secret: it only explains WHY
 * a passphrase is being requested (`reason`) and whether the store is brand-new
 * (`isFirstRun`), so a prompt can adjust its copy. Never carries a passphrase.
 */
export type PassphraseContext = {
  readonly reason: "keychain-unavailable";
  readonly isFirstRun: boolean;
};

/** A provider's answer: a passphrase, or an explicit decline (fall back to nothing). */
export type PassphraseResponse =
  | { readonly outcome: "provided"; readonly passphrase: string }
  | { readonly outcome: "declined" };

/**
 * Synchronous passphrase source. Total: returns a typed {@link PassphraseResponse}.
 * A `declined` result MUST cause the store to write nothing (no descriptor, no
 * ciphertext, no plaintext).
 */
export type PassphraseProvider = (ctx: PassphraseContext) => PassphraseResponse;

/**
 * Default provider: read the passphrase from `env[QS_PASSPHRASE]`. An unset, empty,
 * or whitespace-only value is a `declined` (there is nothing to unlock with). The
 * value is read at call time so a test/host can set it just before opening.
 */
export function envPassphraseProvider(
  env: Record<string, string | undefined>,
): PassphraseProvider {
  return (_ctx: PassphraseContext): PassphraseResponse => {
    const value = env[PASSPHRASE_ENV_VAR];
    if (value === undefined || value.trim().length === 0) {
      return { outcome: "declined" };
    }
    return { outcome: "provided", passphrase: value };
  };
}
