#!/data/data/com.termux/files/usr/bin/bash
# ERMI termugpt v4 — local SOCKS supervisor + Pinggy TCP + POST /proxy
set +m
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$HOME/.ssh" "$HOME/bin"

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
SOCKS_PORT="${SOCKS_PORT:-1080}"
SSHD_PORT="${SSHD_PORT:-8022}"

log() { echo "$(date -Is) $*"; }
exec >>"$BASE/logs/supervisor.log" 2>&1
log "supervisor v4 start pid=$$"
termux-wake-lock 2>/dev/null || true

cat >"$BASE/askpass.sh" << '\''ASK'\''
#!/data/data/com.termux/files/usr/bin/bash
echo ""
ASK
chmod 700 "$BASE/askpass.sh"

kill_socks_clients() {
  pkill -f "ssh -D 127.0.0.1:${SOCKS_PORT}" 2>/dev/null || true
  pkill -f "ssh -D 127.0.0.1:$SOCKS_PORT" 2>/dev/null || true
}

ensure_sshd() {
  # Host key
  if [ ! -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" ]; then
    mkdir -p "$PREFIX/etc/ssh"
    ssh-keygen -t ed25519 -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" -N "" -q
  fi
  # Client key + authorized
  if [ ! -f "$HOME/.ssh/id_ermi" ]; then
    ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ermi" -N "" -q
  fi
  chmod 700 "$HOME/.ssh"
  grep -qf "$HOME/.ssh/id_ermi.pub" "$HOME/.ssh/authorized_keys" 2>/dev/null || \
    cat "$HOME/.ssh/id_ermi.pub" >> "$HOME/.ssh/authorized_keys"
  chmod 600 "$HOME/.ssh/authorized_keys" "$HOME/.ssh/id_ermi" 2>/dev/null || true

  cat >"$PREFIX/etc/ssh/sshd_config" << EOF
Port $SSHD_PORT
HostKey $PREFIX/etc/ssh/ssh_host_ed25519_key
PubkeyAuthentication yes
PasswordAuthentication no
AuthorizedKeysFile $HOME/.ssh/authorized_keys
AllowTcpForwarding yes
PermitTunnel yes
PidFile $BASE/pids/sshd.pid
EOF

  if ! pgrep -f "$PREFIX/bin/sshd" >/dev/null 2>&1; then
    sshd 2>>"$BASE/logs/sshd.log" || true
    sleep 1
  fi
  # If not listening, restart once
  if ! (echo >/dev/tcp/127.0.0.1/$SSHD_PORT) >/dev/null 2>&1; then
    pkill -f "$PREFIX/bin/sshd" 2>/dev/null || true
    sleep 1
    sshd 2>>"$BASE/logs/sshd.log" || true
    sleep 1
  fi
}

start_socks() {
  kill_socks_clients
  sleep 1
  ensure_sshd
  : >"$BASE/logs/socks.log"
  nohup ssh -D "127.0.0.1:${SOCKS_PORT}" -N \
    -i "$HOME/.ssh/id_ermi" -p "$SSHD_PORT" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o ConnectTimeout=10 \
    127.0.0.1 >>"$BASE/logs/socks.log" 2>&1 &
  local SPID=$!
  echo "$SPID" >"$BASE/pids/socks.pid"
  log "socks client pid=$SPID"
  sleep 2
}

port_listening() {
  # busybox / bash /dev/tcp
  (echo >/dev/tcp/127.0.0.1/$1) >/dev/null 2>&1
}

socks_ok() {
  port_listening "$SOCKS_PORT" || return 1
  curl -4 -fsS --max-time 10 --proxy "socks5h://127.0.0.1:${SOCKS_PORT}" https://api.ipify.org >/dev/null 2>&1
}

ensure_socks() {
  if socks_ok; then
    return 0
  fi
  log "SOCKS unhealthy — restarting local stack"
  ensure_sshd
  start_socks
  local i=0
  while [ "$i" -lt 8 ]; do
    i=$((i + 1))
    if socks_ok; then
      log "SOCKS ok after restart"
      return 0
    fi
    sleep 1
  done
  log "SOCKS still down after restart"
  tail -15 "$BASE/logs/socks.log" 2>/dev/null || true
  return 1
}

is_valid_public() {
  local h="$1"
  [ -n "$h" ] || return 1
  case "$h" in
    free.pinggy.io*|tcp@*|localhost*|127.0.0.1*|*"]"*|YOUR-*|test-*|example.*) return 1 ;;
  esac
  echo "$h" | grep -qE \''^[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+:[0-9]{2,5}$\'' || return 1
  local port="${h##*:}"
  [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null || return 1
  case "$h" in free.pinggy.io:*) return 1 ;; esac
  return 0
}

parse_public() {
  local f="$BASE/logs/pinggy.log"
  local line h
  line=$(grep -oE \''tcp://[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+:[0-9]+\'' "$f" 2>/dev/null | head -1)
  if [ -n "$line" ]; then
    h="${line#tcp://}"
    if is_valid_public "$h"; then echo "$h"; return 0; fi
  fi
  for pat in \
    \''[A-Za-z0-9-]+\.run\.pinggy-free\.link:[0-9]+\'' \
    \''[A-Za-z0-9-]+\.[a-z0-9-]+\.pinggy\.link:[0-9]+\'' \
    \''[A-Za-z0-9-]+\.a\.free\.pinggy\.link:[0-9]+\'' \
    \''[A-Za-z0-9-]+\.a\.pinggy\.link:[0-9]+\''
  do
    h=$(grep -oE "$pat" "$f" 2>/dev/null | head -1)
    if is_valid_public "$h"; then echo "$h"; return 0; fi
  done
  return 1
}

post_proxy() {
  local hp="$1"
  [ -n "$TOKEN" ] || { log "TOKEN missing"; return 1; }
  local body code
  body=$(curl -sS --max-time 25 -w "\n%{http_code}" -X POST "$URL/proxy" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"server\":\"socks5://$hp\"}" 2>&1) || true
  code=$(echo "$body" | tail -1)
  log "POST /proxy http=$code body=$(echo "$body" | head -1)"
  echo "$code" | grep -qE \''^20\'' || return 1
  echo "socks5://$hp" >"$BASE/PROXY_SERVER.txt"
  return 0
}

public_ok() {
  local hp
  [ -f "$BASE/last_public.txt" ] || return 1
  hp=$(cat "$BASE/last_public.txt")
  is_valid_public "$hp" || return 1
  curl -4 -fsS --max-time 15 --proxy "socks5h://$hp" https://api.ipify.org >/dev/null 2>&1
}

start_pinggy() {
  pkill -f "tcp@free.pinggy.io" 2>/dev/null || true
  pkill -f "free.pinggy.io" 2>/dev/null || true
  pkill -f "pro.pinggy.io" 2>/dev/null || true
  sleep 1
  : >"$BASE/logs/pinggy.log"

  # SOCKS must be up before reverse tunnel attaches to it
  ensure_socks || log "warning: starting Pinggy with weak SOCKS"

  export DISPLAY=:999
  export SSH_ASKPASS_REQUIRE=force
  export SSH_ASKPASS="$BASE/askpass.sh"

  setsid ssh -tt -p 443 -R0:127.0.0.1:${SOCKS_PORT} \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=20 \
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
        post_proxy "$PUBLIC" || log "post failed"
      else
        post_proxy "$PUBLIC" || true
      fi
      return 0
    fi
  done
  log "no public url after 60s"
  tail -20 "$BASE/logs/pinggy.log" || true
  return 1
}

# ---- boot ----
ensure_sshd
ensure_socks
start_pinggy || true

# ---- main loop: SOCKS + Pinggy health ----
while true; do
  if ! socks_ok; then
    log "local SOCKS down — restart"
    ensure_socks
  fi

  PID=$(cat "$BASE/pids/pinggy.pid" 2>/dev/null || true)
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    log "pinggy process dead — restart"
    start_pinggy || true
  elif ! public_ok; then
    log "public path dead — restart pinggy"
    start_pinggy || true
  fi

  # Re-assert proxy with Railway every ~5 min
  if [ -f "$BASE/last_public.txt" ]; then
    now=$(date +%s)
    last=$(cat "$BASE/pids/last_repost.txt" 2>/dev/null || echo 0)
    if [ $((now - last)) -ge 300 ]; then
      hp=$(cat "$BASE/last_public.txt")
      post_proxy "$hp" || true
      echo "$now" >"$BASE/pids/last_repost.txt"
    fi
  fi

  sleep 20
done
