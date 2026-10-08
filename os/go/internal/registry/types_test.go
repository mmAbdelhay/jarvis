package registry

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func validEntry() Entry {
	return Entry{
		ID: "weather", Name: "Weather", Description: "Forecasts from met.no.",
		Tier: TierCommunity, Version: "1.2.0",
		Artifact:    Artifact{URL: "https://example.org/weather-1.2.0.tar.gz", SHA256: strings.Repeat("ab", 32), Runtime: RuntimeNode},
		Permissions: Permissions{Network: true, Paths: []string{"~/Documents/Weather"}},
		Tools:       []ToolDecl{{Name: "weather.today", Risk: "safe"}},
	}
}

func TestValidEntry(t *testing.T) {
	if err := validEntry().Validate(); err != nil {
		t.Fatal(err)
	}
	e := validEntry()
	e.ID, e.Tier = "jarvis-files", TierOfficial
	if err := e.Validate(); err != nil {
		t.Fatalf("official jarvis- id: %v", err)
	}
}

func TestEntryRefusals(t *testing.T) {
	cases := map[string]func(*Entry){
		"traversal id":           func(e *Entry) { e.ID = "../x" },
		"upper id":               func(e *Entry) { e.ID = "Weather" },
		"one-letter id":          func(e *Entry) { e.ID = "w" },
		"reserved id":            func(e *Entry) { e.ID, e.Tier = "jarvis-pkg", TierOfficial },
		"jarvis- not official":   func(e *Entry) { e.ID = "jarvis-files" },
		"unknown tier":           func(e *Entry) { e.Tier = "trusted" },
		"slash version":          func(e *Entry) { e.Version = "1/../../x" },
		"empty version":          func(e *Entry) { e.Version = "" },
		"empty name":             func(e *Entry) { e.Name = "" },
		"bidi name":              func(e *Entry) { e.Name = "Weather‮gnp.exe" },
		"escape in description":  func(e *Entry) { e.Description = "a\x1b[31mred" },
		"http url":               func(e *Entry) { e.Artifact.URL = "http://example.org/a.tar.gz" },
		"userinfo url":           func(e *Entry) { e.Artifact.URL = "https://u:p@example.org/a.tar.gz" },
		"file url":               func(e *Entry) { e.Artifact.URL = "file:///etc/passwd" },
		"short sha":              func(e *Entry) { e.Artifact.SHA256 = "abcd" },
		"upper sha":              func(e *Entry) { e.Artifact.SHA256 = strings.Repeat("AB", 32) },
		"unknown runtime":        func(e *Entry) { e.Artifact.Runtime = "ruby" },
		"absolute path":          func(e *Entry) { e.Permissions.Paths = []string{"/etc"} },
		"home itself":            func(e *Entry) { e.Permissions.Paths = []string{"~/"} },
		"hidden path":            func(e *Entry) { e.Permissions.Paths = []string{"~/.ssh"} },
		"hidden nested":          func(e *Entry) { e.Permissions.Paths = []string{"~/Projects/.git"} },
		"dotdot path":            func(e *Entry) { e.Permissions.Paths = []string{"~/Documents/../.ssh"} },
		"systemd user units":     func(e *Entry) { e.Permissions.Paths = []string{"~/.config/systemd/user"} },
		"double slash":           func(e *Entry) { e.Permissions.Paths = []string{"~/a//b"} },
		"duplicate path":         func(e *Entry) { e.Permissions.Paths = []string{"~/a", "~/a"} },
		"no tools":               func(e *Entry) { e.Tools = nil },
		"password risk":          func(e *Entry) { e.Tools[0].Risk = "password" },
		"describe tool name":     func(e *Entry) { e.Tools[0].Name = "jarvis.describe" },
		"tool name with a space": func(e *Entry) { e.Tools[0].Name = "weather today" },
		"duplicate tool":         func(e *Entry) { e.Tools = append(e.Tools, e.Tools[0]) },
	}
	for name, mutate := range cases {
		e := validEntry()
		e.Tools = append([]ToolDecl(nil), e.Tools...)
		mutate(&e)
		if err := e.Validate(); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
}

func TestParseIndexDropsBadEntriesKeepsGood(t *testing.T) {
	good, _ := json.Marshal(validEntry())
	doc := `{"version":1,"generatedAt":"2026-10-09T08:00:00Z","validUntil":"2026-10-16T08:00:00Z","future":true,"entries":[` +
		string(good) + `,{"id":"../evil"},` + string(good) + `]}`
	ix, err := ParseIndex([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if len(ix.Entries) != 1 || len(ix.Rejected) != 2 {
		t.Fatalf("entries=%d rejected=%v", len(ix.Entries), ix.Rejected)
	}
	if _, ok := ix.Find("weather", "1.2.0"); !ok {
		t.Fatal("Find weather 1.2.0")
	}
	if _, ok := ix.Find("weather", "9.9.9"); ok {
		t.Fatal("Find must match the version too")
	}
	if !ix.Generated().Equal(time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC)) {
		t.Fatalf("generated = %v", ix.Generated())
	}
}

func TestParseIndexRefusesTheWholeDocument(t *testing.T) {
	for name, doc := range map[string]string{
		"not an object": `[]`,
		"format 2":      `{"version":2,"generatedAt":"2026-10-09T08:00:00Z","validUntil":"2026-10-16T08:00:00Z","entries":[]}`,
		"no validUntil": `{"version":1,"generatedAt":"2026-10-09T08:00:00Z","entries":[]}`,
		"bad date":      `{"version":1,"generatedAt":"yesterday","entries":[]}`,
		"too large":     `{"version":1,"generatedAt":"2026-10-09T08:00:00Z","validUntil":"2026-10-16T08:00:00Z","entries":[]}` + strings.Repeat(" ", MaxIndexBytes),
	} {
		if _, err := ParseIndex([]byte(doc)); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestPathsAndToolsMarshalAsLists(t *testing.T) {
	e := validEntry()
	e.Permissions.Paths = nil
	b, _ := json.Marshal(e)
	ix, err := ParseIndex([]byte(`{"version":1,"generatedAt":"2026-10-09T08:00:00Z","validUntil":"2026-10-16T08:00:00Z","entries":[` + string(b) + `]}`))
	if err != nil || len(ix.Entries) != 1 {
		t.Fatalf("%v %v", ix, err)
	}
	out, _ := json.Marshal(ix.Entries[0])
	if !strings.Contains(string(out), `"paths":[]`) {
		t.Fatalf("paths must be [] on the wire: %s", out)
	}
	want := `{"id":"weather","name":"Weather","description":"Forecasts from met.no.","tier":"community","version":"1.2.0","artifact":{"url":"https://example.org/weather-1.2.0.tar.gz","sha256":"` +
		strings.Repeat("ab", 32) + `","runtime":"node"},"permissions":{"network":true,"paths":[]},"tools":[{"name":"weather.today","risk":"safe"}]}`
	if string(out) != want {
		t.Fatalf("wire shape\n got %s\nwant %s", out, want)
	}
}

func TestValidUntilBounded(t *testing.T) {
	ok := `{"version":1,"generatedAt":"2026-10-09T08:00:00Z","validUntil":"2026-11-08T08:00:00Z","entries":[]}`
	ix, err := ParseIndex([]byte(ok))
	if err != nil || !ix.Expiry().Equal(time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)) {
		t.Fatalf("%v %v", ix, err)
	}
	for _, vu := range []string{"2026-11-09T08:00:00Z", "soon", ""} {
		doc := `{"version":1,"generatedAt":"2026-10-09T08:00:00Z","validUntil":"` + vu + `","entries":[]}`
		if _, err := ParseIndex([]byte(doc)); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v", vu, err)
		}
	}
}
