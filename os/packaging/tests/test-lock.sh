#!/usr/bin/env bash
# jarvis-lock (M3 contracts §3) from tiny CMake projects standing in for os/lock.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
if ! command -v cmake >/dev/null || ! command -v cc >/dev/null; then
  echo 'SKIP test-lock.sh: needs cmake and a C compiler (TRIXIE_PACKAGES="cmake gcc libc6-dev")' >&2
  exit 1
fi
make_project() { # make_project DIR elf|setuid|script
  local dir=$1 kind=$2
  mkdir -p "$dir"
  echo 'int main(void) { return 0; }' > "$dir/main.c"
  case $kind in
    elf)
      printf 'cmake_minimum_required(VERSION 3.20)\nproject(fake_lock C)\nadd_executable(jarvis-lock main.c)\ninstall(TARGETS jarvis-lock RUNTIME DESTINATION bin)\n' > "$dir/CMakeLists.txt" ;;
    setuid)
      printf 'cmake_minimum_required(VERSION 3.20)\nproject(fake_lock C)\nadd_executable(jarvis-lock main.c)\ninstall(TARGETS jarvis-lock RUNTIME DESTINATION bin PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE SETUID)\n' > "$dir/CMakeLists.txt" ;;
    script)
      printf '#!/bin/sh\nexec /usr/libexec/jarvis/real-lock "$@"\n' > "$dir/jarvis-lock"
      printf 'cmake_minimum_required(VERSION 3.20)\nproject(fake_lock NONE)\ninstall(PROGRAMS jarvis-lock DESTINATION bin)\n' > "$dir/CMakeLists.txt" ;;
  esac
  cmake -S "$dir" -B "$dir/build" -DCMAKE_INSTALL_PREFIX=/usr >/dev/null
  cmake --build "$dir/build" >/dev/null
}
printf '# Plan O runtime list (stand-in)\nlayer-shell-qt\nqml6-module-qtquick-controls\n' > "$tmp/runtime.txt"
lock_build() { LOCK_BUILD_DIR=$2 LOCK_RUNTIME_DEPS=$tmp/runtime.txt "$PACKAGING_DIR/build.sh" --out "$1" jarvis-lock; }

make_project "$tmp/elf" elf
lock_build "$tmp/out" "$tmp/elf/build" >/dev/null
deb=$tmp/out/jarvis-lock_${OS_VERSION}_amd64.deb
check "binary at /usr/bin/jarvis-lock (contracts §3)" deb_has "$deb" usr/bin/jarvis-lock
check "binary 0755" test "$(deb_mode "$deb" usr/bin/jarvis-lock)" = "-rwxr-xr-x"
deps=$(deb_field "$deb" Depends)
check "needs the same-version jarvis-ui (greeter look)" grep -qF "jarvis-ui (= $OS_VERSION)" <<<"$deps"
for p in libpam-runtime libpam-modules layer-shell-qt qml6-module-qtquick-controls; do
  check "Depends has $p" grep -qw -- "$p" <<<"$deps"
done
check "PAM file 0644" test "$(deb_mode "$deb" etc/pam.d/jarvis-lock)" = "-rw-r--r--"
check "PAM file is a conffile" grep -qx /etc/pam.d/jarvis-lock <<<"$(dpkg-deb --ctrl-tarfile "$deb" | tar -xO ./conffiles)"
pam=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./etc/pam.d/jarvis-lock)
check "PAM: the login stack (common-auth)" grep -qx '@include common-auth' <<<"$pam"
check "PAM: account checked (expired/locked accounts)" grep -qx '@include common-account' <<<"$pam"
check "PAM: 2 s failure delay first" grep -Eq '^auth +optional +pam_faildelay\.so delay=2000000$' <<<"$(grep -v '^#' <<<"$pam" | head -n1)"
check "PAM: never pam_permit" bash -c '! grep -q pam_permit'  <<<"$pam"
check "PAM: no session stack" grep -Eq '^session +required +pam_deny\.so$' <<<"$pam"
check "PAM: no password changes" grep -Eq '^password +required +pam_deny\.so$' <<<"$pam"

make_project "$tmp/suid" setuid
lock_build "$tmp/o2" "$tmp/suid/build" >/dev/null
check "a setuid bit from the build is dropped" \
  test "$(deb_mode "$tmp/o2/jarvis-lock_${OS_VERSION}_amd64.deb" usr/bin/jarvis-lock)" = "-rwxr-xr-x"

make_project "$tmp/script" script
err=$(lock_build "$tmp/o3" "$tmp/script/build" 2>&1 || true)
check "a wrapper script is refused (jarvisd checks /proc/<pid>/exe)" grep -qF '/proc/<pid>/exe' <<<"$err"
check "no package from a wrapper script" test ! -e "$tmp/o3/jarvis-lock_${OS_VERSION}_amd64.deb"

err=$(lock_build "$tmp/o4" "$tmp/nowhere" 2>&1 || true)
check "unbuilt lock names Plan O's cmake commands" grep -q 'cmake -S os/lock' <<<"$err"
finish
