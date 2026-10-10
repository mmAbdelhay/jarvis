#!/bin/sh
# Runs one Qt test binary inside a headless labwc with two outputs
# (Linux only). Usage: run-headless-labwc.sh <test binary>
set -eu
test_bin=$1
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -m 0700 "$work/run"
mkdir -p "$work/labwc"
printf '<?xml version="1.0"?>\n<labwc_config><core><gap>0</gap></core></labwc_config>\n' > "$work/labwc/rc.xml"
cat > "$work/inner.sh" <<EOF
#!/bin/sh
QT_QPA_PLATFORM=wayland "$test_bin" > "$work/out" 2>&1
echo \$? > "$work/status"
labwc --exit
EOF
chmod +x "$work/inner.sh"
XDG_RUNTIME_DIR="$work/run" WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=2 \
  WLR_LIBINPUT_NO_DEVICES=1 timeout 100 labwc -C "$work/labwc" -s "$work/inner.sh" || true
cat "$work/out" 2>/dev/null || true
test "$(cat "$work/status" 2>/dev/null)" = 0
