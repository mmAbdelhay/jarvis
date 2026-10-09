package guard

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"unicode"

	"github.com/godbus/dbus/v5"
)

// RolePasswordText is ATSPI_ROLE_PASSWORD_TEXT.
//
// Known gap (proposed contract gap 13, see cu/e2e/README.md): GTK4 password
// entries (e.g. trixie's zenity --password) report ATSPI_ROLE_TEXT (61) with
// no distinguishing state or attribute, so they are NOT detected here and
// input into them is not refused. Toolkits reporting role 40 (GTK3, Qt) are.
const RolePasswordText = 40

const (
	stateActive  = 1  // ATSPI_STATE_ACTIVE, bit in word 0
	stateFocused = 12 // ATSPI_STATE_FOCUSED, bit in word 0
)

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

// Seeder finds the currently focused accessible without waiting for an
// event. found=false with a nil error means nothing has focus.
type Seeder interface {
	Focused(ctx context.Context) (a Accessible, found bool, err error)
}

// PasswordWatch tracks the last focused accessible. Until it has seen a
// focus event or seeded itself from the live tree it does not know what has
// focus, and PasswordFocused refuses (ErrNoA11y) rather than say "no".
type PasswordWatch struct {
	q      A11yQuery
	mu     sync.Mutex
	last   *Accessible
	live   bool
	seeded bool
}

// NewPasswordWatch wraps a query (tests; StartPasswordWatch for the bus).
// A query that is also a Seeder starts unseeded.
func NewPasswordWatch(q A11yQuery) *PasswordWatch {
	_, canSeed := q.(Seeder)
	return &PasswordWatch{q: q, live: true, seeded: !canSeed}
}

// seed asks the tree what has focus now. It reports whether the watch knows.
func (w *PasswordWatch) seed(ctx context.Context) bool {
	w.mu.Lock()
	if w.seeded {
		w.mu.Unlock()
		return true
	}
	w.mu.Unlock()
	sd, ok := w.q.(Seeder)
	if !ok {
		return false
	}
	a, found, err := sd.Focused(ctx)
	if err != nil {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.seeded { // a focus event may have arrived meanwhile; it wins
		if found {
			w.last = &a
		}
		w.seeded = true
	}
	return true
}

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
	w.seeded = true
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
	if !w.seed(ctx) {
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

func (b busQuery) RoleName(ctx context.Context, a Accessible) (string, error) {
	var r string
	err := b.conn.Object(a.Bus, a.Path).CallWithContext(ctx, "org.a11y.atspi.Accessible.GetRoleName", 0).Store(&r)
	return r, err
}

func (b busQuery) Name(ctx context.Context, a Accessible) (string, error) {
	var v dbus.Variant
	err := b.conn.Object(a.Bus, a.Path).CallWithContext(ctx, "org.freedesktop.DBus.Properties.Get", 0,
		"org.a11y.atspi.Accessible", "Name").Store(&v)
	if err != nil {
		return "", err
	}
	s, ok := v.Value().(string)
	if !ok {
		return "", errors.New("accessible name is not a string")
	}
	return s, nil
}

const nullPath = "/org/a11y/atspi/null"

func (b busQuery) atPoint(ctx context.Context, a Accessible, x, y int32) (Accessible, bool, error) {
	var ref []interface{}
	err := b.conn.Object(a.Bus, a.Path).CallWithContext(ctx, "org.a11y.atspi.Component.GetAccessibleAtPoint", 0,
		x, y, uint32(coordTypeWindow)).Store(&ref)
	if err != nil {
		return Accessible{}, false, err
	}
	if len(ref) != 2 {
		return Accessible{}, false, errors.New("malformed accessible reference")
	}
	bus, ok1 := ref[0].(string)
	path, ok2 := ref[1].(dbus.ObjectPath)
	if !ok1 || !ok2 {
		return Accessible{}, false, errors.New("malformed accessible reference")
	}
	if bus == "" || path == "" || path == nullPath {
		return Accessible{}, false, nil
	}
	return Accessible{Bus: bus, Path: path}, true, nil
}

const (
	seedMaxNodes = 4000
	// Web content nests deep (app > frame > ... > document > sections >
	// form > entry); the node cap is what bounds the walk, this only stops
	// runaway or cyclic trees.
	seedMaxDepth = 64
)

var seedRoot = Accessible{Bus: "org.a11y.atspi.Registry", Path: "/org/a11y/atspi/accessible/root"}

func (b busQuery) children(ctx context.Context, a Accessible) ([]Accessible, error) {
	var kids [][]interface{}
	err := b.conn.Object(a.Bus, a.Path).CallWithContext(ctx, "org.a11y.atspi.Accessible.GetChildren", 0).Store(&kids)
	if err != nil {
		return nil, err
	}
	out := make([]Accessible, 0, len(kids))
	for _, k := range kids {
		if len(k) != 2 {
			continue
		}
		bus, ok1 := k[0].(string)
		path, ok2 := k[1].(dbus.ObjectPath)
		if ok1 && ok2 {
			out = append(out, Accessible{Bus: bus, Path: path})
		}
	}
	return out, nil
}

// Focused walks the live accessibility tree (see focusedWalk).
func (b busQuery) Focused(ctx context.Context) (Accessible, bool, error) {
	return focusedWalk(ctx, b)
}

// treeQuery is what the seed walk needs from the bus.
type treeQuery interface {
	States(ctx context.Context, a Accessible) ([]uint32, error)
	children(ctx context.Context, a Accessible) ([]Accessible, error)
}

// focusedWalk walks the tree breadth-first from the registry root and returns
// the first node in the focused state. found=false with a nil error is only
// returned after every node was examined: a node (and its subtree) is skipped
// only when the bus says its application or object is gone. Any other
// failure, a failure at the root, or a walk cut short by the node or depth
// cap is an error, so the caller keeps refusing instead of assuming nothing
// has focus.
func focusedWalk(ctx context.Context, t treeQuery) (Accessible, bool, error) {
	type item struct {
		a     Accessible
		depth int
	}
	apps, err := t.children(ctx, seedRoot)
	if err != nil {
		return Accessible{}, false, err
	}
	queue := make([]item, 0, len(apps))
	for _, a := range apps {
		queue = append(queue, item{a, 1})
	}
	for n := 0; len(queue) > 0; n++ {
		if err := ctx.Err(); err != nil {
			return Accessible{}, false, err
		}
		if n >= seedMaxNodes {
			return Accessible{}, false, errors.New("accessibility tree too large to search")
		}
		it := queue[0]
		queue = queue[1:]
		st, err := t.States(ctx, it.a)
		if err != nil {
			if gone(err) {
				continue
			}
			return Accessible{}, false, fmt.Errorf("reading state of %s%s: %w", it.a.Bus, it.a.Path, err)
		}
		if len(st) > 0 && st[0]&(1<<stateFocused) != 0 {
			return it.a, true, nil
		}
		kids, err := t.children(ctx, it.a)
		if err != nil {
			if gone(err) {
				continue
			}
			return Accessible{}, false, fmt.Errorf("listing children of %s%s: %w", it.a.Bus, it.a.Path, err)
		}
		if len(kids) == 0 {
			continue
		}
		if it.depth >= seedMaxDepth {
			return Accessible{}, false, errors.New("accessibility tree too deep to search")
		}
		for _, k := range kids {
			queue = append(queue, item{k, it.depth + 1})
		}
	}
	return Accessible{}, false, nil
}

// RoleUnknown is DescribeAt's answer whenever the accessible cannot be found.
const RoleUnknown = "unknown"

const (
	maxDescribeName  = 120 // runes; a label, never a document
	maxDescribeDepth = 32  // hit-test descent steps
	coordTypeWindow  = 1   // ATSPI_COORD_TYPE_WINDOW
)

// pointQuery is what DescribeAt needs from the bus.
type pointQuery interface {
	treeQuery
	Name(ctx context.Context, a Accessible) (string, error)
	RoleName(ctx context.Context, a Accessible) (string, error)
	// atPoint hit-tests a's children at a window-relative point;
	// found=false means no child is there.
	atPoint(ctx context.Context, a Accessible, x, y int32) (Accessible, bool, error)
}

// DescribeAt names the accessible under a point of the window titled title
// (contracts §4.2 describeAt). x, y are logical pixels relative to that
// window's top-left corner: on Wayland apps do not know where their window
// sits on screen, so AT-SPI screen coordinates are unreliable and only
// window coordinates (ATSPI_COORD_TYPE_WINDOW) are used. The caller maps
// capture-space points into the window (for the fullscreened base window
// the two are the same). The window is found among the apps' top-level
// accessibles by exact title; several matches are narrowed to the active
// one. Any failure, ambiguity or empty hit answers (RoleUnknown, "").
func DescribeAt(ctx context.Context, q pointQuery, title string, x, y int) (role, name string) {
	if q == nil || title == "" || x < 0 || y < 0 || x > 1<<20 || y > 1<<20 {
		return RoleUnknown, ""
	}
	frame, ok := findFrame(ctx, q, title)
	if !ok {
		return RoleUnknown, ""
	}
	cur := frame
	seen := map[Accessible]bool{frame: true}
	for i := 0; ; i++ {
		if i >= maxDescribeDepth {
			return RoleUnknown, ""
		}
		next, found, err := q.atPoint(ctx, cur, int32(x), int32(y))
		if err != nil {
			return RoleUnknown, ""
		}
		if !found || next == cur {
			break
		}
		if seen[next] {
			return RoleUnknown, ""
		}
		seen[next] = true
		cur = next
	}
	if cur == frame {
		return RoleUnknown, ""
	}
	r, err := q.RoleName(ctx, cur)
	r = strings.TrimSpace(r)
	if err != nil || r == "" {
		return RoleUnknown, ""
	}
	n, err := q.Name(ctx, cur)
	if err != nil {
		return RoleUnknown, ""
	}
	return clean(r, maxDescribeName), clean(n, maxDescribeName)
}

// clean drops control characters and caps s at max runes.
func clean(s string, max int) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n >= max {
			break
		}
		if unicode.IsControl(r) || r == unicode.ReplacementChar {
			continue
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}

// findFrame looks one level below each app for the window titled title.
func findFrame(ctx context.Context, q pointQuery, title string) (Accessible, bool) {
	apps, err := q.children(ctx, seedRoot)
	if err != nil {
		return Accessible{}, false
	}
	var matches []Accessible
	n := 0
	for _, app := range apps {
		wins, err := q.children(ctx, app)
		if err != nil {
			if gone(err) {
				continue
			}
			return Accessible{}, false
		}
		for _, w := range wins {
			if n++; n > seedMaxNodes || ctx.Err() != nil {
				return Accessible{}, false
			}
			name, err := q.Name(ctx, w)
			if err != nil {
				if gone(err) {
					continue
				}
				return Accessible{}, false
			}
			if name == title {
				matches = append(matches, w)
			}
		}
	}
	if len(matches) > 1 {
		var active []Accessible
		for _, m := range matches {
			st, err := q.States(ctx, m)
			if err == nil && len(st) > 0 && st[0]&(1<<stateActive) != 0 {
				active = append(active, m)
			}
		}
		matches = active
	}
	if len(matches) != 1 {
		return Accessible{}, false
	}
	return matches[0], true
}

// DescribeAt uses the watch's bus connection (see the package func). A
// watch without a bus, or a dead one, answers (RoleUnknown, "").
func (w *PasswordWatch) DescribeAt(ctx context.Context, title string, x, y int) (role, name string) {
	if w == nil || !w.Live() {
		return RoleUnknown, ""
	}
	pq, ok := w.q.(pointQuery)
	if !ok {
		return RoleUnknown, ""
	}
	return DescribeAt(ctx, pq, title, x, y)
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
	w := NewPasswordWatch(busQuery{conn}) // unseeded: refuses until it knows what has focus
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
