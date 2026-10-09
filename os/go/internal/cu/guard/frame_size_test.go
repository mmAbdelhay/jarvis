package guard

import (
	"context"
	"errors"
	"testing"
)

// sized is a fakePoint that also answers Component.GetExtents.
type sized struct {
	*fakePoint
	ext map[Accessible][4]int32
	err error
}

func (s sized) Role(context.Context, Accessible) (uint32, error) { return 0, nil }

func (s sized) extents(_ context.Context, a Accessible) (x, y, w, h int32, err error) {
	if s.err != nil {
		return 0, 0, 0, 0, s.err
	}
	e, ok := s.ext[a]
	if !ok {
		return 0, 0, 0, 0, errors.New("no extents")
	}
	return e[0], e[1], e[2], e[3], nil
}

func TestFrameSize(t *testing.T) {
	f := newFakePoint()
	dlg := f.window(":1.8", "Welcome to GIMP 3.0.4", true)
	q := sized{fakePoint: f, ext: map[Accessible][4]int32{dlg: {0, 0, 695, 613}}}
	w := NewPasswordWatch(q)
	ctx := context.Background()
	if fw, fh, ok := w.FrameSize(ctx, "Welcome to GIMP 3.0.4"); !ok || fw != 695 || fh != 613 {
		t.Fatalf("got %d %d %v", fw, fh, ok)
	}
	if _, _, ok := w.FrameSize(ctx, "Nope"); ok {
		t.Fatal("no such window")
	}
	q.err = errors.New("timeout")
	if _, _, ok := NewPasswordWatch(q).FrameSize(ctx, "Welcome to GIMP 3.0.4"); ok {
		t.Fatal("a bus error is unknown")
	}
	q.err = nil
	q.ext[dlg] = [4]int32{0, 0, 0, 0}
	if _, _, ok := NewPasswordWatch(q).FrameSize(ctx, "Welcome to GIMP 3.0.4"); ok {
		t.Fatal("an empty frame is unknown")
	}
	var nilW *PasswordWatch
	if _, _, ok := nilW.FrameSize(ctx, "x"); ok {
		t.Fatal("nil watch")
	}
}
