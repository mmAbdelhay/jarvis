package parse

import "strings"

// DesktopEntry is the part of a .desktop file pkg.list_installed needs.
type DesktopEntry struct {
	Name      string // unlocalised Name=
	Type      string
	NoDisplay bool
	Hidden    bool
}

// Desktop parses the [Desktop Entry] group of a .desktop file. Other groups
// (actions) are ignored; localised keys like Name[ar] are ignored.
func Desktop(content string) DesktopEntry {
	var e DesktopEntry
	inEntry := false
	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "[") {
			inEntry = line == "[Desktop Entry]"
			continue
		}
		if !inEntry {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "Name":
			e.Name = strings.TrimSpace(v)
		case "Type":
			e.Type = strings.TrimSpace(v)
		case "NoDisplay":
			e.NoDisplay = strings.TrimSpace(v) == "true"
		case "Hidden":
			e.Hidden = strings.TrimSpace(v) == "true"
		}
	}
	return e
}

// Visible reports whether a launcher shows this entry as an app.
func (e DesktopEntry) Visible() bool {
	return e.Type == "Application" && !e.NoDisplay && !e.Hidden && e.Name != ""
}
