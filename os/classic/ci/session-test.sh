#!/usr/bin/env bash
# Linux CI only (M2 §11.16): jarvis-classic inside a headless labwc must map its
# taskbar, and a second `jarvis-classic --chat` must hand over to the first and
# open the docked panel. Requires: os/classic/build from ci/test.sh; labwc.
set -euo pipefail

build="$PWD/os/classic/build"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -m 0700 "$work/run"
mkdir -p "$work/labwc" "$work/data/applications"
cp "$PWD/os/classic/tests/data/applications/foot.desktop" "$work/data/applications/"

cat > "$work/run-classic.sh" <<EOF
#!/bin/sh
export QT_QPA_PLATFORM=wayland QML_IMPORT_PATH="$build/qml" JARVIS_I18N_DIR="$build/i18n" XDG_DATA_DIRS="$work/data"
"$build/src/jarvis-classic" --quit-after 8000 > "$work/out" 2> "$work/err" &
first=\$!
sleep 3
"$build/src/jarvis-classic" --chat > "$work/forward-out" 2>&1
echo \$? > "$work/forward-status"
wait \$first
echo \$? > "$work/status"
labwc --exit
EOF
chmod +x "$work/run-classic.sh"

XDG_RUNTIME_DIR="$work/run" WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1 \
  WLR_LIBINPUT_NO_DEVICES=1 timeout 90 labwc -C "$work/labwc" -s "$work/run-classic.sh" || true

cat "$work/out"
cat "$work/err" >&2 || true
test "$(cat "$work/status")" = 0
test "$(cat "$work/forward-status")" = 0
grep -qx "jarvis-classic: taskbar shown" "$work/out"
grep -qx "jarvis-classic: chat shown" "$work/out"
echo "jarvis-classic: taskbar on layer-shell and --chat hand-over OK"
