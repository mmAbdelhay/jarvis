package wlcu

import (
	"errors"
	"fmt"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/img"
	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

const frameFlagYInvert = 1

type bufferSpec struct {
	format img.Format
	w, h   int
	stride int
}

type frameState struct {
	specs     []bufferSpec
	specsDone chan struct{}
	specsShut bool
	flags     uint32
	done      chan struct{}
	failed    bool
}

func (f *frameState) closeSpecs() {
	if !f.specsShut {
		f.specsShut = true
		close(f.specsDone)
	}
}

func (c *Client) frameEvent(obj uint32, op uint16, r *wl.Reader) {
	f := c.frames[obj]
	if f == nil {
		return
	}
	switch op {
	case evFrameBuffer:
		s := bufferSpec{img.Format(r.Uint()), int(r.Uint()), int(r.Uint()), int(r.Uint())}
		if r.Err() == nil {
			f.specs = append(f.specs, s)
		}
		if c.vers[kindScreencopy] < 3 {
			f.closeSpecs()
		}
	case evFrameBufferDone:
		f.closeSpecs()
	case evFrameFlags:
		f.flags = r.Uint()
	case evFrameReady:
		f.closeSpecs()
		close(f.done)
		delete(c.frames, obj)
	case evFrameFailed:
		f.failed = true
		f.closeSpecs()
		close(f.done)
		delete(c.frames, obj)
	}
}

func pickSpec(specs []bufferSpec) (bufferSpec, bool) {
	for _, want := range []img.Format{img.FormatXRGB8888, img.FormatARGB8888, img.FormatXBGR8888, img.FormatABGR8888} {
		for _, s := range specs {
			if s.format == want {
				return s, true
			}
		}
	}
	return bufferSpec{}, false
}

// Capture copies one output's current image without the cursor.
// Shared memory is wiped and released before return; the caller must clear Pix.
func (c *Client) Capture(output string) (img.Frame, error) {
	c.mu.Lock()
	outID, o, err := c.outputByName(output)
	if err != nil {
		c.mu.Unlock()
		return img.Frame{}, err
	}
	if o.transform != 0 {
		c.mu.Unlock()
		return img.Frame{}, ErrRotated
	}
	frame := c.newID(kindFrame)
	fs := &frameState{specsDone: make(chan struct{}), done: make(chan struct{})}
	c.frames[frame] = fs
	mgr, shmObj := c.ids[kindScreencopy], c.ids[kindShm]
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.frames, frame)
		c.mu.Unlock()
		c.send(msg(frame, opFrameDestroy), nil)
	}()

	if err := c.send(msg(mgr, opScreencopyCaptureOutput, frame, 0, outID), nil); err != nil {
		return img.Frame{}, err
	}
	if err := c.wait(fs.specsDone); err != nil {
		return img.Frame{}, err
	}
	c.mu.Lock()
	spec, ok := pickSpec(fs.specs)
	failed := fs.failed
	c.mu.Unlock()
	if failed {
		return img.Frame{}, errors.New("the desktop could not copy the screen")
	}
	if !ok {
		return img.Frame{}, &UnsupportedError{Missing: []string{"a 32-bit shm screen copy format"}}
	}
	size := spec.stride * spec.h
	if spec.w <= 0 || spec.h <= 0 || spec.w > 16384 || spec.h > 16384 || spec.stride < 4*spec.w || size > 512<<20 {
		return img.Frame{}, fmt.Errorf("wlcu: odd screen copy buffer %dx%d stride %d", spec.w, spec.h, spec.stride)
	}
	shm, err := c.shmAlloc.Alloc(size)
	if err != nil {
		return img.Frame{}, err
	}
	defer shm.Close()

	c.mu.Lock()
	pool, buf := c.newID(kindPool), c.newID(kindBuffer)
	c.mu.Unlock()
	if err := c.send(msg(shmObj, opShmCreatePool, pool, uint32(size)), []int{shm.FD}); err != nil {
		return img.Frame{}, err
	}
	err = c.sendAll(
		msg(pool, opPoolCreateBuffer, buf, 0, uint32(spec.w), uint32(spec.h), uint32(spec.stride), uint32(spec.format)),
		msg(pool, opPoolDestroy),
		msg(frame, opFrameCopy, buf),
	)
	if err != nil {
		return img.Frame{}, err
	}
	werr := c.wait(fs.done)
	c.send(msg(buf, opBufferDestroy), nil)
	if werr != nil {
		return img.Frame{}, werr
	}
	c.mu.Lock()
	failed, flags := fs.failed, fs.flags
	c.mu.Unlock()
	if failed {
		return img.Frame{}, errors.New("the desktop could not copy the screen")
	}
	pix := make([]byte, size)
	copy(pix, shm.Mem)
	return img.Frame{Width: spec.w, Height: spec.h, Stride: spec.stride, Format: spec.format,
		YInvert: flags&frameFlagYInvert != 0, Pix: pix}, nil
}
