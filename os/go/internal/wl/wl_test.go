package wl

import (
	"bytes"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestWireRoundTrip(t *testing.T) {
	args := new(Builder).Uint(7).String("wl_seat").Array([]byte{1, 2, 3, 4, 5}).String("").Bytes()
	data, err := Message{Object: 3, Opcode: 2, Args: args}.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if len(data)%4 != 0 || len(data) != 8+4+12+12+8 {
		t.Fatalf("length %d", len(data))
	}
	m, err := ReadMessage(bytes.NewReader(data))
	if err != nil || m.Object != 3 || m.Opcode != 2 {
		t.Fatalf("%+v %v", m, err)
	}
	r := NewReader(m.Args)
	if r.Uint() != 7 || r.String() != "wl_seat" || !bytes.Equal(r.Array(), []byte{1, 2, 3, 4, 5}) || r.String() != "" || r.Err() != nil {
		t.Fatal("decoded arguments differ")
	}
	short := NewReader([]byte{9, 0, 0, 0, 'a'})
	if s := short.String(); s != "" || short.Err() == nil {
		t.Fatal("a truncated string must fail")
	}
	if _, err := ReadMessage(bytes.NewReader([]byte{1, 0, 0, 0, 0, 0, 3, 0})); err == nil {
		t.Fatal("a size below 8 must fail")
	}
}

func baseFake() *fake {
	return &fake{
		globals: []string{"wl_compositor", SeatInterface, ManagerInterface},
		windows: []fakeWindow{
			{appID: "firefox", title: "Inbox — Mozilla Firefox", states: []uint32{stateActivated, stateMaximized}},
			{appID: "org.gnome.Nautilus", title: "Downloads", states: []uint32{stateMinimized}},
		},
	}
}

func TestListFocusClose(t *testing.T) {
	f := baseFake()
	c, err := startFake(t, f)
	if err != nil {
		t.Fatal(err)
	}
	ws, err := c.Windows()
	if err != nil {
		t.Fatal(err)
	}
	want := []Window{
		{ID: "w1", AppID: "firefox", Title: "Inbox — Mozilla Firefox", Focused: true, Maximized: true},
		{ID: "w2", AppID: "org.gnome.Nautilus", Title: "Downloads", Minimized: true},
	}
	if !reflect.DeepEqual(ws, want) {
		t.Fatalf("windows\n%+v\nwant\n%+v", ws, want)
	}
	if err := c.Activate("w2"); err != nil {
		t.Fatal(err)
	}
	ws, _ = c.Windows()
	if ws[0].Focused || !ws[1].Focused || ws[1].Minimized {
		t.Fatalf("after activate: %+v", ws)
	}
	if err := c.CloseWindow("w1"); err != nil {
		t.Fatal(err)
	}
	ws, _ = c.Windows()
	if len(ws) != 1 || ws[0].ID != "w2" {
		t.Fatalf("after close: %+v", ws)
	}
	if err := c.Activate("w1"); !errors.Is(err, ErrNoWindow) {
		t.Fatalf("closed window: %v", err)
	}
	log := strings.Join(f.Log(), "|")
	for _, want := range []string{"bind zwlr_foreign_toplevel_manager_v1 v3", "bind wl_seat v1", "activate org.gnome.Nautilus", "close firefox", "destroy"} {
		if !strings.Contains(log, want) {
			t.Errorf("compositor log lacks %q: %s", want, log)
		}
	}
}

func TestNoManagerIsUnsupported(t *testing.T) {
	f := baseFake()
	f.globals = []string{"wl_compositor", SeatInterface}
	if _, err := startFake(t, f); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("err %v", err)
	}
}

func TestNoSeatCannotFocus(t *testing.T) {
	f := baseFake()
	f.globals = []string{ManagerInterface}
	c, err := startFake(t, f)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Activate("w1"); !errors.Is(err, ErrNoSeat) {
		t.Fatalf("err %v", err)
	}
}

func TestSilentCompositorTimesOut(t *testing.T) {
	f := baseFake()
	f.noSync = true
	done := make(chan error, 1)
	go func() { _, err := startFake(t, f); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrTimeout) {
			t.Fatalf("err %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("NewClient hung")
	}
}

func TestProtocolErrorKillsTheClient(t *testing.T) {
	f := baseFake()
	c, err := startFake(t, f)
	if err != nil {
		t.Fatal(err)
	}
	c.send(Message{Object: 999, Opcode: 0})
	if _, err := c.Windows(); err == nil || !strings.Contains(err.Error(), "invalid object 999") {
		t.Fatalf("err %v", err)
	}
	if c.Alive() {
		t.Fatal("client must be dead after a protocol error")
	}
}

func TestSocketPath(t *testing.T) {
	dir := t.TempDir()
	env := map[string]string{"XDG_RUNTIME_DIR": "/run/user/1000", "WAYLAND_DISPLAY": "wayland-1"}
	get := func(k string) string { return env[k] }
	if p, _ := SocketPath(get, os.ReadDir); p != "/run/user/1000/wayland-1" {
		t.Fatalf("relative: %s", p)
	}
	env["WAYLAND_DISPLAY"] = "/tmp/w.sock"
	if p, _ := SocketPath(get, os.ReadDir); p != "/tmp/w.sock" {
		t.Fatalf("absolute: %s", p)
	}
	env["WAYLAND_DISPLAY"] = "../../etc/x"
	if _, err := SocketPath(get, os.ReadDir); err == nil {
		t.Fatal("odd WAYLAND_DISPLAY must fail")
	}
	delete(env, "WAYLAND_DISPLAY")
	env["XDG_RUNTIME_DIR"] = dir
	if _, err := SocketPath(get, os.ReadDir); err == nil {
		t.Fatal("no socket must fail")
	}
	fakeDir := func(string) ([]os.DirEntry, error) {
		return []os.DirEntry{sockEntry("wayland-10"), sockEntry("wayland-1.lock"), sockEntry("wayland-2")}, nil
	}
	if p, _ := SocketPath(get, fakeDir); p != filepath.Join(dir, "wayland-2") {
		t.Fatalf("scan: %s", p)
	}
}

type sockEntry string

func (s sockEntry) Name() string               { return string(s) }
func (s sockEntry) IsDir() bool                { return false }
func (s sockEntry) Type() os.FileMode          { return os.ModeSocket }
func (s sockEntry) Info() (os.FileInfo, error) { return nil, errors.New("no info") }

func TestDisplayPreservesAbsoluteSocket(t *testing.T) {
	get := func(k string) string {
		if k == "WAYLAND_DISPLAY" {
			return "/tmp/rafiq.sock"
		}
		return "/run/user/1000"
	}
	got, err := Display(get, os.ReadDir)
	if err != nil || got != "/tmp/rafiq.sock" {
		t.Fatalf("Display = %q, %v", got, err)
	}
}

func TestEncodeRejectsUnalignedArguments(t *testing.T) {
	if _, err := (Message{Object: 1, Args: []byte{1}}).Encode(); err == nil {
		t.Fatal("unaligned message accepted")
	}
}

func TestCloseImmediatelyMarksDead(t *testing.T) {
	c, err := startFake(t, baseFake())
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	if c.Alive() {
		t.Fatal("closed client is alive")
	}
}

func TestBlockedWriteTimesOut(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	done := make(chan error, 1)
	go func() { _, err := NewClient(client, 30*time.Millisecond); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrTimeout) {
			t.Fatalf("err %v", err)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("blocked write exceeded timeout")
	}
}

func TestSocketPathRejectsDotNames(t *testing.T) {
	for _, display := range []string{".", ".."} {
		get := func(k string) string {
			if k == "WAYLAND_DISPLAY" {
				return display
			}
			return "/run/user/1000"
		}
		if path, err := SocketPath(get, os.ReadDir); err == nil {
			t.Fatalf("accepted %q as %q", display, path)
		}
	}
}

func TestRoundtripTimeoutEndsConnection(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	c := &Client{conn: client, timeout: 30 * time.Millisecond, next: 2, objects: map[uint32]objKind{}, callbacks: map[uint32]chan struct{}{}, dead: make(chan struct{})}
	defer c.Close()
	go func() { _, _ = ReadMessage(server) }()
	if err := c.roundtrip(); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err %v", err)
	}
	if c.Alive() {
		t.Fatal("timed out client remains alive")
	}
}
