package helper

import (
	"errors"
	"reflect"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

// The adapter's error mapping, tested without a bus.
func TestReplyMapping(t *testing.T) {
	ok, code, tail, derr := reply(helperapi.Outcome{OK: false, ExitCode: 100, StderrTail: "E: x"}, nil)
	if ok || code != 100 || tail != "E: x" || derr != nil {
		t.Fatalf("outcome mapping: %v %v %q %v", ok, code, tail, derr)
	}
	_, _, _, derr = reply(helperapi.Outcome{}, &helperapi.Error{Name: helperapi.ErrNotAllowed, Message: "sshd is not on the restart allowlist"})
	if derr == nil || derr.Name != helperapi.ErrNotAllowed || derr.Body[0] != "sshd is not on the restart allowlist" {
		t.Fatalf("typed error mapping: %+v", derr)
	}
	_, _, _, derr = reply(helperapi.Outcome{}, errors.New("boom"))
	if derr == nil || derr.Name != "org.freedesktop.DBus.Error.Failed" {
		t.Fatalf("untyped error mapping: %+v", derr)
	}
}

// godbus exports every exported method of Object: guard that it is exactly
// the contract methods (M1 §2 plus M2 §2), so a helper method added for convenience can
// never become a root D-Bus entry point by accident.
func TestObjectExportsExactlyTheContractMethods(t *testing.T) {
	want := map[string]bool{"AptInstall": true, "AptRemove": true, "FlatpakInstall": true, "FlatpakRemove": true, "RestartUnit": true,
		"AptUpgrade": true, "FlatpakUpdate": true}
	typ := reflect.TypeOf(&Object{})
	var got []string
	for i := 0; i < typ.NumMethod(); i++ {
		got = append(got, typ.Method(i).Name)
	}
	if len(got) != len(want) {
		t.Fatalf("exported methods = %v", got)
	}
	for _, m := range got {
		if !want[m] {
			t.Errorf("unexpected exported method %s", m)
		}
	}
}
