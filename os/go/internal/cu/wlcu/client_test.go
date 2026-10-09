package wlcu

import (
	"bytes"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

func TestBindsOutputsFirstThenEverything(t *testing.T) {
	f := newFake()
	if _, err := startFake(t, f, nil); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"bind wl_output v4",
		"bind wl_seat v1",
		"bind wl_shm v1",
		"bind zwlr_foreign_toplevel_manager_v1 v3",
		"bind zwlr_screencopy_manager_v1 v3",
		"bind zwlr_virtual_pointer_manager_v1 v2",
		"bind zwp_virtual_keyboard_manager_v1 v1",
		"bind ext_idle_notifier_v1 v1",
	}
	if got := f.logged(); !reflect.DeepEqual(got, want) {
		t.Fatalf("binds:\n got %v\nwant %v", got, want)
	}
}

func TestUnsupportedNamesWhatIsMissing(t *testing.T) {
	f := newFake()
	var gs []fakeGlobal
	for _, g := range f.globals {
		switch g.iface {
		case IfVPointerMgr:
			continue
		case IfToplevelMgr:
			g.version = 1 // no set_fullscreen
		}
		gs = append(gs, g)
	}
	f.globals = gs
	_, err := startFake(t, f, nil)
	var ue *UnsupportedError
	if !errors.As(err, &ue) {
		t.Fatalf("want UnsupportedError, got %v", err)
	}
	joined := strings.Join(ue.Missing, ",")
	if !strings.Contains(joined, IfVPointerMgr) || !strings.Contains(joined, IfToplevelMgr+" v2") {
		t.Fatalf("missing = %v", ue.Missing)
	}
}

func TestToplevelsAndOutputs(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	outs, err := c.Outputs()
	if err != nil || len(outs) != 1 || outs[0] != (Output{Name: "HEADLESS-1", Width: 8, Height: 4}) {
		t.Fatalf("outputs %+v %v", outs, err)
	}
	tops, err := c.Toplevels()
	if err != nil {
		t.Fatal(err)
	}
	if len(tops) != 2 || tops[0].ID != "w1" || tops[0].AppID != "gimp" || !tops[0].Focused ||
		!reflect.DeepEqual(tops[0].Outputs, []string{"HEADLESS-1"}) || tops[1].AppID != "foot" || tops[1].Focused {
		t.Fatalf("toplevels %+v", tops)
	}
}

func TestOutputNameFallbackBeforeV4(t *testing.T) {
	f := newFake()
	f.outputVersion = 3
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	outs, _ := c.Outputs()
	if len(outs) != 1 || outs[0].Name != "output-1" {
		t.Fatalf("%+v", outs)
	}
}

func TestActivateAndFullscreen(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Activate("w2"); err != nil {
		t.Fatal(err)
	}
	if err := c.SetFullscreen("w1", true); err != nil {
		t.Fatal(err)
	}
	tops, _ := c.Toplevels()
	if tops[0].Focused || !tops[1].Focused || !tops[0].Fullscreen {
		t.Fatalf("%+v", tops)
	}
	if err := c.SetFullscreen("w1", false); err != nil {
		t.Fatal(err)
	}
	tops, _ = c.Toplevels()
	if tops[0].Fullscreen {
		t.Fatal("still fullscreen")
	}
	if err := c.Activate("w9"); !errors.Is(err, ErrNoWindow) {
		t.Fatalf("unknown window: %v", err)
	}
	if f.count("fullscreen gimp") != 1 || f.count("unfullscreen gimp") != 1 || f.count("activate foot") != 1 {
		t.Fatalf("log %v", f.logged())
	}
}

func TestOnChangeFiresForNewAndClosedWindows(t *testing.T) {
	f := newFake()
	changed := make(chan struct{}, 64)
	c, err := startFake(t, f, func() { changed <- struct{}{} })
	if err != nil {
		t.Fatal(err)
	}
	for len(changed) > 0 {
		<-changed
	}
	f.open(fakeWindow{appID: "zenity", title: "Question", states: []uint32{stateActivated}})
	select {
	case <-changed:
	case <-time.After(time.Second):
		t.Fatal("no change for a new window")
	}
	f.closeWindow(0)
	tops, _ := c.Toplevels()
	if len(tops) != 2 || tops[0].AppID != "foot" || tops[1].AppID != "zenity" || !tops[1].Focused {
		t.Fatalf("%+v", tops)
	}
	if f.count("destroy handle") != 1 {
		t.Fatal("a closed handle must be destroyed on the next round trip")
	}
}

func TestProtocolErrorKillsTheClient(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.emit(displayID, evDisplayError, new(wl.Builder).Uint(5).Uint(1).String("bad things"))
	select {
	case <-c.Dead():
	case <-time.After(time.Second):
		t.Fatal("client still alive")
	}
	if !strings.Contains(c.Err().Error(), "bad things") {
		t.Fatal(c.Err())
	}
	if _, err := c.Toplevels(); err == nil {
		t.Fatal("dead client answered")
	}
}

func TestRoundtripTimeout(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.noSync = true
	f.mu.Unlock()
	if _, err := c.Toplevels(); !errors.Is(err, ErrTimeout) {
		t.Fatalf("want timeout, got %v", err)
	}
}

func TestShmCloseZeroesBeforeFreeAndIsIdempotent(t *testing.T) {
	mem := []byte{1, 2, 3}
	frees := 0
	s := &Shm{FD: -1, Mem: mem, free: func() {
		frees++
		for _, b := range mem {
			if b != 0 {
				t.Error("memory not cleared before free")
			}
		}
	}}
	s.Close()
	s.Close()
	if frees != 1 {
		t.Fatalf("freed %d times", frees)
	}
	if s.Mem != nil || s.FD != -1 {
		t.Fatalf("closed shm retains resources: %+v", s)
	}
}

func TestUnixTransportPassesFDAndReadsMessages(t *testing.T) {
	dir, err := os.MkdirTemp("", "wl-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "s")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if errors.Is(err, syscall.EPERM) {
		t.Skip("CI-only, not run: sandbox forbids Unix socket binding")
	}
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	transport, err := DialUnix(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	peer, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	if err := peer.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	want := wl.Message{Object: 12, Opcode: 3, Args: []byte{42, 0, 0, 0}}
	if err := transport.WriteMessage(want, []int{int(file.Fd())}); err != nil {
		t.Fatal(err)
	}
	data, oob := make([]byte, 64), make([]byte, syscall.CmsgSpace(4))
	n, oobn, _, _, err := peer.ReadMsgUnix(data, oob)
	if err != nil {
		t.Fatal(err)
	}
	encoded := []byte{12, 0, 0, 0, 3, 0, 12, 0, 42, 0, 0, 0}
	if !bytes.Equal(data[:n], encoded) {
		t.Fatalf("wire: %x", data[:n])
	}
	controls, err := syscall.ParseSocketControlMessage(oob[:oobn])
	if err != nil {
		t.Fatal(err)
	}
	var fds []int
	defer func() {
		for _, fd := range fds {
			syscall.Close(fd)
		}
	}()
	for _, control := range controls {
		received, err := syscall.ParseUnixRights(&control)
		if err != nil {
			t.Fatal(err)
		}
		fds = append(fds, received...)
	}
	if len(fds) != 1 {
		t.Fatalf("received fds: %v", fds)
	}
	if _, err := peer.Write(encoded); err != nil {
		t.Fatal(err)
	}
	got, err := transport.ReadMessage()
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("read: %+v %v", got, err)
	}
}

func TestDefaultAllocator(t *testing.T) {
	s, err := DefaultAllocator().Alloc(4096)
	if runtime.GOOS != "linux" {
		if err == nil {
			s.Close()
			t.Fatal("shared memory should require Linux")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Mem) != 4096 || s.FD < 0 {
		t.Fatalf("bad allocation: %+v", s)
	}
	s.Mem[0] = 42
	s.Close()
	s.Close()
}
