#!/usr/bin/env bash
# jarvis-workspace (M4 contracts §5, §6.16) from a fake electron-builder directory build.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
u=$tmp/linux-unpacked
sdk=$u/resources/app.asar.unpacked/node_modules/@anthropic-ai
mkdir -p "$u/locales" "$u/resources/app.asar.unpacked/node_modules/node-pty/build/Release" \
  "$sdk/claude-agent-sdk-linux-x64" "$sdk/claude-agent-sdk-linux-x64-musl"
install -m0755 /bin/true "$u/jarvis"
install -m0755 /bin/true "$u/chrome-sandbox"
chmod 4755 "$u/chrome-sandbox"
install -m0644 /bin/true "$u/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node"
install -m0755 /bin/true "$sdk/claude-agent-sdk-linux-x64/claude"
install -m0755 /bin/true "$sdk/claude-agent-sdk-linux-x64-musl/claude"
echo asar > "$u/resources/app.asar"
printf 'png' > "$tmp/icon.png"
WORKSPACE_UNPACKED=$u WORKSPACE_ICON=$tmp/icon.png "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-workspace >/dev/null
deb=$tmp/out/jarvis-workspace_${OS_VERSION}_amd64.deb
list=$(deb_list "$deb")
check "app under /opt/jarvis-workspace (contracts §5)" test "$(deb_mode "$deb" opt/jarvis-workspace/jarvis)" = -rwxr-xr-x
check "a directory build, not an AppImage" deb_has "$deb" opt/jarvis-workspace/resources/app.asar
check "no setuid or setgid file anywhere (chrome-sandbox included)" test -z "$(awk '$1 ~ /[sS]/' <<<"$list")"
check "musl runtimes removed (no Debian library provides libc.musl)" bash -c '! grep -q musl <<<"$1"' _ "$list"
check "glibc agent runtime kept" grep -q 'claude-agent-sdk-linux-x64/claude' <<<"$list"
check "launcher is an executable wrapper (contracts §6.16)" test "$(deb_mode "$deb" usr/bin/jarvis-workspace)" = -rwxr-xr-x
wrap=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/bin/jarvis-workspace)
check "wrapper sets its own JARVIS_CONFIG_DIR" grep -q 'jarvis-workspace$' <<<"$wrap"
check "wrapper execs the app" grep -qx 'exec /opt/jarvis-workspace/jarvis "\$@"' <<<"$wrap"
check "icon" deb_has "$deb" usr/share/icons/hicolor/512x512/apps/jarvis-workspace.png
desk=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/share/applications/jarvis-workspace.desktop)
check "desktop entry runs the wrapper" grep -qx 'Exec=/usr/bin/jarvis-workspace --ozone-platform-hint=auto %U' <<<"$desk"
check "desktop entry has an Arabic name" grep -qx 'Name\[ar\]=مساحة عمل جارفيس' <<<"$desk"
deps=$(deb_field "$deb" Depends)
check "Depends xdg-utils" grep -qw xdg-utils <<<"$deps"
check "Depends from the bundled ELF files (shlibs)" grep -qw libc6 <<<"$deps"
check "Depends is unversioned (nothing pins it to the build)" bash -c '! grep -q "(=" <<<"$1"' _ "$deps"
check "Recommends git" grep -qw git <<<"$(deb_field "$deb" Recommends)"
check "zstd data" grep -qx 'data.tar.zst' <<<"$(ar t "$deb")"
if command -v desktop-file-validate >/dev/null; then
  printf '%s\n' "$desk" > "$tmp/w.desktop"
  check "desktop-file-validate" desktop-file-validate "$tmp/w.desktop"
fi
err=$(WORKSPACE_UNPACKED=$tmp/nowhere "$PACKAGING_DIR/build.sh" --out "$tmp/o2" jarvis-workspace 2>&1 || true)
check "a missing build names the electron-builder command" grep -q 'electron-builder --linux dir' <<<"$err"
finish
