#!/data/data/com.termux/files/usr/bin/bash
# ERMI WATCHDOG (Layer B) — independent health check
# Runs via termux-job-scheduler ~15m. Does NOT hold permanent wake lock.
# If runtime dead or public path failed → start/repair runtime.
set +e
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$BASE/health"

LOCK="$BASE/pids/watchdog.lock"
exec 8>"$LOCK"
if ! flock -n 8; then
  echo "watchdog already running" >&2
  exit 0
fi

LOG="$BASE/logs/watchdog.log"
log() { echo "$(date -Is) [watchdog:$$] $*" >>"$LOG"; }

# Cap log
if [ -f "$LOG" ]; then
  sz=$(wc -c <"$LOG" 2>/dev/null || echo 0)
  if [ "$sz" -gt 262144 ]; then
    tail -c 131072 "$LOG" >"$LOG.tmp" 2>/dev/null
    mv "$LOG.tmp" "$LOG" 2>/dev/null || true
  fi
fi

log "watchdog start"

# Skip if maintenance lock held
if [ -f "$BASE/pids/maintenance.lock" ]; then
  if ! flock -n "$BASE/pids/maintenance.lock" true 2>/dev/null; then
    log "maintenance in progress — skip"
    exit 0
  fi
fi

# shellcheck disable=SC1091
[ -f "$BASE/config.env" ] && . "$BASE/config.env"
SOCKS_PORT="${SOCKS_PORT:-1080}"
STATE=$(cat "$BASE/state.txt" 2>/dev/null || echo unknown)

# Is runtime process alive?
runtime_alive=0
if [ -f "$BASE/pids/runtime.lock" ] && ! flock -n "$BASE/pids/runtime.lock" true 2>/dev/null; then
  runtime_alive=1
elif pgrep -f "sim-exit/ermi-runtime.sh" >/dev/null 2>&1; then
  runtime_alive=1
elif pgrep -f "sim-exit/termugpt.sh" >/dev/null 2>&1; then
  runtime_alive=1
fi

# Local SOCKS check
socks_ok=0
if (echo >/dev/tcp/127.0.0.1/$SOCKS_PORT) >/dev/null 2>&1; then
  ip=$(curl -4 -fsS --max-time 10 --proxy "socks5h://127.0.0.1:${SOCKS_PORT}" https://api.ipify.org 2>/dev/null || true)
  if echo "$ip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    socks_ok=1
  fi
fi

# Public path check
public_ok=0
if [ -f "$BASE/last_public.txt" ]; then
  hp=$(cat "$BASE/last_public.txt")
  if [ -n "$hp" ]; then
    pip=$(curl -4 -fsS --max-time 12 --proxy "socks5h://$hp" https://api.ipify.org 2>/dev/null || true)
    if echo "$pip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      public_ok=1
    fi
  fi
fi

log "check runtime_alive=$runtime_alive socks_ok=$socks_ok public_ok=$public_ok state=$STATE"

NEED_START=0
if [ "$runtime_alive" -eq 0 ]; then
  log "runtime not running — start"
  NEED_START=1
elif [ "$socks_ok" -eq 0 ] || [ "$public_ok" -eq 0 ]; then
  if [ "$STATE" = "ACTIVE" ] || [ "$STATE" = "DEGRADED" ]; then
    log "path unhealthy while claimed up — restart runtime"
    NEED_START=1
  fi
fi

if [ "$NEED_START" -eq 1 ]; then
  # Soft restart: kill only our processes then start
  pkill -f "sim-exit/ermi-runtime.sh" 2>/dev/null || true
  pkill -f "sim-exit/termugpt.sh" 2>/dev/null || true
  sleep 2
  RUNTIME="$BASE/ermi-runtime.sh"
  [ -x "$RUNTIME" ] || RUNTIME="$BASE/termugpt.sh"
  if [ -x "$RUNTIME" ]; then
    termux-wake-lock 2>/dev/null || true
    nohup bash "$RUNTIME" >/dev/null 2>&1 &
    log "runtime restarted pid=$!"
  else
    log "no runtime script found"
  fi
fi

# Write health snapshot
{
  echo "watchdog_ts=$(date +%s)"
  echo "runtime_alive=$runtime_alive"
  echo "socks_ok=$socks_ok"
  echo "public_ok=$public_ok"
  echo "state=$STATE"
} >"$BASE/health/watchdog.env"

log "watchdog end"
exit 0
