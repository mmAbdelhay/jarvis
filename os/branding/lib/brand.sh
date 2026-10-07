# shellcheck shell=bash
# Sourced. The distro brand from os/branding/brand.env.
#   brand_load [FILE]        validate + export the brand ($BRAND_ENV overrides the default file)
#   brand_render_text        stdin -> stdout with @KEY@ placeholders filled
#   brand_render IN OUT      file version; fails if a brand placeholder is left
shopt -u patsub_replacement 2>/dev/null || true
BRAND_ENV_DEFAULT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/brand.env
BRAND_KEYS="DISTRO_NAME DISTRO_ID DISTRO_VERSION ISO_VOLUME HOME_URL"

brand_load() {
  local file=${1:-${BRAND_ENV:-$BRAND_ENV_DEFAULT}}
  if [ ! -f "$file" ]; then echo "brand: no brand file at $file" >&2; return 1; fi
  # Data, not code: refuse anything but the five KEY="plain value" lines.
  if grep -vE '^[[:space:]]*(#.*)?$' "$file" |
    grep -vqE '^(DISTRO_NAME|DISTRO_ID|DISTRO_VERSION|ISO_VOLUME|HOME_URL)="[^"$`\\]*"$'; then
    echo "brand: $file may only hold KEY=\"value\" lines for: $BRAND_KEYS" >&2
    return 1
  fi
  local key
  for key in $BRAND_KEYS; do unset "$key"; done
  # shellcheck source=/dev/null
  . "$file"
  for key in $BRAND_KEYS; do
    if [ -z "${!key:-}" ]; then echo "brand: $key is missing or empty in $file" >&2; return 1; fi
  done
  if ! [[ $DISTRO_ID =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
    echo "brand: DISTRO_ID must match [a-z0-9][a-z0-9._-]* (os-release ID)" >&2; return 1
  fi
  if ! [[ $DISTRO_VERSION =~ ^[0-9]+\.[0-9]+$ ]]; then
    echo "brand: DISTRO_VERSION must be MAJOR.MINOR" >&2; return 1
  fi
  if [ "${#ISO_VOLUME}" -gt 32 ]; then
    echo "brand: ISO_VOLUME is longer than 32 characters" >&2; return 1
  fi
  if ! [[ $HOME_URL =~ ^https:// ]]; then echo "brand: HOME_URL must be https" >&2; return 1; fi
  PRETTY_NAME="$DISTRO_NAME $DISTRO_VERSION (trixie)"
  export DISTRO_NAME DISTRO_ID DISTRO_VERSION ISO_VOLUME HOME_URL PRETTY_NAME
}

brand_render_text() {
  local text
  text=$(cat; printf x)
  text=${text%x}
  text=${text//@DISTRO_NAME@/$DISTRO_NAME}
  text=${text//@DISTRO_ID@/$DISTRO_ID}
  text=${text//@DISTRO_VERSION@/$DISTRO_VERSION}
  text=${text//@ISO_VOLUME@/$ISO_VOLUME}
  text=${text//@HOME_URL@/$HOME_URL}
  text=${text//@PRETTY_NAME@/$PRETTY_NAME}
  printf '%s' "$text"
}

brand_render() {
  local in=$1 out=$2
  brand_render_text < "$in" > "$out"
  if grep -nE '@(DISTRO_[A-Z_]*|ISO_VOLUME|HOME_URL|PRETTY_NAME)[A-Z_]*@' "$out" >&2; then
    echo "brand: unknown brand placeholder left in $out (from $in)" >&2
    return 1
  fi
}
