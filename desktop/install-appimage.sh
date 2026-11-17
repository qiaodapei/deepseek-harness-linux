#!/usr/bin/env bash
# Install (or reinstall) a DeepSeek Harness AppImage in the desktop application menu.
#
# Usage:
#   desktop/install-appimage.sh [/path/to/DeepSeek-Harness-<version>-x86_64.AppImage]
#
# Without an argument, the newest AppImage in ~/Applications, dist-desktop/ or the
# repository root is used. The desktop entry points at the icon by absolute path so
# GNOME Shell does not depend on the hicolor theme cache (a missing cache is what
# makes an application show a generic gear icon).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

appimage="${1:-}"
if [ -z "$appimage" ]; then
  for dir in "$HOME/Applications" "$root/dist-desktop" "$root"; do
    [ -d "$dir" ] || continue
    candidate="$(
      find "$dir" -maxdepth 1 -type f -name 'DeepSeek-Harness-*-x86_64.AppImage' \
        -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-
    )"
    if [ -n "$candidate" ]; then
      appimage="$candidate"
      break
    fi
  done
fi

if [ -z "$appimage" ]; then
  echo "Usage: $0 /path/to/DeepSeek-Harness-<version>-x86_64.AppImage" >&2
  exit 1
fi

appimage="$(readlink -f "$appimage")"
[ -f "$appimage" ] || {
  echo "AppImage not found: $appimage" >&2
  exit 1
}
chmod +x "$appimage"

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
apps_dir="$data_home/applications"
icons_root="$data_home/icons/hicolor"
entry="$apps_dir/deepseek-harness.desktop"
icon="$icons_root/512x512/apps/deepseek-harness.png"
src="$root/desktop/assets/icon-512.png"

mkdir -p "$apps_dir"

# Install several sizes so the icon looks right in menus, the dock and the app grid.
# A user-level hicolor/index.theme is deliberately not created: it would shadow the
# system theme index. Without a cache GTK/GNOME simply scans the icon directories.
if [ -f "$src" ]; then
  sizes="16 22 24 32 36 48 64 72 96 128 192 256 512"
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import PIL' >/dev/null 2>&1; then
    for size in $sizes; do
      dir="$icons_root/${size}x${size}/apps"
      mkdir -p "$dir"
      python3 - "$src" "$dir/deepseek-harness.png" "$size" <<'PY'
import sys
from PIL import Image

src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
Image.open(src).convert('RGBA').resize((size, size), Image.LANCZOS).save(
    dst, 'PNG', optimize=True
)
PY
    done
  elif command -v convert >/dev/null 2>&1; then
    for size in $sizes; do
      dir="$icons_root/${size}x${size}/apps"
      mkdir -p "$dir"
      convert "$src" -resize "${size}x${size}" "$dir/deepseek-harness.png"
    done
  else
    mkdir -p "$(dirname "$icon")"
    cp "$src" "$icon"
  fi
fi

[ -f "$icon" ] || {
  echo "Icon not found: $icon" >&2
  echo "Run this script from the repository checkout, or install the icon manually." >&2
  exit 1
}

cat >"$entry" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=DeepSeek Harness
Name[zh_CN]=DeepSeek Harness
GenericName=AI Coding Agent
Comment=DeepSeek Harness desktop client
Comment[zh_CN]=DeepSeek Harness 桌面客户端
Exec=$appimage
TryExec=$appimage
Icon=$icon
Terminal=false
Categories=Development;
Keywords=deepseek;harness;dsh;ai;agent;
StartupNotify=true
StartupWMClass=deepseek-harness
EOF

chmod +x "$entry"

if command -v gio >/dev/null 2>&1; then
  gio set "$entry" metadata::trusted true 2>/dev/null || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
fi

if [ -f "$icons_root/index.theme" ] && command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$icons_root" >/dev/null 2>&1 || true
fi

echo "Installed: $entry"
echo "Icon:      $icon"
echo "AppImage:  $appimage"
echo
echo "If the dock still shows a stale icon, log out and back in once to refresh"
echo "GNOME Shell's in-memory icon cache."
