package validate

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	usernameRe = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	diskRe     = regexp.MustCompile(`^/dev/(sd[a-z]{1,2}|mmcblk[0-9]{1,2})$`)
	labelRe    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9 _-]*$`)
)

// reservedUsers are system account names the helper never creates or
// removes even if they are missing from /etc/passwd.
var reservedUsers = map[string]bool{
	"root": true, "daemon": true, "bin": true, "sys": true, "sync": true, "games": true, "man": true,
	"lp": true, "mail": true, "news": true, "uucp": true, "proxy": true, "www-data": true, "backup": true,
	"list": true, "irc": true, "nobody": true, "messagebus": true, "polkitd": true, "sshd": true,
	"ollama": true, "greeter": true, "_apt": true,
}

// Username checks a new or existing login name (Debian's NAME_REGEX,
// 1-32 characters, never a system account name).
func Username(s string) error {
	if !usernameRe.MatchString(s) || strings.HasSuffix(s, "-") {
		return invalid("%q is not a user name (lowercase letters, digits, - and _, at most 32)", s)
	}
	if reservedUsers[s] || strings.HasPrefix(s, "systemd-") {
		return invalid("%q is a system account name", s)
	}
	return nil
}

// FullName checks the GECOS full name: at most 64 characters of plain
// text without the separators of /etc/passwd (: , =) or a backslash.
func FullName(s string) error {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > 64 {
		return invalid("a full name has at most 64 characters")
	}
	if strings.ContainsAny(s, ":,=\\") || strings.HasPrefix(s, "-") {
		return invalid("a full name may not contain : , = or \\ or start with -")
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			return invalid("a full name may not contain control characters")
		}
	}
	return nil
}

// WholeDisk checks a whole-disk device path of a USB/SD drive
// (/dev/sdX or /dev/mmcblkN; never a partition, NVMe or a loop device).
func WholeDisk(s string) error {
	if !diskRe.MatchString(s) {
		return invalid("%q is not a whole USB or SD drive like /dev/sdb or /dev/mmcblk0", s)
	}
	return nil
}

// FSTypes are the filesystems FormatRemovable makes.
var FSTypes = []string{"exfat", "vfat", "ext4"}

// FSLabel checks a filesystem label for fs and returns it as it will be
// written (FAT labels are upper case). "" means no label.
func FSLabel(fs, label string) (string, error) {
	max := map[string]int{"exfat": 15, "vfat": 11, "ext4": 16}[fs]
	if max == 0 {
		return "", invalid("filesystem must be exfat, vfat or ext4")
	}
	if label == "" {
		return "", nil
	}
	if len(label) > max || !labelRe.MatchString(label) {
		return "", invalid("a %s label has at most %d letters, digits, spaces, - or _", fs, max)
	}
	if fs == "vfat" {
		label = strings.ToUpper(label)
	}
	return label, nil
}

// Password checks a password handed to the helper (the administrator's own,
// or the new account's). It never echoes the value. At most 128 bytes, no
// newline, carriage return or NUL: those would end the line chpasswd reads
// or the NUL-terminated token unix_chkpwd reads.
func Password(s string) error {
	if s == "" || len(s) > 128 || !utf8.ValidString(s) || strings.ContainsAny(s, "\n\r\x00") {
		return invalid("a password is 1 to 128 characters without line breaks")
	}
	return nil
}
