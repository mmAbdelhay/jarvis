package guard

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/godbus/dbus/v5"
)

// RolePasswordText is ATSPI_ROLE_PASSWORD_TEXT.
const RolePasswordText = 40

const stateFocused = 12 // ATSPI_STATE_FOCUSED, bit in word 0

// ErrNoA11y: password fields cannot be checked right now.
var ErrNoA11y = errors.New("cannot check for password fields (accessibility bus unavailable)")

// Accessible names one AT-SPI object.
type Accessible struct {
	Bus  string
	Path dbus.ObjectPath
}

// A11yQuery asks the accessibility bus about an object.
type A11yQuery interface {
	Role(ctx context.Context, a Accessible) (uint32, error)
	States(ctx context.Context, a Accessible) ([]uint32, error)
}

// PasswordWatch tracks the last focused accessible.
type PasswordWatch struct {
	q    A11yQuery
	mu   sync.Mutex
	last *Accessible
	live bool
}

// NewPasswordWatch wraps a query (tests; StartPasswordWatch for the bus).
func NewPasswordWatch(q A11yQuery) *PasswordWatch { return &PasswordWatch{q: q, live: true} }

// Live reports whether focus events still arrive.
func (w *PasswordWatch) Live() bool {
	if w == nil {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.live
}

// Focus records a focus change.
func (w *PasswordWatch) Focus(a Accessible, focused bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if focused {
		w.last = &a
	} else if w.last != nil && *w.last == a {
		w.last = nil
	}
}

func gone(err error) bool {
	var de dbus.Error
	if errors.As(err, &de) {
		switch de.Name {
		case "org.freedesktop.DBus.Error.ServiceUnknown", "org.freedesktop.DBus.Error.UnknownObject",
			"org.freedesktop.DBus.Error.UnknownMethod", "org.freedesktop.DBus.Error.NameHasNoOwner":
			return true
		}
	}
	return false
}

// PasswordFocused reports whether a password field has keyboard focus.
func (w *PasswordWatch) PasswordFocused(ctx context.Context) (bool, error) {
	if !w.Live() {
		return false, ErrNoA11y
	}
	w.mu.Lock()
	var last Accessible
	has := w.last != nil
	if has {
		last = *w.last
	}
	w.mu.Unlock()
	if !has {
		return false, nil
	}
	role, err := w.q.Role(ctx, last)
	if err != nil {
		if gone(err) {
			w.Focus(last, false)
			return false, nil
		}
		return false, fmt.Errorf("%w: %v", ErrNoA11y, err)
	}
	if role != RolePasswordText {
		return false, nil
	}
	states, err := w.q.States(ctx, last)
	if err != nil {
		if gone(err) {
			w.Focus(last, false)
			return false, nil
		}
		return false, fmt.Errorf("%w: %v", ErrNoA11y, err)
	}
	return len(states) > 0 && states[0]&(1<<stateFocused) != 0, nil
}

func (w *PasswordWatch) handleSignal(s *dbus.Signal) {
	if s == nil || s.Name != "org.a11y.atspi.Event.Object.StateChanged" || len(s.Body) < 2 {
		return
	}
	detail, ok := s.Body[0].(string)
	if !ok || detail != "focused" {
		return
	}
	d1, ok := s.Body[1].(int32)
	if !ok {
		return
	}
	w.Focus(Accessible{Bus: s.Sender, Path: s.Path}, d1 == 1)
}

type busQuery struct{ conn *dbus.Conn }

func (b busQuery) Role(ctx context.Context, a Accessible) (uint32, error) {
	var role uint32
	err := b.conn.Object(a.Bus, a.Path).CallWithContext(ctx, "org.a11y.atspi.Accessible.GetRole", 0).Store(&role)
	return role, err
}

func (b busQuery) States(ctx context.Context, a Accessible) ([]uint32, error) {
	var st []uint32
	err := b.conn.Object(a.Bus, a.Path).CallWithContext(ctx, "org.a11y.atspi.Accessible.GetState", 0).Store(&st)
	return st, err
}

// StartPasswordWatch turns accessibility on for toolkits that wait to be
// asked (org.a11y.Status.IsEnabled), connects to the accessibility bus,
// registers for focus events and starts tracking. The func closes it.
func StartPasswordWatch(ctx context.Context) (*PasswordWatch, func(), error) {
	sess, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrNoA11y, err)
	}
	bus := sess.Object("org.a11y.Bus", "/org/a11y/bus")
	_ = bus.SetProperty("org.a11y.Status.IsEnabled", dbus.MakeVariant(true))
	var addr string
	if err := bus.CallWithContext(ctx, "org.a11y.Bus.GetAddress", 0).Store(&addr); err != nil {
		sess.Close()
		return nil, nil, fmt.Errorf("%w: %v", ErrNoA11y, err)
	}
	conn, err := dbus.Connect(addr)
	if err != nil {
		sess.Close()
		return nil, nil, fmt.Errorf("%w: %v", ErrNoA11y, err)
	}
	reg := conn.Object("org.a11y.atspi.Registry", "/org/a11y/atspi/registry")
	// at-spi2-core ≥ 2.46 takes (s event, as properties, s app); older takes (s).
	if reg.CallWithContext(ctx, "org.a11y.atspi.Registry.RegisterEvent", 0, "object:state-changed:focused", []string{}, "").Err != nil {
		if err := reg.CallWithContext(ctx, "org.a11y.atspi.Registry.RegisterEvent", 0, "object:state-changed:focused").Err; err != nil {
			conn.Close()
			sess.Close()
			return nil, nil, fmt.Errorf("%w: %v", ErrNoA11y, err)
		}
	}
	if err := conn.AddMatchSignal(dbus.WithMatchInterface("org.a11y.atspi.Event.Object"), dbus.WithMatchMember("StateChanged")); err != nil {
		conn.Close()
		sess.Close()
		return nil, nil, fmt.Errorf("%w: %v", ErrNoA11y, err)
	}
	w := &PasswordWatch{q: busQuery{conn}, live: true}
	ch := make(chan *dbus.Signal, 256)
	conn.Signal(ch)
	go func() {
		for s := range ch {
			w.handleSignal(s)
		}
		w.mu.Lock()
		w.live = false
		w.mu.Unlock()
	}()
	return w, func() {
		conn.Close()
		sess.Close()
	}, nil
}
