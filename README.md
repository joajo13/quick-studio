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
the [GitHub Releases](../../releases) page:

- **Linux (x64):** `quick-studio-linux-x64`
- **Windows (x64):** `quick-studio-windows-x64.exe`

The binary is self-contained — no Bun, Node, or bundler required.

**Linux**

```sh
chmod +x quick-studio-linux-x64
./quick-studio-linux-x64
```

**Windows**

```powershell
.\quick-studio-windows-x64.exe
```

## Run

quick-studio prints the bound URL to stderr on start, e.g.
`quick-studio Core listening on http://127.0.0.1:<port>`. Open that URL in your
browser.

### Flags

- **`-h, --help`** — print usage and exit 0 (stdout; the Core never boots).
- **`-v, --version`** — print the version and exit 0 (stdout; the Core never boots).
- **`--persistent`** — select Persistent mode explicitly. Contradicts a database
  URL positional (both can't be selected at once).
- **`--ephemeral`** — select Ephemeral mode explicitly, with no database
  connection configured (`quick-studio --ephemeral <url>` is also valid — the
  URL is carried through). Contradicts `--persistent`.
- **`--no-open`** — do not launch the OS default browser after boot.

Behavior (the environment variables below are honored by the CLI; for `QS_MODE`,
a flag or an explicit database URL overrides it — the others have no flag
equivalent):

- **`QS_HOST`** — overrides the bind host (default loopback `127.0.0.1`). A
  non-loopback value (a concrete IP or wildcard `0.0.0.0` / `::`) makes the Core
  reachable from other machines and triggers a loud **Port-Exposure Warning** on
  stderr and an in-page banner. Only the session token stands between the
  network and your data — use with intent.
- **`QS_PORT`** — overrides the bind port. `0` (the default) picks an ephemeral
  free port.
- **`QS_MODE`** — default run mode when no flag/URL is given: `persistent`
  (default) or `ephemeral`. Overridden by a database URL positional or by
  `--ephemeral`/`--persistent`.
- **`QS_NO_OPEN`** — a non-empty value suppresses browser-open, same as
  `--no-open`.

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

## Development

Requires [Bun](https://bun.sh) `>= 1.2.0`.

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
