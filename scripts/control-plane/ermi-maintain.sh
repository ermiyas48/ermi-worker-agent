#!/data/data/com.termux/files/usr/bin/bash
# ERMI MAINTENANCE (Layer C) — package updates, cleanup, post-verify
# Safe to re-run. Uses global maintenance lock.
# Weekly packages, daily cleanup. Does not upgrade during ACTIVE tunnel rotation.
set +e
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$BASE/health"

MAINT_LOCK="$BASE/pids/maintenance.lock"
exec 7>"$MAINT_LOCK"
if ! flock -n 7; then
  echo "maintenance already running" >&2
  exit 0
fi

LOG="$BASE/logs/maintain.log"
log() { echo "$(date -Is) [maintain:$$] $*" >>"$LOG"; }

MODE="${1:-auto}"
now=$(date +%s)
WEEK_SECS=604800
DAY_SECS=86400

log "maintain start mode=$MODE"

if [ -f "$LOG" ]; then
  sz=$(wc -c <"$LOG" 2>/dev/null || echo 0)
  if [ "$sz" -gt 262144 ]; then
    tail -c 131072 "$LOG" >"$LOG.tmp" 2>/dev/null
    mv "$LOG.tmp" "$LOG" 2>/dev/null || true
  fi
fi

do_cleanup() {
  log "cleanup start"
  for f in runtime.log supervisor.log socks.log pinggy.log sshd.log watchdog.log maintain.log boot.log; do
    p="$BASE/logs/$f"
    if [ -f "$p" ]; then
      sz=$(wc -c <"$p" 2>/dev/null || echo 0)
      if [ "$sz" -gt 524288 ]; then
        tail -c 262144 "$p" >"$p.tmp" 2>/dev/null
        mv "$p.tmp" "$p" 2>/dev/null || true
        log "rotated $f"
      fi
    fi
  done
  for pf in "$BASE/pids"/*.pid; do
    [ -f "$pf" ] || continue
    pid=$(cat "$pf" 2>/dev/null || true)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pf"
      log "removed stale $(basename $pf)"
    fi
  done
  free_kb=$(df -k "$HOME" 2>/dev/null | awk 'NR==2{print $4}')
  if [ -n "$free_kb" ] && [ "$free_kb" -lt 102400 ] 2>/dev/null; then
    log "low storage ${free_kb}KB — aggressive log trim"
    for f in "$BASE/logs"/*.log; do
      [ -f "$f" ] || continue
      tail -c 65536 "$f" >"$f.tmp" 2>/dev/null
      mv "$f.tmp" "$f" 2>/dev/null || true
    done
  fi
  echo "$now" >"$BASE/health/last_cleanup.txt"
  log "cleanup done"
}

do_packages() {
  log "package maintenance start"
  st=$(cat "$BASE/state.txt" 2>/dev/null || echo "")
  case "$st" in
    RECOVERING|TUNNEL_STARTING|PUBLIC_ENDPOINT_FOUND|PUBLIC_ENDPOINT_VERIFIED)
      log "skip packages — runtime busy state=$st"
      return 0
      ;;
  esac

  if [ -f "$PREFIX/var/lib/dpkg/lock" ] || [ -f "$PREFIX/var/lib/dpkg/lock-frontend" ]; then
    if pgrep -f "dpkg|apt|pkg " >/dev/null 2>&1; then
      log "dpkg/apt busy — skip packages"
      return 0
    fi
    log "clearing stale dpkg locks"
    rm -f "$PREFIX/var/lib/dpkg/lock" "$PREFIX/var/lib/dpkg/lock-frontend" 2>/dev/null || true
  fi

  for pkg in openssh curl which coreutils procps; do
    command -v "${pkg%% *}" >/dev/null 2>&1 || pkg install -y "$pkg" 2>/dev/null || true
  done

  log "running: pkg update -y && pkg upgrade -y"
  if pkg update -y >>"$LOG" 2>&1 && pkg upgrade -y >>"$LOG" 2>&1; then
    log "pkg upgrade OK"
  else
    log "pkg upgrade failed — trying apt recovery"
    dpkg --configure -a >>"$LOG" 2>&1 || true
    apt-get -f install -y >>"$LOG" 2>&1 || true
    pkg update -y >>"$LOG" 2>&1 || true
    pkg upgrade -y >>"$LOG" 2>&1 || true
  fi

  CRITICAL_OK=1
  for cmd in ssh sshd curl bash flock; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      log "CRITICAL missing after upgrade: $cmd"
      CRITICAL_OK=0
    fi
  done

  [ -f "$BASE/config.env" ] && . "$BASE/config.env"
  SOCKS_PORT="${SOCKS_PORT:-1080}"
  URL="${URL:-https://ermi-worker-agent-production.up.railway.app}"
  TOKEN="${TOKEN:-}"

  e2e_ok=0
  if [ "$CRITICAL_OK" -eq 1 ]; then
    lip=""
    if (echo >/dev/tcp/127.0.0.1/$SOCKS_PORT) >/dev/null 2>&1; then
      lip=$(curl -4 -fsS --max-time 12 --proxy "socks5h://127.0.0.1:${SOCKS_PORT}" https://api.ipify.org 2>/dev/null || true)
    fi
    if ! echo "$lip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      log "post-maint: local SOCKS fail — ensuring runtime"
      if ! pgrep -f "sim-exit/ermi-runtime.sh" >/dev/null 2>&1; then
        RUNTIME="$BASE/ermi-runtime.sh"
        [ -x "$RUNTIME" ] || RUNTIME="$BASE/termugpt.sh"
        if [ -x "$RUNTIME" ]; then
          termux-wake-lock 2>/dev/null || true
          nohup bash "$RUNTIME" >/dev/null 2>&1 &
          log "runtime started for recovery pid=$!"
          sleep 15
        fi
      fi
      lip=$(curl -4 -fsS --max-time 12 --proxy "socks5h://127.0.0.1:${SOCKS_PORT}" https://api.ipify.org 2>/dev/null || true)
    fi

    pip=""
    hp=""
    if [ -f "$BASE/last_public.txt" ]; then
      hp=$(cat "$BASE/last_public.txt")
      pip=$(curl -4 -fsS --max-time 15 --proxy "socks5h://$hp" https://api.ipify.org 2>/dev/null || true)
    fi

    railway_ok=0
    if [ -n "$TOKEN" ] && [ -n "$hp" ] && echo "$pip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      body=$(curl -sS --max-time 25 -w "\n%{http_code}" -X POST "$URL/proxy" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"server\":\"socks5://$hp\"}" 2>&1) || true
      code=$(echo "$body" | tail -1)
      resp=$(echo "$body" | sed '$d')
      if echo "$code" | grep -qE '^20' && ! echo "$resp" | grep -qi '"valid"[[:space:]]*:[[:space:]]*false'; then
        railway_ok=1
        log "post-maint: Railway valid OK"
      else
        log "post-maint: Railway sync fail http=$code"
      fi
    else
      log "post-maint: skip Railway (token/public missing or public SOCKS fail)"
    fi

    if echo "$lip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' \
       && echo "$pip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' \
       && [ "$railway_ok" -eq 1 ]; then
      e2e_ok=1
    elif echo "$lip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' \
       && [ -z "$TOKEN" ]; then
      log "post-maint: TOKEN empty — cannot complete Railway e2e"
      e2e_ok=0
      CRITICAL_OK=0
    fi
  fi

  if [ "$CRITICAL_OK" -eq 1 ] && [ "$e2e_ok" -eq 1 ]; then
    echo "$now" >"$BASE/health/last_pkg_ok.txt"
    log "package maintenance verified OK (SOCKS+public+Railway)"
  else
    echo "$now" >"$BASE/health/last_pkg_fail.txt"
    echo "DEGRADED" >"$BASE/state.txt"
    log "package maintenance FAILED e2e verification"
  fi
}

case "$MODE" in
  cleanup) do_cleanup ;;
  packages) do_packages ;;
  auto|*)
    last_c=$(cat "$BASE/health/last_cleanup.txt" 2>/dev/null || echo 0)
    if [ $((now - last_c)) -ge $DAY_SECS ]; then do_cleanup
    else log "cleanup skipped (last $((now - last_c))s ago)"; fi
    last_p=$(cat "$BASE/health/last_pkg_ok.txt" 2>/dev/null || echo 0)
    if [ $((now - last_p)) -ge $WEEK_SECS ]; then do_packages
    else log "packages skipped (last $((now - last_p))s ago)"; fi
    ;;
esac

log "maintain end"
exit 0
