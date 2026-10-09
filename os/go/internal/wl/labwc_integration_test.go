package wl

import (
	"os"
	"runtime"
	"testing"
	"time"
)

// TestAgainstARealCompositor runs only in Linux CI (Plan P starts a
// headless labwc with a terminal open and sets JARVIS_WL_INTEGRATION=1).
// The developer Mac has no Wayland compositor.
func TestAgainstARealCompositor(t *testing.T) {
	if runtime.GOOS != "linux" || os.Getenv("JARVIS_WL_INTEGRATION") != "1" {
		t.Skip("set JARVIS_WL_INTEGRATION=1 with a running labwc (Linux CI only)")
	}
	path, err := SocketPath(os.Getenv, os.ReadDir)
	if err != nil {
		t.Fatal(err)
	}
	c, err := Dial(path, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ws, err := c.Windows()
	if err != nil {
		t.Fatal(err)
	}
	if len(ws) == 0 {
		t.Fatal("CI opens one window before this test; none listed")
	}
	if err := c.Activate(ws[0].ID); err != nil {
		t.Fatal(err)
	}
	ws, err = c.Windows()
	if err != nil || !ws[0].Focused {
		t.Fatalf("after activate: %+v %v", ws, err)
	}
}
