// Package policy holds jarvis-cu's fixed safety rules (Rafiq v1.1
// contracts §1): which windows may never receive input, which windows
// belong to the apps the user allowed, and which key combos and text may
// be injected. Everything here is pure and table-tested.
package policy

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
	"github.com/mmAbdelhay/jarvis/os/go/internal/desktop"
)

// MaxAllowedApps bounds begin's appIds.
const MaxAllowedApps = 8

var appIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$`)

func set(xs ...string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[strings.ToLower(x)] = true
	}
	return m
}

// builtinTerminals are refused even when no .desktop file says so.
var builtinTerminals = set(
	"foot", "footclient", "org.codeberg.dnkl.foot", "xterm", "uxterm", "urxvt", "rxvt", "st", "st-256color",
	"alacritty", "kitty", "org.wezfurlong.wezterm", "wezterm", "com.mitchellh.ghostty", "ghostty",
	"org.gnome.terminal", "gnome-terminal", "gnome-terminal-server", "org.gnome.console", "kgx",
	"org.gnome.ptyxis", "ptyxis", "org.kde.konsole", "konsole", "xfce4-terminal", "lxterminal",
	"qterminal", "terminator", "tilix", "com.gexperts.tilix", "sakura", "terminology",
	"io.elementary.terminal", "mate-terminal", "deepin-terminal", "cool-retro-term", "yakuake",
	"guake", "tilda",
)

// credentialPrompts ask for passwords for the system or the keyring. They
// are matched as substrings of the lowercased window app id, because real
// ids are often reverse-DNS (org.gnupg.pinentry-qt, lxqt-openssh-askpass)
// or a bare WM class (SshAskpass).
var credentialPrompts = []string{
	"pinentry", "askpass", "ssh-askpass", "sshaskpass", "gcr-prompter",
	"keyring.systemprompter", "org.gnome.keyring", "kwallet", "ksecretd",
}

// launcherExecs start other programs; their basenames never alias an app.
var launcherExecs = set("flatpak", "env", "sh", "bash", "dash", "python", "python3", "java",
	"gjs", "electron", "snap", "gtk-launch", "dbus-launch", "exo-open", "xdg-open")

// AppIndex knows which window app ids belong to which desktop ids.
type AppIndex struct {
	aliases   map[string][]string      // lower(window app id) -> lower(desktop ids)
	terminals map[string]bool          // lower ids/aliases of TerminalEmulator entries
	entries   map[string]desktop.Entry // lower desktop id -> entry
}

// NewAppIndex indexes entries (use desktop.IndexAll so hidden terminals count).
func NewAppIndex(entries []desktop.Entry) *AppIndex {
	x := &AppIndex{aliases: map[string][]string{}, terminals: map[string]bool{}, entries: map[string]desktop.Entry{}}
	for _, e := range entries {
		id := strings.ToLower(strings.TrimSpace(e.ID))
		if id == "" {
			continue
		}
		if _, dup := x.entries[id]; !dup {
			x.entries[id] = e
		}
		term := false
		for _, c := range e.Categories {
			if c == "TerminalEmulator" {
				term = true
			}
		}
		for _, n := range aliasesOf(e) {
			if !contains(x.aliases[n], id) {
				x.aliases[n] = append(x.aliases[n], id)
			}
			if term {
				x.terminals[n] = true
			}
		}
	}
	return x
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func aliasesOf(e desktop.Entry) []string {
	out := []string{strings.ToLower(strings.TrimSpace(e.ID))}
	if w := strings.ToLower(strings.TrimSpace(e.StartupWMClass)); w != "" {
		out = append(out, w)
	}
	if f := strings.Fields(e.Exec); len(f) > 0 {
		b := strings.ToLower(filepath.Base(strings.Trim(f[0], `"'`)))
		if b != "" && b != "." && b != "/" && !launcherExecs[b] && !strings.Contains(b, "=") {
			out = append(out, b)
		}
	}
	return out
}

// Excluded reports whether a window with this app id may never receive
// input from Jarvis, and why (English, shown to the model).
func (x *AppIndex) Excluded(appID string) (bool, string) {
	a := strings.ToLower(strings.TrimSpace(appID))
	switch {
	case a == "":
		return true, "a window without an app id"
	case a == "jarvis" || strings.HasPrefix(a, "jarvis-") || strings.HasPrefix(a, "jarvis_") ||
		strings.HasPrefix(a, "os.jarvis.") || strings.HasPrefix(a, "rafiq"):
		return true, "Rafiq's own windows (shell, lock screen, installer)"
	case strings.Contains(a, "polkit") || strings.Contains(a, "policykit"):
		return true, "a system password prompt (polkit agent)"
	}
	for _, p := range credentialPrompts {
		if strings.Contains(a, p) {
			return true, "a password prompt"
		}
	}
	if builtinTerminals[a] || x.terminals[a] {
		return true, "a terminal"
	}
	return false, ""
}

// Matches reports whether a window's app id belongs to one of the allowed
// desktop ids: the id itself, or an alias (StartupWMClass, Exec basename)
// of that desktop entry. Callers check Excluded first; it always wins.
func (x *AppIndex) Matches(appID string, allowed []string) bool {
	a := strings.ToLower(strings.TrimSpace(appID))
	if a == "" {
		return false
	}
	for _, d := range allowed {
		d = strings.ToLower(d)
		if a == d || contains(x.aliases[a], d) {
			return true
		}
	}
	return false
}

// CheckAllowed validates begin's appIds: 1..MaxAllowedApps desktop ids,
// none excluded, and none whose windows would carry an excluded app id.
func (x *AppIndex) CheckAllowed(ids []string) error {
	if len(ids) == 0 {
		return proto.Errorf(proto.CodeFailed, "appIds must name at least one app")
	}
	if len(ids) > MaxAllowedApps {
		return proto.Errorf(proto.CodeFailed, "at most %d apps per session", MaxAllowedApps)
	}
	for _, id := range ids {
		if !appIDRe.MatchString(id) {
			return proto.Errorf(proto.CodeFailed, "%q is not a desktop app id", id)
		}
		if ex, why := x.Excluded(id); ex {
			return proto.Errorf(proto.CodeExcluded, "%s cannot be controlled: it is %s", id, why)
		}
		lower := strings.ToLower(id)
		for alias, owners := range x.aliases {
			if !contains(owners, lower) {
				continue
			}
			if ex, why := x.Excluded(alias); ex {
				return proto.Errorf(proto.CodeExcluded, "%s cannot be controlled: its windows are %s", id, why)
			}
		}
	}
	return nil
}

// RunningApps builds the `apps` op answer (contracts §4.2) from the app ids
// of the open windows: one entry per app, named from its desktop entry,
// without titles or rectangles. A window app id resolves to its desktop id
// directly or through a single alias; otherwise the raw app id is listed
// (begin matches it as-is) and doubles as the name. Apps that begin would
// refuse (excluded, malformed) are left out. Sorted by name.
func (x *AppIndex) RunningApps(windowAppIDs []string) []proto.App {
	out := []proto.App{}
	seen := map[string]bool{}
	for _, raw := range windowAppIDs {
		a := strings.ToLower(strings.TrimSpace(raw))
		if ex, _ := x.Excluded(a); ex {
			continue
		}
		app := proto.App{AppID: strings.TrimSpace(raw), Name: strings.TrimSpace(raw)}
		key := a
		if e, ok := x.entries[a]; ok {
			app, key = proto.App{AppID: e.ID, Name: e.Name}, a
		} else if owners := x.aliases[a]; len(owners) == 1 {
			e := x.entries[owners[0]]
			app, key = proto.App{AppID: e.ID, Name: e.Name}, owners[0]
		}
		if app.Name == "" {
			app.Name = app.AppID
		}
		if seen[key] || x.CheckAllowed([]string{app.AppID}) != nil {
			continue
		}
		seen[key] = true
		out = append(out, app)
	}
	sort.Slice(out, func(i, j int) bool {
		li, lj := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if li != lj {
			return li < lj
		}
		return out[i].AppID < out[j].AppID
	})
	return out
}
