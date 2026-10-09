#!/usr/bin/env bash
# 0100-flathub.hook.chroot: the remote is a hard requirement, appstream is not.
source "$(dirname "$0")/lib.sh"
hook=$ISO_DIR/config/hooks/normal/0100-flathub.hook.chroot
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# fakes FLATPAK_UPDATE_STATUS REMOTE_ADD_STATUS
fakes() {
  cat > "$tmp/bin/flatpak" <<EOT
#!/bin/sh
echo "flatpak \$*" >> "$tmp/calls"
case "\$1" in
  remote-add) exit $2 ;;
  remotes) echo flathub ;;
  update) exit $1 ;;
esac
EOT
  printf '#!/bin/sh\necho "systemctl $*" >> "%s/calls"\n' "$tmp" > "$tmp/bin/systemctl"
  chmod +x "$tmp/bin/flatpak" "$tmp/bin/systemctl"
  rm -f "$tmp/calls"
}
run_hook() { PATH="$tmp/bin:$PATH" FLATHUB_RETRY_DELAY=0 sh "$hook" 2>"$tmp/err"; }

fakes 0 0
check "appstream fetched: hook succeeds" run_hook
check "first-boot unit enabled anyway" grep -qx 'systemctl enable jarvis-flathub-appstream.service' "$tmp/calls"
check "no warning when it worked" bash -c "! grep -q JARVIS-BUILD-WARNING '$tmp/err'"

fakes 1 0
check "Flathub appstream down: build continues" run_hook
check "tried 3 times" test "$(grep -c '^flatpak update' "$tmp/calls")" = 3
check "warning for the build log" grep -q '^JARVIS-BUILD-WARNING: Flathub appstream' "$tmp/err"
check "first-boot unit enabled" grep -qx 'systemctl enable jarvis-flathub-appstream.service' "$tmp/calls"

fakes 0 1
check "no Flathub remote fails the build" bash -c "! PATH='$tmp/bin:$PATH' FLATHUB_RETRY_DELAY=0 sh '$hook' 2>/dev/null"

finish
