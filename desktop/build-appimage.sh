#!/usr/bin/env bash
# Build the self-contained Linux AppImage.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

bash desktop/prepare-runtime.sh

export PATH="$root/node_modules/.bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
exec electron-builder --linux AppImage --x64 \
  --config desktop/electron-builder.config.mjs "$@"
