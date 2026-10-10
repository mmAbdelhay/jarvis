#!/usr/bin/env bash
# Run Linux-only Rafiq tests; host is supplied only via JARVIS_LINUX_BOX.
# Usage: remote.sh [--run-id ID --artifact NAME]... [--dry-run] -- 'COMMAND'
# Syncs source/artifacts under ~/<DISTRO_ID>-build/v11 and retrieves OUT to remote-out.
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
# The box's working directory, named from brand.env (contracts §9): ~/$dir.
dir="$(. "$repo/os/branding/brand.env" && printf '%s' "$DISTRO_ID")-build/v11"
run() { if [ "$dry" = 1 ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }
# SSH's login shell need not be bash: use POSIX single-quote escaping.
quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }
version=$(bash "$repo/os/packaging/version.sh")
run ssh -o BatchMode=yes "$box" "mkdir -p ~/$dir/src ~/$dir/artifacts && rm -rf ~/$dir/out && mkdir -p ~/$dir/out"
# A worktree's .git points outside this checkout. Preserve the version via
# OS_VERSION rather than copying unusable metadata from another worktree.
run rsync -az --delete --exclude .git --exclude node_modules --exclude '/out/' \
  --exclude '/remote-out/' --exclude '/.superpowers/' --exclude 'os/*/build/' \
  --exclude 'os/go/dist/' "$repo/" "$box:$dir/src/"
if [ ${#artifacts[@]} -gt 0 ]; then
  if [ "$dry" = 1 ]; then
    local_artifacts='/tmp/remote-artifacts.DRY-RUN'
    run mktemp -d
  else
    local_artifacts=$(mktemp -d)
    trap 'rm -rf "$local_artifacts"' EXIT
  fi
  for a in "${artifacts[@]}"; do run gh run download "$run_id" -n "$a" -D "$local_artifacts"; done
  run ssh -o BatchMode=yes "$box" "rm -rf ~/$dir/artifacts && mkdir -p ~/$dir/artifacts"
  run rsync -az "$local_artifacts/" "$box:$dir/artifacts/"
fi
status=0
run ssh -o BatchMode=yes "$box" "cd ~/$dir/src && ARTIFACTS=\$HOME/$dir/artifacts OUT=\$HOME/$dir/out OS_VERSION=$(quote "$version") bash -c $(quote "$cmd")" || status=$?
run mkdir -p "$repo/remote-out"
copy_status=0
run rsync -az "$box:$dir/out/" "$repo/remote-out/" || copy_status=$?
# Preserve a failing test's status; otherwise report failed result retrieval.
[ "$status" -ne 0 ] || status=$copy_status
exit "$status"
