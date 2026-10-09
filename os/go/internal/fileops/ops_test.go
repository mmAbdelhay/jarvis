package fileops

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/homepath"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/trash"
)

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, home, rel, data string) {
	t.Helper()
	p := filepath.Join(home, rel)
	must(t, os.MkdirAll(filepath.Dir(p), 0o755))
	must(t, os.WriteFile(p, []byte(data), 0o644))
}

func read(t *testing.T, home, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(home, rel))
	if err != nil {
		return "<missing>"
	}
	return string(b)
}

func exists(home, rel string) bool {
	_, err := os.Lstat(filepath.Join(home, rel))
	return err == nil
}

// newOps builds Ops over a fresh home with a deterministic id sequence.
func newOps(t *testing.T) (*Ops, string, string) {
	home, outside := t.TempDir(), t.TempDir()
	n := 0
	o := &Ops{
		Paths:   homepath.Resolver{Home: home},
		Trash:   trash.Trash{Dir: filepath.Join(home, ".local", "share", "Trash")},
		Journal: Journal{Dir: filepath.Join(home, ".local", "state", "jarvis", "files-journal")},
		Now:     func() time.Time { return time.Date(2026, 10, 9, 10, 0, 0, 0, time.UTC) },
		NewID: func() string {
			n++
			return fmt.Sprintf("%016x", n)
		},
	}
	write(t, home, "Desktop/shot1.png", "one")
	write(t, home, "Desktop/shot2.png", "two")
	write(t, home, "Documents/report.txt", "report")
	write(t, home, "Projects/app/main.go", "package main")
	write(t, outside, "secret.txt", "outside")
	must(t, os.Symlink(outside, filepath.Join(home, "Out")))
	return o, home, outside
}

func TestMoveIntoNewFolderAndUndo(t *testing.T) {
	o, home, _ := newOps(t)
	res := o.Run(Move, []Item{{From: "~/Desktop/shot1.png", To: "~/Pictures/Screenshots/"}, {From: "~/Desktop/shot2.png", To: "~/Pictures/Screenshots/"}})
	if len(res.Failed) != 0 || len(res.Done) != 2 || res.JournalID == "" {
		t.Fatalf("result %+v", res)
	}
	if res.Done[0] != (Done{Kind: Move, From: "~/Desktop/shot1.png", To: "~/Pictures/Screenshots/shot1.png"}) {
		t.Fatalf("done %+v", res.Done[0])
	}
	if read(t, home, "Pictures/Screenshots/shot2.png") != "two" || exists(home, "Desktop/shot1.png") {
		t.Fatal("files did not move")
	}
	undo, err := o.Undo(res.JournalID)
	must(t, err)
	if len(undo.Failed) != 0 || undo.JournalID != "" {
		t.Fatalf("undo %+v", undo)
	}
	if read(t, home, "Desktop/shot1.png") != "one" || exists(home, "Pictures") {
		t.Fatal("undo must move back and remove the folders it created")
	}
	if _, err := o.Undo(res.JournalID); err != ErrNoJournal {
		t.Fatalf("second undo: %v", err)
	}
}

func TestMoveRefusals(t *testing.T) {
	o, home, outside := newOps(t)
	must(t, os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(home, "Documents", "escape.txt")))
	cases := []struct {
		item Item
		code mcp.Code
	}{
		{Item{From: "~/Documents/report.txt", To: "~/Out/"}, mcp.CodeDenied},
		{Item{From: "~/Documents/escape.txt", To: "~/Desktop/"}, mcp.CodeDenied},
		{Item{From: "~/Out/secret.txt", To: "~/Desktop/"}, mcp.CodeDenied},
		{Item{From: "~/Documents/report.txt", To: "~/.config/autostart/"}, mcp.CodeDenied},
		{Item{From: "~/.bashrc", To: "~/Desktop/"}, mcp.CodeDenied},
		{Item{From: "~", To: "~/Desktop/"}, mcp.CodeDenied},
		{Item{From: "~/Projects", To: "~/Projects/app/"}, mcp.CodeInvalid},
		{Item{From: "~/Desktop/shot1.png", To: "~/Desktop/shot2.png"}, mcp.CodeInvalid},
		{Item{From: "~/Desktop/shot1.png"}, mcp.CodeInvalid},
		{Item{From: "/etc/passwd", To: "~/Desktop/"}, mcp.CodeInvalid},
		{Item{From: "~/missing", To: "~/Desktop/"}, mcp.CodeNotFound},
	}
	for _, c := range cases {
		res := o.Run(Move, []Item{c.item})
		if len(res.Failed) != 1 || res.Failed[0].Code != c.code || res.JournalID != "" {
			t.Errorf("%+v: %+v, want %s", c.item, res, c.code)
		}
	}
	if read(t, home, "Desktop/shot2.png") != "two" || read(t, outside, "secret.txt") != "outside" {
		t.Fatal("a refused move changed something")
	}
}

func TestCopyRenameMkdirAndUndo(t *testing.T) {
	o, home, _ := newOps(t)
	must(t, os.Symlink("main.go", filepath.Join(home, "Projects", "app", "link.go")))
	cp := o.Run(Copy, []Item{{From: "~/Projects/app", To: "~/Backup/app-copy"}})
	if len(cp.Failed) != 0 || read(t, home, "Backup/app-copy/main.go") != "package main" {
		t.Fatalf("copy %+v", cp)
	}
	if l, _ := os.Readlink(filepath.Join(home, "Backup", "app-copy", "link.go")); l != "main.go" {
		t.Fatalf("links are copied as links: %q", l)
	}
	ents, _ := os.ReadDir(filepath.Join(home, "Backup"))
	if len(ents) != 1 {
		t.Fatalf("no partial copy is left behind: %v", ents)
	}
	rn := o.Run(Rename, []Item{{From: "~/Documents/report.txt", To: "report-2026.txt"}})
	if len(rn.Failed) != 0 || read(t, home, "Documents/report-2026.txt") != "report" {
		t.Fatalf("rename %+v", rn)
	}
	for _, bad := range []string{"../x", "a/b", ".hidden", ""} {
		if r := o.Run(Rename, []Item{{From: "~/Documents/report-2026.txt", To: bad}}); len(r.Failed) != 1 {
			t.Errorf("rename to %q must fail", bad)
		}
	}
	mk := o.Run(Mkdir, []Item{{From: "~/Work/2026/Q4"}})
	if len(mk.Failed) != 0 || !exists(home, "Work/2026/Q4") {
		t.Fatalf("mkdir %+v", mk)
	}
	write(t, home, "Work/2026/notes.txt", "keep me")
	u, err := o.Undo(mk.JournalID)
	must(t, err)
	if exists(home, "Work/2026/Q4") || !exists(home, "Work/2026/notes.txt") || len(u.Failed) != 2 {
		t.Fatalf("undo mkdir removes only empty folders it made: %+v", u)
	}
	u, err = o.Undo(cp.JournalID)
	must(t, err)
	if exists(home, "Backup/app-copy") || len(u.Failed) != 0 {
		t.Fatalf("undo copy: %+v", u)
	}
	items, _ := o.Trash.List()
	if len(items) != 1 || items[0].Name != "app-copy" {
		t.Fatalf("undoing a copy trashes the copy, never deletes it: %+v", items)
	}
	u, err = o.Undo(rn.JournalID)
	must(t, err)
	if read(t, home, "Documents/report.txt") != "report" {
		t.Fatalf("undo rename: %+v", u)
	}
}

func TestCopyLimitsLeaveNothing(t *testing.T) {
	o, home, _ := newOps(t)
	o.MaxCopyEntries = 2
	res := o.Run(Copy, []Item{{From: "~/Projects", To: "~/Backup/"}})
	if len(res.Failed) != 1 || res.Failed[0].Code != mcp.CodeInvalid || !strings.Contains(res.Failed[0].Message, "too many") {
		t.Fatalf("entries cap: %+v", res)
	}
	o.MaxCopyEntries, o.MaxCopyBytes = 0, 3
	res = o.Run(Copy, []Item{{From: "~/Documents/report.txt", To: "~/Backup/"}})
	if len(res.Failed) != 1 || !strings.Contains(res.Failed[0].Message, "too big") {
		t.Fatalf("bytes cap: %+v", res)
	}
	if ents, _ := os.ReadDir(filepath.Join(home, "Backup")); len(ents) != 0 {
		t.Fatalf("a refused copy leaves nothing: %v", ents)
	}
}

func TestTrashRestoreAndUndo(t *testing.T) {
	o, home, _ := newOps(t)
	tr := o.Run(Trash, []Item{{From: "~/Desktop/shot1.png"}, {From: "~/Desktop/nope.png"}})
	if len(tr.Done) != 1 || len(tr.Failed) != 1 || tr.Done[0].To != "trash:shot1.png" {
		t.Fatalf("trash %+v", tr)
	}
	if exists(home, "Desktop/shot1.png") || read(t, home, ".local/share/Trash/files/shot1.png") != "one" {
		t.Fatal("trash moves into the freedesktop trash")
	}
	rs := o.Run(Restore, []Item{{From: "~/Desktop/shot1.png"}})
	if len(rs.Failed) != 0 || read(t, home, "Desktop/shot1.png") != "one" {
		t.Fatalf("restore by original path: %+v", rs)
	}
	tr2 := o.Run(Trash, []Item{{From: "~/Desktop/shot1.png"}})
	rs2 := o.Run(Restore, []Item{{From: "trash:shot1.png", To: "~/Documents/old-shot.png"}})
	if len(rs2.Failed) != 0 || read(t, home, "Documents/old-shot.png") != "one" {
		t.Fatalf("restore by trash name to another place: %+v %+v", tr2, rs2)
	}
	u, err := o.Undo(rs2.JournalID)
	must(t, err)
	if exists(home, "Documents/old-shot.png") || len(u.Failed) != 0 {
		t.Fatalf("undo restore trashes it again: %+v", u)
	}
	write(t, home, "Desktop/shot2.png", "two")
	t3 := o.Run(Trash, []Item{{From: "~/Desktop/shot2.png"}})
	write(t, home, "Desktop/shot2.png", "a new file")
	u, err = o.Undo(t3.JournalID)
	must(t, err)
	if len(u.Failed) != 1 || read(t, home, "Desktop/shot2.png") != "a new file" || u.JournalID != t3.JournalID {
		t.Fatalf("undo never overwrites; the entry is kept: %+v", u)
	}
	if r := o.Run(Trash, []Item{{From: "~/.local/share/Trash"}}); len(r.Failed) != 1 || r.Failed[0].Code != mcp.CodeDenied {
		t.Fatalf("the trash itself: %+v", r)
	}
}

func TestUndoSkipsWhatChangedSince(t *testing.T) {
	o, home, _ := newOps(t)
	mv := o.Run(Move, []Item{{From: "~/Documents/report.txt", To: "~/Desktop/"}})
	write(t, home, "Desktop/report.txt", "edited after the move")
	u, err := o.Undo(mv.JournalID)
	must(t, err)
	if len(u.Failed) != 1 || read(t, home, "Desktop/report.txt") != "edited after the move" {
		t.Fatalf("changed file must stay: %+v", u)
	}
}

func TestJournalKeepsTheNewest(t *testing.T) {
	dir := t.TempDir()
	j := Journal{Dir: dir, Keep: 3}
	base := time.Date(2026, 10, 9, 10, 0, 0, 0, time.UTC)
	for i := 1; i <= 5; i++ {
		at := base.Add(time.Duration(6-i) * time.Millisecond) // ids and ages in opposite order
		if i == 5 {
			at = base.Add(time.Hour)
		}
		must(t, j.Save(Entry{ID: fmt.Sprintf("%016x", i), CreatedAt: at.Format(time.RFC3339Nano), Steps: []Step{{Kind: Mkdir, From: "/x"}}}))
	}
	var kept []string
	for i := 1; i <= 5; i++ {
		if _, err := j.Load(fmt.Sprintf("%016x", i)); err == nil {
			kept = append(kept, fmt.Sprint(i))
		}
	}
	if !reflect.DeepEqual(kept, []string{"1", "2", "5"}) {
		t.Fatalf("kept %v, want the three newest by time", kept)
	}
	for _, bad := range []string{"../../etc/passwd", "1", "ZZZZZZZZZZZZZZZZ"} {
		if _, err := j.Load(bad); err != ErrNoJournal {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if StateDir(func(k string) string { return map[string]string{"HOME": "/home/u"}[k] }) != "/home/u/.local/state/jarvis/files-journal" {
		t.Fatal("state dir")
	}
}

func TestUndoMkdirNeverRemovesAFile(t *testing.T) {
	o, home, _ := newOps(t)
	mk := o.Run(Mkdir, []Item{{From: "~/Work"}})
	if len(mk.Failed) != 0 || !exists(home, "Work") {
		t.Fatalf("mkdir: %+v", mk)
	}
	must(t, os.Remove(filepath.Join(home, "Work")))
	write(t, home, "Work", "my file")
	u, err := o.Undo(mk.JournalID)
	must(t, err)
	if len(u.Failed) != 1 || read(t, home, "Work") != "my file" {
		t.Fatalf("a file that replaced the folder must stay: %+v", u)
	}
}

func TestRestoreRefusesPrivateTrash(t *testing.T) {
	o, home, outside := newOps(t)
	write(t, home, ".ssh/id_rsa", "KEY")
	write(t, home, "Documents/.hidden/a.txt", "h")
	// as if the file manager trashed them
	for _, rel := range []string{".ssh/id_rsa", "Documents/.hidden/a.txt"} {
		_, err := o.Trash.Put(filepath.Join(home, rel))
		must(t, err)
	}
	for _, from := range []string{"trash:id_rsa", "trash:a.txt", "~/.ssh/id_rsa"} {
		r := o.Run(Restore, []Item{{From: from, To: "~/Desktop/notes.txt"}})
		if len(r.Done) != 0 || len(r.Failed) != 1 {
			t.Fatalf("%s: %+v", from, r)
		}
		if from != "~/.ssh/id_rsa" && r.Failed[0].Code != mcp.CodeDenied {
			t.Fatalf("%s: want denied, %+v", from, r)
		}
	}
	if exists(home, "Desktop/notes.txt") {
		t.Fatal("private item must not land in the open")
	}
	// trashed from outside home
	if _, err := o.Trash.Put(filepath.Join(outside, "secret.txt")); err == nil {
		r := o.Run(Restore, []Item{{From: "trash:secret.txt", To: "~/Desktop/s.txt"}})
		if len(r.Done) != 0 || len(r.Failed) != 1 || r.Failed[0].Code != mcp.CodeDenied {
			t.Fatalf("outside home: %+v", r)
		}
	}
}
