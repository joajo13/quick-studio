# quick-studio

Lightweight, local-first database manager (Postgres + MySQL). Runs entirely on
your machine: it boots a trusted local Core that serves a browser UI over
loopback, gated by a per-boot session token.

> Walking skeleton — epic 1. The UI shell, local Core, token-gated RPC,
> clean shutdown, and the Port-Exposure Warning are in place. Database connect
> and persistence land in later epics.

## Install

### A. Standalone binary (recommended)

Download the binary for your platform from the
[GitHub Releases](../../releases) page:

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

### B. Global package

Requires [Bun](https://bun.sh) `>= 1.2.0` **installed and on your `PATH`** — the
`quick-studio` command runs on Bun (the entry point is a Bun script). You can
install the package globally with either bun or npm, but Bun must be present at
run time in both cases:

```sh
bun add -g quick-studio
# or (still requires Bun at run time)
npm i -g quick-studio
```

Then run:

```sh
quick-studio
```

## Run

quick-studio prints the bound URL to stderr on start, e.g.
`quick-studio Core listening on http://127.0.0.1:<port>`. Open that URL in your
browser.

Behavior (this epic honors the environment variables below; connecting to a
database — including passing a database URL to select a session mode — arrives in
a later epic and is not parsed by the CLI yet):

- **`QS_HOST`** — overrides the bind host (default loopback `127.0.0.1`). A
  non-loopback value (a concrete IP or wildcard `0.0.0.0` / `::`) makes the Core
  reachable from other machines and triggers a loud **Port-Exposure Warning** on
  stderr and an in-page banner. Only the session token stands between the
  network and your data — use with intent.
- **`QS_PORT`** — overrides the bind port. `0` (the default) picks an ephemeral
  free port.

Press `Ctrl-C` to stop; the session ends cleanly and the port is released.

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
