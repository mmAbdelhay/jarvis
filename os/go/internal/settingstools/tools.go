// Package settingstools implements jarvis-settings' settings tools (Rafiq
// M3 contracts §1): settings.get (safe) and the confirm setters. Every
// setter returns {previous, current, undo}, where undo is {tool, input}
// that puts the previous value back.
package settingstools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/settings"
)

// Deps are the settings backends.
type Deps struct {
	Sys  *settings.System
	Sess *settings.Session
	BT   *settings.Bluez
}

// Undo is the undo object (contracts §1).
type Undo struct {
	Tool  string `json:"tool"`
	Input any    `json:"input"`
}

// Change is every setter's structuredContent.
type Change struct {
	Previous any   `json:"previous"`
	Current  any   `json:"current"`
	Undo     *Undo `json:"undo"`
}

// Keys are settings.get's keys, in contract order.
var Keys = []string{"brightness", "volume", "muted", "nightLight", "wifi", "bluetooth", "audioOutput", "powerProfile", "scale", "keyboard"}

// toolErr maps backend errors to contract error codes.
func toolErr(what string, err error) error {
	var te *mcp.ToolError
	var ce *settings.CmdError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &te):
		return te
	case errors.Is(err, settings.ErrUnavailable):
		return mcp.Errorf(mcp.CodeNotFound, errText.Unavailable, what)
	case errors.As(err, &ce):
		return mcp.Errorf(mcp.CodeFailed, "%s", ce.Error())
	default:
		return mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
}

func undo(tool string, input any) *Undo { return &Undo{Tool: tool, Input: input} }

type tool struct {
	name, desc, schema string
	call               func(ctx context.Context, raw json.RawMessage) (any, error)
	describe           func(ctx context.Context, raw json.RawMessage) (mcp.Description, error)
}

// Tools returns every settings tool.
func Tools(d Deps) []mcp.Tool {
	ts := []tool{
		{"settings.brightness", "Set the screen brightness in percent (1-100).", `{"type":"object","properties":{"percent":{"type":"integer","minimum":1,"maximum":100}},"required":["percent"],"additionalProperties":false}`, d.brightness, d.describeBrightness},
		{"settings.volume", "Set the sound volume in percent (0-150) and/or mute or unmute it.", `{"type":"object","properties":{"percent":{"type":"integer","minimum":0,"maximum":150},"muted":{"type":"boolean"}},"additionalProperties":false}`, d.volume, d.describeVolume},
		{"settings.night_light", "Turn the warm night light on (optionally until an hour, 0-23) or off.", `{"type":"object","properties":{"on":{"type":"boolean"},"untilHour":{"type":"integer","minimum":0,"maximum":23}},"required":["on"],"additionalProperties":false}`, d.nightLight, d.describeNightLight},
		{"settings.wifi", "Turn Wi-Fi on or off.", onSchema, d.wifi, d.describeWiFi},
		{"settings.bluetooth", "Turn Bluetooth on or off.", onSchema, d.bluetooth, d.describeBluetooth},
		{"settings.bluetooth_pair", "Pair, trust and connect a Bluetooth device by address (AA:BB:CC:DD:EE:FF). The device must be in pairing mode.", addressSchema, d.pair, d.describePair},
		{"settings.bluetooth_unpair", "Forget a paired Bluetooth device by address.", addressSchema, d.unpair, d.describeUnpair},
		{"settings.audio_output", "Choose the default sound output by sinkId (from settings.get audioOutput.available).", `{"type":"object","properties":{"sinkId":{"type":"string","minLength":1,"maxLength":255}},"required":["sinkId"],"additionalProperties":false}`, d.audioOutput, d.describeAudioOutput},
		{"settings.power_profile", "Switch the power mode.", `{"type":"object","properties":{"profile":{"type":"string","enum":["power-saver","balanced","performance"]}},"required":["profile"],"additionalProperties":false}`, d.powerProfile, d.describePowerProfile},
		{"settings.scale", "Set a display's scale (1, 1.25, 1.5, 1.75 or 2); output names come from settings.get scale.", `{"type":"object","properties":{"output":{"type":"string","minLength":1,"maxLength":64},"scale":{"type":"number","enum":[1,1.25,1.5,1.75,2]}},"required":["output","scale"],"additionalProperties":false}`, d.scale, d.describeScale},
		{"settings.keyboard", "Switch the keyboard layout (XKB layout like us, ara, fr; optional variant).", `{"type":"object","properties":{"layout":{"type":"string","minLength":1,"maxLength":32},"variant":{"type":"string","maxLength":64}},"required":["layout"],"additionalProperties":false}`, d.keyboard, d.describeKeyboard},
	}
	out := []mcp.Tool{{
		Name:        "settings.get",
		Description: "Read the current brightness, volume, mute, night light, Wi-Fi, Bluetooth (with known devices), sound outputs, power mode, display scales and keyboard layout. A setting this computer lacks is null.",
		InputSchema: `{"type":"object","properties":{"keys":{"type":"array","items":{"type":"string","enum":["brightness","volume","muted","nightLight","wifi","bluetooth","audioOutput","powerProfile","scale","keyboard"]},"maxItems":10}},"additionalProperties":false}`,
		Risk:        mcp.RiskSafe,
		Call:        d.get,
	}}
	for _, t := range ts {
		out = append(out, mcp.Tool{Name: t.name, Description: t.desc, InputSchema: t.schema, Risk: mcp.RiskConfirm, Call: t.call, Describe: d.transitionDescription(t)})
	}
	return out
}

const (
	onSchema      = `{"type":"object","properties":{"on":{"type":"boolean"}},"required":["on"],"additionalProperties":false}`
	addressSchema = `{"type":"object","properties":{"address":{"type":"string","minLength":17,"maxLength":17}},"required":["address"],"additionalProperties":false}`
)

// AudioOutput is settings.get's audioOutput.
type AudioOutput struct {
	SinkID    string          `json:"sinkId"`
	Name      string          `json:"name"`
	Available []settings.Sink `json:"available"`
}

// Bluetooth is settings.get's bluetooth.
type Bluetooth struct {
	On      bool                `json:"on"`
	Devices []settings.BTDevice `json:"devices"`
}

func (d Deps) get(ctx context.Context, raw json.RawMessage) (any, error) {
	var in struct {
		Keys []string `json:"keys"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	want := map[string]bool{}
	for _, k := range in.Keys {
		ok := false
		for _, known := range Keys {
			ok = ok || k == known
		}
		if !ok {
			return nil, mcp.Errorf(mcp.CodeInvalid, errText.BadKey, k)
		}
		want[k] = true
	}
	all := len(want) == 0
	out := map[string]any{}
	problems := map[string]string{}
	put := func(key string, v any, err error) {
		if !all && !want[key] {
			return
		}
		if err != nil {
			out[key] = nil
			if !errors.Is(err, settings.ErrUnavailable) {
				problems[key] = err.Error()
			}
			return
		}
		out[key] = v
	}
	need := func(keys ...string) bool {
		for _, k := range keys {
			if all || want[k] {
				return true
			}
		}
		return false
	}
	if need("brightness") {
		v, err := d.Sys.Brightness(ctx)
		put("brightness", v, err)
	}
	if need("volume", "muted") {
		v, err := d.Sys.Volume(ctx)
		put("volume", v.Percent, err)
		put("muted", v.Muted, err)
	}
	if need("nightLight") {
		v, err := d.Sess.NightLight(ctx)
		put("nightLight", v, err)
	}
	if need("wifi") {
		v, err := d.Sys.WiFi(ctx)
		put("wifi", v, err)
	}
	if need("bluetooth") {
		on, err := d.BT.Powered(ctx)
		var devs []settings.BTDevice
		if err == nil {
			devs, err = d.BT.Devices(ctx)
		}
		put("bluetooth", Bluetooth{On: on, Devices: devs}, err)
	}
	if need("audioOutput") {
		sinks, def, err := d.Sys.Sinks(ctx)
		a := AudioOutput{SinkID: def, Available: sinks}
		for _, s := range sinks {
			if s.SinkID == def {
				a.Name = s.Name
			}
		}
		put("audioOutput", a, err)
	}
	if need("powerProfile") {
		v, err := d.Sys.PowerProfile(ctx)
		put("powerProfile", v, err)
	}
	if need("scale") {
		v, err := d.Sess.Outputs(ctx)
		put("scale", v, err)
	}
	if need("keyboard") {
		put("keyboard", d.Sess.Keyboard(), nil)
	}
	if len(problems) > 0 {
		out["errors"] = problems
	}
	return out, nil
}

// --- brightness

func decodePercent(raw json.RawMessage) (int, error) {
	var in struct {
		Percent int `json:"percent"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return 0, err
	}
	if in.Percent < 1 || in.Percent > 100 {
		return 0, mcp.Errorf(mcp.CodeInvalid, "percent must be 1 to 100")
	}
	return in.Percent, nil
}

func (d Deps) brightness(ctx context.Context, raw json.RawMessage) (any, error) {
	p, err := decodePercent(raw)
	if err != nil {
		return nil, err
	}
	prev, err := d.Sys.Brightness(ctx)
	if err != nil {
		return nil, toolErr("A screen backlight", err)
	}
	if err := d.Sys.SetBrightness(ctx, p); err != nil {
		return nil, toolErr("A screen backlight", err)
	}
	return Change{Previous: prev, Current: p, Undo: undo("settings.brightness", map[string]int{"percent": max(prev, 1)})}, nil
}

func (d Deps) describeBrightness(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	p, err := decodePercent(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	now := t.Unknown
	if v, err := d.Sys.Brightness(ctx); err == nil {
		now = fmt.Sprintf("%d%%", v)
	}
	return mcp.Description{Title: i18n.Sprintf(l, t.Brightness, p), Detail: i18n.Sprintf(l, t.Now, now), Source: mcp.SourceSystem}, nil
}

// --- volume

type volumeIn struct {
	Percent *int  `json:"percent"`
	Muted   *bool `json:"muted"`
}

func decodeVolume(raw json.RawMessage) (volumeIn, error) {
	var in volumeIn
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return in, err
	}
	if in.Percent == nil && in.Muted == nil {
		return in, mcp.Errorf(mcp.CodeInvalid, "%s", errText.NeedOne)
	}
	if in.Percent != nil && (*in.Percent < 0 || *in.Percent > 150) {
		return in, mcp.Errorf(mcp.CodeInvalid, "percent must be 0 to 150")
	}
	return in, nil
}

func (d Deps) volume(ctx context.Context, raw json.RawMessage) (any, error) {
	in, err := decodeVolume(raw)
	if err != nil {
		return nil, err
	}
	prev, err := d.Sys.Volume(ctx)
	if err != nil {
		return nil, toolErr("Sound", err)
	}
	if err := d.Sys.SetVolume(ctx, in.Percent, in.Muted); err != nil {
		return nil, toolErr("Sound", err)
	}
	cur := prev
	if in.Percent != nil {
		cur.Percent = *in.Percent
	}
	if in.Muted != nil {
		cur.Muted = *in.Muted
	}
	return Change{Previous: prev, Current: cur, Undo: undo("settings.volume", map[string]any{"percent": min(prev.Percent, 150), "muted": prev.Muted})}, nil
}

func (d Deps) describeVolume(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	in, err := decodeVolume(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	var title string
	switch {
	case in.Percent != nil && in.Muted != nil:
		title = i18n.Sprintf(l, t.VolumeMute, *in.Percent, map[bool]string{true: t.MuteWord, false: t.UnmuteWord}[*in.Muted])
	case in.Percent != nil:
		title = i18n.Sprintf(l, t.Volume, *in.Percent)
	case *in.Muted:
		title = t.Mute
	default:
		title = t.Unmute
	}
	now := t.Unknown
	if v, err := d.Sys.Volume(ctx); err == nil {
		now = fmt.Sprintf("%d%%", v.Percent)
		if v.Muted {
			now = fmt.Sprintf(t.VolumeMuted, v.Percent)
		}
	}
	return mcp.Description{Title: title, Detail: i18n.Sprintf(l, t.Now, now), Source: mcp.SourceSystem}, nil
}

// --- night light

type nightIn struct {
	On        *bool `json:"on"`
	UntilHour *int  `json:"untilHour"`
}

func decodeNight(raw json.RawMessage) (nightIn, error) {
	var in nightIn
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return in, err
	}
	if in.On == nil {
		return in, mcp.Errorf(mcp.CodeInvalid, "on is required")
	}
	if in.UntilHour != nil && (*in.UntilHour < 0 || *in.UntilHour > 23) {
		return in, mcp.Errorf(mcp.CodeInvalid, "untilHour must be 0 to 23")
	}
	return in, nil
}

func (d Deps) nightLight(ctx context.Context, raw json.RawMessage) (any, error) {
	in, err := decodeNight(raw)
	if err != nil {
		return nil, err
	}
	prev, err := d.Sess.NightLight(ctx)
	if err != nil {
		return nil, toolErr("Night light", err)
	}
	if err := d.Sess.SetNightLight(ctx, *in.On, in.UntilHour); err != nil {
		return nil, toolErr("Night light", err)
	}
	back := map[string]any{"on": prev.On}
	if prev.UntilHour != nil {
		back["untilHour"] = *prev.UntilHour
	}
	return Change{Previous: prev, Current: settings.NightLight{On: *in.On, UntilHour: in.UntilHour}, Undo: undo("settings.night_light", back)}, nil
}

func (d Deps) describeNightLight(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	in, err := decodeNight(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	title := t.NightOff
	if *in.On && in.UntilHour != nil {
		title = i18n.Sprintf(l, t.NightOnUntil, *in.UntilHour)
	} else if *in.On {
		title = t.NightOn
	}
	return mcp.Description{Title: title, Source: mcp.SourceSystem}, nil
}

// --- Wi-Fi and Bluetooth radios

func decodeOn(raw json.RawMessage) (bool, error) {
	var in struct {
		On *bool `json:"on"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return false, err
	}
	if in.On == nil {
		return false, mcp.Errorf(mcp.CodeInvalid, "on is required")
	}
	return *in.On, nil
}

func (d Deps) radio(ctx context.Context, raw json.RawMessage, what, tool string, get func(context.Context) (bool, error), set func(context.Context, bool) error) (any, error) {
	on, err := decodeOn(raw)
	if err != nil {
		return nil, err
	}
	prev, err := get(ctx)
	if err != nil {
		return nil, toolErr(what, err)
	}
	if err := set(ctx, on); err != nil {
		return nil, toolErr(what, err)
	}
	return Change{Previous: prev, Current: on, Undo: undo(tool, map[string]bool{"on": prev})}, nil
}

func (d Deps) wifi(ctx context.Context, raw json.RawMessage) (any, error) {
	return d.radio(ctx, raw, "Wi-Fi", "settings.wifi", d.Sys.WiFi, d.Sys.SetWiFi)
}

func (d Deps) bluetooth(ctx context.Context, raw json.RawMessage) (any, error) {
	return d.radio(ctx, raw, "Bluetooth", "settings.bluetooth", d.BT.Powered, d.BT.SetPowered)
}

func describeRadio(raw json.RawMessage, on, off string) (mcp.Description, error) {
	v, err := decodeOn(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	t := off
	if v {
		t = on
	}
	return mcp.Description{Title: t, Source: mcp.SourceSystem}, nil
}

func (d Deps) describeWiFi(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	t := cardText.In(ctx)
	return describeRadio(raw, t.WiFiOn, t.WiFiOff)
}

func (d Deps) describeBluetooth(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	t := cardText.In(ctx)
	return describeRadio(raw, t.BTOn, t.BTOff)
}

// --- Bluetooth pairing

func decodeAddress(raw json.RawMessage) (string, error) {
	var in struct {
		Address string `json:"address"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return "", err
	}
	a, err := settings.NormalizeAddress(in.Address)
	if err != nil {
		return "", mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
	return a, nil
}

func (d Deps) paired(ctx context.Context, address string) (bool, string) {
	devs, _ := d.BT.Devices(ctx)
	for _, dev := range devs {
		if dev.Address == address {
			return dev.Paired, dev.Name
		}
	}
	return false, address
}

func (d Deps) pair(ctx context.Context, raw json.RawMessage) (any, error) {
	a, err := decodeAddress(raw)
	if err != nil {
		return nil, err
	}
	was, _ := d.paired(ctx, a)
	if err := d.BT.Pair(ctx, a); err != nil {
		return nil, toolErr("A Bluetooth device with address "+a, err)
	}
	back := "settings.bluetooth_unpair"
	if was {
		back = "settings.bluetooth_pair"
	}
	return Change{Previous: map[string]bool{"paired": was}, Current: map[string]bool{"paired": true}, Undo: undo(back, map[string]string{"address": a})}, nil
}

func (d Deps) unpair(ctx context.Context, raw json.RawMessage) (any, error) {
	a, err := decodeAddress(raw)
	if err != nil {
		return nil, err
	}
	was, _ := d.paired(ctx, a)
	if err := d.BT.Remove(ctx, a); err != nil {
		return nil, toolErr("A Bluetooth device with address "+a, err)
	}
	return Change{Previous: map[string]bool{"paired": was}, Current: map[string]bool{"paired": false}, Undo: undo("settings.bluetooth_pair", map[string]string{"address": a})}, nil
}

func (d Deps) describePair(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	a, err := decodeAddress(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	_, name := d.paired(ctx, a)
	return mcp.Description{Title: i18n.Sprintf(l, t.Pair, name), Detail: i18n.Iso(l, a) + " · " + t.PairDetail, Source: mcp.SourceSystem}, nil
}

func (d Deps) describeUnpair(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	a, err := decodeAddress(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	_, name := d.paired(ctx, a)
	return mcp.Description{Title: i18n.Sprintf(l, t.Unpair, name), Detail: i18n.Iso(l, a) + " · " + t.UnpairDetail, Source: mcp.SourceSystem}, nil
}

// --- audio output

func decodeSink(raw json.RawMessage) (string, error) {
	var in struct {
		SinkID string `json:"sinkId"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return "", err
	}
	if in.SinkID == "" || len(in.SinkID) > 255 || strings.ContainsAny(in.SinkID, " \n\t") {
		return "", mcp.Errorf(mcp.CodeInvalid, "sinkId must be one of settings.get audioOutput.available")
	}
	return in.SinkID, nil
}

func (d Deps) sinkName(ctx context.Context, id string) (string, string) {
	sinks, def, _ := d.Sys.Sinks(ctx)
	name := id
	for _, s := range sinks {
		if s.SinkID == id {
			name = s.Name
		}
	}
	return name, def
}

func (d Deps) audioOutput(ctx context.Context, raw json.RawMessage) (any, error) {
	id, err := decodeSink(raw)
	if err != nil {
		return nil, err
	}
	_, prev := d.sinkName(ctx, id)
	if err := d.Sys.SetDefaultSink(ctx, id); err != nil {
		return nil, toolErr("A sound output "+id, err)
	}
	var u *Undo
	var previous any
	if prev != "" {
		previous = prev
		if prev != id {
			u = undo("settings.audio_output", map[string]string{"sinkId": prev})
		}
	}
	return Change{Previous: previous, Current: id, Undo: u}, nil
}

func (d Deps) describeAudioOutput(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	id, err := decodeSink(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	name, _ := d.sinkName(ctx, id)
	return mcp.Description{Title: i18n.Sprintf(l, t.AudioOut, name), Detail: i18n.Iso(l, id), Source: mcp.SourceSystem}, nil
}

// --- power profile

func decodeProfile(raw json.RawMessage) (string, error) {
	var in struct {
		Profile string `json:"profile"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return "", err
	}
	for _, p := range settings.PowerProfiles {
		if p == in.Profile {
			return p, nil
		}
	}
	return "", mcp.Errorf(mcp.CodeInvalid, "profile must be power-saver, balanced or performance")
}

func (d Deps) powerProfile(ctx context.Context, raw json.RawMessage) (any, error) {
	p, err := decodeProfile(raw)
	if err != nil {
		return nil, err
	}
	prev, err := d.Sys.PowerProfile(ctx)
	if err != nil {
		return nil, toolErr("Power modes", err)
	}
	if err := d.Sys.SetPowerProfile(ctx, p); err != nil {
		return nil, toolErr("Power modes", err)
	}
	return Change{Previous: prev, Current: p, Undo: undo("settings.power_profile", map[string]string{"profile": prev})}, nil
}

func (d Deps) describePowerProfile(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	p, err := decodeProfile(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	now, err := d.Sys.PowerProfile(ctx)
	if err != nil {
		now = ""
	}
	name := func(id string) string {
		if id == "" {
			return t.Unknown
		}
		if n := t.Profiles[id]; n != "" {
			return n
		}
		return id
	}
	return mcp.Description{Title: i18n.Sprintf(l, t.Power, name(p)), Detail: i18n.Sprintf(l, t.Now, name(now)), Source: mcp.SourceSystem}, nil
}

// --- display scale

type scaleIn struct {
	Output string  `json:"output"`
	Scale  float64 `json:"scale"`
}

func decodeScale(raw json.RawMessage) (scaleIn, error) {
	var in scaleIn
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return in, err
	}
	for _, s := range settings.Scales {
		if s == in.Scale && in.Output != "" {
			return in, nil
		}
	}
	return in, mcp.Errorf(mcp.CodeInvalid, "scale must be 1, 1.25, 1.5, 1.75 or 2 on a named output")
}

func (d Deps) scale(ctx context.Context, raw json.RawMessage) (any, error) {
	in, err := decodeScale(raw)
	if err != nil {
		return nil, err
	}
	outs, err := d.Sess.Outputs(ctx)
	if err != nil {
		return nil, toolErr("Display settings", err)
	}
	prev := 0.0
	for _, o := range outs {
		if o.Name == in.Output {
			prev = o.Scale
		}
	}
	if prev == 0 {
		return nil, mcp.Errorf(mcp.CodeNotFound, "no display is called %q", in.Output)
	}
	if err := d.Sess.SetScale(ctx, in.Output, in.Scale); err != nil {
		return nil, toolErr("Display "+in.Output, err)
	}
	var u *Undo
	for _, s := range settings.Scales {
		if s == prev && prev != in.Scale {
			u = undo("settings.scale", map[string]any{"output": in.Output, "scale": prev})
		}
	}
	return Change{Previous: prev, Current: in.Scale, Undo: u}, nil
}

func (d Deps) describeScale(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	in, err := decodeScale(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	return mcp.Description{Title: i18n.Sprintf(l, t.Scale, in.Output, in.Scale), Source: mcp.SourceSystem}, nil
}

// --- keyboard

func decodeKeyboard(raw json.RawMessage) (settings.Keyboard, error) {
	var in settings.Keyboard
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return in, err
	}
	return in, nil
}

func (d Deps) keyboard(ctx context.Context, raw json.RawMessage) (any, error) {
	kb, err := decodeKeyboard(raw)
	if err != nil {
		return nil, err
	}
	if err := d.Sess.CheckKeyboard(kb); err != nil {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%v", err)
	}
	prev := d.Sess.Keyboard()
	live, err := d.Sess.SetKeyboard(kb)
	if err != nil {
		return nil, toolErr("Keyboard layouts", err)
	}
	back := map[string]string{"layout": prev.Layout}
	if prev.Variant != "" {
		back["variant"] = prev.Variant
	}
	return map[string]any{"previous": prev, "current": kb, "live": live, "undo": undo("settings.keyboard", back)}, nil
}

func (d Deps) describeKeyboard(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	kb, err := decodeKeyboard(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	title := i18n.Sprintf(l, t.Keyboard, kb.Layout)
	if kb.Variant != "" {
		title = i18n.Sprintf(l, t.KeyboardVariant, kb.Layout, kb.Variant)
	}
	prev := d.Sess.Keyboard()
	return mcp.Description{Title: title, Detail: i18n.Sprintf(l, t.Now, prev.Layout), Source: mcp.SourceSystem}, nil
}

// transitionDescription keeps confirmation cards pure and uses the §5.4 detail.
func (d Deps) transitionDescription(tl tool) func(context.Context, json.RawMessage) (mcp.Description, error) {
	return func(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
		desc, err := tl.describe(ctx, raw)
		if err != nil {
			return desc, err
		}
		l := i18n.FromContext(ctx)
		t := cardText.Get(l)
		previous, current := t.Unknown, t.Unknown
		on := func(v bool) string {
			if v {
				return t.On
			}
			return t.Off
		}
		night := func(v settings.NightLight) string {
			if !v.On {
				return t.Off
			}
			if v.UntilHour != nil {
				return fmt.Sprintf(t.OnUntil, *v.UntilHour)
			}
			return t.On
		}
		keyboard := func(v settings.Keyboard) string {
			if v.Variant != "" {
				return v.Layout + " (" + v.Variant + ")"
			}
			return v.Layout
		}
		volume := func(v settings.Volume) string {
			if v.Muted {
				return fmt.Sprintf(t.VolumeMuted, v.Percent)
			}
			return fmt.Sprintf("%d%%", v.Percent)
		}
		switch tl.name {
		case "settings.brightness":
			p, _ := decodePercent(raw)
			current = fmt.Sprintf("%d%%", p)
			if v, e := d.Sys.Brightness(ctx); e == nil {
				previous = fmt.Sprintf("%d%%", v)
			}
		case "settings.volume":
			in, _ := decodeVolume(raw)
			if v, e := d.Sys.Volume(ctx); e == nil {
				previous = volume(v)
				if in.Percent != nil {
					v.Percent = *in.Percent
				}
				if in.Muted != nil {
					v.Muted = *in.Muted
				}
				current = volume(v)
			}
		case "settings.night_light":
			in, _ := decodeNight(raw)
			current = night(settings.NightLight{On: *in.On, UntilHour: in.UntilHour})
			if v, e := d.Sess.NightLight(ctx); e == nil {
				previous = night(v)
			}
		case "settings.wifi", "settings.bluetooth":
			v, _ := decodeOn(raw)
			current = on(v)
			var old bool
			var e error
			if tl.name == "settings.wifi" {
				old, e = d.Sys.WiFi(ctx)
			} else {
				old, e = d.BT.Powered(ctx)
			}
			if e == nil {
				previous = on(old)
			}
		case "settings.bluetooth_pair", "settings.bluetooth_unpair":
			a, _ := decodeAddress(raw)
			was, _ := d.paired(ctx, a)
			yesno := func(v bool) string {
				if v {
					return t.Yes
				}
				return t.No
			}
			previous = yesno(was)
			current = yesno(tl.name == "settings.bluetooth_pair")
		case "settings.audio_output":
			id, _ := decodeSink(raw)
			current, previous = d.sinkName(ctx, id)
			if previous == "" {
				previous = t.Unknown
			}
		case "settings.power_profile":
			current, _ = decodeProfile(raw)
			name := func(id string) string {
				if n := t.Profiles[id]; n != "" {
					return n
				}
				return id
			}
			current = name(current)
			if v, e := d.Sys.PowerProfile(ctx); e == nil {
				previous = name(v)
			}
		case "settings.scale":
			in, _ := decodeScale(raw)
			current = fmt.Sprintf("%g", in.Scale)
			if outs, e := d.Sess.Outputs(ctx); e == nil {
				for _, o := range outs {
					if o.Name == in.Output {
						previous = fmt.Sprintf("%g", o.Scale)
					}
				}
			}
		case "settings.keyboard":
			kb, _ := decodeKeyboard(raw)
			if e := d.Sess.CheckKeyboard(kb); e != nil {
				return mcp.Description{}, mcp.Errorf(mcp.CodeInvalid, "%v", e)
			}
			previous, current = keyboard(d.Sess.Keyboard()), keyboard(kb)
		}
		desc.Detail = i18n.Sprintf(l, t.Transition, previous, current)
		return desc, nil
	}
}
