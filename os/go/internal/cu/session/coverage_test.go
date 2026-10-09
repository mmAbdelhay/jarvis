package session

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
)

// A fullscreen window that does not resize (a fixed-size dialog such as
// GIMP's Welcome) leaves the rest of the output showing whatever is behind
// it: other apps or the shell (seen on labwc 0.8.3 with real GIMP). The
// capture keeps only the base's own area, measured through AT-SPI.

func pixel(t *testing.T, r *proto.CaptureResult, x, y int) [3]uint32 {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(r.PNGBase64)
	if err != nil {
		t.Fatal(err)
	}
	m, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	rr, gg, bb, _ := m.At(x, y).RGBA()
	return [3]uint32{rr >> 8, gg >> 8, bb >> 8}
}

func TestCaptureMasksOutsideASmallFullscreenWindow(t *testing.T) {
	h := ready(t)
	h.mu.Lock()
	h.frames["Export Image"] = [2]int{1280, 720} // half the output each way
	h.mu.Unlock()
	openDialog(h, "w4")
	r, err := h.m.Capture(proto.Capture{}) // 2560x1440 -> 1280x720
	if err != nil {
		t.Fatal(err)
	}
	if c := pixel(t, r, 100, 100); c == [3]uint32{0, 0, 0} {
		t.Fatal("the dialog's own area must show")
	}
	for _, p := range [][2]int{{700, 100}, {100, 400}, {1279, 719}} {
		if c := pixel(t, r, p[0], p[1]); c != [3]uint32{0, 0, 0} {
			t.Fatalf("outside the dialog at %v leaked %v", p, c)
		}
	}
	for _, w := range r.Windows {
		if w.WindowID == "w4" && (w.W != 640 || w.H != 360) {
			t.Fatalf("the base rect is the dialog's area: %+v", w)
		}
	}
	if got := code(h.m.Click(proto.Click{X: f(700), Y: f(100)})); got != proto.CodeOutside {
		t.Fatalf("a click beside the dialog: %q", got)
	}
	if err := h.m.Click(proto.Click{X: f(100), Y: f(100)}); err != nil {
		t.Fatal(err)
	}
}

func TestCaptureBlanksAMovedBaseOfUnknownSize(t *testing.T) {
	h := ready(t)
	h.mu.Lock()
	h.frames["Export Image"] = [2]int{0, 0} // AT-SPI cannot measure it
	h.mu.Unlock()
	openDialog(h, "w4")
	r, err := h.m.Capture(proto.Capture{})
	if err != nil {
		t.Fatal(err)
	}
	if c := pixel(t, r, 100, 100); c != [3]uint32{0, 0, 0} {
		t.Fatalf("a dialog of unknown size may not cover the screen: %v", c)
	}
	for name, err := range map[string]error{
		"key":   h.m.Key(proto.Key{Combo: "Return"}),
		"type":  h.m.Type(proto.Type{Text: strPtr("x")}),
		"click": h.m.Click(proto.Click{X: f(10), Y: f(10)}),
	} {
		if code(err) != proto.CodeOutside {
			t.Fatalf("%s into an unseen dialog: %v", name, err)
		}
	}
}

func TestFirstBaseOfUnknownSizeIsTrusted(t *testing.T) {
	// Apps without accessibility fail open (contracts §4.4, threat model):
	// the window chosen at begin is assumed to fill the screen.
	h := newHarness(t)
	h.mu.Lock()
	h.frames["beach.xcf"] = [2]int{0, 0}
	h.mu.Unlock()
	h.begin(t)
	r, err := h.m.Capture(proto.Capture{})
	if err != nil {
		t.Fatal(err)
	}
	if c := pixel(t, r, 1000, 600); c == [3]uint32{0, 0, 0} {
		t.Fatal("the begin-time base was blanked")
	}
	if err := h.m.Key(proto.Key{Combo: "ctrl+s"}); err != nil {
		t.Fatal(err)
	}
}
