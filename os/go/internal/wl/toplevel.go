package wl

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

// Interface names and the opcodes this client uses (wayland.xml and
// wlr-foreign-toplevel-management-unstable-v1.xml, version 3).
const (
	ManagerInterface = "zwlr_foreign_toplevel_manager_v1"
	SeatInterface    = "wl_seat"
	managerVersion   = 3

	displayID = 1

	opDisplaySync        = 0
	opDisplayGetRegistry = 1
	evDisplayError       = 0
	evDisplayDeleteID    = 1

	opRegistryBind   = 0
	evRegistryGlobal = 0

	evCallbackDone = 0

	evManagerToplevel = 0
	evManagerFinished = 1

	evHandleTitle    = 0
	evHandleAppID    = 1
	evHandleState    = 4
	evHandleDone     = 5
	evHandleClosed   = 6
	opHandleActivate = 4
	opHandleClose    = 5
	opHandleDestroy  = 7

	stateMaximized  = 0
	stateMinimized  = 1
	stateActivated  = 2
	stateFullscreen = 3
)

var (
	// ErrUnsupported: the compositor does not offer foreign-toplevel management.
	ErrUnsupported = errors.New("this desktop does not let apps list or switch windows")
	// ErrNoWindow: no open window has that id.
	ErrNoWindow = errors.New("no open window has that id")
	// ErrNoSeat: there is no seat to focus a window with.
	ErrNoSeat = errors.New("no keyboard/mouse seat to focus a window with")
	// ErrTimeout: the compositor did not answer in time.
	ErrTimeout = errors.New("the desktop did not answer in time")
)

// Window is one open toplevel window.
type Window struct {
	ID         string `json:"windowId"` // "w<N>", stable while this Client lives
	AppID      string `json:"appId"`
	Title      string `json:"title"`
	Focused    bool   `json:"focused"`
	Minimized  bool   `json:"minimized"`
	Maximized  bool   `json:"maximized"`
	Fullscreen bool   `json:"fullscreen"`
}

type objKind int

const (
	kindRegistry objKind = iota + 1
	kindCallback
	kindManager
	kindHandle
	kindSeat
)

type handle struct {
	pending, cur Window
	ready        bool
}

type global struct{ name, version uint32 }

// Client is one connection to the compositor. It is safe for concurrent use.
type Client struct {
	conn    io.ReadWriteCloser
	timeout time.Duration
	wmu     sync.Mutex // one writer at a time

	mu        sync.Mutex
	next      uint32
	objects   map[uint32]objKind
	callbacks map[uint32]chan struct{}
	handles   map[uint32]*handle
	byWindow  map[string]uint32
	created   []uint32
	globals   map[string]global
	registry  uint32
	manager   uint32
	seat      uint32
	seq       int
	destroy   []uint32 // closed handles to destroy on the next request
	err       error
	dead      chan struct{}
}

// Dial connects to the compositor socket at path.
func Dial(path string, timeout time.Duration) (*Client, error) {
	conn, err := net.DialTimeout("unix", path, timeout)
	if err != nil {
		return nil, err
	}
	return NewClient(conn, timeout)
}

// NewClient starts a client on an open connection: it reads the globals,
// binds the toplevel manager (and the first seat) and waits for the
// current window list. timeout bounds each round trip (0: 2 s).
func NewClient(conn io.ReadWriteCloser, timeout time.Duration) (*Client, error) {
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	c := &Client{
		conn: conn, timeout: timeout, next: 2,
		objects: map[uint32]objKind{}, callbacks: map[uint32]chan struct{}{},
		handles: map[uint32]*handle{}, byWindow: map[string]uint32{},
		globals: map[string]global{}, dead: make(chan struct{}),
	}
	go c.readLoop()
	c.mu.Lock()
	c.registry = c.alloc(kindRegistry)
	c.mu.Unlock()
	if err := c.send(Message{Object: displayID, Opcode: opDisplayGetRegistry, Args: new(Builder).Uint(c.registry).Bytes()}); err != nil {
		c.Close()
		return nil, err
	}
	if err := c.roundtrip(); err != nil {
		c.Close()
		return nil, err
	}
	c.mu.Lock()
	mg, ok := c.globals[ManagerInterface]
	seat, hasSeat := c.globals[SeatInterface]
	c.mu.Unlock()
	if !ok {
		c.Close()
		return nil, ErrUnsupported
	}
	if err := c.bind(mg, ManagerInterface, min(mg.version, managerVersion), kindManager, &c.manager); err != nil {
		c.Close()
		return nil, err
	}
	if hasSeat {
		if err := c.bind(seat, SeatInterface, 1, kindSeat, &c.seat); err != nil {
			c.Close()
			return nil, err
		}
	}
	if err := c.roundtrip(); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// Close ends the connection.
func (c *Client) Close() error {
	c.fail(net.ErrClosed)
	return c.conn.Close()
}

// Alive reports whether the connection still works.
func (c *Client) Alive() bool {
	select {
	case <-c.dead:
		return false
	default:
		return true
	}
}

func (c *Client) alloc(k objKind) uint32 {
	id := c.next
	c.next++
	c.objects[id] = k
	return id
}

func (c *Client) bind(g global, iface string, version uint32, k objKind, dst *uint32) error {
	c.mu.Lock()
	id := c.alloc(k)
	*dst = id
	c.mu.Unlock()
	args := new(Builder).Uint(g.name).String(iface).Uint(version).Uint(id).Bytes()
	return c.send(Message{Object: c.registry, Opcode: opRegistryBind, Args: args})
}

func (c *Client) send(m Message) error {
	b, err := m.Encode()
	if err != nil {
		return err
	}
	// Bound writes as well as replies, including waiting for another writer.
	result := make(chan error, 1)
	go func() {
		c.wmu.Lock()
		defer c.wmu.Unlock()
		c.mu.Lock()
		err := c.err
		c.mu.Unlock()
		if err != nil {
			result <- err
			return
		}
		for len(b) > 0 {
			n, err := c.conn.Write(b)
			if err != nil {
				result <- err
				return
			}
			if n <= 0 || n > len(b) {
				result <- io.ErrShortWrite
				return
			}
			b = b[n:]
		}
		result <- nil
	}()
	timer := time.NewTimer(c.timeout)
	defer timer.Stop()
	select {
	case err := <-result:
		if err != nil {
			c.fail(fmt.Errorf("wl: write: %w", err))
			c.conn.Close()
			c.mu.Lock()
			defer c.mu.Unlock()
			return c.err
		}
		return nil
	case <-c.dead:
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.err
	case <-timer.C:
		c.fail(ErrTimeout)
		c.conn.Close()
		return ErrTimeout
	}
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
	cb := c.alloc(kindCallback)
	done := make(chan struct{})
	c.callbacks[cb] = done
	c.mu.Unlock()
	for _, h := range gone {
		if err := c.send(Message{Object: h, Opcode: opHandleDestroy}); err != nil {
			return err
		}
	}
	if err := c.send(Message{Object: displayID, Opcode: opDisplaySync, Args: new(Builder).Uint(cb).Bytes()}); err != nil {
		return err
	}
	select {
	case <-done:
		return nil
	case <-c.dead:
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.err
	case <-time.After(c.timeout):
		c.fail(ErrTimeout)
		c.conn.Close()
		return ErrTimeout
	}
}

func (c *Client) readLoop() {
	for {
		m, err := ReadMessage(c.conn)
		if err != nil {
			c.fail(fmt.Errorf("wl: connection to the desktop lost: %w", err))
			return
		}
		c.mu.Lock()
		perr := c.dispatch(m)
		c.mu.Unlock()
		if perr != nil {
			c.fail(perr)
			c.conn.Close()
			return
		}
	}
}

func (c *Client) fail(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err == nil {
		c.err = err
		close(c.dead)
	}
}

// dispatch handles one event; c.mu is held. Unknown events are skipped.
func (c *Client) dispatch(m Message) error {
	r := NewReader(m.Args)
	if m.Object == displayID {
		switch m.Opcode {
		case evDisplayError:
			obj, code, msg := r.Uint(), r.Uint(), r.String()
			return fmt.Errorf("wl: protocol error on object %d (code %d): %s", obj, code, msg)
		case evDisplayDeleteID:
			delete(c.objects, r.Uint())
		}
		return nil
	}
	switch c.objects[m.Object] {
	case kindRegistry:
		if m.Opcode == evRegistryGlobal {
			name, iface, version := r.Uint(), r.String(), r.Uint()
			if r.Err() == nil {
				if _, seen := c.globals[iface]; !seen {
					c.globals[iface] = global{name, version}
				}
			}
		}
	case kindCallback:
		if m.Opcode == evCallbackDone {
			if ch := c.callbacks[m.Object]; ch != nil {
				close(ch)
				delete(c.callbacks, m.Object)
			}
		}
	case kindManager:
		switch m.Opcode {
		case evManagerToplevel:
			id := r.Uint()
			if r.Err() != nil {
				return r.Err()
			}
			c.objects[id] = kindHandle
			c.seq++
			h := &handle{}
			h.pending.ID = fmt.Sprintf("w%d", c.seq)
			c.handles[id] = h
			c.byWindow[h.pending.ID] = id
			c.created = append(c.created, id)
		case evManagerFinished:
			c.manager = 0
		}
	case kindHandle:
		h := c.handles[m.Object]
		if h == nil {
			return nil
		}
		switch m.Opcode {
		case evHandleTitle:
			h.pending.Title = r.String()
		case evHandleAppID:
			h.pending.AppID = r.String()
		case evHandleState:
			arr := r.Array()
			h.pending.Focused, h.pending.Minimized, h.pending.Maximized, h.pending.Fullscreen = false, false, false, false
			for i := 0; i+4 <= len(arr); i += 4 {
				switch order.Uint32(arr[i:]) {
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
			h.cur, h.ready = h.pending, true
		case evHandleClosed:
			delete(c.handles, m.Object)
			delete(c.byWindow, h.pending.ID)
			c.destroy = append(c.destroy, m.Object)
		}
		return r.Err()
	}
	return nil
}

// Windows returns the open windows, oldest first.
func (c *Client) Windows() ([]Window, error) {
	if err := c.roundtrip(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []Window{}
	for _, id := range c.created {
		if h := c.handles[id]; h != nil && h.ready {
			out = append(out, h.cur)
		}
	}
	return out, nil
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

// Activate focuses (and un-minimizes) a window.
func (c *Client) Activate(windowID string) error {
	id, err := c.handleFor(windowID)
	if err != nil {
		return err
	}
	c.mu.Lock()
	seat := c.seat
	c.mu.Unlock()
	if seat == 0 {
		return ErrNoSeat
	}
	if err := c.send(Message{Object: id, Opcode: opHandleActivate, Args: new(Builder).Uint(seat).Bytes()}); err != nil {
		return err
	}
	return c.roundtrip()
}

// CloseWindow asks a window to close (the app may still ask to save).
func (c *Client) CloseWindow(windowID string) error {
	id, err := c.handleFor(windowID)
	if err != nil {
		return err
	}
	if err := c.send(Message{Object: id, Opcode: opHandleClose}); err != nil {
		return err
	}
	return c.roundtrip()
}

var socketRe = regexp.MustCompile(`^wayland-[0-9]+$`)

// SocketPath finds the compositor socket: $WAYLAND_DISPLAY (absolute, or
// relative to $XDG_RUNTIME_DIR), else the lowest-numbered wayland-N socket
// in $XDG_RUNTIME_DIR (jarvisd runs as a user service, which may have
// started before labwc exported WAYLAND_DISPLAY).
func SocketPath(getenv func(string) string, readDir func(string) ([]os.DirEntry, error)) (string, error) {
	runtime := getenv("XDG_RUNTIME_DIR")
	if d := getenv("WAYLAND_DISPLAY"); d != "" {
		if filepath.IsAbs(d) {
			return d, nil
		}
		if runtime == "" {
			return "", errors.New("XDG_RUNTIME_DIR is not set")
		}
		if d == "." || d == ".." || filepath.Base(d) != d {
			return "", fmt.Errorf("odd WAYLAND_DISPLAY %q", d)
		}
		return filepath.Join(runtime, d), nil
	}
	if runtime == "" {
		return "", errors.New("no Wayland session (XDG_RUNTIME_DIR is not set)")
	}
	ents, err := readDir(runtime)
	if err != nil {
		return "", err
	}
	var names []string
	for _, e := range ents {
		if socketRe.MatchString(e.Name()) && e.Type()&os.ModeSocket != 0 {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		return "", errors.New("no Wayland session found")
	}
	sort.Slice(names, func(i, j int) bool {
		return len(names[i]) < len(names[j]) || (len(names[i]) == len(names[j]) && names[i] < names[j])
	})
	return filepath.Join(runtime, names[0]), nil
}

// Display is the WAYLAND_DISPLAY value to give child processes: the name
// of the socket SocketPath finds, preserving an explicit absolute path.
func Display(getenv func(string) string, readDir func(string) ([]os.DirEntry, error)) (string, error) {
	p, err := SocketPath(getenv, readDir)
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(getenv("WAYLAND_DISPLAY")) {
		return p, nil
	}
	return filepath.Base(p), nil
}
