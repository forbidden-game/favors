#!/usr/bin/env bash
set -euo pipefail

REPO="forbidden-game/favors"
APP_NAME="favors"

os_name() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "macos" ;;
    *) echo "unsupported" ;;
  esac
}

arch_name() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) echo "unknown" ;;
  esac
}

download() {
  local url="$1"
  local out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
  else
    echo "Missing curl or wget"
    exit 1
  fi
}

source_dir() {
  local script_dir root
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(cd "$script_dir/.." && pwd)"
  if [[ -x "$root/bin/favorsd" && -f "$root/web/index.html" ]]; then
    echo "$root"
    return
  fi

  local os arch asset tmp archive
  os="$(os_name)"
  arch="$(arch_name)"
  if [[ "$os" == "unsupported" || "$arch" == "unknown" ]]; then
    echo "Unsupported platform: $(uname -s) $(uname -m)" >&2
    exit 1
  fi

  tmp="$(mktemp -d)"
  archive="${FAVORS_PACKAGE:-$tmp/favors-$os-$arch.tar.gz}"
  if [[ -z "${FAVORS_PACKAGE:-}" ]]; then
    asset="https://github.com/$REPO/releases/latest/download/favors-$os-$arch.tar.gz"
    download "$asset" "$archive"
  fi
  tar -xzf "$archive" -C "$tmp"
  find "$tmp" -maxdepth 1 -type d -name 'favors-*' | head -1
}

install_files() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest/data"
  if [[ "$(cd "$src" && pwd)" == "$(cd "$dest" && pwd)" ]]; then
    return
  fi
  rm -rf "$dest/bin" "$dest/web" "$dest/extension" "$dest/scripts"
  cp -R "$src/bin" "$dest/bin"
  cp -R "$src/web" "$dest/web"
  cp -R "$src/extension" "$dest/extension"
  cp -R "$src/scripts" "$dest/scripts"
}

install_linux() {
  local dest="$1"
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"

  cat > "$unit_dir/favors.socket" <<UNIT
[Unit]
Description=Favors local HTTP socket

[Socket]
ListenStream=127.0.0.1:8123
NoDelay=true

[Install]
WantedBy=sockets.target
UNIT

  cat > "$unit_dir/favors.service" <<UNIT
[Unit]
Description=Favors local daemon
Requires=favors.socket

[Service]
Type=simple
WorkingDirectory=$dest
ExecStart=$dest/bin/favorsd
Environment=FAVORS_ROOT=$dest
Environment=FAVORS_WEB_DIR=$dest/web
Environment=FAVORS_DATA_DIR=$dest/data
Environment=FAVORS_IDLE_SECONDS=300
NoNewPrivileges=true
PrivateTmp=true
UNIT

  systemctl --user stop favors.service >/dev/null 2>&1 || true
  systemctl --user daemon-reload
  systemctl --user enable favors.socket >/dev/null
  systemctl --user restart favors.socket
}

install_macos() {
  local dest="$1"
  local agent_dir="$HOME/Library/LaunchAgents"
  local plist="$agent_dir/com.favors.local.plist"
  mkdir -p "$agent_dir"

  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.favors.local</string>
  <key>ProgramArguments</key>
  <array>
    <string>$dest/bin/favorsd</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$dest</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FAVORS_ROOT</key>
    <string>$dest</string>
    <key>FAVORS_WEB_DIR</key>
    <string>$dest/web</string>
    <key>FAVORS_DATA_DIR</key>
    <string>$dest/data</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
PLIST

  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist"
}

OS="$(os_name)"
SRC="$(source_dir)"
case "$OS" in
  linux) DEST="${FAVORS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/$APP_NAME}" ;;
  macos) DEST="${FAVORS_HOME:-$HOME/Library/Application Support/Favors}" ;;
  *) echo "Unsupported platform: $(uname -s)"; exit 1 ;;
esac

case "$OS" in
  linux) systemctl --user stop favors.service >/dev/null 2>&1 || true ;;
  macos)
    launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.favors.local.plist" >/dev/null 2>&1 || true
    pkill -f "$DEST/bin/favorsd" >/dev/null 2>&1 || true
    ;;
esac

install_files "$SRC" "$DEST"
case "$OS" in
  linux) install_linux "$DEST" ;;
  macos) install_macos "$DEST" ;;
esac

echo "Favors installed in $DEST"
echo "Open http://127.0.0.1:8123"
echo "Chrome extension path: $DEST/extension"
