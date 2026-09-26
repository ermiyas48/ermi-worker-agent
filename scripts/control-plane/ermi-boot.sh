#!/data/data/com.termux/files/usr/bin/bash
# ERMI boot entry — placed in ~/.termux/boot/ by installer
# Termux:Boot runs scripts in ~/.termux/boot/ at device boot.
set +e
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"
BASE="$HOME/sim-exit"

# 1. wake lock
termux-wake-lock 2>/dev/null || true

# 2. repair environment (minimal)
mkdir -p "$BASE/logs" "$BASE/pids" "$BASE/health" "$HOME/bin" "$HOME/.ssh"

# 3. start runtime
RUNTIME="$BASE/ermi-runtime.sh"
[ -x "$RUNTIME" ] || RUNTIME="$BASE/termugpt.sh"
if [ -x "$RUNTIME" ]; then
  nohup bash "$RUNTIME" >/dev/null 2>&1 &
fi

# 4. schedule watchdog if possible
if command -v termux-job-scheduler >/dev/null 2>&1 && [ -x "$BASE/ermi-watchdog.sh" ]; then
  termux-job-scheduler -s "$BASE/ermi-watchdog.sh" --period 900 --network any --battery-not-low false 2>/dev/null || true
fi

# 5. leave a marker
echo "$(date -Is) boot start" >>"$BASE/logs/boot.log"
exit 0
