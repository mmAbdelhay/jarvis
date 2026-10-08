// Package validate is the single gate for every name that reaches a
// privileged or system command. Each check is an allowlist of characters,
// never a denylist: anything not provably harmless is refused.
package validate

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ErrInvalid wraps every validation failure.
var ErrInvalid = errors.New("invalid")

// ErrNotAllowed means the input is well-formed but not on an allowlist.
var ErrNotAllowed = errors.New("not allowed")

// MaxItems bounds one install/remove batch (contracts §1.1: items 1-10).
const MaxItems = 10

var (
	aptNameRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]*$`)
	flatpakRefRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
	unitRe       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9@._:\\-]*$`)
)

// RestartAllowlist is the only set of system units the helper restarts
// (design §6.4). Bare names; ".service" is appended at execution.
var RestartAllowlist = []string{"NetworkManager", "wpa_supplicant", "systemd-resolved", "bluetooth", "cups", "docker"}

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

// AptName checks one Debian package name (design §6.4 regexp, ≤128 bytes).
func AptName(s string) error {
	if len(s) == 0 || len(s) > 128 || !aptNameRe.MatchString(s) {
		return invalid("%q is not a Debian package name", s)
	}
	return nil
}

// FlatpakRef checks one Flathub application ID. Beyond the design's
// character class it also requires an app-ID shape (≥3 dot-separated
// elements, none empty, none starting with '-'), so "-y", ".." or "--from"
// can never be read by flatpak as an option or a path.
func FlatpakRef(s string) error {
	if len(s) == 0 || len(s) > 255 || !flatpakRefRe.MatchString(s) {
		return invalid("%q is not a Flathub app ID", s)
	}
	parts := strings.Split(s, ".")
	if len(parts) < 3 {
		return invalid("%q is not a Flathub app ID", s)
	}
	for _, p := range parts {
		if p == "" || p[0] == '-' {
			return invalid("%q is not a Flathub app ID", s)
		}
	}
	return nil
}

// MaxUpgradeItems bounds one update batch (M2 contracts §2: items 1-200).
const MaxUpgradeItems = 200

// AptNames checks a batch: 1..MaxItems names, each valid, no duplicates.
func AptNames(names []string) error { return batch(names, MaxItems, AptName) }

// FlatpakRefs checks a batch of app IDs the same way.
func FlatpakRefs(refs []string) error { return batch(refs, MaxItems, FlatpakRef) }

// AptUpgradeNames checks an update batch: 1..MaxUpgradeItems names.
func AptUpgradeNames(names []string) error { return batch(names, MaxUpgradeItems, AptName) }

// FlatpakUpdateRefs checks an update batch of app IDs: 1..MaxUpgradeItems.
func FlatpakUpdateRefs(refs []string) error { return batch(refs, MaxUpgradeItems, FlatpakRef) }

func batch(items []string, max int, one func(string) error) error {
	if len(items) == 0 || len(items) > max {
		return invalid("expected 1 to %d items, got %d", max, len(items))
	}
	seen := map[string]bool{}
	for _, it := range items {
		if err := one(it); err != nil {
			return err
		}
		if seen[it] {
			return invalid("%q listed twice", it)
		}
		seen[it] = true
	}
	return nil
}

// UnitName checks a systemd unit name's syntax (any unit, any type).
func UnitName(s string) error {
	if len(s) == 0 || len(s) > 255 || !unitRe.MatchString(s) {
		return invalid("%q is not a systemd unit name", s)
	}
	return nil
}

// ServiceUnit returns s with ".service" appended when s has no unit suffix.
func ServiceUnit(s string) string {
	for _, suf := range []string{".service", ".socket", ".target", ".timer", ".mount", ".path", ".scope", ".slice", ".device", ".swap", ".automount"} {
		if strings.HasSuffix(s, suf) {
			return s
		}
	}
	return s + ".service"
}

// RestartableUnit accepts "NetworkManager" or "NetworkManager.service" for an
// allowlisted unit and returns the bare name. A well-formed unit that is not
// on the list returns ErrNotAllowed; anything malformed returns ErrInvalid.
func RestartableUnit(s string) (string, error) {
	if err := UnitName(s); err != nil {
		return "", err
	}
	bare := strings.TrimSuffix(s, ".service")
	for _, u := range RestartAllowlist {
		if bare == u {
			return u, nil
		}
	}
	return "", fmt.Errorf("%w: %q is not on the restart allowlist", ErrNotAllowed, s)
}

// Text checks free text that becomes one argv element of a user-side command
// (an nmcli connection name, an SSID): valid UTF-8, no control characters,
// not starting with '-', at most max bytes.
func Text(s string, max int) error {
	if s == "" || len(s) > max || !utf8.ValidString(s) {
		return invalid("expected 1 to %d bytes of text", max)
	}
	if s[0] == '-' {
		return invalid("must not start with '-'")
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return invalid("control characters are not allowed")
		}
	}
	return nil
}

// ConnectionID checks a NetworkManager connection name.
func ConnectionID(s string) error { return Text(s, 128) }

// SSID checks a Wi-Fi network name (802.11 allows at most 32 bytes).
func SSID(s string) error { return Text(s, 32) }

// WifiPassword checks a WPA passphrase (8-63 printable ASCII) or a 64-hex PSK.
// It is written to nmcli's stdin, so a newline would end it early.
func WifiPassword(s string) error {
	if len(s) == 64 {
		if isHex(s) {
			return nil
		}
	}
	if len(s) < 8 || len(s) > 63 {
		return invalid("a Wi-Fi password has 8 to 63 characters")
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return invalid("a Wi-Fi password uses printable ASCII only")
		}
	}
	return nil
}

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}
