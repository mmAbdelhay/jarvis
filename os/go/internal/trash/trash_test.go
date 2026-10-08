package trash

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func setup(t *testing.T) (home string, tr Trash) {
	home = t.TempDir()
	clock := time.Date(2026, 10, 9, 14, 30, 5, 0, time.Local)
	tr = Trash{Dir: filepath.Join(home, ".local", "share", "Trash"), Now: func() time.Time {
		clock = clock.Add(time.Second)
		return clock
	}}
	must(t, os.MkdirAll(filepath.Join(home, "Docs", "Album"), 0o755))
	must(t, os.WriteFile(filepath.Join(home, "Docs", "my report.txt"), []byte("r1"), 0o644))
	must(t, os.WriteFile(filepath.Join(home, "Docs", "Album", "صورة.jpg"), []byte("p"), 0o644))
	return home, tr
}

func TestHomeTrashLocation(t *testing.T) {
	env := map[string]string{"HOME": "/home/u"}
	if got := Home(func(k string) string { return env[k] }).Dir; got != "/home/u/.local/share/Trash" {
		t.Fatalf("default: %s", got)
	}
	env["XDG_DATA_HOME"] = "/data/u"
	if got := Home(func(k string) string { return env[k] }).Dir; got != "/data/u/Trash" {
		t.Fatalf("XDG_DATA_HOME: %s", got)
	}
	env["XDG_DATA_HOME"] = "relative"
	if got := Home(func(k string) string { return env[k] }).Dir; got != "/home/u/.local/share/Trash" {
		t.Fatalf("relative XDG_DATA_HOME is ignored: %s", got)
	}
}

func TestPutWritesSpecInfoAndMovesTheFile(t *testing.T) {
	home, tr := setup(t)
	src := filepath.Join(home, "Docs", "my report.txt")
	it, err := tr.Put(src)
	must(t, err)
	if it.Name != "my report.txt" || it.OriginalPath != src {
		t.Fatalf("item %+v", it)
	}
	if _, err := os.Lstat(src); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the source must be gone")
	}
	if b, _ := os.ReadFile(filepath.Join(tr.Dir, "files", "my report.txt")); string(b) != "r1" {
		t.Fatalf("trashed content %q", b)
	}
	info, _ := os.ReadFile(filepath.Join(tr.Dir, "info", "my report.txt.trashinfo"))
	want := "[Trash Info]\nPath=" + strings.ReplaceAll(src, " ", "%20") + "\nDeletionDate=2026-10-09T14:30:06\n"
	if string(info) != want {
		t.Fatalf("info\n%s\nwant\n%s", info, want)
	}
	st, _ := os.Stat(filepath.Join(tr.Dir, "files"))
	if st.Mode().Perm() != 0o700 {
		t.Fatalf("files/ mode %v", st.Mode().Perm())
	}
}

func TestPutCollisionsFoldersAndArabic(t *testing.T) {
	home, tr := setup(t)
	a := filepath.Join(home, "Docs", "my report.txt")
	_, err := tr.Put(a)
	must(t, err)
	must(t, os.WriteFile(a, []byte("r2"), 0o644))
	it2, err := tr.Put(a)
	must(t, err)
	if it2.Name != "my report.2.txt" {
		t.Fatalf("second name %q", it2.Name)
	}
	album, err := tr.Put(filepath.Join(home, "Docs", "Album"))
	must(t, err)
	if b, _ := os.ReadFile(filepath.Join(tr.Dir, "files", album.Name, "صورة.jpg")); string(b) != "p" {
		t.Fatal("a folder is trashed whole")
	}
	items, err := tr.List()
	must(t, err)
	if len(items) != 3 || items[0].Name != "Album" || items[2].Name != "my report.txt" {
		t.Fatalf("newest first: %+v", items)
	}
	newest, err := tr.Find(a)
	must(t, err)
	if newest.Name != "my report.2.txt" {
		t.Fatalf("Find returns the newest: %+v", newest)
	}
}

func TestPutLeavesALinkAsALink(t *testing.T) {
	home, tr := setup(t)
	link := filepath.Join(home, "Docs", "shortcut")
	must(t, os.Symlink(filepath.Join(home, "Docs", "my report.txt"), link))
	it, err := tr.Put(link)
	must(t, err)
	if st, err := os.Lstat(filepath.Join(tr.Dir, "files", it.Name)); err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the link itself is trashed")
	}
	if _, err := os.Stat(filepath.Join(home, "Docs", "my report.txt")); err != nil {
		t.Fatal("the link's target is untouched")
	}
}

func TestRestore(t *testing.T) {
	home, tr := setup(t)
	src := filepath.Join(home, "Docs", "Album", "صورة.jpg")
	it, err := tr.Put(src)
	must(t, err)
	must(t, os.RemoveAll(filepath.Join(home, "Docs", "Album")))
	must(t, tr.Restore(it.Name, it.OriginalPath))
	if b, _ := os.ReadFile(src); string(b) != "p" {
		t.Fatal("restored into a re-created folder")
	}
	if _, err := tr.Get(it.Name); !errors.Is(err, ErrNotFound) {
		t.Fatal("the info file must be gone")
	}
	it, _ = tr.Put(src)
	must(t, os.WriteFile(src, []byte("new"), 0o644))
	if err := tr.Restore(it.Name, src); !errors.Is(err, ErrExists) {
		t.Fatalf("never overwrite: %v", err)
	}
	for _, bad := range []string{"..", "../x", "", "nope"} {
		if err := tr.Restore(bad, filepath.Join(home, "x")); !errors.Is(err, ErrNotFound) {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestListSkipsBrokenEntries(t *testing.T) {
	_, tr := setup(t)
	must(t, os.MkdirAll(filepath.Join(tr.Dir, "info"), 0o700))
	must(t, os.MkdirAll(filepath.Join(tr.Dir, "files"), 0o700))
	must(t, os.WriteFile(filepath.Join(tr.Dir, "info", "orphan.trashinfo"), []byte("[Trash Info]\nPath=/x\nDeletionDate=2026-01-01T00:00:00\n"), 0o600))
	must(t, os.WriteFile(filepath.Join(tr.Dir, "info", "bad.trashinfo"), []byte("garbage"), 0o600))
	must(t, os.WriteFile(filepath.Join(tr.Dir, "files", "bad"), []byte("x"), 0o600))
	items, err := tr.List()
	must(t, err)
	if len(items) != 0 {
		t.Fatalf("broken entries listed: %+v", items)
	}
	if items, err := (Trash{Dir: filepath.Join(t.TempDir(), "none")}).List(); err != nil || len(items) != 0 {
		t.Fatalf("missing trash: %v %v", items, err)
	}
}
