#!/usr/bin/env bash
# jarvis-idle (M3 contracts §3) from a tiny CMake project standing in for os/idle.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
if ! command -v cmake >/dev/null || ! command -v cc >/dev/null; then
  echo 'SKIP test-idle.sh: needs cmake and a C compiler (TRIXIE_PACKAGES="cmake gcc libc6-dev")' >&2
  exit 1
fi
mkdir -p "$tmp/src"
echo 'int main(void) { return 0; }' > "$tmp/src/main.c"
printf 'cmake_minimum_required(VERSION 3.20)\nproject(fake_idle C)\nadd_executable(jarvis-idle main.c)\ninstall(TARGETS jarvis-idle RUNTIME DESTINATION libexec/jarvis)\n' > "$tmp/src/CMakeLists.txt"
cmake -S "$tmp/src" -B "$tmp/build" -DCMAKE_INSTALL_PREFIX=/usr >/dev/null && cmake --build "$tmp/build" >/dev/null
printf 'libwayland-client0\n' > "$tmp/runtime.txt"
IDLE_BUILD_DIR=$tmp/build IDLE_RUNTIME_DEPS=$tmp/runtime.txt "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-idle >/dev/null
deb=$tmp/out/jarvis-idle_${OS_VERSION}_amd64.deb
check "daemon at /usr/libexec/jarvis/jarvis-idle (contracts §3)" deb_has "$deb" usr/libexec/jarvis/jarvis-idle
check "loop shipped 0755" test "$(deb_mode "$deb" usr/libexec/jarvis/jarvis-idle-loop)" = "-rwxr-xr-x"
check "autostart fragment shipped 0644" test "$(deb_mode "$deb" usr/share/jarvis-idle/labwc/autostart)" = "-rw-r--r--"
check "needs the same-version jarvis-lock" grep -qF "jarvis-lock (= $OS_VERSION)" <<<"$(deb_field "$deb" Depends)"
check "Depends has O's runtime list" grep -qw libwayland-client0 <<<"$(deb_field "$deb" Depends)"
err=$(IDLE_BUILD_DIR=$tmp/nowhere IDLE_RUNTIME_DEPS=$tmp/runtime.txt "$PACKAGING_DIR/build.sh" --out "$tmp/o2" jarvis-idle 2>&1 || true)
check "unbuilt idle names Plan O's cmake commands" grep -q 'cmake -S os/idle' <<<"$err"
finish
