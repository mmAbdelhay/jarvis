package helper

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/godbus/dbus/v5"

	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

// fakeBus answers by method name with bodies shaped exactly as godbus
// decodes them off the wire (structs arrive as []any).
type fakeBus struct {
	replies map[string][]any
	errs    map[string]error
	calls   []string
	args    map[string][]any
}

func (f *fakeBus) Call(_ context.Context, dest string, path dbus.ObjectPath, method string, args ...any) ([]any, error) {
	f.calls = append(f.calls, method)
	if f.args == nil {
		f.args = map[string][]any{}
	}
	f.args[method] = args
	if err := f.errs[method]; err != nil {
		return nil, err
	}
	return f.replies[method], nil
}

// userBus answers for uid 1000 and has NO logind replies at all: the
// caller (a child of jarvisd's user unit) may be outside any session, and
// the check must not depend on one (contracts §6.19).
func userBus(authorized bool) *fakeBus {
	return &fakeBus{replies: map[string][]any{
		"org.freedesktop.DBus.GetConnectionUnixUser":              {uint32(1000)},
		"org.freedesktop.PolicyKit1.Authority.CheckAuthorization": {[]any{authorized, false, map[string]string{}}},
	}}
}

// A jarvis-admins member without a session: polkit (via Plan D's rule)
// says yes, so the helper must too.
func TestAuthorizeSessionlessUserAuthorizedByPolkit(t *testing.T) {
	bus := userBus(true)
	if err := (SystemAuthorizer{Bus: bus}).Authorize(context.Background(), ":1.42", helperapi.ActionPackages); err != nil {
		t.Fatal(err)
	}
	args := bus.args["org.freedesktop.PolicyKit1.Authority.CheckAuthorization"]
	subj := args[0].(polkitSubject)
	for _, m := range bus.calls {
		if strings.Contains(m, "login1") {
			t.Fatalf("authorization consulted logind (%s); callers may have no session", m)
		}
	}
	if subj.Kind != "system-bus-name" || subj.Details["name"].Value() != ":1.42" || args[1] != helperapi.ActionPackages || args[3] != uint32(0) {
		t.Fatalf("polkit args = %#v", args)
	}
}

func TestAuthorizeDenials(t *testing.T) {
	cases := map[string]func(*fakeBus){
		"polkit says no": func(b *fakeBus) {
			b.replies["org.freedesktop.PolicyKit1.Authority.CheckAuthorization"] = []any{[]any{false, false, map[string]string{}}}
		},
		"root caller":    func(b *fakeBus) { b.replies["org.freedesktop.DBus.GetConnectionUnixUser"] = []any{uint32(0)} },
		"system account": func(b *fakeBus) { b.replies["org.freedesktop.DBus.GetConnectionUnixUser"] = []any{uint32(108)} },
		"nobody":         func(b *fakeBus) { b.replies["org.freedesktop.DBus.GetConnectionUnixUser"] = []any{uint32(65534)} },
		"caller unknown": func(b *fakeBus) {
			b.errs = map[string]error{"org.freedesktop.DBus.GetConnectionUnixUser": errors.New("NameHasNoOwner")}
		},
		"polkit unreachable": func(b *fakeBus) {
			b.errs = map[string]error{"org.freedesktop.PolicyKit1.Authority.CheckAuthorization": errors.New("ServiceUnknown")}
		},
		"malformed uid reply": func(b *fakeBus) { b.replies["org.freedesktop.DBus.GetConnectionUnixUser"] = []any{"1000"} },
	}
	for name, mutate := range cases {
		bus := userBus(true)
		mutate(bus)
		err := (SystemAuthorizer{Bus: bus}).Authorize(context.Background(), ":1.42", helperapi.ActionServices)
		if !errors.Is(err, ErrDenied) {
			t.Errorf("%s: err = %v, want ErrDenied", name, err)
		}
	}
}

func TestAdminActionAllowsInteraction(t *testing.T) {
	bus := userBus(true)
	(SystemAuthorizer{Bus: bus}).Authorize(context.Background(), ":1.42", helperapi.ActionAdmin)
	if got := bus.args["org.freedesktop.PolicyKit1.Authority.CheckAuthorization"][3]; got != uint32(1) {
		t.Fatalf("flags = %v, want 1 (AllowUserInteraction)", got)
	}
}
