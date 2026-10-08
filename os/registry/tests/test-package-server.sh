#!/usr/bin/env bash
# package-server.sh / package-official.sh: reproducible, minimal, refuse unsafe inputs.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
[ -x /bin/busybox ] || { echo "SKIP test-package-server.sh (needs busybox-static for a static ELF)"; exit 0; }
ps=$REG_DIR/package-server.sh

srv=$tmp/srv; mkdir -p "$srv"; cp /bin/busybox "$srv/server"; chmod 0755 "$srv/server"; echo MIT > "$srv/LICENSE"
a=$("$ps" --id jarvis-clock --version 0.1.0 --runtime go-static --from "$srv" --out "$tmp/o1")
check "artifact name" test "$a" = "$tmp/o1/jarvis-clock-0.1.0-linux-amd64.tar.gz"
touch -d '2001-01-01' "$srv/server" "$srv/LICENSE"
b=$("$ps" --id jarvis-clock --version 0.1.0 --runtime go-static --from "$srv" --out "$tmp/o2")
check "byte-reproducible (mtimes do not leak)" cmp -s "$a" "$b"
listing=$(tar -tzvf "$a")
check "files at the archive root, sorted" test "$(tar -tzf "$a" | tr '\n' ' ')" = "LICENSE server "
check "owner 0/0" bash -c "! grep -v ' 0/0 ' <<<\"\$1\" | grep -q ." _ "$listing"
check "server executable" grep -q '^-rwxr-xr-x .* server$' <<<"$listing"
check "license not executable" grep -q '^-rw-r--r-- .* LICENSE$' <<<"$listing"

refuses() { # refuses NAME NEEDLE ARGS... — package-server fails and says NEEDLE
  local name=$1 needle=$2; shift 2
  local out
  if out=$("$ps" "$@" --out "$tmp/bad" 2>&1); then fail "$name (it succeeded)"; return; fi
  if grep -q -- "$needle" <<<"$out"; then pass "$name"; else fail "$name (said: $out)"; fi
}
dyn=$tmp/dyn; mkdir -p "$dyn"; cp /bin/true "$dyn/server"
refuses "dynamic binary refused" "statically linked" --id jarvis-clock --version 0.1.0 --runtime go-static --from "$dyn"
ln=$tmp/ln; mkdir -p "$ln"; cp /bin/busybox "$ln/server"; ln -s /etc/passwd "$ln/passwd"
refuses "symlink refused" "regular files" --id jarvis-clock --version 0.1.0 --runtime go-static --from "$ln"
lnk=$tmp/lnk; ln -s "$ln" "$lnk"
refuses "symlinked --from still checked" "regular files" --id jarvis-clock --version 0.1.0 --runtime go-static --from "$lnk"
su=$tmp/su; mkdir -p "$su"; cp /bin/busybox "$su/server"; chmod 4755 "$su/server"
refuses "setuid refused" "setuid" --id jarvis-clock --version 0.1.0 --runtime go-static --from "$su"
empty=$tmp/empty; mkdir -p "$empty"
refuses "missing entry point refused" "server.js" --id acme-notes --version 1.0.0 --runtime node --from "$empty"
refuses "bad version refused" "MAJOR.MINOR.PATCH" --id jarvis-clock --version 1.0 --runtime go-static --from "$srv"
refuses "bad id refused" "--id" --id Bad_Id --version 1.0.0 --runtime go-static --from "$srv"
refuses "unknown runtime refused" "--runtime" --id acme-x --version 1.0.0 --runtime ruby --from "$srv"
node=$tmp/node; mkdir -p "$node/lib"; echo 'console.log(1)' > "$node/server.js"; echo x > "$node/lib/a.js"
check "node server packaged" "$ps" --id acme-notes --version 1.0.0 --runtime node --from "$node" --out "$tmp/o3"
check "node tree kept" test "$(tar -tzf "$tmp/o3/acme-notes-1.0.0-linux-amd64.tar.gz" | tr '\n' ' ')" = "lib/ lib/a.js server.js "

# package-official.sh: one artifact per official source, from Plan J's output.
bin=$tmp/dist-registry
for id in jarvis-clock jarvis-files jarvis-web; do mkdir -p "$bin/$id"; cp /bin/busybox "$bin/$id/server"; done
REGISTRY_BIN_DIR=$bin "$REG_DIR/package-official.sh" --out "$tmp/off" >/dev/null
for id in jarvis-clock jarvis-files jarvis-web; do
  check "official $id packaged" test -f "$tmp/off/$id-0.1.0-linux-amd64.tar.gz"
done
rm -rf "$bin/jarvis-web"
err=$(REGISTRY_BIN_DIR=$bin "$REG_DIR/package-official.sh" --out "$tmp/off2" 2>&1 || true)
check "missing server build names Plan J" grep -q 'Plan J' <<<"$err"
finish
