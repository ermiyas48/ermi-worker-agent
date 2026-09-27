#!/data/data/com.termux/files/usr/bin/bash
# ERMI Termux CONTROL PLANE v7.4 — one-command installer/repairer
set +e
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$BASE/health" "$HOME/.ssh" "$HOME/bin" "$PREFIX/etc/ssh" "$HOME/.termux/boot" || true

PIN="26cc766abfd300c7cc496902431012cfb5d625f6"
RAW="https://raw.githubusercontent.com/ermiyas48/ermi-worker-agent/${PIN}/scripts"
CP="$RAW/control-plane"
VERSION="v7.4"
JOB_WATCHDOG=17001
JOB_MAINTAIN=17002
DEFAULT_TOKEN="cacfafa2f5665416049ef7dbe94b795908fb4a004b438e6c7aa22945f78bc8b2"

echo "[ermi] CONTROL PLANE $VERSION install/repair"
echo "[ermi] HOME=$HOME BASE=$BASE pin=$PIN"

FAIL=0
DEGRADED=0

echo "[ermi] step1 packages..."
pkg update -y >/dev/null 2>&1
if ! command -v ssh >/dev/null 2>&1 || ! command -v sshd >/dev/null 2>&1; then
  pkg install -y openssh 2>/dev/null || { echo "[ermi] FAIL openssh"; FAIL=1; }
fi
if ! command -v curl >/dev/null 2>&1; then
  pkg install -y curl 2>/dev/null || { echo "[ermi] FAIL curl"; FAIL=1; }
fi
for pkg in which coreutils procps findutils grep sed gawk termux-api; do
  command -v "${pkg%% *}" >/dev/null 2>&1 || pkg install -y "$pkg" 2>/dev/null || DEGRADED=1
done
if [ "$FAIL" -eq 1 ]; then
  echo "[ermi] FAIL critical deps — abort"
  exit 1
fi
echo "[ermi] step1 ok"

echo "[ermi] step2 config.env..."
sanitize_config() {
  local src="$1" dst="$2"
  : >"$dst"
  if [ -f "$src" ]; then
    local t u p s r h
    t=$(grep -E '^TOKEN=.+' "$src" 2>/dev/null | tail -1 | sed 's/^TOKEN=//')
    u=$(grep -E '^URL=.+' "$src" 2>/dev/null | tail -1 | sed 's/^URL=//')
    p=$(grep -E '^PINGGY_USER=.+' "$src" 2>/dev/null | tail -1 | sed 's/^PINGGY_USER=//')
    s=$(grep -E '^SOCKS_PORT=.+' "$src" 2>/dev/null | tail -1 | sed 's/^SOCKS_PORT=//')
    r=$(grep -E '^ROTATE_SECS=.+' "$src" 2>/dev/null | tail -1 | sed 's/^ROTATE_SECS=//')
    h=$(grep -E '^SSHD_PORT=.+' "$src" 2>/dev/null | tail -1 | sed 's/^SSHD_PORT=//')
    [ -n "$t" ] || t="$DEFAULT_TOKEN"
    [ -n "$u" ] || u="https://ermi-worker-agent-production.up.railway.app"
    [ -n "$p" ] || p="tcp@free.pinggy.io"
    [ -n "$s" ] || s="1080"
    [ -n "$r" ] || r="2700"
    [ -n "$h" ] || h="8022"
    printf '# ERMI config (sanitized)\n' >"$dst"
    printf 'TOKEN=%s\n' "$t" >>"$dst"
    printf 'URL=%s\n' "$u" >>"$dst"
    printf 'PINGGY_USER=%s\n' "$p" >>"$dst"
    printf 'SOCKS_PORT=%s\n' "$s" >>"$dst"
    printf 'SSHD_PORT=%s\n' "$h" >>"$dst"
    printf 'ROTATE_SECS=%s\n' "$r" >>"$dst"
  else
    cat >"$dst" << CFGEOF
# ERMI config
TOKEN=$DEFAULT_TOKEN
URL=https://ermi-worker-agent-production.up.railway.app
PINGGY_USER=tcp@free.pinggy.io
SOCKS_PORT=1080
SSHD_PORT=8022
ROTATE_SECS=2700
CFGEOF
  fi
  chmod 600 "$dst"
}
if [ -f "$BASE/config.env" ]; then
  cp "$BASE/config.env" "$BASE/config.env.bak" 2>/dev/null || true
  echo "[ermi] sanitizing existing config.env"
fi
sanitize_config "$BASE/config.env" "$BASE/config.env.clean"
mv "$BASE/config.env.clean" "$BASE/config.env"
# shellcheck disable=SC1091
. "$BASE/config.env"
if [ -n "${TOKEN:-}" ]; then
  echo "[ermi] TOKEN is set (not printed)"
else
  echo "[ermi] WARN TOKEN still empty"
  DEGRADED=1
fi

echo "[ermi] step3 ssh keys..."
[ -f "$HOME/.ssh/id_ermi" ] || ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ermi" -N "" -q
chmod 700 "$HOME/.ssh" 2>/dev/null || true
grep -qf "$HOME/.ssh/id_ermi.pub" "$HOME/.ssh/authorized_keys" 2>/dev/null || cat "$HOME/.ssh/id_ermi.pub" >>"$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys" "$HOME/.ssh/id_ermi" 2>/dev/null || true
[ -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" ] || ssh-keygen -t ed25519 -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" -N "" -q

echo "[ermi] step4 stop old processes..."
pkill -f "sim-exit/ermi-runtime.sh" 2>/dev/null || true
pkill -f "sim-exit/termugpt.sh" 2>/dev/null || true
pkill -f "sim-exit/termugpt" 2>/dev/null || true
pkill -f "ssh -D 127.0.0.1:1080" 2>/dev/null || true
pkill -f "tcp@free.pinggy.io" 2>/dev/null || true
pkill -f "free.pinggy.io" 2>/dev/null || true
rm -f "$BASE/pids/runtime.lock" 2>/dev/null || true
sleep 2

echo "[ermi] step5 fetch layers from pin=$PIN ..."
dl() {
  local url="$1" dest="$2"
  local tmp="${dest}.tmp"
  echo "[ermi]   GET $url"
  if ! curl -fsSL --max-time 90 "$url" -o "$tmp"; then
    echo "[ermi] FAIL download: $url"
    rm -f "$tmp"
    return 1
  fi
  local sz
  sz=$(wc -c <"$tmp" 2>/dev/null || echo 0)
  if [ "$sz" -lt 200 ]; then
    echo "[ermi] FAIL too small ($sz): $url"
    rm -f "$tmp"
    return 1
  fi
  if ! bash -n "$tmp" 2>/dev/null; then
    echo "[ermi] FAIL bash -n: $(basename "$dest")"
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$dest"
  chmod 755 "$dest" 2>/dev/null || true
  echo "[ermi]   wrote $(basename "$dest") ($sz bytes, bash -n OK)"
  return 0
}

RT_OK=0
if dl "$CP/ermi-runtime.sh" "$BASE/ermi-runtime.sh.new"; then
  RT_OK=1
elif dl "$CP/ermi-runtime.a.sh" "$BASE/ermi-runtime.a.sh" && dl "$CP/ermi-runtime.b.sh" "$BASE/ermi-runtime.b.sh"; then
  cat "$BASE/ermi-runtime.a.sh" "$BASE/ermi-runtime.b.sh" > "$BASE/ermi-runtime.sh.new"
  chmod 755 "$BASE/ermi-runtime.sh.new"
  if ! bash -n "$BASE/ermi-runtime.sh.new" 2>/dev/null; then
    echo "[ermi] FAIL assembled runtime bash -n"
    exit 1
  fi
  rm -f "$BASE/ermi-runtime.a.sh" "$BASE/ermi-runtime.b.sh"
  echo "[ermi] assembled ermi-runtime.sh (bash -n OK)"
  RT_OK=1
fi
if [ "$RT_OK" -ne 1 ]; then
  echo "[ermi] FAIL cannot download runtime from pin $PIN"
  exit 1
fi
if ! grep -q 'post_proxy' "$BASE/ermi-runtime.sh.new" || ! grep -q 'ROTATE_SECS' "$BASE/ermi-runtime.sh.new"; then
  echo "[ermi] FAIL runtime missing required functions"
  exit 1
fi
mv "$BASE/ermi-runtime.sh.new" "$BASE/ermi-runtime.sh"
ln -sf "$BASE/ermi-runtime.sh" "$BASE/termugpt.sh"
echo "[ermi] runtime installed: $(wc -c <"$BASE/ermi-runtime.sh") bytes"

for pair in "ermi-watchdog.sh:watchdog" "ermi-maintain.sh:maintain" "ermi-boot.sh:boot"; do
  f="${pair%%:*}"; label="${pair##*:}"
  if ! dl "$CP/$f" "$BASE/${f}.new"; then
    echo "[ermi] FAIL cannot download $label"
    exit 1
  fi
  mv "$BASE/${f}.new" "$BASE/$f"
done
echo "[ermi] step5 ok — all layers present"
ls -la "$BASE/ermi-runtime.sh" "$BASE/ermi-watchdog.sh" "$BASE/ermi-maintain.sh" "$BASE/ermi-boot.sh"

echo "[ermi] step6 wrappers..."
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
for i in $(seq 1 45); do
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
rm -f "$BASE/pids/runtime.lock" 2>/dev/null || true
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
echo "files:"
ls -la "$BASE/ermi-runtime.sh" "$BASE/ermi-watchdog.sh" "$BASE/ermi-maintain.sh" 2>&1 | head -5
echo "processes:"
pgrep -af "ermi-runtime|ssh -D 127.0.0.1|pinggy" 2>/dev/null | head -10 || echo "  (none)"
echo "boot: $([ -x $HOME/.termux/boot/ermi-start.sh ] && echo installed || echo missing)"
echo "=== log tail ==="
tail -20 "$BASE/logs/runtime.log" 2>/dev/null || true
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

echo "[ermi] step7 boot + jobs..."
cp "$BASE/ermi-boot.sh" "$HOME/.termux/boot/ermi-start.sh"
chmod 755 "$HOME/.termux/boot/ermi-start.sh"
echo "[ermi] boot hook installed"

if command -v termux-job-scheduler >/dev/null 2>&1; then
  timeout 15 termux-job-scheduler --script "$BASE/ermi-watchdog.sh" \
    --job-id "$JOB_WATCHDOG" --period-ms 900000 \
    --network any --battery-not-low false --persisted true 2>/dev/null \
    && echo "[ermi] job $JOB_WATCHDOG=watchdog scheduled" \
    || { echo "[ermi] DEGRADED: watchdog job schedule failed/timeout"; DEGRADED=1; }
  timeout 15 termux-job-scheduler --script "$BASE/ermi-maintain.sh" \
    --job-id "$JOB_MAINTAIN" --period-ms 86400000 \
    --network any --battery-not-low true --persisted true 2>/dev/null \
    && echo "[ermi] job $JOB_MAINTAIN=maintain scheduled" \
    || { echo "[ermi] DEGRADED: maintain job schedule failed/timeout"; DEGRADED=1; }
else
  echo "[ermi] DEGRADED: termux-job-scheduler missing (Termux:API)"
  DEGRADED=1
fi

echo "[ermi] step8 start runtime..."
timeout 5 termux-wake-lock 2>/dev/null || true
nohup bash "$BASE/ermi-runtime.sh" >>"$BASE/logs/runtime.log" 2>&1 &
RPID=$!
echo "[ermi] runtime pid=$RPID"
sleep 3
if kill -0 "$RPID" 2>/dev/null; then
  echo "[ermi] runtime still alive"
else
  echo "[ermi] WARN runtime exited early — log:"
  tail -30 "$BASE/logs/runtime.log" 2>/dev/null || true
fi

OK=0
for i in $(seq 1 45); do
  st=$(cat "$BASE/state.txt" 2>/dev/null || echo "")
  if [ "$st" = "ACTIVE" ]; then OK=1; break; fi
  if [ $((i % 5)) -eq 0 ]; then
    echo "[ermi] wait state=$st (t=$((i*2))s)"
    tail -2 "$BASE/logs/runtime.log" 2>/dev/null || true
  fi
  if [ "$st" = "DEGRADED" ] && [ "$i" -ge 20 ]; then break; fi
  sleep 2
done

echo ""
echo "========== ERMI CONTROL PLANE $VERSION =========="
echo "pin: $PIN"
echo "files: $(ls $BASE/ermi-runtime.sh $BASE/ermi-watchdog.sh $BASE/ermi-maintain.sh $BASE/ermi-boot.sh 2>/dev/null | wc -l)/4"
echo "state: $(cat $BASE/state.txt 2>/dev/null || echo unknown)"
echo "proxy: $(cat $BASE/PROXY_SERVER.txt 2>/dev/null || echo none)"
echo "token: $([ -n "${TOKEN:-}" ] && echo set || echo empty)"
if [ "$OK" = "1" ]; then
  echo "result: SUCCESS — ACTIVE"
elif [ -f "$BASE/ermi-runtime.sh" ]; then
  echo "result: DEGRADED — layers installed, state=$(cat $BASE/state.txt 2>/dev/null || echo none)"
  tail -25 "$BASE/logs/runtime.log" 2>/dev/null || true
else
  echo "result: FAIL — runtime missing"
  FAIL=1
fi
echo "commands: termugpt | termugpt-status | termugpt-stop | termugpt-logs"
echo "================================================="
[ "$FAIL" -eq 1 ] && exit 1
exit 0
