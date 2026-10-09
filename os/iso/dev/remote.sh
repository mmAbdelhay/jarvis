#!/usr/bin/env bash
# Run Linux-only Rafiq tests; host is supplied only via JARVIS_LINUX_BOX.
# Usage: remote.sh [--run-id ID --artifact NAME]... [--dry-run] -- 'COMMAND'
# Syncs source/artifacts under ~/rafiq-build/v11 and retrieves OUT to remote-out.
set -euo pipefail
box=${JARVIS_LINUX_BOX:-}
run_id='' dry=0 separator=0
artifacts=()
usage() { echo "remote.sh: set JARVIS_LINUX_BOX=user@host; use [--run-id ID --artifact NAME]... [--dry-run] -- 'COMMAND'" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case $1 in
    --run-id|--artifact)
      [ $# -ge 2 ] && [ -n "$2" ] && [[ $2 != --* ]] || usage
      if [ "$1" = --run-id ]; then run_id=$2; else artifacts+=("$2"); fi
      shift 2 ;;
    --dry-run) dry=1; shift ;;
    --) separator=1; shift; break ;;
    *) usage ;;
  esac
done
[ -n "$box" ] && [[ $box != -* ]] && [[ $box != *[[:space:]]* ]] || usage
[ "$separator" = 1 ] && [ $# -eq 1 ] && [ -n "$1" ] || usage
[ ${#artifacts[@]} -eq 0 ] || [ -n "$run_id" ] || usage
cmd=$1
repo=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repo"
run() { if [ "$dry" = 1 ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }
# SSH's login shell need not be bash: use POSIX single-quote escaping.
quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }
version=$(bash "$repo/os/packaging/version.sh")
run ssh -o BatchMode=yes "$box" 'mkdir -p ~/rafiq-build/v11/src ~/rafiq-build/v11/artifacts && rm -rf ~/rafiq-build/v11/out && mkdir -p ~/rafiq-build/v11/out'
# A worktree's .git points outside this checkout. Preserve the version via
# OS_VERSION rather than copying unusable metadata from another worktree.
run rsync -az --delete --exclude .git --exclude node_modules --exclude '/out/' \
  --exclude '/remote-out/' --exclude '/.superpowers/' --exclude 'os/*/build/' \
  --exclude 'os/go/dist/' "$repo/" "$box:rafiq-build/v11/src/"
if [ ${#artifacts[@]} -gt 0 ]; then
  local_artifacts=$(mktemp -d)
  trap 'rm -rf "$local_artifacts"' EXIT
  for a in "${artifacts[@]}"; do run gh run download "$run_id" -n "$a" -D "$local_artifacts"; done
  run ssh -o BatchMode=yes "$box" 'rm -rf ~/rafiq-build/v11/artifacts && mkdir -p ~/rafiq-build/v11/artifacts'
  run rsync -az "$local_artifacts/" "$box:rafiq-build/v11/artifacts/"
fi
status=0
run ssh -o BatchMode=yes "$box" "cd ~/rafiq-build/v11/src && ARTIFACTS=\$HOME/rafiq-build/v11/artifacts OUT=\$HOME/rafiq-build/v11/out OS_VERSION=$(quote "$version") bash -c $(quote "$cmd")" || status=$?
run mkdir -p "$repo/remote-out"
copy_status=0
run rsync -az "$box:rafiq-build/v11/out/" "$repo/remote-out/" || copy_status=$?
# Preserve a failing test's status; otherwise report failed result retrieval.
[ "$status" -ne 0 ] || status=$copy_status
exit "$status"
