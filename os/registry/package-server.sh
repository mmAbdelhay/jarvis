#!/usr/bin/env bash
# package-server.sh --id ID --version V --runtime go-static|node|python --from DIR --out DIR
# One MCP server as a registry artifact (M2.5 contracts §3): gzip'd tar of
# DIR's files at the archive root, entry point server / server.js /
# server.py. Byte-for-byte reproducible (sorted, mtime 0, owner 0/0, gzip -n),
# regular files and directories only, nothing setuid. Prints the path.
set -euo pipefail
id="" version="" runtime="" from="" out=""
while [ $# -gt 0 ]; do
  case $1 in
    --id) id=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --runtime) runtime=$2; shift 2 ;;
    --from) from=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    *) echo "package-server: unknown argument $1" >&2; exit 2 ;;
  esac
done
die() { echo "package-server: $*" >&2; exit 1; }
[[ $id =~ ^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$ ]] || die "bad --id '$id' (a-z, 0-9, inner -)"
[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "bad --version '$version' (MAJOR.MINOR.PATCH)"
case $runtime in
  go-static) entry=server ;;
  node) entry=server.js ;;
  python) entry=server.py ;;
  *) die "bad --runtime '$runtime' (go-static, node or python)" ;;
esac
[ -n "$out" ] || die "--out is required"
[ -d "$from" ] || die "no directory $from"
odd=$(find "$from" -mindepth 1 ! -type f ! -type d -print)
[ -z "$odd" ] || die "only regular files and directories may be packaged: $odd"
[ -f "$from/$entry" ] || die "$from has no $entry (the $runtime entry point)"
setid=$(find "$from" -type f -perm /6000 -print)
[ -z "$setid" ] || die "setuid/setgid files refused: $setid"
if [ "$runtime" = go-static ]; then
  [ -x "$from/server" ] || die "server is not executable"
  desc=$(file -b "$from/server")
  case $desc in *x86-64*) ;; *) die "server is not an x86-64 binary: $desc" ;; esac
  case $desc in *"statically linked"* | *"static-pie linked"*) ;; *) die "server is not statically linked: $desc" ;; esac
fi
# Contracts §7.7: <= 2000 entries, <= 256 MiB unpacked, <= 64 MiB download.
entries=$(find "$from" -mindepth 1 | wc -l)
[ "$entries" -le 2000 ] || die "server tree has $entries entries, over the 2000 cap"
bytes=$(find "$from" -type f -exec wc -c {} + | awk '$2 != "total" {s += $1} END {print s + 0}')
[ "$bytes" -le 268435456 ] || die "server tree is $bytes bytes unpacked, over the 256 MiB cap"

mkdir -p "$out"
name="$id-$version-linux-amd64.tar.gz"
list=$(mktemp); trap 'rm -f "$list"' EXIT
(cd "$from" && find . -mindepth 1 | sed 's#^\./##' | LC_ALL=C sort) > "$list"
tar -C "$from" --no-recursion --format=gnu --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --mode='u+rw,go+r,go-w' -cf - -T "$list" | gzip -n -9 > "$out/$name"
[ "$(wc -c < "$out/$name")" -le 67108864 ] || { rm -f "$out/$name"; die "artifact is over the 64 MiB download cap"; }
echo "$out/$name"
