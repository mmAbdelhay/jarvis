// Package helperclient is the D-Bus client jarvis-pkg and jarvis-diag use to
// reach jarvis-helper. It implements helperapi.Helper.
package helperclient

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

// Per-call ceilings. They sit just above the helper's own command timeouts
// so the helper, not the client, reports a hung apt-get.
const (
	packageCallTimeout = 35 * time.Minute
	restartCallTimeout = 2 * time.Minute
)

// Client connects to the system bus lazily, on the first call, so a server
// that is only asked tools/list never needs a bus (and runs on macOS).
type Client struct {
	connect func() (*dbus.Conn, error)
	mu      sync.Mutex
	conn    *dbus.Conn
}

// New returns a Client for the system bus.
func New() *Client {
	return &Client{connect: func() (*dbus.Conn, error) { return dbus.ConnectSystemBus() }}
}

// NewWithConn returns a Client on an existing connection (tests).
func NewWithConn(c *dbus.Conn) *Client {
	return &Client{connect: func() (*dbus.Conn, error) { return c, nil }}
}

func (c *Client) bus() (*dbus.Conn, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != nil && c.conn.Connected() {
		return c.conn, nil
	}
	conn, err := c.connect()
	if err != nil {
		return nil, err
	}
	c.conn = conn
	return conn, nil
}

func (c *Client) call(ctx context.Context, timeout time.Duration, method string, arg any) (helperapi.Outcome, error) {
	conn, err := c.bus()
	if err != nil {
		return helperapi.Outcome{}, &helperapi.Error{Message: "cannot reach the system bus: " + err.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// AllowInteractiveAuthorization lets polkit show its password dialog for
	// a future auth_admin action instead of failing outright.
	call := conn.Object(helperapi.BusName, helperapi.ObjectPath).
		CallWithContext(ctx, helperapi.Interface+"."+method, dbus.FlagAllowInteractiveAuthorization, arg)
	if call.Err != nil {
		return helperapi.Outcome{}, fromDBus(call.Err)
	}
	var out helperapi.Outcome
	if err := call.Store(&out.OK, &out.ExitCode, &out.StderrTail); err != nil {
		return helperapi.Outcome{}, &helperapi.Error{Message: "malformed helper reply: " + err.Error()}
	}
	return out, nil
}

func fromDBus(err error) *helperapi.Error {
	var de dbus.Error
	if errors.As(err, &de) {
		return &helperapi.Error{Name: de.Name, Message: bodyText(de.Body, de.Name)}
	}
	var dep *dbus.Error
	if errors.As(err, &dep) {
		return &helperapi.Error{Name: dep.Name, Message: bodyText(dep.Body, dep.Name)}
	}
	return &helperapi.Error{Message: err.Error()}
}

func bodyText(body []any, fallback string) string {
	if len(body) > 0 {
		if s, ok := body[0].(string); ok {
			return s
		}
	}
	return fallback
}

func (c *Client) AptInstall(ctx context.Context, names []string) (helperapi.Outcome, error) {
	return c.call(ctx, packageCallTimeout, "AptInstall", names)
}

func (c *Client) AptRemove(ctx context.Context, names []string) (helperapi.Outcome, error) {
	return c.call(ctx, packageCallTimeout, "AptRemove", names)
}

func (c *Client) FlatpakInstall(ctx context.Context, refs []string) (helperapi.Outcome, error) {
	return c.call(ctx, packageCallTimeout, "FlatpakInstall", refs)
}

func (c *Client) FlatpakRemove(ctx context.Context, refs []string) (helperapi.Outcome, error) {
	return c.call(ctx, packageCallTimeout, "FlatpakRemove", refs)
}

func (c *Client) RestartUnit(ctx context.Context, name string) (helperapi.Outcome, error) {
	return c.call(ctx, restartCallTimeout, "RestartUnit", name)
}

var _ helperapi.Helper = (*Client)(nil)
