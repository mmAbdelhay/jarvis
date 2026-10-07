#!/usr/bin/env bash
# jarvis-shell from a tiny CMake project standing in for os/shell.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT

if ! command -v cmake >/dev/null || ! command -v cc >/dev/null; then
  echo "SKIP test-shell.sh: needs cmake and a C compiler (TRIXIE_PACKAGES=\"cmake gcc\")" >&2
  exit 1
fi

src=$tmp/src
mkdir -p "$src/labwc"
cat > "$src/CMakeLists.txt" <<'EOF'
cmake_minimum_required(VERSION 3.20)
project(fake_shell C)
add_executable(jarvis-shell main.c)
install(TARGETS jarvis-shell RUNTIME DESTINATION bin)
install(FILES labwc/rc.xml labwc/autostart DESTINATION share/jarvis-shell/labwc)
EOF
echo 'int main(void) { return 0; }' > "$src/main.c"
echo '<labwc_config/>' > "$src/labwc/rc.xml"
echo '(while true; do jarvis-shell; sleep 1; done) &' > "$src/labwc/autostart"
cmake -S "$src" -B "$tmp/build" -DCMAKE_INSTALL_PREFIX=/usr >/dev/null
cmake --build "$tmp/build" >/dev/null
# Stand-in for os/shell/deps/debian-runtime.txt (Plan C owns the real one).
printf '# Runtime packages\nqt6-wayland\nlayer-shell-qt\nqml6-module-qtquick-shapes\nfonts-ibm-plex\nfoot\n' > "$tmp/runtime.txt"

shell_build() { # shell_build OUTDIR [env assignments...]
  local outdir=$1; shift
  env SHELL_BUILD_DIR="$tmp/build" SHELL_RUNTIME_DEPS="$tmp/runtime.txt" "$@" \
    "$PACKAGING_DIR/build.sh" --out "$outdir" jarvis-shell
}
shell_build "$tmp/out" >/dev/null
deb=$tmp/out/jarvis-shell_${OS_VERSION}_amd64.deb
deps=$(deb_field "$deb" Depends)

check "binary at /usr/bin/jarvis-shell" deb_has "$deb" usr/bin/jarvis-shell
check "binary executable" test "$(deb_mode "$deb" usr/bin/jarvis-shell)" = "-rwxr-xr-x"
check "labwc keybinds shipped" deb_has "$deb" usr/share/jarvis-shell/labwc/rc.xml
check "relaunch loop shipped" deb_has "$deb" usr/share/jarvis-shell/labwc/autostart
check "needs the same-version jarvisd" grep -qF "jarvisd (= $OS_VERSION)" <<<"$deps"
for p in qt6-wayland layer-shell-qt qml6-module-qtquick-shapes fonts-ibm-plex foot; do
  check "Depends has C's runtime package $p" grep -qw -- "$p" <<<"$deps"
done
check "shlibs computed" grep -q 'libc6' <<<"$deps"

err=$(shell_build "$tmp/out-nolist" SHELL_RUNTIME_DEPS="$tmp/missing.txt" 2>&1 || true)
check "missing runtime list fails" grep -q 'debian-runtime.txt' <<<"$err"

err=$(shell_build "$tmp/out2" SHELL_BUILD_DIR="$tmp/nowhere" 2>&1 || true)
check "unbuilt shell names the cmake commands" grep -q 'cmake -S os/shell' <<<"$err"

rm -f "$tmp/build/cmake_install.cmake"
printf 'file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/share/jarvis-shell/labwc" TYPE FILE FILES "%s")\n' "$src/labwc/rc.xml" > "$tmp/build/cmake_install.cmake"
err=$(shell_build "$tmp/out3" 2>&1 || true)
check "install without the binary fails" grep -q '/usr/bin/jarvis-shell' <<<"$err"

finish
