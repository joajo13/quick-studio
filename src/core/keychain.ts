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
 *  - A missing entry is a first-class `not-found` result, signalled STRUCTURALLY,
 *    never a throw and never by parsing message text. The observed
 *    `@napi-rs/keyring` contract is that a miss is a null-ish return, not an
 *    exception: `Entry.getPassword()` returns `null` for a missing credential and
 *    `Entry.deletePassword()` returns `false`. So `not-found` is precisely the
 *    `null`/`false` return — locale-independent and reword-proof (DW-10).
 *  - An unreachable backend (e.g. headless Linux with no Secret Service / D-Bus)
 *    is a first-class `unavailable` result, never a throw and NEVER a silent
 *    plaintext fallback — the caller decides what to do (Story 2.3). Because a miss
 *    surfaces as a null-ish return (above), a *thrown* native error is never a
 *    missing entry — it is always a genuine backend failure, so EVERY throw
 *    classifies as `unavailable`. `@napi-rs/keyring` flattens every native keyring
 *    kind (NoEntry, PlatformFailure, …) into a generic `Error` with
 *    `code:"GenericFailure"` — the kind lives only inside the message Display, so
 *    there are no typed error codes to key off at the JS boundary and no reason to
 *    inspect the message: any throw is `unavailable`, the fail-safe direction.
 *  - A caller programming error — an empty (`""`) or blank (whitespace-only)
 *    `service` or `account` — is a first-class `invalid-argument` result,
 *    DISTINCT from `unavailable`. It is a surfaced bug, NOT a missing-backend
 *    condition, so it must never masquerade as `unavailable` and silently trigger
 *    the passphrase fallback. Its `detail` names WHICH identifier is bad and, like
 *    every detail, is secret-free. The guard runs BEFORE any identifier reaches
 *    the native store, so an unknown native throw still fails safe to `unavailable`
 *    and the `not-found` path is unchanged.
 *  - Secret VALUES are never logged or embedded in a result's `detail`.
 *
 * This is only enough surface to prove the path. The durable store API (service
 * / account naming, rotation, etc.) is designed in Story 2.2.
 */

import { Entry } from "@napi-rs/keyring";

/** Outcome of {@link setSecret}: the value was stored, an identifier was invalid, or the backend was unreachable. */
export type KeychainSetResult =
  | { readonly outcome: "stored" }
  | { readonly outcome: "invalid-argument"; readonly detail: string }
  | { readonly outcome: "unavailable"; readonly detail: string };

/**
 * Outcome of {@link getSecret}: the value was found, there is no such entry, an
 * identifier was invalid, or the backend was unreachable. `not-found` is the
 * null-ish "no error" case.
 */
export type KeychainGetResult =
  | { readonly outcome: "found"; readonly value: string }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "invalid-argument"; readonly detail: string }
  | { readonly outcome: "unavailable"; readonly detail: string };

/**
 * Outcome of {@link deleteSecret}: an entry was removed, there was nothing to
 * remove, an identifier was invalid, or the backend was unreachable.
 */
export type KeychainDeleteResult =
  | { readonly outcome: "deleted" }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "invalid-argument"; readonly detail: string }
  | { readonly outcome: "unavailable"; readonly detail: string };

/** Any of the three wrapper results carries this discriminant. */
export type KeychainOutcome =
  | KeychainSetResult["outcome"]
  | KeychainGetResult["outcome"]
  | KeychainDeleteResult["outcome"];

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
 * Validate the caller-supplied identifiers. Pure and deterministic: returns a
 * secret-free reason string naming the offending identifier when `service` or
 * `account` is not a
 * string (e.g. `null`/`undefined` from an untyped/IPC/JSON caller) or is empty
 * (`""`) or blank (whitespace-only, i.e. `.trim().length === 0`), else `null`.
 * The non-string check runs FIRST so the subsequent `.trim()` can never throw —
 * upholding the module's never-throws contract at this defensive boundary (the
 * `string` type signature does not guard a runtime edge whose whole job is
 * catching caller bugs). The reason names only the role (`service`/`account`),
 * never the identifier's contents and never any secret value. Called at the top
 * of each wrapper so a caller programming error surfaces as `invalid-argument`
 * instead of throwing or being routed to `unavailable` by a `new Entry(...)` throw.
 */
export function validateIdentifiers(service: string, account: string): string | null {
  if (typeof service !== "string" || service.trim().length === 0) {
    return "service must be a non-empty, non-blank string";
  }
  if (typeof account !== "string" || account.trim().length === 0) {
    return "account must be a non-empty, non-blank string";
  }
  return null;
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
 * on success, `invalid-argument` (with a secret-free detail) if `service`/`account`
 * is missing/empty/blank, or `unavailable` (with a secret-free detail) if the
 * backend could not be reached. Never throws; never writes plaintext anywhere on
 * failure.
 */
export function setSecret(
  service: string,
  account: string,
  value: string,
): KeychainSetResult {
  const bad = validateIdentifiers(service, account);
  if (bad) return { outcome: "invalid-argument", detail: bad };
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
 * value, `not-found` if there is no such entry, `invalid-argument` if
 * `service`/`account` is missing/empty/blank, or `unavailable` if the backend
 * could not be reached. Never throws.
 *
 * Classification is STRUCTURAL, never message-text based: `@napi-rs/keyring`'s
 * `Entry.getPassword()` returns `null` for a missing credential (it does not throw
 * NoEntry), so `not-found` is exactly the null-ish return. Every throw is therefore
 * a genuine backend failure — the binding flattens all native kinds into a generic
 * `Error{code:"GenericFailure"}`, so there is nothing typed to distinguish and no
 * reason to parse the Display — and classifies as `unavailable`, the fail-safe
 * direction that triggers Story 2.3's passphrase fallback.
 */
export function getSecret(service: string, account: string): KeychainGetResult {
  const bad = validateIdentifiers(service, account);
  if (bad) return { outcome: "invalid-argument", detail: bad };
  let value: string | null;
  try {
    value = openEntry(service, account).getPassword();
  } catch (err) {
    // A miss is the `null` return (below), never a throw — so any throw is a
    // genuine backend failure. Classify structurally as `unavailable`; no
    // message-text heuristic is consulted.
    return { outcome: "unavailable", detail: formatErrorDetail(err) };
  }
  if (value === null || value === undefined) {
    return { outcome: "not-found" };
  }
  return { outcome: "found", value };
}

/**
 * Delete the entry stored under `(service, account)`. Returns `deleted` if an
 * entry was removed, `not-found` if there was nothing to remove,
 * `invalid-argument` if `service`/`account` is missing/empty/blank, or
 * `unavailable` if the backend could not be reached. Never throws — safe to call
 * unconditionally as a cleanup step.
 *
 * Classification is STRUCTURAL, never message-text based: `@napi-rs/keyring`'s
 * `Entry.deletePassword()` returns `false` when there was nothing to remove (it
 * does not throw NoEntry), so `not-found` is exactly the `false` return. Every
 * throw is a genuine backend failure — the binding flattens all native kinds into
 * a generic `Error{code:"GenericFailure"}` — and classifies as `unavailable`.
 */
export function deleteSecret(
  service: string,
  account: string,
): KeychainDeleteResult {
  const bad = validateIdentifiers(service, account);
  if (bad) return { outcome: "invalid-argument", detail: bad };
  try {
    const removed = openEntry(service, account).deletePassword();
    return removed ? { outcome: "deleted" } : { outcome: "not-found" };
  } catch (err) {
    // A "nothing to remove" is the `false` return (above), never a throw — so any
    // throw is a genuine backend failure. Classify structurally as `unavailable`.
    return { outcome: "unavailable", detail: formatErrorDetail(err) };
  }
}
