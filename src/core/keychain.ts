/**
 * quick-studio Core — OS-keychain wrapper (Ring 1 only; AR-20).
 *
 * Epic 2's encrypted credential store holds its AES-256-GCM key in the OS
 * keychain (Windows Credential Manager / Linux Secret Service) via the native
 * `@napi-rs/keyring` NAPI addon. AR-20 flags that NAPI parity under Bun is
 * "almost, not 100%" and unproven per-platform, so this module is deliberately
 * minimal: it is the single place the native side-effect is touched, and it
 * translates every failure mode into a *typed* result instead of letting a
 * native throw escape.
 *
 * Contract (the signal Story 2.3's passphrase fallback keys off):
 *  - A missing entry is a first-class `not-found` result, never a throw.
 *  - An unreachable backend (e.g. headless Linux with no Secret Service / D-Bus)
 *    is a first-class `unavailable` result, never a throw and NEVER a silent
 *    plaintext fallback — the caller decides what to do (Story 2.3).
 *  - Secret VALUES are never logged or embedded in a result's `detail`.
 *
 * This is only enough surface to prove the path. The durable store API (service
 * / account naming, rotation, etc.) is designed in Story 2.2.
 */

import { Entry } from "@napi-rs/keyring";

/** Outcome of {@link setSecret}: the value was stored, or the backend was unreachable. */
export type KeychainSetResult =
  | { readonly outcome: "stored" }
  | { readonly outcome: "unavailable"; readonly detail: string };

/**
 * Outcome of {@link getSecret}: the value was found, there is no such entry, or
 * the backend was unreachable. `not-found` is the null-ish "no error" case.
 */
export type KeychainGetResult =
  | { readonly outcome: "found"; readonly value: string }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "unavailable"; readonly detail: string };

/**
 * Outcome of {@link deleteSecret}: an entry was removed, there was nothing to
 * remove, or the backend was unreachable.
 */
export type KeychainDeleteResult =
  | { readonly outcome: "deleted" }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "unavailable"; readonly detail: string };

/** Any of the three wrapper results carries this discriminant. */
export type KeychainOutcome =
  | KeychainSetResult["outcome"]
  | KeychainGetResult["outcome"]
  | KeychainDeleteResult["outcome"];

/**
 * Substrings that identify a "no such credential" native error, in case a
 * platform's binding throws NoEntry instead of returning a null-ish value
 * (Linux Secret Service returns null on miss; other backends may differ). These
 * are matched case-insensitively against the thrown error's message. Anything
 * that does NOT match is treated as a backend-unavailable condition.
 */
const NOT_FOUND_MARKERS: ReadonlyArray<string> = [
  "no matching entry",
  "no entry",
  "not found",
  "element not found", // Windows Credential Manager wording
];

/** Cap on a `detail` string so a verbose native/D-Bus error can't bloat a caller's log. */
const MAX_DETAIL_LEN = 200;

/**
 * Normalize an unknown thrown value into a single-line, bounded, secret-free
 * detail string. Pure. When `secret` is supplied (the value the caller passed to
 * `setSecret`), any verbatim occurrence is redacted, upholding the module's
 * no-secret-in-detail contract even if a native error echoes the input back.
 */
export function formatErrorDetail(err: unknown, secret?: string): string {
  let raw = err instanceof Error ? err.message : String(err);
  // Redact the verbatim secret BEFORE collapsing whitespace. Whitespace
  // normalization rewrites any secret containing a newline/tab/double-space, so a
  // redaction that ran only afterward would fail to match and let the (collapsed)
  // secret survive into `detail`.
  if (secret && secret.length > 0) {
    raw = raw.split(secret).join("***");
  }
  // Collapse whitespace/newlines so the detail stays a single tidy line.
  raw = raw.replace(/\s+/g, " ").trim();
  // Redact again against the whitespace-collapsed secret, in case the native
  // error echoed a re-spaced form of it that only matches post-normalization.
  if (secret && secret.length > 0) {
    const collapsedSecret = secret.replace(/\s+/g, " ").trim();
    if (collapsedSecret.length > 0) {
      raw = raw.split(collapsedSecret).join("***");
    }
  }
  // Truncate by code point (not UTF-16 unit) so a multi-byte native error can't
  // leave a split surrogate dangling at the cut.
  const points = [...raw];
  return points.length > MAX_DETAIL_LEN
    ? `${points.slice(0, MAX_DETAIL_LEN).join("")}…`
    : raw;
}

/**
 * True when a thrown native error means "no such credential" rather than "backend
 * down". Pure. NOTE (Story 2.1 / AR-20): this English substring heuristic is a
 * provisional hedge for backends that throw NoEntry (e.g. Windows Credential
 * Manager) instead of returning null. It is locale-fragile and must be replaced
 * with typed error codes once real per-platform error shapes are observed in CI /
 * Story 2.2 — see the decision record and deferred-work ledger. The classifier
 * fails safe: anything not recognized as not-found is treated as `unavailable`,
 * so an unknown error triggers the passphrase fallback rather than silently
 * masquerading as an empty entry.
 */
export function isNotFoundError(err: unknown): boolean {
  const msg = formatErrorDetail(err).toLowerCase();
  return NOT_FOUND_MARKERS.some((m) => msg.includes(m));
}

/**
 * Build the native entry handle. Isolated so the sole `new Entry(...)` call site
 * lives in one place; a throw here (rare — construction is usually lazy) is
 * surfaced by the callers as `unavailable`.
 */
function openEntry(service: string, account: string): Entry {
  return new Entry(service, account);
}

/**
 * Store `value` under `(service, account)` in the OS keychain. Returns `stored`
 * on success, or `unavailable` (with a secret-free detail) if the backend could
 * not be reached. Never throws; never writes plaintext anywhere on failure.
 */
export function setSecret(
  service: string,
  account: string,
  value: string,
): KeychainSetResult {
  try {
    openEntry(service, account).setPassword(value);
    return { outcome: "stored" };
  } catch (err) {
    // Redact `value` in case the native error echoes it back.
    return { outcome: "unavailable", detail: formatErrorDetail(err, value) };
  }
}

/**
 * Retrieve the value stored under `(service, account)`. Returns `found` with the
 * value, `not-found` if there is no such entry (a null-ish, non-error outcome),
 * or `unavailable` if the backend could not be reached. Never throws.
 */
export function getSecret(service: string, account: string): KeychainGetResult {
  let value: string | null;
  try {
    value = openEntry(service, account).getPassword();
  } catch (err) {
    // Some bindings throw NoEntry instead of returning null; treat that as a
    // clean not-found, everything else as an unreachable backend.
    if (isNotFoundError(err)) {
      return { outcome: "not-found" };
    }
    return { outcome: "unavailable", detail: formatErrorDetail(err) };
  }
  if (value === null || value === undefined) {
    return { outcome: "not-found" };
  }
  return { outcome: "found", value };
}

/**
 * Delete the entry stored under `(service, account)`. Returns `deleted` if an
 * entry was removed, `not-found` if there was nothing to remove, or
 * `unavailable` if the backend could not be reached. Never throws — safe to call
 * unconditionally as a cleanup step.
 */
export function deleteSecret(
  service: string,
  account: string,
): KeychainDeleteResult {
  try {
    const removed = openEntry(service, account).deletePassword();
    return removed ? { outcome: "deleted" } : { outcome: "not-found" };
  } catch (err) {
    if (isNotFoundError(err)) {
      return { outcome: "not-found" };
    }
    return { outcome: "unavailable", detail: formatErrorDetail(err) };
  }
}
