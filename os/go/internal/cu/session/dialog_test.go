package session

import (
	"slices"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/wlcu"
)

// Dialog contract (final review, finding 1): what the model sees is always
// the window that gets the input. A focused dialog of an allowed app becomes
// the base and is raised; until a capture has shown it, no input is
// injected. While the window chosen at begin is fullscreen behind it, the
// dialog is not made fullscreen: GTK hides a client-side header bar in
// fullscreen, and GTK dialogs keep their buttons there.

func openDialog(h *harness, id string) {
	h.d.mu.Lock()
	h.d.tops = append(h.d.tops, wlcu.Toplevel{ID: id, AppID: "gimp", Title: "Export Image", Outputs: []string{"HEADLESS-1"}})
	h.d.mu.Unlock()
	h.d.focus(id)
}

func TestInputRefusedWhileFocusedDialogIsUnseen(t *testing.T) {
	h := ready(t) // base w1 captured
	openDialog(h, "w4")
	for name, err := range map[string]error{
		"click":  h.m.Click(proto.Click{X: f(10), Y: f(10)}),
		"type":   h.m.Type(proto.Type{Text: strPtr("beach.png")}),
		"key":    h.m.Key(proto.Key{Combo: "Return"}),
		"scroll": h.m.Scroll(proto.Scroll{X: f(10), Y: f(10), DY: 1}),
		"drag":   h.m.Drag(proto.Drag{X1: f(1), Y1: f(1), X2: f(5), Y2: f(5)}),
	} {
		if code(err) != proto.CodeOutside {
			t.Fatalf("%s: got %v", name, err)
		}
	}
	if h.d.count("button") != 0 || h.d.count("combo") != 0 || h.d.count("type") != 0 || h.d.count("scroll") != 0 {
		t.Fatalf("input reached a dialog the model has not seen: %v", h.d.logged())
	}
}

func TestCaptureMakesFocusedDialogTheBase(t *testing.T) {
	h := ready(t)
	openDialog(h, "w4")
	r, err := h.m.Capture(proto.Capture{})
	if err != nil {
		t.Fatal(err)
	}
	if !h.d.has("activate w4") {
		t.Fatalf("the dialog must be raised: %v", h.d.logged())
	}
	if h.d.has("fullscreen w4 true") {
		t.Fatalf("a dialog over the fullscreen first base keeps its header bar (not fullscreen): %v", h.d.logged())
	}
	if _, _, c := decodePNG(t, r); c == [3]uint32{0, 0, 0} {
		t.Fatal("a raised allowed dialog over the fullscreen first base must be shown")
	}
	for _, w := range r.Windows {
		if w.WindowID == "w4" && (w.W != 0 || w.Title != "Export Image") {
			t.Fatalf("the dialog is listed with its title, without a rect: %+v", w)
		}
		if w.WindowID == "w1" && (w.W != 1280 || w.H != 720) {
			t.Fatalf("the fullscreen first base fills the frame: %+v", w)
		}
	}
	if err := h.m.Key(proto.Key{Combo: "Return"}); err != nil {
		t.Fatalf("after the dialog was shown, keys go to it: %v", err)
	}
	if err := h.m.Click(proto.Click{X: f(10), Y: f(10)}); err != nil {
		t.Fatal(err)
	}
	// Closing the dialog hands focus back; the old frame showed the dialog,
	// so input waits for a new capture.
	h.d.mu.Lock()
	h.d.tops = h.d.tops[:3]
	h.d.mu.Unlock()
	h.d.focus("w1")
	if got := code(h.m.Key(proto.Key{Combo: "ctrl+s"})); got != proto.CodeOutside {
		t.Fatalf("stale frame of a closed dialog: got %q", got)
	}
	if _, err := h.m.Capture(proto.Capture{}); err != nil {
		t.Fatal(err)
	}
	if err := h.m.Key(proto.Key{Combo: "ctrl+s"}); err != nil {
		t.Fatal(err)
	}
	h.m.End()
	if !h.d.has("fullscreen w1 false") {
		t.Fatalf("end restores the main window: %v", h.d.logged())
	}
}

func TestDialogOverAFirstBaseThatLeftFullscreenIsBlank(t *testing.T) {
	h := ready(t)
	h.d.set("w1", func(w *wlcu.Toplevel) { w.Fullscreen = false }) // the user or app left fullscreen
	h.d.mu.Lock()
	h.d.ignoreFullscreen = true
	h.d.mu.Unlock()
	openDialog(h, "w4")
	r, err := h.m.Capture(proto.Capture{})
	if err != nil {
		t.Fatal(err)
	}
	if !h.d.has("fullscreen w1 true") {
		t.Fatalf("the first base is made fullscreen again: %v", h.d.logged())
	}
	if _, _, c := decodePNG(t, r); c != [3]uint32{0, 0, 0} {
		t.Fatalf("a dialog with nothing fullscreen behind it may sit beside other windows: %v", c)
	}
	if got := code(h.m.Key(proto.Key{Combo: "Return"})); got != proto.CodeOutside {
		t.Fatalf("got %q", got)
	}
}

func closeFirstBase(h *harness) {
	h.d.mu.Lock()
	h.d.tops = slices.DeleteFunc(h.d.tops, func(w wlcu.Toplevel) bool { return w.ID == "w1" })
	h.d.mu.Unlock()
}

func TestDialogWithoutTheFirstBaseIsMadeFullscreen(t *testing.T) {
	h := ready(t)
	closeFirstBase(h)
	openDialog(h, "w4")
	r, err := h.m.Capture(proto.Capture{})
	if err != nil {
		t.Fatal(err)
	}
	if !h.d.has("fullscreen w4 true") {
		t.Fatalf("with the first base gone the (focused) dialog must be made fullscreen: %v", h.d.logged())
	}
	if _, _, c := decodePNG(t, r); c == [3]uint32{0, 0, 0} {
		t.Fatal("a raised, fullscreen allowed dialog must be shown")
	}
}

func TestDialogThatRefusesFullscreenStaysBlank(t *testing.T) {
	h := ready(t)
	closeFirstBase(h)
	h.d.mu.Lock()
	h.d.ignoreFullscreen = true
	h.d.mu.Unlock()
	openDialog(h, "w4")
	r, err := h.m.Capture(proto.Capture{})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, c := decodePNG(t, r); c != [3]uint32{0, 0, 0} {
		t.Fatalf("a dialog that is not fullscreen may sit beside other windows: %v", c)
	}
	if got := code(h.m.Key(proto.Key{Combo: "Return"})); got != proto.CodeOutside {
		t.Fatalf("got %q", got)
	}
}

func TestStaleFocusedDialogBehindFullscreenBaseIsNeverShown(t *testing.T) {
	// The reviewer's case: the base stays fullscreen and on top while an
	// allowed dialog has keyboard focus. Without making the dialog the base
	// the frame would show the base while keys went to the dialog.
	h := ready(t)
	openDialog(h, "w4")
	v, err := h.m.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if h.m.visible(v) {
		t.Fatal("visible() accepted a focused window that is not the base")
	}
}
