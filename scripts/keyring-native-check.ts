/**
 * Compiled-binary native-load check for @napi-rs/keyring (Story 2.1 / AR-20).
 *
 * This is the SPIKE entry point: `.github/workflows/keyring-spike.yml` compiles it
 * the same way the product is compiled (`bun build --compile
 * scripts/keyring-native-check.ts`) and runs it per OS under
 * `KEYRING_REQUIRE_ROUNDTRIP=1`, on legs that provision a real backend, to attest
 * a genuine per-platform round-trip. Its stdout/stderr line format, its exit
 * codes, and its env contract are the workflow's interface — they are unchanged.
 *
 * The round-trip itself now lives in `src/core/keychain-self-check.ts` (DW-89).
 * The RELEASE gate no longer compiles this script into a second artifact: it runs
 * the shipped `quick-studio-<os>-<arch>` binary with `QS_SELFCHECK=keychain`,
 * which calls the same shared function. That is the point of the extraction — the
 * spike path and the release path execute one implementation, so they can no
 * longer drift into being "equivalent only by accident" of a static import chain.
 * This script stays because the spike workflow's job is different: it attests the
 * round-trip on a provisioned backend, which the release gate deliberately does
 * not demand.
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

try {
  // Import INSIDE the try: loading the self-check module pulls in keychain.ts and
  // with it the native @napi-rs/keyring addon, so a compiled-binary embed/load
  // failure surfaces exactly here — the failure this check exists to catch. A
  // top-level static import would throw during module evaluation, before the try,
  // making the catch below dead for it. (`bun build --compile` still statically
  // bundles the addon — every specifier on the chain is a string literal — so the
  // dynamic import only moves the failure into the try, it does not change what
  // gets embedded.)
  const { runKeychainSelfCheck } = await import("../src/core/keychain-self-check.ts");

  // `label: "native-check"` keeps every emitted line byte-identical to what this
  // script has always printed; keyring-spike.yml's legs read that output.
  process.exit(runKeychainSelfCheck(process.env, { label: "native-check" }));
} catch (err) {
  // Reaching here means the native module could not be loaded/called from the
  // compiled binary — the exact failure this check exists to surface.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`native-check: FAILED — native module did not load: ${msg}`);
  process.exit(1);
}
