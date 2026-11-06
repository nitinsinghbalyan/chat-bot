#!/usr/bin/env bash
# Deploys the newest commit of main, like Render's auto-deploy. Installed by setup.sh as
# /usr/local/sbin/seller-assistants-deploy and run as root by seller-assistants-deploy.timer every 2 minutes.
#
# Each commit is built in its own folder (/opt/seller-assistants/releases/<commit>) as user "bot", so the
# running bot is untouched until the switch. Then the "current" link moves, the service restarts and
# /health is checked. A commit that fails its build or health check is rolled back and not tried again
# until a newer commit arrives. Logs: journalctl -u seller-assistants-deploy
#
#   seller-assistants-deploy           deploy if main moved
#   seller-assistants-deploy --force   rebuild and redeploy main now
set -euo pipefail
BASE=${BASE:-/opt/seller-assistants}
REPO=$BASE/repo
RELEASES=$BASE/releases
STATE=${STATE:-/var/lib/seller-assistants}
BRANCH=${BRANCH:-main}
ENV_FILE=${ENV_FILE:-/etc/seller-assistants.env}
SERVICE=${SERVICE:-seller-assistants}
PORT=$( (grep -E '^PORT=[0-9]+$' "$ENV_FILE" 2>/dev/null || true) | tail -1 | cut -d= -f2)
PORT=${PORT:-3000}
HEALTH_TRIES=${HEALTH_TRIES:-45}

log() { echo "[deploy] $*"; }
as_bot() { if [[ $(id -u) -eq 0 ]]; then runuser -u bot -- env HOME=/home/bot PATH="$PATH" "$@"; else "$@"; fi; }
switch_to() { ln -sfn "$1" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"; }
healthy() {
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    sleep 2
    curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
  done
  return 1
}

mkdir -p "$STATE"
exec 9>"$STATE/deploy.lock"
flock -n 9 || { log "another deploy is running"; exit 0; }

as_bot git -C "$REPO" fetch --quiet origin "$BRANCH"
target=$(as_bot git -C "$REPO" rev-parse "origin/$BRANCH")
live=""
[[ -L $BASE/current ]] && live=$(basename "$(readlink -f "$BASE/current")")
if [[ ${1:-} != --force ]]; then
  [[ $target == "$live" ]] && exit 0
  [[ -f $STATE/failed && $(cat "$STATE/failed") == "$target" ]] && exit 0
fi
log "deploying ${target:0:12} (live: ${live:0:12})"

dir=$RELEASES/$target
rm -rf "$dir"
mkdir -p "$dir"
chown bot:bot "$RELEASES" "$dir"
as_bot bash -c 'git -C "$1" archive "$2" | tar -x -C "$3" && echo "$2" > "$3/.build-commit"' _ "$REPO" "$target" "$dir"
if ! as_bot bash -c 'cd "$1" && npm ci --include=dev --no-audit --no-fund --no-update-notifier --loglevel=error && npm run build --silent' _ "$dir"; then
  log "build failed for ${target:0:12}; still on ${live:0:12}"
  echo "$target" >"$STATE/failed"
  rm -rf "$dir"
  exit 1
fi

switch_to "$dir"
systemctl restart "$SERVICE" 9>&-
if healthy; then
  rm -f "$STATE/failed"
  log "live: ${target:0:12}"
  # Keep the newest 3 releases (the live one is the newest).
  ls -1dt "$RELEASES"/*/ | tail -n +4 | xargs -r rm -rf
  exit 0
fi

log "health check failed for ${target:0:12}"
echo "$target" >"$STATE/failed"
if [[ -n $live && -d $RELEASES/$live ]]; then
  switch_to "$RELEASES/$live"
  systemctl restart "$SERVICE" 9>&-
  log "rolled back to ${live:0:12}"
fi
exit 1
