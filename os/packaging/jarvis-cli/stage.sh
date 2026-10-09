#!/usr/bin/env bash
# Stage jarvis-cli: Plan K's single-file bundle (M2.5 contracts §5, §7.13), run
# by jarvisd's bundled Node through /usr/bin/jarvis.
set -euo pipefail
stage=$1
dist=${CLI_DIST:-$REPO_ROOT/packages/cli/dist-cli}
hint="pnpm --filter @jarvis/cli build (M2.5 contracts §7.13)"
if [ ! -f "$dist/jarvis.mjs" ]; then
  echo "jarvis-cli: missing $dist/jarvis.mjs" >&2
  echo "  produced by: $hint" >&2
  exit 1
fi
if [ -e "$dist/node_modules" ]; then
  echo "jarvis-cli: $dist has node_modules; the bundle must be one file, like jarvisd's" >&2
  exit 1
fi
install -D -m0644 "$dist/jarvis.mjs" "$stage/usr/lib/jarvis/cli/jarvis.mjs"
if [ -f "$dist/jarvis.mjs.map" ]; then
  install -D -m0644 "$dist/jarvis.mjs.map" "$stage/usr/lib/jarvis/cli/jarvis.mjs.map"
fi
mkdir -p "$stage/usr/bin"
cat > "$stage/usr/bin/jarvis" <<'LAUNCHER'
#!/bin/sh
# Jarvis terminal client (package jarvis-cli) on jarvisd's bundled Node.
exec /usr/lib/jarvis/node/bin/node /usr/lib/jarvis/cli/jarvis.mjs "$@"
LAUNCHER
chmod 0755 "$stage/usr/bin/jarvis"
