package guard

import (
	"context"
	"errors"
	"fmt"
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
	e := Accessible{":1.1", "/e"}
	q2 := &seedA11y{err: errors.New("x"), fakeA11y: fakeA11y{
		roles: map[Accessible]uint32{e: 61}, states: map[Accessible][]uint32{e: {1 << 12}}}}
	w2 := NewPasswordWatch(q2)
	w2.Focus(e, true) // an event also seeds (and the control still has focus: no walk)
	if _, err := w2.PasswordFocused(context.Background()); errors.Is(err, ErrNoA11y) {
		t.Fatal("focus event should seed")
	}
}

// fakeTree is an in-memory accessibility tree for the seed walk.
type fakeTree struct {
	kids     map[Accessible][]Accessible
	states   map[Accessible][]uint32
	stateErr map[Accessible]error
	kidsErr  map[Accessible]error
}

func (f *fakeTree) States(_ context.Context, a Accessible) ([]uint32, error) {
	if err := f.stateErr[a]; err != nil {
		return nil, err
	}
	return f.states[a], nil
}

func (f *fakeTree) children(_ context.Context, a Accessible) ([]Accessible, error) {
	if err := f.kidsErr[a]; err != nil {
		return nil, err
	}
	return f.kids[a], nil
}

// chain builds root > app > n1 > ... > nDepth and returns the leaf.
func chain(f *fakeTree, depth int) Accessible {
	parent := seedRoot
	for i := 1; i <= depth; i++ {
		n := Accessible{":1.50", dbus.ObjectPath(fmt.Sprintf("/n/%d", i))}
		f.kids[parent] = append(f.kids[parent], n)
		parent = n
	}
	return parent
}

func newFakeTree() *fakeTree {
	return &fakeTree{kids: map[Accessible][]Accessible{}, states: map[Accessible][]uint32{},
		stateErr: map[Accessible]error{}, kidsErr: map[Accessible]error{}}
}

func TestFocusedWalkFindsDeepFocus(t *testing.T) {
	f := newFakeTree()
	leaf := chain(f, 30) // a web login field sits far below the app node
	f.states[leaf] = []uint32{1 << 12}
	a, found, err := focusedWalk(context.Background(), f)
	if err != nil || !found || a != leaf {
		t.Fatalf("deep focused node: %v %v %v", a, found, err)
	}
}

func TestFocusedWalkCutShortIsError(t *testing.T) {
	f := newFakeTree()
	leaf := chain(f, seedMaxDepth+5)
	f.states[leaf] = []uint32{1 << 12}
	if _, found, err := focusedWalk(context.Background(), f); err == nil || found {
		t.Fatalf("a walk cut by the depth cap must be an error, got found=%v err=%v", found, err)
	}
}

func TestFocusedWalkPartialIsError(t *testing.T) {
	timeout := errors.New("call timed out")
	goneErr := dbus.Error{Name: "org.freedesktop.DBus.Error.ServiceUnknown"}

	f := newFakeTree()
	chain(f, 5)
	f.stateErr[f.kids[seedRoot][0]] = timeout // hung app: its subtree is unknown
	if _, _, err := focusedWalk(context.Background(), f); err == nil {
		t.Fatal("a States timeout must make the walk an error")
	}

	f = newFakeTree()
	chain(f, 5)
	f.kidsErr[f.kids[seedRoot][0]] = timeout
	if _, _, err := focusedWalk(context.Background(), f); err == nil {
		t.Fatal("a children timeout must make the walk an error")
	}

	f = newFakeTree()
	chain(f, 5)
	app := f.kids[seedRoot][0]
	f.stateErr[app] = goneErr
	f.kidsErr[app] = goneErr
	if _, found, err := focusedWalk(context.Background(), f); err != nil || found {
		t.Fatalf("an app that vanished is skipped: %v %v", found, err)
	}

	f = newFakeTree()
	f.kidsErr[seedRoot] = goneErr
	if _, _, err := focusedWalk(context.Background(), f); err == nil {
		t.Fatal("root failure is an error")
	}
}

func TestFocusedWalkNothingFocused(t *testing.T) {
	f := newFakeTree()
	chain(f, 10)
	if _, found, err := focusedWalk(context.Background(), f); found || err != nil {
		t.Fatalf("nothing focused: %v %v", found, err)
	}
}

// fakePoint is an accessibility tree with hit-testing for DescribeAt.
type fakePoint struct {
	*fakeTree
	names   map[Accessible]string
	roles   map[Accessible]string
	hits    map[Accessible]Accessible // what each node reports at the point
	hitErr  map[Accessible]error
	nameErr map[Accessible]error
	asked   []Accessible
	lastX   int32
	lastY   int32
}

func newFakePoint() *fakePoint {
	return &fakePoint{fakeTree: newFakeTree(), names: map[Accessible]string{}, roles: map[Accessible]string{},
		hits: map[Accessible]Accessible{}, hitErr: map[Accessible]error{}, nameErr: map[Accessible]error{}}
}

func (f *fakePoint) Name(_ context.Context, a Accessible) (string, error) {
	if err := f.nameErr[a]; err != nil {
		return "", err
	}
	return f.names[a], nil
}

func (f *fakePoint) RoleName(_ context.Context, a Accessible) (string, error) {
	r, ok := f.roles[a]
	if !ok {
		return "", dbus.Error{Name: "org.freedesktop.DBus.Error.UnknownObject"}
	}
	return r, nil
}

func (f *fakePoint) atPoint(_ context.Context, a Accessible, x, y int32) (Accessible, bool, error) {
	f.asked = append(f.asked, a)
	f.lastX, f.lastY = x, y
	if err := f.hitErr[a]; err != nil {
		return Accessible{}, false, err
	}
	h, ok := f.hits[a]
	return h, ok, nil
}

// window adds app > frame titled title and returns the frame.
func (f *fakePoint) window(app, title string, active bool) Accessible {
	ap := Accessible{app, "/org/a11y/atspi/accessible/root"}
	fr := Accessible{app, dbus.ObjectPath("/frame/" + fmt.Sprint(len(f.kids[ap])))}
	if !contains(f.kids[seedRoot], ap) {
		f.kids[seedRoot] = append(f.kids[seedRoot], ap)
	}
	f.kids[ap] = append(f.kids[ap], fr)
	f.names[fr] = title
	f.roles[fr] = "frame"
	if active {
		f.states[fr] = []uint32{1 << stateActive}
	}
	return fr
}

func contains(xs []Accessible, a Accessible) bool {
	for _, x := range xs {
		if x == a {
			return true
		}
	}
	return false
}

func TestDescribeAtDescendsToDeepestHit(t *testing.T) {
	f := newFakePoint()
	f.window(":1.7", "Other", false)
	fr := f.window(":1.8", "Untitled - Editor", true)
	panel := Accessible{":1.8", "/panel"}
	btn := Accessible{":1.8", "/save"}
	f.hits[fr] = panel
	f.hits[panel] = btn
	f.roles[btn] = "push button"
	f.names[btn] = "Save"
	role, name := DescribeAt(context.Background(), f, "Untitled - Editor", 120, 40)
	if role != "push button" || name != "Save" {
		t.Fatalf("got %q %q", role, name)
	}
	if f.lastX != 120 || f.lastY != 40 {
		t.Fatalf("window coordinates not passed through: %d,%d", f.lastX, f.lastY)
	}
}

func TestDescribeAtUnknown(t *testing.T) {
	timeout := errors.New("call timed out")
	cases := map[string]func(f *fakePoint) string{
		"no matching window": func(f *fakePoint) string {
			fr := f.window(":1.8", "Editor", true)
			f.hits[fr] = Accessible{":1.8", "/b"}
			return "Browser"
		},
		"empty title": func(f *fakePoint) string {
			f.window(":1.8", "", true)
			return ""
		},
		"two windows, same title, none active": func(f *fakePoint) string {
			a := f.window(":1.8", "Doc", false)
			b := f.window(":1.9", "Doc", false)
			f.hits[a] = Accessible{":1.8", "/x"}
			f.hits[b] = Accessible{":1.9", "/x"}
			f.roles[Accessible{":1.8", "/x"}] = "push button"
			f.roles[Accessible{":1.9", "/x"}] = "push button"
			return "Doc"
		},
		"nothing under the point": func(f *fakePoint) string {
			f.window(":1.8", "Editor", true)
			return "Editor"
		},
		"hit test fails": func(f *fakePoint) string {
			fr := f.window(":1.8", "Editor", true)
			f.hitErr[fr] = timeout
			return "Editor"
		},
		"hit object vanished": func(f *fakePoint) string {
			fr := f.window(":1.8", "Editor", true)
			f.hits[fr] = Accessible{":1.8", "/gone"} // no role: UnknownObject
			return "Editor"
		},
		"name read fails": func(f *fakePoint) string {
			fr := f.window(":1.8", "Editor", true)
			b := Accessible{":1.8", "/b"}
			f.hits[fr] = b
			f.roles[b] = "push button"
			f.nameErr[b] = timeout
			return "Editor"
		},
		"tree unreadable": func(f *fakePoint) string {
			f.kidsErr[seedRoot] = timeout
			return "Editor"
		},
		"hit loops": func(f *fakePoint) string {
			fr := f.window(":1.8", "Editor", true)
			a, b := Accessible{":1.8", "/a"}, Accessible{":1.8", "/b"}
			f.hits[fr], f.hits[a], f.hits[b] = a, b, a
			f.roles[a], f.roles[b] = "filler", "filler"
			return "Editor"
		},
	}
	for name, setup := range cases {
		f := newFakePoint()
		title := setup(f)
		role, n := DescribeAt(context.Background(), f, title, 10, 10)
		if role != RoleUnknown || n != "" {
			t.Errorf("%s: got %q %q, want unknown", name, role, n)
		}
	}
	var nilWatch *PasswordWatch
	if role, _ := nilWatch.DescribeAt(context.Background(), "Editor", 1, 1); role != RoleUnknown {
		t.Fatal("no watch must describe as unknown")
	}
	if role, _ := NewPasswordWatch(&fakeA11y{}).DescribeAt(context.Background(), "Editor", 1, 1); role != RoleUnknown {
		t.Fatal("a query without hit-testing must describe as unknown")
	}
}

func TestDescribeAtPrefersActiveWindowAndSkipsVanishedApps(t *testing.T) {
	f := newFakePoint()
	gone := Accessible{":1.5", "/org/a11y/atspi/accessible/root"}
	f.kids[seedRoot] = append(f.kids[seedRoot], gone)
	f.kidsErr[gone] = dbus.Error{Name: "org.freedesktop.DBus.Error.ServiceUnknown"}
	f.window(":1.8", "Doc", false)
	act := f.window(":1.9", "Doc", true)
	b := Accessible{":1.9", "/b"}
	f.hits[act] = b
	f.roles[b] = "check box"
	f.names[b] = "Remember me"
	if role, name := DescribeAt(context.Background(), f, "Doc", 5, 5); role != "check box" || name != "Remember me" {
		t.Fatalf("got %q %q", role, name)
	}
}

func TestDescribeAtCapsName(t *testing.T) {
	f := newFakePoint()
	fr := f.window(":1.8", "Editor", true)
	b := Accessible{":1.8", "/b"}
	f.hits[fr] = b
	f.roles[b] = "label"
	long := ""
	for i := 0; i < 500; i++ {
		long += "ب"
	}
	f.names[b] = long + "\x00\n"
	_, name := DescribeAt(context.Background(), f, "Editor", 1, 1)
	if n := len([]rune(name)); n != maxDescribeName {
		t.Fatalf("name not capped: %d runes", n)
	}
}

// Labwc e2e (flaky 1 in 3 before): GTK4 sends the focus event late, so the
// watch may know of no focused control, or of a stale one, when input comes.
// It then walks the tree again instead of answering "no password".
func TestPasswordFocusedRewalksWhenFocusIsUnknownOrStale(t *testing.T) {
	pw := Accessible{":1.40", "/p"}
	old := Accessible{":1.41", "/old"}
	q := &seedA11y{fakeA11y: fakeA11y{
		roles:  map[Accessible]uint32{pw: RolePasswordText, old: 61},
		states: map[Accessible][]uint32{pw: {1 << 12, 0}, old: {0}},
	}}
	w := NewPasswordWatch(q)
	if got, err := w.PasswordFocused(context.Background()); got || err != nil {
		t.Fatalf("nothing focused yet: %v %v", got, err)
	}
	q.focus = &pw // the password field took focus; no event arrived
	if got, err := w.PasswordFocused(context.Background()); !got || err != nil {
		t.Fatalf("unknown focus must be looked up again: %v %v", got, err)
	}
	w.Focus(old, true) // a stale event: that control no longer has focus
	if got, err := w.PasswordFocused(context.Background()); !got || err != nil {
		t.Fatalf("stale focus must be looked up again: %v %v", got, err)
	}
	q.err = errors.New("tree unreadable")
	w.Focus(old, true)
	if _, err := w.PasswordFocused(context.Background()); !errors.Is(err, ErrNoA11y) {
		t.Fatalf("a failed walk refuses: %v", err)
	}
}
