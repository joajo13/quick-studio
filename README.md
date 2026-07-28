# quick-studio

Lightweight, local-first database manager (Postgres + MySQL). Runs entirely on
your machine: it boots a trusted local Core that serves a browser UI over
loopback, gated by a per-boot session token.

> Walking skeleton — epic 1. The UI shell, local Core, token-gated RPC,
> clean shutdown, and the Port-Exposure Warning are in place. Database connect
> and persistence land in later epics.

## Install

### A. npm (recommended)

Only [Node.js](https://nodejs.org) `>= 18` is required — the published package
ships a self-contained binary for your platform, so **no Bun** and no bundler are
needed at run time.

Run it once, without installing anything permanent:

```sh
npx -y quick-studio <db-url>
```

`-y` skips npx's install prompt. Or install it globally for a permanent command:

```sh
npm i -g quick-studio
quick-studio
```

To update, ask for the newest version explicitly (this bypasses npx's cache):

```sh
npx quick-studio@latest <db-url>
```

npm installs only the prebuilt binary for your platform (`win32-x64`,
`linux-x64`, or `linux-arm64`); the others are skipped automatically. macOS is
not yet supported — use the standalone binary or wait for a later release.

### B. Standalone binary

Prefer no npm at all? Download the self-contained binary for your platform from
the [GitHub Releases](../../releases) page. Every release also attaches a
`SHA256SUMS` file covering every published binary, so you can verify what you
downloaded — download it alongside the binary, into the same directory:

- **Linux (x64):** `quick-studio-linux-x64`
- **Linux (ARM64):** `quick-studio-linux-arm64`
- **Windows (x64):** `quick-studio-windows-x64.exe`
- **Checksums:** `SHA256SUMS`

The binary is self-contained — no Bun, Node, or bundler required. Each one is
compiled natively on a runner matching its own OS/architecture (never
cross-compiled), so the OS-keychain integration works out of the box. macOS is
not yet supported — a later phase adds it once its keyring path is validated
in CI; see [docs/keyring-spike-decision.md](docs/keyring-spike-decision.md).

**Linux (x64 or ARM64)**

With the binary and `SHA256SUMS` downloaded into the same directory — verify
first, then run:

```sh
BIN=quick-studio-linux-x64        # or quick-studio-linux-arm64
sha256sum --ignore-missing -c SHA256SUMS && chmod +x "$BIN" && ./"$BIN"
```

The `&&` chain is load-bearing: on a checksum mismatch `sha256sum` exits
non-zero and the binary is never made executable and never runs. As separate
lines the `FAILED` message would just scroll past and the binary would run
anyway.

`SHA256SUMS` covers every published binary, so `--ignore-missing` is what you
want unless you downloaded all of them (a plain `-c` reports the ones you did
not download as failures).

**Windows**

With `quick-studio-windows-x64.exe` and `SHA256SUMS` downloaded into the same
directory — verify first, then run:

```powershell
$expected = ((Select-String -Path SHA256SUMS -Pattern 'quick-studio-windows-x64\.exe').Line -split '\s+')[0]
$actual = (Get-FileHash quick-studio-windows-x64.exe -Algorithm SHA256).Hash
if ($actual -ine $expected) { Write-Error "checksum mismatch - do not run this binary" } else { .\quick-studio-windows-x64.exe }
```

Verification is pass/fail rather than a hash you eyeball, and the run happens
only in the matching branch — a mismatch prints an error and stops. If
`SHA256SUMS` is missing or has no line for this file, `$expected` is empty, the
comparison fails, and the binary still does not run.

## Run

quick-studio prints the bound URL to stderr on start, e.g.
`quick-studio Core listening on http://127.0.0.1:<port>`. Open that URL in your
browser.

### First run

A bare `quick-studio` with nothing configured yet still boots Persistent mode —
it never refuses to boot just because there is no saved connection — but it
prints one terse hint right after the listening-URL line:

```
quick-studio: no connections saved yet — this looks like a first run.
  - Add one in the UI at the URL above: the "Settings" Tab, "connections" section.
  - Or start a throwaway session directly: quick-studio <database-url>
```

When this is also the first time the workspace itself is opened — nothing saved,
nothing to restore — the UI lands straight on the **Settings** Tab's
**connections** form instead of an empty tree, so the next step is obvious without
reading the hint at all (with `--no-open`/`QS_NO_OPEN` no browser is launched, but
the page you open yourself still lands there). If a workspace *was* saved earlier,
it is restored as-is and nothing is re-focused — your tabs are never hijacked, and
the hint above is the only nudge you get. The database URL is asked for **in that
form** — quick-studio never prompts for one on the terminal.

That onboarding Tab is opened for the session, not written to your saved
workspace: it is not what a later launch restores, and closing it is respected —
it will not reappear the next time you start.

Once quick-studio has a local store, a bare `quick-studio` boots as it did before
this hint existed: the listening-URL line only, and the workspace opens wherever
you last left it — no new prompt, and no new work beyond a handful of file-exists
checks before the server starts. Ephemeral mode
(`quick-studio <database-url>`, `--ephemeral`, or `QS_MODE=ephemeral`) never
consults this check at all and never touches the app-data directory.

The check is deliberately coarse: it asks *"has this machine ever been set up?"*,
not *"does a connection exist?"*. So it stops firing as soon as anything is stored
locally — a saved connection, but equally a saved AI provider key, or the store
that the passphrase setup creates on a host with no OS keychain. On those hosts
the hint appears once, on the very first boot, and not again; from then on the
UI's own empty state ("Sin conexión activa — Agregá una conexión en Ajustes") is
what points the way. Nothing is ever written just to answer this question.

### Flags

- **`-h, --help`** — print usage and exit 0 (stdout; the Core never boots).
- **`-v, --version`** — print the version and exit 0 (stdout; the Core never boots).
- **`--persistent`** — select Persistent mode explicitly. Contradicts a database
  URL positional (both can't be selected at once).
- **`--ephemeral`** — select Ephemeral mode explicitly, with no database
  connection configured (`quick-studio --ephemeral <url>` is also valid — the
  URL is carried through). Contradicts `--persistent`.
- **`--no-open`** — do not launch the OS default browser after boot.

### Commands

- **`quick-studio update`** — a read-only, advisory command. It detects how this
  copy was installed and prints the exact command or URL to upgrade it (the
  `npm i -g quick-studio@latest` command for an npm install, or the
  [GitHub Releases](../../releases) download URL plus how to verify it against
  `SHA256SUMS` for a standalone binary; both, if the install channel can't be told
  apart). It performs no download and no self-replacement, and exits 0 without
  booting the Core.

### Update check

On a Persistent boot, quick-studio does one **non-blocking** check for a newer
release: it reads a cached result and, at most, prints a single stderr line when
a newer version is available. If the cache is older than **24 hours** it fires a
background request to the npm registry (`registry.npmjs.org`) and writes the
result for the *next* boot — the boot itself never waits on the network, and any
failure (offline, timeout, bad response) is a silent no-op. The request is a
plain version lookup and **nothing else** is sent — no telemetry, no identifiers,
no machine info. Ephemeral mode never participates: it reads and writes nothing.

Behavior (the environment variables below are honored by the CLI; for `QS_MODE`,
a flag or an explicit database URL overrides it — the others have no flag
equivalent):

- **`QS_HOST`** — overrides the bind host (default loopback `127.0.0.1`). A
  non-loopback value (a concrete IP or wildcard `0.0.0.0` / `::`) makes the Core
  reachable from other machines and triggers a loud **Port-Exposure Warning** on
  stderr and an in-page banner. Only the session token stands between the
  network and your data — use with intent. The Ring 3 chart sandbox is *not*
  exposed with it: it always binds loopback, so **chat answers that carry a
  chart do not render off-host** — a remote viewer sees an empty pane where the
  chart would be, and loses the prose narration too (a chart answer replaces its
  text bubble with the sandbox frame). The generated SQL and the result table
  still render, so the data itself is not lost. (The **Report** tab is
  unaffected: it draws in-app.) The sandbox origin carries no session token, so
  making it reachable would mean exposing something with nothing left to
  authenticate.
- **`QS_PORT`** — overrides the bind port. `0` (the default) picks an ephemeral
  free port.
- **`QS_MODE`** — default run mode when no flag/URL is given: `persistent`
  (default) or `ephemeral`. Overridden by a database URL positional or by
  `--ephemeral`/`--persistent`.
- **`QS_NO_OPEN`** — a non-empty value suppresses browser-open, same as
  `--no-open`.
- **`QS_NO_UPDATE_CHECK`** — a non-empty value disables the update check entirely,
  in every mode (no cache read, no registry request).

Press `Ctrl-C` to stop; the session ends cleanly and the port is released.

## Persistent mode & the keychain-less fallback

In Persistent mode quick-studio encrypts saved connections and AI provider keys at
rest. The encryption key normally comes from the OS keychain. On a headless host
with no keychain, it is instead derived from a passphrase you supply.

- **`QS_PASSPHRASE`** — the default passphrase source. Convenient, but the value
  lives in the process environment, which is a known secret-leak surface: on the
  same host it is readable via `/proc/<pid>/environ`, it is inherited by every
  child process quick-studio spawns, and it can be captured in a core dump. It is
  never written to disk or logged, but prefer the file-descriptor transport below
  on any multi-tenant or shared host.
- **`QS_PASSPHRASE_FD`** — the hardened alternative. It carries a **file
  descriptor number**, not the secret; quick-studio reads the passphrase from that
  fd once and the secret never enters the environment. Feed it over stdin or an
  inherited fd:

  ```sh
  # stdin (fd 0)
  printf %s "$SECRET" | QS_PASSPHRASE_FD=0 quick-studio
  # an inherited fd from a file
  QS_PASSPHRASE_FD=3 quick-studio 3< secretfile
  ```

  Exactly one trailing newline is stripped from the fd contents, so feed the exact
  passphrase bytes (`printf %s` adds none; a heredoc or `echo` would add one that
  is stripped). Both the connection store and the provider-key store unlock from
  that single fd read.

  Selection is opt-in: when `QS_PASSPHRASE_FD` is unset **or blank**, quick-studio
  uses the `QS_PASSPHRASE` env default. Only a present, non-empty, non-integer
  value (e.g. `abc`) is rejected — it declines rather than silently falling back to
  the environment, since setting it signals you opted out of the env transport.

  A misconfigured fd transport fails safe by declining, which surfaces as "no
  passphrase provided" with no separate error. If Persistent mode reports that
  while you believe you supplied a passphrase, check that the fd is actually
  inherited (e.g. the `3< secretfile` redirect or the `| QS_PASSPHRASE_FD=0` pipe
  is present) and that the fd number matches.
- **Interactive prompt** — the third, terminal-driven way to supply a passphrase,
  for a keychain-less host with neither env var set. It appears only when **all
  four** of these hold:
  1. the run is in Persistent mode — either explicitly via `--persistent`, or by
     default when no `--url` and no `--ephemeral` was given and `QS_MODE` is not
     `ephemeral`;
  2. neither `QS_PASSPHRASE` nor `QS_PASSPHRASE_FD` is set;
  3. the OS keychain is unreachable on this host;
  4. **both** stdin and stderr are an interactive terminal (a TTY). stderr matters
     because that is where the prompt is written: `quick-studio --persistent
     2>err.log` never prompts, since the question would land in the file with
     nothing on screen to answer.

  It runs **before** the Core boots, with terminal echo disabled while you type.
  On a brand-new store it asks you to type the passphrase **twice** (a typo would
  otherwise permanently lock you out — there is no recovery if it is lost) before
  creating `credential-store.meta.json` + `credential-store.enc` in the app-data
  directory; if the two entries disagree three times, nothing is created and the
  Core boots as it would have without a passphrase. On an **existing**
  passphrase-protected store there is no confirmation, and a wrong passphrase is
  re-asked up to **three times** in total. `Ctrl-C` at any point exits cleanly
  without booting the Core, with echo restored, and without writing a descriptor,
  ciphertext, or plaintext — though checking whether a passphrase is even needed
  opens the credential store first, so an *empty* app-data directory may already
  have been created by the time you press it. Pressing Enter on an empty prompt
  is taken as "no passphrase" and stops asking. If all three attempts on an
  existing store are wrong, the Core still boots — with a workspace that cannot
  save a connection or an AI provider key until it is unlocked on a later run.
  Exactly one prompt covers both the connection store and the AI-provider-key
  store, which are expected to share one passphrase; that is an assumption of the
  layout, not something enforced, so an app-data directory assembled by hand from
  two differently-keyed stores is not handled.

  If the terminal cannot hide typed input, quick-studio does **not** prompt with
  echo on — it says so and falls back to the non-interactive transports below.

  It **never** appears in Ephemeral mode, when the keychain is reachable, or on a
  non-interactive stdin (piped input, CI, a service manager) — that case falls
  straight through to today's behavior: a typed `passphrase-declined` result and a
  stderr pointer at `QS_PASSPHRASE_FD`, the way to supply a passphrase
  non-interactively (e.g. from a script or systemd unit).

## Development

Requires [Bun](https://bun.sh) `>= 1.3.14`.

```sh
bun install
bun run build     # regenerates the UI bundle (src/core/ui-bundle.generated.ts)
bun run dev       # builds the UI, then boots the Core
bun test          # runs the test suite
```

The UI is bundled at **build time** into a generated TypeScript module
(`src/core/ui-bundle.generated.ts`). `bun run build` regenerates it — this is a
prerequisite before running the app, the tests, or compiling a binary, because
the Core imports the pre-built bundle instead of bundling at runtime.

Build a self-contained binary locally:

```sh
bun run build:binary   # → dist/quick-studio
```

**Publishing note.** The repo's `package.json` is the **development** manifest,
not the published artifact. The npm packages are **generated** by
`scripts/build-npm-packages.ts` (invoked by `.github/workflows/publish.yml` on a
release): it emits one self-contained package per platform plus a minimal
`quick-studio` package with no runtime `dependencies` and no build scripts. Do
not "fix" the repo manifest's `files`/`dependencies` for publishing, and do not
run `npm publish` on the repo directly — publishing goes through that workflow.

### Run with Docker (pre-seeded demo DB)

For eyeballing the UI without installing Bun or provisioning a database, a
one-command Docker stack boots quick-studio against a disposable, seeded Postgres:

```sh
docker compose up -d        # then open http://127.0.0.1:6060
```

See [docs/docker-development.md](docs/docker-development.md) for how it works, the
everyday commands, and troubleshooting.
