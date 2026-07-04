#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$ROOT/apps/daemon/target/release/favorsd"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [[ ! -x "$BINARY" ]]; then
  echo "Missing $BINARY"
  echo "Run: npm run build"
  exit 1
fi

mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/favors.socket" <<UNIT
[Unit]
Description=Favors local HTTP socket

[Socket]
ListenStream=127.0.0.1:8123
NoDelay=true

[Install]
WantedBy=sockets.target
UNIT

cat > "$UNIT_DIR/favors.service" <<UNIT
[Unit]
Description=Favors local daemon
Requires=favors.socket

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$BINARY
Environment=FAVORS_ROOT=$ROOT
Environment=FAVORS_IDLE_SECONDS=300
NoNewPrivileges=true
PrivateTmp=true
UNIT

systemctl --user daemon-reload
systemctl --user enable --now favors.socket
systemctl --user stop favors.service >/dev/null 2>&1 || true

echo "Favors socket is active at http://127.0.0.1:8123"
echo "Daemon will start on demand and exit after 300 idle seconds."
