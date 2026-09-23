#!/data/data/com.termux/files/usr/bin/bash
# ERMI termugpt v3 — local SOCKS + Pinggy TCP + POST /proxy
# Free Pinggy uses empty password (press Enter); we supply that via SSH_ASKPASS.
set +m
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$HOME/.ssh" "$HOME/bin"

# Single instance
LOCK="$BASE/pids/supervisor.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "already running" >&2
  exit 0
fi

# shellcheck disable=SC1091
[ -f "$BASE/config.env" ] && . "$BASE/config.env"
TOKEN="${TOKEN:-}"
URL="${URL:-https://ermi-worker-agent-production.up.railway.app}"
PINGGY_USER="${PINGGY_USER:-tcp@free.pinggy.io}"
# Optional: TOKEN_FROM_DASHBOARD+tcp@pro.pinggy.io for sticky tunnels

log() { echo "$(date -Is) $*"; }
exec >>"$BASE/logs/supervisor.log" 2>&1
log "supervisor v3 start pid=$$"
termux-wake-lock 2>/dev/null || true

# Empty password helper for free Pinggy (docs: press Enter)
cat >"$BASE/askpass.sh" << 'ASK'
#!/data/data/com.termux/files/usr/bin/bash
echo ""
ASK
chmod 700 "$BASE/askpass.sh"

ensure_sshd() {
  if ! pgrep -f "$PREFIX/bin/sshd" >/dev/null 2>&1; then
    sshd 2>/dev/null || true
    sleep 1
  fi
}

start_socks() {
  pkill -f "ssh -D 127.0.0.1:1080" 2>/dev/null || true
  sleep 1
  ensure_sshd
  ssh -D 127.0.0.1:1080 -N \
    -i "$HOME/.ssh/id_ermi" -p 8022 \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    127.0.0.1 >>"$BASE/logs/socks.log" 2>&1 &
  echo $! >"$BASE/pids/socks.pid"
  sleep 2
}

socks_ok() {
  curl -4 -fsS --max-time 12 --proxy socks5h://127.0.0.1:1080 https://api.ipify.org >/dev/null 2>&1
}

is_valid_public() {
  local h="$1"
  [ -n "$h" ] || return 1
  case "$h" in
    free.pinggy.io*|tcp@*|localhost*|127.0.0.1*|*"]"*|YOUR-*|test-*|example.*) return 1 ;;
  esac
  # must look like host:port with numeric port
  echo "$h" | grep -qE '^[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+:[0-9]{2,5}$' || return 1
  local port="${h##*:}"
  [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null || return 1
  # reject bare free.pinggy.io:443 style
  case "$h" in
    free.pinggy.io:*) return 1 ;;
  esac
  return 0
}

parse_public() {
  local f="$BASE/logs/pinggy.log"
  local line h
  # Prefer explicit tcp:// URLs
  line=$(grep -oE 'tcp://[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+:[0-9]+' "$f" 2>/dev/null | head -1)
  if [ -n "$line" ]; then
    h="${line#tcp://}"
    if is_valid_public "$h"; then echo "$h"; return 0; fi
  fi
  # Common free host patterns
  for pat in \
    '[A-Za-z0-9-]+\.run\.pinggy-free\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.[a-z0-9-]+\.pinggy\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.a\.free\.pinggy\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.a\.pinggy\.link:[0-9]+'
  do
    h=$(grep -oE "$pat" "$f" 2>/dev/null | head -1)
    if is_valid_public "$h"; then echo "$h"; return 0; fi
  done
  return 1
}

post_proxy() {
  local hp="$1"
  [ -n "$TOKEN" ] || { log "TOKEN missing in config.env"; return 1; }
  local code body
  body=$(curl -sS --max-time 25 -w "\n%{http_code}" -X POST "$URL/proxy" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"server\":\"socks5://$hp\"}" 2>&1) || true
  code=$(echo "$body" | tail -1)
  log "POST /proxy http=$code body=$(echo "$body" | head -1)"
  echo "$code" | grep -qE '^20' || return 1
  echo "socks5://$hp" >"$BASE/PROXY_SERVER.txt"
  return 0
}

public_ok() {
  local hp
  [ -f "$BASE/last_public.txt" ] || return 1
  hp=$(cat "$BASE/last_public.txt")
  is_valid_public "$hp" || return 1
  curl -4 -fsS --max-time 20 --proxy "socks5h://$hp" https://api.ipify.org >/dev/null 2>&1
}

start_pinggy() {
  pkill -f "tcp@free.pinggy.io" 2>/dev/null || true
  pkill -f "free.pinggy.io" 2>/dev/null || true
  pkill -f "pro.pinggy.io" 2>/dev/null || true
  sleep 1
  : >"$BASE/logs/pinggy.log"

  export DISPLAY=:999
  export SSH_ASKPASS_REQUIRE=force
  export SSH_ASKPASS="$BASE/askpass.sh"

  # -tt forces PTY so Pinggy prints the allocated URL; ASKPASS supplies empty password
  setsid ssh -tt -p 443 -R0:127.0.0.1:1080 \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o PreferredAuthentications=password \
    -o PubkeyAuthentication=no \
    -o NumberOfPasswordPrompts=1 \
    -o ConnectTimeout=30 \
    "$PINGGY_USER" >>"$BASE/logs/pinggy.log" 2>&1 </dev/null &
  local SPID=$!
  echo "$SPID" >"$BASE/pids/pinggy.pid"
  log "pinggy ssh pid=$SPID"

  local PUBLIC="" i=0
  while [ "$i" -lt 60 ]; do
    i=$((i + 1))
    sleep 1
    PUBLIC=$(parse_public || true)
    if [ -n "$PUBLIC" ]; then
      log "tunnel=$PUBLIC"
      local OLD=""
      [ -f "$BASE/last_public.txt" ] && OLD=$(cat "$BASE/last_public.txt")
      echo "$PUBLIC" >"$BASE/last_public.txt"
      if [ "$PUBLIC" != "$OLD" ]; then
        post_proxy "$PUBLIC" || log "post failed (will retry next cycle)"
      else
        # still re-post periodically in case Railway was cleared
        if [ $((i % 20)) -eq 0 ]; then post_proxy "$PUBLIC" || true; fi
      fi
      return 0
    fi
  done
  log "no public url after 60s"
  tail -30 "$BASE/logs/pinggy.log" || true
  return 1
}

# boot
ensure_sshd
start_socks
socks_ok || { log "SOCKS not ok, retry"; start_socks; }
start_pinggy || true

while true; do
  ensure_sshd
  if ! socks_ok; then
    log "local SOCKS down — restart"
    start_socks
  fi

  PID=$(cat "$BASE/pids/pinggy.pid" 2>/dev/null || true)
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    log "pinggy process dead — restart"
    start_pinggy || true
  elif ! public_ok; then
    log "public path dead — restart pinggy"
    start_pinggy || true
  fi

  sleep 25
done
