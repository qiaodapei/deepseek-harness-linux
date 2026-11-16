#!/usr/bin/env bash
# Stage a self-contained dsh runtime for the AppImage build.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime="$root/runtime"

if [[ ! -x /usr/bin/node ]]; then
  echo "error: /usr/bin/node is required to bundle the runtime" >&2
  exit 1
fi

echo "Preparing runtime in $runtime ..."
rm -rf "$runtime"
mkdir -p "$runtime/app" "$runtime/node/bin"

# Node runtime (keeps the ABI used by the native modules in node_modules).
install -m 0755 /usr/bin/node "$runtime/node/bin/node"
cp -a "$root/bin" "$runtime/app/bin"

# Copy the dsh installation but drop Electron and the packaging toolchain.
tar -C "$root" -cf - \
  --exclude='node_modules/electron' \
  --exclude='node_modules/electron-winstaller' \
  --exclude='node_modules/electron-builder' \
  --exclude='node_modules/electron-builder-squirrel-windows' \
  --exclude='node_modules/electron-publish' \
  --exclude='node_modules/app-builder-lib' \
  --exclude='node_modules/app-builder-bin' \
  --exclude='node_modules/builder-util' \
  --exclude='node_modules/builder-util-runtime' \
  --exclude='node_modules/dmg-builder' \
  --exclude='node_modules/@electron' \
  --exclude='node_modules/@electron-internal' \
  --exclude='node_modules/.bin/electron' \
  --exclude='node_modules/.bin/electron-builder' \
  --exclude='node_modules/.bin/electron-winstaller' \
  node_modules | tar -C "$runtime/app" -xf -

# Smoke-check the staged runtime before the (slow) AppImage compression.
runtime_version="$(PATH="$runtime/node/bin:$PATH" "$runtime/node/bin/node" \
  "$runtime/app/node_modules/@deepseek-ai/dsh/lib/bin.js" --version)"
expected_version="$(/usr/bin/node -e \
  "process.stdout.write(require('$root/package.json').devDependencies['@deepseek-ai/dsh'])")"
echo "Bundled dsh: $runtime_version"

if [[ "$runtime_version" != "$expected_version" ]]; then
  echo "warning: bundled dsh version ($runtime_version) differs from the pinned $expected_version" >&2
fi

du -sh "$runtime"
