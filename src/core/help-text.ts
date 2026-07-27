/**
 * quick-studio Core — `--help` usage text (Story 11.1).
 *
 * A plain, standalone constant: no imports, no version interpolation (the
 * version has its own flag/module, `--version` / `version.generated.ts`), so
 * this stays independent and can compile before any generated module exists.
 * Keeping it out of `cli-args.ts` keeps the parser free of presentation
 * concerns; `bin/quick-studio.ts` writes it verbatim to stdout on `--help`.
 *
 * Every environment variable and flag listed here must stay in lockstep with
 * what `cli-args.ts` / `binding.ts` / the passphrase-fd reader actually honor
 * — `help-text.test.ts` is a cheap drift guard, but this file is the source
 * the README's own Flags/Environment sections are copied from.
 */

export const HELP_TEXT = `Usage:
  quick-studio                    Launch Persistent workspace
  quick-studio <database-url>     Launch Ephemeral, connected to <database-url>
  quick-studio --persistent       Launch Persistent workspace explicitly

Options:
  -h, --help       Show this help and exit
  -v, --version    Show the version and exit
  --persistent     Select Persistent mode explicitly (contradicts a DB URL)
  --ephemeral      Select Ephemeral mode explicitly (no connection required)
  --no-open        Do not launch the OS default browser after boot

Environment:
  QS_HOST            Bind host (default loopback 127.0.0.1)
  QS_PORT            Bind port (default 0, an ephemeral free port)
  QS_MODE            Default run mode when no flag/URL is given: persistent | ephemeral
  QS_NO_OPEN         Non-empty value suppresses browser-open, same as --no-open
  QS_PASSPHRASE      Passphrase for the keychain-less fallback (Persistent mode)
  QS_PASSPHRASE_FD   File descriptor to read the passphrase from instead of QS_PASSPHRASE
`;
