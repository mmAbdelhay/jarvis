// Package session is jarvis-cu's state machine (Rafiq v1.1 contracts §1,
// design §2.3, §2.4, §2.6, §2.9): one session at a time, scoped to the apps
// the user allowed; every capture is blanked unless only allowed windows
// can be on screen; every input op passes the gate in input.go first.
//
// Ruling U-1: labwc gives no window geometry, so the session keeps one
// allowed window (the base) fullscreen and maps capture space onto it.
//
// Dialogs (final review, finding 1): the base follows keyboard focus. When
// another window of an allowed app (an Export dialog, say) takes focus, the
// next capture raises it and makes it fullscreen, so the frame shows the
// window that receives input. Input is refused while the focused window is
// not the base, and while the base differs from the one the last capture
// showed: the model never acts on a window it has not seen.
package session

import (
	"context"
	"encoding/base64"
	"errors"
	"image"
	"slices"
	"sync"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/img"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/policy"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/wlcu"
)

// Desktop is what the session needs from the compositor.
type Desktop interface {
	Toplevels() ([]wlcu.Toplevel, error)
	// Current is the window list as last reported, without a round trip:
	// the only read allowed from FocusChanged (the Wayland read goroutine).
	Current() []wlcu.Toplevel
	Outputs() ([]wlcu.Output, error)
	Activate(id string) error
	SetFullscreen(id string, on bool) error
	Capture(output string) (img.Frame, error)
	Pointer(output string) (Pointer, error)
	Keyboard() (Keyboard, error)
}

// Pointer is a virtual pointer on one output.
type Pointer interface {
	MoveTo(x, y, w, h int) error
	Button(b wlcu.Button, pressed bool) error
	Scroll(dx, dy int) error
}

// Keyboard is the virtual keyboard.
type Keyboard interface {
	Type(syms []string) error
	Combo(mask uint32, keysym string) error
}

// Activity is the physical-input detector (activity.Detector).
type Activity interface {
	Arm(max time.Duration) error
	Begin() error
	End()
}

// Deps are the session's collaborators.
type Deps struct {
	Desktop  Desktop
	Apps     func() *policy.AppIndex // re-read at every begin
	Locked   func() bool
	Password func(ctx context.Context) (bool, error) // nil: password fields cannot be checked
	Activity Activity
	// DescribeAt names the accessible at a point of the window titled
	// title (window-relative logical pixels); nil answers "unknown".
	DescribeAt func(ctx context.Context, title string, x, y int) (role, name string)
	// DescribeFocused names the accessible with keyboard focus when it
	// belongs to the window titled title; nil answers "unknown".
	DescribeFocused func(ctx context.Context, title string) (role, name string)
	// FrameSize measures the window titled title (logical pixels, from
	// AT-SPI); ok=false when it cannot. A fullscreen window that does not
	// resize leaves what is behind it on screen, so captures keep only its
	// own area. nil: never known.
	FrameSize func(ctx context.Context, title string) (w, h int, ok bool)
	Push      func(proto.Event)
	Sleep     func(time.Duration)
	After     func(time.Duration, func())
}

// Limits (plan U Global Constraints).
const (
	MaxInputOps     = 200
	DefaultMaxEdge  = 1280
	MinMaxEdge      = 320
	MaxMaxEdge      = 1920
	armTimeout      = time.Second
	fullscreenPolls = 20
	fullscreenPoll  = 50 * time.Millisecond
	focusDebounce   = 250 * time.Millisecond
	frameTimeout    = 500 * time.Millisecond
)

type shot struct {
	output                 string
	outW, outH, capW, capH int
	scale                  int    // wl_output.scale of the output (>= 1)
	blanked                bool   // the frame was blanked: pointer input must not target it
	baseID                 string // the base this frame showed
	// keep is the base's own area in output pixels when it does not fill
	// the output (everything else was masked); empty = the whole output.
	keep image.Rectangle
	// unseen: the base moved to a window that could not be measured, so the
	// frame was blanked and no input may reach it.
	unseen bool
}

type state struct {
	apps         []string
	index        *policy.AppIndex
	baseID       string
	firstBase    string // the base chosen at begin (trusted to fill the screen when unmeasurable)
	fullscreened map[string]bool
	ops          int
	shot         *shot
}

type view struct {
	tops    []wlcu.Toplevel
	focused *wlcu.Toplevel
	base    *wlcu.Toplevel
}

// Manager owns the (single) session.
type Manager struct {
	d    Deps
	opMu sync.Mutex // serialises ops; guards s
	s    *state

	smu    sync.Mutex // guards active/id/paused (Pause never takes opMu)
	active bool
	id     string
	paused string

	// Focus watch, mirrored from s so FocusChanged can run without opMu.
	// tainted: a window that is not allowed took focus after the base was
	// last focused, so it may sit above the base in the stack.
	wIdx    *policy.AppIndex
	wApps   []string
	wBase   string
	tainted bool
}

// New makes a Manager.
func New(d Deps) *Manager {
	if d.Sleep == nil {
		d.Sleep = time.Sleep
	}
	if d.After == nil {
		d.After = func(t time.Duration, f func()) { time.AfterFunc(t, f) }
	}
	if d.Push == nil {
		d.Push = func(proto.Event) {}
	}
	return &Manager{d: d}
}

func (m *Manager) gateSession() error {
	m.smu.Lock()
	defer m.smu.Unlock()
	if !m.active || m.s == nil {
		return proto.Errorf(proto.CodeNoSession, "no computer-use session; begin one first")
	}
	if m.paused != "" {
		return proto.Errorf(proto.CodePaused, "paused (%s); the user has to resume", m.paused)
	}
	return nil
}

// Pause stops the session until a resuming begin; the event is pushed once.
func (m *Manager) Pause(reason string) {
	m.smu.Lock()
	if !m.active || m.paused != "" {
		m.smu.Unlock()
		return
	}
	m.paused = reason
	m.smu.Unlock()
	m.d.Push(proto.Event{Event: "paused", Reason: reason})
}

// LockedNow: the screen locked. Pause with "locked" and end the session.
func (m *Manager) LockedNow() {
	m.smu.Lock()
	active, already := m.active, m.paused == proto.ReasonLocked
	if active && !already {
		m.paused = proto.ReasonLocked
	}
	m.smu.Unlock()
	if !active || already {
		return
	}
	m.d.Push(proto.Event{Event: "paused", Reason: proto.ReasonLocked})
	go m.End()
}

// FocusChanged is called when any window changes; after a short debounce
// it pauses if keyboard focus sits on an excluded surface.
func (m *Manager) FocusChanged() {
	m.smu.Lock()
	running := m.active && m.paused == ""
	m.smu.Unlock()
	if running {
		// Record a stacking change at once: the debounce below is longer
		// than a quick focus hop (w3, then an allowed dialog). This runs on
		// the Wayland read goroutine: never a round trip here.
		m.noteFocus(m.d.Desktop.Current())
		m.d.After(focusDebounce, m.checkFocus)
	}
}

func (m *Manager) checkFocus() {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if m.gateSession() != nil {
		return
	}
	v, err := m.snapshot()
	if err != nil {
		return
	}
	if v.focused == nil {
		m.Pause(proto.ReasonExcludedFocus)
		return
	}
	if ex, _ := m.s.index.Excluded(v.focused.AppID); ex {
		m.Pause(proto.ReasonExcludedFocus)
	}
}

func (m *Manager) allowed(t wlcu.Toplevel) bool {
	if ex, _ := m.s.index.Excluded(t.AppID); ex {
		return false
	}
	return m.s.index.Matches(t.AppID, m.s.apps)
}

// noteFocus keeps the tainted flag: set when a window that is not allowed
// (or excluded) holds focus, cleared once the base itself is focused again.
func (m *Manager) noteFocus(tops []wlcu.Toplevel) {
	m.smu.Lock()
	defer m.smu.Unlock()
	if m.wIdx == nil || m.wBase == "" {
		return
	}
	for _, t := range tops {
		if !t.Focused {
			continue
		}
		if t.ID == m.wBase {
			m.tainted = false
			return
		}
		if ex, _ := m.wIdx.Excluded(t.AppID); ex || !m.wIdx.Matches(t.AppID, m.wApps) {
			m.tainted = true
		}
		return
	}
}

func (m *Manager) isTainted() bool {
	m.smu.Lock()
	defer m.smu.Unlock()
	return m.tainted
}

func (m *Manager) snapshot() (view, error) {
	tops, err := m.d.Desktop.Toplevels()
	if err != nil {
		return view{}, err
	}
	m.noteFocus(tops)
	v := view{tops: tops}
	for i := range tops {
		if tops[i].Focused {
			v.focused = &tops[i]
		}
		if tops[i].ID == m.s.baseID && m.allowed(tops[i]) {
			v.base = &tops[i]
		}
	}
	return v, nil
}

// pickBase chooses the base: the focused allowed window (the base follows
// focus to an allowed dialog), else the current base, else the newest
// allowed window. It reports whether focus moved the base away from a
// window that is still open: the new base must then be raised.
func (m *Manager) pickBase(v *view) (moved bool) {
	if v.focused != nil && m.allowed(*v.focused) && (v.base == nil || v.base.ID != v.focused.ID) {
		moved = v.base != nil
		v.base = v.focused
	}
	if v.base == nil {
		if v.focused != nil && m.allowed(*v.focused) {
			v.base = v.focused
		} else {
			for i := len(v.tops) - 1; i >= 0; i-- {
				if m.allowed(v.tops[i]) {
					v.base = &v.tops[i]
					break
				}
			}
		}
	}
	m.s.baseID = ""
	if v.base != nil {
		m.s.baseID = v.base.ID
		if m.s.firstBase == "" {
			m.s.firstBase = v.base.ID
		}
	}
	m.smu.Lock()
	if m.wBase != m.s.baseID {
		// A new base: unless it is focused, something may be above it.
		m.tainted = v.base != nil && (v.focused == nil || v.focused.ID != v.base.ID)
	}
	m.wIdx, m.wApps, m.wBase = m.s.index, m.s.apps, m.s.baseID
	m.smu.Unlock()
	return moved
}

// settle keeps the base fullscreen (and, at begin, focused) and waits up
// to a second for labwc to confirm.
func (m *Manager) settle(activate bool) (view, error) {
	v, err := m.snapshot()
	if err != nil {
		return v, err
	}
	moved := m.pickBase(&v) // a dialog is raised over the old fullscreen base
	if v.base == nil {
		return v, nil
	}
	focusedOK := func(v view) bool { return v.focused != nil && m.allowed(*v.focused) }
	changed := false
	// At begin/resume the base is raised unless it already holds focus:
	// focus hops while paused are not tracked (the user may have put a
	// window that is not allowed between the base and an allowed dialog).
	if moved || activate && (v.focused == nil || v.focused.ID != v.base.ID || m.isTainted()) {
		if err := m.d.Desktop.Activate(v.base.ID); err != nil {
			return v, err
		}
		changed = true
	}
	if !v.base.Fullscreen {
		if err := m.d.Desktop.SetFullscreen(v.base.ID, true); err != nil {
			return v, err
		}
		m.s.fullscreened[v.base.ID] = true
		changed = true
	}
	for i := 0; changed && i < fullscreenPolls; i++ {
		if v, err = m.snapshot(); err != nil {
			return v, err
		}
		if v.base != nil && v.base.Fullscreen && (!activate && !moved || (focusedOK(v) && !m.isTainted())) {
			break
		}
		m.d.Sleep(fullscreenPoll)
	}
	return v, nil
}

func sameSet(a, b []string) bool {
	x, y := slices.Clone(a), slices.Clone(b)
	slices.Sort(x)
	slices.Sort(y)
	return slices.Equal(x, y)
}

// Begin starts a session, or resumes a paused one (same id, same apps).
func (m *Manager) Begin(p proto.Begin) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if p.SessionID == "" || len(p.SessionID) > 128 {
		return proto.Errorf(proto.CodeFailed, "sessionId must be 1-128 characters")
	}
	idx := m.d.Apps()
	if err := idx.CheckAllowed(p.AppIDs); err != nil {
		return err
	}
	m.smu.Lock()
	active, id := m.active, m.id
	m.smu.Unlock()
	if active && id != p.SessionID {
		return proto.Errorf(proto.CodeFailed, "another computer-use session is running; end it first")
	}
	if active && !sameSet(m.s.apps, p.AppIDs) {
		return proto.Errorf(proto.CodeFailed, "a resumed session keeps its apps; end it and begin a new one")
	}
	if m.d.Locked() {
		return proto.Errorf(proto.CodeExcluded, "the screen is locked")
	}
	if err := m.d.Activity.Arm(armTimeout); err != nil {
		return proto.Errorf(proto.CodeUnsupported,
			"Jarvis cannot tell when you use the mouse or keyboard: something (a playing video, or your own typing) keeps the screen awake; stop it and try again")
	}
	if !active {
		m.s = &state{apps: slices.Clone(p.AppIDs), index: idx, fullscreened: map[string]bool{}}
	} else {
		m.s.index = idx
	}
	if _, err := m.settle(true); err != nil {
		if !active {
			m.restore()
			m.s = nil
			m.smu.Lock()
			m.wIdx, m.wApps, m.wBase, m.tainted = nil, nil, "", false
			m.smu.Unlock()
		}
		return proto.Errorf(proto.CodeFailed, "could not prepare the app window: %v", err)
	}
	m.smu.Lock()
	m.active, m.id, m.paused = true, p.SessionID, ""
	m.smu.Unlock()
	return nil
}

func (m *Manager) restore() {
	for id := range m.s.fullscreened {
		_ = m.d.Desktop.SetFullscreen(id, false)
	}
}

// End ends the session (no-op without one) and restores fullscreen.
func (m *Manager) End() {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.smu.Lock()
	m.active, m.id, m.paused = false, "", ""
	m.wIdx, m.wApps, m.wBase, m.tainted = nil, nil, "", false
	m.smu.Unlock()
	if m.s == nil {
		return
	}
	m.restore()
	m.s = nil
}

// visible: only the base can be on screen. It is fullscreen, it holds
// keyboard focus (so it is raised), and nothing that is not allowed took
// focus since. A focused allowed window that is not the base may be hidden
// behind it, and showing the base would let keys reach an unseen window.
func (m *Manager) visible(v view) bool {
	return v.base != nil && v.base.Fullscreen && v.focused != nil && v.focused.ID == v.base.ID &&
		m.allowed(*v.focused) && !m.isTainted()
}

func (m *Manager) windowList(v view) []proto.Window {
	out := []proto.Window{}
	for _, t := range v.tops {
		w := proto.Window{WindowID: t.ID, AppID: t.AppID, Focused: t.Focused, Allowed: m.allowed(t)}
		if w.Allowed {
			w.Title = t.Title
		}
		if sh := m.s.shot; v.base != nil && t.ID == v.base.ID && t.Fullscreen && sh != nil && !sh.unseen {
			w.W, w.H = sh.capW, sh.capH
			if !sh.keep.Empty() {
				w.W = sh.keep.Dx() * sh.capW / sh.outW
				w.H = sh.keep.Dy() * sh.capH / sh.outH
			}
		}
		out = append(out, w)
	}
	return out
}

// Windows lists windows; non-allowed titles are "" (they may be private).
func (m *Manager) Windows() ([]proto.Window, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if err := m.gateSession(); err != nil {
		return nil, err
	}
	v, err := m.snapshot()
	if err != nil {
		return nil, proto.Errorf(proto.CodeFailed, "could not read the windows: %v", err)
	}
	return m.windowList(v), nil
}

func clampEdge(n int) int {
	switch {
	case n <= 0:
		return DefaultMaxEdge
	case n < MinMaxEdge:
		return MinMaxEdge
	case n > MaxMaxEdge:
		return MaxMaxEdge
	}
	return n
}

// coverage says how much of the output the fullscreen base really covers.
// A window that does not resize to the output (a fixed-size dialog) sits at
// the output's top-left corner with whatever is behind it around it: keep
// only its own area. A base that cannot be measured is trusted only when it
// is the window chosen at begin (apps without accessibility fail open,
// threat model); a base that focus moved to (a dialog) is blanked and no
// input may reach it.
func (m *Manager) coverage(base *wlcu.Toplevel, frame image.Rectangle, scale int) (keep image.Rectangle, blank, unseen bool) {
	w, h, ok := 0, 0, false
	if m.d.FrameSize != nil && base.Title != "" {
		ctx, cancel := context.WithTimeout(context.Background(), frameTimeout)
		w, h, ok = m.d.FrameSize(ctx, base.Title)
		cancel()
	}
	if !ok || w <= 0 || h <= 0 {
		if base.ID == m.s.firstBase {
			return image.Rectangle{}, false, false
		}
		return image.Rectangle{}, true, true
	}
	r := image.Rect(frame.Min.X, frame.Min.Y, frame.Min.X+w*scale, frame.Min.Y+h*scale).Intersect(frame)
	if r == frame {
		return image.Rectangle{}, false, false
	}
	return r, false, false
}

// outputOf picks the screen to copy. matched is true only when the base
// reports exactly one output and it is the one returned (a lone connected
// screen is trivially the base's). Otherwise the caller must blank: some
// other screen may be showing windows that are not allowed.
func (m *Manager) outputOf(base *wlcu.Toplevel) (out wlcu.Output, matched bool, err error) {
	outs, err := m.d.Desktop.Outputs()
	if err != nil {
		return wlcu.Output{}, false, proto.Errorf(proto.CodeFailed, "could not read the screens: %v", err)
	}
	if len(outs) == 0 {
		return wlcu.Output{}, false, proto.Errorf(proto.CodeFailed, "no screen is connected")
	}
	if base != nil && len(base.Outputs) == 1 {
		for _, o := range outs {
			if o.Name == base.Outputs[0] {
				return o, true, nil
			}
		}
	}
	return outs[0], base != nil && len(outs) == 1 && len(base.Outputs) == 0, nil
}

// Capture returns the base window's screen, blanked unless only allowed
// windows can be visible (Ruling U-1).
func (m *Manager) Capture(p proto.Capture) (*proto.CaptureResult, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if err := m.gateSession(); err != nil {
		return nil, err
	}
	if m.d.Locked() {
		m.LockedNow()
		return nil, proto.Errorf(proto.CodeExcluded, "the screen is locked")
	}
	v, err := m.settle(false)
	if err != nil {
		return nil, proto.Errorf(proto.CodeFailed, "could not read the windows: %v", err)
	}
	out, matched, err := m.outputOf(v.base)
	if err != nil {
		return nil, err
	}
	frame, err := m.d.Desktop.Capture(out.Name)
	if err != nil {
		if errors.Is(err, wlcu.ErrRotated) {
			return nil, proto.Errorf(proto.CodeUnsupported, "%v", err)
		}
		return nil, proto.Errorf(proto.CodeFailed, "could not copy the screen: %v", err)
	}
	rgba, err := frame.RGBA()
	clear(frame.Pix)
	if err != nil {
		return nil, proto.Errorf(proto.CodeFailed, "%v", err)
	}
	// Re-read the windows after the frame arrived: anything that mapped or
	// took focus during the copy may be in the pixels.
	v2, err2 := m.snapshot()
	same := err2 == nil && v.base != nil && v2.base != nil && v2.base.ID == v.base.ID &&
		v.focused != nil && v2.focused != nil && v2.focused.ID == v.focused.ID
	blanked := !matched || !same || !m.visible(v) || !m.visible(v2)
	var keep image.Rectangle
	unseen := false
	if !blanked {
		keep, blanked, unseen = m.coverage(v.base, rgba.Bounds(), max(int(out.Scale), 1))
	}
	switch {
	case blanked:
		img.Blank(rgba)
	case !keep.Empty():
		img.Mask(rgba, []image.Rectangle{keep})
	}
	small, scale := img.Downscale(rgba, clampEdge(p.MaxEdge))
	data, err := img.EncodePNG(small)
	sh := &shot{output: out.Name, outW: rgba.Bounds().Dx(), outH: rgba.Bounds().Dy(),
		capW: small.Bounds().Dx(), capH: small.Bounds().Dy(),
		scale: max(int(out.Scale), 1), blanked: blanked, keep: keep, unseen: unseen}
	if v.base != nil {
		sh.baseID = v.base.ID
	}
	clear(rgba.Pix)
	if small != rgba {
		clear(small.Pix)
	}
	if err != nil {
		return nil, proto.Errorf(proto.CodeFailed, "could not encode the screenshot: %v", err)
	}
	m.s.shot = sh
	return &proto.CaptureResult{
		PNGBase64: base64.StdEncoding.EncodeToString(data),
		Width:     sh.capW, Height: sh.capH, Scale: scale,
		Windows: m.windowList(v),
	}, nil
}
