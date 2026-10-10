#!/bin/sh
# install-gimprc.sh DIR — DIR/gimprc for the computer-use GUI tests: this
# directory's gimprc plus the installed GIMP's version as the known release,
# so GIMP 3 opens no Welcome window on its first start.
set -eu
dir=$1
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$dir"
cp "$here/gimprc" "$dir/gimprc"
ver=$(gimp --version 2>/dev/null | grep -o '[0-9][0-9.]*$' || true)
if [ -n "$ver" ]; then
  printf '(config-version "%s")\n(last-known-release "%s")\n' "$ver" "$ver" >> "$dir/gimprc"
fi
