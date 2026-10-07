package parse

import (
	"strconv"
	"strings"
)

// AptSearchHit is one line of `apt-cache search`.
type AptSearchHit struct {
	Name    string
	Summary string
}

// AptSearch parses `apt-cache search` output ("name - summary" per line).
func AptSearch(out string) []AptSearchHit {
	var hits []AptSearchHit
	for _, line := range strings.Split(out, "\n") {
		name, summary, ok := strings.Cut(line, " - ")
		if !ok || name == "" || strings.ContainsAny(name, " \t") {
			continue
		}
		hits = append(hits, AptSearchHit{Name: name, Summary: strings.TrimSpace(summary)})
	}
	return hits
}

// AptPackage is one stanza of `apt-cache show --no-all-versions`.
type AptPackage struct {
	Name           string
	Version        string
	Summary        string
	DownloadBytes  int64 // Size:
	InstalledBytes int64 // Installed-Size: is KiB
}

// AptShow parses `apt-cache show` stanzas. Only the first stanza per package
// is kept (the candidate version with --no-all-versions).
func AptShow(out string) []AptPackage {
	var pkgs []AptPackage
	seen := map[string]bool{}
	for _, fields := range Stanzas(out) {
		p := AptPackage{Name: fields["Package"], Version: fields["Version"]}
		if p.Name == "" || seen[p.Name] {
			continue
		}
		seen[p.Name] = true
		for k, v := range fields {
			if (k == "Description" || strings.HasPrefix(k, "Description-")) && k != "Description-md5" {
				p.Summary, _, _ = strings.Cut(v, "\n")
			}
		}
		p.DownloadBytes, _ = strconv.ParseInt(fields["Size"], 10, 64)
		if kib, err := strconv.ParseInt(fields["Installed-Size"], 10, 64); err == nil {
			p.InstalledBytes = kib * 1024
		}
		pkgs = append(pkgs, p)
	}
	return pkgs
}

// Stanzas parses RFC 822-style blocks (apt-cache show, systemctl show is
// key=value and has its own parser). Continuation lines (leading space) are
// joined to the previous field with "\n".
func Stanzas(out string) []map[string]string {
	var (
		all  []map[string]string
		cur  map[string]string
		last string
	)
	flush := func() {
		if len(cur) > 0 {
			all = append(all, cur)
		}
		cur, last = nil, ""
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		if line[0] == ' ' || line[0] == '\t' {
			if cur != nil && last != "" {
				cur[last] += "\n" + strings.TrimSpace(line)
			}
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if cur == nil {
			cur = map[string]string{}
		}
		last = k
		cur[k] = strings.TrimSpace(v)
	}
	flush()
	return all
}

// DpkgSearch parses `dpkg-query -S <paths>` into path → package names.
// Lines look like "vlc-bin, vlc:amd64: /usr/share/applications/vlc.desktop".
func DpkgSearch(out string) map[string][]string {
	res := map[string][]string{}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "diversion by") {
			continue
		}
		i := strings.Index(line, ": /")
		if i < 0 {
			continue
		}
		path := line[i+2:]
		for _, p := range strings.Split(line[:i], ", ") {
			name, _, _ := strings.Cut(strings.TrimSpace(p), ":") // drop ":amd64"
			if name != "" {
				res[path] = append(res[path], name)
			}
		}
	}
	return res
}

// DpkgStatus is one line of
// `dpkg-query -W -f='${Package}\t${Version}\t${db:Status-Status}\n'`.
type DpkgStatus struct {
	Name      string
	Version   string
	Installed bool
}

// DpkgQuery parses the tab-separated format above.
func DpkgQuery(out string) []DpkgStatus {
	var res []DpkgStatus
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(line, "\t")
		if len(f) != 3 || f[0] == "" {
			continue
		}
		res = append(res, DpkgStatus{Name: f[0], Version: f[1], Installed: f[2] == "installed"})
	}
	return res
}

// AptSimulatedRemovals parses `apt-get -s remove` output and returns every
// package apt would remove ("Remv <name> [<version>]" lines), including the
// reverse dependencies the user never named.
func AptSimulatedRemovals(out string) []string {
	var res []string
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && f[0] == "Remv" {
			res = append(res, f[1])
		}
	}
	return res
}
