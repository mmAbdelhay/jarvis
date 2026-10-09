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

### M2 Plan F additions (2026-10-08)

Disk fixtures supplied by the Task 1 plan were captured in a `golang:1.24-trixie` container run with
`--privileged` on a 64 GiB sparse file attached with `losetup -P`, laid out
like a Windows 11 disk: `sgdisk --new=1:0:+100M --typecode=1:ef00
--change-name=1:'EFI system partition' --new=2:0:+16M --typecode=2:0c01
--change-name=2:'Microsoft reserved partition' --new=3:0:-1G --typecode=3:0700
--change-name=3:'Basic data partition' --new=4:0:0 --typecode=4:2700
--attributes=4:set:0`, then `mkfs.vfat -F 32 -n SYSTEM p1`, `mkntfs -Q -L
Windows p3`, `mkntfs -Q -L Recovery p4`. No udev runs in a container, so
partition nodes were made with `mknod` from `/sys/block/loopN/loopNpM/dev`.

| File | Command | Source |
|---|---|---|
| sgdisk-p-windows.txt | `sgdisk -p /dev/loop1` (Windows layout above) | captured |
| sgdisk-p-empty.txt | `sgdisk -p /dev/loop1` on a blank 16 GiB file | captured |
| lsblk-windows.json | `lsblk -J -l -b -o PATH,PKNAME,TYPE,SIZE,MODEL,RM,RO,LOG-SEC /dev/loop1` | captured |
| blkid-esp.txt, blkid-msr.txt, blkid-ntfs.txt, blkid-recovery.txt | `blkid -p -o export /dev/loop1pN` | captured |
| blkid-bitlocker.txt | same, after `printf -- -FVE-FS- \| dd of=p4 bs=1 seek=3 conv=notrunc` | captured |
| blkid-luks.txt | same, after `cryptsetup luksFormat --type luks2 --pbkdf argon2id --batch-mode --key-file=-` | captured |
| blkid-ext4.txt | `blkid -p -o export /dev/mapper/jtest` after `mkfs.ext4 -F -q -L jarvis-root` | captured |
| ntfsresize-info-clean.txt | `ntfsresize --info --no-progress-bar p3` | captured |
| ntfsresize-info-dirty.txt | same, after a real `ntfsresize --size` (which schedules chkdsk) | captured |
| ntfsresize-info-bitlocker.txt | same, on the BitLocker-signed p4 | captured |
| efibootmgr.txt | `efibootmgr` (efibootmgr 18, tab before the device path) | reconstructed |
| proc-mounts-live.txt | `cat /proc/mounts` on the live ISO (trimmed) | reconstructed |
| proc-swaps.txt | `cat /proc/swaps` | reconstructed |

Hibernation is NOT visible to `ntfsresize --info` (libntfs-3g checks
`hiberfil.sys` only on read-write mounts), so the probe mounts the volume
read-only with the kernel `ntfs3` driver and reads the first 4 bytes of
`hiberfil.sys` ("HIBR"/"hibr" = hibernated or Fast Startup). Verified in the
same container: `mount -t ntfs3 -o ro` of an image with an `HIBR` hiberfil
succeeds and `head -c 4` reads `HIBR`.

Local capture/re-capture with loop devices, privileged mounts, or QEMU is
CI-only, not run. Fixtures were copied from the supplied plan; the
reconstructed distro label is Rafiq.
