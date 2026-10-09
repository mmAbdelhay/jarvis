package install

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Pure renderers for every file the configure and bootloader steps write.
// Tests compare their output byte for byte.

const mapperName = "jarvis-root"

// bootLabel names the separate /boot: its ext4 label and GPT name.
const bootLabel = "Rafiq boot"

// renderFstab: bootUUID "" means no separate /boot (unencrypted installs).
func renderFstab(rootUUID, bootUUID, espUUID, swapUUID string) string {
	var b strings.Builder
	b.WriteString("# /etc/fstab: written by the Rafiq installer.\n")
	fmt.Fprintf(&b, "UUID=%s / ext4 errors=remount-ro 0 1\n", rootUUID)
	if bootUUID != "" {
		fmt.Fprintf(&b, "UUID=%s /boot ext4 defaults 0 2\n", bootUUID)
	}
	fmt.Fprintf(&b, "UUID=%s /boot/efi vfat umask=0077 0 1\n", espUUID)
	if swapUUID != "" {
		fmt.Fprintf(&b, "UUID=%s none swap sw 0 0\n", swapUUID)
	}
	b.WriteString("/swapfile none swap sw 0 0\n")
	return b.String()
}

// renderCrypttab: "initramfs" makes cryptsetup-initramfs include the
// device even when its root-device detection runs inside a chroot;
// "tries=0" retries the passphrase forever, so wrong passphrases never end
// in an emergency shell (design §3 criterion 2, Plan H).
func renderCrypttab(luksUUID string) string {
	return fmt.Sprintf("# <target name> <source device> <key file> <options>\n%s UUID=%s none luks,discard,initramfs,tries=0\n", mapperName, luksUUID)
}

const cryptsetupConfHook = "# Written by the Rafiq installer: the root file system is encrypted.\nCRYPTSETUP=y\n"

func renderHosts(hostname string) string {
	return fmt.Sprintf("127.0.0.1\tlocalhost\n127.0.1.1\t%s\n\n::1\tlocalhost ip6-localhost ip6-loopback\nff02::1\tip6-allnodes\nff02::2\tip6-allrouters\n", hostname)
}

func renderLocaleGen(locale string) string {
	charset := locale[strings.LastIndexByte(locale, '.')+1:]
	out := locale + " " + charset + "\n"
	if locale != "en_US.UTF-8" {
		out += "en_US.UTF-8 UTF-8\n"
	}
	return out
}

func renderDefaultLocale(locale string) string { return "LANG=" + locale + "\n" }

// renderKeyboard writes /etc/default/keyboard from "us" or "us(intl)".
func renderKeyboard(kb string) string {
	layout, variant, _ := strings.Cut(strings.TrimSuffix(kb, ")"), "(")
	return fmt.Sprintf("XKBMODEL=\"pc105\"\nXKBLAYOUT=\"%s\"\nXKBVARIANT=\"%s\"\nXKBOPTIONS=\"\"\nBACKSPACE=\"guess\"\n", layout, variant)
}

// greetdAutologin edits the packaged /etc/greetd/config.toml (owned by
// jarvis-greeter, Plan H): any [initial_session] section is removed (the
// live ISO must never leave its own autologin behind), and with autologin
// one is appended for the new user. Everything else is kept byte for byte.
func greetdAutologin(conf, username string, autologin bool) string {
	var keep []string
	skipping := false
	var separator string
	for _, line := range strings.SplitAfter(conf, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "[") {
			if skipping && t != "[initial_session]" {
				keep = append(keep, separator)
			}
			separator = ""
			skipping = t == "[initial_session]"
			if skipping && len(keep) > 0 && keep[len(keep)-1] == "\n" {
				keep = keep[:len(keep)-1]
			}
		}
		if !skipping {
			keep = append(keep, line)
		} else if t == "" {
			separator += line
		} else {
			separator = ""
		}
	}
	out := strings.Join(keep, "")
	if autologin {
		if out != "" && !strings.HasSuffix(out, "\n") {
			out += "\n"
		}
		out += fmt.Sprintf("\n[initial_session]\ncommand = \"labwc\"\nuser = %q\n", username)
	}
	return out
}

// renderGrub is /etc/default/grub.d/jarvis.cfg. Debian turns os-prober off
// by default; dual boot needs it on and a visible menu (design §7).
func renderGrub(dualBoot bool) string {
	timeout, style := "0", "hidden"
	if dualBoot {
		timeout, style = "3", "menu"
	}
	return "# Written by the Rafiq installer.\n" +
		"GRUB_DISTRIBUTOR=\"Rafiq\"\n" +
		"GRUB_CMDLINE_LINUX_DEFAULT=\"quiet splash\"\n" +
		"GRUB_DISABLE_OS_PROBER=false\n" +
		"GRUB_TIMEOUT=" + timeout + "\n" +
		"GRUB_TIMEOUT_STYLE=" + style + "\n" +
		"GRUB_THEME=/usr/share/grub/themes/jarvis/theme.txt\n"
}

// renderJarvisYAML is the provider section jarvisd reads (M2 contracts §6,
// packages/desktop/src/daemon/os/provider-config.ts). Strings are JSON
// quoted, which is valid YAML and safe for "qwen3:8b".
// renderJarvisYAML: kind "" (a cloud brain, set up after the first login)
// leaves the provider out; lang "" leaves os.language to jarvisd's LANG default.
func renderJarvisYAML(kind, baseURL, model, lang string) string {
	q := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	out := "# Written by the Rafiq installer. Change it in Settings.\n"
	if kind != "" {
		out += "provider:\n  kind: " + kind + "\n  baseUrl: " + q(baseURL) + "\n  model: " + q(model) + "\n"
	}
	if lang != "" {
		out += "os:\n  language: " + lang + "\n"
	}
	return out
}
