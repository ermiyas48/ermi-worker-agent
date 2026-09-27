#!/usr/bin/env bash
set -euo pipefail

if [[ "${HEADLESS:-true}" == "false" ]]; then
  if ! command -v Xvfb >/dev/null 2>&1; then
    echo "ERROR: Xvfb is not installed in the runtime image" >&2
    exit 1
  fi

  export DISPLAY="${DISPLAY:-:99}"
  rm -f "/tmp/.X99-lock" || true
  Xvfb "${DISPLAY}" -screen 0 1280x720x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!

  cleanup() {
    kill "${XVFB_PID}" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT INT TERM

  for _ in $(seq 1 50); do
    if kill -0 "${XVFB_PID}" >/dev/null 2>&1 && [[ -S /tmp/.X11-unix/X99 ]]; then
      break
    fi
    sleep 0.1
  done

  if ! kill -0 "${XVFB_PID}" >/dev/null 2>&1; then
    echo "ERROR: Xvfb exited during startup" >&2
    cat /tmp/xvfb.log >&2 || true
    exit 1
  fi

  echo "Xvfb ready on DISPLAY=${DISPLAY}"
fi

exec node src/server.js
