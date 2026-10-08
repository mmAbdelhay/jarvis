#!/usr/bin/env bash
# The offline backup-model test (Linux CI only) is wired right; checked statically anywhere.
source "$(dirname "$0")/lib.sh"
b=$PACKAGING_DIR/backup
check "offline-chat.sh parses" bash -n "$b/offline-chat.sh"
check "in-container.sh parses" bash -n "$b/in-container.sh"
check "offline-chat.sh executable" test -x "$b/offline-chat.sh"
check "unprivileged container" bash -c "! grep -q -- '--privileged' '$b/offline-chat.sh'"
check "network cut before the question" python3 - "$b/offline-chat.sh" <<'PY'
import sys
t = open(sys.argv[1]).read()
assert t.index("docker network disconnect") < t.index("in-container.sh"), "disconnect must come first"
PY
check "in-container refuses to run with a network" grep -q 'still has a network' "$b/in-container.sh"
check "check_chat.py parses" python3 -c 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' "$b/check_chat.py"
check "asks in English and in Arabic" python3 - "$b/check_chat.py" <<'PY'
import sys
t = open(sys.argv[1], encoding="utf-8").read()
assert "internet connection" in t and "هل اتصالي بالإنترنت" in t
PY
finish
