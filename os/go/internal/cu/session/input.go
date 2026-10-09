package session

import (
	"context"
	"math"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/policy"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/wlcu"
)

// Input limits (plan U Global Constraints).
const (
	MaxScroll       = 10
	TypeChunk       = 64
	dragSteps       = 12
	dragStepGap     = 16 * time.Millisecond
	clickGap        = 60 * time.Millisecond
	passwordTimeout = 300 * time.Millisecond
)

func (m *Manager) countOp() error {
	if m.s.ops >= MaxInputOps {
		return proto.Errorf(proto.CodeFailed, "this session has used its %d actions; end it and begin a new one", MaxInputOps)
	}
	m.s.ops++
	return nil
}

// focusOK checks what may hold focus while input is injected.
func (m *Manager) focusOK(v view) error {
	if v.focused == nil {
		return proto.Errorf(proto.CodeExcluded, "keyboard focus is on the Rafiq shell or a system surface")
	}
	if ex, why := m.s.index.Excluded(v.focused.AppID); ex {
		return proto.Errorf(proto.CodeExcluded, "the focused window is %s, which Jarvis never controls", why)
	}
	if !m.allowed(*v.focused) {
		return proto.Errorf(proto.CodeOutside, "the focused window (%s) is not one of the allowed apps", v.focused.AppID)
	}
	if v.base == nil || !v.base.Fullscreen {
		return proto.Errorf(proto.CodeOutside, "no allowed window fills the screen; capture again")
	}
	return nil
}

// gateInput runs every check that must hold right before injecting.
func (m *Manager) gateInput(keyboard bool) (*shot, error) {
	if err := m.gateSession(); err != nil {
		return nil, err
	}
	if m.d.Locked() {
		m.LockedNow()
		return nil, proto.Errorf(proto.CodeExcluded, "the screen is locked")
	}
	v, err := m.snapshot()
	if err != nil {
		return nil, proto.Errorf(proto.CodeFailed, "could not read the windows: %v", err)
	}
	if err := m.focusOK(v); err != nil {
		return nil, err
	}
	sh := m.s.shot
	if sh == nil {
		return nil, proto.Errorf(proto.CodeFailed, "capture the screen before acting on it")
	}
	outs, err := m.d.Desktop.Outputs()
	if err != nil {
		return nil, proto.Errorf(proto.CodeFailed, "could not read the screens: %v", err)
	}
	same := false
	for _, o := range outs {
		if o.Name == sh.output && o.Width == sh.outW && o.Height == sh.outH {
			same = true
		}
	}
	if !same || len(v.base.Outputs) > 0 && v.base.Outputs[0] != sh.output {
		return nil, proto.Errorf(proto.CodeFailed, "the screen changed since the last capture; capture again")
	}
	pw, perr := false, error(nil)
	if m.d.Password == nil {
		perr = context.Canceled
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), passwordTimeout)
		pw, perr = m.d.Password(ctx)
		cancel()
	}
	switch {
	case perr != nil && keyboard:
		return nil, proto.Errorf(proto.CodeExcluded, "Jarvis cannot check for password fields right now, so it will not type")
	case perr == nil && pw:
		return nil, proto.Errorf(proto.CodeExcluded, "a password field has focus; Jarvis never types or clicks there; fill it in yourself or move focus")
	}
	return sh, nil
}

// recheck runs between injected steps: focus, pause and lock again.
func (m *Manager) recheck() error {
	if err := m.gateSession(); err != nil {
		return err
	}
	if m.d.Locked() {
		m.LockedNow()
		return proto.Errorf(proto.CodeExcluded, "the screen is locked")
	}
	v, err := m.snapshot()
	if err != nil {
		return proto.Errorf(proto.CodeFailed, "could not read the windows: %v", err)
	}
	return m.focusOK(v)
}

func (sh *shot) toOutput(x, y float64) (int, int, error) {
	if x < 0 || y < 0 || x >= float64(sh.capW) || y >= float64(sh.capH) {
		return 0, 0, proto.Errorf(proto.CodeOutside, "(%g, %g) is outside the %dx%d screenshot", x, y, sh.capW, sh.capH)
	}
	ox := min(int(math.Floor(x*float64(sh.outW)/float64(sh.capW))), sh.outW-1)
	oy := min(int(math.Floor(y*float64(sh.outH)/float64(sh.capH))), sh.outH-1)
	return ox, oy, nil
}

// inject brackets real input with the physical-input detector.
func (m *Manager) inject(fn func() error) error {
	if err := m.d.Activity.Begin(); err != nil {
		return proto.Errorf(proto.CodePaused, "paused: you are using the mouse or keyboard")
	}
	err := fn()
	m.d.Activity.End()
	if err != nil {
		return proto.AsError(err)
	}
	return nil
}

func buttonOf(s string) (wlcu.Button, error) {
	switch s {
	case "", "left":
		return wlcu.ButtonLeft, nil
	case "right":
		return wlcu.ButtonRight, nil
	case "middle":
		return wlcu.ButtonMiddle, nil
	}
	return 0, proto.Errorf(proto.CodeFailed, "button must be left, right or middle")
}

func coords(names []string, vals []*float64) ([]float64, error) {
	out := make([]float64, len(vals))
	for i, v := range vals {
		c, err := proto.Coord(names[i], v)
		if err != nil {
			return nil, err
		}
		out[i] = c
	}
	return out, nil
}

// Click clicks (or double-clicks) at a capture-space point.
func (m *Manager) Click(p proto.Click) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	xy, err := coords([]string{"x", "y"}, []*float64{p.X, p.Y})
	if err != nil {
		return err
	}
	btn, err := buttonOf(p.Button)
	if err != nil {
		return err
	}
	sh, err := m.gateInput(false)
	if err != nil {
		return err
	}
	ox, oy, err := sh.toOutput(xy[0], xy[1])
	if err != nil {
		return err
	}
	if err := m.countOp(); err != nil {
		return err
	}
	ptr, err := m.d.Desktop.Pointer(sh.output)
	if err != nil {
		return proto.Errorf(proto.CodeFailed, "%v", err)
	}
	return m.inject(func() error {
		if err := ptr.MoveTo(ox, oy, sh.outW, sh.outH); err != nil {
			return err
		}
		if err := m.recheck(); err != nil {
			return err
		}
		n := 1
		if p.Double {
			n = 2
		}
		for i := 0; i < n; i++ {
			if i > 0 {
				m.d.Sleep(clickGap)
			}
			if err := ptr.Button(btn, true); err != nil {
				return err
			}
			if err := ptr.Button(btn, false); err != nil {
				return err
			}
		}
		return nil
	})
}

// Type types text in chunks, re-checking the gate before each chunk.
func (m *Manager) Type(p proto.Type) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if p.Text == nil {
		return proto.Errorf(proto.CodeFailed, "text is required")
	}
	syms, err := policy.TextKeysyms(*p.Text)
	if err != nil {
		return err
	}
	if _, err := m.gateInput(true); err != nil {
		return err
	}
	if err := m.countOp(); err != nil {
		return err
	}
	kb, err := m.d.Desktop.Keyboard()
	if err != nil {
		return proto.Errorf(proto.CodeFailed, "%v", err)
	}
	for start := 0; start < len(syms); start += TypeChunk {
		if start > 0 {
			if _, err := m.gateInput(true); err != nil {
				e := proto.AsError(err)
				return proto.Errorf(e.Code, "%s (stopped after %d of %d characters)", e.Message, start, len(syms))
			}
		}
		chunk := syms[start:min(start+TypeChunk, len(syms))]
		if err := m.inject(func() error { return kb.Type(chunk) }); err != nil {
			e := proto.AsError(err)
			return proto.Errorf(e.Code, "%s (stopped after %d of %d characters)", e.Message, start, len(syms))
		}
	}
	return nil
}

// Key presses one combo.
func (m *Manager) Key(p proto.Key) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	c, err := policy.ParseCombo(p.Combo)
	if err != nil {
		return err
	}
	if _, err := m.gateInput(true); err != nil {
		return err
	}
	if err := m.countOp(); err != nil {
		return err
	}
	kb, err := m.d.Desktop.Keyboard()
	if err != nil {
		return proto.Errorf(proto.CodeFailed, "%v", err)
	}
	return m.inject(func() error { return kb.Combo(c.Mods.Mask(), c.Keysym) })
}

// Scroll moves to a point and turns the wheel.
func (m *Manager) Scroll(p proto.Scroll) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	xy, err := coords([]string{"x", "y"}, []*float64{p.X, p.Y})
	if err != nil {
		return err
	}
	if p.DX == 0 && p.DY == 0 || p.DX > MaxScroll || p.DX < -MaxScroll || p.DY > MaxScroll || p.DY < -MaxScroll {
		return proto.Errorf(proto.CodeFailed, "dx and dy are wheel clicks from -%d to %d, not both 0", MaxScroll, MaxScroll)
	}
	sh, err := m.gateInput(false)
	if err != nil {
		return err
	}
	ox, oy, err := sh.toOutput(xy[0], xy[1])
	if err != nil {
		return err
	}
	if err := m.countOp(); err != nil {
		return err
	}
	ptr, err := m.d.Desktop.Pointer(sh.output)
	if err != nil {
		return proto.Errorf(proto.CodeFailed, "%v", err)
	}
	return m.inject(func() error {
		if err := ptr.MoveTo(ox, oy, sh.outW, sh.outH); err != nil {
			return err
		}
		if err := m.recheck(); err != nil {
			return err
		}
		return ptr.Scroll(p.DX, p.DY)
	})
}

// Drag drags with the left button; the button is always released.
func (m *Manager) Drag(p proto.Drag) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	c, err := coords([]string{"x1", "y1", "x2", "y2"}, []*float64{p.X1, p.Y1, p.X2, p.Y2})
	if err != nil {
		return err
	}
	sh, err := m.gateInput(false)
	if err != nil {
		return err
	}
	ax, ay, err := sh.toOutput(c[0], c[1])
	if err != nil {
		return err
	}
	bx, by, err := sh.toOutput(c[2], c[3])
	if err != nil {
		return err
	}
	if err := m.countOp(); err != nil {
		return err
	}
	ptr, err := m.d.Desktop.Pointer(sh.output)
	if err != nil {
		return proto.Errorf(proto.CodeFailed, "%v", err)
	}
	return m.inject(func() (err error) {
		if err := ptr.MoveTo(ax, ay, sh.outW, sh.outH); err != nil {
			return err
		}
		if err := m.recheck(); err != nil {
			return err
		}
		if err := ptr.Button(wlcu.ButtonLeft, true); err != nil {
			return err
		}
		defer func() {
			if rerr := ptr.Button(wlcu.ButtonLeft, false); err == nil {
				err = rerr
			}
		}()
		for i := 1; i <= dragSteps; i++ {
			m.d.Sleep(dragStepGap)
			x := ax + (bx-ax)*i/dragSteps
			y := ay + (by-ay)*i/dragSteps
			if err := ptr.MoveTo(x, y, sh.outW, sh.outH); err != nil {
				return err
			}
		}
		return nil
	})
}
