package settings

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
)

// Session is the labwc desktop session: displays, keyboard, night light.
type Session struct {
	Run            execx.Runner
	Display        func() (string, error) // WAYLAND_DISPLAY name, e.g. "wayland-0"
	Home           string
	StateDir       string // retained for callers; session persistence uses Home (§5.17)
	XKBRules       string // /usr/share/X11/xkb/rules/evdev.lst
	SystemKeyboard string // /etc/default/keyboard
	Proc           string // /proc
	UID            int
	Kill           func(pid int, sig syscall.Signal) error
	Now            func() time.Time
}

func (s *Session) now() time.Time {
	if s.Now == nil {
		return time.Now()
	}
	return s.Now()
}

// wayland runs a Wayland client tool with WAYLAND_DISPLAY set (through
// /usr/bin/env, so the child environment stays execx's fixed one).
func (s *Session) wayland(ctx context.Context, name string, args ...string) (string, error) {
	if s.Display == nil {
		return "", ErrUnavailable
	}
	disp, err := s.Display()
	if err != nil || strings.TrimSpace(disp) == "" {
		return "", ErrUnavailable
	}
	sys := &System{Run: s.Run}
	return sys.out(ctx, "env", append([]string{"WAYLAND_DISPLAY=" + disp, name}, args...)...)
}

// Output is one display.
type Output struct {
	Name    string  `json:"output"`
	Enabled bool    `json:"enabled"`
	Scale   float64 `json:"scale"`
}

// ParseWlrRandr reads wlr-randr's text output.
func ParseWlrRandr(out string) []Output {
	var outs []Output
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		if line[0] != ' ' && line[0] != '\t' {
			name, _, _ := strings.Cut(line, " ")
			outs = append(outs, Output{Name: name})
			continue
		}
		if len(outs) == 0 {
			continue
		}
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch k {
		case "Enabled":
			outs[len(outs)-1].Enabled = v == "yes"
		case "Scale":
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				outs[len(outs)-1].Scale = math.Round(f*100) / 100
			}
		}
	}
	return outs
}

// Scales are the display scales jarvis-settings offers (contracts §1).
var Scales = []float64{1, 1.25, 1.5, 1.75, 2}

var outputRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// Outputs lists the displays.
func (s *Session) Outputs(ctx context.Context) ([]Output, error) {
	out, err := s.wayland(ctx, "wlr-randr")
	if err != nil {
		return nil, err
	}
	return ParseWlrRandr(out), nil
}

// sessionFile is the login persistence contract (M3 §5.17).
func (s *Session) sessionFile() string {
	return filepath.Join(s.Home, ".config", "jarvis", "session.json")
}

func (s *Session) savedSession() (map[string]json.RawMessage, error) {
	m := map[string]json.RawMessage{}
	data, err := os.ReadFile(s.sessionFile())
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	if m == nil {
		m = map[string]json.RawMessage{}
	}
	return m, nil
}

func (s *Session) saveField(key string, value any) error {
	m, err := s.savedSession()
	if err != nil {
		return err
	}
	if value == nil {
		delete(m, key)
	} else {
		data, err := json.Marshal(value)
		if err != nil {
			return err
		}
		m[key] = data
	}
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return writeAtomic(s.sessionFile(), data, 0600)
}

func (s *Session) savedScales() (map[string]float64, error) {
	m, err := s.savedSession()
	if err != nil {
		return nil, err
	}
	scales := map[string]float64{}
	if data, ok := m["scales"]; ok {
		if err := json.Unmarshal(data, &scales); err != nil {
			return nil, err
		}
	}
	if scales == nil {
		scales = map[string]float64{}
	}
	return scales, nil
}

func validScale(scale float64) bool {
	switch scale {
	case 1, 1.25, 1.5, 1.75, 2:
		return true
	}
	return false
}

// SetScale changes one display's scale and remembers it for the next
// login (RestoreScales).
func (s *Session) SetScale(ctx context.Context, output string, scale float64) error {
	ok := false
	for _, k := range Scales {
		ok = ok || k == scale
	}
	if !ok || !outputRe.MatchString(output) {
		return fmt.Errorf("scale must be one of 1, 1.25, 1.5, 1.75, 2 on a named output")
	}
	outs, err := s.Outputs(ctx)
	if err != nil {
		return err
	}
	found := false
	for _, o := range outs {
		found = found || o.Name == output
	}
	if !found {
		return ErrUnavailable
	}
	if _, err := s.wayland(ctx, "wlr-randr", "--output", output, "--scale", strconv.FormatFloat(scale, 'f', -1, 64)); err != nil {
		return err
	}
	saved, err := s.savedScales()
	if err != nil {
		return err
	}
	saved[output] = scale
	return s.saveField("scales", saved)
}

// RestoreScales restores scales on present, enabled outputs and night light
// at login, as required by M3 §5.17 (jarvis-settings restore).
func (s *Session) RestoreScales(ctx context.Context) error {
	saved, err := s.savedScales()
	if err != nil {
		return err
	}
	if len(saved) == 0 {
		return s.restoreNightLight(ctx)
	}
	outs, err := s.Outputs(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, o := range outs {
		if sc, ok := saved[o.Name]; ok && o.Enabled && sc != o.Scale && validScale(sc) && outputRe.MatchString(o.Name) {
			if _, err := s.wayland(ctx, "wlr-randr", "--output", o.Name, "--scale", strconv.FormatFloat(sc, 'f', -1, 64)); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(append(errs, s.restoreNightLight(ctx))...)
}

func writeAtomic(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp.Name())
		return errors.Join(werr, cerr)
	}
	if err := os.Chmod(tmp.Name(), perm); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	defer os.Remove(tmp.Name())
	return os.Rename(tmp.Name(), path)
}

// Keyboard is an XKB layout and optional variant.
type Keyboard struct {
	Layout  string `json:"layout"`
	Variant string `json:"variant"`
}

// XKB is the set of layouts and their variants from evdev.lst.
type XKB struct {
	Layouts  map[string]string            // layout → description
	Variants map[string]map[string]string // layout → variant → description
}

// ParseEvdevList reads /usr/share/X11/xkb/rules/evdev.lst.
func ParseEvdevList(data string) XKB {
	x := XKB{Layouts: map[string]string{}, Variants: map[string]map[string]string{}}
	section := ""
	sc := bufio.NewScanner(strings.NewReader(data))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "!") {
			section = strings.TrimSpace(strings.TrimPrefix(line, "!"))
			continue
		}
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		desc := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), f[0]))
		switch section {
		case "layout":
			x.Layouts[f[0]] = desc
		case "variant":
			layout, d, ok := strings.Cut(desc, ":")
			if !ok {
				continue
			}
			if x.Variants[layout] == nil {
				x.Variants[layout] = map[string]string{}
			}
			x.Variants[layout][f[0]] = strings.TrimSpace(d)
		}
	}
	return x
}

func (s *Session) xkb() (XKB, error) {
	b, err := os.ReadFile(s.XKBRules)
	if err != nil {
		return XKB{}, fmt.Errorf("keyboard layouts: %v", err)
	}
	return ParseEvdevList(string(b)), nil
}

// CheckKeyboard validates a layout/variant against evdev.lst.
func (s *Session) CheckKeyboard(kb Keyboard) error {
	x, err := s.xkb()
	if err != nil {
		return err
	}
	if _, ok := x.Layouts[kb.Layout]; !ok {
		return fmt.Errorf("%q is not a keyboard layout (e.g. us, ara, fr)", kb.Layout)
	}
	if kb.Variant != "" {
		if _, ok := x.Variants[kb.Layout][kb.Variant]; !ok {
			return fmt.Errorf("%q is not a variant of layout %q", kb.Variant, kb.Layout)
		}
	}
	return nil
}

func (s *Session) labwcEnv() string { return filepath.Join(s.Home, ".config", "labwc", "environment") }

// readVars reads KEY=value lines (values may be double-quoted).
func readVars(path string) map[string]string {
	m := map[string]string{}
	b, err := os.ReadFile(path)
	if err != nil {
		return m
	}
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok && !strings.HasPrefix(k, "#") {
			m[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	return m
}

// Keyboard reads the layout labwc uses: the user's labwc environment
// file, else /etc/default/keyboard (M2 contracts §11.5), else "us".
func (s *Session) Keyboard() Keyboard {
	if v := readVars(s.labwcEnv()); v["XKB_DEFAULT_LAYOUT"] != "" {
		return Keyboard{Layout: v["XKB_DEFAULT_LAYOUT"], Variant: v["XKB_DEFAULT_VARIANT"]}
	}
	if v := readVars(s.SystemKeyboard); v["XKBLAYOUT"] != "" {
		return Keyboard{Layout: v["XKBLAYOUT"], Variant: v["XKBVARIANT"]}
	}
	return Keyboard{Layout: "us"}
}

// SetKeyboard writes the layout into ~/.config/labwc/environment (keeping
// every other line) and asks the running labwc to reconfigure. live is
// false when no labwc of this user runs (it applies at next login).
func (s *Session) SetKeyboard(kb Keyboard) (live bool, err error) {
	if err := s.CheckKeyboard(kb); err != nil {
		return false, err
	}
	var kept []string
	if b, err := os.ReadFile(s.labwcEnv()); err == nil {
		for _, line := range strings.Split(strings.TrimSuffix(string(b), "\n"), "\n") {
			k, _, _ := strings.Cut(strings.TrimSpace(line), "=")
			if k == "XKB_DEFAULT_LAYOUT" || k == "XKB_DEFAULT_VARIANT" {
				continue
			}
			kept = append(kept, line)
		}
	}
	kept = append(kept, "XKB_DEFAULT_LAYOUT="+kb.Layout)
	if kb.Variant != "" {
		kept = append(kept, "XKB_DEFAULT_VARIANT="+kb.Variant)
	}
	if err := os.MkdirAll(filepath.Dir(s.labwcEnv()), 0o755); err != nil {
		return false, err
	}
	if err := writeAtomic(s.labwcEnv(), []byte(strings.Join(kept, "\n")+"\n"), 0o644); err != nil {
		return false, err
	}
	return s.reloadLabwc() == nil, nil
}

// reloadLabwc sends SIGHUP (labwc: reconfigure) to this user's labwc.
func (s *Session) reloadLabwc() error {
	ents, err := os.ReadDir(s.Proc)
	if err != nil {
		return err
	}
	var pids []int
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		comm, err := os.ReadFile(filepath.Join(s.Proc, e.Name(), "comm"))
		if err != nil || strings.TrimSpace(string(comm)) != "labwc" {
			continue
		}
		if procUID(filepath.Join(s.Proc, e.Name(), "status")) != s.UID {
			continue
		}
		pids = append(pids, pid)
	}
	if len(pids) == 0 {
		return errors.New("labwc is not running")
	}
	sort.Ints(pids)
	kill := s.Kill
	if kill == nil {
		kill = syscall.Kill
	}
	return kill(pids[0], syscall.SIGHUP)
}

// procUID reads the real uid from /proc/<pid>/status (-1 when unknown).
func procUID(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return -1
	}
	for _, line := range strings.Split(string(b), "\n") {
		if rest, ok := strings.CutPrefix(line, "Uid:"); ok {
			f := strings.Fields(rest)
			if len(f) > 0 {
				if uid, err := strconv.Atoi(f[0]); err == nil {
					return uid
				}
			}
		}
	}
	return -1
}

// NightLight is the night light's state.
type NightLight struct {
	On        bool `json:"on"`
	UntilHour *int `json:"untilHour"`
}

type savedNightLight struct {
	NightLight
	EndTime string `json:"endTime,omitempty"`
}

const nightUnit = "jarvis-night-light.service"

func (s *Session) restoreNightLight(ctx context.Context) error {
	m, err := s.savedSession()
	if err != nil {
		return err
	}
	if data, ok := m["nightLight"]; ok {
		var n savedNightLight
		if err := json.Unmarshal(data, &n); err != nil {
			return err
		}
		if n.On {
			if n.UntilHour == nil {
				return s.SetNightLight(ctx, true, nil)
			}
			// Legacy timed settings have no reliable deadline; do not extend them.
			if n.EndTime == "" {
				return s.saveField("nightLight", nil)
			}
			end, err := time.Parse(time.RFC3339, n.EndTime)
			if err != nil {
				return err
			}
			if !end.After(s.now()) {
				return s.saveField("nightLight", nil)
			}
			return s.setNightLight(ctx, true, n.UntilHour, &end)
		}
	}
	return nil
}

// NightLight reads whether the night-light unit runs.
func (s *Session) NightLight(ctx context.Context) (NightLight, error) {
	res, err := s.Run.Run(ctx, execx.Cmd{Name: "systemctl", Args: []string{"--user", "is-active", nightUnit}, Timeout: cmdTimeout})
	if err != nil {
		return NightLight{}, err
	}
	if res.ExitCode != 0 && res.ExitCode != 3 && res.ExitCode != 4 {
		return NightLight{}, &CmdError{Tool: "systemctl", Message: strings.TrimSpace(string(res.Stderr))}
	}
	n := NightLight{On: strings.TrimSpace(string(res.Stdout)) == "active"}
	if n.On {
		var st struct {
			UntilHour *int `json:"untilHour"`
		}
		if m, err := s.savedSession(); err == nil && json.Unmarshal(m["nightLight"], &st) == nil {
			n.UntilHour = st.UntilHour
		}
	}
	return n, nil
}

// SetNightLight turns the warm screen on (optionally until untilHour:00
// local time, via RuntimeMaxSec) or off. wlsunset with -t 3500 -T 3501
// keeps the screen at ~3500 K whatever the time of day.
func (s *Session) SetNightLight(ctx context.Context, on bool, untilHour *int) error {
	return s.setNightLight(ctx, on, untilHour, nil)
}

func (s *Session) setNightLight(ctx context.Context, on bool, untilHour *int, end *time.Time) error {
	if untilHour != nil && (*untilHour < 0 || *untilHour > 23) {
		return fmt.Errorf("untilHour must be 0 to 23")
	}
	stop, err := s.Run.Run(ctx, execx.Cmd{Name: "systemctl", Args: []string{"--user", "stop", nightUnit}, Timeout: cmdTimeout})
	if err != nil {
		return err
	}
	if stop.ExitCode != 0 && stop.ExitCode != 5 { // 5: unit not loaded
		return &CmdError{Tool: "systemctl", Message: strings.TrimSpace(string(stop.Stderr))}
	}
	if !on {
		return s.saveField("nightLight", nil)
	}
	if s.Display == nil {
		return ErrUnavailable
	}
	disp, err := s.Display()
	if err != nil || strings.TrimSpace(disp) == "" {
		return ErrUnavailable
	}
	args := []string{"--user", "--quiet", "--collect", "--unit=" + nightUnit, "--setenv=WAYLAND_DISPLAY=" + disp}
	if untilHour != nil {
		now := s.now()
		if end == nil {
			deadline := time.Date(now.Year(), now.Month(), now.Day(), *untilHour, 0, 0, 0, now.Location())
			if !deadline.After(now) {
				deadline = deadline.AddDate(0, 0, 1)
			}
			end = &deadline
		}
		if !end.After(now) {
			return s.saveField("nightLight", nil)
		}
		args = append(args, fmt.Sprintf("--property=RuntimeMaxSec=%d", int(end.Sub(now).Seconds())))
	}
	args = append(args, "--", "/usr/bin/wlsunset", "-t", "3500", "-T", "3501", "-S", "06:00", "-s", "18:00")
	sys := &System{Run: s.Run}
	if _, err := sys.out(ctx, "systemd-run", args...); err != nil {
		return err
	}
	saved := savedNightLight{NightLight: NightLight{On: true, UntilHour: untilHour}}
	if end != nil {
		saved.EndTime = end.UTC().Format(time.RFC3339)
	}
	return s.saveField("nightLight", saved)
}
