#!/bin/bash
# Rafiq v1.1 plan U: build jarvis-cu + its end-to-end test for linux/amd64
# and run them in debian:trixie under a headless labwc 0.8.3.
#   ci/cu-headless.sh               build, then run (needs Go and Docker)
#   ci/cu-headless.sh --build-only  build into $CU_E2E_DIR (dev Mac)
#   ci/cu-headless.sh --run-only    run what is in $CU_E2E_DIR (Linux box / CI)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
gomod="$(cd "$here/.." && pwd)"
out="${CU_E2E_DIR:-$gomod/dist-cu-e2e}"
mode="${1:-}"
case "$mode" in ""|--build-only|--run-only) ;; *) echo "usage: $0 [--build-only|--run-only]" >&2; exit 2 ;; esac
[ "$#" -le 1 ] || { echo "too many arguments" >&2; exit 2; }
if [ "$mode" != "--run-only" ]; then
  mkdir -p "$out"
  (cd "$gomod" &&
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$out/jarvis-cu" ./cmd/jarvis-cu &&
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go test -c -o "$out/cu-e2e.test" ./internal/cu/e2e)
  cp "$here/cu-headless-inner.sh" "$out/"
fi
[ "$mode" = "--build-only" ] && { echo "built into $out"; exit 0; }
perl -e 'alarm 900; exec @ARGV' docker run --rm -v "$out:/work:ro" debian:trixie bash /work/cu-headless-inner.sh
