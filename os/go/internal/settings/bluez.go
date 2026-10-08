package settings

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"
)

// BTDevice is one Bluetooth device BlueZ knows.
type BTDevice struct {
	Address   string `json:"address"`
	Name      string `json:"name"`
	Paired    bool   `json:"paired"`
	Connected bool   `json:"connected"`
}

// Objects is org.freedesktop.DBus.ObjectManager.GetManagedObjects' reply.
type Objects = map[dbus.ObjectPath]map[string]map[string]dbus.Variant

// BluezBus is the slice of the system bus that Bluez needs.
type BluezBus interface {
	ManagedObjects(ctx context.Context) (Objects, error)
	Call(ctx context.Context, path dbus.ObjectPath, method string, args ...any) error
	SetProperty(ctx context.Context, path dbus.ObjectPath, iface, prop string, value any) error
}

// Bluez drives BlueZ (org.bluez) over D-Bus.
type Bluez struct {
	Bus      BluezBus
	Sleep    func(time.Duration) // nil: time.Sleep
	Discover time.Duration       // how long Pair looks for an unknown device; 0: 10 s
}

const (
	adapterIface = "org.bluez.Adapter1"
	deviceIface  = "org.bluez.Device1"
)

var addressRe = regexp.MustCompile(`^([0-9A-F]{2}:){5}[0-9A-F]{2}$`)

// NormalizeAddress upper-cases and checks a Bluetooth address.
func NormalizeAddress(a string) (string, error) {
	a = strings.ToUpper(strings.TrimSpace(a))
	if !addressRe.MatchString(a) {
		return "", fmt.Errorf("%q is not a Bluetooth address like AA:BB:CC:DD:EE:FF", a)
	}
	return a, nil
}

func str(v dbus.Variant) string {
	s, _ := v.Value().(string)
	return s
}

func boolean(v dbus.Variant) bool {
	b, _ := v.Value().(bool)
	return b
}

// adapter returns the first adapter's path and props.
func (b *Bluez) adapter(objs Objects) (dbus.ObjectPath, map[string]dbus.Variant, error) {
	var paths []string
	for p, ifaces := range objs {
		if _, ok := ifaces[adapterIface]; ok {
			paths = append(paths, string(p))
		}
	}
	if len(paths) == 0 {
		return "", nil, ErrUnavailable
	}
	sort.Strings(paths)
	p := dbus.ObjectPath(paths[0])
	return p, objs[p][adapterIface], nil
}

func (b *Bluez) objects(ctx context.Context) (Objects, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if b.Bus == nil {
		return nil, ErrUnavailable
	}
	objs, err := b.Bus.ManagedObjects(ctx)
	if err != nil {
		if bluezErrorName(err) == "org.freedesktop.DBus.Error.ServiceUnknown" {
			return nil, ErrUnavailable
		}
		return nil, err
	}
	return objs, nil
}

// Powered reports whether the adapter is on.
func (b *Bluez) Powered(ctx context.Context) (bool, error) {
	objs, err := b.objects(ctx)
	if err != nil {
		return false, err
	}
	_, props, err := b.adapter(objs)
	if err != nil {
		return false, err
	}
	return boolean(props["Powered"]), nil
}

// SetPowered turns the adapter on or off.
func (b *Bluez) SetPowered(ctx context.Context, on bool) error {
	objs, err := b.objects(ctx)
	if err != nil {
		return err
	}
	path, _, err := b.adapter(objs)
	if err != nil {
		return err
	}
	return b.Bus.SetProperty(ctx, path, adapterIface, "Powered", on)
}

func devices(objs Objects, adapter dbus.ObjectPath) map[string]dbus.ObjectPath {
	out := map[string]dbus.ObjectPath{}
	for p, ifaces := range objs {
		d, ok := ifaces[deviceIface]
		if !ok {
			continue
		}
		if a, _ := d["Adapter"].Value().(dbus.ObjectPath); a != adapter {
			continue
		}
		out[strings.ToUpper(str(d["Address"]))] = p
	}
	return out
}

// Devices lists the adapter's known devices, paired first, then by name.
func (b *Bluez) Devices(ctx context.Context) ([]BTDevice, error) {
	objs, err := b.objects(ctx)
	if err != nil {
		return nil, err
	}
	ad, _, err := b.adapter(objs)
	if err != nil {
		return nil, err
	}
	out := []BTDevice{}
	for addr, p := range devices(objs, ad) {
		d := objs[p][deviceIface]
		name := str(d["Alias"])
		if name == "" {
			name = str(d["Name"])
		}
		out = append(out, BTDevice{Address: addr, Name: name, Paired: boolean(d["Paired"]), Connected: boolean(d["Connected"])})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Paired != out[j].Paired {
			return out[i].Paired
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Address < out[j].Address
	})
	return out, nil
}

// find returns the device path, discovering for up to Discover if needed.
func (b *Bluez) find(ctx context.Context, address string, discover bool) (dbus.ObjectPath, dbus.ObjectPath, error) {
	objs, err := b.objects(ctx)
	if err != nil {
		return "", "", err
	}
	ad, props, err := b.adapter(objs)
	if err != nil {
		return "", "", err
	}
	if p, ok := devices(objs, ad)[address]; ok {
		return ad, p, nil
	}
	if !discover {
		return "", "", ErrUnavailable
	}
	if !boolean(props["Powered"]) {
		return "", "", errors.New("Bluetooth is off; turn it on first")
	}
	if err := b.Bus.Call(ctx, ad, adapterIface+".StartDiscovery"); err != nil {
		return "", "", err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = b.Bus.Call(cleanup, ad, adapterIface+".StopDiscovery")
	}()
	sleep, wait := b.Sleep, b.Discover
	if sleep == nil {
		sleep = func(d time.Duration) {
			timer := time.NewTimer(d)
			defer timer.Stop()
			select {
			case <-ctx.Done():
			case <-timer.C:
			}
		}
	}
	if wait <= 0 || wait > 10*time.Second {
		wait = 10 * time.Second
	}
	for waited := time.Duration(0); waited < wait; waited += 500 * time.Millisecond {
		sleep(min(500*time.Millisecond, wait-waited))
		objs, err := b.objects(ctx)
		if err != nil {
			return "", "", err
		}
		if p, ok := devices(objs, ad)[address]; ok {
			return ad, p, nil
		}
	}
	return "", "", ErrUnavailable
}

// Pair uses just-works pairing, then trusts and connects the device.
// PIN/passkey agents are outside the M3 contract; authentication errors fail.
func (b *Bluez) Pair(ctx context.Context, address string) error {
	address, err := NormalizeAddress(address)
	if err != nil {
		return err
	}
	_, dev, err := b.find(ctx, address, true)
	if err != nil {
		return err
	}
	if err := b.Bus.Call(ctx, dev, deviceIface+".Pair"); err != nil {
		if bluezErrorName(err) != "org.bluez.Error.AlreadyExists" {
			return err
		}
	}
	if err := b.Bus.SetProperty(ctx, dev, deviceIface, "Trusted", true); err != nil {
		return err
	}
	b.Bus.Call(ctx, dev, deviceIface+".Connect") // best effort: some devices only pair
	return nil
}

// Remove unpairs and forgets a device.
func (b *Bluez) Remove(ctx context.Context, address string) error {
	address, err := NormalizeAddress(address)
	if err != nil {
		return err
	}
	ad, dev, err := b.find(ctx, address, false)
	if err != nil {
		return err
	}
	return b.Bus.Call(ctx, ad, adapterIface+".RemoveDevice", dev)
}

// SystemBluezBus is BluezBus on a system-bus connection.
type SystemBluezBus struct {
	Conn func() (*dbus.Conn, error) // nil: shared dbus.SystemBus connection
}

func (s SystemBluezBus) obj(path dbus.ObjectPath) (dbus.BusObject, error) {
	connect := s.Conn
	if connect == nil {
		connect = dbus.SystemBus
	}
	c, err := connect()
	if err != nil {
		return nil, err
	}
	return c.Object("org.bluez", path), nil
}

// ManagedObjects implements BluezBus.
func (s SystemBluezBus) ManagedObjects(ctx context.Context) (Objects, error) {
	o, err := s.obj("/")
	if err != nil {
		return nil, err
	}
	var objs Objects
	err = o.CallWithContext(ctx, "org.freedesktop.DBus.ObjectManager.GetManagedObjects", 0).Store(&objs)
	return objs, err
}

// Call implements BluezBus.
func (s SystemBluezBus) Call(ctx context.Context, path dbus.ObjectPath, method string, args ...any) error {
	o, err := s.obj(path)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	return o.CallWithContext(ctx, method, 0, args...).Err
}

// SetProperty implements BluezBus.
func (s SystemBluezBus) SetProperty(ctx context.Context, path dbus.ObjectPath, iface, prop string, value any) error {
	o, err := s.obj(path)
	if err != nil {
		return err
	}
	return o.CallWithContext(ctx, "org.freedesktop.DBus.Properties.Set", 0, iface, prop, dbus.MakeVariant(value)).Err
}

// bluezErrorName accepts both value errors from fakes and pointer errors from godbus.
func bluezErrorName(err error) string {
	var pointer *dbus.Error
	if errors.As(err, &pointer) && pointer != nil {
		return pointer.Name
	}
	var value dbus.Error
	if errors.As(err, &value) {
		return value.Name
	}
	return ""
}
