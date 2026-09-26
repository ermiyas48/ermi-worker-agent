parse_public() {
  local f="$BASE/logs/pinggy.log"
  local line h
  line=$(grep -oE 'tcp://[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+:[0-9]+' "$f" 2>/dev/null | head -1)
  if [ -n "$line" ]; then
    h="${line#tcp://}"
    if is_valid_public "$h"; then echo "$h"; return 0; fi
  fi
  for pat in \
    '[A-Za-z0-9-]+\.run\.pinggy-free\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.[a-z0-9-]+\.pinggy\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.a\.free\.pinggy\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.a\.pinggy\.link:[0-9]+' \
    '[A-Za-z0-9-]+\.pinggy\.io:[0-9]+' \
    '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+'
  do
    h=$(grep -oE "$pat" "$f" 2>/dev/null | head -1)
    if is_valid_public "$h"; then echo "$h"; return 0; fi
  done
  return 1
}

post_proxy() {
  local hp="$1"
  [ -n "$TOKEN" ] || { log "TOKEN missing — skip Railway update"; return 1; }
  [ -n "$URL" ] || { log "URL missing"; return 1; }
  is_valid_public "$hp" || { log "reject invalid endpoint $hp"; return 1; }
  local body code
  body=$(curl -sS --max-time 25 -w "\n%{http_code}" -X POST "$URL/proxy" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"server\":\"socks5://$hp\"}" 2>&1) || true
  code=$(echo "$body" | tail -1)
  local resp; resp=$(echo "$body" | sed '$d')
  log "POST /proxy http=$code"
  echo "$code" | grep -qE '^20' || { log "Railway HTTP fail code=$code"; return 1; }
  if echo "$resp" | grep -qi '"valid"[[:space:]]*:[[:space:]]*false'; then
    log "Railway rejected proxy (valid:false)"; return 1
  fi
  if echo "$resp" | grep -qi '"ok"[[:space:]]*:[[:space:]]*false'; then
    log "Railway ok:false"; return 1
  fi
  echo "socks5://$hp" >"$BASE/PROXY_SERVER.txt"
  echo "$hp" >"$BASE/last_public.txt"
  date +%s >"$BASE/pids/last_repost.txt"
  date +%s >"$BASE/pids/tunnel_start.txt"
  set_state "RAILWAY_UPDATED" "$hp"
  health_set "last_public_ok" "$(date +%s)"
  log "Railway accepted socks5://$hp"
  return 0
}

public_exit_ip() {
  local hp="$1"
  is_valid_public "$hp" || return 1
  curl -4 -fsS --max-time 18 --proxy "socks5h://$hp" https://api.ipify.org 2>/dev/null
}

public_ok() {
  local hp
  [ -f "$BASE/last_public.txt" ] || return 1
  hp=$(cat "$BASE/last_public.txt")
  is_valid_public "$hp" || return 1
  local ip; ip=$(public_exit_ip "$hp") || return 1
  [ -n "$ip" ] || return 1
  echo "$ip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || return 1
  return 0
}

start_pinggy() {
  set_state "TUNNEL_STARTING"
  kill_ermi_pinggy
  sleep 1
  : >"$BASE/logs/pinggy.log"
  ensure_socks || log "warning: starting Pinggy with weak SOCKS"
  export DISPLAY=:999
  export SSH_ASKPASS_REQUIRE=force
  export SSH_ASKPASS="$BASE/askpass.sh"
  setsid ssh -tt -p 443 -R0:127.0.0.1:${SOCKS_PORT} \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=20 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o PreferredAuthentications=password \
    -o PubkeyAuthentication=no \
    -o NumberOfPasswordPrompts=1 \
    -o ConnectTimeout=30 \
    "$PINGGY_USER" >>"$BASE/logs/pinggy.log" 2>&1 </dev/null &
  local SPID=$!
  echo "$SPID" >"$BASE/pids/pinggy.pid"
  log "pinggy ssh pid=$SPID"
  local PUBLIC="" i=0
  while [ "$i" -lt 75 ]; do
    i=$((i + 1)); sleep 1
    PUBLIC=$(parse_public || true)
    if [ -n "$PUBLIC" ]; then
      set_state "PUBLIC_ENDPOINT_FOUND" "$PUBLIC"
      log "tunnel endpoint=$PUBLIC"
      local exit_ip="" j=0
      while [ "$j" -lt 8 ]; do
        j=$((j + 1))
        exit_ip=$(public_exit_ip "$PUBLIC" || true)
        if [ -n "$exit_ip" ] && echo "$exit_ip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
          set_state "PUBLIC_ENDPOINT_VERIFIED" "$PUBLIC ip=$exit_ip"
          log "e2e OK exit_ip=$exit_ip"
          echo "$PUBLIC" >"$BASE/last_public.txt"
          date +%s >"$BASE/pids/tunnel_start.txt"
          if post_proxy "$PUBLIC"; then
            set_state "ACTIVE" "$PUBLIC"
            health_set "railway_ok" "$(date +%s)"
            return 0
          else
            log "e2e ok but Railway /proxy failed — DEGRADED, keep tunnel, retry later"
            set_state "DEGRADED" "railway_pending $PUBLIC"
            date +%s >"$BASE/pids/railway_retry.txt"
            return 0
          fi
        fi
        sleep 2
      done
      log "endpoint found but e2e failed"
      echo "$PUBLIC" >"$BASE/last_public.txt"
      set_state "DEGRADED" "e2e_fail"
      return 1
    fi
  done
  log "no public url after 75s"
  set_state "DEGRADED" "no_endpoint"
  return 1
}

tunnel_age_secs() {
  if [ -f "$BASE/pids/tunnel_start.txt" ]; then
    local start now
    start=$(cat "$BASE/pids/tunnel_start.txt" 2>/dev/null || echo 0)
    now=$(date +%s)
    echo $((now - start))
  else echo 99999; fi
}

ensure_sshd
ensure_socks
start_pinggy || true

while true; do
  if [ -f "$BASE/pids/maintenance.lock" ] && ! flock -n "$BASE/pids/maintenance.lock" true 2>/dev/null; then
    sleep 25
    continue
  fi
  if ! socks_ok; then
    set_state "RECOVERING" "socks"
    log "local SOCKS down — restart"
    ensure_socks || true
  fi
  PID=$(cat "$BASE/pids/pinggy.pid" 2>/dev/null || true)
  NEED_RESTART=0
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    log "pinggy process dead"; NEED_RESTART=1
  elif ! public_ok; then
    log "public path dead or e2e fail"; NEED_RESTART=1
    set_state "DEGRADED" "public_dead"
  else
    age=$(tunnel_age_secs)
    jitter=$((RANDOM % 240 - 120))
    limit=$((ROTATE_SECS + jitter))
    if [ "$age" -ge "$limit" ]; then
      log "proactive rotate age=${age}s limit=${limit}s"
      NEED_RESTART=1
    fi
  fi
  if [ "$NEED_RESTART" -eq 1 ]; then
    set_state "RECOVERING" "tunnel"
    start_pinggy || true
  fi
  st_now=$(cat "$STATE_FILE" 2>/dev/null || echo "")
  if [ -f "$BASE/last_public.txt" ] && public_ok; then
    now=$(date +%s)
    hp=$(cat "$BASE/last_public.txt")
    if [ "$st_now" = "ACTIVE" ]; then
      last=$(cat "$BASE/pids/last_repost.txt" 2>/dev/null || echo 0)
      if [ $((now - last)) -ge 300 ]; then
        post_proxy "$hp" || true
      fi
    elif [ "$st_now" = "DEGRADED" ] || [ "$st_now" = "PUBLIC_ENDPOINT_VERIFIED" ] || [ "$st_now" = "RAILWAY_UPDATED" ]; then
      last_try=$(cat "$BASE/pids/railway_retry.txt" 2>/dev/null || echo 0)
      tries=$(cat "$BASE/pids/railway_tries.txt" 2>/dev/null || echo 0)
      case "$tries" in
        0) wait_s=30 ;;
        1) wait_s=60 ;;
        2) wait_s=120 ;;
        *) wait_s=180 ;;
      esac
      if [ $((now - last_try)) -ge "$wait_s" ]; then
        log "Railway retry try=$((tries+1)) wait was ${wait_s}s"
        date +%s >"$BASE/pids/railway_retry.txt"
        if post_proxy "$hp"; then
          set_state "ACTIVE" "$hp"
          echo 0 >"$BASE/pids/railway_tries.txt"
          health_set "railway_ok" "$now"
          log "Railway recovered — ACTIVE"
        else
          echo $((tries + 1)) >"$BASE/pids/railway_tries.txt"
          set_state "DEGRADED" "railway_retry_fail"
        fi
      fi
    fi
  fi
  sleep 25
done
