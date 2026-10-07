#!/usr/bin/env bash
# stub-debs.sh OUT — five stand-in Jarvis packages, so the ISO can be built
# and booted before Plans A, B and C have landed. jarvisd keeps the real
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
