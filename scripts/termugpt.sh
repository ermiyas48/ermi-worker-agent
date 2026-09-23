#!/data/data/com.termux/files/usr/bin/bash
# ERMI termugpt — keep Pinggy alive and POST valid /proxy updates
set +m
HOME="${HOME:-/data/data/com.termux/files/home}"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
BASE="$HOME/sim-exit"
mkdir -p "$BASE/logs" "$BASE/pids" "$HOME/.ssh"
# shellcheck disable=SC1091
[ -f "$BASE/config.env" ] && . "$BASE/config.env"
TOKEN="${TOKEN:-}"
URL="${URL:-https://ermi-worker-agent-production.up.railway.app}"
exec >>"$BASE/logs/supervisor.log" 2>&1
echo "$(date -Is) supervisor start"
termux-wake-lock 2>/dev/null || true

sshd 2>/dev/null || true
sleep 1
pkill -f "ssh -D 127.0.0.1:1080" 2>/dev/null || true
sleep 1
ssh -D 127.0.0.1:1080 -N -i "$HOME/.ssh/id_ermi" -p 8022 \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o IdentitiesOnly=yes -o BatchMode=yes -o ServerAliveInterval=30 \
  127.0.0.1 >>"$BASE/logs/socks.log" 2>&1 &
echo $! >"$BASE/pids/socks.pid"

while true; do
  echo "$(date -Is) starting pinggy"
  pkill -f "tcp@free.pinggy.io" 2>/dev/null || true
  sleep 1
  : >"$BASE/logs/pinggy.log"
  # Empty password via SSH_ASKPASS for unattended free Pinggy
  export DISPLAY=:0
  export SSH_ASKPASS_REQUIRE=force
  export SSH_ASKPASS="$BASE/askpass.sh"
  printf '%s\n' '#!/data/data/com.termux/files/usr/bin/bash' 'echo ""' >"$BASE/askpass.sh"
  chmod 700 "$BASE/askpass.sh"

  ssh -p 443 -R0:127.0.0.1:1080 \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o PreferredAuthentications=password \
    -o PubkeyAuthentication=no \
    -o NumberOfPasswordPrompts=1 \
    tcp@free.pinggy.io >>"$BASE/logs/pinggy.log" 2>&1 &
  SPID=$!
  echo $SPID >"$BASE/pids/pinggy.pid"

  PUBLIC=""
  i=0
  while [ "$i" -lt 50 ]; do
    i=$((i+1))
    sleep 1
    PUBLIC=$(grep -oE 'tcp://[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+:[0-9]+' "$BASE/logs/pinggy.log" 2>/dev/null | head -1 | sed 's#tcp://##')
    [ -n "$PUBLIC" ] && break
    PUBLIC=$(grep -oE '[A-Za-z0-9-]+\.run\.pinggy-free\.link:[0-9]+' "$BASE/logs/pinggy.log" 2>/dev/null | head -1)
    [ -n "$PUBLIC" ] && break
  done

  case "$PUBLIC" in
    ""|free.pinggy.io*|*"]"*|localhost*|127.0.0.1*) PUBLIC="" ;;
  esac

  if [ -n "$PUBLIC" ] && [ -n "$TOKEN" ]; then
    echo "$(date -Is) tunnel=$PUBLIC"
    code=$(curl -sS -o "$BASE/logs/proxy_post.json" -w "%{http_code}" --max-time 25 \
      -X POST "$URL/proxy" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"server\":\"socks5://$PUBLIC\"}" || echo 000)
    echo "$(date -Is) post_http=$code"
    echo "socks5://$PUBLIC" >"$BASE/PROXY_SERVER.txt"
  else
    echo "$(date -Is) no valid public endpoint"
    tail -20 "$BASE/logs/pinggy.log" || true
  fi

  while kill -0 "$SPID" 2>/dev/null; do sleep 20; done
  echo "$(date -Is) pinggy died; restart in 5s"
  sleep 5
done
