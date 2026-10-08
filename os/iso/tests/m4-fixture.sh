# shellcheck shell=bash
# m4_fixture CHROOT — the Rafiq M4 pieces verify-m4.sh expects, for test chroots.
M4_PKGS="jarvis-backup-model jarvis-classic jarvis-session jarvis-fonts jarvis-i18n jarvis-recipes pcmanfm-qt fonts-noto-core fonts-ibm-plex"
M4_QM_MAGIC='\x3c\xb8\x64\x18\xca\xef\x9c\x95\xcd\x21\x1c\xbf\x60\xa1\xbd\xdd'
m4_fixture() {
  local c=$1 p comp lang r f
  mkdir -p "$c/var/lib/dpkg" "$c/etc/xdg/labwc" "$c/usr/share/wayland-sessions" "$c/usr/libexec/jarvis" \
    "$c/usr/bin" "$c/usr/share/jarvis-session/labwc" "$c/usr/share/jarvis-shell" "$c/etc/fonts/conf.d" \
    "$c/usr/share/fonts/truetype/noto" "$c/usr/share/jarvis/i18n" "$c/usr/share/jarvis/recipes" "$c/usr/lib/locale"
  for p in $M4_PKGS; do
    printf 'Package: %s\nStatus: install ok installed\nVersion: 0.4.0~test\n\n' "$p" >> "$c/var/lib/dpkg/status"
  done
  printf 'Exec=/usr/libexec/jarvis/jarvis-session full\n' > "$c/usr/share/wayland-sessions/rafiq.desktop"
  printf 'Exec=/usr/libexec/jarvis/jarvis-session classic\n' > "$c/usr/share/wayland-sessions/rafiq-classic.desktop"
  for f in jarvis-session jarvis-shell-guard jarvis-session-key; do install -m0755 /dev/null "$c/usr/libexec/jarvis/$f"; done
  install -m0755 /dev/null "$c/usr/bin/jarvis-classic"
  install -m0755 /dev/null "$c/usr/share/jarvis-shell/jarvis-shell-loop"
  echo 'JARVIS_SHELL_BIN=/usr/libexec/jarvis/jarvis-shell-guard /usr/share/jarvis-shell/jarvis-shell-loop &' \
    > "$c/usr/share/jarvis-session/labwc/autostart"
  grep -qx '. /usr/share/jarvis-session/labwc/autostart' "$c/etc/xdg/labwc/autostart" 2>/dev/null ||
    echo '. /usr/share/jarvis-session/labwc/autostart' >> "$c/etc/xdg/labwc/autostart"
  grep -q 'jarvis-session-key --focus' "$c/etc/xdg/labwc/rc.xml" 2>/dev/null ||
    echo '<keybind key="Super_L" onRelease="yes"><action name="Execute" command="/usr/libexec/jarvis/jarvis-session-key --focus" />' >> "$c/etc/xdg/labwc/rc.xml"
  mkdir -p "$c/etc/xdg/labwc-classic"
  echo 'JARVIS_SHELL_BIN=/usr/bin/jarvis-classic JARVIS_CLASSIC_BIN=/usr/bin/jarvis-classic /usr/share/jarvis-shell/jarvis-shell-loop &' > "$c/etc/xdg/labwc-classic/autostart"
  echo '<keybind key="Super_L" onRelease="yes"><action name="Execute" command="/usr/libexec/jarvis/jarvis-session-key --focus" />' > "$c/etc/xdg/labwc-classic/rc.xml"
  echo 'QT_QPA_PLATFORM=wayland' > "$c/etc/xdg/labwc-classic/environment"
  # The pinned backup model, as sparse files of the right sizes, in a store owned by "ollama" (= us).
  grep -q '^ollama:' "$c/etc/passwd" 2>/dev/null ||
    echo "ollama:x:$(id -u):$(id -g)::/var/lib/ollama:/usr/sbin/nologin" >> "$c/etc/passwd"
  python3 - "$c" "$REPO_ROOT/os/models/backup-model.lock.json" <<'PY'
import json, sys
from pathlib import Path
c, lock = Path(sys.argv[1]), json.load(open(sys.argv[2]))
store = c / "var/lib/ollama/models"
name, ver = lock["ollamaTag"].rsplit(":", 1)
m = store / "manifests/registry.ollama.ai" / (name if "/" in name else f"library/{name}") / ver
m.parent.mkdir(parents=True, exist_ok=True)
m.write_text("{}")
(store / "blobs").mkdir(parents=True, exist_ok=True)
for b in lock["blobs"]:
    with open(store / "blobs" / b["digest"].replace(":", "-"), "wb") as f:
        f.truncate(b["size"])
PY
  ln -sf ../../../usr/share/fontconfig/conf.avail/65-jarvis-arabic.conf "$c/etc/fonts/conf.d/65-jarvis-arabic.conf"
  for f in NotoNaskhArabic NotoKufiArabic NotoSansArabic; do : > "$c/usr/share/fonts/truetype/noto/$f-Regular.ttf"; done
  for comp in shell installer greeter lock classic; do
    for lang in en ar; do printf "$M4_QM_MAGIC" > "$c/usr/share/jarvis/i18n/jarvis-${comp}_${lang}.qm"; done
  done
  for r in python-dev node-dev docker go-dev media-basics office-basics jarvis-workspace; do
    echo '{}' > "$c/usr/share/jarvis/recipes/$r.json"
  done
  printf 'en_US.UTF-8 UTF-8\nar_EG.UTF-8 UTF-8\n' > "$c/etc/locale.gen"
  echo archive > "$c/usr/lib/locale/locale-archive"
}
