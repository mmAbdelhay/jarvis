// Package server is jarvis-cu's control socket (Rafiq v1.1 contracts §1):
// $XDG_RUNTIME_DIR/jarvis/cu.sock, mode 0600, newline-delimited JSON,
// one client (jarvisd, checked by SO_PEERCRED + /proc) at a time.
package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
)

// MaxLine bounds one request (type text ≤ 2000 runes fits easily).
const MaxLine = 64 << 10

const writeTimeout = 2 * time.Second

// Handler runs ops (session.Manager).
type Handler interface {
	Handle(op string, line []byte) (any, error)
	Disconnected()
}

// Listen prepares the socket.
func Listen(path string) (*net.UnixListener, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	st, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != os.Getuid() {
		return nil, fmt.Errorf("%s belongs to another user", dir)
	}
	if st.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return nil, err
		}
	}
	if st, err := os.Lstat(path); err == nil {
		if st.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	old := syscall.Umask(0o177)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	syscall.Umask(old)
	if err != nil {
		return nil, err
	}
	ln.SetUnlinkOnClose(true)
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

type conn struct {
	c  *net.UnixConn
	mu sync.Mutex
}

func (c *conn) write(b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.c.SetWriteDeadline(time.Now().Add(writeTimeout))
	c.c.Write(b)
}

// Server serves one client at a time.
type Server struct {
	ln    *net.UnixListener
	check PeerCheck
	h     Handler
	log   *log.Logger
	mu    sync.Mutex
	cur   *conn
}

// New makes a server on a listener from Listen.
func New(ln *net.UnixListener, check PeerCheck, h Handler, logger *log.Logger) *Server {
	return &Server{ln: ln, check: check, h: h, log: logger}
}

// Close stops accepting.
func (s *Server) Close() error { return s.ln.Close() }

// Serve accepts connections until the listener closes.
func (s *Server) Serve() error {
	for {
		c, err := s.ln.AcceptUnix()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go s.serveConn(c)
	}
}

// Push sends an event to the current client, if any.
func (s *Server) Push(ev proto.Event) {
	s.mu.Lock()
	cc := s.cur
	s.mu.Unlock()
	if cc == nil {
		return
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	cc.write(append(b, '\n'))
}

func outcome(err error) string {
	if err == nil {
		return "ok"
	}
	return proto.AsError(err).Code
}

func (s *Server) serveConn(c *net.UnixConn) {
	defer c.Close()
	if err := s.check(c); err != nil {
		s.log.Printf("refused a connection: %v", err)
		return
	}
	cc := &conn{c: c}
	s.mu.Lock()
	if s.cur != nil {
		s.mu.Unlock()
		cc.write(proto.Response(nil, nil, proto.Errorf(proto.CodeFailed, "jarvis-cu already has a client")))
		return
	}
	s.cur = cc
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.cur = nil
		s.mu.Unlock()
		s.h.Disconnected()
	}()
	sc := bufio.NewScanner(c)
	sc.Buffer(make([]byte, 0, 4096), MaxLine)
	for sc.Scan() {
		line := sc.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var env proto.Envelope
		if err := json.Unmarshal(line, &env); err != nil {
			cc.write(proto.Response(nil, nil, proto.Errorf(proto.CodeFailed, "bad request: not a JSON object")))
			continue
		}
		if len(env.ID) == 0 || string(env.ID) == "null" || env.Op == "" {
			cc.write(proto.Response(env.ID, nil, proto.Errorf(proto.CodeFailed, "every request needs an id and an op")))
			continue
		}
		data, err := s.h.Handle(env.Op, line)
		s.log.Printf("op %s: %s", sanitizeOp(env.Op), outcome(err))
		cc.write(proto.Response(env.ID, data, err))
	}
	if errors.Is(sc.Err(), bufio.ErrTooLong) {
		cc.write(proto.Response(nil, nil, proto.Errorf(proto.CodeFailed, "request longer than %d bytes", MaxLine)))
	}
}

// sanitizeOp keeps the journal clean of whatever a client sends as op.
func sanitizeOp(op string) string {
	if len(op) > 16 {
		op = op[:16]
	}
	b := []byte(op)
	for i, ch := range b {
		if !(ch >= 'a' && ch <= 'z' || ch == '-') {
			b[i] = '?'
		}
	}
	return string(b)
}
