# Fixture provenance

Every parser runs against one of these files. "captured" = real output from a
`debian:trixie` amd64 container (2026-10-07). "reconstructed" = written to the
documented format because the tool needs hardware or a running service a
container lacks; re-capture these on a Debian 13 VM (commands below, run with
`LC_ALL=C.UTF-8 TZ=UTC`) and keep the tests green.

| File | Command | Source |
|---|---|---|
| apt-cache-search-vlc.txt | `apt-cache search -- vlc` | captured |
| apt-cache-show.txt | `apt-cache show --no-all-versions -- vlc vlc-bin` | captured |
| flatpak-remote-info.txt | `flatpak remote-info --system flathub org.videolan.VLC` (no UTF-8 locale: the size separator is `?`) | captured |
| flatpak-info-spotify.txt | `flatpak info --system com.spotify.Client` | reconstructed |
| vlc.desktop | `/usr/share/applications/vlc.desktop` | reconstructed |
| df.txt | `df -B1 --output=target,size,used -x tmpfs -x devtmpfs -x squashfs -x efivarfs` | reconstructed |
| proc-meminfo.txt | `cat /proc/meminfo` (trimmed) | reconstructed |
| journal.json | `journalctl -q --no-pager -o json -n 7` (plus a byte-array, multi-value, null and non-JSON line) | reconstructed |
| systemctl-list-units-failed.txt | `systemctl list-units --failed --plain --no-legend --no-pager` | reconstructed |
| systemctl-show.txt | `systemctl show -p Id,LoadState,ActiveState,SubState,Result,StateChangeTimestamp -- crashy.service docker.socket never-ran.service` | reconstructed |
| nmcli-general.txt | `nmcli -t -f RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI general status` | reconstructed |
| nmcli-device-status.txt | `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status` | reconstructed |
| nmcli-wifi-list.txt | `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list --rescan auto` | reconstructed |
| nmcli-connections.txt | `nmcli -t -f NAME,TYPE connection show` | reconstructed |
| ip-addr.json | `ip -j addr show` | reconstructed |
| ip-route-default.json | `ip -j route show default` | reconstructed (shape matches a captured container route) |
| rfkill.json | `rfkill --json --output TYPE,SOFT,HARD` | reconstructed |
| lspci-k.txt | `lspci -k` (QEMU q35 + an Intel Wi-Fi card with no bound driver) | reconstructed |
| lsusb.txt | `lsusb` | reconstructed |
