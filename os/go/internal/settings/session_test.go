package settings

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
)

func session(t *testing.T, run execx.Runner) *Session {
	home := t.TempDir()
	return &Session{
		Run:            run,
		Display:        func() (string, error) { return "wayland-0", nil },
		Home:           home,
		StateDir:       filepath.Join(home, ".local", "state", "jarvis", "settings"),
		XKBRules:       "testdata/evdev.lst",
		SystemKeyboard: filepath.Join(home, "etc-default-keyboard"),
		Proc:           filepath.Join(home, "proc"),
		UID:            1000,
		Now:            func() time.Time { return time.Date(2026, 10, 9, 20, 30, 0, 0, time.UTC) },
	}
}

func TestOutputsAndScale(t *testing.T) {
	randr, _ := os.ReadFile("testdata/wlr-randr.txt")
	env := []string{"WAYLAND_DISPLAY=wayland-0", "wlr-randr"}
	run := (&execx.Fake{}).
		On(execx.OK(string(randr)), "env", env...).
		On(execx.OK(""), "env", append(env, "--output", "eDP-1", "--scale", "1.5")...)
	s := session(t, run)
	outs, err := s.Outputs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := []Output{{Name: "eDP-1", Enabled: true, Scale: 1.25}, {Name: "HDMI-A-1", Enabled: false, Scale: 1}}
	if !reflect.DeepEqual(outs, want) {
		t.Fatalf("outputs %+v", outs)
	}
	if err := s.SetScale(ctx, "eDP-1", 1.5); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(s.sessionFile()); string(b) != `{"scales":{"eDP-1":1.5}}` {
		t.Fatalf("saved %s", b)
	}
	for _, c := range []struct {
		out   string
		scale float64
	}{{"eDP-1", 3}, {"eDP-1", 1.3}, {"--output", 1}, {"DP-9", 1}} {
		if err := s.SetScale(ctx, c.out, c.scale); err == nil {
			t.Errorf("%v must fail", c)
		}
	}
	noWl := session(t, run)
	noWl.Display = func() (string, error) { return "", errors.New("no session") }
	if _, err := noWl.Outputs(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("no Wayland: %v", err)
	}
}

func TestRestoreScales(t *testing.T) {
	randr, _ := os.ReadFile("testdata/wlr-randr.txt")
	env := []string{"WAYLAND_DISPLAY=wayland-0", "wlr-randr"}
	run := (&execx.Fake{}).
		On(execx.OK(string(randr)), "env", env...).
		On(execx.OK(""), "env", append(env, "--output", "eDP-1", "--scale", "2")...)
	s := session(t, run)
	if err := writeAtomic(s.sessionFile(), []byte(`{"scales":{"eDP-1":2,"HDMI-A-1":1.5,"DP-3":1.25}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.RestoreScales(ctx); err != nil {
		t.Fatal(err)
	}
	if n := len(run.CallsTo("env")); n != 2 {
		t.Fatalf("only the enabled, present, changed output is set: %d calls", n)
	}
}

func TestKeyboard(t *testing.T) {
	s := session(t, nil)
	if kb := s.Keyboard(); kb != (Keyboard{Layout: "us"}) {
		t.Fatalf("default %+v", kb)
	}
	os.WriteFile(s.SystemKeyboard, []byte("XKBMODEL=\"pc105\"\nXKBLAYOUT=\"ara\"\nXKBVARIANT=\"digits\"\n"), 0o644)
	if kb := s.Keyboard(); kb != (Keyboard{Layout: "ara", Variant: "digits"}) {
		t.Fatalf("system %+v", kb)
	}
	envFile := filepath.Join(s.Home, ".config", "labwc", "environment")
	os.MkdirAll(filepath.Dir(envFile), 0o755)
	os.WriteFile(envFile, []byte("XCURSOR_THEME=Adwaita\nXKB_DEFAULT_LAYOUT=us\nXKB_DEFAULT_VARIANT=intl\n"), 0o644)
	// A fake /proc with this user's labwc (pid 4242) and someone else's (pid 99).
	for pid, uid := range map[string]string{"4242": "1000", "99": "1001"} {
		d := filepath.Join(s.Proc, pid)
		os.MkdirAll(d, 0o755)
		os.WriteFile(filepath.Join(d, "comm"), []byte("labwc\n"), 0o644)
		os.WriteFile(filepath.Join(d, "status"), []byte("Name:\tlabwc\nUid:\t"+uid+"\t"+uid+"\t"+uid+"\t"+uid+"\n"), 0o644)
	}
	var sent []string
	s.Kill = func(pid int, sig syscall.Signal) error {
		sent = append(sent, strconv.Itoa(pid)+" "+sig.String())
		return nil
	}
	live, err := s.SetKeyboard(Keyboard{Layout: "fr", Variant: "azerty"})
	if err != nil || !live {
		t.Fatalf("set: %v %v", live, err)
	}
	if b, _ := os.ReadFile(envFile); string(b) != "XCURSOR_THEME=Adwaita\nXKB_DEFAULT_LAYOUT=fr\nXKB_DEFAULT_VARIANT=azerty\n" {
		t.Fatalf("env file:\n%s", b)
	}
	if !reflect.DeepEqual(sent, []string{"4242 hangup"}) {
		t.Fatalf("signals %v", sent)
	}
	if kb := s.Keyboard(); kb != (Keyboard{Layout: "fr", Variant: "azerty"}) {
		t.Fatalf("read back %+v", kb)
	}
	live, err = s.SetKeyboard(Keyboard{Layout: "de"})
	if b, _ := os.ReadFile(envFile); err != nil || string(b) != "XCURSOR_THEME=Adwaita\nXKB_DEFAULT_LAYOUT=de\n" {
		t.Fatalf("no variant line:\n%s %v", b, err)
	}
	for _, bad := range []Keyboard{{Layout: "xx"}, {Layout: "us", Variant: "azerty"}, {Layout: "us\nXKB_DEFAULT_OPTIONS=evil"}} {
		if _, err := s.SetKeyboard(bad); err == nil {
			t.Errorf("%+v must be refused", bad)
		}
	}
	os.RemoveAll(s.Proc)
	os.MkdirAll(s.Proc, 0o755)
	if live, err := s.SetKeyboard(Keyboard{Layout: "us"}); err != nil || live {
		t.Fatalf("no labwc: applies at next login: %v %v", live, err)
	}
}

func TestNightLight(t *testing.T) {
	start := []string{"--user", "--quiet", "--collect", "--unit=jarvis-night-light.service", "--setenv=WAYLAND_DISPLAY=wayland-0"}
	tail := []string{"--", "/usr/bin/wlsunset", "-t", "3500", "-T", "3501", "-S", "06:00", "-s", "18:00"}
	run := (&execx.Fake{}).
		On(execx.Exit(5, "Unit jarvis-night-light.service not loaded.\n"), "systemctl", "--user", "stop", "jarvis-night-light.service").
		On(execx.OK(""), "systemd-run", append(append(append([]string{}, start...), "--property=RuntimeMaxSec=5400"), tail...)...).
		On(execx.OK("active\n"), "systemctl", "--user", "is-active", "jarvis-night-light.service")
	s := session(t, run)
	until := 22
	if err := s.SetNightLight(ctx, true, &until); err != nil {
		t.Fatal(err)
	}
	n, err := s.NightLight(ctx)
	if err != nil || !n.On || n.UntilHour == nil || *n.UntilHour != 22 {
		t.Fatalf("state %+v %v", n, err)
	}
	early := 7 // 07:00 is tomorrow: 10.5 h from 20:30
	run.On(execx.OK(""), "systemd-run", append(append(append([]string{}, start...), "--property=RuntimeMaxSec=37800"), tail...)...)
	if err := s.SetNightLight(ctx, true, &early); err != nil {
		t.Fatal(err)
	}
	if err := s.SetNightLight(ctx, false, nil); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(s.sessionFile()); err != nil || string(b) != `{}` {
		t.Fatalf("off forgets night light: %s %v", b, err)
	}
	bad := 24
	if err := s.SetNightLight(ctx, true, &bad); err == nil {
		t.Fatal("hour 24 must fail")
	}
}

func TestRestoreNightLightAndPreserveSession(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK(""), "systemctl", "--user", "stop", nightUnit).
		On(execx.OK(""), "systemd-run", "--user", "--quiet", "--collect", "--unit="+nightUnit, "--setenv=WAYLAND_DISPLAY=wayland-0", "--property=RuntimeMaxSec=5400", "--", "/usr/bin/wlsunset", "-t", "3500", "-T", "3501", "-S", "06:00", "-s", "18:00")
	s := session(t, run)
	if err := writeAtomic(s.sessionFile(), []byte(`{"scales":{},"nightLight":{"on":true,"untilHour":22},"future":{"value":1}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.RestoreScales(ctx); err != nil {
		t.Fatal(err)
	}
	if !run.Ran("systemctl", "--user", "stop", nightUnit) {
		t.Fatal("night light not restored")
	}
	if err := s.SetNightLight(ctx, false, nil); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(s.sessionFile())
	if !strings.Contains(string(b), `"future":{"value":1}`) {
		t.Fatalf("lost unrelated session state: %s", b)
	}
}

func TestNightLightCommandFailure(t *testing.T) {
	run := (&execx.Fake{}).On(execx.Exit(1, "Failed to connect to bus"), "systemctl", "--user", "is-active", nightUnit)
	s := session(t, run)
	if _, err := s.NightLight(ctx); err == nil {
		t.Fatal("bus failure must not look like off")
	}
	run.On(execx.Exit(3, ""), "systemctl", "--user", "is-active", nightUnit)
	if n, err := s.NightLight(ctx); err != nil || n.On {
		t.Fatalf("inactive: %+v %v", n, err)
	}
}

func TestKeyboardPreservesBlankLines(t *testing.T) {
	s := session(t, nil)
	path := s.labwcEnv()
	if err := writeAtomic(path, []byte("# user settings\n\nXCURSOR_THEME=Adwaita\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetKeyboard(Keyboard{Layout: "us"}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "# user settings\n\nXCURSOR_THEME=Adwaita\nXKB_DEFAULT_LAYOUT=us\n" {
		t.Fatalf("lost original lines: %s", data)
	}
}
