#!/usr/bin/env bash
# The Docker build context (M2.5 contracts §6): jarvisd + jarvis-diag + cli + archive keyring,
# never the root helper or the package tool. No docker needed.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
mk() { mkdir -p "$tmp/debs"; : > "$tmp/debs/$1"; }
mk jarvisd_1.2.3_amd64.deb; mk jarvis-diag_1.2.3_amd64.deb; mk jarvis-cli_1.2.3_all.deb; mk jarvis-archive-keyring_1.2.3_all.deb
mk jarvis-helper_1.2.3_amd64.deb; mk jarvis-pkg_1.2.3_amd64.deb; mk jarvis-shell_1.2.3_amd64.deb
bi=$PACKAGING_DIR/docker/build-image.sh
ctx=$("$bi" --debs "$tmp/debs" --tag t --context-only "$tmp/ctx")
check "context path printed" test "$ctx" = "$tmp/ctx"
check "exactly the four debs" test "$(ls "$ctx/debs" | tr '\n' ' ')" = "jarvis-archive-keyring_1.2.3_all.deb jarvis-cli_1.2.3_all.deb jarvis-diag_1.2.3_amd64.deb jarvisd_1.2.3_amd64.deb "
check "Dockerfile and entrypoint" bash -c "test -f '$ctx/Dockerfile' && test -f '$ctx/entrypoint.sh'"
df=$PACKAGING_DIR/docker/Dockerfile
check "image asserts no helper" grep -qF 'test ! -e /usr/libexec/jarvis/jarvis-helper' "$df"
check "image drops setuid bits" grep -qF 'chmod a-s' "$df"
check "image runs as uid 10001" grep -qx 'USER 10001:10001' "$df"
check "read-only tool profile (contracts §7 #14)" grep -qF 'JARVIS_TOOL_PROFILE=readonly' "$df"
check "source label for ghcr" grep -qF 'org.opencontainers.image.source="https://github.com/mmAbdelhay/jarvis"' "$df"
check "never pushes" bash -c "! grep -qE 'docker (push|login)' '$bi' '$PACKAGING_DIR/docker/test-image.sh'"
mv "$tmp/debs/jarvis-cli_1.2.3_all.deb" "$tmp/debs/jarvis-cli_1.2.4_all.deb"
check "mixed versions refused" bash -c "! '$bi' --debs '$tmp/debs' --tag t --context-only '$tmp/c2' 2>/dev/null"
rm "$tmp/debs/jarvis-diag_1.2.3_amd64.deb"
check "missing diag refused" bash -c "! '$bi' --debs '$tmp/debs' --tag t --context-only '$tmp/c3' 2>/dev/null"
finish
