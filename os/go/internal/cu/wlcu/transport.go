package wlcu

import (
	"bufio"
	"errors"
	"net"
	"syscall"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

// Transport carries Wayland messages. WriteMessage sends fds as
// SCM_RIGHTS with the message's first byte (wl_shm pools and XKB keymaps
// travel this way). jarvis-cu never needs fds from the compositor.
type Transport interface {
	ReadMessage() (wl.Message, error)
	WriteMessage(m wl.Message, fds []int) error
	Close() error
}

type unixTransport struct {
	c       *net.UnixConn
	r       *bufio.Reader
	timeout time.Duration
}

// DialUnix connects to the compositor socket.
func DialUnix(path string, timeout time.Duration) (Transport, error) {
	conn, err := net.DialTimeout("unix", path, timeout)
	if err != nil {
		return nil, err
	}
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		conn.Close()
		return nil, errors.New("wlcu: not a unix socket")
	}
	return &unixTransport{c: uc, r: bufio.NewReaderSize(uc, 64<<10), timeout: timeout}, nil
}

func (t *unixTransport) ReadMessage() (wl.Message, error) { return wl.ReadMessage(t.r) }

func (t *unixTransport) WriteMessage(m wl.Message, fds []int) error {
	b, err := m.Encode()
	if err != nil {
		return err
	}
	if err := t.c.SetWriteDeadline(time.Now().Add(t.timeout)); err != nil {
		return err
	}
	var oob []byte
	if len(fds) > 0 {
		oob = syscall.UnixRights(fds...)
	}
	for len(b) > 0 {
		n, _, err := t.c.WriteMsgUnix(b, oob, nil)
		if err != nil {
			return err
		}
		b, oob = b[n:], nil
	}
	return nil
}

func (t *unixTransport) Close() error { return t.c.Close() }
