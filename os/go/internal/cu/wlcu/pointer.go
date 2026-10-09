package wlcu

import (
	"fmt"
	"sync"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

// Button is an evdev button code.
type Button uint32

const (
	ButtonLeft   Button = 0x110
	ButtonRight  Button = 0x111
	ButtonMiddle Button = 0x112
)

const (
	axisVertical    = 0
	axisHorizontal  = 1
	axisSourceWheel = 0
	wheelStep       = 15 // libinput's degrees per wheel click
)

// Pointer is a virtual pointer bound to one output.
type Pointer struct {
	c     *Client
	id    uint32
	start time.Time
}

func fixed(v int) uint32 { return uint32(int32(v * 256)) }

// NewPointer creates a virtual pointer whose absolute motion maps onto output.
func (c *Client) NewPointer(output string) (*Pointer, error) {
	c.mu.Lock()
	outID, out, err := c.outputByName(output)
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	if out.transform != 0 {
		c.mu.Unlock()
		return nil, ErrRotated
	}
	id := c.newID(kindVPointer)
	mgr, seat := c.ids[kindVPointerMgr], c.ids[kindSeat]
	c.mu.Unlock()
	if err := c.send(msg(mgr, opVPMgrCreateWithOutput, seat, outID, id), nil); err != nil {
		return nil, err
	}
	if err := c.roundtrip(); err != nil {
		return nil, err
	}
	return &Pointer{c: c, id: id, start: time.Now()}, nil
}

func (p *Pointer) ms() uint32 { return uint32(time.Since(p.start).Milliseconds()) }

// MoveTo puts the pointer at (x, y) of a w×h output-pixel box.
func (p *Pointer) MoveTo(x, y, w, h int) error {
	if w <= 0 || h <= 0 || x < 0 || y < 0 || x >= w || y >= h {
		return fmt.Errorf("wlcu: point %d,%d is outside %dx%d", x, y, w, h)
	}
	if err := p.c.sendAll(msg(p.id, opVPMotionAbsolute, p.ms(), uint32(x), uint32(y), uint32(w), uint32(h)), msg(p.id, opVPFrame)); err != nil {
		return err
	}
	return p.c.roundtrip()
}

// Button presses or releases a button.
func (p *Pointer) Button(b Button, pressed bool) error {
	var state uint32
	if pressed {
		state = 1
	}
	if err := p.c.sendAll(msg(p.id, opVPButton, p.ms(), uint32(b), state), msg(p.id, opVPFrame)); err != nil {
		return err
	}
	return p.c.roundtrip()
}

// Scroll turns the wheel dy clicks down (negative: up) and dx clicks right.
func (p *Pointer) Scroll(dx, dy int) error {
	t := p.ms()
	ms := []wl.Message{msg(p.id, opVPAxisSource, axisSourceWheel)}
	if dy != 0 {
		ms = append(ms, msg(p.id, opVPAxisDiscrete, t, axisVertical, fixed(wheelStep*dy), uint32(int32(dy))))
	}
	if dx != 0 {
		ms = append(ms, msg(p.id, opVPAxisDiscrete, t, axisHorizontal, fixed(wheelStep*dx), uint32(int32(dx))))
	}
	ms = append(ms, msg(p.id, opVPFrame))
	if err := p.c.sendAll(ms...); err != nil {
		return err
	}
	return p.c.roundtrip()
}

// Close destroys the virtual pointer.
func (p *Pointer) Close() error { return p.c.send(msg(p.id, opVPDestroy), nil) }

// WatchIdle subscribes to ext-idle-notify: fn(true) after timeout without
// seat activity, fn(false) on the next activity. labwc counts virtual
// devices as activity too; activity.Detector tells them apart.
func (c *Client) WatchIdle(timeout time.Duration, fn func(idled bool)) (func(), error) {
	ms := uint32(timeout.Milliseconds())
	if ms == 0 {
		ms = 1
	}
	c.mu.Lock()
	id := c.newID(kindIdleNote)
	c.idles[id] = fn
	mgr, seat := c.ids[kindIdleNotifier], c.ids[kindSeat]
	c.mu.Unlock()
	if err := c.send(msg(mgr, opIdleGetNotification, id, ms, seat), nil); err != nil {
		return nil, err
	}
	if err := c.roundtrip(); err != nil {
		return nil, err
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			delete(c.idles, id)
			c.mu.Unlock()
			c.send(msg(id, opIdleNoteDestroy), nil)
		})
	}, nil
}

func (c *Client) idleEvent(obj uint32, op uint16) {
	fn := c.idles[obj]
	if fn == nil {
		return
	}
	idled := op == evIdleIdled
	if op != evIdleIdled && op != evIdleResumed {
		return
	}
	c.pending = append(c.pending, func() { fn(idled) })
}
