#!/usr/bin/env bash
# Launch the DeepSeek Harness desktop shell from an application menu shortcut.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/deepseek-harness"
mkdir -p "$state_dir"

export PATH="$root/node_modules/.bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
cd "$root"

exec "$root/node_modules/.bin/electron" "$root/desktop/main.mjs" >>"$state_dir/desktop.log" 2>&1
