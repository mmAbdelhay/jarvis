// Package desktop reads freedesktop.org Desktop Entry files (1.5) into an
// app index for jarvis-apps (Rafiq M3 contracts §1: APT and Flatpak apps)
// and expands their Exec lines into an argv. No shell is ever involved.
package desktop

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Entry is one application.
type Entry struct {
	ID             string   `json:"id"`     // desktop file id without ".desktop", e.g. "org.gnome.Nautilus"
	Name           string   `json:"name"`   // unlocalised Name=
	NameAr         string   `json:"nameAr"` // Name[ar]=, "" when absent
	Source         string   `json:"source"` // "apt" | "flatpak" | "user"
	Categories     []string `json:"categories"`
	MimeTypes      []string `json:"mimeTypes"`
	Path           string   `json:"-"`
	Type           string   `json:"-"`
	Exec           string   `json:"-"`
	Icon           string   `json:"-"`
	Keywords       []string `json:"-"`
	StartupWMClass string   `json:"-"`
	Terminal       bool     `json:"-"`
	NoDisplay      bool     `json:"-"`
	Hidden         bool     `json:"-"`
}

// Visible reports whether a launcher shows the entry as an app.
func (e Entry) Visible() bool {
	return e.Type == "Application" && !e.NoDisplay && !e.Hidden && e.Name != "" && e.Exec != ""
}

// unescape applies the spec's string escapes (\s \n \t \r \\).
func unescape(v string) string {
	if !strings.Contains(v, `\`) {
		return v
	}
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		if v[i] == '\\' && i+1 < len(v) {
			i++
			switch v[i] {
			case 's':
				b.WriteByte(' ')
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case 'r':
				b.WriteByte('\r')
			case '\\':
				b.WriteByte('\\')
			default:
				b.WriteByte('\\')
				b.WriteByte(v[i])
			}
			continue
		}
		b.WriteByte(v[i])
	}
	return b.String()
}

// list splits a ;-separated list value (with "\;" escapes).
func list(v string) []string {
	out := []string{}
	var cur strings.Builder
	for i := 0; i < len(v); i++ {
		switch {
		case v[i] == '\\' && i+1 < len(v) && v[i+1] == ';':
			cur.WriteByte(';')
			i++
		case v[i] == ';':
			if s := strings.TrimSpace(cur.String()); s != "" {
				out = append(out, unescape(s))
			}
			cur.Reset()
		default:
			cur.WriteByte(v[i])
		}
	}
	if s := strings.TrimSpace(cur.String()); s != "" {
		out = append(out, unescape(s))
	}
	return out
}

// Parse reads the [Desktop Entry] group of one file.
func Parse(content string) Entry {
	e := Entry{Categories: []string{}, MimeTypes: []string{}, Keywords: []string{}}
	in := false
	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			in = line == "[Desktop Entry]"
			continue
		}
		if !in {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch k {
		case "Type":
			e.Type = v
		case "Name":
			e.Name = unescape(v)
		case "Name[ar]":
			e.NameAr = unescape(v)
		case "Exec":
			e.Exec = v // unescaped by ExpandExec
		case "Icon":
			e.Icon = unescape(v)
		case "Categories":
			e.Categories = list(v)
		case "MimeType":
			e.MimeTypes = list(v)
		case "Keywords":
			e.Keywords = list(v)
		case "StartupWMClass":
			e.StartupWMClass = unescape(v)
		case "Terminal":
			e.Terminal = v == "true"
		case "NoDisplay":
			e.NoDisplay = v == "true"
		case "Hidden":
			e.Hidden = v == "true"
		}
	}
	return e
}

// Dir is one applications folder and the source its apps come from.
type Dir struct {
	Path   string
	Source string
}

// DefaultDirs lists the applications folders, highest precedence first.
func DefaultDirs(home string) []Dir {
	return []Dir{
		{filepath.Join(home, ".local/share/applications"), "user"},
		{filepath.Join(home, ".local/share/flatpak/exports/share/applications"), "flatpak"},
		{"/var/lib/flatpak/exports/share/applications", "flatpak"},
		{"/usr/local/share/applications", "apt"},
		{"/usr/share/applications", "apt"},
	}
}

// Index reads every .desktop file. The first folder that has an id wins
// (a user copy with Hidden=true hides the system one); only visible apps
// are returned, sorted by name.
func Index(dirs []Dir) []Entry {
	out := walk(dirs, true, Entry.Visible)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if a != b {
			return a < b
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// IndexAll returns every Type=Application entry in every folder: no
// de-duplication and no visibility filter. jarvis-cu needs hidden and
// shadowed entries so that a NoDisplay terminal is still refused (Rafiq
// v1.1 contracts §1).
func IndexAll(dirs []Dir) []Entry {
	return walk(dirs, false, func(e Entry) bool { return e.Type == "Application" })
}

func walk(dirs []Dir, dedupe bool, keep func(Entry) bool) []Entry {
	seen := map[string]bool{}
	out := []Entry{}
	for _, d := range dirs {
		filepath.WalkDir(d.Path, func(p string, de fs.DirEntry, err error) error {
			if err != nil {
				if p == d.Path {
					return filepath.SkipDir
				}
				return nil
			}
			if de.IsDir() || !strings.HasSuffix(p, ".desktop") {
				return nil
			}
			rel, _ := filepath.Rel(d.Path, p)
			id := strings.TrimSuffix(strings.ReplaceAll(filepath.ToSlash(rel), "/", "-"), ".desktop")
			if dedupe && seen[id] {
				return nil
			}
			data, err := readSmall(p)
			if err != nil {
				return nil
			}
			seen[id] = true
			e := Parse(string(data))
			e.ID, e.Path, e.Source = id, p, d.Source
			if keep(e) {
				out = append(out, e)
			}
			return nil
		})
	}
	return out
}

// readSmall reads a desktop file of at most 256 KiB (they are tiny; a huge
// one is not a launcher).
func readSmall(p string) ([]byte, error) {
	st, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > 256<<10 {
		return nil, errors.New("not a desktop file")
	}
	return os.ReadFile(p)
}
