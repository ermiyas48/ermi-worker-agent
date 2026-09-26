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

# Exact source pin (same commit as tested layers)
PIN="26cc766abfd300c7cc496902431012cfb5d625f6"
RAW="https://raw.githubusercontent.com/ermiyas48/ermi-worker-agent/${PIN}/scripts"
CP="$RAW/control-plane"
VERSION="v7.1"
JOB_WATCHDOG=17001
JOB_MAINTAIN=17002

echo "[ermi] CONTROL PLANE $VERSION install/repair (pin=$PIN)"

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
  echo "[ermi]          inject once: termugpt-set-token"
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

echo "[ermi] fetching layer scripts (pin=$PIN)..."
dl() {
  local url="$1" dest="$2"
  local tmp="${dest}.tmp"
  if ! curl -fsSL --max-time 60 "$url" -o "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  local sz
  sz=$(wc -c <"$tmp" 2>/dev/null || echo 0)
  if [ "$sz" -lt 200 ]; then
    echo "[ermi] FAIL: $url too small ($sz bytes)"
    rm -f "$tmp"
    return 1
  fi
  if ! bash -n "$tmp" 2>/dev/null; then
    echo "[ermi] FAIL: bash -n failed for $(basename "$dest")"
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$dest"
  chmod 755 "$dest" 2>/dev/null || true
  echo "[ermi] wrote $(basename "$dest") ($sz bytes, bash -n OK)"
  return 0
}

RT_OK=0
if dl "$CP/ermi-runtime.sh" "$BASE/ermi-runtime.sh.new"; then
  RT_OK=1
elif dl "$CP/ermi-runtime.a.sh" "$BASE/ermi-runtime.a.sh" && dl "$CP/ermi-runtime.b.sh" "$BASE/ermi-runtime.b.sh"; then
  cat "$BASE/ermi-runtime.a.sh" "$BASE/ermi-runtime.b.sh" > "$BASE/ermi-runtime.sh.new"
  chmod 755 "$BASE/ermi-runtime.sh.new"
  if ! bash -n "$BASE/ermi-runtime.sh.new" 2>/dev/null; then
    echo "[ermi] FAIL: assembled runtime bash -n failed"
    exit 1
  fi
  rm -f "$BASE/ermi-runtime.a.sh" "$BASE/ermi-runtime.b.sh"
  echo "[ermi] assembled ermi-runtime.sh (bash -n OK)"
  RT_OK=1
fi
if [ "$RT_OK" -ne 1 ]; then
  echo "[ermi] FAIL: cannot download ermi-runtime.sh or a+b parts from pin $PIN"
  exit 1
fi
if ! grep -q 'post_proxy' "$BASE/ermi-runtime.sh.new" || ! grep -q 'ROTATE_SECS' "$BASE/ermi-runtime.sh.new"; then
  echo "[ermi] FAIL: runtime missing required functions"
  exit 1
fi
mv "$BASE/ermi-runtime.sh.new" "$BASE/ermi-runtime.sh"
ln -sf "$BASE/ermi-runtime.sh" "$BASE/termugpt.sh"

for pair in "ermi-watchdog.sh:watchdog" "ermi-maintain.sh:maintain" "ermi-boot.sh:boot"; do
  f="${pair%%:*}"; label="${pair##*:}"
  if ! dl "$CP/$f" "$BASE/${f}.new"; then
    echo "[ermi] FAIL: cannot download $label"
    exit 1
  fi
  mv "$BASE/${f}.new" "$BASE/$f"
done

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

cat >"$HOME/bin/termugpt-set-token" << 'WRAP'
#!/data/data/com.termux/files/usr/bin/bash
# Usage: termugpt-set-token   (reads one line from stdin; never prints the secret)
set -e
BASE="${HOME:-/data/data/com.termux/files/home}/sim-exit"
mkdir -p "$BASE"
if [ -t 0 ]; then
  echo "Paste TOKEN then Enter (input hidden if possible):" >&2
  stty -echo 2>/dev/null || true
  read -r TOK
  stty echo 2>/dev/null || true
  echo >&2
else
  read -r TOK
fi
[ -n "$TOK" ] || { echo "empty token" >&2; exit 1; }
touch "$BASE/config.env"
chmod 600 "$BASE/config.env"
if grep -q '^TOKEN=' "$BASE/config.env" 2>/dev/null; then
  grep -v '^TOKEN=' "$BASE/config.env" >"$BASE/config.env.tmp" || true
  printf 'TOKEN=%s\n' "$TOK" >>"$BASE/config.env.tmp"
  mv "$BASE/config.env.tmp" "$BASE/config.env"
else
  printf 'TOKEN=%s\n' "$TOK" >>"$BASE/config.env"
fi
chmod 600 "$BASE/config.env"
echo "token saved (not displayed). run: termugpt"
WRAP
chmod 755 "$HOME/bin/termugpt-set-token"

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
echo "pin: $PIN"
echo "state: $(cat $BASE/state.txt 2>/dev/null || echo unknown)"
echo "proxy: $(cat $BASE/PROXY_SERVER.txt 2>/dev/null || echo none)"
if [ -z "${TOKEN:-}" ]; then
  echo "result: DEGRADED — set token once: termugpt-set-token"
elif [ "$OK" = "1" ]; then
  echo "result: SUCCESS — ACTIVE e2e + Railway valid"
else
  echo "result: DEGRADED — not ACTIVE yet; run: termugpt-status"
  tail -20 "$BASE/logs/runtime.log" 2>/dev/null || true
fi
[ "$DEGRADED" -eq 1 ] && echo "note: some optional components DEGRADED"
echo "commands: termugpt | termugpt-status | termugpt-stop | termugpt-set-token"
echo "           termugpt-watchdog | termugpt-maintain [auto|cleanup|packages]"
echo "jobs: $JOB_WATCHDOG=watchdog $JOB_MAINTAIN=maintain"
echo "================================================="
