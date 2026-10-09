package recipes

import (
	"fmt"
	"io/fs"
	"strconv"
	"strings"
)

// Host is what a recipe's requirements are checked against.
type Host struct {
	OSID          string // os-release ID
	MemTotalBytes int64  // /proc/meminfo MemTotal
}

// ReadHost reads os-release and /proc/meminfo from the root FS; missing
// files leave zero values (and every recipe then does not fit).
func ReadHost(fsys fs.FS) Host {
	var h Host
	for _, p := range []string{"etc/os-release", "usr/lib/os-release"} {
		b, err := fs.ReadFile(fsys, p)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(line, "ID="); ok {
				h.OSID = strings.Trim(strings.TrimSpace(v), `"'`)
			}
		}
		break
	}
	if b, err := fs.ReadFile(fsys, "proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if rest, ok := strings.CutPrefix(line, "MemTotal:"); ok {
				if f := strings.Fields(rest); len(f) > 0 {
					if kb, err := strconv.ParseInt(f[0], 10, 64); err == nil {
						h.MemTotalBytes = kb * 1024
					}
				}
			}
		}
	}
	return h
}

// Fits says whether r can run on h and, if not, why (English, for the
// model). Memory counts as enough at 90% of minRamGB GiB, because the
// kernel keeps part of the installed memory (an "8 GB" laptop reports
// about 7.5 GiB).
func (r Recipe) Fits(h Host) (bool, string) {
	if h.OSID != r.Requires.OS {
		id := h.OSID
		if id == "" {
			id = "an unknown system"
		}
		return false, fmt.Sprintf("this recipe is for %s; this computer runs %s", r.Requires.OS, id)
	}
	if r.Requires.MinRAMGB > 0 && float64(h.MemTotalBytes) < r.Requires.MinRAMGB*0.9*(1<<30) {
		return false, fmt.Sprintf("this recipe needs %g GB of memory; this computer has %.1f GB", r.Requires.MinRAMGB, float64(h.MemTotalBytes)/(1<<30))
	}
	return true, ""
}
