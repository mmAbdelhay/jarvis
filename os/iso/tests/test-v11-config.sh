#!/usr/bin/env bash
# v1.1 additions to the live-build tree (contracts §1, §3).
source "$(dirname "$0")/lib.sh"
lists=("$ISO_DIR"/config/package-lists/*.list.chroot)
all=$(grep -hv '^\s*#' "${lists[@]}" | awk 'NF {print $1}')
for p in jarvis-cu at-spi2-core; do check "lists include $p" grep -qx "$p" <<<"$all"; done
check "no package listed twice" test -z "$(sort <<<"$all" | uniq -d)"
req=$(sed -n '/^required="/,/"$/p' "$ISO_DIR/build.sh")
check "build.sh requires jarvis-cu" grep -qw jarvis-cu <<<"$req"
check "verify-chroot runs verify-v11" grep -qF '/verify-v11.sh" "$c"' "$ISO_DIR/scripts/verify-chroot.sh"
check "verify-v11 executable" test -x "$ISO_DIR/scripts/verify-v11.sh"
check "version line is v1.1" grep -q '0.5.0~v11' "$REPO_ROOT/os/packaging/version.sh"
finish
