#!/usr/bin/env bash
# No H-owned file hard-codes the distro name (coordinator directive 2026-10-08).
source "$(dirname "$0")/lib.sh"
lint=$BRANDING_DIR/tools/name-lint.py
fx=$TESTS_DIR/fixtures/lint
check "the repository is clean" python3 "$lint" --root "$REPO_ROOT"
check "a hard-coded name is caught" bash -c "! python3 '$lint' --root '$fx/bad' >/dev/null"
out=$(python3 "$lint" --root "$fx/bad" || true)
check "report names file and line" grep -q '^os/iso/x.sh:3: ' <<<"$out"
check "legacy variants and the current name caught" test "$(wc -l <<<"$out")" -eq 4
check "current name caught" grep -q '^os/iso/x.sh:6: ' <<<"$out"
check "comments, Markdown, tests and spec paths allowed" python3 "$lint" --root "$fx/good"
finish
