package settingstools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/settings"
)

type bus struct {
	objs settings.Objects
	log  []string
}

func (b *bus) ManagedObjects(context.Context) (settings.Objects, error) { return b.objs, nil }
func (b *bus) Call(_ context.Context, p dbus.ObjectPath, m string, _ ...any) error {
	b.log = append(b.log, string(p)+" "+m)
	return nil
}
func (b *bus) SetProperty(_ context.Context, p dbus.ObjectPath, _, prop string, v any) error {
	b.log = append(b.log, string(p)+" set "+prop)
	return nil
}

func newBus() *bus {
	dev := func(addr, name string, paired bool) map[string]map[string]dbus.Variant {
		return map[string]map[string]dbus.Variant{"org.bluez.Device1": {
			"Address": dbus.MakeVariant(addr), "Alias": dbus.MakeVariant(name), "Paired": dbus.MakeVariant(paired),
			"Connected": dbus.MakeVariant(paired), "Adapter": dbus.MakeVariant(dbus.ObjectPath("/org/bluez/hci0")),
		}}
	}
	return &bus{objs: settings.Objects{
		"/org/bluez/hci0":                       {"org.bluez.Adapter1": {"Powered": dbus.MakeVariant(true)}},
		"/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF": dev("AA:BB:CC:DD:EE:FF", "WH-1000XM4", true),
	}}
}

func deps(t *testing.T, run *execx.Fake) (Deps, *bus) {
	home := t.TempDir()
	b := newBus()
	return Deps{
		Sys: &settings.System{Run: run},
		Sess: &settings.Session{
			Run: run, Display: func() (string, error) { return "wayland-0", nil },
			Home: home, StateDir: filepath.Join(home, "state"),
			XKBRules: "../settings/testdata/evdev.lst", SystemKeyboard: filepath.Join(home, "none"),
			Proc: filepath.Join(home, "proc"), UID: 1000,
			Kill: func(int, syscall.Signal) error { return nil },
			Now:  func() time.Time { return time.Date(2026, 10, 9, 20, 0, 0, 0, time.UTC) },
		},
		BT: &settings.Bluez{Bus: b, Sleep: func(time.Duration) {}},
	}, b
}

func call(t *testing.T, d Deps, name, args string) (map[string]any, error) {
	t.Helper()
	for _, tool := range Tools(d) {
		if tool.Name == name {
			v, err := tool.Call(context.Background(), json.RawMessage(args))
			if err != nil {
				return nil, err
			}
			b, _ := json.Marshal(v)
			var m map[string]any
			json.Unmarshal(b, &m)
			return m, nil
		}
	}
	t.Fatalf("no tool %s", name)
	return nil, nil
}

func describe(t *testing.T, d Deps, name, args string) mcp.Description {
	t.Helper()
	for _, tool := range Tools(d) {
		if tool.Name == name {
			desc, err := tool.Describe(context.Background(), json.RawMessage(args))
			if err != nil {
				t.Fatal(err)
			}
			return desc
		}
	}
	t.Fatalf("no tool %s", name)
	return mcp.Description{}
}

func codeOf(err error) mcp.Code {
	if err == nil {
		return ""
	}
	return mcp.AsToolError(err).Code
}

func TestToolsMatchContract(t *testing.T) {
	var names []string
	for _, tool := range Tools(Deps{}) {
		names = append(names, tool.Name)
		want := mcp.RiskConfirm
		if tool.Name == "settings.get" {
			want = mcp.RiskSafe
		}
		if tool.Risk != want || tool.Hidden || tool.Batch != "" {
			t.Errorf("%s: risk %s", tool.Name, tool.Risk)
		}
	}
	want := []string{"settings.get", "settings.brightness", "settings.volume", "settings.night_light", "settings.wifi", "settings.bluetooth",
		"settings.bluetooth_pair", "settings.bluetooth_unpair", "settings.audio_output", "settings.power_profile", "settings.scale", "settings.keyboard"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("tools %v", names)
	}
	if err := (&mcp.Server{Name: "jarvis-settings", Tools: Tools(Deps{})}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestGetReportsMissingThingsAsNull(t *testing.T) {
	pw, _ := os.ReadFile("../settings/testdata/pw-dump.json")
	randr, _ := os.ReadFile("../settings/testdata/wlr-randr.txt")
	run := (&execx.Fake{}).
		On(execx.Exit(1, "Device 'backlight' not found.\n"), "brightnessctl", "--class=backlight", "-m", "info").
		On(execx.OK("Volume: 0.55 [MUTED]\n"), "wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@").
		On(execx.Exit(3, ""), "systemctl", "--user", "is-active", "jarvis-night-light.service").
		On(execx.Exit(1, "Error: NetworkManager is not running.\n"), "nmcli", "-t", "-f", "WIFI", "radio").
		On(execx.OK(string(pw)), "pw-dump").
		On(execx.OK("balanced\n"), "powerprofilesctl", "get").
		On(execx.OK(string(randr)), "env", "WAYLAND_DISPLAY=wayland-0", "wlr-randr")
	d, _ := deps(t, run)
	m, err := call(t, d, "settings.get", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	if m["brightness"] != nil || m["volume"] != 55.0 || m["muted"] != true || m["wifi"] != nil || m["powerProfile"] != "balanced" {
		t.Fatalf("get %v", m)
	}
	if m["audioOutput"].(map[string]any)["name"] != "WH-1000XM4" || len(m["audioOutput"].(map[string]any)["available"].([]any)) != 2 {
		t.Fatalf("audio %v", m["audioOutput"])
	}
	if m["bluetooth"].(map[string]any)["on"] != true || m["keyboard"].(map[string]any)["layout"] != "us" {
		t.Fatalf("bt/keyboard %v %v", m["bluetooth"], m["keyboard"])
	}
	errs := m["errors"].(map[string]any)
	if _, ok := errs["brightness"]; ok || !strings.Contains(errs["wifi"].(string), "NetworkManager is not running") {
		t.Fatalf("errors %v (unavailable is not an error)", errs)
	}
	m, _ = call(t, d, "settings.get", `{"keys":["powerProfile"]}`)
	if len(m) != 1 || m["powerProfile"] != "balanced" {
		t.Fatalf("one key %v", m)
	}
	if _, err := call(t, d, "settings.get", `{"keys":["password"]}`); codeOf(err) != mcp.CodeInvalid {
		t.Fatalf("bad key %v", err)
	}
}

func TestSettersReturnPreviousCurrentAndUndo(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK("intel_backlight,backlight,16800,70%,24000\n"), "brightnessctl", "--class=backlight", "-m", "info").
		On(execx.OK(""), "brightnessctl", "--class=backlight", "-q", "set", "40%").
		On(execx.OK("Volume: 0.30\n"), "wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@").
		On(execx.OK(""), "wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "1").
		On(execx.OK("disabled\n"), "nmcli", "-t", "-f", "WIFI", "radio").
		On(execx.OK(""), "nmcli", "radio", "wifi", "on").
		On(execx.OK("balanced\n"), "powerprofilesctl", "get").
		On(execx.OK(""), "powerprofilesctl", "set", "power-saver")
	d, b := deps(t, run)
	cases := []struct{ tool, args, want string }{
		{"settings.brightness", `{"percent":40}`, `{"current":40,"previous":70,"undo":{"input":{"percent":70},"tool":"settings.brightness"}}`},
		{"settings.volume", `{"muted":true}`, `{"current":{"muted":true,"percent":30},"previous":{"muted":false,"percent":30},"undo":{"input":{"muted":false,"percent":30},"tool":"settings.volume"}}`},
		{"settings.wifi", `{"on":true}`, `{"current":true,"previous":false,"undo":{"input":{"on":false},"tool":"settings.wifi"}}`},
		{"settings.power_profile", `{"profile":"power-saver"}`, `{"current":"power-saver","previous":"balanced","undo":{"input":{"profile":"balanced"},"tool":"settings.power_profile"}}`},
		{"settings.bluetooth_unpair", `{"address":"aa:bb:cc:dd:ee:ff"}`, `{"current":{"paired":false},"previous":{"paired":true},"undo":{"input":{"address":"AA:BB:CC:DD:EE:FF"},"tool":"settings.bluetooth_pair"}}`},
	}
	for _, c := range cases {
		m, err := call(t, d, c.tool, c.args)
		if err != nil {
			t.Fatalf("%s: %v", c.tool, err)
		}
		got, _ := json.Marshal(m)
		if string(got) != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.tool, got, c.want)
		}
	}
	if !strings.Contains(strings.Join(b.log, "|"), "RemoveDevice") {
		t.Fatalf("bluez log %v", b.log)
	}
	for args, tool := range map[string]string{`{"percent":0}`: "settings.brightness", `{}`: "settings.volume", `{"on":"yes"}`: "settings.wifi", `{"profile":"turbo"}`: "settings.power_profile", `{"output":"eDP-1","scale":3}`: "settings.scale", `{"address":"AA:BB"}`: "settings.bluetooth_pair", `{"layout":"xx"}`: "settings.keyboard"} {
		if _, err := call(t, d, tool, args); codeOf(err) != mcp.CodeInvalid {
			t.Errorf("%s %s: %v", tool, args, err)
		}
	}
}

func TestKeyboardSetterAndCards(t *testing.T) {
	run := (&execx.Fake{}).On(execx.OK("intel_backlight,backlight,16800,70%,24000\n"), "brightnessctl", "--class=backlight", "-m", "info").On(execx.Exit(3, ""), "systemctl", "--user", "is-active", "jarvis-night-light.service")
	d, _ := deps(t, run)
	m, err := call(t, d, "settings.keyboard", `{"layout":"ara","variant":"digits"}`)
	if err != nil {
		t.Fatal(err)
	}
	if m["live"] != false || !reflect.DeepEqual(m["undo"], map[string]any{"tool": "settings.keyboard", "input": map[string]any{"layout": "us"}}) {
		t.Fatalf("keyboard %v", m)
	}
	for _, c := range []struct{ tool, args, title, detail string }{
		{"settings.brightness", `{"percent":40}`, "Set screen brightness to 40%", "70% → 40%"},
		{"settings.night_light", `{"on":true,"untilHour":7}`, "Turn night light on until 07:00", "off → on until 07:00"},
		{"settings.keyboard", `{"layout":"fr","variant":"azerty"}`, "Switch keyboard layout to fr (azerty)", "ara (digits) → fr (azerty)"},
		{"settings.scale", `{"output":"eDP-1","scale":1.5}`, "Set eDP-1 display scale to 1.5", "unknown → 1.5"},
	} {
		desc := describe(t, d, c.tool, c.args)
		if desc.Title != c.title || desc.Detail != c.detail || desc.Source != mcp.SourceSystem {
			t.Errorf("%s: %+v", c.tool, desc)
		}
	}
}

func TestNightLightRequiresOn(t *testing.T) {
	d, _ := deps(t, &execx.Fake{})
	for _, args := range []string{`{}`, `{"on":null}`} {
		if _, err := call(t, d, "settings.night_light", args); codeOf(err) != mcp.CodeInvalid {
			t.Fatalf("%s: %v", args, err)
		}
	}
}

func TestPairAlreadyPairedUndoPreservesPairing(t *testing.T) {
	d, _ := deps(t, &execx.Fake{})
	m, err := call(t, d, "settings.bluetooth_pair", `{"address":"AA:BB:CC:DD:EE:FF"}`)
	if err != nil {
		t.Fatal(err)
	}
	if m["undo"].(map[string]any)["tool"] != "settings.bluetooth_pair" {
		t.Fatalf("undo removes existing pairing: %v", m)
	}
}
