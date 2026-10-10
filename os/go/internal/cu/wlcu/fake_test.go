package wlcu

import (
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/img"
	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

type fakeGlobal struct {
	iface   string
	version uint32
}

type fakeOutput struct {
	name      string
	w, h      int
	transform int32
}

type fakeWindow struct {
	appID, title string
	states       []uint32
	output       int
}

type fakeBuf struct {
	mem                  []byte
	offset, w, h, stride int
	format               uint32
}

// fake is a scripted labwc: it answers exactly the requests wlcu makes,
// keeps the state a test needs to assert on, and logs every request.
type fake struct {
	t             *testing.T
	globals       []fakeGlobal
	outputVersion uint32
	outputs       []fakeOutput
	windows       []fakeWindow
	format        uint32
	pixel         [4]byte
	yInvert       bool
	failCopy      bool
	noSync        bool

	mu                sync.Mutex
	toClient          chan wl.Message
	closed            chan struct{}
	closeOnce         sync.Once
	objects           map[uint32]string
	globalOut         map[uint32]int
	outputObj         map[int]uint32
	toplevelMgr       uint32
	screencopyVersion uint32
	handles           []uint32
	fdMem             map[int][]byte
	pools             map[uint32][]byte
	buffers           map[uint32]fakeBuf
	frames            map[uint32]int
	keymaps           []string
	idleNotes         []uint32
	log               []string
	nextServer        uint32
}

func newFake() *fake {
	return &fake{
		globals: []fakeGlobal{
			{IfSeat, 9}, {IfShm, 2}, {IfToplevelMgr, 3}, {IfScreencopy, 3},
			{IfVPointerMgr, 2}, {IfVKeyboardMgr, 1}, {IfIdleNotifier, 1}, {"wl_compositor", 5},
		},
		outputVersion: 4,
		outputs:       []fakeOutput{{name: "HEADLESS-1", w: 8, h: 4}},
		windows: []fakeWindow{
			{appID: "gimp", title: "beach.xcf", states: []uint32{stateActivated}},
			{appID: "foot", title: "~"},
		},
		format: uint32(img.FormatXRGB8888),
		pixel:  [4]byte{0x30, 0x20, 0x10, 0},
	}
}

type fakeTransport struct{ f *fake }

func (ft fakeTransport) ReadMessage() (wl.Message, error) {
	select {
	case m := <-ft.f.toClient:
		return m, nil
	case <-ft.f.closed:
		return wl.Message{}, io.EOF
	}
}

func (ft fakeTransport) WriteMessage(m wl.Message, fds []int) error {
	select {
	case <-ft.f.closed:
		return net.ErrClosed
	default:
	}
	ft.f.handle(m, fds)
	return nil
}

func (ft fakeTransport) Close() error {
	ft.f.closeOnce.Do(func() { close(ft.f.closed) })
	return nil
}

type fakeAlloc struct {
	f *fake
	n int
}

func (a *fakeAlloc) Alloc(size int) (*Shm, error) {
	a.n++
	fd := 100 + a.n
	mem := make([]byte, size)
	a.f.mu.Lock()
	a.f.fdMem[fd] = mem
	a.f.mu.Unlock()
	return &Shm{FD: fd, Mem: mem}, nil
}

func startFake(t *testing.T, f *fake, onChange func()) (*Client, error) {
	t.Helper()
	f.t = t
	f.toClient = make(chan wl.Message, 1<<14)
	f.closed = make(chan struct{})
	f.objects = map[uint32]string{displayID: "wl_display"}
	f.globalOut = map[uint32]int{}
	f.outputObj = map[int]uint32{}
	f.fdMem = map[int][]byte{}
	f.pools = map[uint32][]byte{}
	f.buffers = map[uint32]fakeBuf{}
	f.frames = map[uint32]int{}
	f.nextServer = 0xff000000
	c, err := New(fakeTransport{f}, Options{Timeout: time.Second, Alloc: &fakeAlloc{f: f}, OnChange: onChange})
	if c != nil {
		t.Cleanup(func() { c.Close() })
	}
	return c, err
}

func (f *fake) emit(obj uint32, op uint16, b *wl.Builder) {
	var args []byte
	if b != nil {
		args = b.Bytes()
	}
	f.toClient <- wl.Message{Object: obj, Opcode: op, Args: args}
}

func (f *fake) logf(format string, args ...any) { f.log = append(f.log, fmt.Sprintf(format, args...)) }

func (f *fake) logged() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.log...)
}

func (f *fake) count(prefix string) int {
	n := 0
	for _, l := range f.logged() {
		if strings.HasPrefix(l, prefix) {
			n++
		}
	}
	return n
}

func u32s(states []uint32) []byte {
	b := new(wl.Builder)
	for _, s := range states {
		b.Uint(s)
	}
	return b.Bytes()
}

func hasState(states []uint32, s uint32) bool {
	for _, x := range states {
		if x == s {
			return true
		}
	}
	return false
}

func without(states []uint32, s uint32) []uint32 {
	out := []uint32{}
	for _, x := range states {
		if x != s {
			out = append(out, x)
		}
	}
	return out
}

func (f *fake) emitState(i int) {
	h := f.handles[i]
	if h == 0 {
		return
	}
	f.emit(h, evHandleState, new(wl.Builder).Array(u32s(f.windows[i].states)))
	f.emit(h, evHandleDone, nil)
}

func (f *fake) announce(i int) {
	f.nextServer++
	h := f.nextServer
	f.objects[h] = "handle"
	f.handles = append(f.handles, h)
	w := f.windows[i]
	f.emit(f.toplevelMgr, evManagerToplevel, new(wl.Builder).Uint(h))
	f.emit(h, evHandleTitle, new(wl.Builder).String(w.title))
	f.emit(h, evHandleAppID, new(wl.Builder).String(w.appID))
	if o, ok := f.outputObj[w.output]; ok {
		f.emit(h, evHandleOutputEnter, new(wl.Builder).Uint(o))
	}
	f.emitState(i)
}

func (f *fake) indexOf(h uint32) int {
	for i, x := range f.handles {
		if x == h {
			return i
		}
	}
	return -1
}

func (f *fake) outputIndex(obj uint32) int {
	for i, o := range f.outputObj {
		if o == obj {
			return i
		}
	}
	f.t.Errorf("unknown output object %d", obj)
	return 0
}

// focus makes window i the only activated one (what a click by the user does).
func (f *fake) focus(i int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.activate(i)
}

func (f *fake) activate(i int) {
	for j := range f.windows {
		if f.handles[j] == 0 {
			continue
		}
		was := hasState(f.windows[j].states, stateActivated)
		f.windows[j].states = without(f.windows[j].states, stateActivated)
		if j == i {
			f.windows[j].states = append(f.windows[j].states, stateActivated)
		}
		if was || j == i {
			f.emitState(j)
		}
	}
}

// open maps a new window (it takes focus, as labwc does).
func (f *fake) open(w fakeWindow) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.windows = append(f.windows, w)
	f.announce(len(f.windows) - 1)
	if hasState(w.states, stateActivated) {
		f.activate(len(f.windows) - 1)
	}
}

// closeWindow unmaps window i.
func (f *fake) closeWindow(i int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.emit(f.handles[i], evHandleClosed, nil)
	f.handles[i] = 0
}

// idle sends idled (true) or resumed (false) to every idle notification.
func (f *fake) idle(idled bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	op := uint16(evIdleResumed)
	if idled {
		op = evIdleIdled
	}
	for _, n := range f.idleNotes {
		f.emit(n, op, nil)
	}
}

func (f *fake) handle(m wl.Message, fds []int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := wl.NewReader(m.Args)
	switch f.objects[m.Object] {
	case "wl_display":
		switch m.Opcode {
		case opDisplaySync:
			cb := r.Uint()
			if !f.noSync {
				f.emit(cb, evCallbackDone, new(wl.Builder).Uint(1))
				f.emit(displayID, evDisplayDeleteID, new(wl.Builder).Uint(cb))
			}
		case opDisplayGetRegistry:
			id := r.Uint()
			f.objects[id] = "wl_registry"
			for i, g := range f.globals {
				f.emit(id, evRegistryGlobal, new(wl.Builder).Uint(uint32(i+1)).String(g.iface).Uint(g.version))
			}
			for i := range f.outputs {
				name := uint32(100 + i)
				f.globalOut[name] = i
				f.emit(id, evRegistryGlobal, new(wl.Builder).Uint(name).String(IfOutput).Uint(f.outputVersion))
			}
		}
	case "wl_registry":
		name, iface, version, id := r.Uint(), r.String(), r.Uint(), r.Uint()
		f.objects[id] = iface
		f.logf("bind %s v%d", iface, version)
		switch iface {
		case IfOutput:
			i := f.globalOut[name]
			f.outputObj[i] = id
			o := f.outputs[i]
			f.emit(id, evOutputGeometry, new(wl.Builder).Uint(0).Uint(0).Uint(300).Uint(200).Uint(0).String("make").String("model").Uint(uint32(o.transform)))
			f.emit(id, evOutputMode, new(wl.Builder).Uint(1).Uint(uint32(o.w)).Uint(uint32(o.h)).Uint(60000))
			f.emit(id, evOutputScale, new(wl.Builder).Uint(1))
			if version >= 4 {
				f.emit(id, evOutputName, new(wl.Builder).String(o.name))
			}
			f.emit(id, evOutputDone, nil)
		case IfToplevelMgr:
			f.toplevelMgr = id
			for i := range f.windows {
				f.announce(i)
			}
		case IfScreencopy:
			f.screencopyVersion = version
		}
	case "handle":
		if m.Opcode == opHandleDestroy {
			f.logf("destroy handle")
			return
		}
		i := f.indexOf(m.Object)
		if i < 0 {
			return
		}
		app := f.windows[i].appID
		switch m.Opcode {
		case opHandleActivate:
			f.logf("activate %s", app)
			f.activate(i)
		case opHandleSetFullscreen:
			if out := r.Uint(); out != 0 {
				f.t.Errorf("set_fullscreen must let labwc pick the output, got %d", out)
			}
			f.logf("fullscreen %s", app)
			if !hasState(f.windows[i].states, stateFullscreen) {
				f.windows[i].states = append(f.windows[i].states, stateFullscreen)
			}
			f.emitState(i)
		case opHandleUnsetFullscreen:
			f.logf("unfullscreen %s", app)
			f.windows[i].states = without(f.windows[i].states, stateFullscreen)
			f.emitState(i)
		}
	case IfShm:
		if m.Opcode == opShmCreatePool {
			id, size := r.Uint(), int(r.Uint())
			if len(fds) != 1 {
				f.t.Errorf("create_pool needs exactly one fd, got %v", fds)
				return
			}
			mem := f.fdMem[fds[0]]
			if len(mem) < size {
				f.t.Errorf("pool of %d bytes over %d bytes of memory", size, len(mem))
				return
			}
			f.objects[id] = "pool"
			f.pools[id] = mem[:size]
		}
	case "pool":
		switch m.Opcode {
		case opPoolCreateBuffer:
			id := r.Uint()
			b := fakeBuf{mem: f.pools[m.Object], offset: int(r.Uint()), w: int(r.Uint()), h: int(r.Uint()), stride: int(r.Uint()), format: r.Uint()}
			f.objects[id] = "buffer"
			f.buffers[id] = b
		case opPoolDestroy:
			f.logf("pool destroy")
		}
	case "buffer":
		f.logf("buffer destroy")
	case IfScreencopy:
		if m.Opcode == opScreencopyCaptureOutput {
			frame, cursor, out := r.Uint(), r.Uint(), r.Uint()
			if cursor != 0 {
				f.t.Error("the cursor must not be painted into screenshots")
			}
			idx := f.outputIndex(out)
			f.objects[frame] = "frame"
			f.frames[frame] = idx
			o := f.outputs[idx]
			f.emit(frame, evFrameBuffer, new(wl.Builder).Uint(f.format).Uint(uint32(o.w)).Uint(uint32(o.h)).Uint(uint32(4*o.w)))
			if f.screencopyVersion >= 3 {
				f.emit(frame, evFrameBufferDone, nil)
			}
		}
	case "frame":
		switch m.Opcode {
		case opFrameCopy:
			b := f.buffers[r.Uint()]
			if f.failCopy {
				f.emit(m.Object, evFrameFailed, nil)
				return
			}
			for y := 0; y < b.h; y++ {
				for x := 0; x < b.w; x++ {
					copy(b.mem[b.offset+y*b.stride+4*x:], f.pixel[:])
				}
			}
			var flags uint32
			if f.yInvert {
				flags = 1
			}
			f.emit(m.Object, evFrameFlags, new(wl.Builder).Uint(flags))
			f.emit(m.Object, evFrameReady, new(wl.Builder).Uint(0).Uint(0).Uint(0))
		case opFrameDestroy:
			f.logf("frame destroy")
		}
	case IfVPointerMgr:
		if m.Opcode == opVPMgrCreateWithOutput {
			_, out, id := r.Uint(), r.Uint(), r.Uint()
			f.objects[id] = "pointer"
			f.logf("pointer on %s", f.outputs[f.outputIndex(out)].name)
		}
	case "pointer":
		switch m.Opcode {
		case opVPMotionAbsolute:
			_, x, y, xe, ye := r.Uint(), r.Uint(), r.Uint(), r.Uint(), r.Uint()
			f.logf("abs %d %d %d %d", x, y, xe, ye)
		case opVPButton:
			_, b, s := r.Uint(), r.Uint(), r.Uint()
			f.logf("button %#x %d", b, s)
		case opVPFrame:
			f.logf("frame")
		case opVPAxisSource:
			f.logf("axis-source %d", r.Uint())
		case opVPAxisDiscrete:
			_, axis, value, disc := r.Uint(), r.Uint(), int32(r.Uint()), int32(r.Uint())
			f.logf("discrete %d %d %d", axis, value/256, disc)
		case opVPDestroy:
			f.logf("pointer destroy")
		}
	case IfVKeyboardMgr:
		if m.Opcode == opVKMgrCreate {
			_, id := r.Uint(), r.Uint()
			f.objects[id] = "keyboard"
			f.logf("keyboard")
		}
	case "keyboard":
		switch m.Opcode {
		case opVKKeymap:
			format, size := r.Uint(), int(r.Uint())
			if format != keymapFormatXKBv1 || len(fds) != 1 {
				f.t.Errorf("keymap format %d fds %v", format, fds)
				return
			}
			f.keymaps = append(f.keymaps, strings.TrimRight(string(f.fdMem[fds[0]][:size]), "\x00"))
			f.logf("keymap")
		case opVKKey:
			_, key, state := r.Uint(), r.Uint(), r.Uint()
			f.logf("key %d %d", key, state)
		case opVKModifiers:
			f.logf("mods %d", r.Uint())
		}
	case IfIdleNotifier:
		if m.Opcode == opIdleGetNotification {
			id, timeout := r.Uint(), r.Uint()
			f.objects[id] = "idle"
			f.idleNotes = append(f.idleNotes, id)
			f.logf("idle %dms", timeout)
		}
	case "idle":
		f.logf("idle destroy")
	}
}
