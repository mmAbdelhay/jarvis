package parse

import (
	"regexp"
	"strings"
)

// AptUpgrade is one package `apt-get -s upgrade` would upgrade.
type AptUpgrade struct {
	Name, From, To string
	Security       bool // the candidate comes from a *-security suite
}

// "Inst <name> [<from>] (<to> <origin>[, <origin>...] [<arch>])..."
var aptInstRe = regexp.MustCompile(`^Inst (\S+) \[([^\]]*)\] \((\S+) ([^\[]*)\[[^\]]*\]\)`)

// AptSimUpgrade parses `apt-get -s upgrade`. Only "Inst" lines with an
// installed version in brackets are upgrades; "Conf" lines repeat them. A
// package is a security update when any origin of its candidate names a
// "-security" suite ("Debian-Security:13/stable-security").
func AptSimUpgrade(out string) []AptUpgrade {
	var res []AptUpgrade
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		m := aptInstRe.FindStringSubmatch(line)
		if m == nil || seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		res = append(res, AptUpgrade{Name: m[1], From: m[2], To: m[3], Security: strings.Contains(m[4], "-security")})
	}
	return res
}

// AptPolicy is `apt-cache policy -- <name>` for one package.
type AptPolicy struct {
	Name, Installed, Candidate string // "" for "(none)"
	CandidateSecurity          bool   // a source of the candidate is a *-security suite
}

// AptCachePolicy parses `apt-cache policy` for one or more packages.
func AptCachePolicy(out string) []AptPolicy {
	var res []AptPolicy
	var cur *AptPolicy
	inCandidate := false
	none := func(v string) string {
		if v == "(none)" {
			return ""
		}
		return v
	}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		if line[0] != ' ' && strings.HasSuffix(line, ":") {
			res = append(res, AptPolicy{Name: strings.TrimSuffix(line, ":")})
			cur = &res[len(res)-1]
			inCandidate = false
			continue
		}
		if cur == nil {
			continue
		}
		t := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(t, "Installed:"):
			cur.Installed = none(strings.TrimSpace(strings.TrimPrefix(t, "Installed:")))
		case strings.HasPrefix(t, "Candidate:"):
			cur.Candidate = none(strings.TrimSpace(strings.TrimPrefix(t, "Candidate:")))
		case t == "Version table:":
		default:
			f := strings.Fields(strings.TrimPrefix(t, "*** "))
			// A version row is "<version> <priority>" at 5-space indent; a
			// source row is "<priority> <uri> <suite>/<component> ..." deeper.
			if len(f) == 2 && strings.HasPrefix(line, "     ") && !strings.HasPrefix(line, "        ") || strings.HasPrefix(t, "*** ") {
				inCandidate = f[0] == cur.Candidate
				continue
			}
			if inCandidate && len(f) >= 3 && strings.Contains(f[2], "-security") {
				cur.CandidateSecurity = true
			}
		}
	}
	return res
}

// TabRows splits tab-separated rows (flatpak --columns output) and keeps
// rows with at least n fields.
func TabRows(out string, n int) [][]string {
	var res [][]string
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(line, "\t")
		if len(f) < n || f[0] == "" {
			continue
		}
		for i := range f {
			f[i] = strings.TrimSpace(f[i])
		}
		res = append(res, f)
	}
	return res
}
