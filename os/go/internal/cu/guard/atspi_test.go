package guard

import (
	"context"
	"errors"
	"testing"

	"github.com/godbus/dbus/v5"
)

type fakeA11y struct {
	roles  map[Accessible]uint32
	states map[Accessible][]uint32
	err    error
}

func (f *fakeA11y) Role(_ context.Context, a Accessible) (uint32, error) {
	if f.err != nil {
		return 0, f.err
	}
	r, ok := f.roles[a]
	if !ok {
		return 0, dbus.Error{Name: "org.freedesktop.DBus.Error.UnknownObject"}
	}
	return r, nil
}

func (f *fakeA11y) States(_ context.Context, a Accessible) ([]uint32, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.states[a], nil
}

func TestPasswordFocused(t *testing.T) {
	pw := Accessible{":1.40", "/org/a11y/atspi/accessible/12"}
	entry := Accessible{":1.40", "/org/a11y/atspi/accessible/13"}
	q := &fakeA11y{
		roles:  map[Accessible]uint32{pw: RolePasswordText, entry: 61},
		states: map[Accessible][]uint32{pw: {1 << 12, 0}, entry: {1 << 12, 0}},
	}
	w := NewPasswordWatch(q)
	ctx := context.Background()
	if got, err := w.PasswordFocused(ctx); got || err != nil {
		t.Fatalf("nothing focused yet: %v %v", got, err)
	}
	w.Focus(pw, true)
	if got, err := w.PasswordFocused(ctx); !got || err != nil {
		t.Fatalf("password focused: %v %v", got, err)
	}
	w.Focus(entry, true)
	if got, _ := w.PasswordFocused(ctx); got {
		t.Fatal("a plain entry is not a password field")
	}
	w.Focus(pw, true)
	q.states[pw] = []uint32{0, 0} // focus moved somewhere without a11y events
	if got, _ := w.PasswordFocused(ctx); got {
		t.Fatal("a password field that lost focus still counted")
	}
	q.states[pw] = []uint32{1 << 12, 0}
	w.Focus(pw, false)
	if got, _ := w.PasswordFocused(ctx); got {
		t.Fatal("unfocus event ignored")
	}
}

func TestPasswordWatchGoneAndBroken(t *testing.T) {
	gone := Accessible{":1.9", "/x"}
	q := &fakeA11y{roles: map[Accessible]uint32{}}
	w := NewPasswordWatch(q)
	w.Focus(gone, true)
	if got, err := w.PasswordFocused(context.Background()); got || err != nil {
		t.Fatalf("a vanished object is not focused: %v %v", got, err)
	}
	q.err = errors.New("bus timeout")
	w.Focus(Accessible{":1.9", "/y"}, true)
	if _, err := w.PasswordFocused(context.Background()); !errors.Is(err, ErrNoA11y) {
		t.Fatalf("broken bus must report ErrNoA11y, got %v", err)
	}
	var nilWatch *PasswordWatch
	if _, err := nilWatch.PasswordFocused(context.Background()); !errors.Is(err, ErrNoA11y) {
		t.Fatal("no watch must report ErrNoA11y")
	}
}

func TestHandleSignal(t *testing.T) {
	pw := Accessible{":1.40", "/a/12"}
	q := &fakeA11y{roles: map[Accessible]uint32{pw: RolePasswordText}, states: map[Accessible][]uint32{pw: {1 << 12}}}
	w := NewPasswordWatch(q)
	w.handleSignal(&dbus.Signal{Sender: ":1.40", Path: "/a/12", Name: "org.a11y.atspi.Event.Object.StateChanged",
		Body: []any{"focused", int32(1), int32(0), dbus.MakeVariant(0), map[string]dbus.Variant{}}})
	if got, _ := w.PasswordFocused(context.Background()); !got {
		t.Fatal("focus signal not recorded")
	}
	for _, s := range []*dbus.Signal{
		{Sender: ":1.40", Path: "/a/13", Name: "org.a11y.atspi.Event.Object.StateChanged", Body: []any{"showing", int32(1)}},
		{Sender: ":1.40", Path: "/a/13", Name: "org.a11y.atspi.Event.Object.TextChanged", Body: []any{"focused", int32(1)}},
		{Sender: ":1.40", Path: "/a/13", Name: "org.a11y.atspi.Event.Object.StateChanged", Body: []any{"focused"}},
		{Sender: ":1.40", Path: "/a/13", Name: "org.a11y.atspi.Event.Object.StateChanged", Body: []any{int32(1), "focused"}},
	} {
		w.handleSignal(s)
	}
	if got, _ := w.PasswordFocused(context.Background()); !got {
		t.Fatal("unrelated or malformed signals changed the focus")
	}
}

type seedA11y struct {
	fakeA11y
	focus *Accessible
	err   error
}

func (s *seedA11y) Focused(context.Context) (Accessible, bool, error) {
	if s.err != nil {
		return Accessible{}, false, s.err
	}
	if s.focus == nil {
		return Accessible{}, false, nil
	}
	return *s.focus, true, nil
}

func TestPasswordFocusedSeedsFromTree(t *testing.T) {
	pw := Accessible{":1.40", "/p"}
	q := &seedA11y{fakeA11y: fakeA11y{
		roles:  map[Accessible]uint32{pw: RolePasswordText},
		states: map[Accessible][]uint32{pw: {1 << 12, 0}},
	}, focus: &pw}
	w := NewPasswordWatch(q)
	if got, err := w.PasswordFocused(context.Background()); !got || err != nil {
		t.Fatalf("password already focused at start must be seen: %v %v", got, err)
	}
}

func TestPasswordFocusedUnseededRefuses(t *testing.T) {
	q := &seedA11y{err: errors.New("tree unreadable")}
	w := NewPasswordWatch(q)
	if got, err := w.PasswordFocused(context.Background()); got || !errors.Is(err, ErrNoA11y) {
		t.Fatalf("unseeded must refuse, got %v %v", got, err)
	}
	q.err = nil // nothing focused: now known
	if got, err := w.PasswordFocused(context.Background()); got || err != nil {
		t.Fatalf("seeded empty: %v %v", got, err)
	}
	q2 := &seedA11y{err: errors.New("x")}
	w2 := NewPasswordWatch(q2)
	w2.Focus(Accessible{":1.1", "/e"}, true) // an event also seeds
	if _, err := w2.PasswordFocused(context.Background()); errors.Is(err, ErrNoA11y) {
		t.Fatal("focus event should seed")
	}
}
