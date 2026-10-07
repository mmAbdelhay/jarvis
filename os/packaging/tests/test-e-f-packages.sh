#!/usr/bin/env bash
# E/F packages from fake upstream outputs (contracts §7).
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
command -v cmake >/dev/null || { echo "SKIP test-e-f-packages.sh (needs cmake)"; exit 0; }

# Fake E builds: a CMake project per component whose install() rules put
# files at the contract paths, plus a runtime list.
fake_cmake() { # fake_cmake NAME "path1 path2..."
  local src=$tmp/src/$1 build=$tmp/build/$1
  mkdir -p "$src/deps"
  { echo 'cmake_minimum_required(VERSION 3.16)'; echo "project($1 NONE)"
    for p in $2; do echo "install(FILES \${CMAKE_CURRENT_SOURCE_DIR}/f DESTINATION $(dirname "$p") RENAME $(basename "$p"))"; done
  } > "$src/CMakeLists.txt"
  echo x > "$src/f"; printf '# runtime\nqml6-module-qtquick\n' > "$src/deps/debian-runtime.txt"
  cmake -S "$src" -B "$build" -DCMAKE_INSTALL_PREFIX=/usr >/dev/null
}
fake_cmake ui "lib/x86_64-linux-gnu/qt6/qml/Jarvis/UI/qmldir lib/x86_64-linux-gnu/qt6/qml/Jarvis/UI/Theme.qml"
fake_cmake installer "bin/jarvis-installer share/applications/jarvis-installer.desktop"
fake_cmake greeter "bin/jarvis-greeter"
# Fake F dist.
dist=$tmp/dist
for f in usr/libexec/jarvis/jarvis-installer-backend usr/libexec/jarvis/jarvis-model-fetch; do install -D -m0755 /bin/true "$dist/$f"; done
for f in usr/share/dbus-1/system.d/os.jarvis.Installer1.conf usr/share/dbus-1/system-services/os.jarvis.Installer1.service \
  usr/lib/systemd/system/jarvis-installer-backend.service usr/lib/systemd/system/jarvis-model-fetch.service \
  usr/share/polkit-1/actions/os.jarvis.installer.policy; do install -D -m0644 /dev/null "$dist/$f"; echo "# $f" > "$dist/$f"; done
printf '[Unit]\nConditionPathExists=/var/lib/jarvis/model-pending\n[Service]\nType=exec\nExecStart=/usr/libexec/jarvis/jarvis-model-fetch\n[Install]\nWantedBy=multi-user.target\n' > "$dist/usr/lib/systemd/system/jarvis-model-fetch.service"

export GO_DIST=$dist
export UI_BUILD_DIR=$tmp/build/ui UI_RUNTIME_DEPS=$tmp/src/ui/deps/debian-runtime.txt
export INSTALLER_BUILD_DIR=$tmp/build/installer INSTALLER_RUNTIME_DEPS=$tmp/src/installer/deps/debian-runtime.txt
export GREETER_BUILD_DIR=$tmp/build/greeter GREETER_RUNTIME_DEPS=$tmp/src/greeter/deps/debian-runtime.txt
"$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-ui jarvis-installer jarvis-greeter jarvis-installer-backend jarvis-model-fetch >/dev/null
d() { echo "$tmp/out/${1}_${OS_VERSION}_${2:-amd64}.deb"; }

check "ui QML module path" deb_has "$(d jarvis-ui)" usr/lib/x86_64-linux-gnu/qt6/qml/Jarvis/UI/qmldir
check "ui runtime deps from E's list" grep -q qml6-module-qtquick <<<"$(deb_field "$(d jarvis-ui)" Depends)"
check "installer binary" deb_has "$(d jarvis-installer)" usr/bin/jarvis-installer
check "installer desktop file" deb_has "$(d jarvis-installer)" usr/share/applications/jarvis-installer.desktop
check "installer needs same-version backend" grep -qF "jarvis-installer-backend (= $OS_VERSION)" <<<"$(deb_field "$(d jarvis-installer)" Depends)"
check "installer needs same-version ui" grep -qF "jarvis-ui (= $OS_VERSION)" <<<"$(deb_field "$(d jarvis-installer)" Depends)"
g=$(d jarvis-greeter)
check "greeter binary" deb_has "$g" usr/bin/jarvis-greeter
cfg=$(dpkg-deb --fsys-tarfile "$g" | tar -xO ./etc/greetd/config.toml)
check "greetd runs the greeter in cage (contracts §7)" grep -qx 'command = "cage -s -- jarvis-greeter"' <<<"$cfg"
check "greetd greeter user" grep -qx 'user = "_greetd"' <<<"$cfg"
check "no autologin in the package" bash -c "! grep -q initial_session <<<\"\$1\"" _ "$cfg"
check "greetd config is a conffile" grep -qx /etc/greetd/config.toml <<<"$(dpkg-deb --ctrl-tarfile "$g" | tar -xO ./conffiles)"
check "preinst diverts greetd's config" grep -q 'dpkg-divert --package jarvis-greeter --add --rename --divert /etc/greetd/config.toml.greetd /etc/greetd/config.toml' <<<"$(deb_script "$g" preinst)"
check "postrm removes the diversion" grep -q 'dpkg-divert --package jarvis-greeter --remove' <<<"$(deb_script "$g" postrm)"
for dep in greetd cage "jarvis-ui (= $OS_VERSION)" "jarvis-branding (= $OS_VERSION)"; do
  check "greeter depends on $dep" grep -qF "$dep" <<<"$(deb_field "$g" Depends)"
done
b=$(d jarvis-installer-backend)
for p in usr/libexec/jarvis/jarvis-installer-backend usr/share/dbus-1/system.d/os.jarvis.Installer1.conf \
  usr/share/dbus-1/system-services/os.jarvis.Installer1.service usr/lib/systemd/system/jarvis-installer-backend.service \
  usr/share/polkit-1/actions/os.jarvis.installer.policy; do check "backend ships /$p" deb_has "$b" "$p"; done
for dep in gdisk cryptsetup ntfs-3g squashfs-tools os-prober shim-signed grub-efi-amd64-signed "jarvis-ollama (= $OS_VERSION)"; do
  check "backend depends on $dep" grep -qF "$dep" <<<"$(deb_field "$b" Depends)"
done
m=$(d jarvis-model-fetch)
check "model-fetch binary" deb_has "$m" usr/libexec/jarvis/jarvis-model-fetch
check "model-fetch unit" deb_has "$m" usr/lib/systemd/system/jarvis-model-fetch.service
check "model-fetch does not block boot (contracts §11)" grep -qx Type=exec <<<"$(dpkg-deb --fsys-tarfile "$m" | tar -xO ./usr/lib/systemd/system/jarvis-model-fetch.service)"
check "model-fetch postinst enables the unit" grep -q 'systemctl enable jarvis-model-fetch.service' <<<"$(deb_script "$m" postinst)"
check "shell now depends on jarvis-ui" grep -q 'jarvis-ui (= @VERSION@)' "$PACKAGING_DIR/jarvis-shell/control.in"
check "version line is M2" grep -q "0.2.0~m2" "$PACKAGING_DIR/version.sh"
check "tag prefix stripped" test "$(OS_VERSION=os-v0.2.1 "$PACKAGING_DIR/version.sh")" = 0.2.1
rm "$tmp/build/greeter/CMakeCache.txt"
err=$("$PACKAGING_DIR/build.sh" --out "$tmp/o2" jarvis-greeter 2>&1 || true)
check "missing E build names the command" grep -q 'cmake -S os/greeter' <<<"$err"
finish
