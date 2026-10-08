#!/usr/bin/env bash
# Linux CI only (M2 §11.16): jarvis-lock-testhooks inside a headless labwc with
# two outputs must take the session lock, refuse a wrong password, then unlock
# with the right one. PAM runs through pam_wrapper + pam_matrix: no real
# account is touched. Requires: os/lock/build from ci/test.sh; labwc and
# libpam-wrapper installed.
set -euo pipefail

build="$PWD/os/lock/build"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -m 0700 "$work/run"
mkdir "$work/labwc" "$work/pam.d"
wrapper="$(find /usr/lib -name 'libpam_wrapper.so*' | head -n1)"
matrix="$(find /usr/lib -path '*pam_wrapper*' -name pam_matrix.so | head -n1)"
test -n "$wrapper" && test -n "$matrix"

printf '%s:right-pass:jarvis-lock\n' "$(id -un)" > "$work/passdb"
printf 'auth required %s passdb=%s\naccount required %s passdb=%s\n' \
  "$matrix" "$work/passdb" "$matrix" "$work/passdb" > "$work/pam.d/jarvis-lock"
printf 'wrong-pass\nright-pass\n' > "$work/passwords"

cat > "$work/run-lock.sh" <<EOF
#!/bin/sh
LD_PRELOAD="$wrapper" PAM_WRAPPER=1 PAM_WRAPPER_SERVICE_DIR="$work/pam.d" \\
QT_QPA_PLATFORM=wayland QML_IMPORT_PATH="$build/qml" \\
  "$build/src/jarvis-lock-testhooks" --test-password-file "$work/passwords" > "$work/out" 2> "$work/err"
echo \$? > "$work/status"
labwc --exit
EOF
chmod +x "$work/run-lock.sh"

XDG_RUNTIME_DIR="$work/run" WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=2 \
  WLR_LIBINPUT_NO_DEVICES=1 timeout 90 labwc -C "$work/labwc" -s "$work/run-lock.sh" || true

cat "$work/out"
cat "$work/err" >&2 || true
test "$(cat "$work/status")" = 0
grep -qx locked "$work/out"
grep -qx auth-failed "$work/out"
grep -qx unlocked "$work/out"
locked_line="$(grep -n -x locked "$work/out" | cut -d: -f1)"
failed_line="$(grep -n -x auth-failed "$work/out" | cut -d: -f1)"
test "$locked_line" -lt "$failed_line"
echo "jarvis-lock: session lock, PAM refusal and unlock OK"
