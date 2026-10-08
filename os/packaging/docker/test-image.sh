#!/usr/bin/env bash
# test-image.sh TAG [FAKE_PROVIDER_JSON] — the built jarvis-agent image:
# non-root, no helper, no package tool, no setuid; with a fake-provider script
# (real debs), one turn with a safe tool through the CLI on a read-only root.
set -euo pipefail
tag=$1 fake=${2:-}
failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
run() { docker run --rm --platform linux/amd64 "$@"; }
in_image() { run --entrypoint sh "$tag" -c "$1"; }

check "runs as uid 10001" test "$(run --entrypoint id "$tag" -u)" = 10001
check "no root helper, no polkit, no helper bus policy" in_image \
  'test ! -e /usr/libexec/jarvis/jarvis-helper && test ! -e /usr/share/polkit-1 && test ! -e /usr/share/dbus-1/system.d/os.jarvis.Helper1.conf'
check "no package tool server" in_image 'test ! -e /usr/lib/jarvis/mcp/jarvis-pkg'
check "no setuid/setgid files" test -z "$(in_image 'find / -xdev -type f -perm /6000 2>/dev/null')"
check "no jarvisd systemd unit" in_image 'test ! -e /usr/lib/systemd/user/jarvisd.service'
check "read-only tool profile set" in_image 'test "$JARVIS_TOOL_PROFILE" = readonly'
size=$(docker image inspect -f '{{.Size}}' "$tag")
check "image under 400 MB ($((size / 1048576)) MB)" test "$size" -lt 419430400

if [ -n "$fake" ]; then
  check "diag server, client and node present" in_image \
    'test -x /usr/lib/jarvis/mcp/jarvis-diag && test -x /usr/bin/jarvis && test -x /usr/lib/jarvis/node/bin/node'
  abs=$(cd "$(dirname "$fake")" && pwd)/$(basename "$fake")
  out=$(run --read-only --tmpfs /tmp --tmpfs /home/jarvis:uid=10001,gid=10001,mode=0700 \
    -e JARVIS_FAKE_PROVIDER=/fake.json -v "$abs:/fake.json:ro" "$tag" ask "check health" 2>&1 || true)
  check "one turn with a safe tool on a read-only root" grep -q 'agent-test-health-done' <<<"$out"
  [ "$failures" -eq 0 ] || printf '%s\n' "$out" >&2
fi
if [ "$failures" -gt 0 ]; then echo "$failures failure(s)" >&2; exit 1; fi
echo "all passed"
