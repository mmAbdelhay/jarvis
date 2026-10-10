package guard

import (
	"context"
	"testing"
)

// focusQuery is a fakePoint that also answers numeric roles (A11yQuery).
type focusQuery struct{ *fakePoint }

func (f focusQuery) Role(context.Context, Accessible) (uint32, error) { return 61, nil }

func TestDescribeFocusedNamesTheFocusedControlOfTheBase(t *testing.T) {
	f := newFakePoint()
	other := f.window(":1.7", "Inbox", true)
	f.window(":1.8", "Export Image", true)
	btn := Accessible{":1.8", "/export"}
	f.roles[btn] = "push button"
	f.names[btn] = "Export"
	f.states[btn] = []uint32{1 << stateFocused}
	w := NewPasswordWatch(focusQuery{f})
	ctx := context.Background()
	if r, _ := w.DescribeFocused(ctx, "Export Image"); r != RoleUnknown {
		t.Fatalf("nothing focused yet: %q", r)
	}
	w.Focus(btn, true)
	if r, n := w.DescribeFocused(ctx, "Export Image"); r != "push button" || n != "Export" {
		t.Fatalf("got %q %q", r, n)
	}
	// Focus belongs to another app's window: never describe it as the base's.
	if r, _ := w.DescribeFocused(ctx, "Inbox"); r != RoleUnknown {
		t.Fatalf("focus of another app reported: %q", r)
	}
	_ = other
	// The focused state was lost without an event (window deactivated).
	f.states[btn] = []uint32{0}
	if r, _ := w.DescribeFocused(ctx, "Export Image"); r != RoleUnknown {
		t.Fatalf("stale focus reported: %q", r)
	}
	f.states[btn] = []uint32{1 << stateFocused}
	// No matching window, a dead watch, a nil watch.
	if r, _ := w.DescribeFocused(ctx, "Nope"); r != RoleUnknown {
		t.Fatal("no frame must answer unknown")
	}
	var nilW *PasswordWatch
	if r, _ := nilW.DescribeFocused(ctx, "Export Image"); r != RoleUnknown {
		t.Fatal("nil watch")
	}
	w.mu.Lock()
	w.live = false
	w.mu.Unlock()
	if r, _ := w.DescribeFocused(ctx, "Export Image"); r != RoleUnknown {
		t.Fatal("dead watch")
	}
}
