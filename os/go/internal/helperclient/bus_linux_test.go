//go:build linux

package helperclient

import (
	"bufio"
	"context"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helper"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

// Linux-only: runs a private dbus-daemon (session config, so no root and no
// polkit), exports the real helper.Object on one connection and calls it
// through the real Client on another. Proves the wire signature, the
// Sender plumbing and the error-name mapping end to end.

// recordingAuth is called on a godbus goroutine; the reply travels over a
// socket the race detector cannot see through, so it needs its own lock.
type recordingAuth struct {
	mu      sync.Mutex
	senders []string
}

func (a *recordingAuth) Authorize(_ context.Context, sender, _ string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.senders = append(a.senders, sender)
	return nil
}

func (a *recordingAuth) seen() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.senders...)
}

func privateBus(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("dbus-daemon"); err != nil {
		t.Skip("dbus-daemon not installed")
	}
	cmd := exec.Command("dbus-daemon", "--session", "--nofork", "--print-address=1")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	addr, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(addr)
}

func connect(t *testing.T, addr string) *dbus.Conn {
	t.Helper()
	c, err := dbus.Connect(addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestHelperOverARealBus(t *testing.T) {
	addr := privateBus(t)
	run := (&execx.Fake{}).
		On(execx.OK("Package: hello\nVersion: 2.10-3\n"), "apt-cache", "show", "--no-all-versions", "--", "hello").
		On(execx.Result{ExitCode: 0, Stderr: []byte("done\n")}, "apt-get", "install", "-y", "--no-install-recommends", "--", "hello")
	auth := &recordingAuth{}
	svc := &helper.Service{Run: run, Auth: auth, Now: time.Now, ListsAge: func() (time.Duration, error) { return 0, nil }}
	if err := helper.Export(connect(t, addr), &helper.Object{Svc: svc}); err != nil {
		t.Fatal(err)
	}
	clientConn := connect(t, addr)
	client := NewWithConn(clientConn)

	out, err := client.AptInstall(context.Background(), []string{"hello"})
	if err != nil || !out.OK || out.StderrTail != "done\n" {
		t.Fatalf("AptInstall = %+v, %v", out, err)
	}
	if got := auth.seen(); len(got) != 1 || got[0] != clientConn.Names()[0] {
		t.Fatalf("sender = %v, want %s", got, clientConn.Names()[0])
	}

	_, err = client.RestartUnit(context.Background(), "NetworkManager; reboot")
	var he *helperapi.Error
	if !errors.As(err, &he) || he.Code() != "invalid" {
		t.Fatalf("hostile unit: %v", err)
	}
	_, err = client.RestartUnit(context.Background(), "sshd")
	if !errors.As(err, &he) || he.Code() != "not_allowed" {
		t.Fatalf("off-allowlist unit: %v", err)
	}
}
