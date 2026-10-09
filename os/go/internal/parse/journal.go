package parse

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// JournalEntry is one record of `journalctl -o json`.
type JournalEntry struct {
	Time     time.Time
	Unit     string
	Priority int
	Message  string
}

// Journal parses `journalctl -o json` (one JSON object per line). Lines that
// are not JSON objects are skipped. journald hands back a field as an array
// of byte values when it is not valid UTF-8, and as an array of strings when
// the field occurs more than once; both are handled.
func Journal(out string) []JournalEntry {
	var res []JournalEntry
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var raw map[string]json.RawMessage
		if json.Unmarshal([]byte(line), &raw) != nil {
			continue
		}
		e := JournalEntry{Priority: 6}
		if us, err := strconv.ParseInt(field(raw["__REALTIME_TIMESTAMP"]), 10, 64); err == nil {
			e.Time = time.UnixMicro(us).UTC()
		}
		if p, err := strconv.Atoi(field(raw["PRIORITY"])); err == nil && p >= 0 && p <= 7 {
			e.Priority = p
		}
		for _, k := range []string{"_SYSTEMD_UNIT", "_SYSTEMD_USER_UNIT", "SYSLOG_IDENTIFIER", "_COMM"} {
			if v := field(raw[k]); v != "" {
				e.Unit = v
				break
			}
		}
		if field(raw["_TRANSPORT"]) == "kernel" {
			e.Unit = "kernel"
		}
		e.Message = field(raw["MESSAGE"])
		res = append(res, e)
	}
	return res
}

// field decodes a journal JSON field value: a string, null, an array of
// byte values, or an array of strings (first value wins).
func field(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var bytesV []int
	if json.Unmarshal(raw, &bytesV) == nil {
		b := make([]byte, 0, len(bytesV))
		for _, x := range bytesV {
			if x >= 0 && x <= 255 {
				b = append(b, byte(x))
			}
		}
		return strings.ToValidUTF8(strings.ReplaceAll(string(b), "\x00", ""), string(utf8.RuneError))
	}
	var strs []string
	if json.Unmarshal(raw, &strs) == nil && len(strs) > 0 {
		return strs[0]
	}
	return ""
}
