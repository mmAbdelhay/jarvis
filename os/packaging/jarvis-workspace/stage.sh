#!/usr/bin/env bash
# Stage jarvis-workspace (M4 contracts §5, §6.16): the Jarvis Electron app as
# electron-builder's Linux directory build (not an AppImage), under
# /opt/jarvis-workspace, with a wrapper, launcher entry and icon. Optional:
# never in the ISO package lists.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
stage=$1
src=${WORKSPACE_UNPACKED:-$REPO_ROOT/packages/desktop/release/linux-unpacked}
icon=${WORKSPACE_ICON:-$REPO_ROOT/packages/desktop/assets/icon.png}
if [ ! -x "$src/jarvis" ] || [ ! -d "$src/resources" ]; then
  echo "jarvis-workspace: no Electron directory build at $src" >&2
  echo "  pnpm install --frozen-lockfile --ignore-scripts && pnpm bootstrap" >&2
  echo "  pnpm --filter @jarvis/desktop build" >&2
  echo "  pnpm --filter @jarvis/desktop exec electron-builder --linux dir --x64 --config electron-builder.yml" >&2
  exit 1
fi
dest=$stage/opt/jarvis-workspace
mkdir -p "$dest"
cp -a "$src/." "$dest/"
# musl builds of bundled runtimes link libc.musl, which no Debian package
# provides (dpkg-shlibdeps would fail), and the glibc build is next to them.
find "$dest" -depth -type d -name '*-musl' -exec rm -rf {} +
# No setuid/setgid helper (ruling, plan Task 13): Chromium sandboxes with
# unprivileged user namespaces on Debian; a setuid-root chrome-sandbox would
# be a root binary for every user, for an optional app.
find "$dest" -type f -perm /6000 -exec chmod ug-s {} +
echo opt/jarvis-workspace > "$stage/.shlibs-libdirs"
install -D -m0644 "$here/jarvis-workspace.desktop" "$stage/usr/share/applications/jarvis-workspace.desktop"
install -D -m0644 "$icon" "$stage/usr/share/icons/hicolor/512x512/apps/jarvis-workspace.png"
# Wrapper (contracts §6.16): own config dir, never jarvisd's.
install -D -m0755 "$here/jarvis-workspace" "$stage/usr/bin/jarvis-workspace"
echo zstd > "$stage/.deb-compression"
