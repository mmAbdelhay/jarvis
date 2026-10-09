#!/usr/bin/env bash
# M3 additions to the live-build tree (contracts §3, §4; M2.5 §7 #15).
source "$(dirname "$0")/lib.sh"
lists=("$ISO_DIR"/config/package-lists/*.list.chroot)
all=$(grep -hv '^\s*#' "${lists[@]}" | awk 'NF {print $1}')
for p in jarvis-settings jarvis-apps jarvis-wl jarvis-lock jarvis-idle jarvis-voice-models jarvis-voice-engines \
  brightnessctl wireplumber wlsunset bluez power-profiles-daemon wlr-randr udisks2 xdg-utils mako-notifier exfatprogs; do
  check "lists include $p" grep -qx "$p" <<<"$all"
done
check "no package listed twice" test -z "$(sort <<<"$all" | uniq -d)"
check "live user in bluetooth" grep -Eq 'user-default-groups=[^ ]*\bbluetooth\b' "$ISO_DIR/bootappend"
for p in jarvis-settings jarvis-apps jarvis-wl jarvis-lock jarvis-idle jarvis-voice-models jarvis-voice-engines; do
  check "build.sh requires $p" grep -qw "$p" <<<"$(sed -n '/^required="/,/"$/p' "$ISO_DIR/build.sh")"
done
check "verify-chroot runs verify-m3" grep -qF '/verify-m3.sh" "$c"' "$ISO_DIR/scripts/verify-chroot.sh"
finish
