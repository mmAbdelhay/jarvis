#!/usr/bin/env bash
# jarvis-accounts (Plan Y §2.2, §5.4, §5.7).
source "$(dirname "$0")/lib.sh"
REPO_ROOT=$(cd "$PACKAGING_DIR/../.." && pwd)
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
"$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-accounts >/dev/null
deb=$tmp/out/jarvis-accounts_${OS_VERSION}_all.deb
check "pins at the contract path" deb_has "$deb" usr/share/jarvis/accounts/accounts.json
check "pins identical to source" cmp -s <(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/share/jarvis/accounts/accounts.json) "$REPO_ROOT/os/models/accounts.json"
check "pins 0644" test "$(deb_mode "$deb" usr/share/jarvis/accounts/accounts.json)" = "-rw-r--r--"
check "empty npm user config for installs" test "$(deb_mode "$deb" usr/lib/jarvis/accounts/npmrc)" = "-rw-r--r--"
check "browser shim executable" test "$(deb_mode "$deb" usr/lib/jarvis/accounts/bin/xdg-open)" = "-rwxr-xr-x"
for alias in sensible-browser x-www-browser www-browser; do
  check "$alias goes to the shim" deb_has "$deb" "usr/lib/jarvis/accounts/bin/$alias"
done
check "depends on the same jarvisd" bash -c "dpkg-deb -f '$deb' Depends | grep -qx 'jarvisd (= $OS_VERSION)'"
check "arch all" test "$(deb_field "$deb" Architecture)" = all

dpkg-deb -x "$deb" "$tmp/root"
shim=$tmp/root/usr/lib/jarvis/accounts/bin/xdg-open
JARVIS_OPEN_URL_FILE="$tmp/open-url" "$shim" "https://claude.ai/oauth/authorize?x=1"
check "the shim hands the URL over" test "$(cat "$tmp/open-url")" = "https://claude.ai/oauth/authorize?x=1"
check "the handed-over file is private" test "$(stat -c %a "$tmp/open-url")" = 600
check "the shim refuses without a target file" bash -c "! env -u JARVIS_OPEN_URL_FILE '$shim' https://example.org"
check "the shim refuses a missing URL" bash -c "! JARVIS_OPEN_URL_FILE='$tmp/x' '$shim'"

python3 - "$REPO_ROOT/os/models/accounts.json" "$tmp/bad.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
doc["accounts"][0]["version"] = "^2.1.0"
json.dump(doc, open(sys.argv[2], "w"))
PY
check "an invalid pins file fails the build" bash -c "! ACCOUNTS_PINS='$tmp/bad.json' '$PACKAGING_DIR/build.sh' --out '$tmp/o2' jarvis-accounts >/dev/null 2>&1"
finish
