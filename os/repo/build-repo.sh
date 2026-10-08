#!/usr/bin/env bash
# build-repo.sh --suite trixie|trixie-testing --debs DIR --out DIR --gnupghome DIR
#               --sign-with FPR [--previous DIR]
# Builds the whole GitHub Pages site from scratch with reprepro (design §9).
# No reprepro database is kept between runs: the suite being published gets
# DIR/*.deb, the other suite is re-included from the previous site's pool.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../branding/lib/brand.sh
. "$here/../branding/lib/brand.sh"
suite="" debs="" out="" gh="" sign="" previous=""
while [ $# -gt 0 ]; do
  case $1 in
    --suite) suite=$2; shift 2 ;;
    --debs) debs=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --gnupghome) gh=$2; shift 2 ;;
    --sign-with) sign=$2; shift 2 ;;
    --previous) previous=$2; shift 2 ;;
    *) echo "build-repo: unknown argument $1" >&2; exit 2 ;;
  esac
done
case $suite in trixie|trixie-testing) ;; *) echo "build-repo: --suite must be trixie or trixie-testing" >&2; exit 2 ;; esac
for v in debs out gh sign; do [ -n "${!v}" ] || { echo "build-repo: missing argument for $v" >&2; exit 2; }; done
compgen -G "$debs/*.deb" >/dev/null || { echo "build-repo: no .deb in $debs" >&2; exit 1; }
brand_load
export GNUPGHOME=$gh

base=$(mktemp -d); trap 'rm -rf "$base"' EXIT
mkdir -p "$base/conf"
brand_render "$here/conf/distributions.in" "$base/conf/distributions.tmp"
sed "s/@SIGN_WITH@/$sign/" "$base/conf/distributions.tmp" > "$base/conf/distributions"
rm "$base/conf/distributions.tmp"
printf 'verbose\nask-passphrase\n' > "$base/conf/options"
rr() { reprepro --basedir "$base" --silent "$@"; }

for codename in trixie trixie-testing; do
  if [ "$codename" = "$suite" ]; then
    for deb in "$debs"/*.deb; do rr -S misc -P optional includedeb "$codename" "$deb"; done
  elif [ -n "$previous" ] && [ -f "$previous/dists/$codename/main/binary-amd64/Packages" ]; then
    awk '/^Filename: / {print $2}' "$previous/dists/$codename/main/binary-amd64/Packages" | while read -r f; do
      rr -S misc -P optional includedeb "$codename" "$previous/$f"
    done
  fi
done
rr export

rm -rf "$out"; mkdir -p "$out"
cp -a "$base/dists" "$base/pool" "$out/"
gpg --armor --export "$sign" > "$out/jarvis-archive-keyring.gpg"
touch "$out/.nojekyll"
cat > "$out/index.html" <<EOF
<!doctype html><meta charset="utf-8"><title>$DISTRO_NAME packages</title>
<h1>$DISTRO_NAME APT repository</h1>
<p>Installed systems use it already (package jarvis-archive-keyring). Suites: trixie, trixie-testing.</p>
<p>Signing key: <a href="jarvis-archive-keyring.gpg">jarvis-archive-keyring.gpg</a> ($sign)</p>
EOF
echo "build-repo: $out ($suite)"
