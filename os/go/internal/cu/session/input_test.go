package session

import (
	"errors"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/wlcu"
)

func f(v float64) *float64 { return &v }

func ready(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	h.begin(t)
	if _, err := h.m.Capture(proto.Capture{}); err != nil { // 2560x1440 -> 1280x720
		t.Fatal(err)
	}
	return h
}

func TestClickMapsCaptureSpaceToOutput(t *testing.T) {
	h := ready(t)
	if err := h.m.Click(proto.Click{X: f(640), Y: f(360.7)}); err != nil {
		t.Fatal(err)
	}
	want := []string{"move 1280 721 2560 1440", "button 0x110 true", "button 0x110 false"}
	got := h.d.logged()[len(h.d.logged())-3:]
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %v", got)
	}
	if h.act.begins != 1 || h.act.ends != 1 {
		t.Fatal("injection must be bracketed by the activity detector")
	}
}

func TestDoubleRightClick(t *testing.T) {
	h := ready(t)
	if err := h.m.Click(proto.Click{X: f(1), Y: f(1), Button: "right", Double: true}); err != nil {
		t.Fatal(err)
	}
	if h.d.count("button 0x111 true") != 2 || h.d.count("button 0x111 false") != 2 {
		t.Fatal(h.d.logged())
	}
}

func TestClickRefusals(t *testing.T) {
	cases := []struct {
		name  string
		setup func(h *harness)
		click proto.Click
		want  string
	}{
		{"right edge", nil, proto.Click{X: f(1280), Y: f(10)}, proto.CodeOutside},
		{"negative", nil, proto.Click{X: f(-1), Y: f(10)}, proto.CodeOutside},
		{"below", nil, proto.Click{X: f(10), Y: f(720)}, proto.CodeOutside},
		{"missing x", nil, proto.Click{Y: f(10)}, proto.CodeFailed},
		{"bad button", nil, proto.Click{X: f(1), Y: f(1), Button: "back"}, proto.CodeFailed},
		{"terminal focused", func(h *harness) { h.d.focus("w2") }, proto.Click{X: f(1), Y: f(1)}, proto.CodeExcluded},
		{"shell focused", func(h *harness) { h.d.focus("") }, proto.Click{X: f(1), Y: f(1)}, proto.CodeExcluded},
		{"other app focused", func(h *harness) { h.d.focus("w3") }, proto.Click{X: f(1), Y: f(1)}, proto.CodeOutside},
		{"password field", func(h *harness) { h.pw = true }, proto.Click{X: f(1), Y: f(1)}, proto.CodeExcluded},
		{"paused", func(h *harness) { h.m.Pause(proto.ReasonPhysicalInput) }, proto.Click{X: f(1), Y: f(1)}, proto.CodePaused},
		{"physical input at inject", func(h *harness) { h.act.beginErr = errors.New("busy") }, proto.Click{X: f(1), Y: f(1)}, proto.CodePaused},
		{"op budget spent", func(h *harness) { h.m.s.ops = MaxInputOps }, proto.Click{X: f(1), Y: f(1)}, proto.CodeFailed},
	}
	for _, c := range cases {
		h := ready(t)
		if c.setup != nil {
			c.setup(h)
		}
		before := h.d.count("button")
		if got := code(h.m.Click(c.click)); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
		if h.d.count("button") != before {
			t.Errorf("%s: a refused click pressed a button", c.name)
		}
	}
}

func TestClickBeforeCaptureFails(t *testing.T) {
	h := newHarness(t)
	h.begin(t)
	if got := code(h.m.Click(proto.Click{X: f(1), Y: f(1)})); got != proto.CodeFailed {
		t.Fatalf("got %q", got)
	}
}

func TestClickWithoutSession(t *testing.T) {
	h := newHarness(t)
	if got := code(h.m.Click(proto.Click{X: f(1), Y: f(1)})); got != proto.CodeNoSession {
		t.Fatalf("got %q", got)
	}
}

func TestClickRefusesAfterResolutionChange(t *testing.T) {
	h := ready(t)
	h.d.mu.Lock()
	h.d.outs[0].Width, h.d.outs[0].Height = 1920, 1080
	h.d.mu.Unlock()
	err := h.m.Click(proto.Click{X: f(10), Y: f(10)})
	if code(err) != proto.CodeFailed || !strings.Contains(err.Error(), "capture again") {
		t.Fatalf("got %v", err)
	}
}

func TestClickRefusesWhenBaseLeftFullscreen(t *testing.T) {
	h := ready(t)
	h.d.set("w1", func(t *wlcu.Toplevel) { t.Fullscreen = false })
	if got := code(h.m.Click(proto.Click{X: f(10), Y: f(10)})); got != proto.CodeOutside {
		t.Fatalf("got %q", got)
	}
}

func TestClickRechecksFocusAfterMove(t *testing.T) {
	h := ready(t)
	h.d.onMove = func() { h.d.focus("w3") } // a non-allowed window grabs focus
	if got := code(h.m.Click(proto.Click{X: f(10), Y: f(10)})); got != proto.CodeOutside {
		t.Fatalf("got %q", got)
	}
	if h.d.count("button") != 0 {
		t.Fatal("the click landed after focus moved")
	}
	if h.act.ends != h.act.begins {
		t.Fatal("End must follow Begin even on refusal")
	}
}

func TestLockedBeforeInputEndsSession(t *testing.T) {
	h := ready(t)
	h.locked = true
	if got := code(h.m.Type(proto.Type{Text: strPtr("hi")})); got != proto.CodeExcluded {
		t.Fatalf("got %q", got)
	}
	if ev := h.pushed(); len(ev) != 1 || ev[0].Reason != proto.ReasonLocked {
		t.Fatalf("%+v", ev)
	}
	if h.d.count("type") != 0 {
		t.Fatal("typed into the lock screen")
	}
}

func strPtr(s string) *string { return &s }

func TestTypeRegatesEveryChunk(t *testing.T) {
	h := ready(t)
	text := strings.Repeat("a", 130) // 3 chunks: 64, 64, 2
	h.d.onType = func(call int) {
		if call == 1 {
			h.d.focus("w3")
		}
	}
	err := h.m.Type(proto.Type{Text: &text})
	if code(err) != proto.CodeOutside || !strings.Contains(err.Error(), "64 of 130") {
		t.Fatalf("got %v", err)
	}
	if h.d.count("type") != 1 {
		t.Fatalf("typed %d chunks after focus moved", h.d.count("type"))
	}
}

func TestTypeArabic(t *testing.T) {
	h := ready(t)
	if err := h.m.Type(proto.Type{Text: strPtr("سلام\n")}); err != nil {
		t.Fatal(err)
	}
	if !h.d.has("type 5 U0633,U0644,U0627,U0645,Return") {
		t.Fatal(h.d.logged())
	}
}

func TestKeyboardRefusedWhenPasswordCheckUnavailable(t *testing.T) {
	h := ready(t)
	h.pwErr = errors.New("no a11y bus")
	if got := code(h.m.Type(proto.Type{Text: strPtr("x")})); got != proto.CodeExcluded {
		t.Fatalf("type: %q", got)
	}
	if got := code(h.m.Key(proto.Key{Combo: "ctrl+s"})); got != proto.CodeExcluded {
		t.Fatalf("key: %q", got)
	}
	if err := h.m.Click(proto.Click{X: f(1), Y: f(1)}); err != nil {
		t.Fatalf("clicks still work: %v", err)
	}
}

func TestTypeAndKeyValidation(t *testing.T) {
	h := ready(t)
	if got := code(h.m.Type(proto.Type{})); got != proto.CodeFailed {
		t.Fatalf("missing text: %q", got)
	}
	if got := code(h.m.Type(proto.Type{Text: strPtr("a\x1b")})); got != proto.CodeFailed {
		t.Fatalf("escape char: %q", got)
	}
	if got := code(h.m.Key(proto.Key{Combo: "super+l"})); got != proto.CodeExcluded {
		t.Fatalf("super: %q", got)
	}
	if got := code(h.m.Key(proto.Key{Combo: "ctrl+alt+t"})); got != proto.CodeExcluded {
		t.Fatalf("ctrl+alt: %q", got)
	}
	if h.d.count("combo") != 0 {
		t.Fatal("refused combos reached the keyboard")
	}
	if err := h.m.Key(proto.Key{Combo: "ctrl+shift+s"}); err != nil {
		t.Fatal(err)
	}
	if !h.d.has("combo 5 s") {
		t.Fatal(h.d.logged())
	}
}

func TestScroll(t *testing.T) {
	h := ready(t)
	for _, s := range []proto.Scroll{
		{X: f(1), Y: f(1), DY: 11},
		{X: f(1), Y: f(1), DX: -11},
		{X: f(1), Y: f(1)},
	} {
		if got := code(h.m.Scroll(s)); got != proto.CodeFailed {
			t.Errorf("%+v: %q", s, got)
		}
	}
	if err := h.m.Scroll(proto.Scroll{X: f(100), Y: f(50), DY: 3}); err != nil {
		t.Fatal(err)
	}
	if !h.d.has("move 200 100 2560 1440") || !h.d.has("scroll 0 3") {
		t.Fatal(h.d.logged())
	}
}

func TestDrag(t *testing.T) {
	h := ready(t)
	if err := h.m.Drag(proto.Drag{X1: f(0), Y1: f(0), X2: f(120), Y2: f(60)}); err != nil {
		t.Fatal(err)
	}
	l := h.d.logged()
	if !h.d.has("move 0 0 2560 1440") || !h.d.has("move 240 120 2560 1440") ||
		h.d.count("move") != 1+dragSteps || l[len(l)-1] != "button 0x110 false" {
		t.Fatal(l)
	}
	if got := code(h.m.Drag(proto.Drag{X1: f(0), Y1: f(0), X2: f(5000), Y2: f(0)})); got != proto.CodeOutside {
		t.Fatalf("end point outside: %q", got)
	}
}

func TestDragAlwaysReleases(t *testing.T) {
	h := ready(t)
	h.d.moveFails = 4 // fail in the middle of the drag
	if err := h.m.Drag(proto.Drag{X1: f(0), Y1: f(0), X2: f(120), Y2: f(60)}); err == nil {
		t.Fatal("error swallowed")
	}
	if h.d.count("button 0x110 true") != 1 || h.d.count("button 0x110 false") != 1 {
		t.Fatalf("button left pressed: %v", h.d.logged())
	}
}
