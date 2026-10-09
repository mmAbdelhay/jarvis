package session

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image/png"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/wlcu"
)

func TestBeginFocusesAndFullscreensTheBase(t *testing.T) {
	h := newHarness(t)
	h.begin(t)
	if !h.d.has("activate w1") || !h.d.has("fullscreen w1 true") {
		t.Fatalf("log %v", h.d.logged())
	}
	ws, err := h.m.Windows()
	if err != nil {
		t.Fatal(err)
	}
	if len(ws) != 3 || !ws[0].Allowed || !ws[0].Focused || ws[1].Allowed || ws[2].Allowed {
		t.Fatalf("%+v", ws)
	}
	if ws[1].Title != "" || ws[2].Title != "" || ws[0].Title != "beach.xcf" {
		t.Fatalf("non-allowed titles must be redacted: %+v", ws)
	}
}

func TestBeginRefusals(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		name string
		p    proto.Begin
		want string
	}{
		{"no session id", proto.Begin{AppIDs: []string{"gimp"}}, proto.CodeFailed},
		{"no apps", proto.Begin{SessionID: "s1"}, proto.CodeFailed},
		{"terminal", proto.Begin{SessionID: "s1", AppIDs: []string{"foot"}}, proto.CodeExcluded},
		{"shell", proto.Begin{SessionID: "s1", AppIDs: []string{"jarvis-shell"}}, proto.CodeExcluded},
	}
	for _, c := range cases {
		if got := code(h.m.Begin(c.p)); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
	h.locked = true
	if got := code(h.m.Begin(proto.Begin{SessionID: "s1", AppIDs: []string{"gimp"}})); got != proto.CodeExcluded {
		t.Fatalf("locked: %q", got)
	}
	h.locked = false
	h.begin(t)
	if got := code(h.m.Begin(proto.Begin{SessionID: "s2", AppIDs: []string{"gimp"}})); got != proto.CodeFailed {
		t.Fatalf("second session: %q", got)
	}
	if got := code(h.m.Begin(proto.Begin{SessionID: "s1", AppIDs: []string{"gimp", "org.mozilla.firefox"}})); got != proto.CodeFailed {
		t.Fatalf("resume with other apps: %q", got)
	}
}

func TestBeginUnsupportedWhenSeatNeverIdles(t *testing.T) {
	h := newHarness(t)
	h.act.armErr = errors.New("never idle")
	err := h.m.Begin(proto.Begin{SessionID: "s1", AppIDs: []string{"gimp"}})
	if code(err) != proto.CodeUnsupported {
		t.Fatalf("got %v", err)
	}
	if h.d.count("fullscreen") != 0 {
		t.Fatal("a refused begin must not touch windows")
	}
	if _, err := h.m.Capture(proto.Capture{}); code(err) != proto.CodeNoSession {
		t.Fatal("no session must exist after a refused begin")
	}
}

func decodePNG(t *testing.T, r *proto.CaptureResult) (w, h int, centre [3]uint32) {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(r.PNGBase64)
	if err != nil {
		t.Fatal(err)
	}
	m, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	rr, gg, bb, _ := m.At(m.Bounds().Dx()/2, m.Bounds().Dy()/2).RGBA()
	return m.Bounds().Dx(), m.Bounds().Dy(), [3]uint32{rr >> 8, gg >> 8, bb >> 8}
}

func TestCaptureDownscalesAndShowsTheAllowedApp(t *testing.T) {
	h := newHarness(t)
	h.begin(t)
	r, err := h.m.Capture(proto.Capture{})
	if err != nil {
		t.Fatal(err)
	}
	w, hh, c := decodePNG(t, r)
	if w != 1280 || hh != 720 || r.Width != 1280 || r.Height != 720 || r.Scale != 0.5 {
		t.Fatalf("%dx%d %+v", w, hh, r)
	}
	if c != [3]uint32{100, 150, 200} {
		t.Fatalf("allowed content hidden: %v", c)
	}
	base := r.Windows[0]
	if base.WindowID != "w1" || base.X != 0 || base.Y != 0 || base.W != 1280 || base.H != 720 {
		t.Fatalf("base rect %+v", base)
	}
	if other := r.Windows[2]; other.W != 0 || other.Title != "" {
		t.Fatalf("other windows have no rect and no title: %+v", other)
	}
	for _, b := range h.d.lastPix {
		if b != 0 {
			t.Fatal("the raw frame was not wiped")
		}
	}
}

func TestCaptureBlanksWhenFocusIsNotAllowed(t *testing.T) {
	for _, id := range []string{"w2", "w3", ""} {
		h := newHarness(t)
		h.begin(t)
		h.d.focus(id) // terminal, other app, or nothing (shell / layer surface)
		r, err := h.m.Capture(proto.Capture{MaxEdge: 640})
		if err != nil {
			t.Fatal(err)
		}
		w, _, c := decodePNG(t, r)
		if w != 640 || c != [3]uint32{0, 0, 0} {
			t.Fatalf("focus %q: width %d centre %v", id, w, c)
		}
	}
}

func TestCaptureBlanksWhenBaseIsNotFullscreen(t *testing.T) {
	h := newHarness(t)
	h.d.ignoreFullscreen = true // the app refuses fullscreen
	h.begin(t)
	r, err := h.m.Capture(proto.Capture{})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, c := decodePNG(t, r); c != [3]uint32{0, 0, 0} {
		t.Fatal("geometry unknown, so nothing may be shown")
	}
	if r.Windows[0].W != 0 {
		t.Fatal("no rect without fullscreen")
	}
}

func TestCaptureWithNoAllowedWindowYet(t *testing.T) {
	h := newHarness(t)
	if err := h.m.Begin(proto.Begin{SessionID: "s1", AppIDs: []string{"org.inkscape.Inkscape"}}); err != nil {
		t.Fatal(err)
	}
	r, err := h.m.Capture(proto.Capture{})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, c := decodePNG(t, r); c != [3]uint32{0, 0, 0} {
		t.Fatal("no allowed window, nothing to show")
	}
	h.d.mu.Lock()
	h.d.tops = append(h.d.tops, wlcu.Toplevel{ID: "w4", AppID: "org.inkscape.Inkscape", Title: "drawing.svg", Focused: true, Outputs: []string{"HEADLESS-1"}})
	for i := range h.d.tops[:3] {
		h.d.tops[i].Focused = false
	}
	h.d.mu.Unlock()
	r, _ = h.m.Capture(proto.Capture{})
	if _, _, c := decodePNG(t, r); c == [3]uint32{0, 0, 0} {
		t.Fatal("a newly opened allowed window must become the base")
	}
	if !h.d.has("fullscreen w4 true") {
		t.Fatal(h.d.logged())
	}
}

func TestMaxEdgeClamp(t *testing.T) {
	cases := map[int]int{0: 1280, -5: 1280, 100: 320, 900: 900, 5000: 1920}
	for in, want := range cases {
		if got := clampEdge(in); got != want {
			t.Errorf("clampEdge(%d) = %d want %d", in, got, want)
		}
	}
}

func TestPauseAndResume(t *testing.T) {
	h := newHarness(t)
	h.begin(t)
	h.m.Pause(proto.ReasonPhysicalInput)
	h.m.Pause(proto.ReasonPhysicalInput)
	if ev := h.pushed(); len(ev) != 1 || ev[0] != (proto.Event{Event: "paused", Reason: "physical-input"}) {
		t.Fatalf("events %+v", ev)
	}
	if _, err := h.m.Capture(proto.Capture{}); code(err) != proto.CodePaused {
		t.Fatalf("paused capture: %v", err)
	}
	h.begin(t) // resume: same id, same apps
	if _, err := h.m.Capture(proto.Capture{}); err != nil {
		t.Fatalf("after resume: %v", err)
	}
}

func TestPauseWithoutSessionIsSilent(t *testing.T) {
	h := newHarness(t)
	h.m.Pause(proto.ReasonPhysicalInput)
	if len(h.pushed()) != 0 {
		t.Fatal("no session, no event")
	}
}

func TestEndRestoresFullscreen(t *testing.T) {
	h := newHarness(t)
	h.begin(t)
	h.m.End()
	if !h.d.has("fullscreen w1 false") {
		t.Fatal(h.d.logged())
	}
	if _, err := h.m.Capture(proto.Capture{}); code(err) != proto.CodeNoSession {
		t.Fatal(err)
	}
	h.m.End() // twice is fine
	if h.d.count("fullscreen w1 false") != 1 {
		t.Fatal("restored twice")
	}
}

func TestEndLeavesAlreadyFullscreenWindowsAlone(t *testing.T) {
	h := newHarness(t)
	h.d.set("w1", func(t *wlcu.Toplevel) { t.Fullscreen = true })
	h.begin(t)
	h.m.End()
	if h.d.count("fullscreen w1") != 0 {
		t.Fatal("the helper did not fullscreen it, so it must not unfullscreen it")
	}
}

func TestFocusChangedPausesOnExcludedFocus(t *testing.T) {
	h := newHarness(t)
	h.begin(t)
	h.d.focus("w3") // another app: not excluded, no pause (capture blanks instead)
	h.m.FocusChanged()
	if len(h.pushed()) != 0 {
		t.Fatal("a non-excluded app must not pause")
	}
	h.d.focus("w2") // terminal
	h.m.FocusChanged()
	if ev := h.pushed(); len(ev) != 1 || ev[0].Reason != proto.ReasonExcludedFocus {
		t.Fatalf("%+v", ev)
	}
	h2 := newHarness(t)
	h2.begin(t)
	h2.d.focus("") // shell / lock / layer surface has the keyboard
	h2.m.FocusChanged()
	if ev := h2.pushed(); len(ev) != 1 || ev[0].Reason != proto.ReasonExcludedFocus {
		t.Fatalf("%+v", ev)
	}
}

func TestLockedNowPausesAndEnds(t *testing.T) {
	h := newHarness(t)
	h.begin(t)
	h.m.LockedNow()
	if ev := h.pushed(); len(ev) != 1 || ev[0].Reason != proto.ReasonLocked {
		t.Fatalf("%+v", ev)
	}
	deadline := time.Now().Add(time.Second)
	for !h.d.has("fullscreen w1 false") {
		if time.Now().After(deadline) {
			t.Fatal("session not ended after lock")
		}
		time.Sleep(time.Millisecond)
	}
}
