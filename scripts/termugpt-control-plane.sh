#!/data/data/com.termux/files/usr/bin/bash
# ERMI Termux CONTROL PLANE v7.1 — one-command installer/repairer
# Layers: Runtime | Watchdog | Maintenance | Boot recovery
# Safe to re-run. Idempotent. No credentials in this script.
set -e
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$BASE/health" "$HOME/.ssh" "$HOME/bin" "$PREFIX/etc/ssh" "$HOME/.termux/boot"

RAW="https://raw.githubusercontent.com/ermiyas48/ermi-worker-agent/main/scripts"
CP="$RAW/control-plane"
VERSION="v7.1"
JOB_WATCHDOG=17001
JOB_MAINTAIN=17002

echo "[ermi] CONTROL PLANE $VERSION install/repair"

FAIL=0
DEGRADED=0

echo "[ermi] ensuring packages..."
pkg update -y >/dev/null 2>&1 || true
if ! command -v ssh >/dev/null 2>&1 || ! command -v sshd >/dev/null 2>&1; then
  if ! pkg install -y openssh 2>/dev/null; then
    echo "[ermi] FAIL critical package: openssh"
    FAIL=1
  fi
fi
if ! command -v curl >/dev/null 2>&1; then
  if ! pkg install -y curl 2>/dev/null; then
    echo "[ermi] FAIL critical package: curl"
    FAIL=1
  fi
fi
for pkg in which coreutils procps findutils grep sed gawk termux-api; do
  command -v "${pkg%% *}" >/dev/null 2>&1 || pkg install -y "$pkg" 2>/dev/null || {
    echo "[ermi] DEGRADED optional package: $pkg"
    DEGRADED=1
  }
done
if [ "$FAIL" -eq 1 ]; then
  echo "[ermi] FAIL: critical dependencies missing — abort"
  exit 1
fi

if [ -f "$BASE/config.env" ]; then
  echo "[ermi] preserving existing config.env"
  grep -q '^URL=' "$BASE/config.env" 2>/dev/null || echo 'URL=https://ermi-worker-agent-production.up.railway.app' >>"$BASE/config.env"
  grep -q '^PINGGY_USER=' "$BASE/config.env" 2>/dev/null || echo 'PINGGY_USER=tcp@free.pinggy.io' >>"$BASE/config.env"
  grep -q '^SOCKS_PORT=' "$BASE/config.env" 2>/dev/null || echo 'SOCKS_PORT=1080' >>"$BASE/config.env"
  grep -q '^ROTATE_SECS=' "$BASE/config.env" 2>/dev/null || echo 'ROTATE_SECS=2700' >>"$BASE/config.env"
else
  cat >"$BASE/config.env" << 'CFGEOF'
# ERMI config — set TOKEN locally. Never commit real tokens.
TOKEN=
URL=https://ermi-worker-agent-production.up.railway.app
PINGGY_USER=tcp@free.pinggy.io
SOCKS_PORT=1080
SSHD_PORT=8022
ROTATE_SECS=2700
CFGEOF
  chmod 600 "$BASE/config.env"
  echo "[ermi] created credential-free config.env template"
fi

# shellcheck disable=SC1091
. "$BASE/config.env"
if [ -z "${TOKEN:-}" ]; then
  echo "[ermi] DEGRADED: TOKEN empty in $BASE/config.env"
  echo "[ermi]          set TOKEN=<your-owner-token> then: termugpt"
  DEGRADED=1
fi

[ -f "$HOME/.ssh/id_ermi" ] || ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ermi" -N "" -q
chmod 700 "$HOME/.ssh"
grep -qf "$HOME/.ssh/id_ermi.pub" "$HOME/.ssh/authorized_keys" 2>/dev/null || cat "$HOME/.ssh/id_ermi.pub" >>"$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys" "$HOME/.ssh/id_ermi" 2>/dev/null || true
[ -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" ] || ssh-keygen -t ed25519 -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" -N "" -q

echo "[ermi] stopping prior ERMI processes..."
pkill -f "sim-exit/ermi-runtime.sh" 2>/dev/null || true
pkill -f "sim-exit/termugpt.sh" 2>/dev/null || true
pkill -f "sim-exit/termugpt" 2>/dev/null || true
pkill -f "ssh -D 127.0.0.1:1080" 2>/dev/null || true
pkill -f "tcp@free.pinggy.io" 2>/dev/null || true
pkill -f "free.pinggy.io" 2>/dev/null || true
sleep 2

echo "[ermi] fetching layer scripts..."
dl() {
  local url="$1" dest="$2"
  local tmp="${dest}.tmp"
  if ! curl -fsSL --max-time 60 "$url" -o "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! head -1 "$tmp" | grep -qE 'bash|parse_public'; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$dest"
  chmod 755 "$dest" 2>/dev/null || true
  echo "[ermi] wrote $(basename "$dest")"
  return 0
}

if dl "$CP/ermi-runtime.sh" "$BASE/ermi-runtime.sh"; then
  :
elif dl "$CP/ermi-runtime.a.sh" "$BASE/ermi-runtime.a.sh" && dl "$CP/ermi-runtime.b.sh" "$BASE/ermi-runtime.b.sh"; then
  cat "$BASE/ermi-runtime.a.sh" "$BASE/ermi-runtime.b.sh" > "$BASE/ermi-runtime.sh"
  chmod 755 "$BASE/ermi-runtime.sh"
  rm -f "$BASE/ermi-runtime.a.sh" "$BASE/ermi-runtime.b.sh"
  echo "[ermi] assembled ermi-runtime.sh from a+b"
else
  echo "[ermi] FAIL: cannot download ermi-runtime.sh or a+b parts"
  exit 1
fi
if ! grep -q 'post_proxy' "$BASE/ermi-runtime.sh" || ! grep -q 'ROTATE_SECS' "$BASE/ermi-runtime.sh"; then
  echo "[ermi] FAIL: runtime missing required functions"
  exit 1
fi
ln -sf "$BASE/ermi-runtime.sh" "$BASE/termugpt.sh"

if ! dl "$CP/ermi-watchdog.sh" "$BASE/ermi-watchdog.sh"; then
  echo "[ermi] FAIL: cannot download watchdog"; exit 1
fi
if ! dl "$CP/ermi-maintain.sh" "$BASE/ermi-maintain.sh"; then
  echo "[ermi] FAIL: cannot download maintain"; exit 1
fi
if ! dl "$CP/ermi-boot.sh" "$BASE/ermi-boot.sh"; then
  echo "[ermi] FAIL: cannot download boot"; exit 1
fi

cat >"$HOME/bin/termugpt" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PATH="$HOME/bin:/data/data/com.termux/files/usr/bin:$PATH"
termux-wake-lock 2>/dev/null || true
BASE="$HOME/sim-exit"
if flock -n "$BASE/pids/runtime.lock" true 2>/dev/null; then
  nohup bash "$BASE/ermi-runtime.sh" >/dev/null 2>&1 &
  echo "started pid $!"
else
  echo "already running"
fi
for i in $(seq 1 90); do
  st=$(cat "$BASE/state.txt" 2>/dev/null || echo "")
  if [ "$st" = "ACTIVE" ]; then
    echo "STATE=ACTIVE"
    cat "$BASE/PROXY_SERVER.txt" 2>/dev/null
    exit 0
  fi
  sleep 2
done
echo "STATE=$(cat $BASE/state.txt 2>/dev/null || echo unknown)"
cat "$BASE/PROXY_SERVER.txt" 2>/dev/null || echo "(no proxy yet)"
WRAP
chmod 755 "$HOME/bin/termugpt"

cat >"$HOME/bin/termugpt-stop" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
export HOME="${HOME:-/data/data/com.termux/files/home}"
BASE="$HOME/sim-exit"
pkill -f "sim-exit/ermi-runtime.sh" 2>/dev/null || true
pkill -f "sim-exit/termugpt.sh" 2>/dev/null || true
pkill -f "ssh -D 127.0.0.1:1080" 2>/dev/null || true
pkill -f "tcp@free.pinggy.io" 2>/dev/null || true
pkill -f "free.pinggy.io" 2>/dev/null || true
pkill -f "pro.pinggy.io" 2>/dev/null || true
termux-wake-unlock 2>/dev/null || true
echo "stopped"
WRAP
chmod 755 "$HOME/bin/termugpt-stop"

cat >"$HOME/bin/termugpt-status" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
export HOME="${HOME:-/data/data/com.termux/files/home}"
BASE="$HOME/sim-exit"
echo "=== ERMI CONTROL PLANE STATUS ==="
echo "state: $(cat $BASE/state.txt 2>/dev/null || echo none)"
echo "proxy: $(cat $BASE/PROXY_SERVER.txt 2>/dev/null || echo none)"
echo "public: $(cat $BASE/last_public.txt 2>/dev/null || echo none)"
TOKEN_SET=no
if [ -f "$BASE/config.env" ]; then
  . "$BASE/config.env"
  [ -n "${TOKEN:-}" ] && TOKEN_SET=yes
fi
echo "token: $TOKEN_SET"
echo "health:"
cat "$BASE/health/status.env" 2>/dev/null || echo "  (none)"
echo "locks:"
for l in runtime.lock watchdog.lock maintenance.lock; do
  if [ -f "$BASE/pids/$l" ]; then
    if flock -n "$BASE/pids/$l" true 2>/dev/null; then echo "  $l: free"; else echo "  $l: HELD"; fi
  else
    echo "  $l: absent"
  fi
done
echo "processes:"
pgrep -af "ermi-runtime|ssh -D 127.0.0.1|pinggy" 2>/dev/null | head -10 || echo "  (none)"
echo "boot: $([ -x $HOME/.termux/boot/ermi-start.sh ] && echo installed || echo missing)"
echo "jobs:"
termux-job-scheduler --pending 2>/dev/null | head -30 || echo "  (termux-job-scheduler unavailable)"
echo "=== runtime log (tail) ==="
tail -15 "$BASE/logs/runtime.log" 2>/dev/null || true
WRAP
chmod 755 "$HOME/bin/termugpt-status"

cat >"$HOME/bin/termugpt-logs" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
tail -f "$HOME/sim-exit/logs/runtime.log"
WRAP
chmod 755 "$HOME/bin/termugpt-logs"

cat >"$HOME/bin/termugpt-watchdog" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
exec bash "$HOME/sim-exit/ermi-watchdog.sh"
WRAP
chmod 755 "$HOME/bin/termugpt-watchdog"

cat >"$HOME/bin/termugpt-maintain" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
exec bash "$HOME/sim-exit/ermi-maintain.sh" "$@"
WRAP
chmod 755 "$HOME/bin/termugpt-maintain"

grep -q 'HOME/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >>"$HOME/.bashrc"
export PATH="$HOME/bin:$PATH"

cp "$BASE/ermi-boot.sh" "$HOME/.termux/boot/ermi-start.sh"
chmod 755 "$HOME/.termux/boot/ermi-start.sh"
echo "[ermi] boot hook installed"

if command -v termux-job-scheduler >/dev/null 2>&1; then
  termux-job-scheduler --script "$BASE/ermi-watchdog.sh" \
    --job-id "$JOB_WATCHDOG" --period-ms 900000 \
    --network any --battery-not-low false --persisted true
  termux-job-scheduler --script "$BASE/ermi-maintain.sh" \
    --job-id "$JOB_MAINTAIN" --period-ms 86400000 \
    --network any --battery-not-low true --persisted true
  echo "[ermi] scheduled job-id=$JOB_WATCHDOG (watchdog 15m), job-id=$JOB_MAINTAIN (maintain daily)"
else
  echo "[ermi] DEGRADED: termux-job-scheduler missing (install Termux:API)"
  DEGRADED=1
fi

echo "[ermi] starting runtime..."
termux-wake-lock 2>/dev/null || true
nohup bash "$BASE/ermi-runtime.sh" >/dev/null 2>&1 &
echo "[ermi] runtime pid=$!"

OK=0
for i in $(seq 1 100); do
  st=$(cat "$BASE/state.txt" 2>/dev/null || echo "")
  if [ "$st" = "ACTIVE" ]; then OK=1; break; fi
  if [ "$st" = "DEGRADED" ] && [ "$i" -gt 60 ]; then break; fi
  sleep 2
done

echo ""
echo "========== ERMI CONTROL PLANE $VERSION =========="
echo "state: $(cat $BASE/state.txt 2>/dev/null || echo unknown)"
echo "proxy: $(cat $BASE/PROXY_SERVER.txt 2>/dev/null || echo none)"
if [ -z "${TOKEN:-}" ]; then
  echo "result: DEGRADED — TOKEN missing; set in $BASE/config.env then: termugpt"
elif [ "$OK" = "1" ]; then
  echo "result: SUCCESS — ACTIVE e2e + Railway valid"
else
  echo "result: DEGRADED — not ACTIVE yet; run: termugpt-status"
  tail -20 "$BASE/logs/runtime.log" 2>/dev/null || true
fi
[ "$DEGRADED" -eq 1 ] && echo "note: some optional components DEGRADED (see above)"
echo "commands: termugpt | termugpt-status | termugpt-stop | termugpt-logs"
echo "           termugpt-watchdog | termugpt-maintain [auto|cleanup|packages]"
echo "jobs: $JOB_WATCHDOG=watchdog $JOB_MAINTAIN=maintain"
echo "================================================="
