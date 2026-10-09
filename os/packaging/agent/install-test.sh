#!/usr/bin/env bash
# install-test.sh --debs DIR --image debian:trixie|ubuntu:24.04 [--level deps|chat]
# M2.5 design §2 criterion 10: apt install of jarvis-agent on a stock Debian
# 13 / Ubuntu 24.04 (a plain, unprivileged container: no systemd, no KVM).
#   deps  install, check what is and is not on the system, purge (stubs are fine)
#   chat  also run jarvisd with the fake provider and drive the jarvis CLI:
#         a reply, a safe tool, a confirm card denied at the terminal (real debs)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
debs="" image="" level=deps
while [ $# -gt 0 ]; do
  case $1 in
    --debs | --image | --level)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "install-test: $1 requires a value" >&2; exit 2; }
      case $1 in
        --debs) debs=$2; shift 2 ;;
        --image) image=$2; shift 2 ;;
        --level) level=$2; shift 2 ;;
      esac ;;
    *) echo "install-test: unknown argument $1" >&2; exit 2 ;;
  esac
done
die() { echo "install-test: $*" >&2; exit 1; }
case $image in debian:trixie | ubuntu:24.04) ;; *) die "--image must be debian:trixie or ubuntu:24.04" ;; esac
case $level in deps | chat) ;; *) die "--level must be deps or chat" ;; esac
[ -d "$debs" ] || die "no directory $debs"
debs=$(cd "$debs" && pwd)
shopt -s nullglob
for p in jarvis-agent jarvisd jarvis-pkg jarvis-diag jarvis-helper jarvis-cli jarvis-archive-keyring; do
  matches=("$debs/${p}_"*.deb)
  [ "${#matches[@]}" -eq 1 ] || die "need exactly one $p .deb in $debs"
done
echo "== jarvis-agent on $image ($level)"
exec perl -e 'alarm 900; exec @ARGV' docker run --rm --platform linux/amd64 -e DEBIAN_FRONTEND=noninteractive \
  -v "$debs:/debs:ro" -v "$here:/agent-test:ro" "$image" bash /agent-test/in-container.sh "$level"
