package clocktools

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

func deps(run execx.Runner) Deps {
	return Deps{
		Run:         run,
		Now:         func() time.Time { return time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC) },
		Local:       time.UTC,
		NewID:       func() string { return "abcd1234" },
		HasNotifier: func() bool { return true },
	}
}

func call(t *testing.T, d Deps, name, args string) (any, error) {
	t.Helper()
	for _, tool := range Tools(d) {
		if tool.Name == name {
			return tool.Call(context.Background(), json.RawMessage(args))
		}
	}
	t.Fatalf("no tool %s", name)
	return nil, nil
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func codeOf(err error) mcp.Code {
	if err == nil {
		return ""
	}
	return mcp.AsToolError(err).Code
}

func TestToolsMatchContract(t *testing.T) {
	var got []string
	for _, tool := range Tools(Deps{}) {
		if tool.Risk != mcp.RiskSafe || tool.Hidden || len(tool.Secrets) != 0 || tool.Batch != "" {
			t.Errorf("%s must be a plain safe tool (contracts §3)", tool.Name)
		}
		got = append(got, tool.Name)
	}
	if !reflect.DeepEqual(got, []string{"clock.now", "clock.timer"}) {
		t.Fatalf("tools %v", got)
	}
	if Manifest.ID != "jarvis-clock" || Manifest.Permissions.Network || len(Manifest.Permissions.Paths) != 0 {
		t.Fatalf("manifest %+v", Manifest)
	}
}

func TestNow(t *testing.T) {
	got, err := call(t, deps(nil), "clock.now", `{"timezone":"Asia/Tokyo"}`)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"utc":"2026-10-09T08:00:00Z","local":"2026-10-09T17:00:00+09:00","timezone":"Asia/Tokyo","unix":1791532800,"weekday":"Friday"}`
	if s := asJSON(t, got); s != want {
		t.Fatalf("got  %s\nwant %s", s, want)
	}
	got, _ = call(t, deps(nil), "clock.now", `{}`)
	if s := asJSON(t, got); !strings.Contains(s, `"timezone":"UTC"`) || !strings.Contains(s, `"local":"2026-10-09T08:00:00Z"`) {
		t.Fatalf("default zone: %s", s)
	}
}

func TestNowRefusals(t *testing.T) {
	for args, want := range map[string]mcp.Code{
		`{"timezone":"../../etc/passwd"}`: mcp.CodeInvalid,
		`{"timezone":"Mars/Olympus"}`:     mcp.CodeNotFound,
		`{"tz":"UTC"}`:                    mcp.CodeInvalid,
	} {
		if _, err := call(t, deps(nil), "clock.now", args); codeOf(err) != want {
			t.Errorf("%s: %v, want %s", args, err, want)
		}
	}
}

var timerArgs = []string{"--user", "--quiet", "--collect", "--unit=jarvis-timer-abcd1234", "--on-active=300s",
	"--timer-property=AccuracySec=1s", "--", "/usr/bin/notify-send", "--app-name=Jarvis", "--", "Jarvis timer", "Tea is ready"}

func TestTimerStartsATransientUserTimer(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK(""), "systemd-run", timerArgs...)
	got, err := call(t, deps(run), "clock.timer", `{"seconds":300,"label":"  Tea is ready "}`)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"timerId":"jarvis-timer-abcd1234","seconds":300,"label":"Tea is ready","firesAt":"2026-10-09T08:05:00Z"}`
	if s := asJSON(t, got); s != want {
		t.Fatalf("got  %s\nwant %s", s, want)
	}
}

func TestTimerDefaultLabelAndFailures(t *testing.T) {
	args := append([]string(nil), timerArgs...)
	args[4] = "--on-active=60s"
	args[len(args)-1] = text.DefaultLabel
	run := (&execx.Fake{}).On(execx.OK(""), "systemd-run", args...)
	if _, err := call(t, deps(run), "clock.timer", `{"seconds":60}`); err != nil {
		t.Fatalf("default label: %v", err)
	}
	for _, bad := range []string{`{"seconds":0}`, `{"seconds":86401}`, `{"seconds":5,"label":"\u001b[2J"}`, `{"seconds":5,"label":"a\u202eb"}`, `{"seconds":5,"label":"` + strings.Repeat("x", 101) + `"}`, `{}`} {
		if _, err := call(t, deps(&execx.Fake{}), "clock.timer", bad); codeOf(err) != mcp.CodeInvalid {
			t.Errorf("%s: %v", bad, err)
		}
	}
	busFail := (&execx.Fake{}).On(execx.Exit(1, "Failed to connect to bus: No medium found\n"), "systemd-run", args...)
	_, err := call(t, deps(busFail), "clock.timer", `{"seconds":60}`)
	if codeOf(err) != mcp.CodeFailed || !strings.Contains(err.Error(), "Failed to connect to bus") {
		t.Fatalf("bus failure: %v", err)
	}
	gone := (&execx.Fake{}).OnErr(errors.New("systemd-run not found"), "systemd-run", args...)
	if _, err := call(t, deps(gone), "clock.timer", `{"seconds":60}`); codeOf(err) != mcp.CodeFailed {
		t.Fatalf("no systemd-run: %v", err)
	}
}

func TestTimerUnsupportedWithoutNotifier(t *testing.T) {
	d := deps(&execx.Fake{})
	d.HasNotifier = func() bool { return false }
	_, err := call(t, d, "clock.timer", `{"seconds":60}`)
	if codeOf(err) != mcp.CodeUnsupported {
		t.Fatalf("got %v", err)
	}
}

func TestLocalZone(t *testing.T) {
	none := func(string) string { return "" }
	noLink := func(string) (string, error) { return "", errors.New("no link") }
	if z := LocalZone(func(k string) string {
		if k == "TZ" {
			return ":Asia/Tokyo"
		}
		return ""
	}, noLink); z.String() != "Asia/Tokyo" {
		t.Errorf("TZ: %s", z)
	}
	if z := LocalZone(none, func(string) (string, error) { return "/usr/share/zoneinfo/Europe/Berlin", nil }); z.String() != "Europe/Berlin" {
		t.Errorf("link: %s", z)
	}
	if z := LocalZone(none, func(string) (string, error) { return "../zoneinfo/../../etc/passwd", nil }); z != time.Local {
		t.Errorf("odd link must fall back to time.Local: %s", z)
	}
	if z := LocalZone(none, noLink); z != time.Local {
		t.Errorf("fallback: %s", z)
	}
}
