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
// GTK4 (gap 13, see cu/e2e/README.md): an entry with hidden text, such as
// trixie's zenity --password, reports ATSPI_ROLE_TEXT (61) with no
// distinguishing state or attribute. For a focused text or entry the watch
// therefore also reads its name, its labelled-by labels and the labels just
// before it, and treats password words there as a password field (fails
// closed; a field with no such label stays a residual risk, threat model).
const RolePasswordText = 40

const (
	roleText       = 61 // ATSPI_ROLE_TEXT
	roleEntry      = 79 // ATSPI_ROLE_ENTRY
	atspiRoleLabel = 29 // ATSPI_ROLE_LABEL
	relLabelledBy  = 2  // ATSPI_RELATION_LABELLED_BY
	labelsLookBack = 2  // siblings before the entry that may be its label
)

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
// When the watch knows of no focused control, or the one it knows lost
// focus (GTK4 sends its focus event late; an app without accessibility
// sends none), it walks the tree again rather than answer "no".
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
	if has {
		pw, focused, err := w.check(ctx, last)
		if err != nil || focused {
			return pw, err
		}
	}
	sd, ok := w.q.(Seeder)
	if !ok {
		return false, nil
	}
	a, found, err := sd.Focused(ctx)
	if err != nil {
		return false, fmt.Errorf("%w: %v", ErrNoA11y, err)
	}
	if !found {
		return false, nil
	}
	w.Focus(a, true)
	pw, _, err := w.check(ctx, a)
	return pw, err
}

// check reads one control: is it focused, and is it a password field.
func (w *PasswordWatch) check(ctx context.Context, a Accessible) (password, focused bool, err error) {
	role, err := w.q.Role(ctx, a)
	if err != nil {
		if gone(err) {
			w.Focus(a, false)
			return false, false, nil
		}
		return false, false, fmt.Errorf("%w: %v", ErrNoA11y, err)
	}
	states, err := w.q.States(ctx, a)
	if err != nil {
		if gone(err) {
			w.Focus(a, false)
			return false, false, nil
		}
		return false, false, fmt.Errorf("%w: %v", ErrNoA11y, err)
	}
	if len(states) == 0 || states[0]&(1<<stateFocused) == 0 {
		return false, false, nil
	}
	switch role {
	case RolePasswordText:
		return true, true, nil
	case roleText, roleEntry:
		lq, ok := w.q.(labelQuery)
		if !ok {
			return false, true, nil
		}
		pw, err := labelledPassword(ctx, w.q, lq, a)
		return pw, true, err
	}
	return false, true, nil
}

// labelQuery is what the GTK4 label heuristic needs from the bus.
type labelQuery interface {
	Name(ctx context.Context, a Accessible) (string, error)
	Parent(ctx context.Context, a Accessible) (Accessible, bool, error)
	children(ctx context.Context, a Accessible) ([]Accessible, error)
	LabelledBy(ctx context.Context, a Accessible) ([]Accessible, error)
}

// labelledPassword reports whether a text field is labelled as a password:
// its own name, its labelled-by labels, or a label just before it. A
// vanished object ends the search (false); any other bus error is ErrNoA11y.
func labelledPassword(ctx context.Context, q A11yQuery, lq labelQuery, a Accessible) (bool, error) {
	fail := func(err error) (bool, error) {
		if gone(err) {
			return false, nil
		}
		return false, fmt.Errorf("%w: %v", ErrNoA11y, err)
	}
	named := func(x Accessible) (bool, error) {
		n, err := lq.Name(ctx, x)
		if err != nil {
			return false, err
		}
		return passwordWords(n), nil
	}
	if hit, err := named(a); err != nil || hit {
		if err != nil {
			return fail(err)
		}
		return true, nil
	}
	labels, err := lq.LabelledBy(ctx, a)
	if err != nil {
		return fail(err)
	}
	for _, l := range labels {
		if hit, err := named(l); err != nil || hit {
			if err != nil {
				return fail(err)
			}
			return true, nil
		}
	}
	parent, ok, err := lq.Parent(ctx, a)
	if err != nil || !ok {
		if err != nil {
			return fail(err)
		}
		return false, nil
	}
	kids, err := lq.children(ctx, parent)
	if err != nil {
		return fail(err)
	}
	at := -1
	for i, k := range kids {
		if k == a {
			at = i
		}
	}
	for i := at - 1; i >= 0 && i >= at-labelsLookBack; i-- {
		r, err := q.Role(ctx, kids[i])
		if err != nil {
			return fail(err)
		}
		if r != atspiRoleLabel {
			continue
		}
		if hit, err := named(kids[i]); err != nil || hit {
			if err != nil {
				return fail(err)
			}
			return true, nil
		}
	}
	return false, nil
}

// passwordWords: English words as whole tokens (so "Passport" and "Pinned"
// do not count), Arabic phrases after alef/taa-marbuta normalisation.
func passwordWords(s string) bool {
	low := strings.ToLower(s)
	for _, tok := range strings.FieldsFunc(low, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		switch tok {
		case "password", "passwords", "passphrase", "passcode", "pin", "pincode":
			return true
		}
	}
	ar := strings.NewReplacer("ة", "ه", "أ", "ا", "إ", "ا", "آ", "ا").Replace(low)
	for _, p := range []string{"كلمه المرور", "كلمه السر", "كلمه مرور", "كلمه سر", "رمز المرور", "الرقم السري", "رمز سري"} {
		if strings.Contains(ar, p) {
			return true
		}
	}
	return false
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

// Parent reads the Accessible.Parent property; found=false for the root.
func (b busQuery) Parent(ctx context.Context, a Accessible) (Accessible, bool, error) {
	var v dbus.Variant
	err := b.conn.Object(a.Bus, a.Path).CallWithContext(ctx, "org.freedesktop.DBus.Properties.Get", 0,
		"org.a11y.atspi.Accessible", "Parent").Store(&v)
	if err != nil {
		return Accessible{}, false, err
	}
	ref, ok := v.Value().([]interface{})
	if !ok || len(ref) != 2 {
		return Accessible{}, false, errors.New("malformed parent reference")
	}
	bus, ok1 := ref[0].(string)
	path, ok2 := ref[1].(dbus.ObjectPath)
	if !ok1 || !ok2 {
		return Accessible{}, false, errors.New("malformed parent reference")
	}
	if bus == "" || path == "" || path == nullPath {
		return Accessible{}, false, nil
	}
	return Accessible{Bus: bus, Path: path}, true, nil
}

// LabelledBy reads the labelled-by targets of a's relation set.
func (b busQuery) LabelledBy(ctx context.Context, a Accessible) ([]Accessible, error) {
	var rels []struct {
		Type    uint32
		Targets []struct {
			Bus  string
			Path dbus.ObjectPath
		}
	}
	err := b.conn.Object(a.Bus, a.Path).CallWithContext(ctx, "org.a11y.atspi.Accessible.GetRelationSet", 0).Store(&rels)
	if err != nil {
		return nil, err
	}
	var out []Accessible
	for _, r := range rels {
		if r.Type != relLabelledBy {
			continue
		}
		for _, t := range r.Targets {
			if t.Bus != "" && t.Path != "" && t.Path != nullPath {
				out = append(out, Accessible{Bus: t.Bus, Path: t.Path})
			}
		}
	}
	return out, nil
}

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

// DescribeFocused names the accessible that has keyboard focus, but only
// when it belongs to the same application as the window titled title (the
// base) and still reports the focused state. V uses it before a key or a
// typed Return/space: the control that would be activated, not the one the
// model last clicked (final review, finding 3). Anything else answers
// (RoleUnknown, ""), which V treats as "ask".
func (w *PasswordWatch) DescribeFocused(ctx context.Context, title string) (role, name string) {
	if w == nil || !w.Live() || title == "" || !w.seed(ctx) {
		return RoleUnknown, ""
	}
	pq, ok := w.q.(pointQuery)
	if !ok {
		return RoleUnknown, ""
	}
	w.mu.Lock()
	var last Accessible
	has := w.last != nil
	if has {
		last = *w.last
	}
	w.mu.Unlock()
	if !has {
		return RoleUnknown, ""
	}
	st, err := pq.States(ctx, last)
	if err != nil || len(st) == 0 || st[0]&(1<<stateFocused) == 0 {
		return RoleUnknown, ""
	}
	frame, ok := findFrame(ctx, pq, title)
	if !ok || frame.Bus != last.Bus {
		return RoleUnknown, ""
	}
	r, err := pq.RoleName(ctx, last)
	r = strings.TrimSpace(r)
	if err != nil || r == "" {
		return RoleUnknown, ""
	}
	n, err := pq.Name(ctx, last)
	if err != nil {
		return RoleUnknown, ""
	}
	return clean(r, maxDescribeName), clean(n, maxDescribeName)
}

// frameQuery measures a frame (FrameSize).
type frameQuery interface {
	pointQuery
	extents(ctx context.Context, a Accessible) (x, y, w, h int32, err error)
}

func (b busQuery) extents(ctx context.Context, a Accessible) (x, y, w, h int32, err error) {
	var r struct{ X, Y, W, H int32 }
	err = b.conn.Object(a.Bus, a.Path).CallWithContext(ctx, "org.a11y.atspi.Component.GetExtents", 0,
		uint32(coordTypeWindow)).Store(&r)
	return r.X, r.Y, r.W, r.H, err
}

// FrameSize measures the window titled title (found as DescribeAt finds it)
// in logical pixels. jarvis-cu uses it to keep only the area a fullscreen
// window really covers: a window that does not resize leaves what is behind
// it on screen. ok=false whenever it cannot tell.
func (w *PasswordWatch) FrameSize(ctx context.Context, title string) (width, height int, ok bool) {
	if w == nil || !w.Live() || title == "" {
		return 0, 0, false
	}
	fq, isFrame := w.q.(frameQuery)
	if !isFrame {
		return 0, 0, false
	}
	frame, found := findFrame(ctx, fq, title)
	if !found {
		return 0, 0, false
	}
	_, _, fw, fh, err := fq.extents(ctx, frame)
	if err != nil || fw <= 0 || fh <= 0 || fw > 1<<15 || fh > 1<<15 {
		return 0, 0, false
	}
	return int(fw), int(fh), true
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

var (
	_ labelQuery = busQuery{}
	_ frameQuery = busQuery{}
)
