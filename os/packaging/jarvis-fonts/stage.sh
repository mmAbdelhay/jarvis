#!/usr/bin/env bash
# Stage jarvis-fonts (M4 contracts §3): the Arabic fontconfig rule, enabled
# the Debian way (conf.avail + a conf.d symlink).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
stage=$1
mkdir -p "$stage/usr/share/fontconfig/conf.avail"
install -m0644 "$here/65-jarvis-arabic.conf" "$stage/usr/share/fontconfig/conf.avail/65-jarvis-arabic.conf"
mkdir -p "$stage/etc/fonts/conf.d"
ln -s ../../../usr/share/fontconfig/conf.avail/65-jarvis-arabic.conf "$stage/etc/fonts/conf.d/65-jarvis-arabic.conf"
