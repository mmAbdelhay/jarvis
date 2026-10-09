package guard

import (
	"context"
	"errors"
	"testing"

	"github.com/godbus/dbus/v5"
)

// labelled is an A11yQuery that also answers names, parents, children and
// labelled-by relations (labelQuery), like the bus does.
type labelled struct {
	fakeA11y
	names   map[Accessible]string
	parent  map[Accessible]Accessible
	kids    map[Accessible][]Accessible
	labelBy map[Accessible][]Accessible
	nameErr error
}

func (l *labelled) Name(_ context.Context, a Accessible) (string, error) {
	if l.nameErr != nil {
		return "", l.nameErr
	}
	return l.names[a], nil
}

func (l *labelled) Parent(_ context.Context, a Accessible) (Accessible, bool, error) {
	p, ok := l.parent[a]
	return p, ok, nil
}

func (l *labelled) children(_ context.Context, a Accessible) ([]Accessible, error) {
	return l.kids[a], nil
}

func (l *labelled) LabelledBy(_ context.Context, a Accessible) ([]Accessible, error) {
	return l.labelBy[a], nil
}

const roleLabel = 29

// gtk4Entry builds trixie's zenity --password: panel > [label "Password:",
// entry (role 61, no name)].
func gtk4Entry(label string) (*labelled, Accessible) {
	panel := Accessible{":1.40", "/panel"}
	lab := Accessible{":1.40", "/label"}
	entry := Accessible{":1.40", "/entry"}
	l := &labelled{
		fakeA11y: fakeA11y{
			roles:  map[Accessible]uint32{panel: 39, lab: roleLabel, entry: 61},
			states: map[Accessible][]uint32{entry: {1 << stateFocused}},
		},
		names:   map[Accessible]string{lab: label},
		parent:  map[Accessible]Accessible{entry: panel, lab: panel},
		kids:    map[Accessible][]Accessible{panel: {lab, entry}},
		labelBy: map[Accessible][]Accessible{},
	}
	return l, entry
}

// Gap 13: a GTK4 entry with hidden text reports role 61; the label next to
// it (or its own name, or its labelled-by label) is the signal.
func TestPasswordFocusedGTK4EntryByLabel(t *testing.T) {
	ctx := context.Background()
	for _, label := range []string{"Password:", "Passphrase", "PIN", "كلمة المرور:", "كلمة السر"} {
		q, entry := gtk4Entry(label)
		w := NewPasswordWatch(q)
		w.Focus(entry, true)
		if got, err := w.PasswordFocused(ctx); !got || err != nil {
			t.Fatalf("%q: %v %v", label, got, err)
		}
	}
	for _, label := range []string{"File name:", "Search", "Passport number"} {
		q, entry := gtk4Entry(label)
		w := NewPasswordWatch(q)
		w.Focus(entry, true)
		if got, err := w.PasswordFocused(ctx); got || err != nil {
			t.Fatalf("%q is not a password field: %v %v", label, got, err)
		}
	}
	// Its own accessible name, or a labelled-by relation.
	q, entry := gtk4Entry("")
	q.names[entry] = "Wi-Fi password"
	w := NewPasswordWatch(q)
	w.Focus(entry, true)
	if got, _ := w.PasswordFocused(ctx); !got {
		t.Fatal("own name")
	}
	q, entry = gtk4Entry("")
	far := Accessible{":1.40", "/far-label"}
	q.names[far] = "Enter your password"
	q.labelBy[entry] = []Accessible{far}
	w = NewPasswordWatch(q)
	w.Focus(entry, true)
	if got, _ := w.PasswordFocused(ctx); !got {
		t.Fatal("labelled-by")
	}
	// Not focused any more: no.
	q, entry = gtk4Entry("Password:")
	q.states[entry] = []uint32{0}
	w = NewPasswordWatch(q)
	w.Focus(entry, true)
	if got, _ := w.PasswordFocused(ctx); got {
		t.Fatal("unfocused")
	}
	// A broken bus while reading labels refuses (fails closed).
	q, entry = gtk4Entry("Password:")
	q.nameErr = errors.New("timeout")
	w = NewPasswordWatch(q)
	w.Focus(entry, true)
	if _, err := w.PasswordFocused(ctx); !errors.Is(err, ErrNoA11y) {
		t.Fatalf("got %v", err)
	}
	// A vanished label is skipped, not an error.
	q, entry = gtk4Entry("Password:")
	q.nameErr = dbus.Error{Name: "org.freedesktop.DBus.Error.UnknownObject"}
	w = NewPasswordWatch(q)
	w.Focus(entry, true)
	if got, err := w.PasswordFocused(ctx); got || err != nil {
		t.Fatalf("vanished: %v %v", got, err)
	}
}

func TestPasswordWords(t *testing.T) {
	for _, s := range []string{"Password", "PASSWORD:", "passphrase", "PIN code", "Passcode", "كلمة المرور", "كلمة السر", "رمز المرور", "الرقم السري"} {
		if !passwordWords(s) {
			t.Fatalf("%q", s)
		}
	}
	for _, s := range []string{"", "Passport", "Spinner", "Pinned", "Opinion", "اسم المستخدم", "File name"} {
		if passwordWords(s) {
			t.Fatalf("%q", s)
		}
	}
}
