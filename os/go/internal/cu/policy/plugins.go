package policy

import (
	"path/filepath"
	"slices"
	"strings"
)

// GIMPPluginGlobs are where Debian's GIMP keeps its plug-ins, one directory
// per plug-in program.
var GIMPPluginGlobs = []string{
	"/usr/lib/*/gimp/*/plug-ins/*",
	"/usr/lib/gimp/*/plug-ins/*",
	"/usr/libexec/gimp/*/plug-ins/*",
}

// GIMPPlugins lists the plug-in program names found under globs, sorted.
func GIMPPlugins(globs []string) []string {
	out := []string{}
	for _, g := range globs {
		matches, _ := filepath.Glob(g)
		for _, m := range matches {
			n := strings.ToLower(filepath.Base(m))
			if appIDRe.MatchString(n) && !slices.Contains(out, n) {
				out = append(out, n)
			}
		}
	}
	slices.Sort(out)
	return out
}

func isGIMP(id string, aliases []string) bool {
	if strings.EqualFold(id, "org.gimp.GIMP") {
		return true
	}
	for _, a := range aliases {
		if a == "gimp" || strings.HasPrefix(a, "gimp-") {
			return true
		}
	}
	return false
}

// AddGIMPPlugins makes GIMP's plug-in programs aliases of every installed
// GIMP entry: GIMP 3 runs each plug-in as its own program, and a plug-in's
// dialog (file-png's "Export Image as PNG") carries the plug-in's name as
// its Wayland app id. A name that already belongs to another app, or to a
// terminal, is left alone; exclusions are checked separately and still win.
func (x *AppIndex) AddGIMPPlugins(names []string) {
	gimps := []string{}
	for id, e := range x.entries {
		if isGIMP(id, aliasesOf(e)) {
			gimps = append(gimps, id)
		}
	}
	slices.Sort(gimps)
	if len(gimps) == 0 {
		return
	}
	for _, n := range names {
		n = strings.ToLower(n)
		if _, taken := x.aliases[n]; taken || x.terminals[n] {
			continue
		}
		if _, isEntry := x.entries[n]; isEntry {
			continue
		}
		x.aliases[n] = slices.Clone(gimps)
	}
}
