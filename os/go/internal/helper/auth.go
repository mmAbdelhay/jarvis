package helper

import (
	"context"
	"fmt"

	"github.com/godbus/dbus/v5"

	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

// BusCaller makes one D-Bus method call and returns the reply body. It is
// the seam that lets SystemAuthorizer be tested without a bus.
type BusCaller interface {
	Call(ctx context.Context, dest string, path dbus.ObjectPath, method string, args ...any) ([]any, error)
}

// ConnCaller is the real BusCaller.
type ConnCaller struct{ Conn *dbus.Conn }

// Call implements BusCaller.
func (c ConnCaller) Call(ctx context.Context, dest string, path dbus.ObjectPath, method string, args ...any) ([]any, error) {
	call := c.Conn.Object(dest, path).CallWithContext(ctx, method, 0, args...)
	return call.Body, call.Err
}

// SystemAuthorizer allows a caller when (1) its UID, from the bus daemon,
// is a regular user's (≥ MinUID; root and system accounts have no reason
// to come through Jarvis) and (2) polkit authorizes the action for that
// bus name. It does not require a logind session: jarvisd runs as a systemd
// user unit, so its children are outside any session scope (contracts §6.19).
// polkit decides with allow_active for a session process and with Plan D's
// rule (/usr/share/polkit-1/rules.d/50-jarvis.rules: group jarvis-admins)
// otherwise. Any error denies: it fails closed.
type SystemAuthorizer struct {
	Bus    BusCaller
	MinUID uint32 // 0 means DefaultMinUID
}

// DefaultMinUID is Debian's first regular user ID.
const DefaultMinUID = 1000

type polkitSubject struct {
	Kind    string
	Details map[string]dbus.Variant
}

type polkitResult struct {
	IsAuthorized bool
	IsChallenge  bool
	Details      map[string]string
}

// Authorize implements Authorizer.
func (a SystemAuthorizer) Authorize(ctx context.Context, sender, action string) error {
	body, err := a.Bus.Call(ctx, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.GetConnectionUnixUser", sender)
	var uid uint32
	if err != nil || dbus.Store(body, &uid) != nil {
		return fmt.Errorf("%w: cannot identify caller %s", ErrDenied, sender)
	}

	min := a.MinUID
	if min == 0 {
		min = DefaultMinUID
	}
	if uid < min || uid == 65534 { // 65534: nobody
		return fmt.Errorf("%w: uid %d is not a regular user", ErrDenied, uid)
	}

	var flags uint32 // 0: never prompt for allow_active=yes actions
	if action == helperapi.ActionAdmin {
		flags = 1 // AllowUserInteraction: show the polkit password dialog
	}
	subject := polkitSubject{Kind: "system-bus-name", Details: map[string]dbus.Variant{"name": dbus.MakeVariant(sender)}}
	body, err = a.Bus.Call(ctx, "org.freedesktop.PolicyKit1", "/org/freedesktop/PolicyKit1/Authority",
		"org.freedesktop.PolicyKit1.Authority.CheckAuthorization", subject, action, map[string]string{}, flags, "")
	var res polkitResult
	if err != nil || dbus.Store(body, &res) != nil {
		return fmt.Errorf("%w: polkit check failed", ErrDenied)
	}
	if !res.IsAuthorized {
		return fmt.Errorf("%w: polkit refused %s", ErrDenied, action)
	}
	return nil
}
