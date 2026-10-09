package server

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
)

type echo struct {
	mu   sync.Mutex
	ops  []string
	gone chan struct{}
}

func (e *echo) Handle(op string, line []byte) (any, error) {
	e.mu.Lock()
	e.ops = append(e.ops, op)
	e.mu.Unlock()
	switch op {
	case "windows":
		return []proto.Window{{WindowID: "w1", AppID: "gimp"}}, nil
	case "click":
		return nil, proto.Errorf(proto.CodeOutside, "nope")
	}
	return nil, nil
}

func (e *echo) Disconnected() { close(e.gone) }

func sockPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "cu") // short: macOS caps unix socket paths at 104 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "jarvis", "cu.sock")
}

func start(t *testing.T, check PeerCheck) (*Server, *echo, string, func() string) {
	t.Helper()
	path := sockPath(t)
	ln, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	h := &echo{gone: make(chan struct{})}
	var logs strings.Builder
	var lmu sync.Mutex
	logger := log.New(writerFunc(func(p []byte) (int, error) { lmu.Lock(); defer lmu.Unlock(); return logs.Write(p) }), "", 0)
	s := New(ln, check, h, logger)
	go s.Serve()
	t.Cleanup(func() { s.Close() })
	return s, h, path, func() string { lmu.Lock(); defer lmu.Unlock(); return logs.String() }
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

func allow(*net.UnixConn) error { return nil }

func dial(t *testing.T, path string) (net.Conn, *bufio.Reader) {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(5 * time.Second))
	return c, bufio.NewReader(c)
}

func readJSON(t *testing.T, r *bufio.Reader) map[string]any {
	t.Helper()
	line, err := r.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		t.Fatalf("%s: %v", line, err)
	}
	return m
}

func TestSocketPermissions(t *testing.T) {
	_, _, path, _ := start(t, allow)
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 || st.Mode()&os.ModeSocket == 0 {
		t.Fatalf("socket mode %v %v", st.Mode(), err)
	}
	dst, _ := os.Stat(filepath.Dir(path))
	if dst.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %v", dst.Mode())
	}
}

func TestListenRefusesNonSocketAndTightensDir(t *testing.T) {
	path := sockPath(t)
	os.MkdirAll(filepath.Dir(path), 0o755)
	os.WriteFile(path, []byte("not a socket"), 0o600)
	if _, err := Listen(path); err == nil {
		t.Fatal("a regular file at the socket path was replaced")
	}
	os.Remove(path)
	ln, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if st, _ := os.Stat(filepath.Dir(path)); st.Mode().Perm() != 0o700 {
		t.Fatalf("dir not tightened: %v", st.Mode())
	}
}

func TestRequestsRepliesAndPush(t *testing.T) {
	s, h, path, logs := start(t, allow)
	c, r := dial(t, path)
	io.WriteString(c, `{"id":1,"op":"windows"}`+"\n")
	m := readJSON(t, r)
	if m["id"] != 1.0 || m["ok"] != true || m["data"].([]any)[0].(map[string]any)["appId"] != "gimp" {
		t.Fatalf("%v", m)
	}
	io.WriteString(c, `{"id":"x","op":"click","x":1,"y":2,"secret":"hunter2"}`+"\n")
	m = readJSON(t, r)
	if m["ok"] != false || m["error"].(map[string]any)["code"] != "outside" || m["id"] != "x" {
		t.Fatalf("%v", m)
	}
	io.WriteString(c, "not json\n")
	if m = readJSON(t, r); m["ok"] != false || m["id"] != nil {
		t.Fatalf("%v", m)
	}
	io.WriteString(c, `{"op":"windows"}`+"\n")
	if m = readJSON(t, r); m["ok"] != false {
		t.Fatalf("missing id accepted: %v", m)
	}
	io.WriteString(c, "\n")
	s.Push(proto.Event{Event: "paused", Reason: "physical-input"})
	if m = readJSON(t, r); m["event"] != "paused" || m["reason"] != "physical-input" {
		t.Fatalf("%v", m)
	}
	c.Close()
	select {
	case <-h.gone:
	case <-time.After(time.Second):
		t.Fatal("Disconnected not called")
	}
	if strings.Contains(logs(), "hunter2") || !strings.Contains(logs(), "op click: outside") {
		t.Fatalf("log: %q", logs())
	}
}

func TestSecondClientRefused(t *testing.T) {
	_, _, path, _ := start(t, allow)
	c1, r1 := dial(t, path)
	io.WriteString(c1, `{"id":1,"op":"windows"}`+"\n")
	readJSON(t, r1)
	_, r2 := dial(t, path)
	m := readJSON(t, r2)
	if m["ok"] != false {
		t.Fatalf("%v", m)
	}
	if _, err := r2.ReadByte(); err == nil {
		t.Fatal("second connection left open")
	}
}

func TestRefusedPeerGetsNothing(t *testing.T) {
	_, h, path, logs := start(t, func(*net.UnixConn) error { return errors.New("peer is /usr/bin/python3") })
	c, r := dial(t, path)
	io.WriteString(c, `{"id":1,"op":"begin"}`+"\n")
	if _, err := r.ReadByte(); err == nil {
		t.Fatal("refused peer got a reply")
	}
	if len(h.ops) != 0 {
		t.Fatal("refused peer reached the handler")
	}
	waitLog := time.Now().Add(time.Second)
	for !strings.Contains(logs(), "refused") && time.Now().Before(waitLog) {
		time.Sleep(time.Millisecond)
	}
	if !strings.Contains(logs(), "refused") {
		t.Fatal(logs())
	}
}

func TestTooLongLineClosesConnection(t *testing.T) {
	_, _, path, _ := start(t, allow)
	c, r := dial(t, path)
	go io.WriteString(c, `{"id":1,"op":"type","text":"`+strings.Repeat("a", MaxLine)+`"}`+"\n")
	m := readJSON(t, r)
	if m["ok"] != false {
		t.Fatalf("%v", m)
	}
	if _, err := r.ReadByte(); err == nil {
		t.Fatal("connection not closed")
	}
}
