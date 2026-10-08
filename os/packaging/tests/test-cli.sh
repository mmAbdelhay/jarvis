#!/usr/bin/env bash
# jarvis-cli (M2.5 contracts §5, §6): Plan K's bundle on jarvisd's Node.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
dist=$tmp/cli-dist; mkdir -p "$dist"
echo 'console.log("jarvis cli");' > "$dist/jarvis.mjs"
echo '{"version":3,"sources":[],"mappings":""}' > "$dist/jarvis.mjs.map"

CLI_DIST=$dist "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-cli >/dev/null
deb=$tmp/out/jarvis-cli_${OS_VERSION}_all.deb
check "bundle at its path" deb_has "$deb" usr/lib/jarvis/cli/jarvis.mjs
check "source map shipped" deb_has "$deb" usr/lib/jarvis/cli/jarvis.mjs.map
check "launcher at /usr/bin/jarvis (contracts §5)" deb_has "$deb" usr/bin/jarvis
check "launcher 0755" test "$(deb_mode "$deb" usr/bin/jarvis)" = "-rwxr-xr-x"
check "bundle 0644" test "$(deb_mode "$deb" usr/lib/jarvis/cli/jarvis.mjs)" = "-rw-r--r--"
launcher=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/bin/jarvis)
check "launcher runs the bundle on jarvisd's node" grep -qxF 'exec /usr/lib/jarvis/node/bin/node /usr/lib/jarvis/cli/jarvis.mjs "$@"' <<<"$launcher"
check "launcher is POSIX sh" grep -qx '#!/bin/sh' <<<"$(head -n1 <<<"$launcher")"
check "depends on the same-version jarvisd (its Node)" grep -qF "jarvisd (= $OS_VERSION)" <<<"$(deb_field "$deb" Depends)"
check "arch all" test "$(deb_field "$deb" Architecture)" = all
files=$(deb_list "$deb" | awk '{print $6}' | grep -v '/$' | sort | tr '\n' ' ')
check "nothing but bundle, map and launcher" test "$files" = "./usr/bin/jarvis ./usr/lib/jarvis/cli/jarvis.mjs ./usr/lib/jarvis/cli/jarvis.mjs.map "

rm "$dist/jarvis.mjs.map"
CLI_DIST=$dist "$PACKAGING_DIR/build.sh" --out "$tmp/nomap" jarvis-cli >/dev/null
check "map is optional" test -f "$tmp/nomap/jarvis-cli_${OS_VERSION}_all.deb"
mkdir -p "$dist/node_modules/x"
check "a bundle with node_modules is refused" bash -c "! CLI_DIST='$dist' '$PACKAGING_DIR/build.sh' --out '$tmp/o2' jarvis-cli >/dev/null 2>&1"
rm -rf "${dist:?}"/*
err=$(CLI_DIST=$dist "$PACKAGING_DIR/build.sh" --out "$tmp/o3" jarvis-cli 2>&1 || true)
check "missing bundle names Plan K's build" grep -q 'pnpm --filter @jarvis/cli build' <<<"$err"
finish
