package filestools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/fileops"
	"github.com/mmAbdelhay/jarvis/os/go/internal/homepath"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/trash"
)

func writeDeps(t *testing.T) (WriteDeps, string) {
	home := t.TempDir()
	n := 0
	ops := &fileops.Ops{
		Paths:   homepath.Resolver{Home: home},
		Trash:   trash.Trash{Dir: filepath.Join(home, ".local", "share", "Trash")},
		Journal: fileops.Journal{Dir: filepath.Join(home, ".local", "state", "jarvis", "files-journal")},
		Now:     func() time.Time { return time.Date(2026, 10, 9, 10, 0, 0, 0, time.UTC) },
		NewID:   func() string { n++; return fmt.Sprintf("%016x", n) },
	}
	write(t, home, "Desktop/shot.png", []byte("png"))
	write(t, home, "Documents/a.txt", []byte("a"))
	return WriteDeps{Ops: ops}, home
}

func callW(t *testing.T, w WriteDeps, name, args string) (map[string]any, error) {
	t.Helper()
	for _, tool := range WriteTools(w) {
		if tool.Name == name {
			v, err := tool.Call(context.Background(), json.RawMessage(args))
			if err != nil {
				return nil, err
			}
			b, _ := json.Marshal(v)
			var m map[string]any
			json.Unmarshal(b, &m)
			return m, nil
		}
	}
	t.Fatalf("no tool %s", name)
	return nil, nil
}

func describeW(t *testing.T, w WriteDeps, name, args string) mcp.Description {
	t.Helper()
	for _, tool := range WriteTools(w) {
		if tool.Name == name {
			d, err := tool.Describe(context.Background(), json.RawMessage(args))
			if err != nil {
				t.Fatal(err)
			}
			return d
		}
	}
	t.Fatalf("no tool %s", name)
	return mcp.Description{}
}

func TestWriteToolsMatchContract(t *testing.T) {
	var names []string
	for _, tool := range WriteTools(WriteDeps{}) {
		names = append(names, tool.Name)
		if tool.Name == "files.trash_list" {
			if tool.Risk != mcp.RiskSafe || tool.Hidden || tool.Batch != "" {
				t.Errorf("files.trash_list must be a visible safe tool")
			}
			continue
		}
		if tool.Risk != mcp.RiskConfirm || tool.Describe == nil || len(tool.Secrets) != 0 {
			t.Errorf("%s must be confirm with a Describe", tool.Name)
		}
		if tool.Name == "files.undo" {
			if !tool.Hidden || tool.Batch != "" {
				t.Errorf("files.undo is hidden and not a batch")
			}
		} else if tool.Hidden || tool.Batch != "items" {
			t.Errorf("%s: batch %q hidden %v", tool.Name, tool.Batch, tool.Hidden)
		}
	}
	want := []string{"files.move", "files.copy", "files.rename", "files.mkdir", "files.trash", "files.restore", "files.trash_list", "files.undo"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("tools %v", names)
	}
	srv := &mcp.Server{Name: "jarvis-files", Tools: append(Tools(Deps{}), WriteTools(WriteDeps{})...)}
	if err := srv.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestMoveReturnsUndoThatRestores(t *testing.T) {
	w, home := writeDeps(t)
	m, err := callW(t, w, "files.move", `{"items":[{"from":"~/Desktop/shot.png","to":"~/Pictures/"},{"from":"~/.ssh/id_rsa","to":"~/Desktop/"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(m["done"].([]any)) != 1 || len(m["failed"].([]any)) != 1 || m["journalId"] != "0000000000000001" {
		t.Fatalf("result %v", m)
	}
	undo := m["undo"].(map[string]any)
	if undo["tool"] != "files.undo" || !reflect.DeepEqual(undo["input"], map[string]any{"journalId": "0000000000000001"}) {
		t.Fatalf("undo object %v", undo)
	}
	in, _ := json.Marshal(undo["input"])
	u, err := callW(t, w, "files.undo", string(in))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "Desktop", "shot.png")); err != nil || u["undo"] != nil {
		t.Fatalf("undo did not restore: %v %v", u, err)
	}
	if _, err := callW(t, w, "files.undo", string(in)); codeOf(err) != mcp.CodeNotFound {
		t.Fatalf("second undo: %v", err)
	}
	if _, err := callW(t, w, "files.undo", `{"journalId":"../../x"}`); codeOf(err) != mcp.CodeInvalid {
		t.Fatalf("bad id: %v", err)
	}
}

func TestNothingDoneMeansNoUndo(t *testing.T) {
	w, _ := writeDeps(t)
	m, err := callW(t, w, "files.trash", `{"items":[{"from":"~/nope"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if m["journalId"] != "" || m["undo"] != nil {
		t.Fatalf("no change, no undo: %v", m)
	}
	for _, bad := range []string{`{"items":[]}`, `{"items":[{"to":"~/x"}]}`, `{"items":[{"from":"~/a","extra":1}]}`} {
		if _, err := callW(t, w, "files.copy", bad); codeOf(err) != mcp.CodeInvalid {
			t.Errorf("%s: %v", bad, err)
		}
	}
	many := `{"items":[` + strings.TrimSuffix(strings.Repeat(`{"from":"~/a"},`, 201), ",") + `]}`
	if _, err := callW(t, w, "files.trash", many); codeOf(err) != mcp.CodeInvalid {
		t.Errorf("201 items: %v", err)
	}
}

func TestDescribeCardLines(t *testing.T) {
	w, _ := writeDeps(t)
	for _, c := range []struct{ tool, args, title, detail string }{
		{"files.move", `{"items":[{"from":"~/Desktop/shot.png","to":"~/Pictures/"}]}`, "Move shot.png to ~/Pictures", "~/Desktop/shot.png → ~/Pictures"},
		{"files.copy", `{"items":[{"from":"~/Documents/a.txt","to":"~/Documents/b.txt"}]}`, "Copy a.txt to ~/Documents/b.txt", "~/Documents/a.txt → ~/Documents/b.txt"},
		{"files.rename", `{"items":[{"from":"~/Documents/a.txt","to":"notes.txt"}]}`, "Rename a.txt to notes.txt", "~/Documents/a.txt → ~/Documents/notes.txt"},
		{"files.mkdir", `{"items":[{"from":"~/Projects/new"}]}`, "Create folder ~/Projects/new", "~/Projects/new"},
		{"files.trash", `{"items":[{"from":"~/Documents/a.txt"}]}`, "Move a.txt to the trash", "~/Documents/a.txt · You can restore it from the trash, or say \"undo\"."},
		{"files.restore", `{"items":[{"from":"trash:a.txt"}]}`, "Restore a.txt from the trash", "Back to trash:a.txt"},
	} {
		d := describeW(t, w, c.tool, c.args)
		if d.Title != c.title || d.Detail != c.detail || d.Source != mcp.SourceSystem {
			t.Errorf("%s: %+v, want %q / %q", c.tool, d, c.title, c.detail)
		}
	}
	d := describeW(t, w, "files.move", `{"items":[{"from":"~/Documents/a.txt","to":"/etc/"}]}`)
	if !strings.Contains(d.Detail, "This will be refused") {
		t.Fatalf("a refused item says so on the card: %+v", d)
	}
}

func TestTrashListFindsRestorableItems(t *testing.T) {
	w, home := writeDeps(t)
	write(t, home, ".ssh/id_rsa", []byte("k"))
	write(t, home, "Documents/server.key", []byte("k"))
	for _, p := range []string{"~/Documents/a.txt", "~/Desktop/shot.png", "~/.ssh/id_rsa", "~/Documents/server.key"} {
		if _, err := callW(t, w, "files.trash", `{"items":[{"from":"`+p+`"}]}`); err != nil {
			t.Fatal(err)
		}
	}
	res, err := callW(t, w, "files.trash_list", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	items := res["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("private originals must be hidden: %v", items)
	}
	first := items[0].(map[string]any)
	if first["trash"] != "trash:a.txt" && first["trash"] != "trash:shot.png" {
		t.Fatalf("%v", first)
	}
	if first["deletedAt"] != "2026-10-09T10:00:00Z" && first["deletedAt"] != "2026-10-09T09:00:00Z" {
		t.Logf("deletedAt %v", first["deletedAt"])
	}
	res, _ = callW(t, w, "files.trash_list", `{"query":"DOCUMENTS a.txt"}`)
	got := res["items"].([]any)
	if len(got) != 1 || got[0].(map[string]any)["originalPath"] != "~/Documents/a.txt" {
		t.Fatalf("query: %v", got)
	}
	res, _ = callW(t, w, "files.trash_list", `{"limit":1}`)
	if len(res["items"].([]any)) != 1 {
		t.Fatal("limit")
	}
	if _, err := callW(t, w, "files.trash_list", `{"limit":0,"x":1}`); codeOf(err) != mcp.CodeInvalid {
		t.Fatalf("bad args: %v", err)
	}
}
