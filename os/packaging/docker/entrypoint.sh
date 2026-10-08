#!/bin/sh
# Start jarvisd in the background, wait for its control socket, then run the
# jarvis client in the foreground with the container's arguments.
set -e
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/jarvis-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"
log="$XDG_RUNTIME_DIR/jarvisd.log"
/usr/lib/jarvis/node/bin/node /usr/lib/jarvis/daemon/jarvisd.mjs run >"$log" 2>&1 &
i=0
while [ ! -S "$HOME/.config/jarvis/run/jarvisd.sock" ]; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then
    echo "jarvis-agent: jarvisd did not start" >&2
    tail -n 50 "$log" >&2
    exit 1
  fi
  sleep 0.1
done
exec jarvis "$@"
