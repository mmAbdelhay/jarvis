#!/usr/bin/env bash
# publish.sh: one orphan commit, force-pushed; nothing but the site.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
git init -q --bare "$tmp/remote.git"
mkdir -p "$tmp/site/dists" && echo a > "$tmp/site/dists/x" && touch "$tmp/site/.nojekyll"
"$REPO_DIR/publish.sh" --site "$tmp/site" --remote "$tmp/remote.git" --message "first" >/dev/null
echo b > "$tmp/site/dists/x"
"$REPO_DIR/publish.sh" --site "$tmp/site" --remote "$tmp/remote.git" --message "second" >/dev/null
check "single commit on main" test "$(git --git-dir "$tmp/remote.git" rev-list --count main)" -eq 1
check "latest content" test "$(git --git-dir "$tmp/remote.git" show main:dists/x)" = b
check "dotfiles kept" git --git-dir "$tmp/remote.git" cat-file -e main:.nojekyll
check "message" test "$(git --git-dir "$tmp/remote.git" log -1 --format=%s main)" = second
check "missing site fails" bash -c "! '$REPO_DIR/publish.sh' --site '$tmp/nope' --remote '$tmp/remote.git' --message x 2>/dev/null"
check "runbook never tells anyone to commit a private key" bash -c "! grep -qiE 'git add .*secret|export-secret-keys .*> *os/' '$REPO_DIR/README.md'"
check "runbook names the secrets" bash -c "grep -q JARVIS_APT_SIGNING_KEY '$REPO_DIR/README.md' && grep -q JARVIS_APT_DEPLOY_KEY '$REPO_DIR/README.md'"
finish
