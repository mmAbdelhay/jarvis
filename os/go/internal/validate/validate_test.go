package validate

import (
	"errors"
	"strings"
	"testing"
)

// Hostile inputs from design §11, plus the obvious neighbours.
var hostile = []string{
	"",
	"vlc; rm -rf /",
	"-o APT::Get::AllowUnauthenticated=true",
	"-oAPT::Get::Assume-Yes=1",
	"--purge",
	"../",
	"../../etc/passwd",
	"vlc\nrm",
	"vlc rm",
	"vlc$(reboot)",
	"vlc`reboot`",
	"vlc|reboot",
	"vlc&&reboot",
	"vlс",          // Cyrillic es: looks like "vlc"
	"ｖlc",          // fullwidth v
	"vlc​",         // zero-width space
	"vlc\x00",      // NUL
	"vlc/unstable", // release selector
	"vlc=3.0.21-1", // version pin
	"https://evil.example/x.deb",
}

func TestAptNameAcceptsRealNames(t *testing.T) {
	for _, s := range []string{"vlc", "gimp", "g++", "libstdc++6", "python3.13", "0ad", "fonts-noto-cjk"} {
		if err := AptName(s); err != nil {
			t.Errorf("AptName(%q) = %v", s, err)
		}
	}
}

func TestAptNameRejectsHostileInput(t *testing.T) {
	for _, s := range append(hostile, "VLC", strings.Repeat("a", 129)) {
		if err := AptName(s); !errors.Is(err, ErrInvalid) {
			t.Errorf("AptName(%q) = %v, want ErrInvalid", s, err)
		}
	}
}

func TestFlatpakRefAcceptsAppIDs(t *testing.T) {
	for _, s := range []string{"com.spotify.Client", "org.videolan.VLC", "org.gimp.GIMP", "io.github.flattool.Warehouse", "com.visualstudio.code-oss", "org.mozilla.firefox"} {
		if err := FlatpakRef(s); err != nil {
			t.Errorf("FlatpakRef(%q) = %v", s, err)
		}
	}
}

func TestFlatpakRefRejectsHostileInputAndOtherRemotes(t *testing.T) {
	cases := append(hostile,
		"fedora:org.gnome.Calculator", // another remote
		"fedora/org.gnome.Calculator", // remote-qualified
		"--from=https://evil.example/app.flatpakref",
		"--remote=fedora",
		"-y",
		"app/org.videolan.VLC/x86_64/stable", // full ref: '/' is refused
		"org.videolan.VLC;reboot",
		"org..VLC",
		".org.videolan.VLC",
		"org.-evil.App",
		"org.videolan",     // too few elements
		"org.videolаn.VLC", // Cyrillic a
		"..",
	)
	for _, s := range cases {
		if err := FlatpakRef(s); !errors.Is(err, ErrInvalid) {
			t.Errorf("FlatpakRef(%q) = %v, want ErrInvalid", s, err)
		}
	}
}

func TestBatches(t *testing.T) {
	if err := AptNames([]string{"vlc", "gimp"}); err != nil {
		t.Fatal(err)
	}
	for name, in := range map[string][]string{
		"empty":     {},
		"duplicate": {"vlc", "vlc"},
		"one bad":   {"vlc", "gimp; reboot"},
		"too many":  {"a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11"},
	} {
		if err := AptNames(in); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: AptNames = %v, want ErrInvalid", name, err)
		}
	}
	if err := FlatpakRefs([]string{"com.spotify.Client", "--system"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("FlatpakRefs accepted an option: %v", err)
	}
}

func TestRestartableUnit(t *testing.T) {
	for in, want := range map[string]string{
		"NetworkManager":         "NetworkManager",
		"NetworkManager.service": "NetworkManager",
		"systemd-resolved":       "systemd-resolved",
		"wpa_supplicant.service": "wpa_supplicant",
		"bluetooth":              "bluetooth",
		"cups":                   "cups",
		"docker":                 "docker",
	} {
		got, err := RestartableUnit(in)
		if err != nil || got != want {
			t.Errorf("RestartableUnit(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, s := range []string{"sshd", "gdm", "networkmanager", "docker.socket", "NetworkManager.service.d", "systemd-logind"} {
		if _, err := RestartableUnit(s); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("RestartableUnit(%q) = %v, want ErrNotAllowed", s, err)
		}
	}
	for _, s := range []string{"NetworkManager; reboot", "../NetworkManager", "-NetworkManager", "NetworkManager ", "NetworkManager\x00", "", "NetworkМanager"} {
		if _, err := RestartableUnit(s); !errors.Is(err, ErrInvalid) {
			t.Errorf("RestartableUnit(%q) = %v, want ErrInvalid", s, err)
		}
	}
}

func TestUnitNameAndServiceUnit(t *testing.T) {
	for _, s := range []string{"getty@tty1.service", "dev-sda1.device", "foo\\x2dbar.mount", "pipewire.socket"} {
		if err := UnitName(s); err != nil {
			t.Errorf("UnitName(%q) = %v", s, err)
		}
	}
	if ServiceUnit("cups") != "cups.service" || ServiceUnit("pipewire.socket") != "pipewire.socket" {
		t.Fatal("ServiceUnit suffix logic wrong")
	}
}

func TestTextInputs(t *testing.T) {
	for _, s := range []string{"Home WiFi", "Café ☕", "eth0 connection 1", "مقهى"} {
		if err := ConnectionID(s); err != nil {
			t.Errorf("ConnectionID(%q) = %v", s, err)
		}
	}
	for _, s := range []string{"", "-h", "--help", "a\nb", "a\tb", "\x00", strings.Repeat("x", 129)} {
		if err := ConnectionID(s); !errors.Is(err, ErrInvalid) {
			t.Errorf("ConnectionID(%q) = %v, want ErrInvalid", s, err)
		}
	}
	if err := SSID(strings.Repeat("x", 33)); !errors.Is(err, ErrInvalid) {
		t.Error("SSID over 32 bytes accepted")
	}
}

func TestWifiPassword(t *testing.T) {
	for _, s := range []string{"correcthorse", "12345678", strings.Repeat("a", 63), strings.Repeat("f", 64)} {
		if err := WifiPassword(s); err != nil {
			t.Errorf("WifiPassword(%q) = %v", s, err)
		}
	}
	for _, s := range []string{"short", strings.Repeat("a", 65), "pass\nword", "pässwörd1", strings.Repeat("z", 64)} {
		if err := WifiPassword(s); !errors.Is(err, ErrInvalid) {
			t.Errorf("WifiPassword(%q) = %v, want ErrInvalid", s, err)
		}
	}
}
