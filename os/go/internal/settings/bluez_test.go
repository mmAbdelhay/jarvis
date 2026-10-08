package settings

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

// fakeBluez is BlueZ's object tree plus a call log.
type fakeBluez struct {
	objs      Objects
	log       []string
	appear    Objects // added to objs on StartDiscovery's second poll
	polls     int
	pairError error
	down      bool
}

func (f *fakeBluez) ManagedObjects(context.Context) (Objects, error) {
	if f.down {
		return nil, dbus.Error{Name: "org.freedesktop.DBus.Error.ServiceUnknown"}
	}
	f.polls++
	if f.appear != nil && f.polls >= 3 {
		for k, v := range f.appear {
			f.objs[k] = v
		}
	}
	return f.objs, nil
}

func (f *fakeBluez) Call(_ context.Context, path dbus.ObjectPath, method string, args ...any) error {
	f.log = append(f.log, string(path)+" "+method)
	if strings.HasSuffix(method, ".Pair") {
		return f.pairError
	}
	return nil
}

func (f *fakeBluez) SetProperty(_ context.Context, path dbus.ObjectPath, iface, prop string, v any) error {
	f.log = append(f.log, string(path)+" set "+prop+"="+map[bool]string{true: "true", false: "false"}[v.(bool)])
	return nil
}

func device(addr, name string, paired bool) map[string]map[string]dbus.Variant {
	return map[string]map[string]dbus.Variant{deviceIface: {
		"Address": dbus.MakeVariant(addr), "Alias": dbus.MakeVariant(name),
		"Paired": dbus.MakeVariant(paired), "Connected": dbus.MakeVariant(false),
		"Adapter": dbus.MakeVariant(dbus.ObjectPath("/org/bluez/hci0")),
	}}
}

func newFake(powered bool) *fakeBluez {
	return &fakeBluez{objs: Objects{
		"/org/bluez/hci0":                       {adapterIface: {"Powered": dbus.MakeVariant(powered)}},
		"/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF": device("AA:BB:CC:DD:EE:FF", "WH-1000XM4", true),
		"/org/bluez/hci0/dev_11_22_33_44_55_66": device("11:22:33:44:55:66", "Keyboard K380", false),
	}}
}

func TestBluezReadAndPower(t *testing.T) {
	f := newFake(true)
	b := &Bluez{Bus: f}
	on, err := b.Powered(ctx)
	if err != nil || !on {
		t.Fatalf("powered %v %v", on, err)
	}
	devs, _ := b.Devices(ctx)
	want := []BTDevice{{Address: "AA:BB:CC:DD:EE:FF", Name: "WH-1000XM4", Paired: true}, {Address: "11:22:33:44:55:66", Name: "Keyboard K380"}}
	if !reflect.DeepEqual(devs, want) {
		t.Fatalf("devices %+v", devs)
	}
	if err := b.SetPowered(ctx, false); err != nil || f.log[0] != "/org/bluez/hci0 set Powered=false" {
		t.Fatalf("set powered %v %v", f.log, err)
	}
	none := &Bluez{Bus: &fakeBluez{objs: Objects{}}}
	if _, err := none.Powered(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("no adapter: %v", err)
	}
	if _, err := (&Bluez{Bus: &fakeBluez{down: true}}).Powered(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("no bluetoothd: %v", err)
	}
}

func TestBluezPairKnownAndDiscovered(t *testing.T) {
	f := newFake(true)
	b := &Bluez{Bus: f, Sleep: func(time.Duration) {}}
	if err := b.Pair(ctx, "11:22:33:44:55:66"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/org/bluez/hci0/dev_11_22_33_44_55_66 org.bluez.Device1.Pair",
		"/org/bluez/hci0/dev_11_22_33_44_55_66 set Trusted=true",
		"/org/bluez/hci0/dev_11_22_33_44_55_66 org.bluez.Device1.Connect",
	}
	if !reflect.DeepEqual(f.log, want) {
		t.Fatalf("log %v", f.log)
	}
	f = newFake(true)
	f.appear = Objects{"/org/bluez/hci0/dev_77_88_99_AA_BB_CC": device("77:88:99:AA:BB:CC", "Speaker", false)}
	b = &Bluez{Bus: f, Sleep: func(time.Duration) {}}
	if err := b.Pair(ctx, "77:88:99:aa:bb:cc"); err != nil {
		t.Fatal(err)
	}
	if f.log[0] != "/org/bluez/hci0 org.bluez.Adapter1.StartDiscovery" || !strings.Contains(strings.Join(f.log, "|"), "StopDiscovery") {
		t.Fatalf("discovery %v", f.log)
	}
	f = newFake(true)
	b = &Bluez{Bus: f, Sleep: func(time.Duration) {}, Discover: time.Second}
	if err := b.Pair(ctx, "00:00:00:00:00:01"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("never found: %v", err)
	}
	if err := (&Bluez{Bus: newFake(false)}).Pair(ctx, "00:00:00:00:00:01"); err == nil || !strings.Contains(err.Error(), "off") {
		t.Fatalf("adapter off: %v", err)
	}
	f = newFake(true)
	f.pairError = dbus.Error{Name: "org.bluez.Error.AuthenticationFailed", Body: []any{"Authentication Failed"}}
	if err := (&Bluez{Bus: f}).Pair(ctx, "11:22:33:44:55:66"); err == nil {
		t.Fatal("a failed pairing must fail")
	}
	for _, bad := range []string{"AA:BB", "aa:bb:cc:dd:ee:fg", "AA:BB:CC:DD:EE:FF; rm"} {
		if err := b.Pair(ctx, bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}

func TestBluezRemove(t *testing.T) {
	f := newFake(true)
	b := &Bluez{Bus: f}
	if err := b.Remove(ctx, "aa:bb:cc:dd:ee:ff"); err != nil {
		t.Fatal(err)
	}
	if f.log[0] != "/org/bluez/hci0 org.bluez.Adapter1.RemoveDevice" {
		t.Fatalf("log %v", f.log)
	}
	if err := b.Remove(ctx, "00:00:00:00:00:09"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unknown device: %v", err)
	}
}

func TestBluezDiscoveryBoundAndCancellation(t *testing.T) {
	f := newFake(true)
	var waited time.Duration
	b := &Bluez{Bus: f, Discover: 20 * time.Second, Sleep: func(d time.Duration) { waited += d }}
	if err := b.Pair(ctx, "00:00:00:00:00:01"); !errors.Is(err, ErrUnavailable) || waited > 10*time.Second {
		t.Fatalf("discovery waited %v: %v", waited, err)
	}
	f = newFake(true)
	cancelCtx, cancel := context.WithCancel(ctx)
	b = &Bluez{Bus: f, Sleep: func(time.Duration) { cancel() }}
	if err := b.Pair(cancelCtx, "00:00:00:00:00:01"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if got := f.log[len(f.log)-1]; got != "/org/bluez/hci0 org.bluez.Adapter1.StopDiscovery" {
		t.Fatalf("cleanup: %v", f.log)
	}
}

func TestBluezServiceUnknownPointer(t *testing.T) {
	b := &Bluez{Bus: &unavailableBluez{}}
	if _, err := b.Powered(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing service: %v", err)
	}
}

type unavailableBluez struct{ fakeBluez }

func (unavailableBluez) ManagedObjects(context.Context) (Objects, error) {
	return nil, &dbus.Error{Name: "org.freedesktop.DBus.Error.ServiceUnknown"}
}
