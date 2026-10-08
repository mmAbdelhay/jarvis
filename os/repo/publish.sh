#!/usr/bin/env bash
# publish.sh --site DIR --remote URL [--branch main] --message TEXT
# Replace the Pages repo's branch with one orphan commit holding DIR.
set -euo pipefail
site="" remote="" branch=main message=""
while [ $# -gt 0 ]; do
  case $1 in
    --site) site=$2; shift 2 ;;
    --remote) remote=$2; shift 2 ;;
    --branch) branch=$2; shift 2 ;;
    --message) message=$2; shift 2 ;;
    *) echo "publish: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -d "$site" ] || { echo "publish: no site at $site" >&2; exit 1; }
[ -n "$remote" ] && [ -n "$message" ] || { echo "publish: --remote and --message are required" >&2; exit 2; }
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cp -a "$site/." "$work/"
git -C "$work" init -q -b "$branch"
git -C "$work" add -A
git -C "$work" -c user.name="repo-bot" -c user.email="repo-bot@users.noreply.github.com" commit -q -m "$message"
git -C "$work" push -q --force "$remote" "$branch:$branch"
echo "publish: $remote $branch"
