// Package settings reads and changes desktop settings for jarvis-settings
// (Rafiq M3 contracts §1) through the system's own tools and services:
// brightnessctl (which goes through logind), PipeWire's wpctl/pw-dump,
// NetworkManager's nmcli, power-profiles-daemon, wlr-randr, labwc's
// environment file, wlsunset and BlueZ. No root is needed for any of them.
package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
)

// ErrUnavailable means this machine has no such thing (no backlight, no
// Bluetooth adapter, no power-profiles-daemon, ...). settings.get reports
// such a key as null; a setter reports it as not_found.
var ErrUnavailable = errors.New("not available on this computer")

// CmdError is a tool that ran and failed.
type CmdError struct {
	Tool, Message string
}

func (e *CmdError) Error() string { return e.Tool + ": " + e.Message }

const cmdTimeout = 10 * time.Second

// System is the computer, seen through its command-line tools.
type System struct {
	Run execx.Runner
}

// out runs a command and returns stdout; a failed run is a *CmdError.
func (s *System) out(ctx context.Context, name string, args ...string) (string, error) {
	res, err := s.Run.Run(ctx, execx.Cmd{Name: name, Args: args, Timeout: cmdTimeout})
	if err != nil {
		if strings.Contains(err.Error(), "not found in") { // execx.LookPath: not installed
			return "", ErrUnavailable
		}
		return "", &CmdError{Tool: name, Message: err.Error()}
	}
	if res.ExitCode != 0 {
		msg := strings.TrimSpace(string(res.Stderr))
		if msg == "" {
			msg = strings.TrimSpace(string(res.Stdout))
		}
		return "", &CmdError{Tool: name, Message: msg}
	}
	return string(res.Stdout), nil
}

// ParseBrightnessctl reads `brightnessctl -m info`
// ("intel_backlight,backlight,12000,50%,24000") into a percent.
func ParseBrightnessctl(out string) (int, error) {
	line := strings.TrimSpace(strings.SplitN(out, "\n", 2)[0])
	f := strings.Split(line, ",")
	if len(f) != 5 {
		return 0, fmt.Errorf("brightnessctl: unexpected output %q", line)
	}
	cur, err1 := strconv.Atoi(f[2])
	max, err2 := strconv.Atoi(f[4])
	if err1 != nil || err2 != nil || max <= 0 {
		return 0, fmt.Errorf("brightnessctl: unexpected output %q", line)
	}
	return int(math.Round(float64(cur) * 100 / float64(max))), nil
}

// Brightness is the backlight in percent.
func (s *System) Brightness(ctx context.Context) (int, error) {
	out, err := s.out(ctx, "brightnessctl", "--class=backlight", "-m", "info")
	if err != nil {
		var ce *CmdError
		if errors.As(err, &ce) && strings.Contains(ce.Message, "not found") {
			return 0, ErrUnavailable
		}
		return 0, err
	}
	return ParseBrightnessctl(out)
}

// SetBrightness sets the backlight (1-100 %).
func (s *System) SetBrightness(ctx context.Context, percent int) error {
	if percent < 1 || percent > 100 {
		return fmt.Errorf("brightness must be 1 to 100")
	}
	_, err := s.out(ctx, "brightnessctl", "--class=backlight", "-q", "set", strconv.Itoa(percent)+"%")
	return err
}

// Volume is the default output's volume.
type Volume struct {
	Percent int  `json:"percent"`
	Muted   bool `json:"muted"`
}

// ParseWpctlVolume reads `wpctl get-volume` ("Volume: 0.40 [MUTED]").
func ParseWpctlVolume(out string) (Volume, error) {
	f := strings.Fields(out)
	if len(f) < 2 || f[0] != "Volume:" {
		return Volume{}, fmt.Errorf("wpctl: unexpected output %q", strings.TrimSpace(out))
	}
	v, err := strconv.ParseFloat(f[1], 64)
	if err != nil || v < 0 {
		return Volume{}, fmt.Errorf("wpctl: unexpected output %q", strings.TrimSpace(out))
	}
	return Volume{Percent: int(math.Round(v * 100)), Muted: strings.Contains(out, "[MUTED]")}, nil
}

const defaultSink = "@DEFAULT_AUDIO_SINK@"

// Volume reads the default output's volume.
func (s *System) Volume(ctx context.Context) (Volume, error) {
	out, err := s.out(ctx, "wpctl", "get-volume", defaultSink)
	if err != nil {
		return Volume{}, err
	}
	return ParseWpctlVolume(out)
}

// SetVolume changes the volume (0-150 %) and/or mute; nil leaves it.
func (s *System) SetVolume(ctx context.Context, percent *int, muted *bool) error {
	if percent != nil {
		if *percent < 0 || *percent > 150 {
			return fmt.Errorf("volume must be 0 to 150")
		}
		if _, err := s.out(ctx, "wpctl", "set-volume", "-l", "1.5", defaultSink, fmt.Sprintf("%.2f", float64(*percent)/100)); err != nil {
			return err
		}
	}
	if muted != nil {
		v := "0"
		if *muted {
			v = "1"
		}
		if _, err := s.out(ctx, "wpctl", "set-mute", defaultSink, v); err != nil {
			return err
		}
	}
	return nil
}

// Sink is one audio output.
type Sink struct {
	SinkID string `json:"sinkId"` // PipeWire node.name, stable across reboots
	Name   string `json:"name"`   // node.description
	id     int    // PipeWire object id, valid until the next restart
}

type pwObject struct {
	ID   int    `json:"id"`
	Type string `json:"type"`
	Info struct {
		Props map[string]any `json:"props"`
	} `json:"info"`
	Props    map[string]any `json:"props"`
	Metadata []struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
	} `json:"metadata"`
}

// ParsePwDump reads `pw-dump` into the audio sinks and the default sink's
// node.name ("" when unknown).
func ParsePwDump(out []byte) ([]Sink, string, error) {
	var objs []pwObject
	if err := json.Unmarshal(out, &objs); err != nil {
		return nil, "", fmt.Errorf("pw-dump: %v", err)
	}
	sinks := []Sink{}
	def := ""
	for _, o := range objs {
		switch o.Type {
		case "PipeWire:Interface:Node":
			if o.Info.Props["media.class"] != "Audio/Sink" {
				continue
			}
			name, _ := o.Info.Props["node.name"].(string)
			desc, _ := o.Info.Props["node.description"].(string)
			if name == "" {
				continue
			}
			if desc == "" {
				desc = name
			}
			sinks = append(sinks, Sink{SinkID: name, Name: desc, id: o.ID})
		case "PipeWire:Interface:Metadata":
			if o.Props["metadata.name"] != "default" {
				continue
			}
			for _, m := range o.Metadata {
				if m.Key != "default.audio.sink" {
					continue
				}
				var v struct {
					Name string `json:"name"`
				}
				if json.Unmarshal(m.Value, &v) == nil {
					def = v.Name
				}
			}
		}
	}
	return sinks, def, nil
}

// Sinks lists the audio outputs and the default one's id.
func (s *System) Sinks(ctx context.Context) ([]Sink, string, error) {
	out, err := s.out(ctx, "pw-dump")
	if err != nil {
		return nil, "", err
	}
	return ParsePwDump([]byte(out))
}

// SetDefaultSink makes sinkID (a node.name from Sinks) the default output.
func (s *System) SetDefaultSink(ctx context.Context, sinkID string) error {
	sinks, _, err := s.Sinks(ctx)
	if err != nil {
		return err
	}
	for _, k := range sinks {
		if k.SinkID == sinkID {
			_, err := s.out(ctx, "wpctl", "set-default", strconv.Itoa(k.id))
			return err
		}
	}
	return ErrUnavailable
}

// WiFi reports whether the Wi-Fi radio is enabled.
func (s *System) WiFi(ctx context.Context) (bool, error) {
	out, err := s.out(ctx, "nmcli", "-t", "-f", "WIFI", "radio")
	if err != nil {
		return false, err
	}
	switch strings.TrimSpace(out) {
	case "enabled":
		return true, nil
	case "disabled":
		return false, nil
	}
	return false, fmt.Errorf("nmcli: unexpected output %q", strings.TrimSpace(out))
}

// SetWiFi turns the Wi-Fi radio on or off.
func (s *System) SetWiFi(ctx context.Context, on bool) error {
	v := "off"
	if on {
		v = "on"
	}
	_, err := s.out(ctx, "nmcli", "radio", "wifi", v)
	return err
}

// PowerProfiles are the profiles power-profiles-daemon knows.
var PowerProfiles = []string{"power-saver", "balanced", "performance"}

// PowerProfile reads the active profile.
func (s *System) PowerProfile(ctx context.Context) (string, error) {
	out, err := s.out(ctx, "powerprofilesctl", "get")
	if err != nil {
		var ce *CmdError
		if errors.As(err, &ce) && (strings.Contains(ce.Message, "not found") || strings.Contains(ce.Message, "ServiceUnknown")) {
			return "", ErrUnavailable
		}
		return "", err
	}
	p := strings.TrimSpace(out)
	for _, k := range PowerProfiles {
		if p == k {
			return p, nil
		}
	}
	return "", fmt.Errorf("powerprofilesctl: unexpected output %q", p)
}

// SetPowerProfile switches profile.
func (s *System) SetPowerProfile(ctx context.Context, profile string) error {
	ok := false
	for _, k := range PowerProfiles {
		ok = ok || k == profile
	}
	if !ok {
		return fmt.Errorf("unknown power profile %q", profile)
	}
	_, err := s.out(ctx, "powerprofilesctl", "set", profile)
	return err
}
