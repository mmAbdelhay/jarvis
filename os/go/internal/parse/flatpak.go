package parse

import (
	"fmt"
	"strconv"
	"strings"
)

// FlatpakHit is one row of
// `flatpak search --columns=application,name,version,description,remotes`.
type FlatpakHit struct {
	ID, Name, Version, Summary string
	Remotes                    []string
}

// FlatpakSearch parses tab-separated search rows. "No matches found" yields
// no rows.
func FlatpakSearch(out string) []FlatpakHit {
	var res []FlatpakHit
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 5 || f[0] == "" {
			continue
		}
		res = append(res, FlatpakHit{
			ID: f[0], Name: f[1], Version: f[2], Summary: f[3],
			Remotes: strings.Split(f[4], ","),
		})
	}
	return res
}

// FlatpakApp is one row of `flatpak list --app --columns=application,name,version`.
type FlatpakApp struct {
	ID, Name, Version string
}

// FlatpakList parses tab-separated list rows.
func FlatpakList(out string) []FlatpakApp {
	var res []FlatpakApp
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 3 || f[0] == "" {
			continue
		}
		res = append(res, FlatpakApp{ID: f[0], Name: f[1], Version: f[2]})
	}
	return res
}

// FlatpakInfo is `flatpak remote-info` or `flatpak info` output.
type FlatpakInfo struct {
	ID, Name, Version, Summary string
	DownloadBytes              int64
	InstalledBytes             int64
}

// FlatpakDetails parses the "Name - Summary" title line and the
// right-aligned "Key: value" lines of `flatpak remote-info` / `flatpak info`.
func FlatpakDetails(out string) (FlatpakInfo, error) {
	var info FlatpakInfo
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		k, v, ok := strings.Cut(line, ": ")
		if ok && !strings.Contains(k, " ") {
			switch k {
			case "ID":
				info.ID = v
			case "Version":
				info.Version = v
			case "Download":
				info.DownloadBytes, _ = HumanSize(v)
			case "Installed":
				info.InstalledBytes, _ = HumanSize(v)
			}
			continue
		}
		if info.Name == "" && info.ID == "" {
			name, summary, _ := strings.Cut(line, " - ")
			info.Name, info.Summary = name, summary
		}
	}
	if info.ID == "" {
		return info, fmt.Errorf("flatpak details: no ID line")
	}
	return info, nil
}

// HumanSize parses GLib's g_format_size output ("37.4 MB", "980 bytes",
// "1.2 GB"); units are decimal. GLib puts a no-break space (U+00A0) between
// number and unit, which becomes "?" when flatpak runs without a UTF-8
// locale, so the number is read as the leading digits and whatever
// separator follows is skipped.
func HumanSize(s string) (int64, error) {
	s = strings.TrimSpace(s)
	end := strings.IndexFunc(s, func(r rune) bool { return (r < '0' || r > '9') && r != '.' })
	if end < 0 {
		end = len(s)
	}
	f, err := strconv.ParseFloat(s[:end], 64)
	if err != nil {
		return 0, fmt.Errorf("size %q: %w", s, err)
	}
	unit := strings.TrimLeft(s[end:], " ?\u00a0")
	mult := map[string]float64{"": 1, "byte": 1, "bytes": 1, "B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
	m, ok := mult[unit]
	if !ok {
		return 0, fmt.Errorf("size %q: unknown unit", s)
	}
	return int64(f*m + 0.5), nil
}
