#!/data/data/com.termux/files/usr/bin/bash
# One-shot install for ERMI termugpt
set -e
export HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
pkg install -y openssh curl which 2>/dev/null || true
mkdir -p "$HOME/sim-exit/logs" "$HOME/sim-exit/pids" "$HOME/.ssh" "$HOME/bin" "$PREFIX/etc/ssh"

if [ ! -f "$HOME/sim-exit/config.env" ]; then
  cat >"$HOME/sim-exit/config.env" << EOF
TOKEN=cacfafa2f5665416049ef7dbe94b795908fb4a004b438e6c7aa22945f78bc8b2
URL=https://ermi-worker-agent-production.up.railway.app
PINGGY_USER=tcp@free.pinggy.io
EOF
fi

if [ ! -f "$HOME/.ssh/id_ermi" ]; then
  ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ermi" -N "" -q
fi
chmod 700 "$HOME/.ssh"
grep -qf "$HOME/.ssh/id_ermi.pub" "$HOME/.ssh/authorized_keys" 2>/dev/null || cat "$HOME/.ssh/id_ermi.pub" >>"$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys" "$HOME/.ssh/id_ermi"

if [ ! -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" ]; then
  ssh-keygen -t ed25519 -f "$PREFIX/etc/ssh/ssh_host_ed25519_key" -N "" -q
fi
cat >"$PREFIX/etc/ssh/sshd_config" << EOF
Port 8022
HostKey $PREFIX/etc/ssh/ssh_host_ed25519_key
PubkeyAuthentication yes
PasswordAuthentication no
AuthorizedKeysFile $HOME/.ssh/authorized_keys
AllowTcpForwarding yes
PidFile $HOME/sim-exit/pids/sshd.pid
EOF

# Fetch latest supervisor from GitHub raw if network works, else embed path
SCRIPT_SRC="$HOME/sim-exit/termugpt.sh"
if [ -f /data/data/com.termux/files/home/sim-exit/termugpt.sh.new ]; then
  mv /data/data/com.termux/files/home/sim-exit/termugpt.sh.new "$SCRIPT_SRC"
fi
chmod +x "$SCRIPT_SRC" 2>/dev/null || true

cat >"$HOME/bin/termugpt" << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock 2>/dev/null || true
if pgrep -f "sim-exit/termugpt.sh" >/dev/null 2>&1; then
  echo "already running"
  cat "$HOME/sim-exit/PROXY_SERVER.txt" 2>/dev/null
  exit 0
fi
nohup bash "$HOME/sim-exit/termugpt.sh" >/dev/null 2>&1 &
echo "started pid $!"
sleep 45
cat "$HOME/sim-exit/PROXY_SERVER.txt" 2>/dev/null || echo "waiting for tunnel — tail -f $HOME/sim-exit/logs/supervisor.log"
EOF
chmod +x "$HOME/bin/termugpt"

cat >"$HOME/bin/termugpt-stop" << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
pkill -f "sim-exit/termugpt.sh" 2>/dev/null || true
pkill -f "ssh -D 127.0.0.1:1080" 2>/dev/null || true
pkill -f "free.pinggy.io" 2>/dev/null || true
pkill -f "pro.pinggy.io" 2>/dev/null || true
termux-wake-unlock 2>/dev/null || true
echo stopped
EOF
chmod +x "$HOME/bin/termugpt-stop"

cat >"$HOME/bin/termugpt-status" << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
pgrep -af "sim-exit/termugpt.sh" || echo "supervisor: not running"
[ -f "$HOME/sim-exit/PROXY_SERVER.txt" ] && echo "proxy: $(cat $HOME/sim-exit/PROXY_SERVER.txt)"
tail -15 "$HOME/sim-exit/logs/supervisor.log" 2>/dev/null
EOF
chmod +x "$HOME/bin/termugpt-status"

cat >"$HOME/bin/termugpt-logs" << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
tail -f "$HOME/sim-exit/logs/supervisor.log"
EOF
chmod +x "$HOME/bin/termugpt-logs"

grep -q 'HOME/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >>"$HOME/.bashrc"
export PATH="$HOME/bin:$PATH"
echo "Installed. Run: termugpt"
