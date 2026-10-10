package policy

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// GIMP 3 runs each plug-in as its own program, and the plug-in's dialog
// (file-png's "Export Image as PNG") carries the plug-in's name as its
// Wayland app id. Allowing GIMP allows its plug-ins' windows.
func TestGIMPPluginWindowsBelongToGIMP(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{"x86_64-linux-gnu/gimp/3.0/plug-ins/file-png", "x86_64-linux-gnu/gimp/3.0/plug-ins/script-fu",
		"x86_64-linux-gnu/gimp/3.0/plug-ins/firefox", "x86_64-linux-gnu/gimp/3.0/plug-ins/kgx"} {
		if err := os.MkdirAll(filepath.Join(root, p), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	names := GIMPPlugins([]string{filepath.Join(root, "*/gimp/*/plug-ins/*"), filepath.Join(root, "missing/*")})
	if !slices.Equal(names, []string{"file-png", "firefox", "kgx", "script-fu"}) {
		t.Fatalf("plug-ins: %v", names)
	}
	x := testIndex()
	x.AddGIMPPlugins(names)
	for _, c := range []struct {
		appID   string
		allowed []string
		want    bool
	}{
		{"file-png", []string{"gimp"}, true},
		{"FILE-PNG", []string{"gimp"}, true},
		{"script-fu", []string{"gimp"}, true},
		{"file-png", []string{"org.mozilla.firefox"}, false},
		// A name that is already another app's never becomes GIMP's.
		{"firefox", []string{"gimp"}, false},
		{"firefox", []string{"org.mozilla.firefox"}, true},
		{"kgx", []string{"gimp"}, false},
	} {
		if got := x.Matches(c.appID, c.allowed); got != c.want {
			t.Errorf("Matches(%q, %v) = %v, want %v", c.appID, c.allowed, got, c.want)
		}
	}
	if ex, _ := x.Excluded("kgx"); !ex {
		t.Fatal("a terminal stays excluded")
	}
	// Without a GIMP entry nothing is added.
	y := NewAppIndex(nil)
	y.AddGIMPPlugins(names)
	if y.Matches("file-png", []string{"gimp"}) {
		t.Fatal("no GIMP installed: file-png is nobody's")
	}
}
