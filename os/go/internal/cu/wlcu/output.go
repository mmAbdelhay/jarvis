package wlcu

import "github.com/mmAbdelhay/jarvis/os/go/internal/wl"

type outputState struct {
	name          string
	width, height int
	transform     int32
	scale         int32
}

// Output is one screen; Width/Height are the current mode in pixels
// (the size of a screencopy buffer and of virtual-pointer extents).
type Output struct {
	Name          string
	Width, Height int
	Transform     int32
	// Scale is wl_output.scale (0 when the compositor never said: treat as 1).
	Scale int32
}

func (c *Client) outputEvent(obj uint32, op uint16, r *wl.Reader) {
	o := c.outputs[obj]
	if o == nil {
		return
	}
	switch op {
	case evOutputGeometry:
		r.Uint()
		r.Uint()
		r.Uint()
		r.Uint()
		r.Uint()
		_ = r.String()
		_ = r.String()
		o.transform = int32(r.Uint())
	case evOutputMode:
		flags, w, h := r.Uint(), int32(r.Uint()), int32(r.Uint())
		r.Uint()
		if flags&1 != 0 && w > 0 && h > 0 {
			o.width, o.height = int(w), int(h)
		}
	case evOutputScale:
		if s := int32(r.Uint()); s > 0 {
			o.scale = s
		}
	case evOutputName:
		if n := r.String(); n != "" {
			o.name = n
		}
	}
}

// Outputs lists the screens that have a current mode, in bind order.
func (c *Client) Outputs() ([]Output, error) {
	if err := c.roundtrip(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []Output{}
	for _, id := range c.outputOrder {
		if o := c.outputs[id]; o.width > 0 {
			out = append(out, Output{Name: o.name, Width: o.width, Height: o.height, Transform: o.transform, Scale: o.scale})
		}
	}
	return out, nil
}

// outputByName finds an output object; c.mu is held.
func (c *Client) outputByName(name string) (uint32, *outputState, error) {
	for _, id := range c.outputOrder {
		if o := c.outputs[id]; o.name == name {
			return id, o, nil
		}
	}
	return 0, nil, ErrNoOutput
}

func (c *Client) outputNames(set map[uint32]bool) []string {
	out := []string{}
	for _, id := range c.outputOrder {
		if set[id] {
			out = append(out, c.outputs[id].name)
		}
	}
	return out
}
