package wlcu

import (
	"fmt"

	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

// Toplevel is one open window.
type Toplevel struct {
	ID         string // "w<N>", stable while this Client lives
	AppID      string
	Title      string
	Focused    bool
	Minimized  bool
	Maximized  bool
	Fullscreen bool
	Outputs    []string // names of the outputs it is on
}

type handle struct {
	pending, cur Toplevel
	outs         map[uint32]bool
	ready        bool
}

func (c *Client) managerEvent(op uint16, r *wl.Reader) {
	switch op {
	case evManagerToplevel:
		id := r.Uint()
		if r.Err() != nil || c.handles[id] != nil {
			return
		}
		c.objects[id] = kindHandle
		c.seq++
		h := &handle{outs: map[uint32]bool{}}
		h.pending.ID = fmt.Sprintf("w%d", c.seq)
		c.handles[id] = h
		c.byWindow[h.pending.ID] = id
		c.created = append(c.created, id)
	case evManagerFinished:
		c.ids[kindToplevelMgr] = 0
	}
}

func (c *Client) handleEvent(obj uint32, op uint16, r *wl.Reader) {
	h := c.handles[obj]
	if h == nil {
		return
	}
	switch op {
	case evHandleTitle:
		h.pending.Title = r.String()
	case evHandleAppID:
		h.pending.AppID = r.String()
	case evHandleOutputEnter:
		h.outs[r.Uint()] = true
	case evHandleOutputLeave:
		delete(h.outs, r.Uint())
	case evHandleState:
		arr := r.Array()
		h.pending.Focused, h.pending.Minimized, h.pending.Maximized, h.pending.Fullscreen = false, false, false, false
		for i := 0; i+4 <= len(arr); i += 4 {
			switch uint32(arr[i]) | uint32(arr[i+1])<<8 | uint32(arr[i+2])<<16 | uint32(arr[i+3])<<24 {
			case stateMaximized:
				h.pending.Maximized = true
			case stateMinimized:
				h.pending.Minimized = true
			case stateActivated:
				h.pending.Focused = true
			case stateFullscreen:
				h.pending.Fullscreen = true
			}
		}
	case evHandleDone:
		h.cur = h.pending
		h.cur.Outputs = c.outputNames(h.outs)
		h.ready = true
		c.changed()
	case evHandleClosed:
		delete(c.handles, obj)
		delete(c.byWindow, h.pending.ID)
		for i, id := range c.created {
			if id == obj {
				c.created = append(c.created[:i], c.created[i+1:]...)
				break
			}
		}
		c.destroy = append(c.destroy, obj)
		c.changed()
	}
}

func (c *Client) changed() {
	if c.onChange != nil {
		c.pending = append(c.pending, c.onChange)
	}
}

// Toplevels returns the open windows, oldest first.
func (c *Client) Toplevels() ([]Toplevel, error) {
	if err := c.roundtrip(); err != nil {
		return nil, err
	}
	return c.Current(), nil
}

// Current returns the windows as last reported, without a round trip. It is
// the only window read allowed inside OnChange (which runs on the read
// goroutine, so a round trip there would wait for itself).
func (c *Client) Current() []Toplevel {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []Toplevel{}
	for _, id := range c.created {
		if h := c.handles[id]; h != nil && h.ready {
			t := h.cur
			t.Outputs = append([]string(nil), t.Outputs...)
			out = append(out, t)
		}
	}
	return out
}

func (c *Client) handleFor(windowID string) (uint32, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	id, ok := c.byWindow[windowID]
	if !ok {
		return 0, ErrNoWindow
	}
	return id, nil
}

// Activate focuses (and raises, un-minimizes) a window.
func (c *Client) Activate(windowID string) error {
	id, err := c.handleFor(windowID)
	if err != nil {
		return err
	}
	c.mu.Lock()
	seat := c.ids[kindSeat]
	c.mu.Unlock()
	if err := c.send(msg(id, opHandleActivate, seat), nil); err != nil {
		return err
	}
	return c.roundtrip()
}

// SetFullscreen asks labwc to make a window fullscreen on its current
// output (output argument null), or to leave fullscreen.
func (c *Client) SetFullscreen(windowID string, on bool) error {
	id, err := c.handleFor(windowID)
	if err != nil {
		return err
	}
	m := msg(id, opHandleUnsetFullscreen)
	if on {
		m = msg(id, opHandleSetFullscreen, 0)
	}
	if err := c.send(m, nil); err != nil {
		return err
	}
	return c.roundtrip()
}
