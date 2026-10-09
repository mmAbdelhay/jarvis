#!/usr/bin/env bash
# Inside the stock image, as root (install-test.sh). No systemd runs here.
set -euo pipefail
level=${1:-deps}
case $level in deps | chat) ;; *) echo "invalid level: $level" >&2; exit 2 ;; esac
failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
absent() { ! installed "$1"; }
# shellcheck source=/dev/null
. /etc/os-release
distro_id=$ID pretty=$PRETTY_NAME
cp /etc/os-release /tmp/os-release.before

apt-get update -qq
if [ "$level" = deps ]; then
  # Stub jarvisd (os/iso/dev/stub-debs.sh) has no Depends but keeps the real
  # postinst (systemctl --global enable); the real jarvisd depends on systemd.
  apt-get install -y -qq --no-install-recommends systemd >/dev/null
fi
mkdir -p /tmp/debs
for p in jarvis-agent jarvisd jarvis-pkg jarvis-diag jarvis-helper jarvis-cli jarvis-archive-keyring; do cp /debs/"${p}"_*.deb /tmp/debs/; done
chmod 0644 /tmp/debs/*.deb
if apt-get install -y -qq --no-install-recommends /tmp/debs/*.deb >/tmp/apt.log 2>&1; then
  pass "apt installs jarvis-agent and its six packages on $pretty"
else
  tail -n 40 /tmp/apt.log >&2; fail "apt install on $pretty"; exit 1
fi
for p in jarvis-agent jarvisd jarvis-pkg jarvis-diag jarvis-helper jarvis-cli jarvis-archive-keyring; do check "$p installed" installed "$p"; done
for p in jarvis-shell jarvis-ui jarvis-branding jarvis-greeter labwc greetd; do check "$p not pulled in" absent "$p"; done
check "jarvis on PATH" test "$(command -v jarvis)" = /usr/bin/jarvis
check "os-release untouched (no branding)" cmp -s /tmp/os-release.before /etc/os-release
check "stock distro ID retained" test "$(. /etc/os-release && echo "$ID")" = "$distro_id"
check "jarvis-admins group exists" getent group jarvis-admins
check "jarvisd enabled for every user" test -L /etc/systemd/user/default.target.wants/jarvisd.service
check "no user is added to jarvis-admins" test -z "$(getent group jarvis-admins | cut -d: -f4)"

if [ "$level" = chat ]; then
  for f in /usr/lib/jarvis/node/bin/node /usr/lib/jarvis/daemon/jarvisd.mjs /usr/lib/jarvis/cli/jarvis.mjs \
    /usr/lib/jarvis/mcp/jarvis-pkg /usr/lib/jarvis/mcp/jarvis-diag /usr/libexec/jarvis/jarvis-helper; do
    check "$f present" test -s "$f"
  done
  check "bundled node runs on $pretty" /usr/lib/jarvis/node/bin/node -e 'process.exit(0)'
  useradd -m -s /bin/bash tester
  install -o tester -m 0644 /agent-test/fake-provider.json /home/tester/fake.json
  install -d -o tester -m 0700 /tmp/xdg-tester
  if runuser -u tester -- env HOME=/home/tester XDG_RUNTIME_DIR=/tmp/xdg-tester \
    dbus-run-session -- bash /agent-test/chat-checks.sh; then
    pass "chat, safe tool and terminal card as a normal user"
  else
    fail "chat checks (see FAIL lines above)"
  fi
fi

if apt-get purge -y -qq jarvis-agent jarvis-cli jarvisd jarvis-pkg jarvis-diag jarvis-helper jarvis-archive-keyring >/tmp/purge.log 2>&1; then
  pass "purge"
else
  tail -n 40 /tmp/purge.log >&2; fail "purge"
fi
for p in jarvis-agent jarvisd jarvis-pkg jarvis-diag jarvis-helper jarvis-cli jarvis-archive-keyring; do check "$p purged" absent "$p"; done
check "no /usr/lib/jarvis left" test ! -e /usr/lib/jarvis
check "no /usr/bin/jarvis left" test ! -e /usr/bin/jarvis
check "jarvisd no longer enabled" test ! -L /etc/systemd/user/default.target.wants/jarvisd.service
if [ "$failures" -gt 0 ]; then echo "$failures failure(s) on $pretty" >&2; exit 1; fi
echo "all passed on $pretty"
