# Local Development with Docker

**Status:** working (verified on Docker Desktop for Windows, engine v28).
**Files:** `docker-compose.yml`, `docker/Dockerfile`, `docker/seed.sql`.

A one-command local stack for **eyeballing the UI during development**: it boots a
disposable, pre-seeded Postgres and runs quick-studio against it, so you can open
the app in a browser without installing Bun, provisioning a database, or touching
the OS keychain. It is a **development convenience only** — not a deployment
artifact and not how end users run the app (see the root `README.md` for the
standalone binary and global-package paths).

## Quickstart

From the repo root:

```sh
docker compose up -d        # boot db + app (builds the UI on first start)
# then open:
#   http://127.0.0.1:6060   # MUST be 127.0.0.1, not localhost (see "Host guard")
docker compose logs -f app  # watch the build + boot; look for "Core listening"
docker compose down         # stop (keeps the DB volume)
```

Docker Desktop must be running first.

## What you get

| Service | Image / build         | Host port        | Purpose                                              |
|---------|-----------------------|------------------|------------------------------------------------------|
| `db`    | `postgres:16`         | `127.0.0.1:5433` | Disposable Postgres, seeded from `docker/seed.sql`.  |
| `app`   | `docker/Dockerfile`   | `127.0.0.1:6060` | quick-studio Core + UI, pre-connected to `db`.       |

Both ports bind the host **loopback only** — nothing is reachable from the LAN.

The app runs in **Ephemeral mode**: the connection string is passed as a
positional CLI argument (`postgres://demo:demo@db:5432/demo`), which selects
Ephemeral mode in `parseCliArgs` and means the credential store / OS keychain is
never touched. This sidesteps the headless-keychain failure modes that Persistent
mode has to handle.

## The demo dataset

`docker/seed.sql` runs once, the first time the `db` volume is created (Postgres'
`/docker-entrypoint-initdb.d` hook). It builds a small e-commerce schema —
`customers`, `products`, `orders`, `order_items` — plus two views,
`revenue_by_country` and `top_products`, so the workspace, ERD, and report
surfaces all have something real to render.

To re-seed from scratch (e.g. after editing `seed.sql`), drop the data volume:

```sh
docker compose down -v      # removes qs_pgdata; next `up` re-seeds
```

## How it works

### Live source, deps and bundles in volumes

The `app` service bind-mounts the repo (`.:/app`) so you develop against your
working tree. Two things are kept **out** of that bind mount, in named volumes, so
the host tree stays clean and platform-correct:

- `qs_node_modules` → `/app/node_modules` — Linux dependencies, separate from any
  Windows `node_modules` on the host.
- `qs_pgdata` → the Postgres data directory.

On each `up`, the app container runs `bun install` (a no-op once cached in the
volume), `bun run build` (regenerates the `*-bundle.generated.ts` UI bundles — the
Core serves these pre-built bundles, it does not bundle at runtime), then boots.

### The loopback bind + socat forwarder (why the banner stays off)

quick-studio shows a red **Port-Exposure banner** in the UI, and prints a matching
stderr warning, whenever it binds a **non-loopback** host — see `isExposed()` in
`src/core/binding.ts` and `ExposureBanner` in `src/ui/workspace/Workspace.tsx`.
That is correct behavior for the app, but under Docker it created a false alarm:
the naive way to make a container port reachable is to bind `0.0.0.0`, which the
app reads as "exposed".

To keep the app in its non-exposed, banner-free state, the container binds
**loopback** (`QS_HOST=127.0.0.1`) and a small `socat` forwarder republishes it on
the wildcard interface for Docker to publish:

```
browser → 127.0.0.1:6060 (host)
        → Docker publish → container :8080
        → socat TCP-LISTEN:8080 → 127.0.0.1:6060 (app, loopback bind)
```

`socat` forwards raw TCP, so the HTTP `Host` header the browser sent
(`127.0.0.1:6060`) is preserved end to end. That matters for the **Host guard**
below. `socat` is the only reason `docker/Dockerfile` exists (it layers `socat`
onto `oven/bun:1`); everything else could run on the stock Bun image.

### Host guard — use `127.0.0.1`, not `localhost`

`validateOrigin` (`src/core/auth.ts`) pins the request `Host`/`Origin` to the
Core's bound authority as a DNS-rebinding defense, and treats `localhost` and
`127.0.0.1` as **distinct** origins. Because the app binds the concrete host
`127.0.0.1`, only `http://127.0.0.1:6060` passes — `http://localhost:6060` is
rejected with `forbidden_origin` (403). Always open the `127.0.0.1` URL.

## Persistent mode (optional)

The default stack runs the app in **ephemeral** mode. To test the features that
persist across restarts — saved Connections and AI provider keys — use the
persistent override:

```sh
docker compose -f docker-compose.yml -f docker-compose.persistent.yml up -d
# open http://127.0.0.1:6060, then Settings -> Connections -> add:
#   name: demo   url: postgres://demo:demo@db:5432/demo
# add an AI provider key too; both survive a restart.
docker compose -f docker-compose.yml -f docker-compose.persistent.yml restart app
docker compose -f docker-compose.yml -f docker-compose.persistent.yml down    # keep the store
docker compose -f docker-compose.yml -f docker-compose.persistent.yml down -v  # wipe the store
```

What the override changes (`docker-compose.persistent.yml`):
- **No positional connection string** → the app boots in persistent mode (the
  default). It starts with NO connection; add one in the UI and it is encrypted
  and saved. Both `db` (5432, container-internal) and the demo creds are the same
  as ephemeral.
- **`QS_PASSPHRASE=devpass`** → derives the at-rest AES-256-GCM key. The container
  is headless, so there is no OS keychain; the passphrase is the key source. (Dev
  only — never a real secret.)
- **`XDG_DATA_HOME=/data` + a `qs_persistent_data` volume** → the encrypted store
  (`credential-store.enc`, `credential-store.meta.json`, `workspace-state.json`)
  lives on a durable volume, so it survives `restart`/`up`/`down` (but not
  `down -v`).
- **A seccomp profile (`docker/no-keyring.seccomp.json`) that fails the kernel
  keyring syscalls.** This is the non-obvious part: `@napi-rs/keyring` in the
  container falls back to the **Linux kernel keyutils keyring**, which works
  in-process but is *ephemeral* — a store created in keychain mode cannot be
  unlocked after a container restart (`credential store is unavailable
  (key-unavailable)`). Failing the keyring syscalls makes the keychain report
  *unavailable*, so quick-studio creates the store in **passphrase mode** (salt
  persisted in `credential-store.meta.json`), which re-derives the same key from
  `QS_PASSPHRASE` on every boot. Without this, "persistent" would silently break
  on the first restart.

To switch back to ephemeral, just use the base `docker compose up -d` again
(recreates the `app` container without the override).

## Everyday commands

```sh
docker compose up -d            # start (ephemeral)
docker compose restart app      # re-run bun build — do this after pulling new commits
docker compose logs -f app      # follow app output
docker compose down             # stop, keep the DB
docker compose down -v          # stop, wipe the DB (re-seeds on next up)
docker compose up -d --build    # rebuild the app image (after editing docker/Dockerfile)
```

There is **no hot reload**: the UI is served from build-time bundles, so source
edits (and freshly pulled commits) require `docker compose restart app` to rebuild
and be reflected.

## Design decisions & rejected alternatives

- **Postgres on host port `5433`, not `5432`.** Avoids clashing with a native
  Postgres install on the host (the dev machine this was set up on runs the
  Windows PostgreSQL 16 service on `5432`).
- **Docker host networking (`network_mode: host`) — rejected.** It would let the
  app bind `127.0.0.1` and be reached directly (no `socat`, no banner), but on
  Docker Desktop for Windows host networking does **not** reach the Windows
  loopback (a probe from the host returned no connection). The `socat` forwarder
  works regardless of Docker Desktop's networking mode.
- **Patching the UI to hide the banner — rejected.** The banner is correct product
  behavior; suppressing it in app code would be a misleading diff. Keeping the app
  genuinely non-exposed (loopback bind) is the honest fix.
- **Ephemeral over Persistent mode.** Passing the connection string positionally
  avoids the OS keychain entirely, which keeps the containerized run simple and
  independent of any host secret store.

## Troubleshooting

- **`forbidden_origin` / 403 in the UI.** You opened `localhost:6060`. Use
  `http://127.0.0.1:6060`.
- **Port `6060`/`5433` already in use.** Something else holds the host port. Stop
  it, or change the left-hand side of the `ports:` mappings in
  `docker-compose.yml`.
- **Stale UI after pulling new commits.** Run `docker compose restart app` to
  re-run `bun run build`.
- **DB looks empty / schema changed.** The seed only runs on a fresh volume. Run
  `docker compose down -v && docker compose up -d` to re-seed.
- **`Cannot connect to the Docker daemon`.** Docker Desktop is not running — start
  it and retry.
