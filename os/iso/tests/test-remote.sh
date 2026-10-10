#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
r=$ISO_DIR/dev/remote.sh
check "remote.sh parses" bash -n "$r"
check "remote.sh executable" test -x "$r"
check "no host address is committed" bash -c '! grep -nE "[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" "$1"' _ "$r"
check "refuses without host" bash -c 'env -u JARVIS_LINUX_BOX "$1" -- true 2>/dev/null; [ $? -eq 2 ]' _ "$r"
for args in '--artifact x' '--run-id' '--artifact' '--run-id 42 --artifact' ''; do
  # Intentional splitting exercises malformed option lists.
  # shellcheck disable=SC2086
  check "rejects malformed options: $args" bash -c 'JARVIS_LINUX_BOX=me@box "$1" "${@:2}" 2>/dev/null; [ $? -eq 2 ]' _ "$r" $args
 done
out=$(JARVIS_LINUX_BOX=me@box "$r" --dry-run --run-id 42 --artifact debs-go --artifact debs-qt -- 'echo "$ARTIFACTS"') || out=''
check "copies worktree to permitted directory" grep -q '^+ rsync .*me@box:rafiq-build/v11/src/' <<<"$out"
check "downloads each artifact" test "$(grep -c '^+ gh run download 42' <<<"$out")" -eq 2
check "exports ARTIFACTS and OUT" grep -q 'ARTIFACTS=.*OUT=' <<<"$out"
check "brings OUT back" grep -q 'me@box:rafiq-build/v11/out/' <<<"$out"
check "batch SSH" grep -q '^+ ssh -o BatchMode=yes' <<<"$out"
check "worktree git pointer excluded" grep -q '\.git' <<<"$out"
# Fake transport boundaries; execute the runner's actual remote shell command
# locally and ensure quotes/newlines are preserved and results survive failure.
tmp=$(mktmp)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home"
cat > "$tmp/bin/ssh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${@: -1}" >> "$TRACE"
case ${*: -1} in
  *'bash -c'*) HOME="$FAKE_HOME" sh -c "${*: -1}" ;;
  *) mkdir -p "$FAKE_HOME/rafiq-build/v11/"{src,out,artifacts} ;;
esac
SH
cat > "$tmp/bin/rsync" <<'SH'
#!/usr/bin/env bash
printf 'rsync %s\n' "$*" >> "$TRACE"
SH
# Dry runs must not allocate local artifact storage or contact transports.
cat > "$tmp/bin/mktemp" <<'SH'
#!/usr/bin/env bash
printf 'mktemp\n' >> "$TRACE"
exit 99
SH
chmod +x "$tmp/bin/"*
dry_status=0
PATH="$tmp/bin:$PATH" TRACE="$tmp/dry-trace" JARVIS_LINUX_BOX=me@box "$r" --dry-run --run-id 42 --artifact debs-go -- true > "$tmp/dry-output" || dry_status=$?
check "dry run succeeds without allocating artifact storage" test "$dry_status" -eq 0
check "dry run invokes no external side effects" test ! -e "$tmp/dry-trace"
status=0
PATH="$tmp/bin:$PATH" TRACE="$tmp/trace" FAKE_HOME="$tmp/home" JARVIS_LINUX_BOX=me@box "$r" -- 'printf "%s\n" "it is a quote: '\'' and \$HOME" > "$OUT/result"; exit 7' || status=$?
check "preserves command status" test "$status" -eq 7
check "remote quoting preserves literal text" grep -qx "it is a quote: ' and \$HOME" "$tmp/home/rafiq-build/v11/out/result"
check "fetches output after failure" grep -q 'rsync .*me@box:rafiq-build/v11/out/' "$tmp/trace"
finish
