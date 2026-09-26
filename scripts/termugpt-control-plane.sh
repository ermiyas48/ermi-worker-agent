#!/data/data/com.termux/files/usr/bin/bash
# ERMI Termux CONTROL PLANE v7 — one-command installer/repairer
# Layers: Runtime | Watchdog | Maintenance | Boot recovery
# Safe to re-run. Idempotent. Downloads layer scripts from stable raw URLs.
set -e
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$BASE/health" "$HOME/.ssh" "$HOME/bin" "$PREFIX/etc/ssh" "$HOME/.termux/boot"

REPO_RAW="https://raw.githubusercontent.com/ermiyas48/ermi-worker-agent/main/scripts/control-plane"
VERSION="v7"

echo "[ermi] CONTROL PLANE $VERSION install/repair"

# --- packages (non-interactive, tolerate failures) ---
echo "[ermi] ensuring packages..."
pkg update -y >/dev/null 2>&1 || true
for pkg in openssh curl which coreutils procps findutils grep sed gawk termux-api; do
  command -v "${pkg%% *}" >/dev/null 2>&1 || pkg install -y "$pkg" 2>/dev/null || true
done

# --- preserve config.env ---
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

# --- SSH keys ---
[ -f "$HOME/.ssh/id_ermi" ] || ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ermi" -N "" -q
chmod 700 "$HOME/.ssh"
grep -qf "$HOME/.ssh/id_ermi.pub" "$HOME/.ssh/authorized_keys" 2>/dev/null || cat "$HOME/.ssh/id_ermi.pub" >>"$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys" "$HOME/.ssh/id_ermi" 2>/dev/null || true
[ -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" ] || ssh-keygen -t ed25519 -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" -N "" -q

# --- stop prior ERMI only ---
echo "[ermi] stopping prior ERMI processes..."
pkill -f "sim-exit/ermi-runtime.sh" 2>/dev/null || true
pkill -f "sim-exit/termugpt.sh" 2>/dev/null || true
pkill -f "sim-exit/termugpt" 2>/dev/null || true
pkill -f "ssh -D 127.0.0.1:1080" 2>/dev/null || true
pkill -f "tcp@free.pinggy.io" 2>/dev/null || true
pkill -f "free.pinggy.io" 2>/dev/null || true
sleep 2

# --- download layer scripts ---
echo "[ermi] fetching layer scripts..."
for s in ermi-runtime.sh ermi-watchdog.sh ermi-maintain.sh ermi-boot.sh; do
  tmp="$BASE/${s}.tmp"
  if curl -fsSL --max-time 60 "$REPO_RAW/$s" -o "$tmp"; then
    head -1 "$tmp" | grep -q 'bash' || { echo "[ermi] bad script $s"; rm -f "$tmp"; exit 1; }
    mv "$tmp" "$BASE/$s"
    chmod 755 "$BASE/$s"
    echo "[ermi] wrote $s"
  else
    echo "[ermi] FAIL download $s"
    exit 1
  fi
done
ln -sf "$BASE/ermi-runtime.sh" "$BASE/termugpt.sh"

# --- wrappers ---
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
echo "watchdog jobs:"
termux-job-scheduler --pending 2>/dev/null | head -20 || echo "  (termux-job-scheduler unavailable)"
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

# --- boot integration ---
cp "$BASE/ermi-boot.sh" "$HOME/.termux/boot/ermi-start.sh"
chmod 755 "$HOME/.termux/boot/ermi-start.sh"
echo "[ermi] boot hook installed (~/.termux/boot/ermi-start.sh)"

# --- schedule watchdog (~15 min) + daily maintain ---
if command -v termux-job-scheduler >/dev/null 2>&1; then
  termux-job-scheduler --cancel-all 2>/dev/null || true
  termux-job-scheduler -s "$BASE/ermi-watchdog.sh" --period 900 --network any --battery-not-low false 2>/dev/null || true
  termux-job-scheduler -s "$BASE/ermi-maintain.sh" --period 86400 --network any --battery-not-low true 2>/dev/null || true
  echo "[ermi] scheduled: watchdog ~15m, maintain daily (packages weekly inside maintain)"
else
  echo "[ermi] termux-job-scheduler not found — install Termux:API; boot + manual still work"
fi

# --- start runtime ---
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
echo "========== ERMI CONTROL PLANE v7 =========="
echo "state: $(cat $BASE/state.txt 2>/dev/null || echo unknown)"
echo "proxy: $(cat $BASE/PROXY_SERVER.txt 2>/dev/null || echo none)"
if [ "$OK" = "1" ]; then
  echo "result: ACTIVE — e2e + Railway OK"
else
  echo "result: not yet ACTIVE — run: termugpt-status"
  tail -20 "$BASE/logs/runtime.log" 2>/dev/null || true
fi
echo "commands: termugpt | termugpt-status | termugpt-stop | termugpt-logs"
echo "           termugpt-watchdog | termugpt-maintain [auto|cleanup|packages]"
echo "layers: RUNTIME | WATCHDOG(~15m) | MAINTAIN(weekly pkgs) | BOOT"
echo "==========================================="
