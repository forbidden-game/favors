#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

systemctl --user disable --now favors.socket >/dev/null 2>&1 || true
systemctl --user stop favors.service >/dev/null 2>&1 || true

rm -f "$UNIT_DIR/favors.socket" "$UNIT_DIR/favors.service"
systemctl --user daemon-reload

echo "Favors systemd user socket and service were removed."
