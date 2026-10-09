// Package wlcu is jarvis-cu's Wayland client (Rafiq v1.1 contracts §1).
// It speaks the wire protocol directly (no libwayland, no cgo) and reuses
// internal/wl's codec; unlike internal/wl it passes fds (wl_shm pools,
// XKB keymaps), binds every output, and drives screencopy, virtual input
// and idle notifications. Safety rules live in internal/cu/policy and
// internal/cu/session, never here.
package wlcu

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

// Interface names (all verified on labwc 0.8.3 / wlroots 0.18).
const (
	IfSeat         = "wl_seat"
	IfOutput       = "wl_output"
	IfShm          = "wl_shm"
	IfToplevelMgr  = "zwlr_foreign_toplevel_manager_v1"
	IfScreencopy   = "zwlr_screencopy_manager_v1"
	IfVPointerMgr  = "zwlr_virtual_pointer_manager_v1"
	IfVKeyboardMgr = "zwp_virtual_keyboard_manager_v1"
	IfIdleNotifier = "ext_idle_notifier_v1"
)

// Opcodes (requests op*, events ev*) from wayland.xml,
// wlr-foreign-toplevel-management-unstable-v1, wlr-screencopy-unstable-v1,
// wlr-virtual-pointer-unstable-v1, virtual-keyboard-unstable-v1 and
// ext-idle-notify-v1.
const (
	displayID            = 1
	opDisplaySync        = 0
	opDisplayGetRegistry = 1
	evDisplayError       = 0
	evDisplayDeleteID    = 1
	opRegistryBind       = 0
	evRegistryGlobal     = 0
	evCallbackDone       = 0

	evOutputGeometry = 0
	evOutputMode     = 1
	evOutputDone     = 2
	evOutputScale    = 3
	evOutputName     = 4

	evManagerToplevel       = 0
	evManagerFinished       = 1
	evHandleTitle           = 0
	evHandleAppID           = 1
	evHandleOutputEnter     = 2
	evHandleOutputLeave     = 3
	evHandleState           = 4
	evHandleDone            = 5
	evHandleClosed          = 6
	opHandleActivate        = 4
	opHandleDestroy         = 7
	opHandleSetFullscreen   = 8
	opHandleUnsetFullscreen = 9
	stateMaximized          = 0
	stateMinimized          = 1
	stateActivated          = 2
	stateFullscreen         = 3

	opShmCreatePool    = 0
	opPoolCreateBuffer = 0
	opPoolDestroy      = 1
	opBufferDestroy    = 0

	opScreencopyCaptureOutput = 0
	opFrameCopy               = 0
	opFrameDestroy            = 1
	evFrameBuffer             = 0
	evFrameFlags              = 1
	evFrameReady              = 2
	evFrameFailed             = 3
	evFrameBufferDone         = 6

	opVPMgrCreateWithOutput = 2
	opVPMotionAbsolute      = 1
	opVPButton              = 2
	opVPFrame               = 4
	opVPAxisSource          = 5
	opVPAxisDiscrete        = 7
	opVPDestroy             = 8

	opVKMgrCreate     = 0
	opVKKeymap        = 0
	opVKKey           = 1
	opVKModifiers     = 2
	opVKDestroy       = 3
	keymapFormatXKBv1 = 1

	opIdleGetNotification = 1
	opIdleNoteDestroy     = 0
	evIdleIdled           = 0
	evIdleResumed         = 1
)

type kind int

const (
	kindRegistry kind = iota + 1
	kindCallback
	kindSeat
	kindShm
	kindPool
	kindBuffer
	kindOutput
	kindToplevelMgr
	kindHandle
	kindScreencopy
	kindFrame
	kindVPointerMgr
	kindVPointer
	kindVKeyboardMgr
	kindVKeyboard
	kindIdleNotifier
	kindIdleNote
)

type global struct{ name, version uint32 }

type binding struct {
	iface    string
	min, max uint32
	k        kind
}

// singletons are bound after the outputs, in this order.
var singletons = []binding{
	{IfSeat, 1, 1, kindSeat},
	{IfShm, 1, 1, kindShm},
	{IfToplevelMgr, 2, 3, kindToplevelMgr}, // v2: set_fullscreen
	{IfScreencopy, 1, 3, kindScreencopy},   // v3: buffer_done
	{IfVPointerMgr, 2, 2, kindVPointerMgr}, // v2: create_virtual_pointer_with_output
	{IfVKeyboardMgr, 1, 1, kindVKeyboardMgr},
	{IfIdleNotifier, 1, 1, kindIdleNotifier},
}

// UnsupportedError: the compositor lacks a protocol jarvis-cu needs.
type UnsupportedError struct{ Missing []string }

func (e *UnsupportedError) Error() string {
	return "this desktop lacks " + strings.Join(e.Missing, ", ")
}

var (
	ErrTimeout  = errors.New("the desktop did not answer in time")
	ErrNoWindow = errors.New("no open window has that id")
	ErrNoOutput = errors.New("no such screen")
	ErrRotated  = errors.New("rotated screens are not supported for computer use")
)

// Options configure a Client.
type Options struct {
	Timeout  time.Duration // per round trip; default 2 s
	Alloc    Allocator     // default DefaultAllocator()
	OnChange func()        // a window appeared, changed or closed; runs on the read goroutine
}

// Client is one connection to the compositor; safe for concurrent use.
type Client struct {
	t        Transport
	timeout  time.Duration
	shmAlloc Allocator
	onChange func()
	wmu      sync.Mutex

	mu          sync.Mutex
	next        uint32
	objects     map[uint32]kind
	callbacks   map[uint32]chan struct{}
	globals     map[string]global
	outGlobals  []global
	ids         map[kind]uint32
	vers        map[kind]uint32
	outputs     map[uint32]*outputState
	outputOrder []uint32
	handles     map[uint32]*handle
	byWindow    map[string]uint32
	created     []uint32
	seq         int
	destroy     []uint32
	frames      map[uint32]*frameState
	idles       map[uint32]func(bool)
	pending     []func()
	err         error
	dead        chan struct{}
}

// Dial connects to the compositor socket at path.
func Dial(path string, o Options) (*Client, error) {
	if o.Timeout <= 0 {
		o.Timeout = 2 * time.Second
	}
	t, err := DialUnix(path, o.Timeout)
	if err != nil {
		return nil, err
	}
	return New(t, o)
}

// New starts a client: reads the globals, binds every output and the
// singletons, and waits for the initial window and output state.
func New(t Transport, o Options) (*Client, error) {
	if o.Timeout <= 0 {
		o.Timeout = 2 * time.Second
	}
	if o.Alloc == nil {
		o.Alloc = DefaultAllocator()
	}
	c := &Client{
		t: t, timeout: o.Timeout, shmAlloc: o.Alloc, onChange: o.OnChange, next: 2,
		objects: map[uint32]kind{}, callbacks: map[uint32]chan struct{}{}, globals: map[string]global{},
		ids: map[kind]uint32{}, vers: map[kind]uint32{}, outputs: map[uint32]*outputState{},
		handles: map[uint32]*handle{}, byWindow: map[string]uint32{}, frames: map[uint32]*frameState{},
		idles: map[uint32]func(bool){}, dead: make(chan struct{}),
	}
	go c.readLoop()
	c.mu.Lock()
	reg := c.newID(kindRegistry)
	c.ids[kindRegistry] = reg
	c.mu.Unlock()
	steps := []func() error{
		func() error { return c.send(msg(displayID, opDisplayGetRegistry, reg), nil) },
		c.roundtrip,
		c.bindAll,
		c.roundtrip,
	}
	for _, step := range steps {
		if err := step(); err != nil {
			c.Close()
			return nil, err
		}
	}
	return c, nil
}

func (c *Client) bindAll() error {
	c.mu.Lock()
	var missing []string
	if len(c.outGlobals) == 0 {
		missing = append(missing, IfOutput)
	}
	for _, b := range singletons {
		if g, ok := c.globals[b.iface]; !ok || g.version < b.min {
			missing = append(missing, fmt.Sprintf("%s v%d", b.iface, b.min))
		}
	}
	outs := append([]global(nil), c.outGlobals...)
	c.mu.Unlock()
	if len(missing) > 0 {
		return &UnsupportedError{Missing: missing}
	}
	// Outputs first: toplevel output_enter events name output objects.
	for _, g := range outs {
		c.mu.Lock()
		id := c.newID(kindOutput)
		c.outputs[id] = &outputState{name: fmt.Sprintf("output-%d", len(c.outputOrder)+1)}
		c.outputOrder = append(c.outputOrder, id)
		c.mu.Unlock()
		if err := c.bind(g, IfOutput, min(g.version, 4), id); err != nil {
			return err
		}
	}
	for _, b := range singletons {
		c.mu.Lock()
		g := c.globals[b.iface]
		v := min(g.version, b.max)
		id := c.newID(b.k)
		c.ids[b.k], c.vers[b.k] = id, v
		c.mu.Unlock()
		if err := c.bind(g, b.iface, v, id); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) bind(g global, iface string, version, id uint32) error {
	c.mu.Lock()
	reg := c.ids[kindRegistry]
	c.mu.Unlock()
	args := new(wl.Builder).Uint(g.name).String(iface).Uint(version).Uint(id).Bytes()
	return c.send(wl.Message{Object: reg, Opcode: opRegistryBind, Args: args}, nil)
}

// Close ends the connection.
func (c *Client) Close() error {
	c.fail(net.ErrClosed)
	return c.t.Close()
}

// Dead is closed when the connection is gone.
func (c *Client) Dead() <-chan struct{} { return c.dead }

// Err is why the connection died (nil while alive).
func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *Client) fail(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err == nil {
		c.err = err
		close(c.dead)
	}
}

// newID allocates a client object id; c.mu is held.
func (c *Client) newID(k kind) uint32 {
	id := c.next
	c.next++
	c.objects[id] = k
	return id
}

func msg(obj uint32, op uint16, args ...uint32) wl.Message {
	b := new(wl.Builder)
	for _, a := range args {
		b.Uint(a)
	}
	return wl.Message{Object: obj, Opcode: op, Args: b.Bytes()}
}

func (c *Client) send(m wl.Message, fds []int) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if err := c.Err(); err != nil {
		return err
	}
	if err := c.t.WriteMessage(m, fds); err != nil {
		c.fail(fmt.Errorf("wlcu: write: %w", err))
		c.t.Close()
		return c.Err()
	}
	return nil
}

func (c *Client) sendAll(ms ...wl.Message) error {
	for _, m := range ms {
		if err := c.send(m, nil); err != nil {
			return err
		}
	}
	return nil
}

// roundtrip destroys closed handles, then waits until the compositor has
// handled every earlier request (wl_display.sync).
func (c *Client) roundtrip() error {
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return err
	}
	gone := c.destroy
	c.destroy = nil
	cb := c.newID(kindCallback)
	done := make(chan struct{})
	c.callbacks[cb] = done
	c.mu.Unlock()
	for _, h := range gone {
		if err := c.send(msg(h, opHandleDestroy), nil); err != nil {
			return err
		}
	}
	if err := c.send(msg(displayID, opDisplaySync, cb), nil); err != nil {
		return err
	}
	if err := c.wait(done); err != nil {
		return err
	}
	// Closed events may arrive while sync is in flight. Flush their
	// destructors before returning the synchronized window snapshot.
	c.mu.Lock()
	more := len(c.destroy) > 0
	c.mu.Unlock()
	if more {
		return c.roundtrip()
	}
	return nil
}

// wait blocks until ch closes, the connection dies or the timeout hits
// (a timeout kills the connection: a stuck compositor is not trusted).
func (c *Client) wait(ch <-chan struct{}) error {
	timer := time.NewTimer(c.timeout)
	defer timer.Stop()
	select {
	case <-ch:
		return nil
	case <-c.dead:
		return c.Err()
	case <-timer.C:
		c.fail(ErrTimeout)
		c.t.Close()
		return ErrTimeout
	}
}

func (c *Client) readLoop() {
	for {
		m, err := c.t.ReadMessage()
		if err != nil {
			c.fail(fmt.Errorf("wlcu: connection to the desktop lost: %w", err))
			return
		}
		c.mu.Lock()
		perr := c.dispatch(m)
		run := c.pending
		c.pending = nil
		c.mu.Unlock()
		for _, f := range run {
			f()
		}
		if perr != nil {
			c.fail(perr)
			c.t.Close()
			return
		}
	}
}

// dispatch handles one event; c.mu is held. Unknown events are skipped.
func (c *Client) dispatch(m wl.Message) error {
	r := wl.NewReader(m.Args)
	if m.Object == displayID {
		switch m.Opcode {
		case evDisplayError:
			obj, code, text := r.Uint(), r.Uint(), r.String()
			return fmt.Errorf("wlcu: protocol error on object %d (code %d): %s", obj, code, text)
		case evDisplayDeleteID:
			delete(c.objects, r.Uint())
		}
		return nil
	}
	switch c.objects[m.Object] {
	case kindRegistry:
		if m.Opcode == evRegistryGlobal {
			name, iface, version := r.Uint(), r.String(), r.Uint()
			if r.Err() != nil {
				return r.Err()
			}
			if iface == IfOutput {
				c.outGlobals = append(c.outGlobals, global{name, version})
			} else if _, seen := c.globals[iface]; !seen {
				c.globals[iface] = global{name, version}
			}
		}
	case kindCallback:
		if m.Opcode == evCallbackDone {
			if ch := c.callbacks[m.Object]; ch != nil {
				close(ch)
				delete(c.callbacks, m.Object)
			}
		}
	case kindOutput:
		c.outputEvent(m.Object, m.Opcode, r)
	case kindToplevelMgr:
		c.managerEvent(m.Opcode, r)
	case kindHandle:
		c.handleEvent(m.Object, m.Opcode, r)
	case kindFrame:
		c.frameEvent(m.Object, m.Opcode, r)
	case kindIdleNote:
		c.idleEvent(m.Object, m.Opcode)
	}
	return r.Err()
}
