#!/data/data/com.termux/files/usr/bin/bash
# ERMI boot entry — placed in ~/.termux/boot/ by installer
# Termux:Boot runs scripts in ~/.termux/boot/ at device boot.
set +e
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BASE="$HOME/sim-exit"

termux-wake-lock 2>/dev/null || true
mkdir -p "$BASE/logs" "$BASE/pids" "$BASE/health" "$HOME/bin" "$HOME/.ssh"

RUNTIME="$BASE/ermi-runtime.sh"
[ -x "$RUNTIME" ] || RUNTIME="$BASE/termugpt.sh"
if [ -x "$RUNTIME" ]; then
  if flock -n "$BASE/pids/runtime.lock" true 2>/dev/null; then
    nohup bash "$RUNTIME" >/dev/null 2>&1 &
  fi
fi

if command -v termux-job-scheduler >/dev/null 2>&1; then
  if [ -x "$BASE/ermi-watchdog.sh" ]; then
    termux-job-scheduler --script "$BASE/ermi-watchdog.sh" \
      --job-id 17001 --period-ms 900000 \
      --network any --battery-not-low false --persisted true 2>/dev/null || true
  fi
  if [ -x "$BASE/ermi-maintain.sh" ]; then
    termux-job-scheduler --script "$BASE/ermi-maintain.sh" \
      --job-id 17002 --period-ms 86400000 \
      --network any --battery-not-low true --persisted true 2>/dev/null || true
  fi
fi

echo "$(date -Is) boot start" >>"$BASE/logs/boot.log"
exit 0
