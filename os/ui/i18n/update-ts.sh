#!/bin/sh
# Refresh <ts dir>/{en,ar}.ts from the sources; existing translations are kept.
# Usage: os/ui/i18n/update-ts.sh <ts dir> <source dir>...   (env LUPDATE overrides the tool)
set -eu
ts_dir=$1
shift
lupdate=${LUPDATE:-}
if [ -z "$lupdate" ]; then
    brew_qt=$(brew --prefix qt 2>/dev/null || true)
    for candidate in lupdate /usr/lib/qt6/bin/lupdate "$brew_qt/bin/lupdate" "$brew_qt/share/qt/libexec/lupdate"; do
        if command -v "$candidate" >/dev/null 2>&1; then
            lupdate=$candidate
            break
        fi
    done
fi
[ -n "$lupdate" ] || { echo "update-ts.sh: lupdate not found; set LUPDATE" >&2; exit 1; }
mkdir -p "$ts_dir"
for lang in en ar; do
    "$lupdate" -silent -locations none -no-obsolete -source-language en -target-language "$lang" \
        "$@" -ts "$ts_dir/$lang.ts"
done
