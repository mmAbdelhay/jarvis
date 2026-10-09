#!/usr/bin/env bash
# As the test user inside dbus-run-session: jarvisd with the fake provider
# (M1 contracts §5), then the jarvis CLI (M2.5 contracts §5).
set -euo pipefail
failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
has() { grep -Fq -- "$1" <<<"$2"; }
log=$XDG_RUNTIME_DIR/jarvisd.log
sock=$HOME/.config/jarvis/run/jarvisd.sock
JARVIS_FAKE_PROVIDER=$HOME/fake.json /usr/lib/jarvis/node/bin/node /usr/lib/jarvis/daemon/jarvisd.mjs run >"$log" 2>&1 &
daemon=$!
cleanup() {
  kill "$daemon" 2>/dev/null || true
  wait "$daemon" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for _ in $(seq 300); do [ -S "$sock" ] && break; sleep 0.1; done
if [ ! -S "$sock" ]; then fail "jarvisd listening at $sock"; tail -n 40 "$log" >&2; exit 1; fi
pass "jarvisd listening"

code=0
out=$(timeout 60 jarvis ask "say hello" </dev/null 2>&1) || code=$?
if [ "$code" -eq 0 ]; then pass "jarvis ask exits 0"; else fail "jarvis ask exits 0 (got $code)"; fi
if has agent-test-hello "$out"; then pass "reply printed"; else fail "reply printed: $out"; fi

code=0
out=$(timeout 60 jarvis ask "check health" </dev/null 2>&1) || code=$?
if [ "$code" -eq 0 ]; then pass "safe tool exits 0"; else fail "safe tool exits 0 (got $code)"; fi
if has agent-test-health-done "$out"; then pass "safe tool ran without a prompt"; else fail "safe tool turn: $out"; fi

# The card needs a terminal: script(1) gives the CLI a pty; "d" is offered every
# 2 s until the turn ends (the CLI reads it at the card prompt).
out=$({ for _ in $(seq 25); do sleep 2; printf 'd\n'; done; } |
  { code=0; timeout 60 script -qefc 'jarvis ask "restart printing"' /dev/null 2>&1 || code=$?;
    printf '\nagent-test-terminal-exit=%s\n' "$code"; }) || true
# The writer may receive SIGPIPE after script closes its input. Check the
# terminal command itself rather than treating that expected signal as failure.
if grep -Fxq agent-test-terminal-exit=0 <<<"$out"; then pass "terminal turn exits 0"; else fail "terminal turn exits 0: $out"; fi
if has cups "$out"; then pass "confirm card shown in the terminal"; else fail "card shown: $out"; fi
if has agent-test-after-deny "$out"; then pass "denied at the prompt, the turn went on"; else fail "deny path: $out"; fi

cleanup
if [ "$failures" -gt 0 ]; then { echo "--- jarvisd log"; tail -n 60 "$log"; } >&2; fi
exit "$failures"
