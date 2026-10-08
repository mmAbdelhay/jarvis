#!/usr/bin/env bash
# Turn a staged install tree into a .deb with dpkg-deb.
#
#   build-deb.sh --control control.in --root STAGE --out DIR --version V [--scripts DIR]
#
# control.in placeholders: @VERSION@, @INSTALLED_SIZE@. Packages a stage.sh
# listed in STAGE/.extra-depends (e.g. jarvis-shell's QML modules, which no
# tool can discover) are appended to Depends, then the library dependencies
# of every x86-64 ELF file in the tree, computed with dpkg-shlibdeps, so a bundled binary (node, the shell) cannot ship
# without the libraries it links. Files under /etc become conffiles.
set -euo pipefail
shopt -u patsub_replacement 2>/dev/null || true

control="" root="" out="" version="" scripts=""
while [ $# -gt 0 ]; do
  case $1 in
    --control) control=$2; shift 2 ;;
    --root) root=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --scripts) scripts=$2; shift 2 ;;
    *) echo "build-deb: unknown argument $1" >&2; exit 2 ;;
  esac
done
for name in control root out version; do
  if [ -z "${!name}" ]; then echo "build-deb: --$name is required" >&2; exit 2; fi
done
[ -f "$control" ] || { echo "build-deb: no control template at $control" >&2; exit 2; }
[ -d "$root" ] || { echo "build-deb: no staged tree at $root" >&2; exit 2; }

is_x86_64_elf() {
  [ "$(head -c 4 "$1" | od -An -tx1 | tr -d ' \n')" = 7f454c46 ] &&
    [ "$(od -An -tx1 -j18 -N2 "$1" | tr -d ' \n')" = 3e00 ]
}

shlibs_depends() {
  local tree=$1 file probe
  local args=()
  while IFS= read -r -d '' file; do
    if is_x86_64_elf "$file"; then args+=("-e$file"); fi
  done < <(find "$tree" -path "$tree/DEBIAN" -prune -o -type f -print0)
  [ ${#args[@]} -gt 0 ] || return 0
  probe=$(mktemp -d)
  mkdir "$probe/debian"
  printf 'Source: shlibs-probe\n\nPackage: shlibs-probe\nArchitecture: any\n' > "$probe/debian/control"
  (cd "$probe" && dpkg-shlibdeps -O --ignore-missing-info "${libdirs[@]}" "${args[@]}" 2>/dev/null) |
    sed -n 's/^shlibs:Depends=//p'
  rm -rf "$probe"
}

rm -rf "$root/DEBIAN"
extra=""
if [ -f "$root/.extra-depends" ]; then
  extra=$({ grep -v '^[[:space:]]*#' "$root/.extra-depends" || true; } | awk 'NF {print $1}' | paste -sd, - | sed 's/,/, /g')
  rm -f "$root/.extra-depends"
fi
# Stage metadata lists package-private library search paths.
libdirs=()
if [ -f "$root/.shlibs-libdirs" ]; then
  while IFS= read -r d || [ -n "$d" ]; do
    case $d in '' ) continue ;; esac
    [[ $d =~ ^[[:space:]]*# ]] && continue
    libdirs+=("-l$root/${d#/}")
  done < "$root/.shlibs-libdirs"
  rm -f "$root/.shlibs-libdirs"
fi
# Stage metadata picks the data compression (GGUF weights do not compress;
# xz would spend many minutes for nothing).
compression=xz
if [ -f "$root/.deb-compression" ]; then
  compression=$(tr -d '[:space:]' < "$root/.deb-compression")
  rm -f "$root/.deb-compression"
  case $compression in
    xz|zstd|gzip|none) ;;
    *) echo "build-deb: .deb-compression must be xz, zstd, gzip or none (got '$compression')" >&2; exit 1 ;;
  esac
fi
chmod -R u+rwX,go+rX,go-w "$root"
mkdir -p "$root/DEBIAN" "$out"

size_kb=$(du -sk --exclude=DEBIAN "$root" | cut -f1)
text=$(cat "$control")
text=${text//@VERSION@/$version}
text=${text//@INSTALLED_SIZE@/$size_kb}
# Brand placeholders from os/branding/brand.env.
# shellcheck source=../../branding/lib/brand.sh
. "$(dirname "$0")/../../branding/lib/brand.sh"
brand_load
text=$(printf '%s' "$text" | brand_render_text)
if grep -q '@[A-Z_]*@' <<<"$text"; then
  echo "build-deb: unfilled placeholder in $control:" >&2
  grep '@[A-Z_]*@' <<<"$text" >&2
  exit 1
fi
printf '%s\n' "$text" > "$root/DEBIAN/control"

shlibs=$(shlibs_depends "$root")
added=$(printf '%s\n%s\n' "$extra" "$shlibs" | awk 'NF' | paste -sd, - | sed 's/,\([^ ]\)/, \1/g')
if [ -n "$added" ]; then
  if grep -q '^Depends:' "$root/DEBIAN/control"; then
    sed -i "s#^Depends: \(.*\)#Depends: \1, $added#" "$root/DEBIAN/control"
  else
    sed -i "/^Description:/i Depends: $added" "$root/DEBIAN/control"
  fi
fi

if [ -n "$scripts" ]; then
  for script in preinst postinst prerm postrm; do
    if [ -f "$scripts/$script" ]; then
      install -m0755 "$scripts/$script" "$root/DEBIAN/$script"
    fi
  done
fi

if [ -d "$root/etc" ]; then
  (cd "$root" && find etc -type f | sed 's#^#/#' | sort) > "$root/DEBIAN/conffiles"
fi
(cd "$root" && find . -path ./DEBIAN -prune -o -type f -print0 | sort -z |
  xargs -0 -r md5sum | sed 's#  \./#  #') > "$root/DEBIAN/md5sums"

package=$(sed -n 's/^Package: //p' "$root/DEBIAN/control")
arch=$(sed -n 's/^Architecture: //p' "$root/DEBIAN/control")
deb="$out/${package}_${version}_${arch}.deb"
dpkg-deb --root-owner-group -Z"$compression" --build "$root" "$deb" >/dev/null
echo "$deb"
