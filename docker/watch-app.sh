#!/usr/bin/env sh
# watch-app.sh — auto-refresh the running quick-studio app on new commits.
#
# Polls the repo HEAD; whenever a new commit lands (e.g. bmad-loop finishing a
# story), it rebuilds + restarts the `app` container so http://127.0.0.1:6060
# reflects the latest work without a manual `docker compose restart`.
#
# Run it in a terminal that stays open (e.g. Git Bash / Windows Terminal) while
# the loop works — typically overnight:
#
#   bash docker/watch-app.sh
#
# Tunables (env): QS_WATCH_INTERVAL (seconds between HEAD checks, default 15).
# Requires Docker Desktop running and the compose stack defined at the repo root.

cd "$(dirname "$0")/.." || exit 1
INTERVAL="${QS_WATCH_INTERVAL:-15}"

log() { echo "[watch-app] $*"; }

log "watching HEAD every ${INTERVAL}s — restarts 'app' on each new commit. Ctrl-C to stop."
docker compose up -d >/dev/null 2>&1 || log "warning: 'docker compose up -d' failed (is Docker Desktop running?)"

last=""
while true; do
  cur="$(git rev-parse HEAD 2>/dev/null || echo '')"
  if [ -n "$cur" ] && [ "$cur" != "$last" ]; then
    if [ -n "$last" ]; then
      log "new commit $(git log -1 --format='%h %s' 2>/dev/null) — rebuilding app…"
      if docker compose restart app >/dev/null 2>&1; then
        log "app restarted (UI will be back in a few seconds)."
      else
        log "restart failed — check 'docker compose logs app'."
      fi
    fi
    last="$cur"
  fi
  sleep "$INTERVAL"
done
