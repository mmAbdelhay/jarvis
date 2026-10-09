package e2e

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/wlcu"
)

// Status: under headless labwc GTK3 apps receive no virtual-keyboard input
// (README), so this test stops at the first shortcut there; it is meant
// for a session with a real keyboard (KVM) once that is settled.
//
// TestGimpExportThroughDialogs drives real GIMP 3 on a real labwc through
// jarvis-cu alone (final review finding 1): Export As opens "Export Image",
// then "Export Image as PNG"; each dialog must become the visible base before
// a key reaches it, and the export must write the PNG. The consequential card
// in front of the last key is jarvisd's (computer-use.test.ts); here the key
// carries no card. Run via os/go/ci/cu-headless.sh with CU_E2E_GIMP=1.
func TestGimpExportThroughDialogs(t *testing.T) {
	if os.Getenv("JARVIS_CU_GIMP") != "1" {
		t.Skip("run via CU_E2E_GIMP=1 os/go/ci/cu-headless.sh")
	}
	self, _ := os.Executable()
	tmp := t.TempDir()
	sock := filepath.Join(tmp, "jarvis", "cu.sock")
	_, cuOut := start(t, os.Getenv("JARVIS_CU_BIN"), "--socket", sock, "--peer-exe", self, "--peer-script", "")
	shots := os.Getenv("JARVIS_CU_SHOTS") // optional: where to keep the captures for a human
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("jarvis-cu output:\n%s", cuOut.String())
		}
	})
	home, _ := os.UserHomeDir()
	pictures := filepath.Join(home, "Pictures")
	if err := os.MkdirAll(pictures, 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(home, "beach.png")
	writeBeach(t, src)
	out := filepath.Join(pictures, "beach-export.png")
	obs := observer(t)
	_, gimpOut := start(t, "gimp", "-n", "--no-splash", src)
	t.Cleanup(func() {
		if t.Failed() {
			out := gimpOut.String()
			t.Logf("gimp output:\n%s", out[max(0, len(out)-4000):])
		}
	})
	var main wlcu.Toplevel
	deadline := time.Now().Add(3 * time.Minute) // first start: fonts and plug-ins
	for time.Now().Before(deadline) {
		tops, _ := obs.Toplevels()
		for _, w := range tops {
			if strings.Contains(strings.ToLower(w.AppID), "gimp") && strings.Contains(w.Title, "beach") {
				main = w
			}
		}
		if main.ID != "" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if main.ID == "" {
		tops, _ := obs.Toplevels()
		t.Fatalf("no GIMP image window: %+v", tops)
	}
	t.Logf("GIMP app id %q, title %q", main.AppID, main.Title)
	time.Sleep(3 * time.Second)
	cl := connect(t, sock)
	cl.must("begin", map[string]any{"sessionId": "gimp", "appIds": []string{main.AppID}})
	n := 0
	look := func(what string) map[string]any {
		t.Helper()
		var d map[string]any
		for i := 0; i < 10; i++ { // a resize after fullscreen may take a few frames
			time.Sleep(500 * time.Millisecond)
			d = cl.must("capture", map[string]any{"maxEdge": 1280})
			if baseCentre(t, d) != [3]uint32{0, 0, 0} {
				break
			}
		}
		n++
		if shots != "" {
			b, _ := base64.StdEncoding.DecodeString(d["pngBase64"].(string))
			_ = os.WriteFile(filepath.Join(shots, strings.ReplaceAll(what, " ", "-")+".png"), b, 0o644)
		}
		if baseCentre(t, d) == [3]uint32{0, 0, 0} {
			t.Fatalf("%s: the capture stayed black", what)
		}
		t.Logf("%s: windows %v", what, d["windows"])
		return d
	}
	focusedTitle := func(sub string) wlcu.Toplevel {
		t.Helper()
		var got wlcu.Toplevel
		t.Cleanup(func() {
			if got.ID == "" {
				tops, _ := obs.Toplevels()
				t.Logf("windows while waiting for %q: %+v", sub, tops)
			}
		})
		waitFor(t, "focused "+sub, func() bool {
			tops, _ := obs.Toplevels()
			for _, w := range tops {
				if w.Focused && strings.Contains(w.Title, sub) {
					got = w
					return true
				}
			}
			return false
		})
		return got
	}
	baseIs := func(d map[string]any, id string) {
		t.Helper()
		for _, w := range d["windows"].([]any) {
			m := w.(map[string]any)
			if m["windowId"] == id && m["w"].(float64) > 0 {
				return
			}
		}
		t.Fatalf("window %s is not the base: %v", id, d["windows"])
	}
	look("first look")
	// GIMP 3 opens "Welcome to GIMP" on a first start; it had focus, so it
	// is the base now. Close it the way a model would (Escape), then the
	// image window must come back as the base before keys reach it.
	tops, _ := obs.Toplevels()
	for _, w := range tops {
		if w.Focused && strings.Contains(w.Title, "Welcome") {
			cl.must("key", map[string]any{"combo": "Escape"})
			focusedTitle("beach")
			time.Sleep(time.Second)
			if _, code := cl.do("key", map[string]any{"combo": "ctrl+shift+e"}); code != "outside" {
				t.Fatalf("a key reached the image window before a capture showed it: %q", code)
			}
		}
	}
	img := look("image")
	baseIs(img, main.ID)
	// Put keyboard focus on the canvas (an empty spot beside the image), as
	// a model would before a shortcut.
	cl.must("click", map[string]any{"x": img["width"].(float64) * 0.1, "y": img["height"].(float64) * 0.5})
	time.Sleep(500 * time.Millisecond)
	cl.must("key", map[string]any{"combo": "ctrl+shift+e"})
	exportDlg := focusedTitle("Export Image")
	time.Sleep(time.Second)
	if _, code := cl.do("key", map[string]any{"combo": "ctrl+a"}); code != "outside" {
		t.Fatalf("a key reached the unseen Export Image dialog: %q", code)
	}
	baseIs(look("export dialog"), exportDlg.ID)
	cl.must("key", map[string]any{"combo": "ctrl+a"})
	cl.must("type", map[string]any{"text": out})
	cl.must("key", map[string]any{"combo": "Return"})
	pngDlg := focusedTitle("PNG")
	time.Sleep(time.Second)
	if _, code := cl.do("key", map[string]any{"combo": "Return"}); code != "outside" {
		t.Fatalf("a key reached the unseen PNG options dialog: %q", code)
	}
	baseIs(look("png dialog"), pngDlg.ID)
	cl.must("key", map[string]any{"combo": "Return"})
	waitFor(t, out, func() bool {
		f, err := os.Open(out)
		if err != nil {
			return false
		}
		defer f.Close()
		cfg, err := png.DecodeConfig(f)
		return err == nil && cfg.Width == 640 && cfg.Height == 480
	})
	cl.must("end", nil)
	t.Logf("exported %s through %d visible captures", out, n)
}

func writeBeach(t *testing.T, path string) {
	t.Helper()
	m := image.NewRGBA(image.Rect(0, 0, 640, 480))
	for y := 0; y < 480; y++ {
		for x := 0; x < 640; x++ {
			c := color.RGBA{230, 200, 140, 255}
			if y < 300 {
				c = color.RGBA{uint8(80 + y>>2), 160, 230, 255}
			}
			m.Set(x, y, c)
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, m); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}
