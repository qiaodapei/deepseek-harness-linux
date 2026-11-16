#!/usr/bin/env bash
# Install (or reinstall) the DeepSeek Harness entry in the desktop application menu.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
entry="$apps_dir/deepseek-harness.desktop"

mkdir -p "$apps_dir"
chmod +x "$root/scripts/desktop-launch.sh"

cat >"$entry" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=DeepSeek Harness
Name[zh_CN]=DeepSeek Harness
GenericName=AI Coding Agent
Comment=DeepSeek Harness desktop client
Comment[zh_CN]=DeepSeek Harness 桌面客户端
Exec=$root/scripts/desktop-launch.sh
Icon=$root/desktop/assets/icon.png
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

echo "Installed: $entry"
echo "Run it from the application menu, or: $root/scripts/desktop-launch.sh"
