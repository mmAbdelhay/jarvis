#!/usr/bin/env bash
# jarvisd deb from a fake dist-daemon and a fake Node tarball (no network).
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT

dist=$tmp/dist-daemon
EXEC='ExecStart=/usr/lib/jarvis/node/bin/node /usr/lib/jarvis/daemon/jarvisd.mjs run'
make_dist() { # make_dist [EXECSTART_LINE] — Plan A's four files (contracts §6 #16)
  rm -rf "$dist"; mkdir -p "$dist"
  echo 'console.log("daemon");' > "$dist/jarvisd.mjs"
  echo '{"version":3,"sources":[],"mappings":""}' > "$dist/jarvisd.mjs.map"
  echo '{"build":"0.1.0+abc.2026-10-07T00:00:00Z"}' > "$dist/build-stamp.json"
  printf '[Unit]\nDescription=Jarvis daemon\n\n[Service]\n%s\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n' \
    "${1:-$EXEC}" > "$dist/jarvisd.service"
}
make_dist

# make_tarball OUT NODE_OUTPUT — a node-v24.0.0-linux-x64.tar.xz whose
# bin/node prints NODE_OUTPUT.
make_tarball() {
  local root=$tmp/tar-src/node-v24.0.0-linux-x64
  rm -rf "$tmp/tar-src"
  mkdir -p "$root/bin"
  printf '#!/bin/sh\necho %s\n' "$2" > "$root/bin/node"
  chmod 0755 "$root/bin/node"
  echo "MIT" > "$root/LICENSE"
  tar -C "$tmp/tar-src" -cJf "$1" node-v24.0.0-linux-x64
}
make_tarball "$tmp/node.tar.xz" v24.0.0
printf 'NODE_VERSION=24.0.0\nNODE_SHA256=%s\n' "$(sha256sum "$tmp/node.tar.xz" | cut -d' ' -f1)" > "$tmp/node.env"

build() { # build OUTDIR [extra env assignments...]
  local outdir=$1; shift
  env DAEMON_DIST="$dist" NODE_ENV_FILE="$tmp/node.env" NODE_TARBALL="$tmp/node.tar.xz" \
    NODE_CACHE_DIR="$tmp/cache" "$@" "$PACKAGING_DIR/build.sh" --out "$outdir" jarvisd
}

build "$tmp/out" >/dev/null
deb=$tmp/out/jarvisd_${OS_VERSION}_amd64.deb
unit=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/lib/systemd/user/jarvisd.service)

check "bundle installed" deb_has "$deb" usr/lib/jarvis/daemon/jarvisd.mjs
check "source map installed" deb_has "$deb" usr/lib/jarvis/daemon/jarvisd.mjs.map
check "build stamp beside the bundle (§6 #6)" deb_has "$deb" usr/lib/jarvis/daemon/build-stamp.json
check "nothing else in the daemon dir" test "$(deb_list "$deb" | awk '{print $6}' | grep -c '^./usr/lib/jarvis/daemon/.')" = 3
check "node at contract path" deb_has "$deb" usr/lib/jarvis/node/bin/node
check "node executable" test "$(deb_mode "$deb" usr/lib/jarvis/node/bin/node)" = "-rwxr-xr-x"
check "node licence shipped" deb_has "$deb" usr/lib/jarvis/node/LICENSE
check "user unit at contract path" deb_has "$deb" usr/lib/systemd/user/jarvisd.service
check "unit is Plan A's, running bundled node on the bundle" grep -qx "$EXEC" <<<"$unit"
check "unit never sets the fake provider" bash -c '! grep -q JARVIS_FAKE_PROVIDER' <<<"$unit"
check "postinst enables for every user" grep -q 'systemctl --global enable jarvisd.service' <<<"$(deb_script "$deb" postinst)"
check "prerm disables on remove" grep -q 'systemctl --global disable jarvisd.service' <<<"$(deb_script "$deb" prerm)"
check "depends on its MCP servers" grep -qF "jarvis-diag (= $OS_VERSION)" <<<"$(deb_field "$deb" Depends)"

# Review Focus 4: a tampered tarball fails with both checksums named.
make_tarball "$tmp/evil.tar.xz" v24.0.0
echo tampered >> "$tmp/evil.tar.xz"
err=$(build "$tmp/out-evil" NODE_TARBALL="$tmp/evil.tar.xz" 2>&1 || true)
check "tampered node fails the build" test ! -e "$tmp/out-evil/jarvisd_${OS_VERSION}_amd64.deb"
check "mismatch names expected and actual" grep -q 'expected' <<<"$err"

# ...and a poisoned cache entry is deleted so the next run downloads afresh.
mkdir -p "$tmp/cache"
cp "$tmp/evil.tar.xz" "$tmp/cache/node-v24.0.0-linux-x64.tar.xz"
build "$tmp/out-cache" NODE_TARBALL= >/dev/null 2>&1 || true
check "poisoned cache entry removed" test ! -e "$tmp/cache/node-v24.0.0-linux-x64.tar.xz"

# A Node that is not 24 is refused.
make_tarball "$tmp/old.tar.xz" v22.9.0
printf 'NODE_VERSION=24.0.0\nNODE_SHA256=%s\n' "$(sha256sum "$tmp/old.tar.xz" | cut -d' ' -f1)" > "$tmp/old.env"
err=$(build "$tmp/out-old" NODE_TARBALL="$tmp/old.tar.xz" NODE_ENV_FILE="$tmp/old.env" 2>&1 || true)
check "node 22 refused" grep -q 'need v24' <<<"$err"

# Review Focus 5: no dist-daemon -> the error names Plan A's build command.
err=$(build "$tmp/out-nodist" DAEMON_DIST="$tmp/missing" 2>&1 || true)
check "missing dist names build:daemon" grep -q 'build:daemon' <<<"$err"
rm "$dist/build-stamp.json"
err=$(build "$tmp/out-nostamp" 2>&1 || true)
check "missing build stamp fails" test ! -e "$tmp/out-nostamp/jarvisd_${OS_VERSION}_amd64.deb"

# A unit that runs anything else, or turns on the fake provider, is refused.
make_dist 'ExecStart=/usr/bin/node /usr/lib/jarvis/daemon/jarvisd.mjs run'
err=$(build "$tmp/out-exec" 2>&1 || true)
check "foreign ExecStart refused" grep -q 'ExecStart' <<<"$err"
make_dist
printf 'Environment=JARVIS_FAKE_PROVIDER=/x.json\n' >> "$dist/jarvisd.service"
err=$(build "$tmp/out-fake" 2>&1 || true)
check "fake provider in the unit refused" grep -q 'JARVIS_FAKE_PROVIDER' <<<"$err"
make_dist

finish
