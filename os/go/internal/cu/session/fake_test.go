package session

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/img"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/policy"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/wlcu"
)

type fakeDesk struct {
	mu               sync.Mutex
	tops             []wlcu.Toplevel
	outs             []wlcu.Output
	frameW, frameH   int
	lastPix          []byte
	log              []string
	ignoreFullscreen bool
	moveFails        int // fail the Nth MoveTo (1-based), 0 = never
	moves            int
	onMove           func()
	onType           func(call int)
	types            int
	onCapture        func()
}

func newDesk() *fakeDesk {
	return &fakeDesk{
		tops: []wlcu.Toplevel{
			{ID: "w1", AppID: "gimp", Title: "beach.xcf", Outputs: []string{"HEADLESS-1"}},
			{ID: "w2", AppID: "foot", Title: "~/secret-project", Focused: true, Outputs: []string{"HEADLESS-1"}},
			{ID: "w3", AppID: "firefox", Title: "Inbox (3) - mail", Outputs: []string{"HEADLESS-1"}},
		},
		outs:   []wlcu.Output{{Name: "HEADLESS-1", Width: 2560, Height: 1440}},
		frameW: 2560, frameH: 1440,
	}
}

func (d *fakeDesk) logf(f string, a ...any) { d.log = append(d.log, fmt.Sprintf(f, a...)) }

func (d *fakeDesk) logged() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.log)
}

func (d *fakeDesk) has(s string) bool { return slices.Contains(d.logged(), s) }

func (d *fakeDesk) count(prefix string) int {
	n := 0
	for _, l := range d.logged() {
		if strings.HasPrefix(l, prefix) {
			n++
		}
	}
	return n
}

func (d *fakeDesk) focus(id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := range d.tops {
		d.tops[i].Focused = d.tops[i].ID == id
	}
}

func (d *fakeDesk) set(id string, f func(*wlcu.Toplevel)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := range d.tops {
		if d.tops[i].ID == id {
			f(&d.tops[i])
		}
	}
}

func (d *fakeDesk) Toplevels() ([]wlcu.Toplevel, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.tops), nil
}

func (d *fakeDesk) Outputs() ([]wlcu.Output, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.outs), nil
}

func (d *fakeDesk) Activate(id string) error {
	d.mu.Lock()
	d.logf("activate %s", id)
	d.mu.Unlock()
	d.focus(id)
	return nil
}

func (d *fakeDesk) SetFullscreen(id string, on bool) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.logf("fullscreen %s %v", id, on)
	if d.ignoreFullscreen {
		return nil
	}
	for i := range d.tops {
		if d.tops[i].ID == id {
			d.tops[i].Fullscreen = on
		}
	}
	return nil
}

func (d *fakeDesk) Capture(output string) (img.Frame, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.logf("capture %s", output)
	if hook := d.onCapture; hook != nil {
		d.mu.Unlock()
		hook()
		d.mu.Lock()
	}
	pix := make([]byte, 4*d.frameW*d.frameH)
	for i := 0; i < len(pix); i += 4 {
		pix[i], pix[i+1], pix[i+2] = 200, 150, 100 // B G R
	}
	d.lastPix = pix
	return img.Frame{Width: d.frameW, Height: d.frameH, Stride: 4 * d.frameW, Format: img.FormatXRGB8888, Pix: pix}, nil
}

type fakePtr struct{ d *fakeDesk }

func (p fakePtr) MoveTo(x, y, w, h int) error {
	p.d.mu.Lock()
	p.d.moves++
	n, fail, hook := p.d.moves, p.d.moveFails, p.d.onMove
	p.d.logf("move %d %d %d %d", x, y, w, h)
	p.d.mu.Unlock()
	if fail != 0 && n == fail {
		return errors.New("compositor went away")
	}
	if hook != nil {
		hook()
	}
	return nil
}

func (p fakePtr) Button(b wlcu.Button, pressed bool) error {
	p.d.mu.Lock()
	defer p.d.mu.Unlock()
	p.d.logf("button %#x %v", uint32(b), pressed)
	return nil
}

func (p fakePtr) Scroll(dx, dy int) error {
	p.d.mu.Lock()
	defer p.d.mu.Unlock()
	p.d.logf("scroll %d %d", dx, dy)
	return nil
}

func (d *fakeDesk) Pointer(output string) (Pointer, error) { return fakePtr{d}, nil }

type fakeKb struct{ d *fakeDesk }

func (k fakeKb) Type(syms []string) error {
	k.d.mu.Lock()
	k.d.types++
	n, hook := k.d.types, k.d.onType
	k.d.logf("type %d %s", len(syms), strings.Join(syms, ","))
	k.d.mu.Unlock()
	if hook != nil {
		hook(n)
	}
	return nil
}

func (k fakeKb) Combo(mask uint32, keysym string) error {
	k.d.mu.Lock()
	defer k.d.mu.Unlock()
	k.d.logf("combo %d %s", mask, keysym)
	return nil
}

func (d *fakeDesk) Keyboard() (Keyboard, error) { return fakeKb{d}, nil }

type fakeActivity struct {
	mu       sync.Mutex
	armErr   error
	beginErr error
	begins   int
	ends     int
}

func (a *fakeActivity) Arm(time.Duration) error { return a.armErr }

func (a *fakeActivity) Begin() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.beginErr != nil {
		return a.beginErr
	}
	a.begins++
	return nil
}

func (a *fakeActivity) End() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ends++
}

type harness struct {
	m      *Manager
	d      *fakeDesk
	act    *fakeActivity
	locked bool
	pw     bool
	pwErr  error
	mu     sync.Mutex
	events []proto.Event
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{d: newDesk(), act: &fakeActivity{}}
	h.m = New(Deps{
		Desktop:  h.d,
		Apps:     func() *policy.AppIndex { return policy.NewAppIndex(nil) },
		Locked:   func() bool { h.mu.Lock(); defer h.mu.Unlock(); return h.locked },
		Password: func(context.Context) (bool, error) { h.mu.Lock(); defer h.mu.Unlock(); return h.pw, h.pwErr },
		Activity: h.act,
		Push:     func(e proto.Event) { h.mu.Lock(); h.events = append(h.events, e); h.mu.Unlock() },
		Sleep:    func(time.Duration) {},
		After:    func(_ time.Duration, f func()) { f() },
	})
	return h
}

func (h *harness) pushed() []proto.Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.events)
}

func (h *harness) begin(t *testing.T, apps ...string) {
	t.Helper()
	if len(apps) == 0 {
		apps = []string{"gimp"}
	}
	if err := h.m.Begin(proto.Begin{SessionID: "s1", AppIDs: apps}); err != nil {
		t.Fatal(err)
	}
}

func code(err error) string {
	if err == nil {
		return ""
	}
	return proto.AsError(err).Code
}
