#!/data/data/com.termux/files/usr/bin/bash
# ERMI RUNTIME (Layer A) — SOCKS5 + Pinggy + Railway /proxy
# Single-instance via flock. Does NOT run package upgrades or watchdog.
set +m
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$BASE/health" "$HOME/.ssh" "$HOME/bin"

LOCK="$BASE/pids/runtime.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "ermi-runtime already running (flock held)" >&2
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
HEALTH_FILE="$BASE/health/status.env"
LOG_MAX_BYTES=524288

log() {
  local msg="$(date -Is) [runtime:$$] $*"
  echo "$msg" >>"$BASE/logs/runtime.log"
  if [ -f "$BASE/logs/runtime.log" ]; then
    local sz; sz=$(wc -c <"$BASE/logs/runtime.log" 2>/dev/null || echo 0)
    if [ "$sz" -gt "$LOG_MAX_BYTES" ]; then
      tail -c $((LOG_MAX_BYTES / 2)) "$BASE/logs/runtime.log" >"$BASE/logs/runtime.log.tmp" 2>/dev/null
      mv "$BASE/logs/runtime.log.tmp" "$BASE/logs/runtime.log" 2>/dev/null || true
    fi
  fi
}

set_state() {
  echo "$1" >"$STATE_FILE"
  log "STATE=$1 ${2:-}"
}

health_set() {
  local key="$1" val="$2"
  mkdir -p "$BASE/health"
  if [ -f "$HEALTH_FILE" ] && grep -q "^${key}=" "$HEALTH_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$HEALTH_FILE" 2>/dev/null || true
  else
    echo "${key}=${val}" >>"$HEALTH_FILE"
  fi
}

log "runtime start pid=$$"
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
