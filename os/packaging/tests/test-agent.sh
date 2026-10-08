#!/usr/bin/env bash
# jarvis-agent (M2.5 contracts §6, §7.14): the brain, its tools, the helper,
# the CLI and the archive keyring for stock Debian 13 / Ubuntu 24.04.
# No shell, no branding.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
"$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-agent >/dev/null
deb=$tmp/out/jarvis-agent_${OS_VERSION}_all.deb
deps=$(deb_field "$deb" Depends)
for p in jarvisd jarvis-pkg jarvis-diag jarvis-helper jarvis-cli jarvis-archive-keyring; do
  check "depends on $p (= version)" grep -qF "$p (= $OS_VERSION)" <<<"$deps"
done
check "exactly six dependencies" test "$(tr ',' '\n' <<<"$deps" | awk 'NF' | wc -l)" -eq 6
for p in jarvis-shell jarvis-ui jarvis-branding jarvis-greeter jarvis-installer labwc greetd; do
  check "does not pull in $p" bash -c "! grep -qE '(^|[ ,])$p( |,|\$)' <<<\"\$1\"" _ "$deps"
done
check "arch all" test "$(deb_field "$deb" Architecture)" = all
check "no maintainer scripts" bash -c "! dpkg-deb --ctrl-tarfile '$deb' | tar -t | grep -qE 'preinst|postinst|prerm|postrm'"
check "only its README" test "$(deb_list "$deb" | awk '{print $6}' | grep -v '/$')" = "./usr/share/doc/jarvis-agent/README.Debian"
readme=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/share/doc/jarvis-agent/README.Debian)
check "README explains the jarvis-admins opt-in" grep -qF 'sudo adduser "$USER" jarvis-admins' <<<"$readme"
check "README warns what the group grants" grep -q 'install and remove packages' <<<"$readme"
check "README names jarvis setup" grep -q 'jarvis setup' <<<"$readme"

# No distro branding in what apt shows on Debian/Ubuntu (Rafiq is pinned here on purpose).
for p in jarvis-agent jarvis-cli jarvisd jarvis-pkg jarvis-diag jarvis-helper; do
  desc=$(sed -n '/^Description:/,$p' "$PACKAGING_DIR/$p/control.in")
  check "$p description is brand-neutral" bash -c "! grep -qE 'Rafiq|@DISTRO_NAME@|@PRETTY_NAME@|Jarvis OS' <<<\"\$1\"" _ "$desc"
done
finish
