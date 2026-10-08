// Package clocktools implements jarvis-clock's tools (Rafiq M2.5
// contracts §3): clock.now and clock.timer, both safe.
package clocktools

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/official"
	"github.com/mmAbdelhay/jarvis/os/go/internal/registry"
)

// Manifest is jarvis-clock's registry manifest: no network, no writes.
var Manifest = official.Manifest{
	ID:          "jarvis-clock",
	Name:        "Clock",
	Description: "Current time in any time zone, and desktop timers.",
	Permissions: registry.Permissions{Network: false, Paths: []string{}},
}

// Deps are jarvis-clock's side effects.
type Deps struct {
	Run   execx.Runner
	Now   func() time.Time // nil: time.Now
	Local *time.Location   // nil: time.Local
	NewID func() string    // nil: 8 random hex digits
	// HasNotifier reports whether desktop notifications are possible;
	// nil: /usr/bin/notify-send exists. The server cannot ask the
	// daemon itself (the session bus is inaccessible in its sandbox).
	HasNotifier func() bool
}

func (d Deps) clock() time.Time {
	if d.Now == nil {
		return time.Now()
	}
	return d.Now()
}

func (d Deps) local() *time.Location {
	if d.Local == nil {
		return time.Local
	}
	return d.Local
}

func (d Deps) hasNotifier() bool {
	if d.HasNotifier != nil {
		return d.HasNotifier()
	}
	_, err := os.Stat("/usr/bin/notify-send")
	return err == nil
}

func (d Deps) newID() string {
	if d.NewID != nil {
		return d.NewID()
	}
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Tools returns every jarvis-clock tool.
func Tools(d Deps) []mcp.Tool {
	return []mcp.Tool{
		{
			Name:        "clock.now",
			Description: "The current date and time, in this computer's time zone or in a named IANA time zone such as Africa/Cairo.",
			InputSchema: `{"type":"object","properties":{"timezone":{"type":"string","minLength":1,"maxLength":64}},"additionalProperties":false}`,
			Risk:        mcp.RiskSafe,
			Call:        d.now,
		},
		{
			Name:        "clock.timer",
			Description: "Start a desktop timer that shows a notification after the given number of seconds (1 second to 24 hours), with an optional short label.",
			InputSchema: `{"type":"object","properties":{"seconds":{"type":"integer","minimum":1,"maximum":86400},"label":{"type":"string","maxLength":100}},"required":["seconds"],"additionalProperties":false}`,
			Risk:        mcp.RiskSafe,
			Call:        d.timer,
		},
	}
}

// Now is clock.now's structuredContent.
type Now struct {
	UTC      string `json:"utc"`
	Local    string `json:"local"`
	Timezone string `json:"timezone"`
	Unix     int64  `json:"unix"`
	Weekday  string `json:"weekday"`
}

var tzRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$`)

func (d Deps) now(_ context.Context, raw json.RawMessage) (any, error) {
	var in struct {
		Timezone string `json:"timezone"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	loc := d.local()
	if in.Timezone != "" {
		if !tzRe.MatchString(in.Timezone) {
			return nil, mcp.Errorf(mcp.CodeInvalid, "%q is not a time zone name like Africa/Cairo", in.Timezone)
		}
		l, err := time.LoadLocation(in.Timezone)
		if err != nil {
			return nil, mcp.Errorf(mcp.CodeNotFound, "unknown time zone %q", in.Timezone)
		}
		loc = l
	}
	t := d.clock().In(loc)
	return Now{
		UTC: t.UTC().Format(time.RFC3339), Local: t.Format(time.RFC3339),
		Timezone: loc.String(), Unix: t.Unix(), Weekday: t.Weekday().String(),
	}, nil
}

// Timer is clock.timer's structuredContent.
type Timer struct {
	TimerID string `json:"timerId"`
	Seconds int    `json:"seconds"`
	Label   string `json:"label"`
	FiresAt string `json:"firesAt"`
}

func printable(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			return false
		}
	}
	return utf8.ValidString(s)
}

// timer starts a transient user timer (systemd-run --user --on-active)
// that runs notify-send, so it survives this server being restarted.
func (d Deps) timer(ctx context.Context, raw json.RawMessage) (any, error) {
	var in struct {
		Seconds int    `json:"seconds"`
		Label   string `json:"label"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if in.Seconds < 1 || in.Seconds > 86400 {
		return nil, mcp.Errorf(mcp.CodeInvalid, "seconds must be 1 to 86400")
	}
	label := strings.TrimSpace(in.Label)
	if utf8.RuneCountInString(label) > 100 || !printable(label) {
		return nil, mcp.Errorf(mcp.CodeInvalid, "the label must be plain text of at most 100 characters")
	}
	if label == "" {
		label = text.DefaultLabel
	}
	if !d.hasNotifier() {
		return nil, mcp.Errorf(mcp.CodeUnsupported, "this computer has no desktop notifications, so timers are not available")
	}
	id := "jarvis-timer-" + d.newID()
	fires := d.clock().Add(time.Duration(in.Seconds) * time.Second)
	res, err := d.Run.Run(ctx, execx.Cmd{
		Name: "systemd-run",
		Args: []string{"--user", "--quiet", "--collect", "--unit=" + id, fmt.Sprintf("--on-active=%ds", in.Seconds),
			"--timer-property=AccuracySec=1s", "--", "/usr/bin/notify-send", "--app-name=Jarvis", "--", text.Summary, label},
		Timeout: 10 * time.Second,
	})
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "could not start the timer: %v", err)
	}
	if res.ExitCode != 0 {
		return nil, mcp.Errorf(mcp.CodeFailed, "could not start the timer: %s", strings.TrimSpace(string(res.Stderr)))
	}
	return Timer{TimerID: id, Seconds: in.Seconds, Label: label, FiresAt: fires.UTC().Format(time.RFC3339)}, nil
}

// LocalZone finds the system time zone by name (TZ, then the
// /etc/localtime link), so clock.now reports "Africa/Cairo" rather than
// "Local". Anything odd falls back to time.Local.
func LocalZone(getenv func(string) string, readlink func(string) (string, error)) *time.Location {
	try := func(name string) *time.Location {
		name = strings.TrimPrefix(name, ":")
		if !tzRe.MatchString(name) {
			return nil
		}
		l, err := time.LoadLocation(name)
		if err != nil {
			return nil
		}
		return l
	}
	if l := try(getenv("TZ")); l != nil {
		return l
	}
	if target, err := readlink("/etc/localtime"); err == nil {
		if i := strings.LastIndex(target, "zoneinfo/"); i >= 0 {
			if l := try(target[i+len("zoneinfo/"):]); l != nil {
				return l
			}
		}
	}
	return time.Local
}
