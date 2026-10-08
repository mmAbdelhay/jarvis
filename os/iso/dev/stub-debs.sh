#!/usr/bin/env bash
# stub-debs.sh OUT — eleven stand-in Jarvis packages, so the ISO can be built
# and booted before the real E, F and G packages have landed. jarvisd keeps the real
# maintainer scripts and a unit that runs /bin/true; jarvis-shell opens a
# terminal (relaunch-loop snippet at the real package's path), which shows the
# session works; jarvis-helper keeps its real postinst and polkit rule.
set -euo pipefail
out=$1
here=$(cd "$(dirname "$0")" && pwd)
packaging=$(cd "$here/../../packaging" && pwd)
version=0.0.0~stub1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

stub() { # stub NAME [SCRIPTS_DIR]
  local name=$1 scripts=${2:-}
  local root=$tmp/$name
  mkdir -p "$root/usr/share/doc/$name"
  echo "Stub for ISO build tests; not the real $name." > "$root/usr/share/doc/$name/README.stub"
  cat > "$tmp/$name.control" <<EOF
Package: $name
Version: @VERSION@
Architecture: amd64
Maintainer: Stub package <stub@example.invalid>
Installed-Size: @INSTALLED_SIZE@
Section: misc
Priority: optional
Description: stub $name for ISO build tests
 Not functional. Built by os/iso/dev/stub-debs.sh.
EOF
  if [ -n "$scripts" ]; then
    "$packaging/lib/build-deb.sh" --control "$tmp/$name.control" --root "$root" --out "$out" \
      --version "$version" --scripts "$scripts"
  else
    "$packaging/lib/build-deb.sh" --control "$tmp/$name.control" --root "$root" --out "$out" \
      --version "$version"
  fi
}

mkdir -p "$tmp/jarvisd/usr/lib/systemd/user"
printf '[Unit]\nDescription=Jarvis daemon (stub)\n\n[Service]\nExecStart=/bin/true\n\n[Install]\nWantedBy=default.target\n' \
  > "$tmp/jarvisd/usr/lib/systemd/user/jarvisd.service"
stub jarvisd "$packaging/jarvisd"

mkdir -p "$tmp/jarvis-shell/usr/bin" "$tmp/jarvis-shell/usr/share/jarvis-shell/labwc"
printf '#!/bin/sh\nexec foot\n' > "$tmp/jarvis-shell/usr/bin/jarvis-shell"
chmod 0755 "$tmp/jarvis-shell/usr/bin/jarvis-shell"
echo '(while true; do jarvis-shell; sleep 1; done) &' > "$tmp/jarvis-shell/usr/share/jarvis-shell/labwc/autostart"
stub jarvis-shell
stub jarvis-pkg
stub jarvis-diag

# The real postinst (creates jarvis-admins) and polkit rule, so the session
# hook and verify-chroot pass on a stub build.
mkdir -p "$tmp/jarvis-helper/usr/share/polkit-1/rules.d"
cp "$packaging/jarvis-helper/50-jarvis.rules" "$tmp/jarvis-helper/usr/share/polkit-1/rules.d/"
stub jarvis-helper "$packaging/jarvis-helper"

mkdir -p "$tmp/jarvis-ui/usr/lib/x86_64-linux-gnu/qt6/qml/Jarvis/UI"
echo 'module Jarvis.UI' > "$tmp/jarvis-ui/usr/lib/x86_64-linux-gnu/qt6/qml/Jarvis/UI/qmldir"
stub jarvis-ui
# The stub greeter is a terminal login inside cage; config and diversion are real.
mkdir -p "$tmp/jarvis-greeter/usr/bin" "$tmp/jarvis-greeter/etc/greetd"
printf '#!/bin/sh\nexec foot -e agreety --cmd labwc\n' > "$tmp/jarvis-greeter/usr/bin/jarvis-greeter"
chmod 0755 "$tmp/jarvis-greeter/usr/bin/jarvis-greeter"
cp "$packaging/jarvis-greeter/config.toml" "$tmp/jarvis-greeter/etc/greetd/config.toml"
install -D -m0755 "$packaging/jarvis-greeter/with-keyboard" "$tmp/jarvis-greeter/usr/lib/jarvis-greeter/with-keyboard"
stub jarvis-greeter "$packaging/jarvis-greeter"
stub jarvis-installer
stub jarvis-installer-backend
mkdir -p "$tmp/jarvis-model-fetch/usr/lib/systemd/system"
printf '[Unit]\nConditionPathExists=/var/lib/jarvis/model-pending\n[Service]\nType=oneshot\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' \
  > "$tmp/jarvis-model-fetch/usr/lib/systemd/system/jarvis-model-fetch.service"
stub jarvis-model-fetch "$packaging/jarvis-model-fetch"

# jarvis-cli from its real definition (launcher, Depends on jarvisd) with a
# one-line bundle, at the stub version so it pairs with the stub jarvisd.
mkdir -p "$tmp/cli-dist"
echo 'console.log("jarvis (stub)");' > "$tmp/cli-dist/jarvis.mjs"
OS_VERSION=$version CLI_DIST=$tmp/cli-dist "$packaging/build.sh" --out "$out" jarvis-cli >/dev/null
