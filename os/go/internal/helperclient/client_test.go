package helperclient

import (
	"errors"
	"testing"

	"github.com/godbus/dbus/v5"

	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

func TestFromDBusMapsErrorNamesToCodes(t *testing.T) {
	err := fromDBus(dbus.Error{Name: helperapi.ErrNotAllowed, Body: []any{"sshd is not on the restart allowlist"}})
	if err.Code() != "not_allowed" || err.Message != "sshd is not on the restart allowlist" {
		t.Fatalf("got %+v", err)
	}
	if e := fromDBus(dbus.Error{Name: "org.freedesktop.DBus.Error.ServiceUnknown"}); e.Code() != "failed" || e.Message == "" {
		t.Fatalf("service unknown: %+v", e)
	}
	if e := fromDBus(errors.New("connection closed")); e.Code() != "failed" || e.Message != "connection closed" {
		t.Fatalf("plain error: %+v", e)
	}
}

func TestUnreachableBusIsAFailedHelperError(t *testing.T) {
	c := &Client{connect: func() (*dbus.Conn, error) { return nil, errors.New("no such file") }}
	_, err := c.RestartUnit(t.Context(), "NetworkManager")
	var he *helperapi.Error
	if !errors.As(err, &he) || he.Code() != "failed" {
		t.Fatalf("err = %v", err)
	}
}
