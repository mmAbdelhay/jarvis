package policy

import (
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
	"github.com/mmAbdelhay/jarvis/os/go/internal/desktop"
)

func testIndex() *AppIndex {
	return NewAppIndex([]desktop.Entry{
		{ID: "gimp", Type: "Application", Exec: "gimp-2.10 %U", StartupWMClass: "gimp-2.10", Categories: []string{"Graphics"}},
		{ID: "org.mozilla.firefox", Type: "Application", Exec: "/usr/lib/firefox/firefox %u", Categories: []string{"Network"}},
		{ID: "org.gnome.Console", Type: "Application", Exec: "kgx", Categories: []string{"System", "TerminalEmulator"}},
		{ID: "my-term", Type: "Application", Exec: "/opt/myterm/bin/myterm", NoDisplay: true, Categories: []string{"TerminalEmulator"}},
		{ID: "org.gimp.GIMP", Type: "Application", Exec: "/usr/bin/flatpak run --branch=stable org.gimp.GIMP", Categories: []string{"Graphics"}},
		{ID: "sneaky", Type: "Application", Exec: "sneaky", StartupWMClass: "foot"},
	})
}

func TestExcluded(t *testing.T) {
	x := testIndex()
	cases := map[string]bool{
		"":                                    true,
		"  ":                                  true,
		"jarvis-shell":                        true,
		"JARVIS-LOCK":                         true,
		"jarvis-installer":                    true,
		"jarvis-classic":                      true,
		"jarvis-workspace":                    true,
		"jarvis":                              true,
		"os.jarvis.Settings":                  true,
		"rafiq-anything":                      true,
		"polkit-gnome-authentication-agent-1": true,
		"lxqt-policykit-agent":                true,
		"org.kde.polkit-kde-authentication-agent-1": true,
		"pinentry-gnome3":     true,
		"gcr-prompter":        true,
		"org.kde.ksshaskpass": true,
		"foot":                true,
		"footclient":          true,
		"Alacritty":           true,
		"org.gnome.Console":   true,
		"kgx":                 true,
		"myterm":              true, // exec alias of a hidden TerminalEmulator entry
		"my-term":             true,
		"gimp":                false,
		"gimp-2.10":           false,
		"firefox":             false,
		"org.mozilla.firefox": false,
		"jarvisish-editor":    false, // only the "jarvis-" / "jarvis_" prefixes count
	}
	for id, want := range cases {
		got, why := x.Excluded(id)
		if got != want {
			t.Errorf("Excluded(%q) = %v (%s), want %v", id, got, why, want)
		}
		if got && why == "" {
			t.Errorf("Excluded(%q) gave no reason", id)
		}
	}
}

func TestMatches(t *testing.T) {
	x := testIndex()
	cases := []struct {
		appID   string
		allowed []string
		want    bool
	}{
		{"gimp", []string{"gimp"}, true},
		{"GIMP-2.10", []string{"gimp"}, true},              // StartupWMClass alias
		{"firefox", []string{"org.mozilla.firefox"}, true}, // exec basename alias
		{"org.gimp.GIMP", []string{"org.gimp.GIMP"}, true},
		{"flatpak", []string{"org.gimp.GIMP"}, false}, // launcher basenames are never aliases
		{"gimp", []string{"org.mozilla.firefox"}, false},
		{"", []string{"gimp"}, false},
		{"evince", []string{"evince"}, true}, // no .desktop needed for an exact id
	}
	for _, c := range cases {
		if got := x.Matches(c.appID, c.allowed); got != c.want {
			t.Errorf("Matches(%q, %v) = %v, want %v", c.appID, c.allowed, got, c.want)
		}
	}
}

func TestCheckAllowed(t *testing.T) {
	x := testIndex()
	if err := x.CheckAllowed([]string{"gimp", "org.mozilla.firefox"}); err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		ids  []string
		code string
	}{
		"empty":             {nil, proto.CodeFailed},
		"too many":          {[]string{"a", "b", "c", "d", "e", "f", "g", "h", "i"}, proto.CodeFailed},
		"bad chars":         {[]string{"gimp; rm -rf"}, proto.CodeFailed},
		"leading dot":       {[]string{".hidden"}, proto.CodeFailed},
		"terminal":          {[]string{"foot"}, proto.CodeExcluded},
		"terminal desktop":  {[]string{"org.gnome.Console"}, proto.CodeExcluded},
		"shell":             {[]string{"jarvis-shell"}, proto.CodeExcluded},
		"alias of terminal": {[]string{"sneaky"}, proto.CodeExcluded}, // its windows would be "foot"
	}
	for name, c := range cases {
		err := x.CheckAllowed(c.ids)
		if err == nil || proto.AsError(err).Code != c.code {
			t.Errorf("%s: CheckAllowed(%v) = %v, want code %s", name, c.ids, err, c.code)
		}
	}
}
