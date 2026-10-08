#!/usr/bin/env bash
# make-test-debs.sh OUT — stub jarvisd/pkg/diag/helper/cli (os/iso/dev/stub-debs.sh)
# plus a stub archive-keyring and the real jarvis-agent definition, all at 0.0.0~stub1, for
# `install-test.sh --level deps` before Plans I, J, K land. Linux (dpkg-deb).
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 OUT" >&2; exit 2; }
out=$1
repo=$(cd "$(dirname "$0")/../../.." && pwd)
"$repo/os/iso/dev/stub-debs.sh" "$out" >/dev/null
# Contracts §7 adds the keyring dependency. This deps-only fixture carries no
# signing key and is deliberately unsuitable for chat or release use.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/keyring/DEBIAN" "$tmp/keyring/usr/share/doc/jarvis-archive-keyring"
cat > "$tmp/keyring/DEBIAN/control" <<'EOF'
Package: jarvis-archive-keyring
Version: 0.0.0~stub1
Architecture: all
Maintainer: Stub package <stub@example.invalid>
Section: misc
Priority: optional
Description: stub archive keyring for agent dependency tests
 Not functional. Contains no signing key or trust material.
EOF
printf 'Dependency-test stub only; not a release keyring.\n' > "$tmp/keyring/usr/share/doc/jarvis-archive-keyring/README.stub"
dpkg-deb --build --root-owner-group "$tmp/keyring" "$out/jarvis-archive-keyring_0.0.0~stub1_all.deb" >/dev/null
OS_VERSION=0.0.0~stub1 "$repo/os/packaging/build.sh" --out "$out" jarvis-agent >/dev/null
ls "$out"/jarvis-agent_*.deb
