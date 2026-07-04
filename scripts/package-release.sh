#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)}"
STAGE="$ROOT/dist/packages/favors-$TARGET"
ARCHIVE_DIR="$ROOT/dist"

case "$TARGET" in
  *windows*|*win*) BIN_NAME="favorsd.exe" ;;
  *) BIN_NAME="favorsd" ;;
esac

BIN_SRC="$ROOT/apps/daemon/target/release/$BIN_NAME"
if [[ ! -x "$BIN_SRC" && ! -f "$BIN_SRC" ]]; then
  echo "Missing $BIN_SRC"
  echo "Run: npm run build"
  exit 1
fi

if [[ ! -f "$ROOT/apps/web/dist/index.html" ]]; then
  echo "Missing apps/web/dist/index.html"
  echo "Run: npm run build:web"
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/web" "$STAGE/extension" "$STAGE/scripts" "$ARCHIVE_DIR"

cp "$BIN_SRC" "$STAGE/bin/$BIN_NAME"
cp -R "$ROOT/apps/web/dist/." "$STAGE/web/"
cp -R "$ROOT/apps/extension/." "$STAGE/extension/"
cp "$ROOT/scripts/install.sh" "$STAGE/scripts/install.sh"
cp "$ROOT/scripts/install.ps1" "$STAGE/scripts/install.ps1"

cat > "$STAGE/README.txt" <<README
Favors release package

Linux/macOS:
  ./scripts/install.sh

Windows PowerShell:
  .\\scripts\\install.ps1

Chrome extension path after extraction:
  extension/
README

if [[ "$BIN_NAME" == "favorsd.exe" ]]; then
  if command -v zip >/dev/null 2>&1; then
    (cd "$ROOT/dist/packages" && zip -qr "$ARCHIVE_DIR/favors-$TARGET.zip" "favors-$TARGET")
  elif command -v powershell.exe >/dev/null 2>&1; then
    stage_path="$STAGE"
    archive_path="$ARCHIVE_DIR/favors-$TARGET.zip"
    if command -v cygpath >/dev/null 2>&1; then
      stage_path="$(cygpath -w "$stage_path")"
      archive_path="$(cygpath -w "$archive_path")"
    fi
    powershell.exe -NoProfile -Command \
      "Compress-Archive -Path '$stage_path' -DestinationPath '$archive_path' -Force"
  else
    echo "Missing zip or PowerShell Compress-Archive"
    exit 1
  fi
  echo "$ARCHIVE_DIR/favors-$TARGET.zip"
else
  tar -C "$ROOT/dist/packages" -czf "$ARCHIVE_DIR/favors-$TARGET.tar.gz" "favors-$TARGET"
  echo "$ARCHIVE_DIR/favors-$TARGET.tar.gz"
fi
