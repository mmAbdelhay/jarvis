package modelstate

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
)

func TestWriteReadMarker(t *testing.T) {
	root := t.TempDir()
	f := &files.OS{Root: root}
	now := time.Date(2026, 10, 8, 14, 0, 0, 0, time.FixedZone("EET", 3*3600))
	st := State{ModelID: "qwen3-8b", OllamaTag: "qwen3:8b", State: Downloading, Percent: 42, Message: "Downloading"}
	if err := Write(f, "/target", st, now); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(root, "target/var/lib/jarvis/model-state.json"))
	want := `{"modelId":"qwen3-8b","ollamaTag":"qwen3:8b","state":"downloading","percent":42,"message":"Downloading","updatedAt":"2026-10-08T11:00:00Z"}` + "\n"
	if string(b) != want {
		t.Fatalf("file = %s", b)
	}
	if fi, _ := os.Stat(filepath.Join(root, "target/var/lib/jarvis/model-state.json")); fi.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v: the greeter and jarvisd must be able to read it", fi.Mode())
	}
	got, err := Read(f, "/target")
	if err != nil || got.Percent != 42 || got.State != Downloading {
		t.Fatalf("read %+v, %v", got, err)
	}
	if err := Write(f, "/", State{State: "done"}, now); err == nil {
		t.Fatal("unknown state must be refused")
	}
	if err := Write(f, "/", State{State: Ready, Percent: 101}, now); err == nil {
		t.Fatal("percent > 100 must be refused")
	}
	if IsPending(f, "/target") {
		t.Fatal("no marker yet")
	}
	if err := MarkPending(f, "/target"); err != nil || !IsPending(f, "/target") {
		t.Fatalf("mark: %v", err)
	}
	if err := ClearPending(f, "/target"); err != nil || IsPending(f, "/target") {
		t.Fatalf("clear: %v", err)
	}
}
