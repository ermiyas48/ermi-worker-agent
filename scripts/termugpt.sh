#!/data/data/com.termux/files/usr/bin/bash
# ERMI termugpt v6 — production residential proxy supervisor
# Architecture: local SOCKS5 (sshd+ssh -D) → Pinggy TCP reverse → Railway POST /proxy
# Self-healing, proactive 45m rotation, flock single-instance, e2e validation
set +m
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$HOME/.ssh" "$HOME/bin"

LOCK="$BASE/pids/supervisor.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "supervisor already running (flock held)" >&2
  exit 0
fi

# shellcheck disable=SC1091
[ -f "$BASE/config.env" ] && . "$BASE/config.env"
TOKEN="${TOKEN:-}"
URL="${URL:-https://ermi-worker-agent-production.up.railway.app}"
PINGGY_USER="${PINGGY_USER:-tcp@free.pinggy.io}"
SOCKS_PORT="${SOCKS_PORT:-1080}"
SSHD_PORT="${SSHD_PORT:-8022}"
ROTATE_SECS="${ROTATE_SECS:-2700}"
STATE_FILE="$BASE/state.txt"
LOG_MAX_BYTES=524288

log() {
  local msg="$(date -Is) [$$] $*"
  echo "$msg" >>"$BASE/logs/supervisor.log"
  if [ -f "$BASE/logs/supervisor.log" ]; then
    local sz
    sz=$(wc -c <"$BASE/logs/supervisor.log" 2>/dev/null || echo 0)
    if [ "$sz" -gt "$LOG_MAX_BYTES" ]; then
      tail -c $((LOG_MAX_BYTES / 2)) "$BASE/logs/supervisor.log" >"$BASE/logs/supervisor.log.tmp" 2>/dev/null
      mv "$BASE/logs/supervisor.log.tmp" "$BASE/logs/supervisor.log" 2>/dev/null || true
    fi
  fi
}

set_state() {
  echo "$1" >"$STATE_FILE"
  log "STATE=$1 ${2:-}"
}

log "supervisor v6 start pid=$$"
termux-wake-lock 2>/dev/null || true
set_state "STARTING"

cat >"$BASE/askpass.sh" << 'ASK'
#!/data/data/com.termux/files/usr/bin/bash
echo ""
ASK
chmod 700 "$BASE/askpass.sh"

kill_ermi_socks() {
  pkill -f "ssh -D 127.0.0.1:${SOCKS_PORT}" 2>/dev/null || true
  pkill -f "ssh -D 127.0.0.1:$SOCKS_PORT" 2>/dev/null || true
  if [ -f "$BASE/pids/socks.pid" ]; then
    local p; p=$(cat "$BASE/pids/socks.pid" 2>/dev/null)
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  fi
}

kill_ermi_pinggy() {
  if [ -f "$BASE/pids/pinggy.pid" ]; then
    local p; p=$(cat "$BASE/pids/pinggy.pid" 2>/dev/null)
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  fi
  pkill -f "tcp@free.pinggy.io" 2>/dev/null || true
  pkill -f " -R0:127.0.0.1:${SOCKS_PORT} " 2>/dev/null || true
  pkill -f "free.pinggy.io" 2>/dev/null || true
  pkill -f "pro.pinggy.io" 2>/dev/null || true
  pkill -f "a.pinggy.io" 2>/dev/null || true
}

ensure_sshd() {
  if [ ! -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" ]; then
    mkdir -p "$PREFIX/etc/ssh"
    ssh-keygen -t ed25519 -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" -N "" -q
  fi
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
  if ! (echo >/dev/tcp/127.0.0.1/$SSHD_PORT) >/dev/null 2>&1; then
    pkill -f "$PREFIX/bin/sshd" 2>/dev/null || true
    sleep 1
    sshd 2>>"$BASE/logs/sshd.log" || true
    sleep 1
  fi
}

start_socks() {
  kill_ermi_socks
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

port_listening() { (echo >/dev/tcp/127.0.0.1/$1) >/dev/null 2>&1; }

socks_exit_ip() {
  curl -4 -fsS --max-time 12 --proxy "socks5h://127.0.0.1:${SOCKS_PORT}" https://api.ipify.org 2>/dev/null
}

socks_ok() {
  port_listening "$SOCKS_PORT" || return 1
  local ip; ip=$(socks_exit_ip) || return 1
  [ -n "$ip" ] || return 1
  echo "$ip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || return 1
  return 0
}

ensure_socks() {
  if socks_ok; then set_state "SOCKS_READY"; return 0; fi
  log "SOCKS unhealthy — restarting local stack"
  ensure_sshd; start_socks
  local i=0
  while [ "$i" -lt 10 ]; do
    i=$((i + 1))
    if socks_ok; then log "SOCKS ok after restart"; set_state "SOCKS_READY"; return 0; fi
    sleep 1
  done
  log "SOCKS still down after restart"
  return 1
}

is_valid_public() {
  local h="$1"
  [ -n "$h" ] || return 1
  case "$h" in
    free.pinggy.io*|tcp@*|localhost*|127.0.0.1*|0.0.0.0*|*\"]\"*|YOUR-*|test-*|example.*) return 1 ;;
  esac
  echo "$h" | grep -qE '^[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+:[0-9]{2,5}$' || return 1
  local port="${h##*:}"
  [ "$port" -ge 1024 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null || return 1
  case "$h" in free.pinggy.io:*) return 1 ;; esac
  return 0
}

parse_public() {
  local f="$BASE/logs/pinggy.log"
  local line h
  line=$(grep -oE 'tcp://[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+:[0-9]+' "$f" 2>/dev/null | head -1)
  if [ -n "$line" ]; then
    h="${line#tcp://}"
    if is_valid_public "$h"; then echo "$h"; return 0; fi
  fi
  for pat in \
    '[A-Za-z0-9-]+\.run\.pinggy-free\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.[a-z0-9-]+\.pinggy\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.a\.free\.pinggy\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.a\.pinggy\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.pinggy\.io:[0-9]+' \
    '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+'
  do
    h=$(grep -oE "$pat" "$f" 2>/dev/null | head -1)
    if is_valid_public "$h"; then echo "$h"; return 0; fi
  done
  return 1
}

post_proxy() {
  local hp="$1"
  [ -n "$TOKEN" ] || { log "TOKEN missing — skip Railway update"; return 1; }
  [ -n "$URL" ] || { log "URL missing"; return 1; }
  is_valid_public "$hp" || { log "reject invalid endpoint $hp"; return 1; }
  local body code
  body=$(curl -sS --max-time 25 -w "\n%{http_code}" -X POST "$URL/proxy" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"server\":\"socks5://$hp\"}" 2>&1) || true
  code=$(echo "$body" | tail -1)
  local resp; resp=$(echo "$body" | sed '$d')
  log "POST /proxy http=$code"
  echo "$code" | grep -qE '^20' || { log "Railway HTTP fail code=$code"; return 1; }
  if echo "$resp" | grep -qi '"valid"[[:space:]]*:[[:space:]]*false'; then
    log "Railway rejected proxy (valid:false)"; return 1
  fi
  if echo "$resp" | grep -qi '"ok"[[:space:]]*:[[:space:]]*false'; then
    log "Railway ok:false"; return 1
  fi
  echo "socks5://$hp" >"$BASE/PROXY_SERVER.txt"
  echo "$hp" >"$BASE/last_public.txt"
  date +%s >"$BASE/pids/last_repost.txt"
  date +%s >"$BASE/pids/tunnel_start.txt"
  set_state "RAILWAY_UPDATED" "$hp"
  log "Railway accepted socks5://$hp"
  return 0
}

public_exit_ip() {
  local hp="$1"
  is_valid_public "$hp" || return 1
  curl -4 -fsS --max-time 18 --proxy "socks5h://$hp" https://api.ipify.org 2>/dev/null
}

public_ok() {
  local hp
  [ -f "$BASE/last_public.txt" ] || return 1
  hp=$(cat "$BASE/last_public.txt")
  is_valid_public "$hp" || return 1
  local ip; ip=$(public_exit_ip "$hp") || return 1
  [ -n "$ip" ] || return 1
  echo "$ip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || return 1
  return 0
}

start_pinggy() {
  set_state "TUNNEL_STARTING"
  kill_ermi_pinggy
  sleep 1
  : >"$BASE/logs/pinggy.log"
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
  while [ "$i" -lt 75 ]; do
    i=$((i + 1)); sleep 1
    PUBLIC=$(parse_public || true)
    if [ -n "$PUBLIC" ]; then
      set_state "PUBLIC_ENDPOINT_FOUND" "$PUBLIC"
      log "tunnel endpoint=$PUBLIC"
      local exit_ip="" j=0
      while [ "$j" -lt 8 ]; do
        j=$((j + 1))
        exit_ip=$(public_exit_ip "$PUBLIC" || true)
        if [ -n "$exit_ip" ] && echo "$exit_ip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
          set_state "PUBLIC_ENDPOINT_VERIFIED" "$PUBLIC ip=$exit_ip"
          log "e2e OK exit_ip=$exit_ip"
          if post_proxy "$PUBLIC"; then
            set_state "ACTIVE" "$PUBLIC"
            return 0
          else
            log "e2e ok but Railway update failed — will retry"
            echo "$PUBLIC" >"$BASE/last_public.txt"
            return 0
          fi
        fi
        sleep 2
      done
      log "endpoint found but e2e failed — not marking ACTIVE"
      echo "$PUBLIC" >"$BASE/last_public.txt"
      set_state "DEGRADED" "e2e_fail"
      return 1
    fi
  done
  log "no public url after 75s"
  set_state "DEGRADED" "no_endpoint"
  return 1
}

tunnel_age_secs() {
  if [ -f "$BASE/pids/tunnel_start.txt" ]; then
    local start now
    start=$(cat "$BASE/pids/tunnel_start.txt" 2>/dev/null || echo 0)
    now=$(date +%s)
    echo $((now - start))
  else echo 99999; fi
}

ensure_sshd
ensure_socks
start_pinggy || true

while true; do
  if ! socks_ok; then
    set_state "RECOVERING" "socks"
    log "local SOCKS down — restart"
    ensure_socks || true
  fi
  PID=$(cat "$BASE/pids/pinggy.pid" 2>/dev/null || true)
  NEED_RESTART=0
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    log "pinggy process dead"; NEED_RESTART=1
  elif ! public_ok; then
    log "public path dead or e2e fail"; NEED_RESTART=1
    set_state "DEGRADED" "public_dead"
  else
    age=$(tunnel_age_secs)
    jitter=$((RANDOM % 240 - 120))
    limit=$((ROTATE_SECS + jitter))
    if [ "$age" -ge "$limit" ]; then
      log "proactive rotate age=${age}s limit=${limit}s"
      NEED_RESTART=1
    fi
  fi
  if [ "$NEED_RESTART" -eq 1 ]; then
    set_state "RECOVERING" "tunnel"
    start_pinggy || true
  fi
  if [ -f "$BASE/last_public.txt" ] && [ "$(cat "$STATE_FILE" 2>/dev/null)" = "ACTIVE" ]; then
    now=$(date +%s)
    last=$(cat "$BASE/pids/last_repost.txt" 2>/dev/null || echo 0)
    if [ $((now - last)) -ge 300 ]; then
      hp=$(cat "$BASE/last_public.txt")
      if public_ok; then post_proxy "$hp" || true; fi
    fi
  fi
  sleep 25
done
