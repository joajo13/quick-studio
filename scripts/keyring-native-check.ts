/**
 * Compiled-binary native-load check for @napi-rs/keyring (Story 2.1 / AR-20).
 *
 * The product ships via `bun build --compile`, and a native `.node` addon may
 * not embed cleanly into a self-contained binary. `bun test` only proves the
 * addon loads from the source tree — NOT from the real distribution artifact.
 * This script is compiled the same way the product is (`bun build --compile
 * scripts/keyring-native-check.ts`) and then run: if the native module fails to
 * load from the embedded binary, the guarded `await import("keychain.ts")` throws
 * and the catch reports it before exiting non-zero, failing the CI leg loudly.
 * (`bun build --compile` still statically bundles the addon — keychain.ts's
 * `@napi-rs/keyring` import is a string literal — so the dynamic import only moves
 * the failure into the try, it does not change what gets embedded.)
 *
 * By default a `keychain-unavailable` result is NOT a failure here: it means the
 * addon loaded fine but the platform has no backend. Only an unhandled throw
 * (module did not load) is a failure.
 *
 * When `KEYRING_REQUIRE_ROUNDTRIP=1` (set by the CI legs, which each provision or
 * guarantee a real backend), the check additionally FAILS if a real round-trip
 * did not happen (`store -> found(matches) -> deleted`). This closes the gap
 * where a silently-broken keyring provisioning (e.g. gnome-keyring failing to
 * unlock) would otherwise leave CI green on `unavailable` without proving the
 * keychain path — turning a passing CI leg into an actual per-platform proof.
 *
 * Self-cleaning; never writes a real credential.
 */

const SERVICE = "quick-studio-native-check";
const ACCOUNT = `compiled-${crypto.randomUUID()}`;
const SECRET = `probe-${crypto.randomUUID()}`;
const REQUIRE_ROUNDTRIP = process.env.KEYRING_REQUIRE_ROUNDTRIP === "1";

try {
  // Import INSIDE the try: loading keychain.ts pulls in the native @napi-rs/keyring
  // addon, and a compiled-binary embed/load failure surfaces exactly here — the
  // failure this check exists to catch. A top-level static import would throw
  // during module evaluation, before the try, making the catch below dead for it.
  const { deleteSecret, getSecret, setSecret } = await import("../src/core/keychain.ts");

  const set = setSecret(SERVICE, ACCOUNT, SECRET);
  console.log(`native-check: setSecret -> ${set.outcome}`);

  const got = getSecret(SERVICE, ACCOUNT);
  const roundTripped = got.outcome === "found" && got.value === SECRET;
  if (got.outcome === "found") {
    console.log(`native-check: getSecret -> found (matches=${got.value === SECRET})`);
  } else {
    console.log(`native-check: getSecret -> ${got.outcome}`);
  }

  const del = deleteSecret(SERVICE, ACCOUNT);
  console.log(`native-check: deleteSecret -> ${del.outcome}`);

  if (REQUIRE_ROUNDTRIP && !roundTripped) {
    // This platform was expected to have a working backend, but no real
    // round-trip occurred — treat it as a hard failure so CI cannot green-light a
    // keychain path it never actually exercised.
    console.error(
      `native-check: FAILED — KEYRING_REQUIRE_ROUNDTRIP=1 but no real round-trip ` +
        `(set=${set.outcome}, get=${got.outcome}). Backend likely unavailable/unprovisioned.`,
    );
    process.exit(1);
  }

  // The native addon loaded and every call returned a typed result. Whether the
  // platform round-tripped or reported unavailable, the distribution path works.
  console.log("native-check: OK — @napi-rs/keyring loaded from the compiled binary");
  process.exit(0);
} catch (err) {
  // Reaching here means the native module could not be loaded/called from the
  // compiled binary — the exact failure this check exists to surface.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`native-check: FAILED — native module did not load: ${msg}`);
  process.exit(1);
}
