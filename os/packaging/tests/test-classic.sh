#!/usr/bin/env bash
# jarvis-classic (M4 contracts §2) from a tiny CMake project standing in for os/classic.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
if ! command -v cmake >/dev/null || ! command -v cc >/dev/null; then
  echo 'SKIP test-classic.sh: needs cmake and a C compiler (TRIXIE_PACKAGES="cmake gcc libc6-dev")' >&2
  exit 1
fi
mkdir -p "$tmp/src"
echo 'int main(void) { return 0; }' > "$tmp/src/main.c"
: > "$tmp/src/ar.qm"
cat > "$tmp/src/CMakeLists.txt" <<'CM'
cmake_minimum_required(VERSION 3.20)
project(fake_classic C)
add_executable(jarvis-classic main.c)
install(TARGETS jarvis-classic RUNTIME DESTINATION bin)
install(FILES ar.qm DESTINATION share/jarvis/i18n)
CM
cmake -S "$tmp/src" -B "$tmp/build" -DCMAKE_INSTALL_PREFIX=/usr >/dev/null && cmake --build "$tmp/build" >/dev/null
printf '# Plan R runtime list (stand-in)\nlayer-shell-qt\nqml6-module-qtquick-controls\n' > "$tmp/runtime.txt"
CLASSIC_BUILD_DIR=$tmp/build CLASSIC_RUNTIME_DEPS=$tmp/runtime.txt "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-classic >/dev/null
deb=$tmp/out/jarvis-classic_${OS_VERSION}_amd64.deb
check "binary at /usr/bin/jarvis-classic (contracts §2)" deb_has "$deb" usr/bin/jarvis-classic
check "binary 0755" test "$(deb_mode "$deb" usr/bin/jarvis-classic)" = "-rwxr-xr-x"
deps=$(deb_field "$deb" Depends)
for p in "jarvis-ui (= $OS_VERSION)" "jarvis-shell (= $OS_VERSION)" "jarvis-session (= $OS_VERSION)"; do
  check "Depends has $p" grep -qF "$p" <<<"$deps"
done
for p in pcmanfm-qt foot layer-shell-qt qml6-module-qtquick-controls libc6; do
  check "Depends has $p" grep -qw -- "$p" <<<"$deps"
done
check "translations left to jarvis-i18n" bash -c "! dpkg-deb -c '$deb' | grep -q 'share/jarvis/i18n'"
err=$(CLASSIC_BUILD_DIR=$tmp/nowhere CLASSIC_RUNTIME_DEPS=$tmp/runtime.txt "$PACKAGING_DIR/build.sh" --out "$tmp/o2" jarvis-classic 2>&1 || true)
check "an unbuilt classic names Plan R's cmake commands" grep -q 'cmake -S os/classic' <<<"$err"
finish
