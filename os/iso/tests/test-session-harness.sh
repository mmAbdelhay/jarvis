#!/usr/bin/env bash
# The headless session harness (Task 10) is wired to the real session files.
# It runs only in Linux CI; this checks it statically anywhere.
source "$(dirname "$0")/lib.sh"
h=$ISO_DIR/session
check "run.sh parses" bash -n "$h/run.sh"
check "in-container.sh parses" bash -n "$h/in-container.sh"
check "run.sh executable" test -x "$h/run.sh"
check "unprivileged container" bash -c "! grep -q -- '--privileged' '$h/run.sh'"
check "reads the ISO include tree" grep -qF "includes.chroot_after_packages" "$h/in-container.sh"
for f in "etc/xdg/labwc/rc.xml" "etc/xdg/labwc/environment" "usr/local/bin/labwc" "etc/xdg/labwc/autostart"; do
  check "uses the ISO's $f" grep -qF "$f" "$h/in-container.sh"
done
check "headless pixman labwc" grep -q 'WLR_BACKENDS=headless' "$h/in-container.sh"
for case in "Super alone focuses the shell" "Super+Space runs push-to-talk" "Super+L locks" \
  "a wrong password keeps the session locked" "the right password unlocks" "idle locks after lockAfterMinutes" \
  "the loop restarts jarvis-idle"; do
  check "covers: $case" grep -qF "\"$case\"" "$h/in-container.sh"
done
finish
