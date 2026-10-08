package settings

import (
	"context"
	"errors"
	"os"
	"reflect"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
)

var ctx = context.Background()

func TestParsers(t *testing.T) {
	if p, err := ParseBrightnessctl("intel_backlight,backlight,12000,50%,24000\n"); err != nil || p != 50 {
		t.Fatalf("brightness %d %v", p, err)
	}
	if p, _ := ParseBrightnessctl("amdgpu_bl0,backlight,77,30%,255\n"); p != 30 {
		t.Fatalf("rounding %d", p)
	}
	if _, err := ParseBrightnessctl("garbage"); err == nil {
		t.Fatal("garbage must fail")
	}
	for out, want := range map[string]Volume{"Volume: 0.40\n": {40, false}, "Volume: 1.25 [MUTED]\n": {125, true}} {
		if v, err := ParseWpctlVolume(out); err != nil || v != want {
			t.Errorf("%q: %+v %v", out, v, err)
		}
	}
	if _, err := ParseWpctlVolume("Object not found\n"); err == nil {
		t.Fatal("wpctl garbage must fail")
	}
	data, err := os.ReadFile("testdata/pw-dump.json")
	if err != nil {
		t.Fatal(err)
	}
	sinks, def, err := ParsePwDump(data)
	if err != nil {
		t.Fatal(err)
	}
	want := []Sink{{SinkID: "alsa_output.pci-0000_00_1f.3.analog-stereo", Name: "Built-in Audio Analog Stereo", id: 48}, {SinkID: "bluez_output.AA_BB_CC_DD_EE_FF.1", Name: "WH-1000XM4", id: 77}}
	if !reflect.DeepEqual(sinks, want) || def != "bluez_output.AA_BB_CC_DD_EE_FF.1" {
		t.Fatalf("sinks %+v default %q", sinks, def)
	}
}

func TestSetters(t *testing.T) {
	pw, _ := os.ReadFile("testdata/pw-dump.json")
	run := (&execx.Fake{}).
		On(execx.OK("intel_backlight,backlight,12000,50%,24000\n"), "brightnessctl", "--class=backlight", "-m", "info").
		On(execx.OK(""), "brightnessctl", "--class=backlight", "-q", "set", "35%").
		On(execx.OK(""), "wpctl", "set-volume", "-l", "1.5", "@DEFAULT_AUDIO_SINK@", "1.20").
		On(execx.OK(""), "wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "1").
		On(execx.OK(string(pw)), "pw-dump").
		On(execx.OK(""), "wpctl", "set-default", "48").
		On(execx.OK("enabled\n"), "nmcli", "-t", "-f", "WIFI", "radio").
		On(execx.OK(""), "nmcli", "radio", "wifi", "off").
		On(execx.OK("balanced\n"), "powerprofilesctl", "get").
		On(execx.OK(""), "powerprofilesctl", "set", "performance")
	s := &System{Run: run}
	if p, err := s.Brightness(ctx); err != nil || p != 50 {
		t.Fatalf("brightness %d %v", p, err)
	}
	pct, muted := 120, true
	for _, err := range []error{
		s.SetBrightness(ctx, 35), s.SetVolume(ctx, &pct, &muted), s.SetDefaultSink(ctx, "alsa_output.pci-0000_00_1f.3.analog-stereo"),
		s.SetWiFi(ctx, false), s.SetPowerProfile(ctx, "performance"),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}
	if on, err := s.WiFi(ctx); err != nil || !on {
		t.Fatalf("wifi %v %v", on, err)
	}
	if p, err := s.PowerProfile(ctx); err != nil || p != "balanced" {
		t.Fatalf("profile %q %v", p, err)
	}
	bad := 151
	for _, err := range []error{s.SetBrightness(ctx, 0), s.SetVolume(ctx, &bad, nil), s.SetPowerProfile(ctx, "turbo")} {
		if err == nil {
			t.Error("out-of-range input must fail before running anything")
		}
	}
	if err := s.SetDefaultSink(ctx, "nope"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unknown sink: %v", err)
	}
}

func TestUnavailable(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.Exit(1, "Device 'backlight' not found.\n"), "brightnessctl", "--class=backlight", "-m", "info").
		OnErr(errors.New("execx: powerprofilesctl not found in /usr/sbin:/usr/bin:/sbin:/bin"), "powerprofilesctl", "get").
		On(execx.Exit(1, "Error: NetworkManager is not running.\n"), "nmcli", "-t", "-f", "WIFI", "radio")
	s := &System{Run: run}
	if _, err := s.Brightness(ctx); !errors.Is(err, ErrUnavailable) {
		t.Errorf("no backlight: %v", err)
	}
	if _, err := s.PowerProfile(ctx); !errors.Is(err, ErrUnavailable) {
		t.Errorf("no ppd: %v", err)
	}
	var ce *CmdError
	if _, err := s.WiFi(ctx); !errors.As(err, &ce) || ce.Message != "Error: NetworkManager is not running." {
		t.Errorf("nm down: %v", err)
	}
}
