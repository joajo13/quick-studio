/**
 * quick-studio Core — `QS_SELFCHECK` resolution (DW-89).
 *
 * A hidden, CI-facing diagnostic switch. `.github/workflows/release.yml` runs the
 * SHIPPED `quick-studio-<os>-<arch>` binary with `QS_SELFCHECK=keychain` so the
 * release keyring gate interrogates the exact artifact users download, instead of
 * a second artifact compiled from `scripts/keyring-native-check.ts` that is
 * equivalent to it only by accident of a currently-static import chain.
 *
 * Deliberately dependency-free — ZERO imports, and it must stay that way. `bin/`
 * imports this module STATICALLY, before it knows whether a self-check was even
 * asked for; the round-trip itself therefore lives in `./keychain-self-check.ts`,
 * which `bin/` imports dynamically inside its own `try`.
 *
 * Be honest about what that split buys TODAY. `bin/quick-studio.ts` already
 * reaches `./keychain.ts` through a STATIC chain (`first-run-setup.ts` → … →
 * `keychain.ts` → the top-level `@napi-rs/keyring` import), so on a binary that
 * did not embed its binding the load throws during module evaluation, before the
 * branch runs at all: loud and non-zero, but an uncaught stack trace rather than
 * the clean `selfcheck: FAILED — native module did not load` line. The dynamic
 * import and its `catch` are what make that clean report — and the self-check as a
 * whole — correct the moment that chain goes lazy, which is exactly the future
 * DW-89 exists to guard. Pulling the keychain module in HERE would move the
 * failure permanently outside the branch's `try` and make the report dead code
 * forever, so the two-module split is right in both worlds.
 *
 * This is not a user knob: it mutates the OS keychain (it stores and deletes one
 * probe entry) and it exits without booting the Core. It is deliberately absent
 * from BOTH `HELP_TEXT` and the README's environment table. `QS_NO_UPDATE_CHECK`
 * is only a PARTIAL precedent: it is hidden from `HELP_TEXT` but is documented in
 * the README's environment list (`README.md`), because it is a real user knob that
 * simply does not deserve help-text space. `QS_SELFCHECK` goes further — out of
 * both — because it is a CI probe that writes to the OS keychain, and it is
 * documented in `docs/keyring-spike-decision.md` instead.
 */

/**
 * What `QS_SELFCHECK` asked for. `unknown` carries the offending value so the
 * caller can name it back: an unrecognized value must be LOUD, never a silent
 * fall-through. A gate that typos `QS_SELFCHECK=kaychain` and gets ignored would
 * boot the Core on a CI runner and sit there until the job's `timeout-minutes`
 * expires, reporting a 30-minute hang instead of a typo.
 *
 * Adding an arm here is a change to `bin/quick-studio.ts` too: the branch there
 * is a sequence of `if`s whose fall-through boots the Core, so a new mode left
 * unhandled would silently start a server on a release runner. A `never`
 * exhaustiveness guard after the last `if` makes that a COMPILE error rather than
 * a discovery made at `timeout-minutes`.
 */
export type SelfCheckMode =
  | { readonly kind: "none" }
  | { readonly kind: "keychain" }
  | { readonly kind: "unknown"; readonly value: string };

/**
 * Resolve the `QS_SELFCHECK` request. Pure: no I/O, no `process` reads.
 *
 * Unset and `""` both mean "not requested" — the same treatment `resolvePort`
 * gives an empty `QS_PORT`, and the shape a workflow produces when it defines the
 * variable conditionally. Matching is exact: case-sensitive and untrimmed, so
 * `"Keychain"` and `" keychain"` are `unknown` rather than silently coerced. That
 * is the point — the only way to reach the keychain branch is to have spelled it
 * the way the gate documents it.
 */
export function resolveSelfCheckMode(env: {
  readonly QS_SELFCHECK?: string | undefined;
  // The index signature is what makes `process.env` assignable here: without it
  // TS's weak-type check rejects a `ProcessEnv` that declares none of the named
  // keys. Same shape as `RunModeEnv` and `runUpdateCheck`'s env parameter.
  readonly [key: string]: string | undefined;
}): SelfCheckMode {
  const raw = env.QS_SELFCHECK;
  if (raw === undefined || raw === "") return { kind: "none" };
  if (raw === "keychain") return { kind: "keychain" };
  return { kind: "unknown", value: raw };
}

/** Cap on the echoed value, mirroring `keychain.ts`'s `MAX_DETAIL_LEN` in spirit: the
 * only legitimate value is 8 characters long, so anything past this is noise. */
const MAX_ECHOED_VALUE_LEN = 60;

/**
 * Make an unrecognized `QS_SELFCHECK` value safe to echo into a log line.
 *
 * The resolver above keeps the value VERBATIM on purpose — naming back exactly
 * what was set is the whole point of the `unknown` arm — but the value is
 * attacker-adjacent input (a workflow file, a shell export) that lands in a public
 * CI log, so the printing site bounds it. Newlines would let a value forge
 * additional log lines; an ESC byte would let it repaint the terminal or hide
 * text behind ANSI; a bidi override or a zero-width character would let it
 * visually reorder or hide the REST of the line without containing a single
 * control byte. `src/core/keychain.ts`'s `formatErrorDetail` bounds its `detail`
 * for exactly this reason and this mirrors it: every Unicode control (`Cc` — C0,
 * DEL, C1, where the newline, CR, tab and the ANSI-introducing ESC live) and every
 * format character (`Cf` — the bidi overrides and isolates, ZWSP, ZWNJ, word
 * joiners, BOM) becomes a space, runs of whitespace collapse to one, and the
 * result is truncated BY CODE POINT so a multi-byte value cannot leave a split
 * surrogate at the cut. Pure; no I/O, so it stays importable by `bin/` statically.
 */
export function formatSelfCheckValue(value: string): string {
  const flattened = value
    // `Cc` is C0 + DEL + C1 (newline, CR, tab, ESC); `Cf` is the invisible
    // formatting layer (U+202E RIGHT-TO-LEFT OVERRIDE, U+2066 LRI, U+200B ZWSP,
    // U+FEFF BOM). Neither may survive into a CI log line: the first forges lines
    // and repaints terminals, the second reorders or hides the text around it.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = [...flattened];
  return points.length > MAX_ECHOED_VALUE_LEN
    ? `${points.slice(0, MAX_ECHOED_VALUE_LEN).join("")}…`
    : flattened;
}
