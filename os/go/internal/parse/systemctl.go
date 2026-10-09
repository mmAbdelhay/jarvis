package parse

import (
	"strings"
	"time"
)

// UnitRow is one row of `systemctl list-units --plain --no-legend`.
type UnitRow struct {
	Unit, Load, Active, Sub, Description string
}

// ListUnits parses `systemctl list-units --plain --no-legend --no-pager`.
func ListUnits(out string) []UnitRow {
	var res []UnitRow
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "●"))
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		row := UnitRow{Unit: f[0], Load: f[1], Active: f[2], Sub: f[3]}
		if len(f) > 4 {
			row.Description = strings.Join(f[4:], " ")
		}
		res = append(res, row)
	}
	return res
}

// Show parses `systemctl show` output: key=value lines, one blank-line
// separated block per unit.
func Show(out string) []map[string]string {
	var (
		all []map[string]string
		cur map[string]string
	)
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			if cur != nil {
				all = append(all, cur)
				cur = nil
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		if cur == nil {
			cur = map[string]string{}
		}
		cur[k] = v
	}
	if cur != nil {
		all = append(all, cur)
	}
	return all
}

// ShowTime parses a systemctl timestamp such as "Tue 2026-10-07 09:12:44 UTC".
// The tools run systemctl with TZ=UTC, so the zone is always UTC.
func ShowTime(v string) (time.Time, bool) {
	v = strings.TrimSpace(v)
	if v == "" || v == "n/a" {
		return time.Time{}, false
	}
	t, err := time.Parse("Mon 2006-01-02 15:04:05 MST", v)
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}
