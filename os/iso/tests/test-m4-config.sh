#!/usr/bin/env bash
# M4 additions to the live-build tree (contracts §1-§5).
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
lists=("$ISO_DIR"/config/package-lists/*.list.chroot)
all=$(grep -hv '^\s*#' "${lists[@]}" | awk 'NF {print $1}')
for p in jarvis-backup-model jarvis-classic jarvis-session jarvis-fonts jarvis-i18n jarvis-recipes \
  pcmanfm-qt fonts-noto-core fonts-ibm-plex; do
  check "lists include $p" grep -qx "$p" <<<"$all"
done
check "jarvis-workspace is never in the image (contracts §5)" bash -c '! grep -qx jarvis-workspace <<<"$1"' _ "$all"
check "no package listed twice" test -z "$(sort <<<"$all" | uniq -d)"
req=$(sed -n '/^required="/,/"$/p' "$ISO_DIR/build.sh")
for p in jarvis-backup-model jarvis-classic jarvis-session jarvis-fonts jarvis-i18n jarvis-recipes; do
  check "build.sh requires $p" grep -qw "$p" <<<"$req"
done
check "verify-chroot runs verify-m4" grep -qF '/verify-m4.sh" "$c"' "$ISO_DIR/scripts/verify-chroot.sh"
check "ISO ceiling allows the backup model" grep -qF 'max_mb=${ISO_MAX_MB:-4300}' "$ISO_DIR/scripts/check-iso.sh"
check "check-iso keeps the squashfs under 4 GiB" grep -q 'filesystem.squashfs' "$ISO_DIR/scripts/check-iso.sh"
hook=$ISO_DIR/config/hooks/normal/0400-locales.hook.chroot
check "locale hook executable" test -x "$hook"
check "locale hook is POSIX sh" sh -n "$hook"
mkdir -p "$tmp/r/etc"
printf '# en_US.UTF-8 UTF-8\n# fr_FR.UTF-8 UTF-8\n' > "$tmp/r/etc/locale.gen"
check "locale hook runs" env LOCALE_ROOT="$tmp/r" LOCALE_GEN=true LOCALE_LIST="printf ar_EG.utf8\nen_US.utf8\n" sh "$hook"
check "English uncommented" grep -qx 'en_US.UTF-8 UTF-8' "$tmp/r/etc/locale.gen"
check "Arabic added" grep -qx 'ar_EG.UTF-8 UTF-8' "$tmp/r/etc/locale.gen"
check "others untouched" grep -qx '# fr_FR.UTF-8 UTF-8' "$tmp/r/etc/locale.gen"
check "locale hook fails when Arabic was not generated" \
  bash -c "! LOCALE_ROOT='$tmp/r' LOCALE_GEN=true LOCALE_LIST='printf en_US.utf8\n' sh '$hook' 2>/dev/null"
finish
