#!/usr/bin/env bash
# brand.env and lib/brand.sh.
source "$(dirname "$0")/lib.sh"
# shellcheck source=../lib/brand.sh
source "$BRANDING_DIR/lib/brand.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT

check "brand.env loads" brand_load
check "name (contracts §9)" test "$DISTRO_NAME" = "Rafiq"
check "id (contracts §9)" test "$DISTRO_ID" = "rafiq"
check "volume (contracts §9)" test "$ISO_VOLUME" = "Rafiq 0.2"
check "pretty name derived" test "$PRETTY_NAME" = "Rafiq 0.2 (trixie)"
check "iso volume fits ISO 9660 (32 chars)" test "${#ISO_VOLUME}" -le 32
check "only the five keys" test "$(grep -cvE '^[[:space:]]*(#.*)?$' "$BRANDING_DIR/brand.env")" -eq 5

printf 'NAME="@DISTRO_NAME@"\nID=@DISTRO_ID@\nP="@PRETTY_NAME@"\nU=@HOME_URL@\nV=@DISTRO_VERSION@ L=@ISO_VOLUME@ & keep\n' > "$tmp/in"
brand_render "$tmp/in" "$tmp/out"
check "renders every key" test "$(cat "$tmp/out")" = "$(printf 'NAME="Rafiq"\nID=rafiq\nP="Rafiq 0.2 (trixie)"\nU=https://github.com/mmAbdelhay/jarvis\nV=0.2 L=Rafiq 0.2 & keep')"
printf 'x @DISTRO_NAMEX@\n' > "$tmp/bad"
check "leftover placeholder fails" bash -c "! (source '$BRANDING_DIR/lib/brand.sh'; brand_load; brand_render '$tmp/bad' '$tmp/o') 2>/dev/null"

alt() { printf '%s\n' "$@" > "$tmp/alt.env"; }
alt 'DISTRO_NAME="Nova Linux"' 'DISTRO_ID="nova"' 'DISTRO_VERSION="1.0"' 'ISO_VOLUME="Nova"' 'HOME_URL="https://example.org"'
check "another brand loads" bash -c "source '$BRANDING_DIR/lib/brand.sh'; BRAND_ENV='$tmp/alt.env' brand_load && [ \"\$PRETTY_NAME\" = 'Nova Linux 1.0 (trixie)' ]"
alt 'DISTRO_NAME="Nova"' 'DISTRO_ID="Nova OS"' 'DISTRO_VERSION="1.0"' 'ISO_VOLUME="Nova"' 'HOME_URL="https://example.org"'
check "os-release-invalid id refused" bash -c "! (source '$BRANDING_DIR/lib/brand.sh'; brand_load '$tmp/alt.env') 2>/dev/null"
alt 'DISTRO_NAME="$(touch /tmp/pwned)"' 'DISTRO_ID="nova"' 'DISTRO_VERSION="1.0"' 'ISO_VOLUME="Nova"' 'HOME_URL="https://example.org"'
check "code in brand.env refused" bash -c "! (source '$BRANDING_DIR/lib/brand.sh'; brand_load '$tmp/alt.env') 2>/dev/null"
alt 'DISTRO_NAME="Nova"' 'DISTRO_ID="nova"' 'DISTRO_VERSION="1.0"' 'ISO_VOLUME="A volume label that is far too long"' 'HOME_URL="https://example.org"'
check "long volume refused" bash -c "! (source '$BRANDING_DIR/lib/brand.sh'; brand_load '$tmp/alt.env') 2>/dev/null"
alt 'DISTRO_NAME="Nova"' 'DISTRO_ID="nova"' 'DISTRO_VERSION="1"' 'ISO_VOLUME="Nova"' 'HOME_URL="https://example.org"'
check "version must be X.Y" bash -c "! (source '$BRANDING_DIR/lib/brand.sh'; brand_load '$tmp/alt.env') 2>/dev/null"
finish
