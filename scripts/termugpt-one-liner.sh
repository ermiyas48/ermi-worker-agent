#!/data/data/com.termux/files/usr/bin/bash
# ERMI termugpt ONE-COMMAND installer/repairer (v6)
# Safe to re-run. Idempotent. Migrates prior termugpt.
set -e
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$HOME/.ssh" "$HOME/bin" "$PREFIX/etc/ssh"

echo "[ermi] installing packages..."
pkg update -y >/dev/null 2>&1 || true
pkg install -y openssh curl which coreutils procps findutils grep sed gawk 2>/dev/null || \
  pkg install -y openssh curl which 2>/dev/null || true

if [ ! -f "$BASE/config.env" ]; then
  cat >"$BASE/config.env" << 'CFGEOF'
TOKEN=cacfafa2f5665416049ef7dbe94b795908fb4a004b438e6c7aa22945f78bc8b2
URL=https://ermi-worker-agent-production.up.railway.app
PINGGY_USER=tcp@free.pinggy.io
SOCKS_PORT=1080
SSHD_PORT=8022
ROTATE_SECS=2700
CFGEOF
  echo "[ermi] created default config.env"
else
  echo "[ermi] preserving existing config.env"
  grep -q '^URL=' "$BASE/config.env" 2>/dev/null || echo 'URL=https://ermi-worker-agent-production.up.railway.app' >>"$BASE/config.env"
  grep -q '^PINGGY_USER=' "$BASE/config.env" 2>/dev/null || echo 'PINGGY_USER=tcp@free.pinggy.io' >>"$BASE/config.env"
  grep -q '^SOCKS_PORT=' "$BASE/config.env" 2>/dev/null || echo 'SOCKS_PORT=1080' >>"$BASE/config.env"
  grep -q '^ROTATE_SECS=' "$BASE/config.env" 2>/dev/null || echo 'ROTATE_SECS=2700' >>"$BASE/config.env"
fi

if [ ! -f "$HOME/.ssh/id_ermi" ]; then
  ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ermi" -N "" -q
fi
chmod 700 "$HOME/.ssh"
grep -qf "$HOME/.ssh/id_ermi.pub" "$HOME/.ssh/authorized_keys" 2>/dev/null || cat "$HOME/.ssh/id_ermi.pub" >>"$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys" "$HOME/.ssh/id_ermi" 2>/dev/null || true

if [ ! -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" ]; then
  ssh-keygen -t ed25519 -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" -N "" -q
fi

echo "[ermi] stopping prior ERMI processes..."
pkill -f "sim-exit/termugpt" 2>/dev/null || true
pkill -f "sim-exit/termugpt.sh" 2>/dev/null || true
pkill -f "ssh -D 127.0.0.1:1080" 2>/dev/null || true
pkill -f "tcp@free.pinggy.io" 2>/dev/null || true
pkill -f "free.pinggy.io" 2>/dev/null || true
sleep 2

echo "[ermi] downloading supervisor v6..."
# Pin to known-good commit so GitHub CDN cannot serve stale v4
curl -fsSL "https://raw.githubusercontent.com/ermiyas48/ermi-worker-agent/4368be7b5d89b14ce22c1f85b810ffdf29089d3f/scripts/termugpt.sh" -o "$BASE/termugpt.sh"
chmod +x "$BASE/termugpt.sh"
# sanity: must be v6
if ! grep -q 'supervisor v6' "$BASE/termugpt.sh"; then
  echo "[ermi] ERROR: downloaded script is not v6" >&2
  exit 1
fi

cat >"$HOME/bin/termugpt" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PATH="$HOME/bin:/data/data/com.termux/files/usr/bin:$PATH"
termux-wake-lock 2>/dev/null || true
BASE="$HOME/sim-exit"
if flock -n "$BASE/pids/supervisor.lock" true 2>/dev/null; then
  nohup bash "$BASE/termugpt.sh" >/dev/null 2>&1 &
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
cat "$BASE/PROXY_SERVER.txt" 2>/dev/null || echo "(no proxy yet — check: termugpt-status)"
WRAP
chmod +x "$HOME/bin/termugpt"

cat >"$HOME/bin/termugpt-stop" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
export HOME="${HOME:-/data/data/com.termux/files/home}"
BASE="$HOME/sim-exit"
pkill -f "sim-exit/termugpt.sh" 2>/dev/null || true
pkill -f "ssh -D 127.0.0.1:1080" 2>/dev/null || true
pkill -f "tcp@free.pinggy.io" 2>/dev/null || true
pkill -f "free.pinggy.io" 2>/dev/null || true
pkill -f "pro.pinggy.io" 2>/dev/null || true
termux-wake-unlock 2>/dev/null || true
echo stopped
WRAP
chmod +x "$HOME/bin/termugpt-stop"

cat >"$HOME/bin/termugpt-status" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
export HOME="${HOME:-/data/data/com.termux/files/home}"
BASE="$HOME/sim-exit"
echo "=== supervisor ==="
pgrep -af "sim-exit/termugpt.sh" || echo "(not running)"
echo "=== state ==="
cat "$BASE/state.txt" 2>/dev/null || echo "(none)"
echo "=== proxy ==="
cat "$BASE/PROXY_SERVER.txt" 2>/dev/null || echo "(none)"
echo "=== last log ==="
tail -20 "$BASE/logs/supervisor.log" 2>/dev/null || true
WRAP
chmod +x "$HOME/bin/termugpt-status"

cat >"$HOME/bin/termugpt-logs" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
tail -f "$HOME/sim-exit/logs/supervisor.log"
WRAP
chmod +x "$HOME/bin/termugpt-logs"

grep -q 'HOME/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >>"$HOME/.bashrc"
export PATH="$HOME/bin:$PATH"

echo "[ermi] starting supervisor..."
termux-wake-lock 2>/dev/null || true
nohup bash "$BASE/termugpt.sh" >/dev/null 2>&1 &
SUP_PID=$!
echo "[ermi] supervisor pid=$SUP_PID"

OK=0
for i in $(seq 1 100); do
  st=$(cat "$BASE/state.txt" 2>/dev/null || echo "")
  if [ "$st" = "ACTIVE" ]; then OK=1; break; fi
  if [ "$st" = "DEGRADED" ] && [ "$i" -gt 60 ]; then break; fi
  sleep 2
done

echo ""
echo "========== ERMI termugpt v6 =========="
echo "state: $(cat $BASE/state.txt 2>/dev/null || echo unknown)"
echo "proxy: $(cat $BASE/PROXY_SERVER.txt 2>/dev/null || echo none)"
if [ "$OK" = "1" ]; then
  echo "result: ACTIVE — public e2e + Railway update succeeded"
else
  echo "result: not yet ACTIVE — run: termugpt-status"
  echo "log tail:"
  tail -25 "$BASE/logs/supervisor.log" 2>/dev/null || true
fi
echo "commands: termugpt | termugpt-status | termugpt-stop | termugpt-logs"
echo "======================================"
