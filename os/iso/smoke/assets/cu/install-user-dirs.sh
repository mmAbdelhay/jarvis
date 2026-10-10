#!/bin/sh
# install-user-dirs.sh HOME — the XDG user folders for the computer-use GUI
# tests, as xdg-user-dirs-update writes them on a desktop install: GTK's
# file chooser then lists Pictures in its sidebar, where the scripted model
# clicks it in GIMP's Export Image dialog. The ISO does not ship
# xdg-user-dirs, so the test sets them up.
set -eu
home=$1
mkdir -p "$home/.config" "$home/Documents" "$home/Pictures"
cat > "$home/.config/user-dirs.dirs" <<'DIRS'
XDG_DOCUMENTS_DIR="$HOME/Documents"
XDG_PICTURES_DIR="$HOME/Pictures"
DIRS
